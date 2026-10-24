/**
 * game-lookup — Supabase Edge Function (Deno)
 *
 * Proxy do backend para IGDB (metadados) e SteamGridDB (imagens). Os segredos
 * (TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, STEAMGRIDDB_API_KEY) são lidos de
 * Deno.env e nunca aparecem em respostas, logs ou no frontend.
 *
 * Só atende usuário logado no Supabase Auth (o admin do site): o gateway fica
 * com verify_jwt desligado (ver config.toml) e a verificação é feita aqui.
 *
 * Ações (POST JSON { action, ... }):
 *   igdb_search   { query }                 -> sugestões (prefixo; completa com busca textual)
 *   igdb_game     { id }                    -> metadados completos de um jogo
 *   sgdb_search   { query }                 -> jogos no SteamGridDB
 *   sgdb_images   { gameId, formats?, page? } -> artes por formato (vertical|horizontal|square)
 */

type Env = { get(key: string): string | undefined };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fail = (status: number, code: string, message: string) => json(status, { ok: false, code, message });

class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Remove aspas/barras (a busca da IGDB usa string entre aspas) e limita o tamanho. */
const cleanTerm = (v: unknown) => String(v ?? '').replace(/["\\;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

/* ------------------------------ Twitch / IGDB ------------------------------ */

// Cache em memória do isolate: some quando a função "dorme" e é refeito na próxima chamada.
let twitchToken: { value: string; expiresAt: number } | null = null;
let lastIgdbCall = 0;
const IGDB_MIN_INTERVAL_MS = 260; // limite documentado: 4 requisições/segundo

/** Só para testes: limpa o cache do token. */
export function _resetTokenCache() { twitchToken = null; }

async function getTwitchToken(env: Env, force = false): Promise<string> {
  const id = env.get('TWITCH_CLIENT_ID');
  const secret = env.get('TWITCH_CLIENT_SECRET');
  if (!id || !secret) {
    throw new ApiError(503, 'missing_secret', 'IGDB não configurada: faltam TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET nos segredos da função.');
  }
  if (!force && twitchToken && Date.now() < twitchToken.expiresAt - 60_000) return twitchToken.value;

  let res: Response;
  try {
    res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
    });
  } catch (_e) {
    throw new ApiError(502, 'upstream_unavailable', 'Não foi possível falar com a Twitch para autenticar na IGDB.');
  }
  if (!res.ok) {
    throw new ApiError(502, 'upstream_auth', 'A Twitch recusou as credenciais da IGDB (confira TWITCH_CLIENT_ID e TWITCH_CLIENT_SECRET).');
  }
  const data = await res.json().catch(() => null);
  if (!data || typeof data.access_token !== 'string') {
    throw new ApiError(502, 'invalid_response', 'Resposta inesperada da Twitch ao gerar o token.');
  }
  twitchToken = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return twitchToken.value;
}

async function igdb(env: Env, endpoint: string, query: string): Promise<any[]> {
  const clientId = env.get('TWITCH_CLIENT_ID');
  let refreshed = false;
  let retried429 = false;
  for (;;) {
    const token = await getTwitchToken(env);
    const wait = lastIgdbCall + IGDB_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastIgdbCall = Date.now();

    let res: Response;
    try {
      res = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
        method: 'POST',
        headers: { 'Client-ID': clientId!, Authorization: `Bearer ${token}`, Accept: 'application/json' },
        body: query,
      });
    } catch (_e) {
      throw new ApiError(502, 'upstream_unavailable', 'A IGDB está indisponível no momento.');
    }
    if (res.status === 401 && !refreshed) { // token expirado/revogado: renova uma vez
      refreshed = true;
      twitchToken = null;
      await getTwitchToken(env, true);
      continue;
    }
    if (res.status === 401) throw new ApiError(502, 'upstream_auth', 'A IGDB recusou o token da Twitch.');
    if (res.status === 429) {
      if (!retried429) { retried429 = true; await sleep(1100); continue; }
      throw new ApiError(429, 'rate_limited', 'Limite de requisições da IGDB atingido. Tente de novo em instantes.');
    }
    if (!res.ok) throw new ApiError(502, 'upstream_unavailable', `A IGDB respondeu com erro (${res.status}).`);
    const data = await res.json().catch(() => null);
    if (!Array.isArray(data)) throw new ApiError(502, 'invalid_response', 'Resposta inesperada da IGDB.');
    return data;
  }
}

