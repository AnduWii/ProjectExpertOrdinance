'use strict';

/**
 * Local JSON persistence for bookmarks, history and settings.
 * Each store is a single human-readable JSON file in the app's userData
 * folder. Writes are atomic (temp file + rename) so a crash mid-write never
 * leaves a truncated file behind.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class JsonFile {
  constructor(filePath, defaults) {
    this.filePath = filePath;
    this.defaults = defaults;
  }

  read() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep the unreadable file for inspection instead of silently losing it.
        const backup = `${this.filePath}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this.filePath, backup);
        } catch {
          /* ignore */
        }
        console.warn(`[store] ${path.basename(this.filePath)} unreadable, moved to ${backup}`);
      }
      return structuredClone(this.defaults);
    }
  }

  write(data) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}

const isRecordable = (url) => /^(https?|file):/i.test(url || '');

class Bookmarks {
  constructor(dir) {
    this.file = new JsonFile(path.join(dir, 'bookmarks.json'), { version: 1, bookmarks: [] });
    this.data = this.file.read();
    if (!Array.isArray(this.data.bookmarks)) this.data = { version: 1, bookmarks: [] };
  }

  list() {
    return this.data.bookmarks.slice();
  }

  has(url) {
    return this.data.bookmarks.some((b) => b.url === url);
  }

  add({ url, title }) {
    if (!url || this.has(url)) return this.data.bookmarks.find((b) => b.url === url) || null;
    const bookmark = {
      id: crypto.randomUUID(),
      url,
      title: title || url,
      createdAt: new Date().toISOString(),
    };
    this.data.bookmarks.push(bookmark);
    this.file.write(this.data);
    return bookmark;
  }

  remove(idOrUrl) {
    const before = this.data.bookmarks.length;
    this.data.bookmarks = this.data.bookmarks.filter((b) => b.id !== idOrUrl && b.url !== idOrUrl);
    if (this.data.bookmarks.length !== before) this.file.write(this.data);
    return before !== this.data.bookmarks.length;
  }

  toggle({ url, title }) {
    if (this.has(url)) {
      this.remove(url);
      return false;
    }
    this.add({ url, title });
    return true;
  }
}

class History {
  constructor(dir, { maxEntries = 5000, flushDelayMs = 400 } = {}) {
    this.file = new JsonFile(path.join(dir, 'history.json'), { version: 1, entries: [] });
    this.data = this.file.read();
    if (!Array.isArray(this.data.entries)) this.data = { version: 1, entries: [] };
    this.maxEntries = maxEntries;
    this.flushDelayMs = flushDelayMs;
    this.timer = null;
  }

  /** Newest first. */
  list({ query = '', limit = 500 } = {}) {
    const q = query.trim().toLowerCase();
    const out = [];
    for (let i = this.data.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.data.entries[i];
      if (!q || e.url.toLowerCase().includes(q) || (e.title || '').toLowerCase().includes(q)) out.push(e);
    }
    return out;
  }

  add({ url, title }) {
    if (!isRecordable(url)) return null;
    const last = this.data.entries[this.data.entries.length - 1];
    // Collapse reloads / in-page re-navigations of the same URL.
    if (last && last.url === url) {
      last.visitedAt = new Date().toISOString();
      if (title) last.title = title;
      this.scheduleFlush();
      return last;
    }
    const entry = { id: crypto.randomUUID(), url, title: title || url, visitedAt: new Date().toISOString() };
    this.data.entries.push(entry);
    if (this.data.entries.length > this.maxEntries) {
      this.data.entries.splice(0, this.data.entries.length - this.maxEntries);
    }
    this.scheduleFlush();
    return entry;
  }

  updateTitle(url, title) {
    for (let i = this.data.entries.length - 1; i >= 0; i--) {
      if (this.data.entries[i].url === url) {
        this.data.entries[i].title = title;
        this.scheduleFlush();
        return;
      }
    }
  }

  remove(id) {
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter((e) => e.id !== id);
    if (before !== this.data.entries.length) this.flush();
  }

  clear() {
    this.data.entries = [];
    this.flush();
  }

  scheduleFlush() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.flushDelayMs);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    this.file.write(this.data);
  }
}

const DEFAULT_SETTINGS = {
  version: 2,
  homePage: 'https://www.google.com/',
  searchUrl: 'https://www.google.com/search?q=',
  // Absolute paths of unpacked extensions to load on every start.
  extensions: [],
  // Folders in <userData>/extensions that the user removed.
  ignoredExtensions: [],
};

const LEGACY_DEFAULTS = {
  homePage: 'https://duckduckgo.com/',
  searchUrl: 'https://duckduckgo.com/?q=',
};

class Settings {
  constructor(dir) {
    this.file = new JsonFile(path.join(dir, 'settings.json'), DEFAULT_SETTINGS);
    this.data = { ...DEFAULT_SETTINGS, ...this.file.read() };
    // Profiles from before Google became the default saved DuckDuckGo; upgrade
    // them (nothing in the UI let anyone choose DuckDuckGo deliberately).
    let migrated = false;
    for (const [key, oldDefault] of Object.entries(LEGACY_DEFAULTS)) {
      if (this.data[key] === oldDefault) {
        this.data[key] = DEFAULT_SETTINGS[key];
        migrated = true;
      }
    }
    if (migrated || this.data.version < DEFAULT_SETTINGS.version) {
      this.data.version = DEFAULT_SETTINGS.version;
      if (migrated) this.file.write(this.data);
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.file.write(this.data);
  }
}

module.exports = { Bookmarks, History, Settings, JsonFile, DEFAULT_SETTINGS };
