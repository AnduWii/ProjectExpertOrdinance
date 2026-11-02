'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

/** Open a new tab via the + button and navigate it with the address bar. */
async function openNamedTab(app, ui, origin, name) {
  const before = (await h.mainState(app)).tabs.length;
  await ui.click('#new-tab');
  await h.waitUntil(async () => (await h.mainState(app)).tabs.length === before + 1, { message: 'new tab' });
  await ui.fill('#address', `${origin}/named/${name}`);
  await ui.press('#address', 'Enter');
  await h.waitUntil(async () => (await h.mainState(app)).tabs.some((t) => t.title === name), { message: `tab ${name}` });
}

test('[Tabs] open, close, switch and drag to reorder', async (t) => {
  const server = await h.startServer();
  const { app, ui } = await h.launch({ userData: h.tempProfile('tabs'), home: `${server.origin}/` });
  t.after(async () => {
    await app.close().catch(() => {});
    await server.close();
  });

  await t.test('starts with one tab showing the home page', async () => {
    await h.waitUntil(async () => (await h.mainState(app)).tabs[0]?.title === 'Home Fixture', { message: 'home page' });
    assert.equal((await ui.$$('#tabs .tab')).length, 1);
    await h.waitUntil(async () => (await h.uiTabTitles(ui))[0] === 'Home Fixture', { message: 'UI title' });
  });

  await t.test('open: the + button adds a tab and makes it active', async () => {
    await ui.click('#new-tab');
    await h.waitUntil(async () => (await ui.$$('#tabs .tab')).length === 2, { message: 'two tabs in UI' });
    const s = await h.mainState(app);
    assert.equal(s.tabs.length, 2);
    assert.equal(s.activeId, s.order[1]);
    assert.equal(await ui.getAttribute('#tabs .tab >> nth=1', 'aria-selected'), 'true');
  });

  await t.test('switch: clicking a tab shows that tab', async () => {
    const s = await h.mainState(app);
    await ui.click('#tabs .tab >> nth=0');
    await h.waitUntil(async () => (await h.mainState(app)).activeId === s.order[0], { message: 'first tab active' });
    const attached = await app.evaluate(() => {
      const c = [...globalThis.__ordinance.controllers][0];
      const tabViews = [...c.tabs.values()].map((x) => x.view);
      const shown = c.win.contentView.children.filter((v) => tabViews.includes(v));
      return { count: shown.length, isActive: shown[0] === c.activeTab.view };
    });
    assert.deepEqual(attached, { count: 1, isActive: true }, 'exactly the active tab view is attached');
    assert.equal(await ui.getAttribute('#tabs .tab >> nth=0', 'aria-selected'), 'true');
  });

  await t.test('close: the × button closes a tab and activates a neighbour', async () => {
    const s = await h.mainState(app);
    await ui.click('#tabs .tab >> nth=1 >> .close');
    await h.waitUntil(async () => (await h.mainState(app)).tabs.length === 1, { message: 'one tab left' });
    const after = await h.mainState(app);
    assert.deepEqual(after.order, [s.order[0]]);
    assert.equal((await ui.$$('#tabs .tab')).length, 1);
  });

  await t.test('drag: dropping a tab before/after another reorders the strip', async () => {
    // Rename the remaining tab to A, then add B and C.
    await ui.fill('#address', `${server.origin}/named/A`);
    await ui.press('#address', 'Enter');
    await h.waitUntil(async () => (await h.mainState(app)).tabs[0].title === 'A', { message: 'tab A' });
    await openNamedTab(app, ui, server.origin, 'B');
    await openNamedTab(app, ui, server.origin, 'C');
    await h.waitUntil(async () => (await h.uiTabTitles(ui)).join() === 'A,B,C', { message: 'A,B,C in UI' });

    const titlesInMain = async () => (await h.mainState(app)).tabs.map((x) => x.title).join();

    // C onto the left half of A -> C, A, B
    await ui.locator('#tabs .tab').nth(2).dragTo(ui.locator('#tabs .tab').nth(0), { targetPosition: { x: 10, y: 15 } });
    await h.waitUntil(async () => (await titlesInMain()) === 'C,A,B', { message: 'C,A,B in main process' });
    await h.waitUntil(async () => (await h.uiTabTitles(ui)).join() === 'C,A,B', { message: 'C,A,B in UI' });

    // C onto the right half of B -> A, B, C
    const box = await ui.locator('#tabs .tab').nth(2).boundingBox();
    await ui.locator('#tabs .tab').nth(0).dragTo(ui.locator('#tabs .tab').nth(2), { targetPosition: { x: box.width - 10, y: 15 } });
    await h.waitUntil(async () => (await titlesInMain()) === 'A,B,C', { message: 'A,B,C in main process' });
    await h.waitUntil(async () => (await h.uiTabTitles(ui)).join() === 'A,B,C', { message: 'A,B,C in UI' });
    h.screenshot('tabs-reordered');
  });

  await t.test('menu commands: New Tab and Close Tab (Ctrl/Cmd+T, Ctrl/Cmd+W)', async () => {
    const clickMenu = (label) =>
      app.evaluate(({ Menu }, name) => {
        const find = (items) => {
          for (const item of items) {
            if (item.label === name) return item;
            const sub = item.submenu && find(item.submenu.items);
            if (sub) return sub;
          }
          return null;
        };
        const item = find(Menu.getApplicationMenu().items);
        item.click();
        return item.accelerator;
      }, label);
    const before = (await h.mainState(app)).tabs.length;
    assert.equal(await clickMenu('New Tab'), 'CmdOrCtrl+T');
    await h.waitUntil(async () => (await h.mainState(app)).tabs.length === before + 1, { message: 'menu new tab' });
    await h.waitUntil(async () => ui.evaluate(() => document.activeElement?.id === 'address'), { message: 'address focused' });
    assert.equal(await clickMenu('Close Tab'), 'CmdOrCtrl+W');
    await h.waitUntil(async () => (await h.mainState(app)).tabs.length === before, { message: 'menu close tab' });
  });

  await t.test('window.open from a page opens a new tab next to its opener', async () => {
    const s = await h.mainState(app);
    await ui.click('#tabs .tab >> nth=0');
    await h.waitUntil(async () => (await h.mainState(app)).activeId === s.order[0], { message: 'A active' });
    await h.tabEval(app, s.order[0], `window.open('${server.origin}/page2'); true`);
    await h.waitUntil(async () => (await h.mainState(app)).tabs.length === 4, { message: 'popup tab' });
    const after = await h.mainState(app);
    assert.equal(after.tabs[1].displayUrl, `${server.origin}/page2`);
  });
});
