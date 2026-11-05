'use strict';

// The browser must open a window no matter what its extensions do.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./harness');

const HELLO = path.join(h.FIXTURES, 'extensions', 'hello-content');

test('[Start-up] the window always opens: slow extensions, failed starts, --safe-mode', async (t) => {
  const server = await h.startServer();
  t.after(() => server.close());

  await t.test('extensions that take too long do not hold the window back, and still load', async () => {
    const userData = h.tempProfile('slowext');
    fs.cpSync(HELLO, path.join(userData, 'extensions', 'hello'), { recursive: true });
    // Extension loading is held (as if an extension hung) against a 100 ms
    // budget: the window must open anyway, then loading finishes once released.
    const { app } = await h.launch({
      userData,
      home: `${server.origin}/page1`,
      env: { ORDINANCE_EXTENSION_WAIT_MS: '100', ORDINANCE_EXTENSION_HOLD: '1' },
    });
    try {
      // The window (and its first tab) is already up — launch() waited for it —
      // while extension loading is still held.
      const early = await app.evaluate(() => ({
        deferred: globalThis.__ordinance.ctx.extensionsDeferred,
        loaded: globalThis.__ordinance.ctx.extensionsLoaded,
        count: globalThis.__ordinance.ctx.extensions.list().length,
      }));
      assert.deepEqual(early, { deferred: true, loaded: false, count: 0 }, 'window opened before extensions loaded');

      await app.evaluate(() => globalThis.__releaseExtensions());
      await h.waitUntil(() => app.evaluate(() => globalThis.__ordinance.ctx.extensions.list().length === 1), {
        timeout: 20000,
        message: 'extension loaded in the background',
      });
      const log = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
      assert.match(log, /loading extensions is taking longer than 100 ms/);
    } finally {
      await app.close();
    }
  });

  await t.test('after a start that never finished, the next start skips extensions and says so', async () => {
    const userData = h.tempProfile('safemode');
    fs.cpSync(HELLO, path.join(userData, 'extensions', 'hello'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'startup-in-progress'), '123 earlier\n');
    let { app } = await h.launch({ userData, home: `${server.origin}/page1` });
    try {
      const state = await app.evaluate(() => ({
        safeMode: globalThis.__ordinance.ctx.safeMode,
        extensions: globalThis.__ordinance.ctx.extensions.list().length,
      }));
      assert.deepEqual(state, { safeMode: { reason: 'the last start did not finish' }, extensions: 0 });
      await h.waitUntil(() => !fs.existsSync(path.join(userData, 'startup-in-progress')), { message: 'marker cleared once shown' });
    } finally {
      await app.close();
    }
    // The following start is normal again.
    ({ app } = await h.launch({ userData, home: `${server.origin}/page1` }));
    try {
      const state = await app.evaluate(() => ({
        safeMode: globalThis.__ordinance.ctx.safeMode,
        extensions: globalThis.__ordinance.ctx.extensions.list().length,
      }));
      assert.deepEqual(state, { safeMode: null, extensions: 1 });
    } finally {
      await app.close();
    }
  });

  await t.test('--safe-mode starts without extensions on request', async () => {
    const userData = h.tempProfile('safeflag');
    fs.cpSync(HELLO, path.join(userData, 'extensions', 'hello'), { recursive: true });
    const { app } = await h.launch({ userData, home: `${server.origin}/page1`, args: ['--safe-mode'] });
    try {
      const safeMode = await app.evaluate(() => globalThis.__ordinance.ctx.safeMode);
      assert.deepEqual(safeMode, { reason: 'you started it with --safe-mode' });
    } finally {
      await app.close();
    }
  });

  await t.test('the log records each start and when the window appeared (CI checks this on macOS)', async () => {
    const userData = h.tempProfile('startlog');
    const { app } = await h.launch({ userData, home: `${server.origin}/page1` });
    try {
      const file = path.join(userData, 'logs', 'main.log');
      await h.waitUntil(() => fs.existsSync(file) && /\[startup\] window shown/.test(fs.readFileSync(file, 'utf8')), {
        message: '"window shown" in main.log',
      });
      assert.match(fs.readFileSync(file, 'utf8'), /INFO \[startup\] \S+ \S+ starting \(pid \d+, Electron [\d.]+, \w+ \w+\)/);
    } finally {
      await app.close();
    }
  });
});
