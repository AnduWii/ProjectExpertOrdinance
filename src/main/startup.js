'use strict';

/**
 * Start-up safety net. The browser must always open a window: a slow or
 * broken extension, an unreadable profile file or an unexpected exception
 * should never leave a windowless process holding the single-instance lock
 * (after which every launch quits silently and the app "won't open").
 *
 *   - Log: every warning/error and every uncaught exception goes to
 *     <userData>/logs/main.log, so a failed start can be diagnosed.
 *   - Time limit: extension loading gets a few seconds; after that the
 *     window opens and extensions finish loading in the background.
 *   - Safe mode: if the previous start never got a window on screen, this
 *     start skips extensions (or run with --safe-mode).
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 1024 * 1024;

/** Mirror console.warn/error (and uncaught errors) into a log file. */
function installLog(dir, { console: con = console } = {}) {
  const file = path.join(dir, 'logs', 'main.log');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.old`);
  } catch {
    /* logging is best effort */
  }
  const write = (level, args) => {
    const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : safeJson(a))).join(' ');
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`);
    } catch {
      /* disk full or read-only: nothing useful to do */
    }
  };
  for (const level of ['warn', 'error']) {
    const original = con[level].bind(con);
    con[level] = (...args) => {
      write(level.toUpperCase(), args);
      original(...args);
    };
  }
  return { file, write: (...args) => write('INFO', args) };
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Resolve with the promise's value, or with `fallback` after `ms`. Never rejects. */
function withTimeout(promise, ms, { label = 'task', fallback = undefined, log = console.warn } = {}) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      log(`[startup] ${label} is taking longer than ${ms} ms; continuing without waiting`);
      resolve(fallback);
    }, ms);
  });
  const guarded = Promise.resolve()
    .then(() => promise)
    .catch((err) => {
      log(`[startup] ${label} failed: ${err?.stack || err}`);
      return fallback;
    });
  return Promise.race([guarded, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Marker file that exists only while a start is in progress. Finding it at
 * launch means the last start never reached a visible window.
 */
class StartupGuard {
  constructor(dir) {
    this.file = path.join(dir, 'startup-in-progress');
    this.previousFailed = false;
  }

  begin() {
    try {
      this.previousFailed = fs.existsSync(this.file);
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${process.pid} ${new Date().toISOString()}\n`);
    } catch {
      this.previousFailed = false;
    }
    return this.previousFailed;
  }

  succeeded() {
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      /* ignore */
    }
  }
}

module.exports = { installLog, withTimeout, StartupGuard };
