// The optional recommend tool, against a fake djdb-mcp module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore } from '../lib/core.mjs';
import { clampResolveConcurrency, DEFAULT_RESOLVE_CONCURRENCY, MAX_RESOLVE_CONCURRENCY } from '../lib/recommender.mjs';
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
function spotify(byQuery = {}, { limited = [], raw = {}, retryAfter = 120 } = {}) {
  const searches = [];
  const fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/search') {
      const q = u.searchParams.get('q');
      searches.push({ q, market: u.searchParams.get('market'), type: u.searchParams.get('type') });
      if (limited.includes(q)) return new Response('{}', { status: 429, headers: { 'retry-after': String(retryAfter) } });
      if (q in raw) return new Response(JSON.stringify(raw[q]), { status: 200 });
      return new Response(JSON.stringify({ tracks: { items: byQuery[q] || [] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: `no route ${u.pathname}` } }), { status: 404 });
  };
  return { fetch, searches };
}

const run = (f, s, args = {}, extra = {}) => createCore({ configDir: authorizedDir(), clientId: 'cid', djdb: f.djdb, fetch: s.fetch, sleep: async () => {}, ...extra }).callTool('recommend', args);

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
  assert.equal(s.searches.length, 3, 'the first wave may already have launched later searches');
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
  assert.equal(s.searches.length, 3, 'the first wave may already have launched later searches');
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

// Controllable search: hold each query until release(q), and record peak in-flight count
// and actual completion order. when() is event-driven (notified on start and end).
function gatedSpotify(byQuery = {}, { limited = [], raw = {}, errors = {}, retryAfter = 120, honorSignal = false } = {}) {
  const searches = [];
  const completed = [];
  let current = 0;
  let peak = 0;
  const gates = new Map();
  const waiters = [];
  const notify = () => { for (const fn of waiters.slice()) fn(); };
  const gate = (q) => {
    if (!gates.has(q)) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      gates.set(q, { promise, resolve });
    }
    return gates.get(q);
  };
  const abortErr = (signal) => (typeof DOMException === 'function'
    ? new DOMException(signal?.reason || 'The operation was aborted.', 'AbortError')
    : Object.assign(new Error(signal?.reason || 'The operation was aborted.'), { name: 'AbortError', code: 'ABORT_ERR' }));
  const waitForGate = (q, signal) => {
    if (!signal) return gate(q).promise;
    if (signal.aborted) return Promise.reject(abortErr(signal));
    return new Promise((resolve, reject) => {
      const onAbort = () => { cleanup(); reject(abortErr(signal)); };
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      gate(q).promise.then((v) => { cleanup(); resolve(v); }, (e) => { cleanup(); reject(e); });
    });
  };
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/search') {
      const q = u.searchParams.get('q');
      const signal = honorSignal ? init.signal : undefined;
      current++;
      peak = Math.max(peak, current);
      searches.push({ q, market: u.searchParams.get('market'), type: u.searchParams.get('type') });
      notify();
      try {
        await waitForGate(q, signal);
        if (q in errors) throw errors[q];
        if (limited.includes(q)) return new Response('{}', { status: 429, headers: { 'retry-after': String(retryAfter) } });
        if (q in raw) return new Response(JSON.stringify(raw[q]), { status: 200 });
        return new Response(JSON.stringify({ tracks: { items: byQuery[q] || [] } }), { status: 200 });
      } finally {
        completed.push(q);
        current--;
        notify();
      }
    }
    return new Response(JSON.stringify({ error: { message: `no route ${u.pathname}` } }), { status: 404 });
  };
  return {
    fetch,
    searches,
    completed,
    get peak() { return peak; },
    get inFlight() { return current; },
    release(q) { gate(q).resolve(); },
    when(pred, label = 'searches') {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => finish(() => reject(new Error(`timeout waiting for ${label}`))), 2000);
        const tick = () => {
          try {
            if (pred()) finish(resolve);
          } catch (e) {
            finish(() => reject(e));
          }
        };
        const finish = (fn) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          const i = waiters.indexOf(tick);
          if (i >= 0) waiters.splice(i, 1);
          fn();
        };
        waiters.push(tick);
        tick();
      });
    },
  };
}

