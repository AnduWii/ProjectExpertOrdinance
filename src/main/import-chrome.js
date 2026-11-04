'use strict';

/**
 * Import bookmarks and history from other Chromium-based browsers (Chrome,
 * Edge, Brave, Chromium). Reads only the plain `Bookmarks` JSON file and the
 * `History` SQLite database from the user's own profile.
 *
 * It deliberately does NOT touch cookies, saved passwords or login sessions.
 * Those are encrypted with a key in the OS keychain, and pulling live sessions
 * out of another browser is exactly what cookie-stealing malware does, so it
 * is out of scope. To sign in, sign in inside this browser once.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Known Chromium browsers and where each keeps its "User Data" root, per OS. */
const BROWSERS = {
  darwin: [
    ['Google Chrome', 'Library/Application Support/Google/Chrome'],
    ['Google Chrome Beta', 'Library/Application Support/Google/Chrome Beta'],
    ['Google Chrome Dev', 'Library/Application Support/Google/Chrome Dev'],
    ['Google Chrome Canary', 'Library/Application Support/Google/Chrome Canary'],
    ['Microsoft Edge', 'Library/Application Support/Microsoft Edge'],
    ['Brave', 'Library/Application Support/BraveSoftware/Brave-Browser'],
    ['Arc', 'Library/Application Support/Arc/User Data'],
    ['Chromium', 'Library/Application Support/Chromium'],
    ['Vivaldi', 'Library/Application Support/Vivaldi'],
  ],
  win32: [
    ['Google Chrome', 'Google/Chrome/User Data'],
    ['Google Chrome Beta', 'Google/Chrome Beta/User Data'],
    ['Google Chrome Dev', 'Google/Chrome Dev/User Data'],
    ['Google Chrome Canary', 'Google/Chrome SxS/User Data'],
    ['Microsoft Edge', 'Microsoft/Edge/User Data'],
    ['Brave', 'BraveSoftware/Brave-Browser/User Data'],
    ['Chromium', 'Chromium/User Data'],
    ['Vivaldi', 'Vivaldi/User Data'],
  ],
  linux: [
    ['Google Chrome', '.config/google-chrome'],
    ['Google Chrome Beta', '.config/google-chrome-beta'],
    ['Google Chrome Dev', '.config/google-chrome-unstable'],
    ['Chromium', '.config/chromium'],
    ['Brave', '.config/BraveSoftware/Brave-Browser'],
    ['Microsoft Edge', '.config/microsoft-edge'],
    ['Vivaldi', '.config/vivaldi'],
  ],
};

const isMissing = (err) => err?.code === 'ENOENT' || err?.code === 'ENOTDIR';

/**
 * Every place a supported browser could keep its data on this OS. The
 * options exist so tests can point at a fake home folder or another OS.
 */
function candidateRoots({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const list = BROWSERS[platform] || BROWSERS.linux;
  const base = platform === 'win32' ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local') : home;
  return list.map(([name, rel]) => ({ name, root: path.join(base, rel) }));
}

/** The candidate roots that exist. */
function browserRoots(opts) {
  return candidateRoots(opts).filter((b) => safeExists(b.root));
}

/** Where a "Choose Folder" picker should open. */
function defaultDataDir({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin') {
    const google = path.join(home, 'Library', 'Application Support', 'Google');
    return safeExists(google) ? google : path.join(home, 'Library', 'Application Support');
  }
  if (platform === 'win32') return env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return path.join(home, '.config');
}

function safeExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

/** Human-readable profile names from the browser's Local State, if present. */
function profileNames(root) {
  try {
    const cache = readJson(path.join(root, 'Local State'))?.profile?.info_cache || {};
    const out = {};
    for (const [dir, info] of Object.entries(cache)) if (info?.name) out[dir] = info.name;
    return out;
  } catch {
    return {};
  }
}

function countBookmarks(file) {
  try {
    const roots = readJson(file).roots || {};
    let n = 0;
    const walk = (node) => {
      if (!node) return;
      if (node.type === 'url') n += 1;
      for (const child of node.children || []) walk(child);
    };
    for (const key of ['bookmark_bar', 'other', 'synced']) walk(roots[key]);
    return n;
  } catch {
    return 0;
  }
}

/** Flatten a Chrome Bookmarks file into [{ url, title }], in document order. */
function parseBookmarks(file) {
  const roots = readJson(file).roots || {};
  const out = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'url' && typeof node.url === 'string' && /^(https?|file):/i.test(node.url)) {
      if (!seen.has(node.url)) {
        seen.add(node.url);
        out.push({ url: node.url, title: node.name || node.url });
      }
    }
    for (const child of node.children || []) walk(child);
  };
  for (const key of ['bookmark_bar', 'other', 'synced']) walk(roots[key]);
  return out;
}

