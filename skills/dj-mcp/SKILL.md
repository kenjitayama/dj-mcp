---
name: dj-mcp
description: Control the user's Spotify playback (Premium) with the dj-mcp tools - search music, pick a Spotify Connect device, play/pause/skip/queue, set volume, read what's playing, recent and top listening, and build playlists. Use when asked to play, queue, find, or make a playlist of music on Spotify.
---

# dj-mcp (Spotify Web API)

The tools come from the `dj-mcp` MCP server. Agents that can't load MCP servers can call the same tools through the CLI:
`<plugin dir>/bin/dj-mcp <tool> --json '{...}'`. It prints JSON; on failure it exits 1 and prints `{"error":{code,message,hint}}`.

## Before anything
- Call `auth_status`.
  - `client_id_error` / `client_id_missing`: the user must create their own Spotify app (Redirect URI `http://127.0.0.1:8888/callback`, Web API checked) and set `SPOTIFY_CLIENT_ID` or `client_id` in the config file. Relay the hint and stop.
  - `authorized` is false, or a tool returns `not_authorized` / `invalid_grant`:
    1. Call `auth_start` and give the user `authorize_url`.
    2. The user opens it and clicks Agree. The browser lands on `http://127.0.0.1:8888/callback?code=...&state=...` and shows a connection error. That's expected.
    3. The user pastes the full URL. Call `auth_complete {"redirect_url": "<pasted URL>"}` soon after, because Spotify codes expire within minutes. A newer `auth_start` invalidates older URLs.
- Tokens refresh automatically. Never ask for, print, or handle tokens.

## Playing music
1. Find items with `search {query, types, limit≤10}`. For the user's taste, use `get_top_items {type, time_range}` and `get_recently_played`.
2. Pick a device with `get_devices`. If none is `is_active`, call `transfer_playback {device_id}` (or `device_name`). A device only shows up while its Spotify app is open.
3. Use `play {uris:[...]}` for specific tracks, or `play {context_uri, offset}` for an album, playlist or artist. `play {}` resumes.
4. Adjust with `add_to_queue`, `next`, `previous`, `pause`, `set_volume`. Confirm with `get_currently_playing`.
- `no_active_device`: call `get_devices`, then `transfer_playback` (or pass `device_id`/`device_name`), and retry.
- `rate_limited`: wait `retry_after` seconds.

## Playlists
Call `create_playlist {name, description?, public?=false}`, then `add_items_to_playlist {playlist_id, uris}`. Any number of URIs works; they're sent in batches of 100.

## Development-mode limits
- There are no recommendations, related artists or audio features. Choose tracks yourself from search, top items and recent plays.
- Search returns at most 10 results per type per call. Page with `offset`.
- Playlist contents can only be read for playlists the user owns or collaborates on.
- Only allowlisted users (max 5) can authorize, and the app owner needs Premium.
- Report only what the tools return. Don't invent track names, URIs or device names.
