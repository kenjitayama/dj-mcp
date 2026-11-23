// The optional recommend tool, against a fake djdb-mcp module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore } from '../lib/core.mjs';
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
