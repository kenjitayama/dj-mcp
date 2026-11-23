// Characterization tests: pin the tool list, auth_status, and the CLI exactly as they behave
// today, so later changes (e.g. the optional recommender) can prove they leave them unchanged.
// Some pinned CLI behaviors are known quirks kept on purpose; see the comments on each case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore, SCOPES, DEFAULT_REDIRECT_URI } from '../lib/core.mjs';
import { probeDjdb } from '../lib/recommender.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sdj-contract-'));
const NOW = 1_800_000_000_000;
// With djdb-mcp installed on a Node in its range, recommend is appended. Without it, the list is exactly the pinned one.
const WITH_DJDB = probeDjdb();
const pinnedPlusOptional = (list, golden) => {
  assert.deepEqual(WITH_DJDB ? list.slice(0, -1) : list, golden);
  if (WITH_DJDB) assert.equal(list.at(-1).name, 'recommend');
};

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

function seedTokens(dir, over = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const t = { access_token: 'AT-fake', refresh_token: 'RT-fake', scope: SCOPES.join(' '), expires_at: NOW + 3600e3, client_id: 'cid', ...over };
  fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify(t), { mode: 0o600 });
}

test('tools/list is exactly the pinned list (names, descriptions, input schemas)', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(fixtures, 'contract-tools.json'), 'utf8'));
  const core = createCore({ configDir: tmpDir(), clientId: 'cid' });
  pinnedPlusOptional(core.tools, golden);
});

test('auth_status shape: authorized with matching client id', async () => {
  const dir = tmpDir();
  seedTokens(dir);
  const r = await withEnv({ SPOTIFY_REDIRECT_URI: undefined }, () => createCore({ configDir: dir, clientId: 'cid', now: () => NOW })).callTool('auth_status');
  assert.deepEqual(r, {
    authorized: true,
    has_refresh_token: true,
    access_token_expired: false,
    expires_at: new Date(NOW + 3600e3).toISOString(),
    scopes: SCOPES,
    missing_scopes: [],
    pending_authorization: false,
    client_id: 'cid',
    client_id_source: 'option',
    redirect_uri: DEFAULT_REDIRECT_URI,
    token_store: path.join(dir, 'tokens.json'),
    next_step: null,
  });
});

test('auth_status shape: nothing configured', async () => {
  const dir = tmpDir();
  const r = await withEnv({ SPOTIFY_CLIENT_ID: undefined, SPOTIFY_REDIRECT_URI: undefined }, () => createCore({ configDir: dir, now: () => NOW }).callTool('auth_status'));
  assert.deepEqual(r, {
    authorized: false,
    has_refresh_token: false,
    access_token_expired: null,
    expires_at: null,
    scopes: [],
    missing_scopes: SCOPES,
    pending_authorization: false,
    client_id: null,
    client_id_source: null,
    client_id_error: 'No Spotify Client ID configured. Set SPOTIFY_CLIENT_ID or client_id in ' + path.join(dir, 'config.json') + '.',
    redirect_uri: DEFAULT_REDIRECT_URI,
    token_store: path.join(dir, 'tokens.json'),
    next_step: 'Configure a Spotify Client ID first (see client_id_error), then auth_start.',
  });
});

test('auth_status shape: tokens issued to another client id', async () => {
  const dir = tmpDir();
  seedTokens(dir, { client_id: 'other' });
  const r = await withEnv({ SPOTIFY_REDIRECT_URI: undefined }, () => createCore({ configDir: dir, clientId: 'cid', now: () => NOW }).callTool('auth_status'));
  assert.deepEqual(Object.keys(r), [
    'authorized', 'has_refresh_token', 'access_token_expired', 'expires_at', 'scopes', 'missing_scopes',
    'pending_authorization', 'client_id', 'client_id_source', 'client_id_mismatch', 'redirect_uri', 'token_store', 'next_step',
  ]);
  assert.match(r.client_id_mismatch, /different Client ID/);
});

function cli(args, { tokens = true } = {}) {
  const dir = tmpDir();
  if (tokens) seedTokens(dir, { expires_at: Date.now() + 3600e3 });
  const logFile = path.join(dir, 'requests.jsonl');
  fs.writeFileSync(logFile, '');
  const env = { ...process.env, DJ_MCP_CONFIG_DIR: dir, SPOTIFY_CLIENT_ID: 'cid', CLI_MOCK_LOG: logFile };
  delete env.SPOTIFY_REDIRECT_URI;
  const r = spawnSync(process.execPath, ['--import', path.join(fixtures, 'cli-fetch-mock.mjs'), path.join(root, 'bin', 'dj-mcp'), ...args], { env, encoding: 'utf8', timeout: 15000 });
  const requests = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr, requests };
}

const DEVICES = { method: 'GET', url: 'https://api.spotify.com/v1/me/player/devices', body: null };
const api = (method, p, body = null) => ({ method, url: 'https://api.spotify.com/v1' + p, body: body === null ? null : JSON.stringify(body) });

