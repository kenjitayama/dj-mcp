// Optional recommender: the `recommend` tool, backed by @kenjitayama/djdb-mcp.
// Without the package, or on a Node outside its range, there is no tool and nothing here
// imports node:sqlite, so dj-mcp behaves as if this file did not exist.

import { createRequire } from 'node:module';

const PKG = '@kenjitayama/djdb-mcp';
export const DJDB_API_VERSION = 2;
export const DJDB_NODE_RANGE = '>=24.15.0 <25 || >=26 <27';
const DEFAULT_N = 10;
export const DEFAULT_RESOLVE_CONCURRENCY = 4;
export const MAX_RESOLVE_CONCURRENCY = 4;

/** Clamp a resolve concurrency to 1..MAX_RESOLVE_CONCURRENCY; invalid values become the default. */
export function clampResolveConcurrency(value = DEFAULT_RESOLVE_CONCURRENCY) {
  const raw = Math.trunc(Number(value));
  return Math.min(MAX_RESOLVE_CONCURRENCY, Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_RESOLVE_CONCURRENCY);
}

const MAX_N = 20;
const DEFAULT_MARKET = 'JP';
const SEARCH_LIMIT = 5;
const MAX_SEEDS = 5;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SPOTIFY_REF = /^(spotify:|https?:\/\/open\.spotify\.com\/)/i;

export function nodeSupportedForDjdb(v = process.versions.node) {
  const [a, b] = String(v).split('.').map(Number);
  return (a === 24 && b >= 15) || a === 26;
}

/** Whether djdb-mcp can be used here. Sync and import-free: the Node range, then require.resolve. */
export function probeDjdb(v = process.versions.node) {
  if (!nodeSupportedForDjdb(v)) return false;
  try {
    createRequire(import.meta.url).resolve(PKG);
    return true;
  } catch {
    return false;
  }
}

/**
 * The recommend tool, or null when djdb-mcp is unavailable.
 * api, toUri and SpotifyError come from core. djdb: false turns the tool off; { load } supplies
 * the module instead of importing the package (tests).
 */
export function recommendTool({ api, toUri, SpotifyError, djdb } = {}) {
  if (djdb === false) return null;
  const load = djdb?.load ?? (probeDjdb() ? () => import(PKG) : null);
  if (!load) return null;
  let loading = null;
  const module = () => {
    loading ??= Promise.resolve().then(load).catch((e) => {
      loading = null;
      throw e;
    });
    return loading;
  };
  return {
    name: 'recommend',
    description:
      'Recommend tracks from your ListenBrainz listening history (optional djdb-mcp library). ' +
      'mode "discover" (default): recordings you have not played, from artists near your taste. ' +
      'mode "rediscover": artists you played a lot in an earlier era. ' +
      'Returns Spotify track URIs playable in market; pass them to play or add_to_queue. ' +
      'If the library is not ready, returns {disabled, reason, hint}; other tools are unaffected.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['discover', 'rediscover'], description: 'Default discover.' },
        n: { type: 'integer', minimum: 1, maximum: MAX_N, description: `Tracks to return, default ${DEFAULT_N}.` },
        market: { type: 'string', description: `ISO country code the tracks must be playable in, default ${DEFAULT_MARKET}.` },
        seeds: {
          type: 'array',
          items: { type: 'string' },
          maxItems: MAX_SEEDS,
          description: 'Optional artists to steer toward: names, Spotify artist URIs or links, or MusicBrainz artist IDs.',
        },
      },
      additionalProperties: false,
    },
    handler: (a) => recommend({ api, toUri, SpotifyError, module }, a),
  };
}

const disabled = (reason, hint) => ({ disabled: true, reason, hint: hint ?? null });

