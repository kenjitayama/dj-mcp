// The optional recommend tool, against a fake djdb-mcp module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore } from '../lib/core.mjs';
import { fakeDjdb, item } from './djdb-fake.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const golden = JSON.parse(fs.readFileSync(path.join(fixtures, 'contract-tools.json'), 'utf8'));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dj-rec-'));
const core = (djdb, extra = {}) => createCore({ configDir: tmpDir(), clientId: 'cid', djdb, ...extra });

test('with djdb, tools/list is the pinned list plus recommend at the end', () => {
  const tools = core(fakeDjdb().djdb).tools;
  assert.deepEqual(tools.slice(0, -1), golden);
  assert.equal(tools.at(-1).name, 'recommend');
  assert.deepEqual(core(false).tools, golden);
});

test('auth_status is the same with or without djdb', async () => {
  const dir = tmpDir();
  const a = await createCore({ configDir: dir, clientId: 'cid', djdb: false, now: () => 1 }).callTool('auth_status');
  const b = await createCore({ configDir: dir, clientId: 'cid', djdb: fakeDjdb().djdb, now: () => 1 }).callTool('auth_status');
  assert.deepEqual(b, a);
});

test('djdb is imported on the first recommend call, not at startup', async () => {
  const f = fakeDjdb({ items: [item(1)] });
  const c = core(f.djdb);
  assert.equal(f.calls.load, 0);
  await c.callTool('recommend', {});
  await c.callTool('recommend', {});
  assert.equal(f.calls.load, 1);
});

test('status is checked on every call: disabled until the library is ready', async () => {
  const f = fakeDjdb({ status: { ok: false, reason: 'never refreshed: run djdb refresh' }, items: [item(1)] });
  const c = core(f.djdb);
  assert.deepEqual(await c.callTool('recommend', {}), { disabled: true, reason: 'never refreshed: run djdb refresh', hint: null });
  f.state.status = { ok: true };
  const r = await c.callTool('recommend', {});
  assert.equal(r.disabled, undefined);
  assert.equal(f.calls.open.length, 2);
  assert.deepEqual(f.calls.open[0], { online: 'write' });
  assert.equal(f.calls.closed, 2);
  assert.equal(f.calls.recommend.length, 1);
});

test('a missing database, a wrong API_VERSION or a failed import disables the tool with a reason', async () => {
  const noDb = fakeDjdb({ openError: Object.assign(new Error('database not found: /tmp/x'), { code: 'no_database', hint: 'Run djdb init, then djdb refresh.' }) });
  assert.deepEqual(await core(noDb.djdb).callTool('recommend', {}), { disabled: true, reason: 'database not found: /tmp/x', hint: 'Run djdb init, then djdb refresh.' });
  const old = fakeDjdb({ apiVersion: 1 });
  assert.match((await core(old.djdb).callTool('recommend', {})).reason, /API_VERSION 1 is not 2/);
  const broken = fakeDjdb({ loadError: new Error('boom') });
  const c = core(broken.djdb);
  assert.match((await c.callTool('recommend', {})).reason, /could not be loaded: boom/);
  await c.callTool('recommend', {});
  assert.equal(broken.calls.load, 2, 'a failed import is retried on the next call');
});

test('bad arguments are invalid_argument errors', async () => {
  const c = core(fakeDjdb().djdb);
  for (const args of [{ mode: 'shuffle' }, { n: 0 }, { n: 21 }, { market: 'Japan' }]) {
    await assert.rejects(c.callTool('recommend', args), { code: 'invalid_argument' }, JSON.stringify(args));
  }
});

// ---- R3: turning djdb items into playable Spotify tracks ----

function authorizedDir() {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ access_token: 'AT', refresh_token: 'RT', scope: '', expires_at: 4_000_000_000_000, client_id: 'cid' }), { mode: 0o600 });
  return dir;
}

const track = (id, name, artist, { isrc, playable = true } = {}) => ({
  id, uri: `spotify:track:${id}`, name, artists: [{ name: artist }], album: { name: 'A' }, duration_ms: 1, external_ids: isrc ? { isrc } : {}, is_playable: playable,
});

