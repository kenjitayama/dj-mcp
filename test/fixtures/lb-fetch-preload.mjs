// Preloaded with --import into the real djdb CLI by e2e-djdb.test.mjs. It replaces fetch with
// answers from the fixture file in DJM_E2E_LB, in the response shapes the live ListenBrainz API
// returned on 2026-11-23, so djdb init and refresh build a real database without the network.
import fs from 'node:fs';

const data = JSON.parse(fs.readFileSync(process.env.DJM_E2E_LB, 'utf8'));
const SIMILAR_ALGORITHMS = [
  'session_based_days_1800_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30',
  'session_based_days_75_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30',
  'session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30',
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30',
  'session_based_days_1825_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30',
  'session_based_days_7500_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30',
];

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input, init = {}) => {
  const u = new URL(String(input?.url ?? input));
  const p = u.pathname;
  if (u.hostname === 'labs.api.listenbrainz.org' && p === '/similar-artists/json') {
    const mbid = u.searchParams.get('artist_mbids');
    if (!mbid || !SIMILAR_ALGORITHMS.includes(u.searchParams.get('algorithm'))) {
      return new Response('<p>validation errors for SimilarArtistsViewerInput</p>', { status: 400, headers: { 'content-type': 'text/html' } });
    }
    return json(data.similar[mbid] || []);
  }
  if (u.hostname !== 'api.listenbrainz.org') throw new Error(`unexpected host ${u.hostname}`);
  if (p === '/1/validate-token') return json({ code: 200, message: 'Token valid.', valid: true, user_name: data.user });
  if (p === `/1/user/${data.user}/listens`) {
    const min = u.searchParams.get('min_ts');
    const max = u.searchParams.get('max_ts');
    const count = Number(u.searchParams.get('count') || 25);
    const all = data.listens
      .filter((l) => (min == null || l.listened_at > Number(min)) && (max == null || l.listened_at < Number(max)))
      .sort((a, b) => b.listened_at - a.listened_at);
    const listens = min != null ? all.slice(-count) : all.slice(0, count);
    return json({ payload: { count: listens.length, latest_listen_ts: all[0]?.listened_at ?? 0, listens, oldest_listen_ts: all.at(-1)?.listened_at ?? 0, user_id: data.user } });
  }
  if (p === `/1/feedback/user/${data.user}/get-feedback`) return json({ count: 0, feedback: [], offset: 0, total_count: 0 });
  if (p === '/1/popularity/artist' && init.method === 'POST') {
    const { artist_mbids: ids } = JSON.parse(init.body);
    return json(ids.map((id) => data.popularity[id]).filter(Boolean));
  }
  const top = p.match(/^\/1\/popularity\/top-recordings-for-artist\/([^/]+)$/);
  if (top) return json(data.tops[decodeURIComponent(top[1])] || []);
  return json({ code: 404, error: `no route ${p}` }, 404);
};