// Chrome timestamps are microseconds since 1601-01-01 UTC.
const CHROME_EPOCH_OFFSET_MS = 11644473600000;
const chromeTimeToIso = (t) => {
  const ms = Number(t) / 1000 - CHROME_EPOCH_OFFSET_MS;
  return ms > 0 && Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
};

/**
 * Read a Chrome History DB. It is copied to a temp file first because the
 * source is usually locked while the other browser is running.
 * @returns {{url, title, visitedAt}[]} newest first, capped at `limit`
 */
function parseHistory(file, { limit = 5000, tmpDir } = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const scratch = tmpDir || os.tmpdir();
  fs.mkdirSync(scratch, { recursive: true });
  const copy = path.join(scratch, `history-import-${process.pid}-${Date.now()}.sqlite`);
  const copies = [copy];
  fs.copyFileSync(file, copy);
  // Bring the write-ahead log along so recent visits are included.
  for (const suffix of ['-wal', '-shm']) {
    if (safeExists(file + suffix)) {
      fs.copyFileSync(file + suffix, copy + suffix);
      copies.push(copy + suffix);
    }
  }
  let db;
  try {
    db = new DatabaseSync(copy, { readOnly: true });
    const stmt = db.prepare(
      `SELECT url, title, last_visit_time AS t
         FROM urls
         WHERE url LIKE 'http%'
         ORDER BY last_visit_time DESC
         LIMIT ?`,
    );
    // Chrome timestamps (microseconds since 1601) exceed Number.MAX_SAFE_INTEGER,
    // so node:sqlite must hand them back as BigInt rather than throwing.
    stmt.setReadBigInts(true);
    const rows = stmt.all(limit);
    return rows.map((r) => ({ url: r.url, title: r.title || r.url, visitedAt: chromeTimeToIso(r.t) }));
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    for (const f of copies) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

// Readable, missing, or blocked (macOS privacy controls, file permissions)?
// existsSync can't tell those apart: it reports "false" for both.
function fileStatus(file) {
  try {
    fs.closeSync(fs.openSync(file, 'r'));
    return { ok: true };
  } catch (err) {
    return { ok: false, denied: isMissing(err) ? null : err.code || 'EUNKNOWN' };
  }
}

const SKIP_PROFILES = new Set(['System Profile', 'Guest Profile']);

/** One profile folder as an import source, if it has Bookmarks or History. */
function profileAt(dir, browser, profile) {
  const bookmarksFile = path.join(dir, 'Bookmarks');
  const b = fileStatus(bookmarksFile);
  const h = fileStatus(path.join(dir, 'History'));
  if (!b.ok && !h.ok) return { denied: b.denied || h.denied };
  return {
    source: { id: dir, browser, profile, bookmarkCount: b.ok ? countBookmarks(bookmarksFile) : 0, hasHistory: h.ok },
  };
}

/** The profiles inside one browser's User Data folder, and why none were found. */
function profilesIn(root, browser) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return isMissing(err) ? { status: 'missing', sources: [] } : { status: 'denied', code: err.code, sources: [] };
  }
  const names = profileNames(root);
  const sources = [];
  let denied = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_PROFILES.has(entry.name)) continue;
    const found = profileAt(path.join(root, entry.name), browser, names[entry.name] || entry.name);
    if (found.source) sources.push(found.source);
    else if (found.denied) denied = found.denied;
  }
  if (sources.length) return { status: 'found', sources };
  if (denied) return { status: 'denied', code: denied, sources };
  return { status: 'empty', sources };
}

