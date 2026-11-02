'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./harness');

const HELLO = path.join(h.FIXTURES, 'extensions', 'hello-content');
const PROBE = path.join(h.FIXTURES, 'extensions', 'api-probe');

test('[Extensions] load unpacked, popup, persist, remove, API surface', async (t) => {
  const server = await h.startServer();
  const userData = h.tempProfile('ext');
  let { app, ui } = await h.launch({ userData, home: `${server.origin}/` });
  t.after(async () => {
    await app.close().catch(() => {});
    await server.close();
  });
  const settings = () => JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  const activeTabId = async () => (await h.mainState(app)).activeId;
  let extId;

  await t.test('"Load unpacked…" loads a folder via session.extensions.loadExtension', async () => {
    await h.stubFolderPicker(app, HELLO);
    await ui.click('#toggle-extensions');
    await ui.click('#extension-load');
    await ui.waitForSelector('#extension-list li');
    const text = await ui.textContent('#extension-list');
    assert.match(text, /Hello Content 1\.0\.0/);
    extId = await app.evaluate(() => globalThis.__ordinance.ctx.extensions.list()[0].id);
    assert.match(extId, /^[a-p]{32}$/);
    assert.deepEqual(settings().extensions, [HELLO]);
    // Unsupported permission is called out.
    assert.match(text, /Not available in this browser: bookmarks/);
  });

  await t.test('content scripts run on pages', async () => {
    await ui.fill('#address', `${server.origin}/page1`);
    await ui.press('#address', 'Enter');
    await h.waitUntil(async () => (await h.tabEval(app, await activeTabId(), 'document.documentElement.dataset.helloContent')) === 'injected', {
      message: 'content script marker',
    });
  });

  await t.test('toolbar button opens the action popup', async () => {
    await ui.click(`#extension-actions [data-extension-id="${extId}"]`);
    const popupUrl = await h.waitUntil(
      () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .map((w) => w.webContents.getURL())
            .find((u) => u.startsWith('chrome-extension://')),
        ),
      { message: 'popup window' },
    );
    assert.equal(popupUrl, `chrome-extension://${extId}/popup.html`);
    h.screenshot('extension-popup');
  });

  await t.test('extensions are re-loaded after a restart', async () => {
    await app.close();
    ({ app, ui } = await h.launch({ userData, home: `${server.origin}/page2` }));
    const ids = await app.evaluate(() => globalThis.__ordinance.ctx.extensions.list().map((e) => e.id));
    assert.deepEqual(ids, [extId]);
    await h.waitUntil(async () => (await h.tabEval(app, await activeTabId(), 'document.documentElement.dataset.helloContent')) === 'injected', {
      message: 'content script after restart',
    });
  });

  await t.test('folders copied from a Chrome profile (with _metadata) load as-is', async () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinance-meta-'));
    fs.cpSync(HELLO, copy, { recursive: true });
    fs.mkdirSync(path.join(copy, '_metadata'));
    fs.writeFileSync(path.join(copy, '_metadata', 'verified_contents.json'), '[]');
    const info = await app.evaluate((_e, dir) => globalThis.__ordinance.ctx.extensions.load(dir, { persist: false }), copy);
    assert.equal(info.name, 'Hello Content');
    const loadedFrom = await app.evaluate((_e, id) => globalThis.__ordinance.ctx.extensions.get(id).path, info.id);
    assert.equal(loadedFrom, copy);
    await app.evaluate((_e, id) => globalThis.__ordinance.ctx.extensions.remove(id), info.id);
  });

  await t.test('invalid folders are rejected with a clear error', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinance-empty-'));
    const message = await app.evaluate(async (_e, dir) => {
      try {
        await globalThis.__ordinance.ctx.extensions.load(dir);
        return 'loaded';
      } catch (err) {
        return err.message;
      }
    }, empty);
    assert.match(message, /No manifest\.json/);
  });

  await t.test('Remove unloads the extension and forgets it', async () => {
    await ui.click('#toggle-extensions');
    await ui.waitForSelector('#extension-list li');
    await ui.click('#extension-list li .remove');
    await h.waitUntil(async () => (await ui.$$('#extension-list li')).length === 0, { message: 'list empty' });
    assert.deepEqual(settings().extensions, []);
    assert.equal(await app.evaluate(() => globalThis.__ordinance.ctx.extensions.list().length), 0);
  });

  await t.test('API probe: which chrome.* namespaces work (written to test/.tmp/api-probe.json)', async () => {
    const ext = await app.evaluate(async (_e, dir) => globalThis.__ordinance.ctx.extensions.load(dir, { persist: false }), PROBE);
    const tabId = await app.evaluate((_e, id) => {
      const c = [...globalThis.__ordinance.controllers][0];
      return c.createTab({ url: `chrome-extension://${id}/page.html` }).id;
    }, ext.id);
    await h.waitUntil(async () => (await h.tabEval(app, tabId, 'document.title')) === 'probe-done', { timeout: 30000, message: 'probe' });
    const probe = await h.tabEval(app, tabId, 'window.__probe');
    fs.mkdirSync(h.ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(h.ARTIFACTS, 'api-probe.json'), JSON.stringify(probe, null, 2));
    const sw = probe.sw.paths;
    for (const p of ['debugger.attach', 'sidePanel.open', 'tabGroups', 'identity.launchWebAuthFlow', 'tabs.group', 'tabs.captureVisibleTab', 'windows.create', 'tabs.create', 'contextMenus', 'cookies', 'webNavigation']) {
      assert.notEqual(sw[p], 'missing', `service worker has chrome.${p}`);
    }
    for (const p of ['bookmarks', 'history', 'tabCapture', 'sessions', 'tts', 'userScripts', 'omnibox']) {
      assert.equal(sw[p], 'missing', `chrome.${p} is not provided`);
    }
    // electron-chrome-extensions defines chrome.downloads as a no-op stub.
    assert.doesNotMatch(probe.functional['downloads.search'], /^ok/);
    assert.match(probe.functional['debugger.getTargets'], /^ok/);
    assert.match(probe.functional['tabGroups.query'], /^ok/);
    assert.match(probe.functional['windows.getAll'], /^ok/);
  });
});
