// stdio smoke test: initialize + tools/list + tools/call(auth_status, auth_start) against the real server binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_ID = 'fakeclientid0000000000000000test';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('MCP stdio: initialize, tools/list, tools/call', async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'sdj-smoke-'));
  const child = spawn(path.join(root, 'bin', 'dj-mcp-server'), [], { cwd: root, env: { ...process.env, DJ_MCP_CONFIG_DIR: cfg, SPOTIFY_CLIENT_ID: FAKE_ID }, stdio: ['pipe', 'pipe', 'pipe'] });
  const responses = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) {
        const m = JSON.parse(line);
        responses.set(m.id, m);
      }
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  const wait = (id) =>
    new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (responses.has(id)) {
          clearInterval(iv);
          res(responses.get(id));
        } else if (Date.now() - t0 > 5000) {
          clearInterval(iv);
          rej(new Error('timeout ' + id));
        }
      }, 10);
    });

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
  const init = await wait(1);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'dj-mcp');
  assert.ok(init.result.capabilities.tools);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = (await wait(2)).result.tools.map((t) => t.name);
  const expected = ['auth_start', 'auth_complete', 'auth_status', 'search', 'get_devices', 'transfer_playback', 'play', 'pause', 'next', 'previous', 'set_volume', 'add_to_queue', 'get_currently_playing', 'get_recently_played', 'get_top_items', 'create_playlist', 'add_items_to_playlist'];
  assert.deepEqual(names, expected);

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'auth_status', arguments: {} } });
  const st = await wait(3);
  assert.equal(st.result.isError, false);
  assert.equal(JSON.parse(st.result.content[0].text).authorized, false);

  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'auth_start', arguments: {} } });
  const as = await wait(4);
  assert.equal(as.result.isError, false);
  assert.match(JSON.parse(as.result.content[0].text).authorize_url, new RegExp(`^https://accounts\\.spotify\\.com/authorize\\?client_id=${FAKE_ID}&`));

  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_devices', arguments: {} } });
  const gd = await wait(5);
  assert.equal(gd.result.isError, true);
  assert.equal(JSON.parse(gd.result.content[0].text).error.code, 'not_authorized');

  send({ jsonrpc: '2.0', id: 6, method: 'bogus/method' });
  assert.equal((await wait(6)).error.code, -32601);

  child.stdin.end();
  await new Promise((r) => child.on('exit', r));
});
