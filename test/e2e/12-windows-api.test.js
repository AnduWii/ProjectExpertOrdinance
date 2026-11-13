'use strict';

// chrome.windows must list each window's tabs the way Chrome does. With
// electron-chrome-extensions 4.10.0 alone, windows.create/get/getAll returned
// `tabs: []`, so agent extensions (Claude in Chrome's tabs_context_mcp with
// createIfEmpty) failed with "Cannot read properties of undefined (reading 'id')".

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require('./harness');

const PROBE = path.join(h.FIXTURES, 'extensions', 'window-probe');

test('[Windows API] windows.create returns its tab, and tab groups work on it', async (t) => {
  const server = await h.startServer();
  const userData = h.tempProfile('windows-api');
  const { app } = await h.launch({ userData, home: `${server.origin}/named/One` });
  t.after(async () => {
    await app.close().catch(() => {});
    await server.close();
  });
  // A second tab, so getAll has more than one tab to order.
  await app.evaluate((_e, url) => [...globalThis.__ordinance.controllers][0].createTab({ url, active: false }), `${server.origin}/named/Two`);

  const ext = await app.evaluate(async (_e, dir) => globalThis.__ordinance.ctx.extensions.load(dir), PROBE);
  const tabId = await app.evaluate((_e, url) => [...globalThis.__ordinance.controllers][0].createTab({ url }).id, `chrome-extension://${ext.id}/probe.html`);
  const log = await h.waitUntil(() => h.tabEval(app, tabId, 'window.__probe || null'), { timeout: 30000, message: 'probe results' });
  const step = (name) => {
    const s = log.find((x) => x.name === name);
    assert.ok(s, `probe step ${name} ran`);
    assert.equal(s.ok, true, `${name} failed: ${s.error}`);
    return s.value;
  };

  await t.test('windows.getAll({populate:true}) lists the tabs in strip order', () => {
    const [win] = step('windows.getAll({populate:true})');
    assert.equal(win.tabsIsArray, true);
    assert.equal(win.tabCount, 3, 'two pages and the probe tab');
    assert.deepEqual(win.tabIndexes, [0, 1, 2]);
  });

  await t.test('windows.create({url}) returns a window whose tabs[0].id is the new tab', () => {
    const win = step('windows.create({url:"about:blank"})');
    assert.equal(win.tabCount, 1);
    assert.equal(typeof win.firstTabId, 'number');
    assert.equal(win.firstTabActive, true, "the new window's only tab is its active tab");
    assert.deepEqual(step('tabs.get(tabId)'), { id: win.firstTabId, active: true, index: 0, windowId: win.id });
    assert.equal(step('createdWindow.tabs[0].id'), win.firstTabId);
    assert.deepEqual(step('tabs.query({windowId})').map((x) => x.id), [win.firstTabId]);
  });

  await t.test('the new tab can be grouped, and the group is queryable', () => {
    const groupId = step('tabs.group({tabIds:[tabId]})');
    assert.equal(typeof groupId, 'number');
    assert.equal(step('tabGroups.update(groupId)').title, 'Probe');
    assert.ok(step('tabGroups.query({})').some((g) => g.id === groupId));
    assert.equal(step('tabs.get(tabId).groupId').groupId, groupId);
  });

  await t.test('windows.get(id,{populate:true}) is not a stale snapshot', () => {
    const win = step('windows.get(createdId,{populate:true})');
    assert.equal(win.tabCount, 1);
    assert.equal(win.firstTabId, step('createdWindow.tabs[0].id'));
  });

  await t.test('tabs.query/get and windows.get agree on tab indexes after tabs move and close', async () => {
    // Every API must report each tab's current position in the strip, also
    // when a query matches only some tabs (the library used to number the
    // matches 0, 1, 2… and leave those numbers behind for tabs.get).
    const check = async (label) => {
      const { order, windowId, activeId } = await app.evaluate(() => {
        const c = [...globalThis.__ordinance.controllers][0];
        return { order: c.order, windowId: c.win.id, activeId: c.activeId };
      });
      const want = Object.fromEntries(order.map((id, i) => [id, i]));
      const got = await h.tabEval(app, tabId, `chrome.runtime.sendMessage({ type: 'indexes', windowId: ${windowId} })`);
      assert.deepEqual(got, { query: want, get: want, window: want, active: { [activeId]: order.indexOf(activeId) } }, label);
      return order;
    };
    const order = await check('as opened');
    await app.evaluate((_e, id) => [...globalThis.__ordinance.controllers][0].moveTab(id, 2), order[0]);
    const moved = await check('after moving the first tab to the end');
    await app.evaluate((_e, id) => [...globalThis.__ordinance.controllers][0].closeTab(id), moved[0]);
    await check('after closing the first tab');
  });
});
