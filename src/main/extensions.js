'use strict';

/**
 * Loads unpacked Chrome extensions into the browser session and remembers
 * them across restarts (Electron itself forgets loaded extensions on exit).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const { unsupportedPermissions } = require('./extension-support');

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

/** Resolve "__MSG_name__" placeholders using the extension's default locale. */
function localize(dir, manifest, value) {
  const m = /^__MSG_(\w+)__$/.exec(value || '');
  if (!m || !manifest.default_locale) return value;
  try {
    const messages = readJson(path.join(dir, '_locales', manifest.default_locale, 'messages.json'));
    const key = Object.keys(messages).find((k) => k.toLowerCase() === m[1].toLowerCase());
    return key ? messages[key].message : value;
  } catch {
    return value;
  }
}

function pickIcon(manifest) {
  const action = manifest.action || manifest.browser_action || {};
  const candidates = [action.default_icon, manifest.icons].filter(Boolean);
  for (const c of candidates) {
    if (typeof c === 'string') return c;
    const sizes = Object.keys(c).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sizes.length) continue;
    const size = sizes.find((s) => s >= 32) ?? sizes[sizes.length - 1];
    return c[String(size)];
  }
  return null;
}

class ExtensionManager extends EventEmitter {
  /**
   * @param {{session: Electron.Session, settings: import('./store').Settings, userDataDir: string}} opts
   */
  constructor({ session, settings, userDataDir }) {
    super();
    this.session = session;
    this.settings = settings;
    this.userDataDir = userDataDir;
    this.sources = new Map(); // extension id -> folder the user picked
    this.iconCache = new Map();
    this.loadErrors = [];
  }

  /**
   * Electron 36 moved extension methods to `session.extensions`;
   * `session.loadExtension` still exists but is deprecated.
   */
  get api() {
    return this.session.extensions || this.session;
  }

  validate(dir) {
    const source = path.resolve(dir);
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
      throw new Error(`Not a folder: ${source}`);
    }
    const manifestPath = path.join(source, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error(`No manifest.json in ${source}`);
    let manifest;
    try {
      manifest = readJson(manifestPath);
    } catch (err) {
      throw new Error(`manifest.json is not valid JSON: ${err.message}`);
    }
    if (![2, 3].includes(manifest.manifest_version)) {
      throw new Error(`Unsupported manifest_version ${manifest.manifest_version}`);
    }
    return { source, manifest };
  }

  /**
   * Extensions copied out of a Chrome profile (or unzipped from a .crx) carry
   * a `_metadata` folder. Chromium refuses to load unpacked extensions with
   * reserved "_"-prefixed entries, so load a cached copy without it. The
   * manifest (and its "key", which fixes the extension ID) is kept intact.
   */
  prepare(source) {
    if (!fs.existsSync(path.join(source, '_metadata'))) return source;
    const hash = crypto.createHash('sha1').update(source).digest('hex').slice(0, 12);
    const target = path.join(this.userDataDir, 'extension-cache', `${path.basename(source)}-${hash}`);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, {
      recursive: true,
      filter: (src) => path.relative(source, src).split(path.sep)[0] !== '_metadata',
    });
    return target;
  }

  async load(dir, { persist = true } = {}) {
    const { source, manifest } = this.validate(dir);
    const loadPath = this.prepare(source);
    const existing = this.api.getAllExtensions().find((e) => e.path === loadPath);
    if (existing) this.api.removeExtension(existing.id);

    const ext = await this.api.loadExtension(loadPath, { allowFileAccess: true });
    this.sources.set(ext.id, source);
    this.iconCache.delete(ext.id);
    if (persist) {
      const saved = new Set(this.settings.get('extensions') || []);
      saved.add(source);
      this.settings.set('extensions', [...saved]);
    }
    this.emit('changed');
    return this.describe(ext, manifest);
  }

  /** Load every extension saved in settings plus folders in <userData>/extensions. */
  async loadSaved() {
    const saved = this.settings.get('extensions') || [];
    const dropIn = path.join(this.userDataDir, 'extensions');
    const auto = fs.existsSync(dropIn)
      ? fs
          .readdirSync(dropIn, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => path.join(dropIn, d.name))
          .filter((d) => fs.existsSync(path.join(d, 'manifest.json')))
      : [];
    this.loadErrors = [];
    for (const dir of [...new Set([...saved, ...auto])]) {
      try {
        await this.load(dir, { persist: false });
      } catch (err) {
        this.loadErrors.push({ path: dir, error: err.message });
        console.warn(`[extensions] failed to load ${dir}: ${err.message}`);
      }
    }
    return this.list();
  }

  remove(id) {
    const ext = this.api.getExtension(id);
    if (!ext) return false;
    this.api.removeExtension(id);
    const source = this.sources.get(id) || ext.path;
    this.sources.delete(id);
    this.iconCache.delete(id);
    const saved = (this.settings.get('extensions') || []).filter((p) => p !== source && p !== ext.path);
    this.settings.set('extensions', saved);
    this.emit('removed', id);
    this.emit('changed');
    return true;
  }

  get(id) {
    return this.api.getExtension(id) || null;
  }

  list() {
    return this.api.getAllExtensions().map((ext) => this.describe(ext));
  }

  iconDataUrl(ext, manifest) {
    if (this.iconCache.has(ext.id)) return this.iconCache.get(ext.id);
    let url = null;
    const rel = pickIcon(manifest);
    if (rel) {
      try {
        const file = path.join(ext.path, rel.replace(/^\//, ''));
        const mime = IMAGE_MIME[path.extname(file).toLowerCase()];
        if (mime) url = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
      } catch {
        /* no icon */
      }
    }
    this.iconCache.set(ext.id, url);
    return url;
  }

  describe(ext, manifestOverride) {
    const manifest = manifestOverride || ext.manifest || {};
    const action = manifest.action || manifest.browser_action;
    return {
      id: ext.id,
      name: localize(ext.path, manifest, ext.name || manifest.name),
      version: ext.version || manifest.version,
      path: this.sources.get(ext.id) || ext.path,
      manifestVersion: manifest.manifest_version,
      icon: this.iconDataUrl(ext, manifest),
      hasAction: !!action,
      hasPopup: !!action?.default_popup,
      hasSidePanel: !!manifest.side_panel?.default_path,
      unsupported: unsupportedPermissions(manifest),
    };
  }
}

module.exports = { ExtensionManager, localize, pickIcon };