/** Spotify search answered from `byQuery` (query string → tracks), `raw` (query → whole body), or a 429 for queries in `limited`. */
function spotify(byQuery = {}, { limited = [], raw = {} } = {}) {
  const searches = [];
  const fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/search') {
      const q = u.searchParams.get('q');
      searches.push({ q, market: u.searchParams.get('market'), type: u.searchParams.get('type') });
      if (limited.includes(q)) return new Response('{}', { status: 429, headers: { 'retry-after': '120' } });
      if (q in raw) return new Response(JSON.stringify(raw[q]), { status: 200 });
      return new Response(JSON.stringify({ tracks: { items: byQuery[q] || [] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: `no route ${u.pathname}` } }), { status: 404 });
  };
  return { fetch, searches };
}

const run = (f, s, args = {}) => createCore({ configDir: authorizedDir(), clientId: 'cid', djdb: f.djdb, fetch: s.fetch, sleep: async () => {} }).callTool('recommend', args);

test('a cached play target needs no search', async () => {
  const f = fakeDjdb({ items: [item(1, { playable: { provider: 'spotify', ext_id: 'c1', play_uri: 'spotify:track:c1', market: 'JP', resolved_by: 'cache' } })] });
  const s = spotify();
  const r = await run(f, s, { n: 1 });
  assert.equal(s.searches.length, 0);
  assert.deepEqual(r.items.map((i) => [i.uri, i.resolved_by]), [['spotify:track:c1', 'cache']]);
  assert.deepEqual(f.calls.external, []);
  assert.deepEqual(f.calls.events, [{ runId: 7, rank: 1, kind: 'impression' }]);
});

test('ISRC first, else title and artist, always with the market; only the same recording counts, and a mismatch is not a miss', async () => {
  const f = fakeDjdb({ items: [
    item(1, { title: 'Blue', artist: 'Kai', isrc: 'JPAA00000001' }),
    item(2, { title: 'Red', artist: 'Mio' }),
    item(3, { title: 'Green', artist: 'Ren feat. Someone' }),
  ] });
  const s = spotify({
    'isrc:JPAA00000001': [track('t1', 'Blue (Remaster)', 'Kai', { isrc: 'JPAA00000001' })],
    'track:"Red" artist:"Mio"': [track('x2', 'Red Light', 'Mio')],
    'track:"Green" artist:"Ren feat. Someone"': [track('t3', 'GREEN', 'Ren')],
  });
  const r = await run(f, s, { n: 3, market: 'us' });
  assert.deepEqual(s.searches.map((x) => [x.q, x.market, x.type]), [
    ['isrc:JPAA00000001', 'US', 'track'], ['track:"Red" artist:"Mio"', 'US', 'track'], ['track:"Green" artist:"Ren feat. Someone"', 'US', 'track'],
  ]);
  assert.deepEqual(r.items.map((i) => i.uri), ['spotify:track:t1', 'spotify:track:t3']);
  assert.deepEqual(f.calls.external, [{ runId: 7, opts: { market: 'US' }, results: [
    { rank: 1, provider: 'spotify', status: 'ok', extId: 't1', playUri: 'spotify:track:t1', method: 'isrc' },
    { rank: 3, provider: 'spotify', status: 'ok', extId: 't3', playUri: 'spotify:track:t3', method: 'name' },
  ] }]);
});

test('an unplayable result is not used and not a miss; n playable tracks are collected and only they get impressions', async () => {
  const f = fakeDjdb({ items: [1, 2, 3, 4, 5].map((k) => item(k)) });
  const s = spotify({
    'track:"Song 1" artist:"Artist 1"': [track('t1', 'Song 1', 'Artist 1', { playable: false })],
    'track:"Song 2" artist:"Artist 2"': [track('t2', 'Song 2', 'Artist 2')],
    'track:"Song 3" artist:"Artist 3"': [track('t3', 'Song 3', 'Artist 3')],
  });
  const r = await run(f, s, { n: 2 });
  assert.deepEqual(r.items.map((i) => i.uri), ['spotify:track:t2', 'spotify:track:t3']);
  assert.equal(s.searches.length, 3, 'items after the n-th playable one are not searched');
  assert.deepEqual(f.calls.external[0].results.map((x) => [x.rank, x.status]), [[2, 'ok'], [3, 'ok']]);
  assert.deepEqual(f.calls.events.map((e) => e.rank), [2, 3]);
});

