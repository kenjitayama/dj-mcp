// Optional recommender: the `recommend` tool, backed by @kenjitayama/djdb-mcp.
// Without the package, or on a Node outside its range, there is no tool and nothing here
// imports node:sqlite, so dj-mcp behaves as if this file did not exist.

import { createRequire } from 'node:module';

const PKG = '@kenjitayama/djdb-mcp';
export const DJDB_API_VERSION = 2;
export const DJDB_NODE_RANGE = '>=24.15.0 <25 || >=26 <27';
const DEFAULT_N = 10;
const MAX_N = 20;
const DEFAULT_MARKET = 'JP';

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
      'If the library is not ready, returns {disabled, reason, hint}; other tools are unaffected.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['discover', 'rediscover'], description: 'Default discover.' },
        n: { type: 'integer', minimum: 1, maximum: MAX_N, description: `Tracks to return, default ${DEFAULT_N}.` },
        market: { type: 'string', description: `ISO country code the tracks must be playable in, default ${DEFAULT_MARKET}.` },
      },
      additionalProperties: false,
    },
    handler: (a) => recommend({ api, toUri, SpotifyError, module }, a),
  };
}

const disabled = (reason, hint) => ({ disabled: true, reason, hint: hint ?? null });

async function recommend({ SpotifyError, module }, a = {}) {
  let mod;
  try {
    mod = await module();
  } catch (e) {
    return disabled(`djdb-mcp could not be loaded: ${e.message}`, 'Reinstall dependencies with npm install.');
  }
  if (mod.API_VERSION !== DJDB_API_VERSION) {
    return disabled(`djdb-mcp API_VERSION ${mod.API_VERSION} is not ${DJDB_API_VERSION}`, 'Install the djdb-mcp version pinned in package.json.');
  }
  const { mode, n, market } = options(a, SpotifyError);
  let h;
  try {
    h = mod.openReader({ online: 'write' });
  } catch (e) {
    return disabled(e.message, e.hint);
  }
  try {
    const st = mod.status(h);
    if (!st.ok) return disabled(st.reason, st.hint);
    const run = await mod.recommend(h, { mode, n, provider: 'spotify', market, record: true });
    if (run.disabled) return disabled(run.reason, run.hint);
    return {
      mode,
      market,
      run_id: run.run_id,
      items: (run.items || []).slice(0, n).map((it) => ({ name: it.title, artists: [it.artist_credit], recording_mbid: it.recording_mbid, isrc: it.isrc })),
      ...(st.provisional ? { note: st.provisional_note } : {}),
    };
  } finally {
    h.close();
  }
}

function options(a, SpotifyError) {
  const invalid = (message) => new SpotifyError('invalid_argument', message);
  const mode = a.mode ?? 'discover';
  if (!['discover', 'rediscover'].includes(mode)) throw invalid('mode must be discover or rediscover.');
  const n = a.n === undefined ? DEFAULT_N : Math.trunc(Number(a.n));
  if (!(n >= 1 && n <= MAX_N)) throw invalid(`n must be 1..${MAX_N}.`);
  const market = String(a.market ?? DEFAULT_MARKET).toUpperCase();
  if (!/^[A-Z]{2}$/.test(market)) throw invalid('market must be a two-letter ISO country code.');
  return { mode, n, market };
}
