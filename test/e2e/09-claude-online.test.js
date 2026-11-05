'use strict';

// Live check against the real Chrome Web Store: install Claude ("Add to
// Chrome"), then open it from the toolbar and record what happens. Needs
// internet, so it only runs with ORDINANCE_ONLINE=1 (a separate CI job).
// Results: test/.tmp/claude-report.json and test/.tmp/claude-*.png

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./harness');

const ONLINE = process.env.ORDINANCE_ONLINE === '1';
const CLAUDE_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const STORE_URL = `https://chromewebstore.google.com/detail/claude/${CLAUDE_ID}`;
const SUPPORTED_PROBE = path.join(h.ROOT, 'docs', 'api-probe', 'ordinance-browser.json');
const { STUBS, MISSING } = require('../../src/main/extension-support');

/** Screenshot a webContents to test/.tmp; GPU-less CI runners can fail this, which is not a test failure. */
async function snap(app, wcIdOrUi, file) {
  try {
    const b64 = await app.evaluate(async ({ webContents }, id) => {
      const wc = id === 'ui' ? [...globalThis.__ordinance.controllers][0].ui : webContents.fromId(id);
      return (await wc.capturePage()).toPNG().toString('base64');
    }, wcIdOrUi);
    fs.writeFileSync(path.join(h.ARTIFACTS, file), Buffer.from(b64, 'base64'));
    return true;
  } catch (err) {
    return `screenshot failed: ${err.message}`;
  }
}

/** chrome.* namespaces referenced anywhere in the extension's JavaScript. */
function scanApiUsage(dir) {
  const counts = {};
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.m?js$/.test(entry.name)) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/\bchrome\.([a-zA-Z]+)(?:\.([a-zA-Z]+))?/g)) {
          if (m[1] === 'exe') continue; // "chrome.exe" in strings, not an API
          const key = m[1] === 'system' && m[2] ? `system.${m[2]}` : m[1];
          counts[key] = (counts[key] || 0) + 1;
        }
      }
    }
  };
  walk(dir);
  return counts;
}

