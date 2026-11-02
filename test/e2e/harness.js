'use strict';

/**
 * Shared helpers for the end-to-end suite: a local HTTP fixture server and a
 * launcher that starts the real app through Playwright's Electron driver.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright-core');
const electronPath = require('electron');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const ARTIFACTS = path.join(ROOT, 'test', '.tmp');

const page = (title, body = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

function startServer() {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    hits.set(url.pathname, (hits.get(url.pathname) || 0) + 1);
    const send = (html, status = 200, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
      res.end(html);
    };
    if (url.pathname === '/') return send(page('Home Fixture', '<a href="/page1">page one</a>'));
    if (url.pathname === '/page1') return send(page('Page One', '<a id="next" href="/page2">page two</a>'));
    if (url.pathname === '/page2') return send(page('Page Two'));
    if (url.pathname === '/counter') return send(page(`Counter ${hits.get('/counter')}`));
    if (url.pathname.startsWith('/named/')) return send(page(decodeURIComponent(url.pathname.slice(7))));
    if (url.pathname === '/agent-target') {
      return send(
        page(
          'Agent Target',
          `<button id="target" style="position:absolute;left:40px;top:120px;width:200px;height:60px">Click me</button>
<input id="field" style="position:absolute;left:40px;top:220px;width:300px">
<script>
  window.__clicks = 0;
  document.getElementById('target').addEventListener('click', () => { window.__clicks++; document.title = 'Clicked ' + window.__clicks; });
  document.getElementById('field').addEventListener('input', (e) => { window.__typed = e.target.value; });
</script>`,
        ),
      );
    }
    if (url.pathname === '/auth/start') {
      const redirect = url.searchParams.get('redirect') || '/';
      return send('', 302, { location: `${redirect}?code=test-code` });
    }
    return send(page('Not Found'), 404);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ origin: `http://localhost:${port}`, port, hits, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, { timeout = 15000, interval = 100, message = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${message} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

function tempProfile(name) {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  return fs.mkdtempSync(path.join(os.tmpdir(), `ordinance-${name}-`));
}

/** Launch the browser. Returns { app, ui } where ui is the toolbar page. */
async function launch({ userData, home, args = [] }) {
  const env = { ...process.env, ORDINANCE_TEST: '1', ORDINANCE_USER_DATA: userData, ORDINANCE_HOME: home };
  delete env.NODE_OPTIONS; // Electron rejects some Node flags (e.g. --use-openssl-ca)
  // ORDINANCE_APP_PATH runs the suite against a packaged build instead of `electron .`
  const packaged = process.env.ORDINANCE_APP_PATH;
  const app = await _electron.launch({
    executablePath: packaged || electronPath,
    args: packaged ? args : [ROOT, ...args],
    env,
    timeout: 45000,
    // Playwright adds --no-sandbox on Linux unless told otherwise, and Electron
    // only runs service-worker preloads (needed for MV3 extension APIs) with
    // the sandbox on. Test like the app actually runs.
    chromiumSandbox: true,
  });
  const ui = await waitUntil(() => app.windows().find((w) => w.url().endsWith('/renderer/index.html')), {
    message: 'browser UI window',
  });
  await ui.waitForSelector('.tab', { timeout: 20000 });
  return { app, ui };
}

/** Snapshot of the first window's tabs as the main process sees them. */
function mainState(app) {
  return app.evaluate(() => {
    const o = globalThis.__ordinance;
    const c = [...o.controllers][0];
    if (!c) return null;
    return {
      windowCount: o.controllers.size,
      activeId: c.activeId,
      order: [...c.order],
      tabs: c.order.map((id) => {
        const t = c.tabs.get(id);
        return { id, url: t.wc.getURL(), title: t.wc.getTitle(), displayUrl: t.errorFor || t.url, loading: t.loading };
      }),
      sidePanel: c.sidePanel ? { extensionId: c.sidePanel.extensionId, url: c.sidePanel.view.webContents.getURL() } : null,
    };
  });
}

function tabEval(app, tabId, js) {
  return app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code), [tabId, js]);
}

async function uiTabTitles(ui) {
  return ui.$$eval('#tabs .tab .title', (els) => els.map((e) => e.textContent));
}

/** Full-screen capture of the Xvfb display (best effort, Linux only). */
function screenshot(name) {
  if (!process.env.DISPLAY) return null;
  try {
    const dir = path.join(ARTIFACTS, 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    execFileSync('import', ['-window', 'root', file], { stdio: 'ignore' });
    return file;
  } catch {
    return null;
  }
}

/** Replace the native folder picker so "Load unpacked…" can be driven by tests. */
function stubFolderPicker(app, folder) {
  return app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, folder);
}

module.exports = {
  ROOT,
  FIXTURES,
  ARTIFACTS,
  startServer,
  launch,
  mainState,
  tabEval,
  uiTabTitles,
  waitUntil,
  sleep,
  tempProfile,
  screenshot,
  stubFolderPicker,
};