const igdbImage = (imageId: string, size: string) => `https://images.igdb.com/igdb/image/upload/t_${size}/${imageId}.jpg`;
const yearOf = (unixSeconds?: number) => (typeof unixSeconds === 'number' ? new Date(unixSeconds * 1000).getUTCFullYear() : null);
const names = (arr: any) => (Array.isArray(arr) ? arr.map((x) => x && x.name).filter(Boolean) : []);

const SEARCH_FIELDS = 'fields name,slug,first_release_date,cover.image_id,platforms.name;';

async function igdbSearch(env: Env, rawQuery: unknown) {
  const term = cleanTerm(rawQuery);
  if (term.length < 2) throw new ApiError(400, 'bad_request', 'Digite pelo menos 2 caracteres.');
  const seen = new Set<number>();
  const results: any[] = [];
  const add = (rows: any[], match: string) => {
    for (const g of rows) {
      if (!g || seen.has(g.id)) continue;
      seen.add(g.id);
      results.push({
        id: g.id,
        name: g.name,
        slug: g.slug ?? null,
        releaseYear: yearOf(g.first_release_date),
        coverThumb: g.cover?.image_id ? igdbImage(g.cover.image_id, 'cover_small') : null,
        platforms: names(g.platforms),
        match,
      });
    }
  };
  // 1) prefixo, sem diferenciar maiúsculas/minúsculas (operador ~ com * no fim), só edições principais
  add(await igdb(env, 'games', `${SEARCH_FIELDS} where name ~ "${term}"* & version_parent = null; sort total_rating_count desc; limit 10;`), 'prefix');
  // 2) poucos resultados: completa com a busca textual da IGDB (acha "witcher" em "The Witcher 3")
  if (results.length < 5) {
    add(await igdb(env, 'games', `search "${term}"; ${SEARCH_FIELDS} where version_parent = null; limit 10;`), 'search');
  }
  return { results: results.slice(0, 12) };
}

/** Precisão da data a partir do texto "human" da IGDB ("Nov 23, 2004" | "Nov 2004" | "2004"). */
function parseRelease(game: any) {
  const first = game.first_release_date;
  if (typeof first !== 'number') return null;
  const entry = (Array.isArray(game.release_dates) ? game.release_dates : []).find((r: any) => r && r.date === first);
  const human = String(entry?.human ?? '');
  const d = new Date(first * 1000);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  if (/^[A-Za-z]{3} \d{1,2}, \d{4}$/.test(human)) return { value: `${yyyy}-${mm}-${dd}`, precision: 'day' };
  if (/^[A-Za-z]{3} \d{4}$/.test(human)) return { value: `${yyyy}-${mm}`, precision: 'month' };
  // Sem texto reconhecível (ex.: "2024 Q1", "TBD"): não inventa dia nem mês.
  return { value: yyyy, precision: 'year' };
}

