# dj-mcp

An MCP server for controlling playback with the Spotify Web API. `dj-mcp` is packaged as an
[Agent Plugin](https://agent-plugins.org) (a stdio MCP server plus a skill) and ships a CLI over the same core,
so AI agents can search music and play it on your Spotify Connect devices (desktop app, phone, speakers).

Currently supports Spotify. In the future, I'd like to consider supporting other music services such as Apple Music.

- Zero dependencies. Node.js >= 20. All logic is in `lib/core.mjs`.
- Auth: Authorization Code + PKCE (S256) with **your own** Spotify app. No client secret.
- Results come back trimmed to small, stable shapes, not raw Spotify JSON.
- Tokens are stored outside the repo in `~/.config/dj-mcp/` (directory 0700, files 0600, atomic writes).
  The access token refreshes automatically (early, and once on a 401). Rotated refresh tokens are saved.
  On HTTP 429 it waits for `Retry-After` (≤30 s, up to 2 retries), otherwise it returns a `rate_limited` error.

> dj-mcp is an independent project. It is not affiliated with, sponsored by, or endorsed by Spotify.
> "Spotify" is a trademark of Spotify AB and is used here only to describe the API this tool works with.
> Playback control needs Spotify Premium.

## Setup with an AI agent
**For users:** give your AI agent (Codex, Claude, Cursor, Grok Bot, or similar) this repo URL and ask it to set it up:
"Set this up: https://github.com/kenjitayama/dj-mcp". The agent can handle the rest except three steps that need you:

1. **Have Spotify Premium.** Playback control requires it.
2. **Create your own Spotify app** in the [Developer Dashboard](https://developer.spotify.com/dashboard), with Redirect URI
   `http://127.0.0.1:8888/callback` and **Web API** checked. Give the agent its Client ID. Each person or app uses its
   own Client ID, and no client secret is needed. Details: [1. Create a Spotify app](#1-create-a-spotify-app).
3. **Approve in the browser.** Open the link the agent shows you and click Agree. You'll land on a "can't connect" page,
   which is expected. Copy the **full URL** from the address bar and paste it back to the agent within a few minutes,
   before the code expires.

**For agents**, step by step:
1. Check `node --version` is >= 20.
2. Run `git clone https://github.com/kenjitayama/dj-mcp /path/to/dj-mcp`. Below, `CLI` means `/path/to/dj-mcp/bin/dj-mcp`.
3. Save the user's Client ID, either as env `SPOTIFY_CLIENT_ID` or in `~/.config/dj-mcp/config.json`
   (folder 0700, file 0600). See [2. Set the Client ID](#2-set-the-client-id).
4. Run `CLI auth_start` and show the user the `authorize_url`.
5. Run `CLI auth_complete --redirect_url '<pasted URL>'`. Single-quote the URL, because it contains `&`.
6. Run `CLI auth_status` and confirm `authorized: true` and `missing_scopes: []`.
7. Run `CLI get_devices`. Devices only appear while a Spotify app is open, so if the list is empty, ask the user to open one.
8. With the user's OK, test playback: `CLI search --query '<song>'`, then `CLI transfer_playback --device_name '<name>'` and
   `CLI play --json '{"uris":["<track uri>"]}'`.
9. Register the MCP server (`node /path/to/dj-mcp/bin/dj-mcp-server`) with the user's client:
   - **Cursor / Claude Desktop:** see [Cursor](#cursor) and [Claude Desktop](#claude-desktop).
   - **Claude Code:** `claude mcp add --transport stdio --scope user dj-mcp -- node /path/to/dj-mcp/bin/dj-mcp-server`
   - **Codex:** `codex mcp add dj-mcp -- node /path/to/dj-mcp/bin/dj-mcp-server`, or in `~/.codex/config.toml`:
     ```toml
     [mcp_servers.dj-mcp]
     command = "node"
     args = ["/path/to/dj-mcp/bin/dj-mcp-server"]
     ```
   - **Anything else:** see [MCP: generic stdio](#mcp-generic-stdio).

   If the Client ID is in `config.json`, no env setting is needed in the client config.

**Rules for agents:**
- Never commit tokens or the Client ID to the repo, and never paste them into it.
- Don't print tokens.
- Don't ask for a client secret. It isn't needed.
- Don't re-run `auth_start` while an authorization is pending, because it invalidates the earlier link.

## How this differs from other Spotify MCP servers
There are several good Spotify MCP servers out there. This one makes a few particular choices that might suit some setups:

- **Authorization Code + PKCE.** You only need your own app's Client ID. No client secret is stored or required.
- **Zero runtime dependencies.** Plain Node.js (>= 20), with nothing to install from npm.
- **A shell CLI on the same core** (`bin/dj-mcp`), for agents or scripts that can run commands but can't load MCP servers.
- **`transfer_playback` (and other playback tools) accept a device name** as well as a device ID.
- **Built for new Development Mode apps (February 2026 onward).** It avoids the endpoints that were removed or renamed for them.
- **Small and playback-focused.** Search, devices, playback control, listening history, and simple playlist creation.

If you're looking for more features, such as playlist editing or library management,
[marcelmarais/spotify-mcp-server](https://github.com/marcelmarais/spotify-mcp-server) may be a better fit.

## 1. Create a Spotify app
1. Go to https://developer.spotify.com/dashboard and choose **Create app**. Spotify's guidelines say the app name must not
   include "Spotify" or anything similar to it (e.g. "My DJ Agent").
2. Set **Redirect URI** to exactly `http://127.0.0.1:8888/callback`. Nothing has to listen on that address,
   because you'll copy the redirected URL from the browser.
3. Under "Which API/SDKs are you planning to use?", check **Web API**. Save.
4. Copy the app's **Client ID**. It's public, not a secret. You don't need the client secret.
5. In development mode, only allowlisted users can authorize. Add your own Spotify account (and up to 4 others)
   under **User Management**.

## 2. Set the Client ID
dj-mcp looks for the Client ID in this order (there is no built-in default):
1. the environment variable `SPOTIFY_CLIENT_ID`
2. `client_id` in `<config dir>/config.json`

The config dir (which also holds the tokens) is `~/.config/dj-mcp`, or `DJ_MCP_CONFIG_DIR` if set.

```bash
mkdir -p ~/.config/dj-mcp && chmod 700 ~/.config/dj-mcp
printf '{\n  "client_id": "YOUR_CLIENT_ID"\n}\n' > ~/.config/dj-mcp/config.json && chmod 600 ~/.config/dj-mcp/config.json
```
If neither is set, tools return `client_id_missing` with these instructions.
The refresh token is tied to the Client ID it was issued to, and refreshes always use the ID saved with the tokens.
If you switch to a different app, run `auth_start` again. `auth_status` reports `client_id_mismatch` when the two differ.
Optional: `SPOTIFY_REDIRECT_URI` if you registered a different loopback redirect.

## 3. Authorize (once per machine)
1. Call `auth_start` and open the `authorize_url` it returns in a browser signed in to Spotify. Click **Agree**.
2. The browser goes to `http://127.0.0.1:8888/callback?code=...&state=...` and shows a "can't connect" error.
   That's expected.
3. Copy the **full URL** from the address bar and call `auth_complete` with `redirect_url` set to it.
   It checks `state`. Do this soon after approving, because Spotify codes expire within minutes.
   Running `auth_start` again makes earlier URLs invalid.
4. `auth_status` should show `authorized: true` and `missing_scopes: []`.

Requested scopes: `user-read-playback-state user-modify-playback-state user-read-currently-playing
user-read-recently-played user-top-read playlist-read-private playlist-modify-private playlist-modify-public user-library-read`.

## 4. Use it

### CLI (any agent that can run shell commands)
```bash
SDJ=/path/to/dj-mcp/bin/dj-mcp
$SDJ tools                                    # list tools and params
$SDJ auth_status
$SDJ auth_start
$SDJ auth_complete --redirect_url 'http://127.0.0.1:8888/callback?code=...&state=...'   # keep the single quotes
$SDJ search --json '{"query":"artist:\"Bill Evans\" waltz","types":["track"],"limit":5}'
$SDJ get_devices
$SDJ transfer_playback --device_name 'Example Speaker' --play false
$SDJ play --json '{"uris":["spotify:track:..."]}'
$SDJ play --json '{"context_uri":"spotify:album:...","offset":0}'
$SDJ set_volume --volume_percent 40
$SDJ get_currently_playing
```
You can pass arguments as `--json '{...}'`, as a bare JSON object, or as `--key value`. Values are JSON-parsed,
except string fields like URLs and IDs. Output is JSON. On failure it prints
`{"error":{"code","message","hint"?,"status"?,"retry_after"?}}` and exits with code 1.
Error codes worth handling: `client_id_missing`, `not_authorized`, `invalid_grant` (re-authorize), `no_active_device`,
`device_not_found`, `rate_limited`, `forbidden`, `premium_required`, `state_mismatch`.

### MCP: generic stdio
The server speaks newline-delimited JSON-RPC 2.0 on stdio: `node /path/to/dj-mcp/bin/dj-mcp-server`.

### Claude Desktop
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):
```json
{
  "mcpServers": {
    "dj-mcp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/dj-mcp/bin/dj-mcp-server"],
      "env": { "SPOTIFY_CLIENT_ID": "YOUR_CLIENT_ID" }
    }
  }
}
```
If `node` isn't found, use its absolute path (`which node`).

### Cursor
Option A, as a local plugin: copy the folder itself (not a symlink) to `~/.cursor/plugins/local/dj-mcp` and reload.
Cursor doesn't expand the standard `${PLUGIN_ROOT}` placeholder used in `mcp.json`'s `cwd`. The server doesn't depend
on its working directory, but if it won't start that way, use option B.

Option B, as a plain MCP server in `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):
```json
{
  "mcpServers": {
    "dj-mcp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/dj-mcp/bin/dj-mcp-server"],
      "env": { "SPOTIFY_CLIENT_ID": "YOUR_CLIENT_ID" }
    }
  }
}
```

### Other Agent Plugins clients
Install the directory as a plugin. `mcp.json` declares a stdio server (`./bin/dj-mcp-server`) and
`skills/dj-mcp/SKILL.md` tells the agent when to call each tool.
`SPOTIFY_CLIENT_ID` is declared under `extensions["com.cursor"].variables`, because the Agent Plugins manifest
schema has no top-level `variables` key. An unexpanded `${SPOTIFY_CLIENT_ID}` placeholder counts as unset.

## Tools
| tool | purpose |
|---|---|
| auth_start | Create and save a PKCE verifier and state; return `authorize_url` |
| auth_complete | Take `redirect_url` (state checked) or a bare `code`; exchange it and store tokens |
| auth_status | Authorized or not, expiry, granted/missing scopes, Client ID source (never tokens) |
| search | track/album/artist/playlist; `limit` forced into 1..10 (default 5); page with `offset` |
| get_devices | Spotify Connect devices → `Device[]` |
| transfer_playback | Make a device active (`device_id` or `device_name`, optional `play`) |
| play | `uris[]`, or `context_uri` (+ `offset` index or URI), `position_ms`, device; no args = resume |
| pause / next / previous | Playback controls (optional device) |
| set_volume | 0–100 |
| add_to_queue | Add a track/episode URI to the queue |
| get_currently_playing | `Playback` |
| get_recently_played | `[{played_at, track}]` (limit ≤50, `before`/`after` cursors) |
| get_top_items | Top tracks or artists, `time_range` short/medium/long_term |
| create_playlist | `POST /me/playlists` (private by default) |
| add_items_to_playlist | `POST /playlists/{id}/items`, in batches of 100 |

URIs can also be `open.spotify.com/...` links.

## Shapes
`Track {uri,name,artists[],album,duration_ms}` · `Device {id,name,type,is_active,volume_percent}` ·
`Playback {device,item,is_playing,progress_ms,shuffle,repeat}` · `Album {uri,name,artists[],release_date,total_tracks}` ·
`Artist {uri,name,genres[]}` · `Playlist {uri,id,name,owner,public,total_items,description}`.

## Optional: recommendations from your listening history
Spotify removed Recommendations and Related Artists for new and development-mode Web API apps on 2024-11-27
(see the limits below), and ListenBrainz computes personal recommendations in batches.
[djdb-mcp](https://github.com/kenjitayama/djdb-mcp) keeps your own listening history in a local database and gives
AI agents an on-demand recommender built on it. dj-mcp resolves its picks to tracks playable on Spotify.
When it is installed and Node is 24.15+ or 26, dj-mcp adds one tool, `recommend`.
Without it, or on Node 20/22, dj-mcp is exactly the tool list above.

- Install: `npm install` in this checkout. djdb-mcp is an optional dependency pinned to its `v0.2.0` tag.
  npm skips it on Node 20/22.
- Set up the library once with djdb-mcp's `djdb init` and `djdb refresh` (see its README).
- `recommend {mode?, n?, market?, seeds?}`. `mode` is `discover` (default: recordings you have not played,
  from artists near your taste) or `rediscover` (artists you played a lot in an earlier era). `n` is 1..20
  (default 10). `market` is the country the tracks must be playable in (default `JP`). `seeds` are up to 5
  artist names, Spotify artist URIs/links or MusicBrainz artist IDs.
- Returns `{mode, market, run_id, items: [{uri, name, artists, recording_mbid, isrc, resolved_by}]}`, plus
  `unresolved_seeds`, `stopped` (a Spotify search failed, e.g. a 429; try again later) or `note` when they apply.
  Pass the URIs to `play` or `add_to_queue`.
- When the library is not ready, the tool returns `{disabled: true, reason, hint}` and every other tool works as usual.
- It writes only to djdb's online database: the run, the Spotify IDs it found for each market, and which
  tracks it showed you. The listening library itself is read-only here.

## Spotify development-mode limits
Checked against developer.spotify.com in November 2026: the February 2026 Web API changelog and migration guide,
the March 2026 changelog, and the November 2024 Web API announcement.
- The app owner needs an active **Premium** subscription. A development-mode app allows at most **5 users**,
  and they must be allowlisted.
- `GET /search`: `limit` max is **10** (default 5). Page with `offset`.
- Playlist items: `/playlists/{id}/tracks` → `/playlists/{id}/items`. Contents are returned only for playlists the
  user owns or collaborates on, and the `tracks` field is renamed `items`.
- Create playlist: `POST /me/playlists` (`POST /users/{id}/playlists` was removed).
- Library: save/remove/follow → `PUT/DELETE /me/library` (URIs); contains checks → `GET /me/library/contains`.
- Removed: batch GETs (`/tracks`, `/albums`, `/artists`, ...), artist top tracks, new releases, browse categories,
  other users' profiles and playlists, markets. `popularity` and some other fields were removed from objects.
- Unavailable to development-mode apps since 2024-11-27: recommendations, related artists, audio features,
  audio analysis, featured playlists, category playlists, and 30-second preview URLs.
  Without djdb-mcp, the agent has to choose tracks itself from search, top items and recent plays.

## Development
```bash
npm test     # node --test, no network: fetch is mocked; the stdio smoke test spawns the real server with a fake Client ID
```
See `VERIFY.md` for the verification checklist.

## License
MIT. See `LICENSE`.