// Most-populated bookmark profiles first.
const byBookmarks = (list) => list.sort((a, b) => b.bookmarkCount - a.bookmarkCount);

/**
 * Look for every supported browser. `checked` records, per browser, whether
 * its folder was found, missing, empty, or blocked by the OS, so a search
 * that comes up empty can say why instead of just "nothing found".
 */
function scan(opts) {
  const sources = [];
  const checked = [];
  for (const { name, root } of candidateRoots(opts)) {
    const res = profilesIn(root, name);
    checked.push({ browser: name, root, status: res.status, code: res.code, profiles: res.sources.length });
    sources.push(...res.sources);
  }
  return { sources: byBookmarks(sources), checked };
}

/** List importable profiles across every installed Chromium browser. */
function listSources(opts) {
  return scan(opts).sources;
}

// Longest paths first so ".../Google/Chrome Beta" isn't taken for ".../Google/Chrome".
const KNOWN_PATHS = Object.values(BROWSERS)
  .flat()
  .map(([name, rel]) => [name, rel.toLowerCase()])
  .sort((a, b) => b[1].length - a[1].length);

function guessBrowser(dir) {
  const norm = dir.split(path.sep).join('/').toLowerCase();
  const hit = KNOWN_PATHS.find(([, rel]) => norm.includes(rel));
  return hit ? hit[0] : 'Chosen folder';
}

/**
 * Import sources in a folder the user picked by hand: a profile ("Default"),
 * a browser's own folder ("Chrome"), or the folder above that ("Google").
 */
function sourcesFromFolder(dir) {
  const label = guessBrowser(dir);
  const name = profileNames(path.dirname(dir))[path.basename(dir)] || path.basename(dir);
  const direct = profileAt(dir, label, name);
  if (direct.source) return { status: 'found', sources: [direct.source] };

  const asRoot = profilesIn(dir, label);
  if (asRoot.sources.length) return { status: 'found', sources: byBookmarks(asRoot.sources) };
  if (asRoot.status !== 'empty') return { status: asRoot.status, code: asRoot.code, sources: [] };

  const deeper = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    /* already readable above; ignore races */
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(dir, entry.name);
    deeper.push(...profilesIn(sub, guessBrowser(sub)).sources);
  }
  if (deeper.length) return { status: 'found', sources: byBookmarks(deeper) };
  return direct.denied ? { status: 'denied', code: direct.denied, sources: [] } : { status: 'empty', sources: [] };
}

/**
 * Import from one profile into the given stores.
 * @param {string} profileDir profile folder (a `source.id` from listSources)
 * @param {{bookmarks: import('./store').Bookmarks, history: import('./store').History}} stores
 * @param {{bookmarks?: boolean, history?: boolean, tmpDir?: string}} opts
 */
function importFrom(profileDir, stores, opts = {}) {
  const want = { bookmarks: opts.bookmarks !== false, history: opts.history !== false };
  const result = { bookmarksAdded: 0, historyAdded: 0, errors: [] };

  if (want.bookmarks) {
    const file = path.join(profileDir, 'Bookmarks');
    try {
      if (safeExists(file)) {
        for (const bm of parseBookmarks(file)) {
          if (!stores.bookmarks.has(bm.url)) {
            stores.bookmarks.add(bm);
            result.bookmarksAdded += 1;
          }
        }
      }
    } catch (err) {
      result.errors.push(`bookmarks: ${err.message}`);
    }
  }

  if (want.history) {
    const file = path.join(profileDir, 'History');
    try {
      if (safeExists(file)) {
        result.historyAdded = stores.history.import(parseHistory(file, { tmpDir: opts.tmpDir }));
      }
    } catch (err) {
      result.errors.push(`history: ${err.message}`);
    }
  }

  return result;
}

module.exports = {
  browserRoots,
  candidateRoots,
  defaultDataDir,
  listSources,
  scan,
  sourcesFromFolder,
  importFrom,
  parseBookmarks,
  parseHistory,
  chromeTimeToIso,
};
