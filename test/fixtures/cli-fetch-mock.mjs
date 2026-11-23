// Preloaded with `node --import` by test/contract.test.mjs. Replaces fetch for the CLI
// process, records every request to CLI_MOCK_LOG, and serves two fictitious devices.
import fs from 'node:fs';

const log = process.env.CLI_MOCK_LOG;
const devices = [
  { id: 'dev-a', name: 'Test Speaker A', type: 'Speaker', is_active: false, volume_percent: 40 },
  { id: 'dev-b', name: 'Test Speaker B', type: 'Computer', is_active: true, volume_percent: 70 },
];

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  fs.appendFileSync(log, JSON.stringify({ method: init.method || 'GET', url: href, body: init.body ?? null }) + '\n');
  if (href.startsWith('https://api.spotify.com/v1/me/player/devices')) {
    return new Response(JSON.stringify({ devices }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (href.startsWith('https://api.spotify.com/')) return new Response(null, { status: 204 });
  return new Response(JSON.stringify({ error: 'unmocked' }), { status: 404 });
};