const nameQ = (k) => `track:"Song ${k}" artist:"Artist ${k}"`;
const playable = (k) => ({ [nameQ(k)]: [track(`t${k}`, `Song ${k}`, `Artist ${k}`)] });
const allPlayable = (ranks) => Object.assign({}, ...ranks.map(playable));

test('at most 4 Spotify searches run at once, and only as many as are still needed to fill n', async () => {
  assert.equal(DEFAULT_RESOLVE_CONCURRENCY, 4);
  const f = fakeDjdb({ items: [1, 2, 3, 4, 5, 6, 7, 8].map((k) => item(k)) });
  const s = gatedSpotify(allPlayable([1, 2, 3, 4, 5, 6, 7, 8]));
  const done = run(f, s, { n: 6 });
  await s.when(() => s.inFlight === 4);
  assert.equal(s.peak, 4);
  assert.deepEqual(s.searches.map((x) => x.q), [1, 2, 3, 4].map(nameQ));
  for (const k of [1, 2, 3, 4]) s.release(nameQ(k));
  await s.when(() => s.searches.length === 6);
  assert.equal(s.peak, 4);
  assert.equal(s.inFlight, 2);
  assert.deepEqual(s.searches.map((x) => x.q), [1, 2, 3, 4, 5, 6].map(nameQ));
  s.release(nameQ(5));
  s.release(nameQ(6));
  const r = await done;
  assert.deepEqual(r.items.map((i) => i.uri), [1, 2, 3, 4, 5, 6].map((k) => `spotify:track:t${k}`));
  assert.equal(s.searches.length, 6, 'items after the n-th playable one are not searched');
  assert.equal(s.peak, 4);
});

test('when n is below the cap, the first wave is min(4, n) searches, not 4', async () => {
  const f = fakeDjdb({ items: [1, 2, 3, 4, 5, 6].map((k) => item(k)) });
  const s = gatedSpotify(allPlayable([1, 2, 3, 4, 5, 6]));
  const done = run(f, s, { n: 2 });
  await s.when(() => s.inFlight === 2);
  assert.equal(s.peak, 2);
  assert.deepEqual(s.searches.map((x) => x.q), [1, 2].map(nameQ));
  s.release(nameQ(1));
  s.release(nameQ(2));
  const r = await done;
  assert.deepEqual(r.items.map((i) => i.uri), ['spotify:track:t1', 'spotify:track:t2']);
  assert.equal(s.searches.length, 2);
  assert.equal(s.peak, 2);
});

test('results stay in rank order when later searches finish first', async () => {
  const f = fakeDjdb({ items: [1, 2, 3, 4].map((k) => item(k)) });
  const s = gatedSpotify(allPlayable([1, 2, 3, 4]));
  const done = run(f, s, { n: 4 });
  await s.when(() => s.inFlight === 4);
  for (const k of [4, 3, 2, 1]) s.release(nameQ(k));
  const r = await done;
  assert.deepEqual(s.completed, [4, 3, 2, 1].map(nameQ), 'searches completed in reverse rank order');
  assert.deepEqual(r.items.map((i) => i.uri), ['spotify:track:t1', 'spotify:track:t2', 'spotify:track:t3', 'spotify:track:t4']);
  assert.deepEqual(f.calls.external[0].results.map((x) => x.rank), [1, 2, 3, 4]);
  assert.deepEqual(f.calls.events.map((e) => e.rank), [1, 2, 3, 4]);
});