const CASES = [
  {
    name: 'transfer_playback with --play true',
    args: ['transfer_playback', '--device_name', 'Test Speaker A', '--play', 'true'],
    code: 0, out: { ok: true, device_id: 'dev-a' },
    requests: [DEVICES, api('PUT', '/me/player', { device_ids: ['dev-a'], play: true })],
  },
  {
    // Known quirk kept on purpose: a trailing bare boolean flag has no value, so play is not sent.
    name: 'transfer_playback with a trailing bare --play',
    args: ['transfer_playback', '--device_name', 'Test Speaker A', '--play'],
    code: 0, out: { ok: true, device_id: 'dev-a' },
    requests: [DEVICES, api('PUT', '/me/player', { device_ids: ['dev-a'] })],
  },
  {
    // Known quirk kept on purpose: a bare flag consumes the next token as its value.
    name: 'bare --play before another flag',
    args: ['transfer_playback', '--play', '--device_name', 'Test Speaker A'],
    code: 1, out: { error: { code: 'invalid_argument', message: 'Unexpected argument: Test Speaker A' } },
    requests: [],
  },
  {
    name: 'set_volume with a number',
    args: ['set_volume', '--volume_percent', '30'],
    code: 0, out: { ok: true, volume_percent: 30 },
    requests: [api('PUT', '/me/player/volume?volume_percent=30')],
  },
  {
    // Known quirk kept on purpose: a non-numeric volume falls back to 50.
    name: 'set_volume with "30%"',
    args: ['set_volume', '--volume_percent', '30%'],
    code: 0, out: { ok: true, volume_percent: 50 },
    requests: [api('PUT', '/me/player/volume?volume_percent=50')],
  },
  {
    name: 'set_volume with --key=value',
    args: ['set_volume', '--volume_percent=25'],
    code: 0, out: { ok: true, volume_percent: 25 },
    requests: [api('PUT', '/me/player/volume?volume_percent=25')],
  },
  {
    name: 'play a context with offset on a device matched by substring',
    args: ['play', '--context_uri', 'spotify:playlist:37i9dQZF1DX0XUsuxWHRQd', '--offset', '3', '--device_name', 'speaker b'],
    code: 0, out: { ok: true, device_id: 'dev-b', context_uri: 'spotify:playlist:37i9dQZF1DX0XUsuxWHRQd' },
    requests: [DEVICES, api('PUT', '/me/player/play?device_id=dev-b', { context_uri: 'spotify:playlist:37i9dQZF1DX0XUsuxWHRQd', offset: { position: 3 } })],
  },
  {
    name: 'play uris via --json',
    args: ['play', '--json', '{"uris":["spotify:track:4uLU6hMCjMI75M1A2tKUQC"]}'],
    code: 0, out: { ok: true, device_id: '(active device)', uris: ['spotify:track:4uLU6hMCjMI75M1A2tKUQC'] },
    requests: [api('PUT', '/me/player/play', { uris: ['spotify:track:4uLU6hMCjMI75M1A2tKUQC'] })],
  },
  {
    name: 'resume with no arguments',
    args: ['play'],
    code: 0, out: { ok: true, device_id: '(active device)' },
    requests: [api('PUT', '/me/player/play')],
  },
  {
    name: 'pause with a bare JSON argument',
    args: ['pause', '{"device_id":"dev-a"}'],
    code: 0, out: { ok: true },
    requests: [api('PUT', '/me/player/pause?device_id=dev-a')],
  },
  {
    name: 'next',
    args: ['next'],
    code: 0, out: { ok: true },
    requests: [api('POST', '/me/player/next')],
  },
  {
    name: 'add_to_queue',
    args: ['add_to_queue', '--uri', 'spotify:track:4uLU6hMCjMI75M1A2tKUQC'],
    code: 0, out: { ok: true, queued: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC' },
    requests: [api('POST', '/me/player/queue?uri=spotify%3Atrack%3A4uLU6hMCjMI75M1A2tKUQC')],
  },
  {
    name: 'unexpected positional argument',
    args: ['pause', 'oops'],
    code: 1, out: { error: { code: 'invalid_argument', message: 'Unexpected argument: oops' } },
    requests: [],
  },
  {
    name: 'unknown device name',
    args: ['pause', '--device_name', 'nowhere'],
    code: 1,
    out: { error: { code: 'device_not_found', message: 'No available device matches "nowhere".', hint: 'Available: Test Speaker A, Test Speaker B' } },
    requests: [DEVICES],
  },
];

for (const c of CASES) {
  test(`CLI: ${c.name}`, () => {
    const r = cli(c.args);
    assert.equal(r.code, c.code, r.stderr);
    assert.deepEqual(r.out, c.out);
    assert.deepEqual(r.requests, c.requests);
  });
}

test('CLI: unknown tool exits 1 without network', () => {
  const r = cli(['bogus_tool']);
  assert.equal(r.code, 1);
  assert.equal(r.out.error.code, 'unknown_tool');
  assert.deepEqual(r.requests, []);
});

test('CLI: not authorized exits 1 without network', () => {
  const r = cli(['pause'], { tokens: false });
  assert.equal(r.code, 1);
  assert.equal(r.out.error.code, 'not_authorized');
  assert.deepEqual(r.requests, []);
});

test('CLI: tools lists every tool with its params', () => {
  const r = cli(['tools']);
  assert.equal(r.code, 0);
  const golden = JSON.parse(fs.readFileSync(path.join(fixtures, 'contract-tools.json'), 'utf8'));
  pinnedPlusOptional(r.out.tools, golden.map((t) => ({ name: t.name, description: t.description, params: Object.keys(t.inputSchema.properties || {}) })));
  assert.deepEqual(r.requests, []);
});