async function recommend({ api, toUri, SpotifyError, module }, a = {}) {
  let mod;
  try {
    mod = await module();
  } catch (e) {
    return disabled(`djdb-mcp could not be loaded: ${e.message}`, 'Reinstall dependencies with npm install.');
  }
  if (mod.API_VERSION !== DJDB_API_VERSION) {
    return disabled(`djdb-mcp API_VERSION ${mod.API_VERSION} is not ${DJDB_API_VERSION}`, 'Install the djdb-mcp version pinned in package.json.');
  }
  const { mode, n, market, seeds } = options(a, SpotifyError);
  let h;
  try {
    h = mod.openReader({ online: 'write' });
  } catch (e) {
    return disabled(e.message, e.hint);
  }
  try {
    const st = mod.status(h);
    if (!st.ok) return disabled(st.reason, st.hint);
    const seeded = await seedsFor(api, toUri, seeds);
    const run = await mod.recommend(h, { mode, n, provider: 'spotify', market, seeds: seeded.seeds, record: true });
    if (run.disabled) return disabled(run.reason, run.hint);
    const unresolvedSeeds = [
      ...seeded.unresolved,
      ...(run.unresolved || []).map((u) => ({ input: seeded.origin.get(u.input) ?? u.input, reason: u.reason })),
    ];
    const { picked, results, stopped } = await resolvePlayable(api, mod, run.items || [], { n, market });
    if (results.length) mod.recordExternalIds(h.online, run.run_id, results, { market });
    for (const p of picked) mod.recordEvent(h.online, run.run_id, p.item.rank, 'impression');
    return {
      mode,
      market,
      run_id: run.run_id,
      items: picked.map((p) => ({
        uri: p.uri, name: p.item.title, artists: [p.item.artist_credit], recording_mbid: p.item.recording_mbid, isrc: p.item.isrc, resolved_by: p.by,
      })),
      ...(picked.length ? {} : { reason: run.reason || 'no playable recommendations' }),
      ...(unresolvedSeeds.length ? { unresolved_seeds: unresolvedSeeds } : {}),
      ...(stopped ? { stopped } : {}),
      ...(st.provisional ? { note: st.provisional_note } : {}),
    };
  } finally {
    h.close();
  }
}

/**
 * Walk djdb's items in rank order until n are playable. An item with a cached play target needs no
 * search and does not occupy a search slot. Otherwise one search: by ISRC when the item has one,
 * else by title and artist, in the market. Up to DEFAULT_RESOLVE_CONCURRENCY searches run at once,
 * but never more than are still needed to fill n (already picked tracks, plus in-flight searches
 * and not-yet-committed matches, count against that need). Results are committed in rank order, so
 * a later search finishing first cannot jump the queue.
 * A result counts only if it is the same recording (djdb's normalizers) and playable.
 * ok is recorded for a match, not_found only for a search with no tracks at all: results that are
 * another recording or unplayable say nothing about this one, so they are skipped unrecorded.
 * A failed search (429, network) or a body without tracks.items records nothing for that item and
 * stops the walk: no new searches are launched, and any later in-flight result is discarded, so the
 * next call can try again from the failure. Searches use retries: 0 so a 429 is not retried (and
 * not amplified across the concurrent wave); leftover in-flight requests are aborted and not
 * awaited, so a stalled later search cannot block the already-known stop. A track already picked
 * is not offered twice; the walk moves on to the next item.
 */
async function resolvePlayable(api, mod, items, { n, market, concurrency = DEFAULT_RESOLVE_CONCURRENCY }) {
  const cap = clampResolveConcurrency(concurrency);
  const picked = [];
  const results = [];
  const uris = new Set();
  const outcome = new Array(items.length);
  const inflight = new Set();
  const ac = new AbortController();
  let next = 0;
  let commitAt = 0;
  let stopped;

  const done = () => stopped || picked.length >= n;
  const isAbortError = (e) => e?.name === 'AbortError' || e?.code === 'ABORT_ERR';

  async function search(item) {
    const method = item.isrc ? 'isrc' : 'name';
    const q = item.isrc ? `isrc:${item.isrc}` : `track:"${unquote(item.title)}" artist:"${unquote(item.artist_credit)}"`;
    let data;
    try {
      data = await api('GET', '/search', { query: { q, type: 'track', limit: SEARCH_LIMIT, market }, retries: 0, signal: ac.signal });
    } catch (e) {
      if (isAbortError(e) || ac.signal.aborted) return { kind: 'aborted' };
      return { kind: 'fail', stopped: { code: e.code || 'error', message: e.message, ...(e.retry_after ? { retry_after: e.retry_after } : {}) } };
    }
    const found = data?.tracks?.items;
    if (!Array.isArray(found)) {
      return { kind: 'fail', stopped: { code: 'spotify_bad_response', message: 'search returned no tracks.items' } };
    }
    if (found.length === 0) return { kind: 'not_found', item };
    const track = found.find((t) => t && t.is_playable !== false && sameRecording(mod, item, t));
    if (!track) return { kind: 'no_match', item };
    return { kind: 'match', item, uri: track.uri, extId: track.id, method };
  }

  function tentative() {
    const seen = new Set(uris);
    let add = 0;
    for (let i = commitAt; i < next; i++) {
      const o = outcome[i];
      if (!o) continue;
      if (o.kind === 'fail') break;
      if ((o.kind === 'cache' || o.kind === 'match') && !seen.has(o.uri)) {
        seen.add(o.uri);
        add++;
      }
    }
    return add;
  }

  function willStop() {
    return stopped || outcome.some((o) => o?.kind === 'fail');
  }

  function commit() {
    if (done()) return;
    while (commitAt < items.length && picked.length < n) {
      const o = outcome[commitAt];
      if (!o) break;
      if (o.kind === 'fail') {
        stopped = o.stopped;
        break;
      }
      if (o.kind === 'not_found') {
        results.push({ rank: o.item.rank, provider: 'spotify', status: 'not_found' });
      } else if (o.kind === 'cache' && !uris.has(o.uri)) {
        uris.add(o.uri);
        picked.push({ item: o.item, uri: o.uri, by: 'cache' });
      } else if (o.kind === 'match' && !uris.has(o.uri)) {
        uris.add(o.uri);
        results.push({ rank: o.item.rank, provider: 'spotify', status: 'ok', extId: o.extId, playUri: o.uri, method: o.method });
        picked.push({ item: o.item, uri: o.uri, by: 'search' });
      }
      commitAt++;
    }
    if (done()) ac.abort();
  }

  function launch() {
    while (next < items.length && picked.length < n && !willStop()) {
      const item = items[next];
      if (item.playable?.play_uri) {
        outcome[next++] = { kind: 'cache', item, uri: item.playable.play_uri };
        commit();
        continue;
      }
      if (!item.isrc && !unquote(item.artist_credit)) {
        outcome[next++] = { kind: 'skip', item };
        commit();
        continue;
      }
      if (inflight.size >= cap) break;
      if (picked.length + tentative() + inflight.size >= n) break;
      const index = next++;
      const p = search(item).then((o) => {
        if (o.kind === 'aborted' || done()) return;
        outcome[index] = o;
        commit();
      }, (e) => {
        if (isAbortError(e) || done()) return;
        outcome[index] = { kind: 'fail', stopped: { code: e.code || 'error', message: e.message, ...(e.retry_after ? { retry_after: e.retry_after } : {}) } };
        commit();
      }).finally(() => inflight.delete(p));
      inflight.add(p);
    }
  }

  launch();
  while (inflight.size && !done()) {
    await Promise.race(inflight);
    launch();
  }
  if (!ac.signal.aborted) ac.abort();
  return stopped ? { picked, results, stopped } : { picked, results };
}