test('a duplicate URI found concurrently keeps the higher-ranked item and fills n from later items', async () => {
  const f = fakeDjdb({ items: [1, 2, 3, 4].map((k) => item(k)) });
  const s = gatedSpotify({
    [nameQ(1)]: [track('t1', 'Song 1', 'Artist 1')],
    [nameQ(2)]: [track('t1', 'Song 2', 'Artist 2')],
    [nameQ(3)]: [track('t3', 'Song 3', 'Artist 3')],
    [nameQ(4)]: [track('t4', 'Song 4', 'Artist 4')],
  });
  const done = run(f, s, { n: 3 });
  await s.when(() => s.inFlight === 3);
  assert.deepEqual(s.searches.map((x) => x.q), [1, 2, 3].map(nameQ), 'first wave is min(4, n), before the duplicate is known');
  s.release(nameQ(2));
  s.release(nameQ(3));
  s.release(nameQ(1));
  await s.when(() => s.searches.length === 4);
  s.release(nameQ(4));
  const r = await done;
  assert.deepEqual(r.items.map((i) => i.uri), ['spotify:track:t1', 'spotify:track:t3', 'spotify:track:t4']);
  assert.deepEqual(f.calls.external[0].results.map((x) => [x.rank, x.status]), [[1, 'ok'], [3, 'ok'], [4, 'ok']]);
  assert.deepEqual(f.calls.events.map((e) => e.rank), [1, 3, 4]);
});

test('a 429 discards later in-flight matches, keeps earlier picks, and launches no new searches', async () => {
  const f = fakeDjdb({ items: [1, 2, 3, 4, 5, 6].map((k) => item(k)) });
  const s = gatedSpotify(allPlayable([1, 2, 3, 4, 5, 6]), { limited: [nameQ(2)] });
  const done = run(f, s, { n: 6 });
  await s.when(() => s.inFlight === 4);
  s.release(nameQ(1));
  s.release(nameQ(2));
  await s.when(() => s.inFlight === 2);
  assert.deepEqual(s.searches.map((x) => x.q), [1, 2, 3, 4].map(nameQ), 'no search is launched after the 429 is known');
  s.release(nameQ(3));
  s.release(nameQ(4));
  const r = await done;
  assert.equal(r.stopped.code, 'rate_limited');
  assert.equal(r.stopped.retry_after, 120);
  assert.deepEqual(r.items.map((i) => i.uri), ['spotify:track:t1']);
  assert.deepEqual(f.calls.external[0].results.map((x) => x.rank), [1]);
  assert.deepEqual(f.calls.events.map((e) => e.rank), [1]);
  assert.equal(s.searches.length, 4);
});

test('a network error stops the same way as a 429', async () => {
  const f = fakeDjdb({ items: [1, 2, 3].map((k) => item(k)) });
  const s = gatedSpotify(allPlayable([1, 2, 3]), { errors: { [nameQ(2)]: new Error('socket hang up') } });
  const done = run(f, s, { n: 3 });
  await s.when(() => s.inFlight === 3);
  s.release(nameQ(1));
  s.release(nameQ(2));
  s.release(nameQ(3));
  const r = await done;
  assert.equal(r.stopped.code, 'error');
  assert.match(r.stopped.message, /socket hang up/);
  assert.deepEqual(r.items.map((i) => i.uri), ['spotify:track:t1']);
  assert.deepEqual(f.calls.external[0].results.map((x) => x.rank), [1]);
  assert.deepEqual(f.calls.events.map((e) => e.rank), [1]);
  assert.equal(s.searches.length, 3);
});

