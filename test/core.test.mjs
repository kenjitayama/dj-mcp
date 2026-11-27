import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCore, codeChallengeS256, generateVerifier, base64url, SCOPES, resolveConfigDir } from '../lib/core.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sdj-test-'));

function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    for (const r of routes) {
      if (r.match(url, init, calls)) {
        const { status = 200, body, headers = {} } = typeof r.respond === 'function' ? r.respond(url, init, calls) : r.respond;
        const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
        return { status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => text };
      }
    }
    throw new Error('unmocked ' + url);
  };
  fn.calls = calls;
  return fn;
}
const isToken = (u) => u === 'https://accounts.spotify.com/api/token';
const form = (init) => Object.fromEntries(new URLSearchParams(init.body));

function seedTokens(dir, over = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ access_token: 'AT-old', refresh_token: 'RT-1', scope: SCOPES.join(' '), expires_at: Date.now() + 3600e3, client_id: 'cid', ...over }), { mode: 0o600 });
}

test('PKCE S256 challenge matches RFC 7636 appendix B vector and is base64url', () => {
  // RFC 7636 Appendix B
  assert.equal(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const v = generateVerifier();
  assert.ok(v.length >= 43 && v.length <= 128, 'verifier length');
  assert.match(v, /^[A-Za-z0-9\-._~]+$/);
  const c = codeChallengeS256(v);
  assert.match(c, /^[A-Za-z0-9_-]{43}$/, 'no padding, url-safe');
  assert.equal(c, createHash('sha256').update(v).digest('base64url'));
  assert.equal(base64url(Buffer.from([0xfb, 0xff])), '-_8');
});

test('auth_start builds correct URL and persists pending state with 0600/0700 perms', async () => {
  const dir = tmpDir();
  const core = createCore({ configDir: path.join(dir, 'cfg'), clientId: 'cid', fetch: mockFetch([]) });
  const r = await core.callTool('auth_start');
  const u = new URL(r.authorize_url);
  assert.equal(u.origin + u.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:8888/callback');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('scope'), SCOPES.join(' '));
  const pending = JSON.parse(fs.readFileSync(path.join(dir, 'cfg', 'pending_auth.json'), 'utf8'));
  assert.equal(u.searchParams.get('state'), pending.state);
  assert.equal(u.searchParams.get('code_challenge'), codeChallengeS256(pending.verifier));
  assert.equal(fs.statSync(path.join(dir, 'cfg')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'cfg', 'pending_auth.json')).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(r).includes(pending.verifier), 'verifier not exposed');
});

test('auth_complete rejects state mismatch and does not call token endpoint', async () => {
  const dir = tmpDir();
  const f = mockFetch([]);
  const core = createCore({ configDir: dir, clientId: 'cid', fetch: f });
  await core.callTool('auth_start');
  await assert.rejects(core.callTool('auth_complete', { redirect_url: 'http://127.0.0.1:8888/callback?code=abc&state=WRONG' }), (e) => e.code === 'state_mismatch');
  await assert.rejects(core.callTool('auth_complete', { redirect_url: 'http://127.0.0.1:8888/callback?code=abc' }), (e) => e.code === 'state_mismatch');
  await assert.rejects(core.callTool('auth_complete', { code: 'abc', state: 'WRONG' }), (e) => e.code === 'state_mismatch');
  await assert.rejects(core.callTool('auth_complete', { redirect_url: 'http://127.0.0.1:8888/callback?error=access_denied&state=x' }), (e) => e.code === 'authorization_denied');
  assert.equal(f.calls.length, 0);
});

test('auth_complete exchanges code with verifier (PKCE, no secret) and stores tokens 0600', async () => {
  const dir = tmpDir();
  const f = mockFetch([{ match: isToken, respond: { body: { access_token: 'AT-1', token_type: 'Bearer', scope: SCOPES.join(' '), expires_in: 3600, refresh_token: 'RT-1' } } }]);
  const core = createCore({ configDir: dir, clientId: 'cid', fetch: f });
  await core.callTool('auth_start');
  const pending = JSON.parse(fs.readFileSync(path.join(dir, 'pending_auth.json'), 'utf8'));
  const r = await core.callTool('auth_complete', { redirect_url: `http://127.0.0.1:8888/callback?code=THECODE&state=${pending.state}` });
  assert.equal(r.authorized, true);
  assert.equal(r.state_checked, true);
  assert.deepEqual(r.missing_scopes, []);
  assert.ok(!JSON.stringify(r).includes('AT-1') && !JSON.stringify(r).includes('RT-1'), 'no tokens in output');
  const sent = form(f.calls[0].init);
  assert.deepEqual(sent, { grant_type: 'authorization_code', code: 'THECODE', redirect_uri: 'http://127.0.0.1:8888/callback', client_id: 'cid', code_verifier: pending.verifier });
  assert.equal(f.calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.ok(!('Authorization' in f.calls[0].init.headers), 'no client secret / basic auth');
  const t = JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8'));
  assert.equal(t.refresh_token, 'RT-1');
  assert.equal(fs.statSync(path.join(dir, 'tokens.json')).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(dir, 'pending_auth.json')), 'pending cleared');
  assert.deepEqual(fs.readdirSync(dir).filter((x) => x.endsWith('.tmp')), [], 'no temp files left');
  const st = await core.callTool('auth_status');
  assert.equal(st.authorized, true);
  assert.ok(!JSON.stringify(st).includes('AT-1') && !JSON.stringify(st).includes('RT-1'));
});

test('bare code is accepted (state unverifiable) and exchanged', async () => {
  const dir = tmpDir();
  const f = mockFetch([{ match: isToken, respond: { body: { access_token: 'AT', scope: '', expires_in: 3600, refresh_token: 'RT' } } }]);
  const core = createCore({ configDir: dir, clientId: 'cid', fetch: f });
  await core.callTool('auth_start');
  const r = await core.callTool('auth_complete', { code: 'BARE' });
  assert.equal(r.state_checked, false);
  assert.equal(form(f.calls[0].init).code, 'BARE');
});

test('401 triggers exactly one refresh, retries, and persists rotated refresh token', async () => {
  const dir = tmpDir();
  seedTokens(dir);
  let apiHits = 0;
  const f = mockFetch([
    { match: isToken, respond: { body: { access_token: 'AT-new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT-2', scope: SCOPES.join(' ') } } },
    {
      match: (u) => u.startsWith('https://api.spotify.com/v1/me/player/devices'),
      respond: (u, init) => {
        apiHits++;
        if (init.headers.Authorization === 'Bearer AT-old') return { status: 401, body: { error: { status: 401, message: 'The access token expired' } } };
        return { body: { devices: [{ id: 'd1', name: 'Example Speaker One', type: 'Computer', is_active: true, volume_percent: 60, is_private_session: false, supports_volume: true }] } };
      },
    },
  ]);
  const core = createCore({ configDir: dir, clientId: 'cid', fetch: f });
  const r = await core.callTool('get_devices');
  assert.deepEqual(r, { devices: [{ id: 'd1', name: 'Example Speaker One', type: 'Computer', is_active: true, volume_percent: 60 }] });
  assert.equal(apiHits, 2);
  const refreshCalls = f.calls.filter((c) => isToken(c.url));
  assert.equal(refreshCalls.length, 1);
  assert.deepEqual(form(refreshCalls[0].init), { grant_type: 'refresh_token', refresh_token: 'RT-1', client_id: 'cid' });
  const t = JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8'));
  assert.equal(t.refresh_token, 'RT-2', 'rotated refresh token persisted');
  assert.equal(t.access_token, 'AT-new');
});

test('persistent 401 after refresh surfaces unauthorized (no infinite loop)', async () => {
  const dir = tmpDir();
  seedTokens(dir);
  const f = mockFetch([
    { match: isToken, respond: { body: { access_token: 'AT-x', expires_in: 3600 } } },
    { match: () => true, respond: { status: 401, body: { error: { status: 401, message: 'Invalid access token' } } } },
  ]);
  const core = createCore({ configDir: dir, clientId: 'cid', fetch: f });
  await assert.rejects(core.callTool('get_devices'), (e) => e.code === 'unauthorized');
  assert.equal(f.calls.filter((c) => isToken(c.url)).length, 1);
  const t = JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8'));
  assert.equal(t.refresh_token, 'RT-1', 'old refresh token kept when none returned');
});

test('expired access token is refreshed proactively', async () => {
  const dir = tmpDir();
  seedTokens(dir, { expires_at: Date.now() - 1000 });
  const f = mockFetch([
    { match: isToken, respond: { body: { access_token: 'AT-fresh', expires_in: 3600, refresh_token: 'RT-9' } } },
    { match: (u, i) => i.headers?.Authorization === 'Bearer AT-fresh', respond: { status: 204 } },
  ]);
  const core = createCore({ configDir: dir, clientId: 'cid', fetch: f });
  assert.deepEqual(await core.callTool('pause'), { ok: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8')).refresh_token, 'RT-9');
});

test('429 honors Retry-After then succeeds; long Retry-After surfaces rate_limited', async () => {
  const dir = tmpDir();
  seedTokens(dir);
  let n = 0;
  const slept = [];
  const f = mockFetch([{ match: () => true, respond: () => (++n === 1 ? { status: 429, headers: { 'retry-after': '2' } } : { status: 204 }) }]);
  const core = createCore({ configDir: dir, fetch: f, sleep: async (ms) => slept.push(ms) });
  assert.deepEqual(await core.callTool('next'), { ok: true });
  assert.deepEqual(slept, [2000]);
  const f2 = mockFetch([{ match: () => true, respond: { status: 429, headers: { 'retry-after': '120' } } }]);
  const core2 = createCore({ configDir: dir, fetch: f2, sleep: async () => {} });
  await assert.rejects(core2.callTool('next'), (e) => e.code === 'rate_limited' && e.retry_after === 120);
});

test('aborting during a Retry-After delay rejects promptly and cancels the timer', async () => {
  const dir = tmpDir();
  seedTokens(dir);

  const pending = new Set();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    const id = realSetTimeout((...a) => {
      pending.delete(id);
      fn(...a);
    }, ms, ...args);
    if (ms >= 1000) pending.add(id);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    pending.delete(id);
    return realClearTimeout(id);
  };
  try {
    const ac = new AbortController();
    let fetches = 0;
    const f = mockFetch([{
      match: () => true,
      respond: () => {
        fetches++;
        realSetTimeout(() => ac.abort(), 5);
        return { status: 429, headers: { 'retry-after': '30' } };
      },
    }]);
    const core = createCore({ configDir: dir, fetch: f });
    await assert.rejects(core.api('POST', '/me/player/next', { signal: ac.signal }), (e) => e.name === 'AbortError');
    assert.equal(fetches, 1, 'a cancelled retry delay must not issue another request');
    assert.equal(pending.size, 0, 'the Retry-After timer was cleared');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }

  const ac2 = new AbortController();
  let sleepStarted = 0;
  const f2 = mockFetch([{ match: () => true, respond: { status: 429, headers: { 'retry-after': '2' } } }]);
  const core2 = createCore({
    configDir: dir,
    fetch: f2,
    sleep: async () => {
      sleepStarted++;
      ac2.abort();
    },
  });
  await assert.rejects(core2.api('POST', '/me/player/next', { signal: ac2.signal }), (e) => e.name === 'AbortError');
  assert.equal(sleepStarted, 1);
  assert.equal(f2.calls.length, 1, 'a missed sync abort would retry and fetch again');
});

test('search clamps limit to 10, trims shapes, drops null playlist entries', async () => {
  const dir = tmpDir();
  seedTokens(dir);
  const f = mockFetch([
    {
      match: (u) => u.startsWith('https://api.spotify.com/v1/search'),
      respond: {
        body: {
          tracks: { items: [{ uri: 'spotify:track:1', id: '1', name: 'Song', artists: [{ name: 'A', id: 'a' }, { name: 'B' }], album: { name: 'Alb', images: [{}] }, duration_ms: 1000, popularity: 3, available_markets: ['JP'], preview_url: null }] },
          albums: { items: [{ uri: 'spotify:album:2', name: 'Alb', artists: [{ name: 'A' }], release_date: '2020', total_tracks: 9, images: [] }] },
          artists: { items: [{ uri: 'spotify:artist:3', name: 'A', genres: ['jazz'], images: [] }] },
          playlists: { items: [null, { uri: 'spotify:playlist:4', id: '4', name: 'PL', owner: { display_name: 'K', id: 'k' }, public: true, items: { total: 12 }, description: '' }] },
        },
      },
    },
  ]);
  const core = createCore({ configDir: dir, fetch: f });
  const r = await core.callTool('search', { query: 'x', types: ['track', 'album', 'artist', 'playlist'], limit: 50 });
  const u = new URL(f.calls[0].url);
  assert.equal(u.searchParams.get('limit'), '10');
  assert.equal(u.searchParams.get('type'), 'track,album,artist,playlist');
  assert.equal(r.limit, 10);
  assert.equal(r.limit_clamped_from, 50);
  assert.deepEqual(r.tracks, [{ uri: 'spotify:track:1', name: 'Song', artists: ['A', 'B'], album: 'Alb', duration_ms: 1000 }]);
  assert.deepEqual(r.albums, [{ uri: 'spotify:album:2', name: 'Alb', artists: ['A'], release_date: '2020', total_tracks: 9 }]);
  assert.deepEqual(r.artists, [{ uri: 'spotify:artist:3', name: 'A', genres: ['jazz'] }]);
  assert.deepEqual(r.playlists, [{ uri: 'spotify:playlist:4', id: '4', name: 'PL', owner: 'K', public: true, total_items: 12, description: null }]);
  await core.callTool('search', { query: 'x', limit: 0 });
  assert.equal(new URL(f.calls[1].url).searchParams.get('limit'), '1');
  await core.callTool('search', { query: 'x' });
  assert.equal(new URL(f.calls[2].url).searchParams.get('limit'), '5');
});

test('playback trimming and 204 no-session handling', async () => {
  const dir = tmpDir();
  seedTokens(dir);
  let first = true;
  const f = mockFetch([
    {
      match: (u) => u.startsWith('https://api.spotify.com/v1/me/player?'),
      respond: () => {
        if (first) {
          first = false;
          return { body: { device: { id: 'd1', name: 'Mac', type: 'Computer', is_active: true, volume_percent: 40, supports_volume: true }, item: { type: 'track', uri: 'spotify:track:1', name: 'S', artists: [{ name: 'A' }], album: { name: 'Al' }, duration_ms: 5 }, is_playing: true, progress_ms: 3, shuffle_state: false, repeat_state: 'off', context: {}, actions: {} } };
        }
        return { status: 204 };
      },
    },
  ]);
  const core = createCore({ configDir: dir, fetch: f });
  assert.deepEqual(await core.callTool('get_currently_playing'), {
    device: { id: 'd1', name: 'Mac', type: 'Computer', is_active: true, volume_percent: 40 },
    item: { uri: 'spotify:track:1', name: 'S', artists: ['A'], album: 'Al', duration_ms: 5 },
    is_playing: true,
    progress_ms: 3,
    shuffle: false,
    repeat: 'off',
  });
  const r2 = await core.callTool('get_currently_playing');
  assert.equal(r2.item, null);
  assert.equal(r2.is_playing, false);
  assert.match(r2.note, /No active playback/);
});

test('no active device error explains and suggests get_devices/transfer_playback', async () => {
  const dir = tmpDir();
  seedTokens(dir);
  const f = mockFetch([{ match: () => true, respond: { status: 404, body: { error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } } } }]);
  const core = createCore({ configDir: dir, fetch: f });
  await assert.rejects(core.callTool('play', { uris: ['spotify:track:abc'] }), (e) => e.code === 'no_active_device' && /get_devices/.test(e.hint) && /transfer_playback/.test(e.hint));
});

test('play builds body (uris / context+offset / device), validates input', async () => {
  const dir = tmpDir();
  seedTokens(dir);
  const f = mockFetch([
    { match: (u) => u.includes('/me/player/devices'), respond: { body: { devices: [{ id: 'mac1', name: 'Example Speaker One', type: 'Computer', is_active: false, volume_percent: 50 }] } } },
    { match: () => true, respond: { status: 204 } },
  ]);
  const core = createCore({ configDir: dir, fetch: f });
  await core.callTool('play', { uris: ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x'], device_id: 'dev9' });
  let c = f.calls.at(-1);
  assert.equal(new URL(c.url).pathname, '/v1/me/player/play');
  assert.equal(new URL(c.url).searchParams.get('device_id'), 'dev9');
  assert.deepEqual(JSON.parse(c.init.body), { uris: ['spotify:track:4uLU6hMCjMI75M1A2tKUQC'] });
  await core.callTool('play', { context_uri: 'spotify:playlist:37i9dQZF1DX0XUsuxWHRQd', offset: 3, device_name: 'example speaker' });
  c = f.calls.at(-1);
  assert.equal(new URL(c.url).searchParams.get('device_id'), 'mac1');
  assert.deepEqual(JSON.parse(c.init.body), { context_uri: 'spotify:playlist:37i9dQZF1DX0XUsuxWHRQd', offset: { position: 3 } });
  await core.callTool('play', {});
  assert.equal(f.calls.at(-1).init.body, undefined, 'resume has no body');
  await assert.rejects(core.callTool('play', { uris: ['spotify:track:a'], context_uri: 'spotify:album:b' }), (e) => e.code === 'invalid_argument');
  await assert.rejects(core.callTool('play', { uris: ['not-a-uri'] }), (e) => e.code === 'invalid_argument');
  await core.callTool('transfer_playback', { device_id: 'mac1', play: true });
  assert.deepEqual(JSON.parse(f.calls.at(-1).init.body), { device_ids: ['mac1'], play: true });
  await core.callTool('set_volume', { volume_percent: 150 });
  assert.equal(new URL(f.calls.at(-1).url).searchParams.get('volume_percent'), '100');
  await core.callTool('add_to_queue', { uri: 'spotify:track:q1' });
  assert.equal(new URL(f.calls.at(-1).url).searchParams.get('uri'), 'spotify:track:q1');
});

test('create_playlist uses POST /me/playlists; add_items uses /playlists/{id}/items in batches of 100', async () => {
  const dir = tmpDir();
  seedTokens(dir);
  const f = mockFetch([
    { match: (u, i) => u.endsWith('/v1/me/playlists') && i.method === 'POST', respond: { status: 201, body: { uri: 'spotify:playlist:P1', id: 'P1', name: 'Mix', owner: { display_name: 'Alex' }, public: false, items: { total: 0 }, description: null, images: [] } } },
    { match: (u) => u.includes('/v1/playlists/P1/items'), respond: { status: 201, body: { snapshot_id: 'snap' } } },
  ]);
  const core = createCore({ configDir: dir, fetch: f });
  const p = await core.callTool('create_playlist', { name: 'Mix', description: 'd' });
  assert.deepEqual(p, { uri: 'spotify:playlist:P1', id: 'P1', name: 'Mix', owner: 'Alex', public: false, total_items: 0, description: null });
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { name: 'Mix', public: false, description: 'd' });
  const uris = Array.from({ length: 150 }, (_, i) => `spotify:track:t${i}`);
  const r = await core.callTool('add_items_to_playlist', { playlist_id: 'spotify:playlist:P1', uris });
  assert.deepEqual(r, { ok: true, playlist_id: 'P1', added: 150, snapshot_id: 'snap' });
  const adds = f.calls.filter((c) => c.url.includes('/items'));
  assert.equal(adds.length, 2);
  assert.equal(JSON.parse(adds[0].init.body).uris.length, 100);
  assert.equal(JSON.parse(adds[1].init.body).uris.length, 50);
});

test('recently played and top items are trimmed', async () => {
  const dir = tmpDir();
  seedTokens(dir);
  const tr = { uri: 'spotify:track:1', name: 'S', artists: [{ name: 'A' }], album: { name: 'Al' }, duration_ms: 1, popularity: 9 };
  const f = mockFetch([
    { match: (u) => u.includes('/recently-played'), respond: { body: { items: [{ played_at: '2026-11-22T00:00:00Z', track: tr, context: null }], cursors: {} } } },
    { match: (u) => u.includes('/me/top/artists'), respond: { body: { items: [{ uri: 'spotify:artist:a', name: 'A', genres: ['pop'], followers: {}, images: [] }] } } },
  ]);
  const core = createCore({ configDir: dir, fetch: f });
  assert.deepEqual(await core.callTool('get_recently_played', { limit: 99 }), { items: [{ played_at: '2026-11-22T00:00:00Z', track: { uri: 'spotify:track:1', name: 'S', artists: ['A'], album: 'Al', duration_ms: 1 } }] });
  assert.equal(new URL(f.calls[0].url).searchParams.get('limit'), '50');
  assert.deepEqual(await core.callTool('get_top_items', { type: 'artists', time_range: 'short_term' }), { type: 'artists', time_range: 'short_term', items: [{ uri: 'spotify:artist:a', name: 'A', genres: ['pop'] }] });
});

test('client ID resolution: env > config.json > friendly error; ${...} placeholder ignored', async () => {
  const dir = tmpDir();
  const saved = process.env.SPOTIFY_CLIENT_ID;
  try {
    delete process.env.SPOTIFY_CLIENT_ID;
    const core = createCore({ configDir: dir, fetch: mockFetch([]) });
    assert.equal(core.clientId, null);
    await assert.rejects(core.callTool('auth_start'), (e) => e.code === 'client_id_missing' && /developer\.spotify\.com\/dashboard/.test(e.hint) && /SPOTIFY_CLIENT_ID/.test(e.hint));
    const st = await core.callTool('auth_status');
    assert.equal(st.client_id, null);
    assert.match(st.client_id_error, /SPOTIFY_CLIENT_ID/);
    assert.ok(!fs.existsSync(path.join(dir, 'pending_auth.json')));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ client_id: 'fromconfig' }));
    assert.deepEqual(core.resolveClientId(), { client_id: 'fromconfig', source: 'config' });
    process.env.SPOTIFY_CLIENT_ID = '${SPOTIFY_CLIENT_ID}';
    assert.equal(core.resolveClientId().source, 'config', 'unexpanded placeholder treated as unset');
    process.env.SPOTIFY_CLIENT_ID = 'fromenv';
    assert.deepEqual(core.resolveClientId(), { client_id: 'fromenv', source: 'env' });
    const u = new URL((await core.callTool('auth_start')).authorize_url);
    assert.equal(u.searchParams.get('client_id'), 'fromenv');
  } finally {
    if (saved === undefined) delete process.env.SPOTIFY_CLIENT_ID;
    else process.env.SPOTIFY_CLIENT_ID = saved;
  }
});

