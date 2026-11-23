// End to end with the real @kenjitayama/djdb-mcp: its CLI builds a library from ListenBrainz
// fixtures (fetch preloaded by fixtures/lb-fetch-preload.mjs), then dj-mcp's recommend resolves the
// pick on a fake Spotify search and records the impression in the online DB. Every path is in a
// temp dir. Skipped when djdb-mcp is not usable here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeDjdb } from '../lib/recommender.mjs';
import { createCore } from '../lib/core.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const skip = probeDjdb() ? false : 'djdb-mcp is not installed, or this Node is outside its range';

const HEAVY = '11111111-1111-4111-8111-111111111111';
const LIGHT = '33333333-3333-4333-8333-333333333333';
const PICK = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DAY = 86400;

function lbFixture() {
  const listens = [];
  for (let i = 0; i < 40; i++) {
    const rec = `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${i % 3}`;
    listens.push({
      listened_at: 1_700_000_000 + i * DAY,
      recording_msid: `e2e-msid-${i}`,
      track_metadata: {
        artist_name: 'Heavy Fixture',
        track_name: `Heavy ${i % 3}`,
        release_name: 'Fixture Album',
        additional_info: { recording_msid: `e2e-msid-${i}`, music_service: 'spotify.com' },
        mbid_mapping: { recording_mbid: rec, recording_name: `Heavy ${i % 3}`, artist_mbids: [HEAVY], artists: [{ artist_mbid: HEAVY, artist_credit_name: 'Heavy Fixture', join_phrase: '' }] },
      },
    });
  }
  const top = (artist, name, mbid, title, n) => ({
    artist_mbids: [artist], artist_name: name, caa_id: null, caa_release_mbid: null, length: 200_000,
    recording_mbid: mbid, recording_name: title, release_mbid: null, release_name: 'Fixture Single', total_listen_count: n, total_user_count: n / 10,
  });
  return {
    user: 'tester',
    listens,
    similar: { [HEAVY]: [{ artist_mbid: LIGHT, name: 'Light Fixture', comment: '', type: 'Group', gender: null, score: 50, reference_mbid: HEAVY }] },
    popularity: {
      [HEAVY]: { artist_mbid: HEAVY, total_listen_count: 1000, total_user_count: 50 },
      [LIGHT]: { artist_mbid: LIGHT, total_listen_count: 500, total_user_count: 20 },
    },
    tops: { [LIGHT]: [top(LIGHT, 'Light Fixture', PICK, 'Night Drive', 300)] },
  };
}

function spotify() {
  const searches = [];
  const fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname !== '/v1/search') return new Response(JSON.stringify({ error: { message: `no route ${u.pathname}` } }), { status: 404 });
    searches.push(u.searchParams.get('q'));
    const items = u.searchParams.get('q') === 'track:"Night Drive" artist:"Light Fixture"'
      ? [{ id: 'e2e1', uri: 'spotify:track:e2e1', name: 'Night Drive', artists: [{ name: 'Light Fixture' }], album: { name: 'Fixture Single' }, duration_ms: 200_000, external_ids: {}, is_playable: true }]
      : [];
    return new Response(JSON.stringify({ tracks: { items } }), { status: 200 });
  };
  return { fetch, searches };
}

test('real djdb CLI builds the library; recommend resolves the pick on Spotify and records its impression', { skip, timeout: 120_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-e2e-'));
  for (const d of ['home', 'data', 'config', 'db', 'dj-mcp']) fs.mkdirSync(path.join(base, d));
  const lbFile = path.join(base, 'lb.json');
  fs.writeFileSync(lbFile, JSON.stringify(lbFixture()));
  const dbPath = path.join(base, 'db', 'djdb.sqlite');
  const env = {
    PATH: process.env.PATH, HOME: path.join(base, 'home'), XDG_DATA_HOME: path.join(base, 'data'), XDG_CONFIG_HOME: path.join(base, 'config'),
    DJDB_PATH: dbPath, LISTENBRAINZ_TOKEN: 'test-token', DJM_E2E_LB: lbFile,
  };
  const bin = path.join(path.dirname(createRequire(import.meta.url).resolve('@kenjitayama/djdb-mcp')), '..', 'bin', 'djdb');
  const djdb = (...args) => {
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(fixtures, 'lb-fetch-preload.mjs')).href, bin, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, `djdb ${args.join(' ')}: ${r.stdout}${r.stderr}`);
    return r.stdout;
  };
  djdb('init');
  const refreshed = JSON.parse(djdb('refresh', '--listens-full-history', '--json'));
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
  assert.equal(JSON.parse(djdb('status', '--json')).counts.plays, 40);

  process.env.DJDB_PATH = dbPath;
  const configDir = path.join(base, 'dj-mcp');
  fs.writeFileSync(path.join(configDir, 'tokens.json'), JSON.stringify({ access_token: 'AT', refresh_token: 'RT', scope: '', expires_at: 4_000_000_000_000, client_id: 'cid' }), { mode: 0o600 });
  const s = spotify();
  const r = await createCore({ configDir, clientId: 'cid', fetch: s.fetch, sleep: async () => {} }).callTool('recommend', { n: 1 });
  assert.deepEqual(r.items.map((i) => [i.uri, i.recording_mbid, i.resolved_by]), [['spotify:track:e2e1', PICK, 'search']]);
  assert.deepEqual(s.searches, ['track:"Night Drive" artist:"Light Fixture"']);

  const { DatabaseSync } = await import('node:sqlite');
  const online = new DatabaseSync(path.join(base, 'db', 'djdb-online.sqlite'), { readOnly: true });
  try {
    const rows = (sql, ...p) => online.prepare(sql).all(...p).map((x) => ({ ...x }));
    const [picked] = rows(`SELECT rank FROM rec_item WHERE run_id=? AND recording_mbid=?`, r.run_id, PICK);
    assert.ok(picked, 'the pick is an item of the recorded run');
    assert.deepEqual(rows(`SELECT run_id, rank, kind FROM rec_event`), [{ run_id: r.run_id, rank: picked.rank, kind: 'impression' }]);
    assert.deepEqual(rows(`SELECT recording_mbid, ext_id, market, status FROM track_external_id`), [{ recording_mbid: PICK, ext_id: 'e2e1', market: 'JP', status: 'ok' }]);
  } finally {
    online.close();
  }

  const again = await createCore({ configDir, clientId: 'cid', fetch: s.fetch, sleep: async () => {} }).callTool('recommend', { n: 1 });
  assert.deepEqual(again.items, [], 'the recorded impression keeps the pick out of the next run');
  assert.equal(s.searches.length, 1);
});