test('cached, unplayable, not_found and valid items can be mixed; caches do not take a search slot', async () => {
  const f = fakeDjdb({ items: [
    item(1, { playable: { play_uri: 'spotify:track:c1' } }),
    item(2),
    item(3),
    item(4),
    item(5, { playable: { play_uri: 'spotify:track:c1' } }),
    item(6),
    item(7, { artist: '' }),
    item(8),
  ] });
  const s = gatedSpotify({
    [nameQ(2)]: [track('x2', 'Other Song', 'Artist 2')],
    [nameQ(3)]: [track('t3', 'Song 3', 'Artist 3')],
    [nameQ(6)]: [track('t6', 'Song 6', 'Artist 6')],
    [nameQ(8)]: [track('t8', 'Song 8', 'Artist 8')],
  });
  const done = run(f, s, { n: 3 });
  // Rank 1 is cached and committed immediately, so remaining need is 2: only two searches start.
  await s.when(() => s.inFlight === 2);
  assert.equal(s.peak, 2);
  assert.deepEqual(s.searches.map((x) => x.q), [nameQ(2), nameQ(3)]);
  s.release(nameQ(2));
  s.release(nameQ(3));
  // Rank 2 is a different recording (not a miss), rank 3 matches; still need one more.
  // Rank 4 returns no tracks (not_found, recorded), rank 5 is a cached duplicate, rank 7 has
  // no artist: none of those fill n, so rank 6 is searched and taken.
  await s.when(() => s.searches.some((x) => x.q === nameQ(4)));
  s.release(nameQ(4));
  await s.when(() => s.searches.some((x) => x.q === nameQ(6)));
  s.release(nameQ(6));
  const r = await done;
  assert.deepEqual(r.items.map((i) => [i.uri, i.resolved_by]), [
    ['spotify:track:c1', 'cache'],
    ['spotify:track:t3', 'search'],
    ['spotify:track:t6', 'search'],
  ]);
  assert.deepEqual(f.calls.external[0].results.map((x) => [x.rank, x.status]), [
    [3, 'ok'],
    [4, 'not_found'],
    [6, 'ok'],
  ]);
  assert.deepEqual(f.calls.events.map((e) => e.rank), [1, 3, 6]);
  assert.deepEqual(s.searches.map((x) => x.q), [nameQ(2), nameQ(3), nameQ(4), nameQ(6)]);
  assert.equal(s.peak, 2);
  assert.ok(!s.searches.some((x) => x.q === nameQ(8)));
});

test('recommend returns promptly when a later in-flight search never settles after an earlier failure', async () => {
  const f = fakeDjdb({ items: [1, 2, 3].map((k) => item(k)) });
  const s = gatedSpotify(allPlayable([1, 2, 3]), { limited: [nameQ(2)] });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const done = run(f, s, { n: 3 });
    await s.when(() => s.inFlight === 3);
    s.release(nameQ(1));
    s.release(nameQ(2));
    // Rank 3 is left held: it never settles.
    const r = await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('recommend hung waiting for a later in-flight search')), 1000)),
    ]);
    assert.equal(r.stopped.code, 'rate_limited');
    assert.deepEqual(r.items.map((i) => i.uri), ['spotify:track:t1']);
    assert.deepEqual(f.calls.external[0].results.map((x) => x.rank), [1]);
    assert.equal(s.searches.length, 3);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a later in-flight fetch that honors signal is aborted on early-stop', async () => {
  const f = fakeDjdb({ items: [1, 2, 3].map((k) => item(k)) });
  const s = gatedSpotify(allPlayable([1, 2, 3]), { limited: [nameQ(2)], honorSignal: true });
  const done = run(f, s, { n: 3 });
  await s.when(() => s.inFlight === 3);
  s.release(nameQ(1));
  s.release(nameQ(2));
  const r = await done;
  await s.when(() => s.inFlight === 0, 'aborted in-flight searches to settle');
  assert.equal(s.inFlight, 0);
  assert.ok(s.completed.includes(nameQ(3)), 'the later fetch rejected via signal abort');
  assert.equal(r.stopped.code, 'rate_limited');
  assert.deepEqual(r.items.map((i) => i.uri), ['spotify:track:t1']);
  assert.deepEqual(f.calls.external[0].results.map((x) => x.rank), [1]);
});