function sameRecording(mod, item, t) {
  const isrc = t.external_ids?.isrc;
  if (item.isrc && isrc) return isrc.toUpperCase() === item.isrc.toUpperCase();
  if (mod.normalizeTitle(t.name) !== item.title_norm) return false;
  const credit = mod.normalizeArtist(item.artist_credit || '');
  return (t.artists || []).some((a) => {
    const name = mod.normalizeArtist(a.name || '');
    return name !== '' && (credit === name || credit.startsWith(`${name} `));
  });
}

/**
 * djdb knows artists by name or MBID, never by Spotify URI. A Spotify artist URI or link becomes
 * the artist's name (one GET /artists/{id}); an MBID passes through; anything else is a name.
 * origin maps each seed object back to what the caller typed, for unresolved_seeds.
 */
async function seedsFor(api, toUri, inputs) {
  const seeds = [];
  const unresolved = [];
  const origin = new Map();
  const add = (seed, input) => {
    seeds.push(seed);
    origin.set(seed, input);
  };
  for (const input of inputs) {
    if (MBID.test(input)) {
      add({ mbid: input.toLowerCase() }, input);
      continue;
    }
    if (!SPOTIFY_REF.test(input)) {
      add({ name: input }, input);
      continue;
    }
    try {
      const id = toUri(input, ['artist']).split(':')[2];
      const artist = await api('GET', `/artists/${id}`);
      if (artist?.name) add({ name: artist.name }, input);
      else unresolved.push({ input, reason: 'no_name' });
    } catch (e) {
      unresolved.push({ input, reason: e.status === 404 ? 'not_found' : e.code || 'error', message: e.message });
    }
  }
  return { seeds, unresolved, origin };
}

const unquote = (s) => String(s ?? '').replace(/"/g, ' ').trim();

function options(a, SpotifyError) {
  const invalid = (message) => new SpotifyError('invalid_argument', message);
  const mode = a.mode ?? 'discover';
  if (!['discover', 'rediscover'].includes(mode)) throw invalid('mode must be discover or rediscover.');
  const n = a.n === undefined ? DEFAULT_N : Math.trunc(Number(a.n));
  if (!(n >= 1 && n <= MAX_N)) throw invalid(`n must be 1..${MAX_N}.`);
  const market = String(a.market ?? DEFAULT_MARKET).toUpperCase();
  if (!/^[A-Z]{2}$/.test(market)) throw invalid('market must be a two-letter ISO country code.');
  const seeds = a.seeds ?? [];
  if (!Array.isArray(seeds) || seeds.length > MAX_SEEDS || seeds.some((s) => typeof s !== 'string' || !s.trim())) {
    throw invalid(`seeds must be up to ${MAX_SEEDS} non-empty strings.`);
  }
  return { mode, n, market, seeds: seeds.map((s) => s.trim()) };
}
