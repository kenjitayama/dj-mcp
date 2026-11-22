# Verification checklist

Re-run before each release. Everything except the live checks runs offline.

| # | Check | How | Expected |
|---|---|---|---|
| 1 | Manifest schemas | Validate `plugin.json` against https://agent-plugins.org/schemas/1.0.0/plugin.schema.json and `mcp.json` against https://agent-plugins.org/schemas/1.0.0/mcp.schema.json (any JSON Schema 2020-12 validator, e.g. ajv) | both valid |
| 2 | Syntax | `node --check lib/core.mjs bin/dj-mcp bin/dj-mcp-server` | no output |
| 3 | Unit + stdio smoke | `npm test` | all pass (fetch is mocked; a fake Client ID is used) |
| 4 | Missing Client ID | `SPOTIFY_CLIENT_ID= DJ_MCP_CONFIG_DIR=$(mktemp -d) bin/dj-mcp auth_start` | exit 1, `client_id_missing` with setup hint |
| 5 | Live (manual) | After authorizing: `auth_status`, then `get_devices` | `authorized: true`, `missing_scopes: []`, device list |

What the test suite covers:
- PKCE S256, checked against the RFC 7636 Appendix B vector
- authorize URL parameters
- state-mismatch rejection
- code exchange without a client secret
- token file permissions (0600) and atomic writes
- one refresh on a 401, and saving a rotated refresh token
- refresh using the token's own Client ID
- 429 `Retry-After` handling
- search limit capped at 10
- response trimming
- the no-active-device hint
- play/transfer/volume/queue request bodies
- `POST /me/playlists` and `POST /playlists/{id}/items` in batches of 100
- Client ID resolution (env > config.json > error)
- stdio initialize / tools/list / tools/call

Known gaps:
- Real Spotify responses are only covered by mocks based on the official docs.
- Cursor doesn't expand `${PLUGIN_ROOT}` in `mcp.json` `cwd` (see README for the fallback).