test('not_found is recorded only when the search returns no tracks at all', async () => {
  const f = fakeDjdb({ items: [item(1), item(2)] });
  const s = spotify({ 'track:"Song 2" artist:"Artist 2"': [track('t2', 'Song 2', 'Artist 2')] });
  const r = await run(f, s, { n: 2 });
  assert.deepEqual(r.items.map((i) => i.uri), ['spotify:track:t2']);
  assert.deepEqual(f.calls.external[0].results.map((x) => [x.rank, x.status]), [[1, 'not_found'], [2, 'ok']]);
});

test('a search response without tracks.items stops the walk and records nothing for that item', async () => {
  const f = fakeDjdb({ items: [item(1), item(2), item(3)] });
  const s = spotify({
    'track:"Song 1" artist:"Artist 1"': [track('t1', 'Song 1', 'Artist 1')],
    'track:"Song 3" artist:"Artist 3"': [track('t3', 'Song 3', 'Artist 3')],
  }, { raw: { 'track:"Song 2" artist:"Artist 2"': { tracks: { href: 'x' } } } });
  const r = await run(f, s, { n: 3 });
  assert.equal(r.stopped.code, 'spotify_bad_response');
  assert.deepEqual(r.items.map((i) => i.uri), ['spotify:track:t1']);
  assert.deepEqual(f.calls.external[0].results.map((x) => [x.rank, x.status]), [[1, 'ok']]);
  assert.equal(s.searches.length, 2);
});

test('a Spotify track already picked is not used twice; the walk moves on to the next item', async () => {
  const f = fakeDjdb({ items: [
    item(1, { playable: { provider: 'spotify', ext_id: 'c1', play_uri: 'spotify:track:c1', market: 'JP', resolved_by: 'cache' } }),
    item(2), item(3), item(4), item(5),
  ] });
  const s = spotify({
    'track:"Song 2" artist:"Artist 2"': [track('c1', 'Song 2', 'Artist 2')],
    'track:"Song 3" artist:"Artist 3"': [track('t3', 'Song 3', 'Artist 3')],
    'track:"Song 4" artist:"Artist 4"': [track('t3', 'Song 4', 'Artist 4')],
    'track:"Song 5" artist:"Artist 5"': [track('t5', 'Song 5', 'Artist 5')],
  });
  const r = await run(f, s, { n: 5 });
  assert.deepEqual(r.items.map((i) => i.uri), ['spotify:track:c1', 'spotify:track:t3', 'spotify:track:t5']);
  assert.deepEqual(f.calls.external[0].results.map((x) => [x.rank, x.status]), [[3, 'ok'], [5, 'ok']]);
  assert.deepEqual(f.calls.events.map((e) => e.rank), [1, 3, 5]);
});

test('a 429 writes nothing for that item and stops; what was found before is kept', async () => {
  const f = fakeDjdb({ items: [item(1), item(2), item(3)] });
  const s = spotify({ 'track:"Song 1" artist:"Artist 1"': [track('t1', 'Song 1', 'Artist 1')] }, { limited: ['track:"Song 2" artist:"Artist 2"'] });
  const r = await run(f, s, { n: 3 });
  assert.equal(r.stopped.code, 'rate_limited');
  assert.equal(r.stopped.retry_after, 120);
  assert.deepEqual(r.items.map((i) => i.uri), ['spotify:track:t1']);
  assert.deepEqual(f.calls.external[0].results.map((x) => x.rank), [1]);
  assert.deepEqual(f.calls.events.map((e) => e.rank), [1]);
  assert.equal(s.searches.length, 2);
});

