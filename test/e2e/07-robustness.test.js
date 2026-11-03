'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./harness');

const HELLO = path.join(h.FIXTURES, 'extensions', 'hello-content');

/** Bounds of the active tab's view and the window's content size. */
const viewGeometry = (app) =>
  app.evaluate(() => {
    const c = [...globalThis.__ordinance.controllers][0];
    const [width, height] = c.win.getContentSize();
    return { bounds: c.activeTab.view.getBounds(), width, height };
  });

test('[Robustness] fullscreen video, crashed tabs, extension load errors', async (t) => {
  const server = await h.startServer();
  const userData = h.tempProfile('robust');
  // A saved extension whose folder no longer exists, plus a drop-in extension.
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ extensions: ['/nonexistent/moved-extension'] }));
  fs.cpSync(HELLO, path.join(userData, 'extensions', 'hello-dropin'), { recursive: true });

  let { app, ui } = await h.launch({ userData, home: `${server.origin}/page1` });
  t.after(async () => {
    await app.close().catch(() => {});
    await server.close();
  });
  const active = async () => {
    const s = await h.mainState(app);
    return s.tabs.find((x) => x.id === s.activeId);
  };
  await h.waitUntil(async () => (await active())?.title === 'Page One', { message: 'Page One' });
  const tabId = (await active()).id;

  await t.test('HTML fullscreen fills the window and Escape restores the toolbar', async () => {
    const normal = await viewGeometry(app);
    assert.ok(normal.bounds.y > 0, 'toolbar visible above the page');
    await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('document.documentElement.requestFullscreen().then(() => true)', true), tabId);
    await h.waitUntil(
      async () => {
        const g = await viewGeometry(app);
        return g.bounds.y === 0 && g.bounds.width === g.width && g.bounds.height === g.height;
      },
      { message: 'page covers the whole window' },
    );
    await app.evaluate(({ webContents }, id) => {
      const wc = webContents.fromId(id);
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    }, tabId);
    await h.waitUntil(async () => (await viewGeometry(app)).bounds.y === normal.bounds.y, { message: 'toolbar restored' });
  });

  await t.test('a crashed tab shows an error page and Reload recovers it', async () => {
    await app.evaluate(({ webContents }, id) => webContents.fromId(id).forcefullyCrashRenderer(), tabId);
    await h.waitUntil(async () => (await active()).title === 'This page crashed', { message: 'crash page' });
    assert.equal((await active()).displayUrl, `${server.origin}/page1`, 'address bar keeps the URL');
    await ui.click('#reload');
    await h.waitUntil(async () => (await active()).title === 'Page One', { message: 'reloaded after crash' });
  });

  await t.test('extensions that fail to load are listed with a Forget button', async () => {
    await ui.click('#toggle-extensions');
    await ui.waitForSelector('#extension-errors li');
    assert.match(await ui.textContent('#extension-errors'), /\/nonexistent\/moved-extension/);
    await ui.click('#extension-errors li .remove');
    await h.waitUntil(async () => (await ui.$$('#extension-errors li')).length === 0, { message: 'error forgotten' });
    const settings = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.extensions, []);
  });

  await t.test('removing a drop-in extension survives a restart', async () => {
    assert.equal(await app.evaluate(() => globalThis.__ordinance.ctx.extensions.list().length), 1, 'drop-in loaded');
    await ui.click('#extension-list li .remove');
    await h.waitUntil(async () => (await ui.$$('#extension-list li')).length === 0, { message: 'removed' });
    await app.close();
    ({ app, ui } = await h.launch({ userData, home: `${server.origin}/page1` }));
    assert.equal(await app.evaluate(() => globalThis.__ordinance.ctx.extensions.list().length), 0, 'still removed after restart');
  });

  await t.test('loading the same folder again re-enables it', async () => {
    await app.evaluate(async (_e, dir) => globalThis.__ordinance.ctx.extensions.load(dir), path.join(userData, 'extensions', 'hello-dropin'));
    await app.close();
    ({ app, ui } = await h.launch({ userData, home: `${server.origin}/page1` }));
    assert.equal(await app.evaluate(() => globalThis.__ordinance.ctx.extensions.list().length), 1);
  });
});