async function igdbGame(env: Env, rawId: unknown) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'bad_request', 'ID de jogo inválido.');
  const rows = await igdb(env, 'games',
    'fields name,slug,summary,first_release_date,genres.name,themes.name,platforms.name,game_modes.name,' +
    'cover.image_id,artworks.image_id,release_dates.date,release_dates.human,release_dates.y,release_dates.m,url; ' +
    `where id = ${id};`);
  const g = rows[0];
  if (!g) throw new ApiError(404, 'not_found', 'Jogo não encontrado na IGDB.');
  return {
    game: {
      igdbId: g.id,
      name: g.name,
      slug: g.slug ?? null,
      url: g.url ?? null,
      genres: names(g.genres),
      themes: names(g.themes),
      platforms: names(g.platforms), // lista da IGDB (fonte única; não é inferida aqui)
      gameModes: names(g.game_modes),
      releaseDate: parseRelease(g),
      // A IGDB entrega a sinopse no idioma original (normalmente inglês). Não é traduzida aqui.
      summary: g.summary ?? null,
      summaryLang: g.summary ? 'en' : null,
      summaryTranslated: false,
      cover: g.cover?.image_id ? { url: igdbImage(g.cover.image_id, 'cover_big'), thumb: igdbImage(g.cover.image_id, 'cover_small') } : null,
      artworks: (Array.isArray(g.artworks) ? g.artworks : []).filter((a: any) => a?.image_id)
        .map((a: any) => ({ url: igdbImage(a.image_id, '1080p'), thumb: igdbImage(a.image_id, 'screenshot_med') })),
    },
    // Tag (Zerado/Jogando/...) é pessoal e nunca vem das APIs.
  };
}

/* -------------------------------- SteamGridDB ------------------------------- */

const SGDB = 'https://www.steamgriddb.com/api/v2';

// Dimensões de grids documentadas pela SteamGridDB (inclui as quadradas adicionadas depois).
// Atenção: nenhuma é exatamente 9:16 ou 16:9 — vertical é ~2:3 e horizontal ~2.14:1.
const SGDB_FORMATS: Record<string, string[]> = {
  vertical: ['600x900', '342x482', '660x930'],
  horizontal: ['920x430', '460x215'],
  square: ['512x512', '1024x1024'],
};