test('an item with neither an ISRC nor an artist credit is skipped: no search, nothing recorded', async () => {
  const f = fakeDjdb({ items: [item(1, { artist: '' }), item(2)] });
  const s = spotify({ 'track:"Song 2" artist:"Artist 2"': [track('t2', 'Song 2', 'Artist 2')] });
  const r = await run(f, s, { n: 2 });
  assert.deepEqual(s.searches.map((x) => x.q), ['track:"Song 2" artist:"Artist 2"']);
  assert.deepEqual(r.items.map((i) => i.uri), ['spotify:track:t2']);
  assert.deepEqual(f.calls.external[0].results.map((x) => x.rank), [2]);
});

test('a 429 on the first item records nothing at all', async () => {
  const f = fakeDjdb({ items: [item(1), item(2)] });
  const s = spotify({}, { limited: ['track:"Song 1" artist:"Artist 1"'] });
  const r = await run(f, s, { n: 2 });
  assert.equal(r.stopped.code, 'rate_limited');
  assert.deepEqual(r.items, []);
  assert.deepEqual(f.calls.external, []);
  assert.deepEqual(f.calls.events, []);
});

// ---- R4: seeds ----

test('seeds: Spotify artist URIs and links become names; djdb never sees a URI', async () => {
  const f = fakeDjdb({ items: [item(1, { playable: { play_uri: 'spotify:track:c1' } })], unknownSeedNames: ['Nobody Here'] });
  const artistCalls = [];
  const fetch = async (url) => {
    const u = new URL(String(url));
    const m = u.pathname.match(/^\/v1\/artists\/(\w+)$/);
    if (m) {
      artistCalls.push(m[1]);
      if (m[1] === 'gone') return new Response(JSON.stringify({ error: { status: 404, message: 'Not found' } }), { status: 404 });
      return new Response(JSON.stringify({ id: m[1], name: `Name of ${m[1]}` }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  const mbid = 'A1B2C3D4-0000-4000-8000-000000000001';
  const core = createCore({ configDir: authorizedDir(), clientId: 'cid', djdb: f.djdb, fetch, sleep: async () => {} });
  const r = await core.callTool('recommend', {
    n: 1,
    seeds: ['spotify:artist:ar1', 'https://open.spotify.com/intl-ja/artist/ar2?si=x', mbid, 'Nobody Here', 'spotify:artist:gone'],
  });
  assert.deepEqual(artistCalls, ['ar1', 'ar2', 'gone']);
  const sent = f.calls.recommend[0].seeds;
  assert.deepEqual(sent, [{ name: 'Name of ar1' }, { name: 'Name of ar2' }, { mbid: mbid.toLowerCase() }, { name: 'Nobody Here' }]);
  assert.doesNotMatch(JSON.stringify(sent), /spotify/i);
  assert.deepEqual(r.unresolved_seeds.map((u) => [u.input, u.reason]), [
    ['spotify:artist:gone', 'not_found'],
    ['Nobody Here', 'not_found'],
  ]);
  const track = await core.callTool('recommend', { n: 1, seeds: ['spotify:track:tr1'] });
  assert.deepEqual(f.calls.recommend[1].seeds, []);
  assert.deepEqual(track.unresolved_seeds.map((u) => [u.input, u.reason]), [['spotify:track:tr1', 'invalid_argument']]);
  assert.deepEqual(artistCalls, ['ar1', 'ar2', 'gone']);
});

test('seeds must be a short list of strings', async () => {
  const f = fakeDjdb();
  const core = createCore({ configDir: tmpDir(), clientId: 'cid', djdb: f.djdb });
  for (const seeds of ['Kai', [1], [''], ['a', 'b', 'c', 'd', 'e', 'f']]) {
    await assert.rejects(core.callTool('recommend', { seeds }), (e) => e.code === 'invalid_argument', JSON.stringify(seeds));
  }
  assert.deepEqual(f.calls.recommend, []);
});
