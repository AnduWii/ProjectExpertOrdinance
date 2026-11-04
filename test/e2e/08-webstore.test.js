'use strict';

// The Chrome Web Store cannot be reached from CI sandboxes, so this suite
// serves a stand-in page at https://chromewebstore.google.com and checks the
// browser side of "Add to Chrome": the injected webstorePrivate API, the
// Chrome-like user agent, stable button branding and the install prompt.
// test/e2e/09-claude-online.test.js does the real thing when online.

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

const FAKE_ID = 'abcdefghijklmnopabcdefghijklmnop';
const STORE_PAGE = `<!doctype html><meta charset="utf-8"><title>Fake Web Store</title>
<span id="add">Add to Chrome</span>
<script>
  window.__result = null;
  window.tryInstall = () => new Promise((resolve) => {
    chrome.webstorePrivate.beginInstallWithManifest3({
      id: '${FAKE_ID}',
      localizedName: 'Agent Helper',
      iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      manifest: JSON.stringify({
        manifest_version: 3, name: 'Agent Helper', version: '1.0',
        permissions: ['debugger', 'tabs', 'bookmarks', 'sidePanel'],
        host_permissions: ['<all_urls>'],
      }),
    }, (result) => resolve(result));
  });
</script>`;

test('[Chrome Web Store] "Add to Chrome" works from chromewebstore.google.com (offline stand-in)', async (t) => {
  const server = await h.startServer();
  const { app, ui } = await h.launch({ userData: h.tempProfile('cws'), home: `${server.origin}/` });
  t.after(async () => {
    await app.close().catch(() => {});
    await server.close();
  });

  await app.evaluate(({ session, net }, html) => {
    session.fromPartition('persist:ordinance').protocol.handle('https', (req) => {
      if (new URL(req.url).hostname === 'chromewebstore.google.com') {
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return net.fetch(req, { bypassCustomProtocolHandlers: true });
    });
  }, STORE_PAGE);

  let storeTab;
  await t.test('the Extensions panel opens the Chrome Web Store in a tab', async () => {
    await ui.click('#toggle-extensions');
    await ui.click('#extension-webstore');
    const s = await h.waitUntil(async () => {
      const st = await h.mainState(app);
      return st.tabs.find((x) => x.title === 'Fake Web Store') && st;
    }, { message: 'store tab' });
    storeTab = s.tabs.find((x) => x.title === 'Fake Web Store').id;
  });

  await t.test('the store page gets chrome.webstorePrivate and a Chrome user agent', async () => {
    const info = await h.waitUntil(
      () => h.tabEval(app, storeTab, '({ api: typeof chrome.webstorePrivate, ua: navigator.userAgent })'),
      { message: 'store API' },
    );
    assert.equal(info.api, 'object');
    assert.match(info.ua, /Chrome\/\d+/);
    assert.doesNotMatch(info.ua, /Electron|Chrome2/);
  });

  await t.test('button branding stays "Add to Chrome" after repeated re-branding passes', async () => {
    // The store re-brands on every in-page navigation; it must not grow "Chrome2222".
    await h.tabEval(app, storeTab, `(async () => { for (const f of ['#a', '#b', '#c']) { await navigation.navigate(f).finished; } return true; })()`);
    await h.sleep(300);
    assert.equal(await h.tabEval(app, storeTab, 'document.getElementById("add").innerText'), 'Add to Chrome');
  });

  await t.test('install asks first, listing what the extension can do; Cancel aborts', async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.__installPrompts = [];
      dialog.showMessageBox = async (...args) => {
        const opts = args.length > 1 ? args[1] : args[0];
        globalThis.__installPrompts.push({ message: opts.message, detail: opts.detail, buttons: opts.buttons });
        return { response: 1 }; // Cancel
      };
    });
    const result = await h.tabEval(app, storeTab, 'window.tryInstall()');
    assert.equal(result, 'user_cancelled');
    const [prompt] = await app.evaluate(() => globalThis.__installPrompts);
    assert.equal(prompt.message, 'Add "Agent Helper"?');
    assert.deepEqual(prompt.buttons, ['Add extension', 'Cancel']);
    assert.match(prompt.detail, /Read and change all your data on all websites/);
    assert.match(prompt.detail, /Access the page debugger backend/);
    assert.match(prompt.detail, /Not available in Chrome2: bookmarks/);
    assert.equal(await app.evaluate((_e, id) => !!globalThis.__ordinance.ctx.extensions.get(id), FAKE_ID), false, 'nothing installed');
  });
});
