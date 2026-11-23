// dj-mcp core: auth (Authorization Code + PKCE), token store, Spotify Web API client,
// response trimming, and the tool registry shared by the MCP server and the CLI.
// Zero dependencies. Node >= 18 (global fetch, webcrypto).

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8888/callback';
export const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-top-read',
  'playlist-read-private',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-library-read',
];
export const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
export const TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const API_BASE = 'https://api.spotify.com/v1';
export const SEARCH_LIMIT_MAX = 10; // Feb 2026 dev-mode change: max 10 (default 5)
const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // relay to the user can be slow; Spotify codes themselves expire quickly after redirect
const REFRESH_SKEW_MS = 60 * 1000;

// ---------- small utils ----------

export class SpotifyError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'SpotifyError';
    this.code = code;
    Object.assign(this, extra);
  }
  toJSON() {
    const o = { code: this.code, message: this.message };
    for (const k of ['status', 'reason', 'hint', 'retry_after']) if (this[k] !== undefined) o[k] = this[k];
    return o;
  }
}

export function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
export function generateVerifier() {
  return base64url(randomBytes(64)); // 86 chars, RFC 7636 unreserved charset
}
export function codeChallengeS256(verifier) {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

function envValue(name) {
  const v = process.env[name];
  if (!v || /^\$\{[^}]*\}$/.test(v)) return undefined; // unexpanded placeholder => unset
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- config dir ----------
// Order: opts.configDir > env DJ_MCP_CONFIG_DIR > ~/.config/dj-mcp
export function resolveConfigDir(opts = {}) {
  if (opts.configDir) return opts.configDir;
  const env = envValue('DJ_MCP_CONFIG_DIR');
  if (env) return env;
  return path.join(opts.homeDir || os.homedir(), '.config', 'dj-mcp');
}

// ---------- token store (0700 dir, 0600 files, atomic writes) ----------

export class Store {
  constructor(dir) {
    this.dir = dir;
  }
  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
  }
  file(name) {
    return path.join(this.dir, name);
  }
  read(name) {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new SpotifyError('store_error', `Could not read ${name}: ${e.message}`);
    }
  }
  write(name, obj) {
    this.ensureDir();
    const target = this.file(name);
    const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(obj, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  }
  remove(name) {
    try {
      fs.unlinkSync(this.file(name));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}

// ---------- trimming to compact shapes ----------

export function trimTrack(t) {
  if (!t) return null;
  if (t.type === 'episode') {
    return {
      uri: t.uri,
      name: t.name,
      artists: t.show?.name ? [t.show.name] : [],
      album: t.show?.name ?? null,
      duration_ms: t.duration_ms ?? null,
      type: 'episode',
    };
  }
  return {
    uri: t.uri,
    name: t.name,
    artists: (t.artists || []).map((a) => a.name),
    album: t.album?.name ?? null,
    duration_ms: t.duration_ms ?? null,
  };
}
export function trimAlbum(a) {
  if (!a) return null;
  return {
    uri: a.uri,
    name: a.name,
    artists: (a.artists || []).map((x) => x.name),
    release_date: a.release_date ?? null,
    total_tracks: a.total_tracks ?? null,
  };
}
export function trimArtist(a) {
  if (!a) return null;
  return { uri: a.uri, name: a.name, genres: a.genres || [] };
}
export function trimPlaylist(p) {
  if (!p) return null;
  return {
    uri: p.uri,
    id: p.id,
    name: p.name,
    owner: p.owner?.display_name ?? p.owner?.id ?? null,
    public: p.public ?? null,
    total_items: p.items?.total ?? p.tracks?.total ?? null,
    description: p.description || null,
  };
}
export function trimDevice(d) {
  if (!d) return null;
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    is_active: !!d.is_active,
    volume_percent: d.volume_percent ?? null,
  };
}
export function trimPlayback(p) {
  if (!p) return { device: null, item: null, is_playing: false, progress_ms: null, shuffle: null, repeat: null };
  return {
    device: trimDevice(p.device),
    item: trimTrack(p.item),
    is_playing: !!p.is_playing,
    progress_ms: p.progress_ms ?? null,
    shuffle: p.shuffle_state ?? null,
    repeat: p.repeat_state ?? null,
  };
}

// ---------- URI helpers ----------

const URI_TYPES = ['track', 'album', 'artist', 'playlist', 'episode', 'show'];
export function toUri(input, allowed = URI_TYPES) {
  if (typeof input !== 'string' || !input.trim()) throw new SpotifyError('invalid_argument', `Expected a Spotify URI, got ${JSON.stringify(input)}`);
  const s = input.trim();
  let m = s.match(/^spotify:(track|album|artist|playlist|episode|show):([A-Za-z0-9]+)$/);
  if (!m) {
    const u = s.match(/^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|artist|playlist|episode|show)\/([A-Za-z0-9]+)/);
    if (u) m = u;
  }
  if (!m || !allowed.includes(m[1])) {
    throw new SpotifyError('invalid_argument', `Not a valid Spotify ${allowed.join('/')} URI or open.spotify.com link: ${s}`);
  }
  return `spotify:${m[1]}:${m[2]}`;
}
export function playlistId(input) {
  if (typeof input === 'string' && /^[A-Za-z0-9]{10,}$/.test(input.trim())) return input.trim();
  return toUri(input, ['playlist']).split(':')[2];
}

