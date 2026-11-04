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

/** Known Chromium browsers and where each keeps its "User Data" root per OS. */
function browserRoots() {
  const home = os.homedir();
  const defs = {
    darwin: [
      ['Google Chrome', 'Library/Application Support/Google/Chrome'],
      ['Microsoft Edge', 'Library/Application Support/Microsoft Edge'],
      ['Brave', 'Library/Application Support/BraveSoftware/Brave-Browser'],
      ['Chromium', 'Library/Application Support/Chromium'],
      ['Vivaldi', 'Library/Application Support/Vivaldi'],
    ],
    win32: [
      ['Google Chrome', 'Google/Chrome/User Data'],
      ['Microsoft Edge', 'Microsoft/Edge/User Data'],
      ['Brave', 'BraveSoftware/Brave-Browser/User Data'],
      ['Chromium', 'Chromium/User Data'],
      ['Vivaldi', 'Vivaldi/User Data'],
    ],
    linux: [
      ['Google Chrome', '.config/google-chrome'],
      ['Chromium', '.config/chromium'],
      ['Brave', '.config/BraveSoftware/Brave-Browser'],
      ['Microsoft Edge', '.config/microsoft-edge'],
      ['Vivaldi', '.config/vivaldi'],
    ],
  };
  const list = defs[process.platform] || defs.linux;
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const base = process.platform === 'win32' ? localAppData : home;
  return list.map(([name, rel]) => ({ name, root: path.resolve(base, rel) })).filter((b) => safeExists(b.root));
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

/** List importable profiles across every installed Chromium browser. */
function listSources() {
  const sources = [];
  for (const { name, root } of browserRoots()) {
    const names = profileNames(root);
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const bookmarksFile = path.join(dir, 'Bookmarks');
      const historyFile = path.join(dir, 'History');
      const hasBookmarks = safeExists(bookmarksFile);
      const hasHistory = safeExists(historyFile);
      if (!hasBookmarks && !hasHistory) continue;
      sources.push({
        id: dir,
        browser: name,
        profile: names[entry.name] || entry.name,
        bookmarkCount: hasBookmarks ? countBookmarks(bookmarksFile) : 0,
        hasHistory,
      });
    }
  }
  // Most-populated bookmark profiles first.
  return sources.sort((a, b) => b.bookmarkCount - a.bookmarkCount);
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

module.exports = { browserRoots, listSources, importFrom, parseBookmarks, parseHistory, chromeTimeToIso };
