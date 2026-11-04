'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installLog, withTimeout, StartupGuard } = require('../../src/main/startup');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chrome2-startup-'));

test('withTimeout returns the result when the work finishes in time', async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 1000, { log: () => {} }), 7);
});

test('withTimeout gives up waiting (without cancelling) when the work is slow', async () => {
  const logs = [];
  const slow = new Promise((r) => setTimeout(() => r('late'), 300));
  const started = Date.now();
  const out = await withTimeout(slow, 20, { label: 'slow thing', fallback: 'fallback', log: (m) => logs.push(m) });
  assert.equal(out, 'fallback');
  assert.ok(Date.now() - started < 250);
  assert.match(logs[0], /slow thing is taking longer/);
  assert.equal(await slow, 'late');
});

test('withTimeout never rejects: a failure is logged and the fallback returned', async () => {
  const logs = [];
  const out = await withTimeout(Promise.reject(new Error('boom')), 1000, { label: 'x', fallback: null, log: (m) => logs.push(m) });
  assert.equal(out, null);
  assert.match(logs[0], /x failed: .*boom/);
});

test('StartupGuard: a start that never finished is detected on the next launch', () => {
  const dir = tmp();
  const first = new StartupGuard(dir);
  assert.equal(first.begin(), false, 'fresh profile');
  // ...the app dies here, before a window is shown.
  const second = new StartupGuard(dir);
  assert.equal(second.begin(), true, 'previous start failed');
  second.succeeded();
  assert.equal(new StartupGuard(dir).begin(), false, 'a successful start clears it');
});

test('installLog mirrors warnings and errors into logs/main.log', () => {
  const dir = tmp();
  const seen = [];
  const fakeConsole = { warn: (...a) => seen.push(['warn', ...a]), error: (...a) => seen.push(['error', ...a]) };
  const log = installLog(dir, { console: fakeConsole });
  fakeConsole.warn('[x] careful', { a: 1 });
  fakeConsole.error(new Error('bad thing'));
  const text = fs.readFileSync(log.file, 'utf8');
  assert.equal(log.file, path.join(dir, 'logs', 'main.log'));
  assert.match(text, /WARN \[x\] careful \{"a":1\}/);
  assert.match(text, /ERROR Error: bad thing/);
  assert.equal(seen.length, 2, 'still printed to the console');
});