test('refresh uses the client_id stored with the tokens (refresh token is bound to it); mismatch reported', async () => {
  const dir = tmpDir();
  seedTokens(dir, { client_id: 'issuedto', expires_at: Date.now() - 1 });
  const f = mockFetch([
    { match: isToken, respond: { body: { access_token: 'AT-n', expires_in: 3600 } } },
    { match: () => true, respond: { status: 204 } },
  ]);
  const core = createCore({ configDir: dir, clientId: 'configured', fetch: f });
  await core.callTool('pause');
  assert.equal(form(f.calls[0].init).client_id, 'issuedto');
  const st = await core.callTool('auth_status');
  assert.equal(st.authorized, true);
  assert.match(st.client_id_mismatch, /different Client ID/);
});

test('config dir: opts.configDir > DJ_MCP_CONFIG_DIR > ~/.config/dj-mcp', () => {
  const saved = process.env.DJ_MCP_CONFIG_DIR;
  try {
    delete process.env.DJ_MCP_CONFIG_DIR;
    assert.equal(resolveConfigDir({ homeDir: '/h' }), path.join('/h', '.config', 'dj-mcp'));
    process.env.DJ_MCP_CONFIG_DIR = '/x/env';
    assert.equal(resolveConfigDir({ homeDir: '/h' }), '/x/env');
    assert.equal(resolveConfigDir({ homeDir: '/h', configDir: '/x/opt' }), '/x/opt');
  } finally {
    if (saved === undefined) delete process.env.DJ_MCP_CONFIG_DIR;
    else process.env.DJ_MCP_CONFIG_DIR = saved;
  }
});