async function sgdb(env: Env, path: string, params?: Record<string, string>) {
  const key = env.get('STEAMGRIDDB_API_KEY');
  if (!key) throw new ApiError(503, 'missing_secret', 'SteamGridDB não configurada: falta STEAMGRIDDB_API_KEY nos segredos da função.');
  const qs = params ? `?${new URLSearchParams(params).toString()}` : '';
  let res: Response;
  try {
    res = await fetch(`${SGDB}${path}${qs}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  } catch (_e) {
    throw new ApiError(502, 'upstream_unavailable', 'O SteamGridDB está indisponível no momento.');
  }
  if (res.status === 401 || res.status === 403) throw new ApiError(502, 'upstream_auth', 'O SteamGridDB recusou a chave (confira STEAMGRIDDB_API_KEY).');
  if (res.status === 404) return { success: true, data: [], notFound: true };
  if (res.status === 429) throw new ApiError(429, 'rate_limited', 'Limite de requisições do SteamGridDB atingido. Tente de novo em instantes.');
  if (!res.ok) throw new ApiError(502, 'upstream_unavailable', `O SteamGridDB respondeu com erro (${res.status}).`);
  const data = await res.json().catch(() => null);
  if (!data || data.success === false) throw new ApiError(502, 'invalid_response', 'Resposta inesperada do SteamGridDB.');
  return data;
}

const isHttps = (u: unknown): u is string => typeof u === 'string' && /^https:\/\//i.test(u);

async function sgdbSearch(env: Env, rawQuery: unknown) {
  const term = cleanTerm(rawQuery);
  if (term.length < 2) throw new ApiError(400, 'bad_request', 'Digite pelo menos 2 caracteres.');
  const data = await sgdb(env, `/search/autocomplete/${encodeURIComponent(term)}`);
  const list = Array.isArray(data.data) ? data.data : [];
  return {
    results: list.slice(0, 12).map((g: any) => ({
      id: g.id, name: g.name, verified: !!g.verified, releaseYear: yearOf(g.release_date),
    })),
  };
}

async function sgdbImages(env: Env, rawGameId: unknown, rawFormats: unknown, rawPage: unknown) {
  const gameId = Number(rawGameId);
  if (!Number.isInteger(gameId) || gameId <= 0) throw new ApiError(400, 'bad_request', 'ID do SteamGridDB inválido.');
  const page = Number.isInteger(Number(rawPage)) && Number(rawPage) >= 0 && Number(rawPage) <= 50 ? Number(rawPage) : 0;
  const wanted = (Array.isArray(rawFormats) ? rawFormats : Object.keys(SGDB_FORMATS)).filter((f) => f in SGDB_FORMATS);
  if (!wanted.length) throw new ApiError(400, 'bad_request', 'Formato inválido (use vertical, horizontal ou square).');

  const formats: Record<string, unknown> = {};
  await Promise.all(wanted.map(async (format) => {
    const data = await sgdb(env, `/grids/game/${gameId}`, {
      dimensions: SGDB_FORMATS[format].join(','),
      types: 'static',
      nsfw: 'false',
      humor: 'false',
      epilepsy: 'false',
      page: String(page),
    });
    const items = (Array.isArray(data.data) ? data.data : [])
      .filter((i: any) => isHttps(i?.url))
      .map((i: any) => ({
        id: i.id, url: i.url, thumb: isHttps(i.thumb) ? i.thumb : i.url,
        width: i.width ?? null, height: i.height ?? null, style: i.style ?? null,
        score: i.score ?? null, author: i.author?.name ?? null,
      }));
    // available=false => o jogo não tem arte nesse formato (não é erro).
    formats[format] = { available: items.length > 0, total: data.total ?? items.length, page, items };
  }));
  return { gameId, formats };
}

/* ---------------------------------- Handler --------------------------------- */

async function requireUser(req: Request, env: Env): Promise<boolean> {
  const m = /^Bearer (.+)$/i.exec(req.headers.get('Authorization') ?? '');
  const base = env.get('SUPABASE_URL');
  const apikey = req.headers.get('apikey') || env.get('SUPABASE_ANON_KEY');
  if (!m || !base || !apikey) return false;
  try {
    const r = await fetch(`${base}/auth/v1/user`, { headers: { apikey, Authorization: `Bearer ${m[1]}` } });
    if (!r.ok) return false;
    const u = await r.json().catch(() => null);
    return !!(u && u.id);
  } catch (_e) {
    return false;
  }
}

export async function handle(req: Request, env: Env): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.');
  if (!(await requireUser(req, env))) return fail(401, 'unauthorized', 'Entre no modo admin para usar a busca de jogos.');

  let body: any;
  try {
    const text = await req.text();
    if (text.length > 10_000) return fail(413, 'bad_request', 'Requisição grande demais.');
    body = JSON.parse(text);
  } catch (_e) {
    return fail(400, 'bad_request', 'Corpo da requisição inválido (esperado JSON).');
  }

  try {
    switch (body?.action) {
      case 'igdb_search': return json(200, { ok: true, ...(await igdbSearch(env, body.query)) });
      case 'igdb_game': return json(200, { ok: true, ...(await igdbGame(env, body.id)) });
      case 'sgdb_search': return json(200, { ok: true, ...(await sgdbSearch(env, body.query)) });
      case 'sgdb_images': return json(200, { ok: true, ...(await sgdbImages(env, body.gameId, body.formats, body.page)) });
      default: return fail(400, 'bad_request', 'Ação desconhecida.');
    }
  } catch (e) {
    if (e instanceof ApiError) return fail(e.status, e.code, e.message);
    console.error('game-lookup: erro inesperado', e instanceof Error ? e.name : 'unknown'); // sem detalhes que possam vazar segredo
    return fail(500, 'internal', 'Erro interno ao consultar as APIs de jogos.');
  }
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D && typeof D.serve === 'function') {
  D.serve((req: Request) => handle(req, { get: (k: string) => D.env.get(k) }));
}
