'use strict';

// Claude in Chrome itself cannot be downloaded in CI, so this suite drives a
// stand-in extension that makes the same kinds of calls agent extensions make:
// a side panel opened from the toolbar, CDP control of a tab via
// chrome.debugger, tab groups, scripting, screenshots and web auth.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require('./harness');

const STANDIN = path.join(h.FIXTURES, 'extensions', 'agent-standin');

test('[Agent extensions] Claude-in-Chrome-style stand-in works end to end', async (t) => {
  const server = await h.startServer();
  const userData = h.tempProfile('agent');
  const { app, ui } = await h.launch({ userData, home: `${server.origin}/` });
  t.after(async () => {
    await app.close().catch(() => {});
    await server.close();
  });

  const ext = await app.evaluate(async (_e, dir) => globalThis.__ordinance.ctx.extensions.load(dir), STANDIN);
  await h.waitUntil(async () => (await h.mainState(app)).tabs[0]?.title === 'Home Fixture', { message: 'home page' });
  const button = `#extension-actions [data-extension-id="${ext.id}"]`;
  await ui.waitForSelector(button);

  let sidePanelUrl;
  await t.test('toolbar button opens the extension side panel (setPanelBehavior)', async () => {
    await ui.click(button);
    const state = await h.waitUntil(async () => (await h.mainState(app)).sidePanel, { message: 'side panel' });
    sidePanelUrl = state.url;
    assert.equal(state.extensionId, ext.id);
    assert.equal(state.url, `chrome-extension://${ext.id}/sidepanel.html`);
    await ui.waitForSelector('#sidepanel-header:not([hidden])');
    assert.equal(await ui.textContent('#sidepanel-title'), 'Agent Stand-in');
  });

  let bannerSeen = false;
  let result;
  await t.test('agent run: debugger attach, evaluate, screenshot, click, type, events, detach', async () => {
    const poll = setInterval(async () => {
      try {
        if (await ui.isVisible('#debug-banner')) bannerSeen = true;
      } catch {
        /* closing */
      }
    }, 100);
    try {
      result = await h.waitUntil(
        () =>
          app.evaluate(() => {
            const c = [...globalThis.__ordinance.controllers][0];
            return c.sidePanel?.view.webContents.executeJavaScript('window.__agentResult || null');
          }),
        { timeout: 40000, message: 'agent result from side panel' },
      );
    } finally {
      clearInterval(poll);
    }
    h.screenshot('agent-side-panel');
    assert.equal(result.error, undefined, `agent reported: ${result.error}`);
    assert.equal(result.title, 'Agent Target');
    assert.ok(result.screenshotBytes > 1000, 'Page.captureScreenshot returned an image');
    assert.equal(result.clicks, 1, 'Input.dispatchMouseEvent clicked the button');
    assert.equal(result.typed, 'typed by agent', 'Input.insertText typed into the field');
    assert.match(result.secondAttachError, /Another debugger is already attached/);
    assert.equal(result.targetAttached, true);
    assert.ok(result.eventsSeen.includes('Page.loadEventFired'), `CDP events delivered: ${result.eventsSeen}`);
  });

  await t.test('debugging banner was shown while attached and cleared after detach', async () => {
    assert.ok(bannerSeen, 'banner visible during the run');
    await h.waitUntil(async () => !(await ui.isVisible('#debug-banner')), { message: 'banner hidden' });
  });

  await t.test('tabs.create + tabs.group + tabGroups.update colour the new tab', async () => {
    assert.ok(result.groupId >= 1);
    assert.deepEqual(
      { title: result.group.title, color: result.group.color },
      { title: 'Agent', color: 'orange' },
    );
    const state = await h.mainState(app);
    assert.ok(state.order.includes(result.tabId), 'agent tab exists in the tab strip');
    const grouped = await ui.$eval(`#tabs .tab[data-id="${result.tabId}"]`, (n) => n.classList.contains('grouped'));
    assert.ok(grouped, 'tab shows the group colour');
  });

  await t.test('scripting.executeScript, tabs.captureVisibleTab, identity.launchWebAuthFlow', async () => {
    assert.equal(result.scripted, 'Agent Target');
    assert.equal(result.visiblePrefix, 'data:image/png;base64,');
    assert.equal(result.authResult, `https://${ext.id}.chromiumapp.org/cb?code=test-code`);
  });

  await t.test('content scripts run in pages', async () => {
    const value = await h.tabEval(app, result.tabId, 'document.documentElement.dataset.agentStandin');
    assert.equal(value, 'injected');
  });

  await t.test('web pages do not get the extension-only shims', async () => {
    const leaked = await h.tabEval(app, result.tabId, 'typeof (globalThis.chrome && chrome.debugger)');
    assert.equal(leaked, 'undefined');
  });

  await t.test('toolbar button toggles the side panel closed', async () => {
    await ui.click(button);
    await h.waitUntil(async () => (await h.mainState(app)).sidePanel === null, { message: 'side panel closed' });
    assert.ok(sidePanelUrl);
  });
});