test('a retryable 429 is not retried or amplified across concurrent searches', async () => {
  const slept = [];
  const f = fakeDjdb({ items: [1, 2, 3, 4, 5, 6].map((k) => item(k)) });
  const s = spotify(allPlayable([1, 2, 3, 4, 5, 6]), { limited: [1, 2, 3, 4, 5, 6].map(nameQ), retryAfter: 2 });
  const r = await run(f, s, { n: 6 }, { sleep: async (ms) => slept.push(ms) });
  assert.equal(r.stopped.code, 'rate_limited');
  assert.equal(r.stopped.retry_after, 2);
  assert.deepEqual(r.items, []);
  assert.deepEqual(f.calls.external, []);
  assert.deepEqual(slept, [], 'recommend searches must not sleep-and-retry a 429');
  assert.equal(s.searches.length, 4, 'only the first wave is sent; no retries after the 429');
  assert.deepEqual([...new Set(s.searches.map((x) => x.q))], [1, 2, 3, 4].map(nameQ));
});

test('n=1 searches only the first needed item; n=20 fills all twenty in rank order', async () => {
  const one = fakeDjdb({ items: [1, 2, 3, 4, 5].map((k) => item(k)) });
  const s1 = spotify(allPlayable([1, 2, 3, 4, 5]));
  const r1 = await run(one, s1, { n: 1 });
  assert.deepEqual(r1.items.map((i) => i.uri), ['spotify:track:t1']);
  assert.deepEqual(s1.searches.map((x) => x.q), [nameQ(1)]);
  assert.deepEqual(one.calls.events.map((e) => e.rank), [1]);

  const ranks = Array.from({ length: 20 }, (_, i) => i + 1);
  const many = fakeDjdb({ items: ranks.map((k) => item(k)) });
  const s20 = spotify(allPlayable(ranks));
  const r20 = await run(many, s20, { n: 20 });
  assert.deepEqual(r20.items.map((i) => i.uri), ranks.map((k) => `spotify:track:t${k}`));
  assert.deepEqual(s20.searches.map((x) => x.q), ranks.map(nameQ));
  assert.deepEqual(many.calls.events.map((e) => e.rank), ranks);
  assert.deepEqual(many.calls.external[0].results.map((x) => x.rank), ranks);
});

test('empty items and an all-cached list need no search', async () => {
  const empty = fakeDjdb({ items: [] });
  const s0 = spotify();
  const r0 = await run(empty, s0, { n: 5 });
  assert.deepEqual(r0.items, []);
  assert.equal(r0.reason, 'no playable recommendations');
  assert.equal(s0.searches.length, 0);
  assert.deepEqual(empty.calls.external, []);
  assert.deepEqual(empty.calls.events, []);

  const cached = fakeDjdb({ items: [
    item(1, { playable: { play_uri: 'spotify:track:c1' } }),
    item(2, { playable: { play_uri: 'spotify:track:c2' } }),
    item(3, { playable: { play_uri: 'spotify:track:c3' } }),
    item(4, { playable: { play_uri: 'spotify:track:c2' } }),
    item(5, { playable: { play_uri: 'spotify:track:c5' } }),
  ] });
  const sC = spotify();
  const rC = await run(cached, sC, { n: 3 });
  assert.deepEqual(rC.items.map((i) => [i.uri, i.resolved_by]), [
    ['spotify:track:c1', 'cache'],
    ['spotify:track:c2', 'cache'],
    ['spotify:track:c3', 'cache'],
  ]);
  assert.equal(sC.searches.length, 0);
  assert.deepEqual(cached.calls.external, []);
  assert.deepEqual(cached.calls.events.map((e) => e.rank), [1, 2, 3]);
});

test('resolve concurrency is clamped to 1..4; invalid values become the default', () => {
  assert.equal(MAX_RESOLVE_CONCURRENCY, 4);
  assert.equal(clampResolveConcurrency(10), 4);
  assert.equal(clampResolveConcurrency(Infinity), 4);
  assert.equal(clampResolveConcurrency(0), 4);
  assert.equal(clampResolveConcurrency(-1), 4);
  assert.equal(clampResolveConcurrency(NaN), 4);
  assert.equal(clampResolveConcurrency(), 4);
  assert.equal(clampResolveConcurrency(1), 1);
  assert.equal(clampResolveConcurrency(3), 3);
  assert.equal(clampResolveConcurrency(4), 4);
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