test('[Online] Claude in Chrome from the live Chrome Web Store', { skip: !ONLINE && 'set ORDINANCE_ONLINE=1 (needs internet)' }, async (t) => {
  const report = { startedAt: new Date().toISOString(), steps: {}, console: [], extensionErrors: [], compatCalls: [], webStoreLog: [] };
  const save = () => {
    fs.mkdirSync(h.ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(h.ARTIFACTS, 'claude-report.json'), JSON.stringify(report, null, 2));
  };
  const { app, ui } = await h.launch({ userData: h.tempProfile('claude'), home: 'https://www.google.com/' });
  app.process().stderr.on('data', (d) => {
    const s = String(d);
    if (/Extension Error|Uncaught|is not yet implemented|cannot add chrome/i.test(s)) report.extensionErrors.push(s.slice(0, 2000));
    // With DEBUG=electron-chrome-web-store:* (set in CI) the store library logs
    // each install step and its result code, e.g. why "Add to Chrome" stopped.
    for (const line of s.split('\n')) {
      if (/electron-chrome-web-store:/.test(line) && report.webStoreLog.length < 300) report.webStoreLog.push(line.slice(0, 400));
    }
  });
  t.after(async () => {
    report.console = (await app.evaluate(() => globalThis.__consoleLog).catch(() => [])) || [];
    report.steps.dialogsSeen = ((await app.evaluate(() => globalThis.__installPrompts).catch(() => [])) || []).map((p) => p.message);
    report.compatCalls = (await app.evaluate(() => globalThis.__compatCalls).catch(() => [])) || [];
    save();
    console.log('CLAUDE REPORT SUMMARY', JSON.stringify({ steps: report.steps, apiUsage: report.apiUsage, unsupportedUsed: report.unsupportedUsed, extensionErrors: report.extensionErrors.slice(0, 10), webStoreLog: report.webStoreLog.filter((l) => !/:updater/.test(l)).slice(-40), consoleErrors: report.console.filter((c) => c.level >= 2).slice(0, 25), compatErrors: report.compatCalls.filter((c) => c.error).slice(0, 25) }, null, 2));
    await app.close().catch(() => {});
  });

  // Record console output from the extension's service worker and pages, and every shim call.
  await app.evaluate(({ session, webContents }) => {
    const ses = session.fromPartition('persist:ordinance');
    globalThis.__consoleLog = [];
    globalThis.__compatCalls = [];
    const push = (where, level, message) => globalThis.__consoleLog.length < 400 && globalThis.__consoleLog.push({ where, level, message: String(message).slice(0, 500) });
    ses.serviceWorkers.on('console-message', (_e, d) => push(`sw:${d.sourceUrl || ''}`, d.level, d.message));
    const watch = (wc) => wc.on('console-message', (e, ...args) => {
      const level = typeof e.level === 'number' ? e.level : args[0];
      const message = e.message ?? args[1];
      if (wc.getURL().startsWith('chrome-extension://')) push(wc.getURL(), level, message);
    });
    webContents.getAllWebContents().forEach(watch);
    require('electron').app.on('web-contents-created', (_e, wc) => watch(wc));
    const compat = globalThis.__ordinance.ctx.compat;
    const original = compat.onCall.bind(compat);
    compat.onCall = async (event, method, args) => {
      const res = await original(event, method, args);
      globalThis.__compatCalls.push({ method, error: res?.error });
      return res;
    };
  }).catch(async () => {
    // `require` is not in scope in some Electron builds; fall back without page console capture.
    await app.evaluate(({ session }) => {
      const ses = session.fromPartition('persist:ordinance');
      globalThis.__consoleLog = [];
      globalThis.__compatCalls = [];
      ses.serviceWorkers.on('console-message', (_e, d) => globalThis.__consoleLog.push({ where: 'sw', level: d.level, message: String(d.message).slice(0, 500) }));
      const compat = globalThis.__ordinance.ctx.compat;
      const original = compat.onCall.bind(compat);
      compat.onCall = async (event, method, args) => {
        const res = await original(event, method, args);
        globalThis.__compatCalls.push({ method, error: res?.error });
        return res;
      };
    });
  });

  let tabId;
  await t.test('Web Store page loads with the install API', async () => {
    tabId = await app.evaluate((_e, url) => [...globalThis.__ordinance.controllers][0].createTab({ url }).id, STORE_URL);
    const page = await h.waitUntil(
      () =>
        h.tabEval(app, tabId, `({ api: typeof (window.chrome && chrome.webstorePrivate), text: document.body ? document.body.innerText.slice(0, 4000) : '' })`).then((r) =>
          /Add to Chrome|Remove from Chrome/.test(r.text) ? r : null,
        ),
      { timeout: 60000, interval: 500, message: 'store page with Add to Chrome' },
    );
    report.steps.storeApi = page.api;
    report.steps.switchToChromeBanner = /Switch to Chrome/.test(page.text);
    report.steps.storeScreenshot = await snap(app, tabId, 'claude-store-page.png');
    assert.equal(page.api, 'object');
  });

  await t.test('"Add to Chrome" installs Claude after the confirmation prompt', async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.__installPrompts = [];
      dialog.showMessageBox = async (...args) => {
        const opts = args.length > 1 ? args[1] : args[0];
        globalThis.__installPrompts.push({ message: opts.message, detail: opts.detail });
        // Accept only the install prompt. Any other dialog (e.g. "Page
        // Unresponsive" on a slow runner) gets its safe/cancel answer, so the
        // stub never picks a destructive first button by accident.
        const isInstall = /^Add ".*"\?$/.test(opts.message || '');
        return { response: isInstall ? 0 : (opts.cancelId ?? 1) };
      };
    });
    const clickAdd = () =>
      app.evaluate(
        ({ webContents }, id) =>
          webContents.fromId(id).executeJavaScript(
            `(() => {
              const el = [...document.querySelectorAll('button, span, div')].find((n) => n.children.length === 0 && /^\\s*Add to Chrome\\s*$/.test(n.innerText || ''));
              if (!el) return false;
              (el.closest('button') || el).click();
              return true;
            })()`,
            true,
          ),
        tabId,
      );
    // The store renders "Add to Chrome" before its script wires the click up.
    // On a slow page load a single early click is silently ignored (no
    // beginInstall reaches the browser), so retry until the store responds.
    const responded = () =>
      app.evaluate(
        (_e, id) => (globalThis.__installPrompts || []).some((p) => /^Add "/.test(p.message || '')) || !!globalThis.__ordinance.ctx.extensions.get(id),
        CLAUDE_ID,
      );
    let clicked = false;
    let clicks = 0;
    for (const deadline = Date.now() + 60000; Date.now() < deadline && !(await responded()); ) {
      if (await clickAdd()) {
        clicked = true;
        clicks += 1;
      } else if (!clicked) break; // no such button at all: use the fallback below
      await h.sleep(3000);
    }
    report.steps.clickedAddButton = clicked;
    report.steps.addButtonClicks = clicks;
    if (!clicked) {
      // Store markup changed: install the same way the button would.
      report.steps.installFallback = true;
      await app.evaluate((_e, id) => globalThis.__ordinance.installWebStoreExtension(id), CLAUDE_ID);
    }
    await h.waitUntil(() => app.evaluate((_e, id) => !!globalThis.__ordinance.ctx.extensions.get(id), CLAUDE_ID), {
      timeout: 120000,
      interval: 1000,
      message: 'Claude installed',
    });
    const prompts = (await app.evaluate(() => globalThis.__installPrompts)) || [];
    report.steps.installPrompt = prompts.find((p) => /^Add "/.test(p.message || '')) || null;
    const others = prompts.filter((p) => !/^Add "/.test(p.message || ''));
    if (others.length) report.steps.otherDialogs = others.map((p) => p.message);

    const info = await app.evaluate((_e, id) => {
      const ext = globalThis.__ordinance.ctx.extensions.get(id);
      const m = ext.manifest;
      return {
        path: ext.path,
        name: ext.name,
        version: ext.version,
        permissions: m.permissions,
        optional_permissions: m.optional_permissions,
        host_permissions: m.host_permissions,
        side_panel: m.side_panel,
        action: m.action,
        background: m.background,
        externally_connectable: m.externally_connectable,
        hasKey: !!m.key,
        described: globalThis.__ordinance.ctx.extensions.describe(ext),
      };
    }, CLAUDE_ID);
    report.manifest = info;
    const usage = scanApiUsage(info.path);
    const supported = JSON.parse(fs.readFileSync(SUPPORTED_PROBE, 'utf8')).sw.paths;
    const works = (ns) => {
      if (MISSING.includes(ns)) return false;
      if (STUBS.includes(ns)) return 'stub (calls do nothing)';
      return supported[ns] === undefined ? 'not probed' : supported[ns] !== 'missing';
    };
    report.apiUsage = Object.fromEntries(Object.entries(usage).sort((a, b) => b[1] - a[1]).map(([ns, n]) => [ns, { refs: n, inChrome2: works(ns) }]));
    report.unsupportedUsed = Object.entries(report.apiUsage).filter(([, v]) => v.inChrome2 !== true).map(([ns, v]) => `${ns}: ${v.inChrome2}`);
    save();
    assert.equal(info.described.source, 'webstore');
  });

  await t.test('clicking the toolbar button opens Claude (side panel or popup)', async () => {
    await h.sleep(3000); // let the service worker register its panel behaviour
    await ui.click(`#extension-actions [data-extension-id="${CLAUDE_ID}"]`);
    const opened = await h
      .waitUntil(
        () =>
          app.evaluate(({ BrowserWindow }) => {
            const c = [...globalThis.__ordinance.controllers][0];
            if (c.sidePanel) return { kind: 'sidePanel', url: c.sidePanel.url };
            const popup = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('chrome-extension://'));
            return popup ? { kind: 'popup', url: popup.webContents.getURL() } : null;
          }),
        { timeout: 20000, message: 'side panel or popup' },
      )
      .catch(() => ({ kind: 'nothing' }));
    report.steps.toolbarClick = opened;
    await h.sleep(10000); // give the UI time to render and sign-in checks to run
    if (opened.kind === 'sidePanel') {
      const panel = await app.evaluate(async () => {
        const wc = [...globalThis.__ordinance.controllers][0].sidePanel.view.webContents;
        const text = await wc.executeJavaScript('document.body ? document.body.innerText.slice(0, 1500) : ""').catch((e) => `error: ${e.message}`);
        return { id: wc.id, text, title: wc.getTitle() };
      });
      report.steps.sidePanel = { title: panel.title, text: panel.text, screenshot: await snap(app, panel.id, 'claude-side-panel.png') };
    }
    report.steps.uiScreenshot = await snap(app, 'ui', 'claude-window-ui.png');
    save();
    assert.notEqual(opened.kind, 'nothing', 'toolbar click opened something');
  });
});