// ---------- the client ----------

export function createCore(opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const redirectUri = opts.redirectUri || envValue('SPOTIFY_REDIRECT_URI') || DEFAULT_REDIRECT_URI;
  const configDir = resolveConfigDir(opts);
  const now = opts.now || (() => Date.now());
  const sleepImpl = opts.sleep || sleep;
  const maxRetryAfterS = opts.maxRetryAfterS ?? 30;
  const store = new Store(configDir);
  let refreshing = null;

  // Client ID resolution: explicit option > env SPOTIFY_CLIENT_ID > <configDir>/config.json "client_id".
  // There is deliberately no built-in default: every user registers their own Spotify app.
  function resolveClientId() {
    if (opts.clientId) return { client_id: opts.clientId, source: 'option' };
    const env = envValue('SPOTIFY_CLIENT_ID');
    if (env) return { client_id: env.trim(), source: 'env' };
    const cfg = store.read('config.json');
    if (cfg && typeof cfg.client_id === 'string' && cfg.client_id.trim()) return { client_id: cfg.client_id.trim(), source: 'config' };
    return { client_id: null, source: null };
  }
  function requireClientId() {
    const { client_id } = resolveClientId();
    if (!client_id) {
      throw new SpotifyError('client_id_missing', 'No Spotify Client ID configured.', {
        hint:
          `Create your own app at https://developer.spotify.com/dashboard (add Redirect URI ${redirectUri}, check "Web API"), ` +
          `then set env SPOTIFY_CLIENT_ID=<your client id> or write {"client_id": "<your client id>"} to ${store.file('config.json')}. No client secret is needed.`,
      });
    }
    return client_id;
  }

  // --- auth ---

  function authStart() {
    const clientId = requireClientId();
    const verifier = generateVerifier();
    const state = randomBytes(16).toString('hex');
    const challenge = codeChallengeS256(verifier);
    store.write('pending_auth.json', { verifier, state, redirect_uri: redirectUri, client_id: clientId, created_at: now() });
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state,
      scope: SCOPES.join(' '),
    }).toString();
    return {
      authorize_url: url.toString(),
      redirect_uri: redirectUri,
      expires_in_minutes: PENDING_TTL_MS / 60000,
      instructions:
        'Open authorize_url in a browser signed in to Spotify and click Agree. The browser will then go to ' +
        `${redirectUri}?code=...&state=... and show a "can't connect" error - that is expected (nothing listens there). ` +
        'Copy the FULL URL from the address bar and pass it to auth_complete as redirect_url. ' +
        'Calling auth_start again invalidates this URL.',
    };
  }

  async function tokenRequest(params) {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const err = data?.error || `http_${res.status}`;
      const desc = data?.error_description || text.slice(0, 200);
      throw new SpotifyError(err === 'invalid_grant' ? 'invalid_grant' : 'token_error', `Spotify token endpoint: ${err}${desc ? ` (${desc})` : ''}`, {
        status: res.status,
        hint: err === 'invalid_grant' ? 'Authorization code/refresh token is invalid or expired. Run auth_start again and re-authorize.' : undefined,
      });
    }
    return data;
  }

  function saveTokens(data, prev, clientId) {
    const tokens = {
      access_token: data.access_token,
      token_type: data.token_type || 'Bearer',
      scope: data.scope ?? prev?.scope ?? '',
      expires_at: now() + (Number(data.expires_in) || 3600) * 1000,
      // Spotify may rotate the refresh token; keep the old one only if none returned.
      refresh_token: data.refresh_token || prev?.refresh_token,
      client_id: clientId ?? prev?.client_id,
      updated_at: now(),
    };
    store.write('tokens.json', tokens);
    return tokens;
  }

  async function authComplete(args = {}) {
    const input = (args.redirect_url || args.url || args.code || '').trim();
    if (!input) throw new SpotifyError('invalid_argument', 'Pass redirect_url (the full URL from the browser address bar) or code.');
    const pending = store.read('pending_auth.json');
    if (!pending) throw new SpotifyError('no_pending_auth', 'No pending authorization. Run auth_start first.');
    if (now() - pending.created_at > PENDING_TTL_MS) {
      store.remove('pending_auth.json');
      throw new SpotifyError('pending_auth_expired', 'The authorization request expired. Run auth_start again.');
    }
    let code;
    let state = args.state;
    if (/^https?:\/\//i.test(input) || input.includes('code=') || input.includes('error=')) {
      let q;
      try {
        q = new URL(input, redirectUri).searchParams;
      } catch {
        throw new SpotifyError('invalid_argument', 'Could not parse redirect_url.');
      }
      if (q.get('error')) throw new SpotifyError('authorization_denied', `Spotify returned error=${q.get('error')}. Run auth_start and try again.`);
      code = q.get('code');
      state = q.get('state');
      if (!code) throw new SpotifyError('invalid_argument', 'redirect_url has no code parameter.');
      if (!state) throw new SpotifyError('state_mismatch', 'redirect_url has no state parameter; refusing (CSRF protection).');
    } else {
      code = input;
    }
    if (state !== undefined && state !== null && state !== pending.state) {
      throw new SpotifyError('state_mismatch', 'State does not match the pending authorization (stale or foreign URL). Run auth_start again and use the newest URL.');
    }
    const data = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirect_uri || redirectUri,
      client_id: pending.client_id || requireClientId(),
      code_verifier: pending.verifier,
    });
    const tokens = saveTokens(data, null, pending.client_id || requireClientId());
    store.remove('pending_auth.json');
    const granted = (tokens.scope || '').split(/\s+/).filter(Boolean);
    return {
      authorized: true,
      state_checked: state !== undefined && state !== null,
      scopes: granted,
      missing_scopes: SCOPES.filter((s) => !granted.includes(s)),
      expires_at: new Date(tokens.expires_at).toISOString(),
      has_refresh_token: !!tokens.refresh_token,
    };
  }

  function authStatus() {
    const t = store.read('tokens.json');
    const cid = resolveClientId();
    const pending = store.read('pending_auth.json');
    const granted = (t?.scope || '').split(/\s+/).filter(Boolean);
    return {
      authorized: !!t?.refresh_token || !!(t?.access_token && t.expires_at > now()),
      has_refresh_token: !!t?.refresh_token,
      access_token_expired: t ? t.expires_at <= now() : null,
      expires_at: t ? new Date(t.expires_at).toISOString() : null,
      scopes: granted,
      missing_scopes: t ? SCOPES.filter((s) => !granted.includes(s)) : SCOPES,
      pending_authorization: !!pending && now() - pending.created_at <= PENDING_TTL_MS,
      client_id: cid.client_id,
      client_id_source: cid.source,
      ...(cid.client_id ? {} : { client_id_error: 'No Spotify Client ID configured. Set SPOTIFY_CLIENT_ID or client_id in ' + store.file('config.json') + '.' }),
      ...(t?.client_id && cid.client_id && t.client_id !== cid.client_id
        ? { client_id_mismatch: 'Stored tokens were issued to a different Client ID; refresh keeps using the token\'s own ID. Run auth_start to re-authorize with the configured one.' }
        : {}),
      redirect_uri: redirectUri,
      token_store: store.file('tokens.json'),
      next_step: !cid.client_id && !t
        ? 'Configure a Spotify Client ID first (see client_id_error), then auth_start.'
        : t ? null : 'Not authorized: call auth_start, have the user approve, then auth_complete with the pasted redirect URL.',
    };
  }

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const prev = store.read('tokens.json'); // re-read: another process may have rotated it
      if (!prev?.refresh_token) throw new SpotifyError('not_authorized', 'Not authorized. Run auth_start then auth_complete.');
      // The refresh token is bound to the client it was issued to, so prefer the ID stored with it.
      const cid = prev.client_id || requireClientId();
      const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: prev.refresh_token, client_id: cid });
      return saveTokens(data, prev, cid);
    })();
    try {
      return await refreshing;
    } finally {
      refreshing = null;
    }
  }

  async function accessToken({ force = false } = {}) {
    const t = store.read('tokens.json');
    if (!t) throw new SpotifyError('not_authorized', 'Not authorized with Spotify yet.', { hint: 'Call auth_start, have the user approve in a browser, then auth_complete with the pasted redirect URL.' });
    if (!force && t.access_token && t.expires_at - REFRESH_SKEW_MS > now()) return t.access_token;
    return (await refresh()).access_token;
  }

  // --- API ---

  async function api(method, pathname, { query, body } = {}) {
    const url = new URL(API_BASE + pathname);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    let refreshed = false;
    let rateRetries = 0;
    for (;;) {
      const token = await accessToken({ force: false });
      const headers = { Authorization: `Bearer ${token}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetchImpl(url.toString(), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await refresh();
        continue;
      }
      if (res.status === 429) {
        const ra = Number(res.headers?.get?.('retry-after')) || 1;
        if (ra <= maxRetryAfterS && rateRetries < 2) {
          rateRetries++;
          await sleepImpl(ra * 1000);
          continue;
        }
        throw new SpotifyError('rate_limited', `Spotify rate limit hit; retry after ${ra}s.`, { status: 429, retry_after: ra });
      }
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (res.ok) return data;
      throw apiError(res.status, data, text, pathname);
    }
  }

  function apiError(status, data, text, pathname) {
    const e = data?.error || {};
    const message = (typeof e === 'string' ? e : e.message) || text?.slice(0, 200) || `HTTP ${status}`;
    const reason = e.reason;
    const isPlayer = pathname.startsWith('/me/player');
    if (reason === 'NO_ACTIVE_DEVICE' || (isPlayer && status === 404 && /no active device/i.test(message))) {
      return new SpotifyError('no_active_device', 'No active Spotify device. Nothing is currently selected for playback.', {
        status,
        reason: 'NO_ACTIVE_DEVICE',
        hint: 'Call get_devices, then transfer_playback with a device_id (or device_name), or pass device_id to play. If the device is not listed, open the Spotify app on it.',
      });
    }
    if (reason === 'PREMIUM_REQUIRED') return new SpotifyError('premium_required', message, { status, reason, hint: 'Playback control requires Spotify Premium on the authorized account.' });
    if (status === 401) return new SpotifyError('unauthorized', message, { status, hint: 'Token rejected after refresh. Run auth_start to re-authorize.' });
    if (status === 403) {
      return new SpotifyError('forbidden', message, {
        status,
        reason,
        hint: 'Missing scope, a restricted action for this device/content, an endpoint unavailable to development-mode apps, or the user is not on the app\'s allowlist (Dashboard > User Management).',
      });
    }
    if (status === 404 && isPlayer) return new SpotifyError('not_found', message, { status, reason, hint: 'Device or item not found. Re-check get_devices / the URI.' });
    return new SpotifyError(status >= 500 ? 'upstream_error' : 'api_error', message, { status, reason });
  }

  // --- device resolution ---
  async function resolveDevice(args) {
    if (args.device_id) return args.device_id;
    if (args.device_name) {
      const data = await api('GET', '/me/player/devices');
      const want = String(args.device_name).toLowerCase();
      const devs = data?.devices || [];
      const d = devs.find((x) => x.name.toLowerCase() === want) || devs.find((x) => x.name.toLowerCase().includes(want));
      if (!d) {
        throw new SpotifyError('device_not_found', `No available device matches "${args.device_name}".`, {
          hint: `Available: ${devs.map((x) => x.name).join(', ') || '(none - open the Spotify app on the device)'}`,
        });
      }
      return d.id;
    }
    return undefined;
  }

  const clampInt = (v, lo, hi, dflt) => {
    const n = Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.trunc(Number(v)) : dflt;
    return Math.min(hi, Math.max(lo, n));
  };

  // --- tools ---
  const deviceProps = {
    device_id: { type: 'string', description: 'Target device id from get_devices. Omit to use the active device.' },
    device_name: { type: 'string', description: 'Alternative to device_id: device name (case-insensitive, substring ok), e.g. "Example Speaker".' },
  };

  const tools = [
    {
      name: 'auth_start',
      description: 'Begin Spotify authorization (PKCE). Returns authorize_url for the user to open; after approving they paste the redirected URL into auth_complete.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => authStart(),
    },
    {
      name: 'auth_complete',
      description: 'Finish authorization: pass the full redirect URL the user copied from the browser address bar (http://127.0.0.1:8888/callback?code=...&state=...), or a bare code. Verifies state and stores tokens.',
      inputSchema: {
        type: 'object',
        properties: {
          redirect_url: { type: 'string', description: 'Full redirected URL (preferred; state is verified).' },
          code: { type: 'string', description: 'Bare authorization code (state cannot be verified unless state is also given).' },
          state: { type: 'string', description: 'Optional state when passing a bare code.' },
        },
        additionalProperties: false,
      },
      handler: authComplete,
    },
    {
      name: 'auth_status',
      description: 'Report whether Spotify is authorized, token expiry, granted/missing scopes. Never reveals tokens.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => authStatus(),
    },
    {
      name: 'search',
      description: 'Search the Spotify catalog. types: track, album, artist, playlist. limit is clamped to 1..10 (development-mode maximum). Use offset to page.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text; supports field filters like artist:"Name" year:1990-1999 genre:jazz.' },
          types: { type: 'array', items: { type: 'string', enum: ['track', 'album', 'artist', 'playlist'] }, description: 'Default ["track"].' },
          limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Results per type, default 5, max 10.' },
          offset: { type: 'integer', minimum: 0 },
          market: { type: 'string', description: 'ISO country code or "from_token".' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      handler: async (a) => {
        if (!a.query || !String(a.query).trim()) throw new SpotifyError('invalid_argument', 'query is required.');
        let types = a.types ?? a.type ?? ['track'];
        if (typeof types === 'string') types = types.split(',').map((s) => s.trim());
        const okTypes = ['track', 'album', 'artist', 'playlist'];
        const bad = types.filter((t) => !okTypes.includes(t));
        if (bad.length || !types.length) throw new SpotifyError('invalid_argument', `types must be from ${okTypes.join(', ')}`);
        const requested = a.limit === undefined ? 5 : Number(a.limit);
        const limit = clampInt(a.limit, 1, SEARCH_LIMIT_MAX, 5);
        const data = await api('GET', '/search', { query: { q: a.query, type: types.join(','), limit, offset: a.offset, market: a.market } });
        const out = { limit, offset: Number(a.offset) || 0 };
        if (requested !== limit) out.limit_clamped_from = requested;
        if (types.includes('track')) out.tracks = (data?.tracks?.items || []).filter(Boolean).map(trimTrack);
        if (types.includes('album')) out.albums = (data?.albums?.items || []).filter(Boolean).map(trimAlbum);
        if (types.includes('artist')) out.artists = (data?.artists?.items || []).filter(Boolean).map(trimArtist);
        if (types.includes('playlist')) out.playlists = (data?.playlists?.items || []).filter(Boolean).map(trimPlaylist);
        return out;
      },
    },
    {
      name: 'get_devices',
      description: 'List Spotify Connect devices currently available (the Spotify app must be open on a device for it to appear).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const data = await api('GET', '/me/player/devices');
        return { devices: (data?.devices || []).map(trimDevice) };
      },
    },
    {
      name: 'transfer_playback',
      description: 'Move playback to a device (makes it the active device). Set play=true to start playing there.',
      inputSchema: { type: 'object', properties: { ...deviceProps, play: { type: 'boolean', description: 'Start playing after transfer (default false keeps current state).' } }, additionalProperties: false },
      handler: async (a) => {
        const id = await resolveDevice(a);
        if (!id) throw new SpotifyError('invalid_argument', 'device_id or device_name is required.', { hint: 'Call get_devices first.' });
        await api('PUT', '/me/player', { body: { device_ids: [id], ...(a.play !== undefined ? { play: !!a.play } : {}) } });
        return { ok: true, device_id: id };
      },
    },
    {
      name: 'play',
      description: 'Start/resume playback. Give uris (list of track/episode URIs) OR context_uri (album/playlist/artist URI) with optional offset (0-based position or a track URI inside the context). No uris/context = resume.',
      inputSchema: {
        type: 'object',
        properties: {
          uris: { type: 'array', items: { type: 'string' }, description: 'Track/episode URIs or open.spotify.com links.' },
          context_uri: { type: 'string', description: 'Album, playlist, or artist URI/link.' },
          offset: { description: '0-based index or a track URI within context_uri.', oneOf: [{ type: 'integer', minimum: 0 }, { type: 'string' }] },
          position_ms: { type: 'integer', minimum: 0 },
          ...deviceProps,
        },
        additionalProperties: false,
      },
      handler: async (a) => {
        if (a.uris && a.context_uri) throw new SpotifyError('invalid_argument', 'Pass either uris or context_uri, not both.');
        const body = {};
        if (a.uris) {
          const list = Array.isArray(a.uris) ? a.uris : [a.uris];
          if (!list.length) throw new SpotifyError('invalid_argument', 'uris is empty.');
          body.uris = list.map((u) => toUri(u, ['track', 'episode']));
        }
        if (a.context_uri) body.context_uri = toUri(a.context_uri, ['album', 'playlist', 'artist', 'show']);
        if (a.offset !== undefined && a.offset !== null) {
          if (!body.context_uri && !body.uris) throw new SpotifyError('invalid_argument', 'offset requires context_uri or uris.');
          body.offset = typeof a.offset === 'number' || /^\d+$/.test(String(a.offset)) ? { position: Number(a.offset) } : { uri: toUri(a.offset, ['track', 'episode']) };
        }
        if (a.position_ms !== undefined) body.position_ms = Number(a.position_ms);
        const device_id = await resolveDevice(a);
        await api('PUT', '/me/player/play', { query: { device_id }, body: Object.keys(body).length ? body : undefined });
        return { ok: true, device_id: device_id ?? '(active device)', ...(body.uris ? { uris: body.uris } : {}), ...(body.context_uri ? { context_uri: body.context_uri } : {}) };
      },
    },
    {
      name: 'pause',
      description: 'Pause playback.',
      inputSchema: { type: 'object', properties: { ...deviceProps }, additionalProperties: false },
      handler: async (a) => {
        const device_id = await resolveDevice(a);
        await api('PUT', '/me/player/pause', { query: { device_id } });
        return { ok: true };
      },
    },
    {
      name: 'next',
      description: 'Skip to the next item in the queue.',
      inputSchema: { type: 'object', properties: { ...deviceProps }, additionalProperties: false },
      handler: async (a) => {
        const device_id = await resolveDevice(a);
        await api('POST', '/me/player/next', { query: { device_id } });
        return { ok: true };
      },
    },
    {
      name: 'previous',
      description: 'Skip to the previous item.',
      inputSchema: { type: 'object', properties: { ...deviceProps }, additionalProperties: false },
      handler: async (a) => {
        const device_id = await resolveDevice(a);
        await api('POST', '/me/player/previous', { query: { device_id } });
        return { ok: true };
      },
    },
    {
      name: 'set_volume',
      description: 'Set volume 0-100 on the active (or given) device. Some devices (phones, some speakers) do not allow volume control.',
      inputSchema: { type: 'object', properties: { volume_percent: { type: 'integer', minimum: 0, maximum: 100 }, ...deviceProps }, required: ['volume_percent'], additionalProperties: false },
      handler: async (a) => {
        if (a.volume_percent === undefined) throw new SpotifyError('invalid_argument', 'volume_percent is required.');
        const v = clampInt(a.volume_percent, 0, 100, 50);
        const device_id = await resolveDevice(a);
        await api('PUT', '/me/player/volume', { query: { volume_percent: v, device_id } });
        return { ok: true, volume_percent: v };
      },
    },
    {
      name: 'add_to_queue',
      description: 'Append a track or episode to the playback queue.',
      inputSchema: { type: 'object', properties: { uri: { type: 'string' }, ...deviceProps }, required: ['uri'], additionalProperties: false },
      handler: async (a) => {
        const uri = toUri(a.uri, ['track', 'episode']);
        const device_id = await resolveDevice(a);
        await api('POST', '/me/player/queue', { query: { uri, device_id } });
        return { ok: true, queued: uri };
      },
    },
    {
      name: 'get_currently_playing',
      description: 'Current playback state: device, item (Track), is_playing, progress_ms, shuffle, repeat.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const data = await api('GET', '/me/player', { query: { additional_types: 'episode' } });
        const pb = trimPlayback(data);
        if (!data) pb.note = 'No active playback session. Use get_devices / transfer_playback / play.';
        return pb;
      },
    },
    {
      name: 'get_recently_played',
      description: 'Recently played tracks (most recent first), each with played_at.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 }, before: { type: 'integer', description: 'Unix ms cursor.' }, after: { type: 'integer', description: 'Unix ms cursor.' } }, additionalProperties: false },
      handler: async (a) => {
        if (a.before && a.after) throw new SpotifyError('invalid_argument', 'Use before or after, not both.');
        const data = await api('GET', '/me/player/recently-played', { query: { limit: clampInt(a.limit, 1, 50, 20), before: a.before, after: a.after } });
        return { items: (data?.items || []).map((i) => ({ played_at: i.played_at, track: trimTrack(i.track) })) };
      },
    },
    {
      name: 'get_top_items',
      description: "The user's top tracks or artists. time_range: short_term (~4 weeks), medium_term (~6 months, default), long_term (~1 year).",
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['tracks', 'artists'] },
          time_range: { type: 'string', enum: ['short_term', 'medium_term', 'long_term'] },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          offset: { type: 'integer', minimum: 0 },
        },
        required: ['type'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const type = a.type || 'tracks';
        if (!['tracks', 'artists'].includes(type)) throw new SpotifyError('invalid_argument', 'type must be tracks or artists.');
        const time_range = a.time_range || 'medium_term';
        if (!['short_term', 'medium_term', 'long_term'].includes(time_range)) throw new SpotifyError('invalid_argument', 'time_range must be short_term, medium_term or long_term.');
        const data = await api('GET', `/me/top/${type}`, { query: { time_range, limit: clampInt(a.limit, 1, 50, 20), offset: a.offset } });
        return { type, time_range, items: (data?.items || []).map(type === 'tracks' ? trimTrack : trimArtist) };
      },
    },
    {
      name: 'create_playlist',
      description: "Create a playlist in the user's account (POST /me/playlists). Private by default.",
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, description: { type: 'string' }, public: { type: 'boolean', description: 'Default false.' }, collaborative: { type: 'boolean' } },
        required: ['name'],
        additionalProperties: false,
      },
      handler: async (a) => {
        if (!a.name) throw new SpotifyError('invalid_argument', 'name is required.');
        const body = { name: a.name, public: a.public === undefined ? false : !!a.public };
        if (a.description) body.description = a.description;
        if (a.collaborative) {
          body.collaborative = true;
          body.public = false;
        }
        const data = await api('POST', '/me/playlists', { body });
        return trimPlaylist(data);
      },
    },
    {
      name: 'add_items_to_playlist',
      description: 'Add tracks/episodes to a playlist the user owns or collaborates on (POST /playlists/{id}/items; batches of 100).',
      inputSchema: {
        type: 'object',
        properties: {
          playlist_id: { type: 'string', description: 'Playlist id, URI, or open.spotify.com link.' },
          uris: { type: 'array', items: { type: 'string' } },
          position: { type: 'integer', minimum: 0, description: 'Insert position (default: append).' },
        },
        required: ['playlist_id', 'uris'],
        additionalProperties: false,
      },
      handler: async (a) => {
        const id = playlistId(a.playlist_id);
        const uris = (Array.isArray(a.uris) ? a.uris : [a.uris]).map((u) => toUri(u, ['track', 'episode']));
        if (!uris.length) throw new SpotifyError('invalid_argument', 'uris is empty.');
        let snapshot_id = null;
        for (let i = 0; i < uris.length; i += 100) {
          const chunk = uris.slice(i, i + 100);
          const body = { uris: chunk };
          if (a.position !== undefined) body.position = Number(a.position) + i;
          const data = await api('POST', `/playlists/${encodeURIComponent(id)}/items`, { body });
          snapshot_id = data?.snapshot_id ?? snapshot_id;
        }
        return { ok: true, playlist_id: id, added: uris.length, snapshot_id };
      },
    },
  ];

  const byName = new Map(tools.map((t) => [t.name, t]));

  async function callTool(name, args = {}) {
    const t = byName.get(String(name).replace(/-/g, '_'));
    if (!t) throw new SpotifyError('unknown_tool', `Unknown tool: ${name}. Known: ${tools.map((x) => x.name).join(', ')}`);
    return t.handler(args || {});
  }

  return {
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    callTool,
    api,
    refresh,
    accessToken,
    store,
    resolveClientId,
    get clientId() {
      return resolveClientId().client_id;
    },
    redirectUri,
    configDir,
  };
}

export function errorPayload(e) {
  if (e instanceof SpotifyError) return { error: e.toJSON() };
  return { error: { code: 'internal_error', message: e?.message || String(e) } };
}
