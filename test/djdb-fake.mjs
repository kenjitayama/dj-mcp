// A stand-in for @kenjitayama/djdb-mcp (API_VERSION 2) that records every call.
// Pass `djdb` to createCore({ djdb }) and change `state` between calls.

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function fakeDjdb({ status = { ok: true }, items = [], apiVersion = 2, openError, loadError, unknownSeedNames = [] } = {}) {
  const state = { status, items, openError, unknownSeedNames };
  const calls = { load: 0, open: [], closed: 0, recommend: [], external: [], events: [] };
  const mod = {
    API_VERSION: apiVersion,
    normalizeTitle: norm,
    normalizeArtist: norm,
    openReader(opts) {
      calls.open.push(opts);
      if (state.openError) throw state.openError;
      return { main: {}, online: {}, close: () => { calls.closed++; } };
    },
    status: () => state.status,
    async recommend(_h, opts) {
      calls.recommend.push(opts);
      const unresolved = (opts.seeds || []).filter((s) => state.unknownSeedNames.includes(s.name)).map((s) => ({ input: s, reason: 'not_found' }));
      return { run_id: 7, items: state.items, unresolved };
    },
    recordExternalIds(_online, runId, results, opts) {
      calls.external.push({ runId, results, opts });
      return { ok: true, log: [] };
    },
    recordEvent(_online, runId, rank, kind) {
      calls.events.push({ runId, rank, kind });
      return { ok: true };
    },
  };
  const djdb = {
    load: async () => {
      calls.load++;
      if (loadError) throw loadError;
      return mod;
    },
  };
  return { djdb, state, calls };
}

/** A recommend() item as djdb returns it. */
export function item(rank, { title = `Song ${rank}`, artist = `Artist ${rank}`, isrc = null, playable = null } = {}) {
  return {
    rank,
    pre_rank: rank,
    candidate_source: 'top-recordings',
    artist_id: rank,
    track_id: 100 + rank,
    title,
    artist_credit: artist,
    recording_mbid: `0000000${rank}-0000-4000-8000-000000000000`.slice(-36),
    isrc,
    title_norm: norm(title),
    score: 1 / rank,
    playable,
  };
}
