'use strict';

// Regression cover for the two defects that stopped Claude in Chrome from
// starting a browser session (see src/main/compat/crx-fixes.js):
//
//   * chrome.windows.create() resolved with `tabs: []`, so an extension doing
//     `win.tabs[0].id` threw "Cannot read properties of undefined (reading 'id')"
//   * chrome.tabs.query({ active: true, lastFocusedWindow: true }) returned the
//     active tab of every window instead of one tab

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require('./harness');

const PROBE = path.join(h.FIXTURES, 'extensions', 'window-probe');

test('[Windows] windows.create reports its tab, and tabs.query honours the focused window', async (t) => {
  const server = await h.startServer();
  const userData = h.tempProfile('windows');
  const { app, ui } = await h.launch({ userData, home: `${server.origin}/` });
  t.after(async () => {
    await app.close().catch(() => {});
    await server.close();
  });

  const ext = await app.evaluate(async (_e, dir) => globalThis.__ordinance.ctx.extensions.load(dir), PROBE);
  await ui.waitForSelector(`#extension-actions [data-extension-id="${ext.id}"]`);

  const probe = await h.waitUntil(
    () =>
      app.evaluate(async (_e, id) => {
        const o = globalThis.__ordinance;
        const c = [...o.controllers][0];
        if (!c.sidePanel) o.ctx.compat.openSidePanel(c, id);
        const wc = c.sidePanel && c.sidePanel.view.webContents;
        return wc ? wc.executeJavaScript('window.__windowProbe || null') : null;
      }, ext.id),
    { timeout: 30000, message: 'window probe result' },
  );

  await t.test('chrome.windows.create resolves with the tab it opened', () => {
    assert.ok(probe.createdWindow.ok, `windows.create failed: ${probe.createdWindow.error}`);
    const win = probe.createdWindow.value;
    assert.equal(typeof win.id, 'number');
    // The original bug: tabs was [] here, so win.tabs[0] was undefined.
    assert.ok(Array.isArray(win.tabs), 'the created window carries a tabs array');
    assert.ok(win.tabs.length >= 1, `the created window lists its tab (got ${JSON.stringify(win.tabs)})`);
    assert.equal(typeof win.tabs[0].id, 'number', 'win.tabs[0].id is readable');
    assert.equal(win.tabs[0].windowId, win.id, 'the listed tab belongs to the new window');
  });

  await t.test('windows.getAll populates every window, not just new ones', () => {
    assert.ok(probe.getAll.ok, `windows.getAll failed: ${probe.getAll.error}`);
    const windows = probe.getAll.value;
    assert.ok(windows.length >= 2, `both windows are reported (got ${windows.length})`);
    for (const win of windows) {
      assert.ok(win.tabs.length >= 1, `window ${win.id} lists its tabs`);
    }
  });

  await t.test('tabs.query with lastFocusedWindow returns one tab', () => {
    assert.ok(probe.activeQuery.ok, `tabs.query failed: ${probe.activeQuery.error}`);
    const tabs = probe.activeQuery.value;
    assert.equal(tabs.length, 1, `exactly one active tab (got ${JSON.stringify(tabs.map((x) => x.windowId))})`);
    assert.equal(tabs[0].active, true);
  });

  await t.test('the agent can still group the tab it found', () => {
    assert.ok(probe.group.ok, `tabs.group failed: ${probe.group.error}`);
    assert.equal(typeof probe.group.value, 'number');
    assert.ok(probe.groups.ok, `tabGroups.query failed: ${probe.groups.error}`);
    assert.ok(
      probe.groups.value.some((g) => g.id === probe.group.value),
      'the new group is listed by tabGroups.query',
    );
  });
});
