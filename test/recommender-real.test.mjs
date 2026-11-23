// recommend against the real @kenjitayama/djdb-mcp, through the MCP server binary.
// Every path djdb could use (DJDB_PATH, its config and data dirs, HOME) points into a temp dir,
// so these tests never read or create a real library. Skipped when djdb-mcp is not usable here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeDjdb } from '../lib/recommender.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = probeDjdb() ? false : 'djdb-mcp is not installed, or this Node is outside its range';

function isolatedEnv(extra = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sdj-djdb-'));
  const env = { PATH: process.env.PATH, HOME: path.join(base, 'home'), XDG_DATA_HOME: path.join(base, 'data'), XDG_CONFIG_HOME: path.join(base, 'config'), DJ_MCP_CONFIG_DIR: path.join(base, 'dj-mcp'), SPOTIFY_CLIENT_ID: 'fakeclientid0000000000000000test', ...extra(base) };
  for (const d of ['home', 'data', 'config']) fs.mkdirSync(path.join(base, d));
  return { base, env };
}

async function callRecommend(env, args = {}) {
  const child = spawn(path.join(root, 'bin', 'dj-mcp-server'), [], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'recommend', arguments: args } });
  const byId = new Map();
  const deadline = Date.now() + 10_000;
  while (!byId.has(3)) {
    if (Date.now() > deadline) throw new Error(`timeout; stderr: ${err}`);
    await new Promise((r) => setTimeout(r, 20));
    for (const line of out.split('\n')) if (line.trim()) byId.set(JSON.parse(line).id, JSON.parse(line));
  }
  child.stdin.end();
  await new Promise((r) => child.on('exit', r));
  return { tools: byId.get(2).result.tools.map((t) => t.name), call: byId.get(3).result };
}

const tree = (dir) => fs.readdirSync(dir, { recursive: true }).sort();

test('real djdb, DJDB_PATH to a missing file: recommend is listed and disabled; nothing is created', { skip }, async () => {
  const { base, env } = isolatedEnv((b) => ({ DJDB_PATH: path.join(b, 'db', 'djdb.sqlite') }));
  const before = tree(base);
  const { tools, call } = await callRecommend(env);
  assert.equal(tools.at(-1), 'recommend');
  assert.equal(call.isError, false);
  const r = JSON.parse(call.content[0].text);
  assert.equal(r.disabled, true);
  assert.match(r.reason, /database not found/);
  assert.equal(r.hint, 'Run djdb init, then djdb refresh.');
  assert.deepEqual(tree(base), before);
});

test('real djdb, default paths under a temp HOME and XDG dirs: disabled, and no data dir is created', { skip }, async () => {
  const { base, env } = isolatedEnv(() => ({}));
  const before = tree(base);
  const r = JSON.parse((await callRecommend(env, { mode: 'rediscover', n: 3 })).call.content[0].text);
  assert.equal(r.disabled, true);
  assert.ok(r.reason.includes(path.join(base, 'data', 'djdb-mcp')), r.reason);
  assert.deepEqual(tree(base), before);
});
