'use strict';

/**
 * Adds chrome.debugger, chrome.sidePanel, chrome.tabGroups, chrome.identity
 * and chrome.tabs.{group,ungroup,captureVisibleTab} to extension contexts.
 * The real work happens in src/main/compat/index.js.
 *
 * Ordering matters: electron-chrome-extensions' preload ends with
 * Object.freeze(chrome), so this preload must be registered first
 * (ExtensionCompat.registerPreloads() runs before that library is created).
 * Web pages never get these APIs: the script exits unless it runs in an
 * extension service worker or a chrome-extension:// document.
 */

const { contextBridge, ipcRenderer } = require('electron');

function installCompat() {
  const bridge = globalThis.__ordinanceCompat;
  try {
    delete globalThis.__ordinanceCompat;
  } catch {
    /* non-configurable in some contexts */
  }
  const chrome = globalThis.chrome;
  if (!bridge || !chrome || !chrome.runtime || !chrome.runtime.id) return;

  const manifest = (chrome.runtime.getManifest && chrome.runtime.getManifest()) || {};
  const permissions = new Set([...(manifest.permissions || []), ...(manifest.optional_permissions || [])]);

  // ---- events: main process -> this context
  const handlers = new Map();
  bridge.subscribe((eventName, args) => {
    const set = handlers.get(eventName);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`Error in ${eventName} listener:`, err);
      }
    }
  });

  class CompatEvent {
    constructor(name) {
      this.name = name;
    }
    addListener(fn) {
      if (typeof fn !== 'function') return;
      let set = handlers.get(this.name);
      if (!set) {
        handlers.set(this.name, (set = new Set()));
        bridge.listen(this.name, true);
      }
      set.add(fn);
    }
    removeListener(fn) {
      const set = handlers.get(this.name);
      if (set) set.delete(fn);
    }
    hasListener(fn) {
      const set = handlers.get(this.name);
      return !!(set && set.has(fn));
    }
    hasListeners() {
      const set = handlers.get(this.name);
      return !!(set && set.size);
    }
  }

  // ---- calls: this context -> main process (promise and callback styles)
  const withLastError = (message, cb) => {
    const runtime = chrome.runtime;
    let set = false;
    try {
      Object.defineProperty(runtime, 'lastError', { value: { message }, configurable: true });
      set = true;
    } catch {
      console.error(`Unchecked runtime.lastError: ${message}`);
    }
    try {
      cb();
    } finally {
      if (set) {
        try {
          delete runtime.lastError;
        } catch {
          /* ignore */
        }
      }
    }
  };

  const api = (method) =>
    function compatApi(...args) {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      const promise = bridge.call(method, args).then((res) => {
        if (res && typeof res.error === 'string') throw new Error(res.error);
        return res && res.result !== null ? res.result : undefined;
      });
      if (!cb) return promise;
      promise.then(
        (value) => cb(value),
        (err) => withLastError(err.message, () => cb()),
      );
      return undefined;
    };

  const define = (name, value) => {
    if (chrome[name] !== undefined) return; // never replace a real implementation
    try {
      Object.defineProperty(chrome, name, { value, enumerable: true, configurable: true, writable: true });
    } catch (err) {
      console.warn(`[compat] cannot add chrome.${name}: ${err.message}`);
    }
  };

  if (permissions.has('debugger')) {
    define('debugger', {
      attach: api('debugger.attach'),
      detach: api('debugger.detach'),
      sendCommand: api('debugger.sendCommand'),
      getTargets: api('debugger.getTargets'),
      onEvent: new CompatEvent('debugger.onEvent'),
      onDetach: new CompatEvent('debugger.onDetach'),
      DetachReason: { CANCELED_BY_USER: 'canceled_by_user', TARGET_CLOSED: 'target_closed' },
      TargetInfoType: { PAGE: 'page', BACKGROUND_PAGE: 'background_page', WORKER: 'worker', OTHER: 'other' },
    });
  }

  if (permissions.has('sidePanel')) {
    define('sidePanel', {
      setOptions: api('sidePanel.setOptions'),
      getOptions: api('sidePanel.getOptions'),
      setPanelBehavior: api('sidePanel.setPanelBehavior'),
      getPanelBehavior: api('sidePanel.getPanelBehavior'),
      open: api('sidePanel.open'),
      close: api('sidePanel.close'),
      onOpened: new CompatEvent('sidePanel.onOpened'),
      onClosed: new CompatEvent('sidePanel.onClosed'),
    });
  }

  if (permissions.has('tabGroups')) {
    define('tabGroups', {
      TAB_GROUP_ID_NONE: -1,
      Color: {
        GREY: 'grey',
        BLUE: 'blue',
        RED: 'red',
        YELLOW: 'yellow',
        GREEN: 'green',
        PINK: 'pink',
        PURPLE: 'purple',
        CYAN: 'cyan',
        ORANGE: 'orange',
      },
      get: api('tabGroups.get'),
      query: api('tabGroups.query'),
      update: api('tabGroups.update'),
      move: api('tabGroups.move'),
      onCreated: new CompatEvent('tabGroups.onCreated'),
      onUpdated: new CompatEvent('tabGroups.onUpdated'),
      onRemoved: new CompatEvent('tabGroups.onRemoved'),
      onMoved: new CompatEvent('tabGroups.onMoved'),
    });
  }

  if (permissions.has('identity')) {
    define('identity', {
      getRedirectURL: (p = '') => `https://${chrome.runtime.id}.chromiumapp.org/${String(p).replace(/^\//, '')}`,
      launchWebAuthFlow: api('identity.launchWebAuthFlow'),
    });
  }

  const tabExtras = {
    group: api('tabs.group'),
    ungroup: api('tabs.ungroup'),
    captureVisibleTab: api('tabs.captureVisibleTab'),
  };
  const tabs = chrome.tabs;
  if (tabs) {
    for (const [name, fn] of Object.entries(tabExtras)) {
      if (tabs[name] !== undefined) continue;
      try {
        Object.defineProperty(tabs, name, { value: fn, enumerable: true, configurable: true, writable: true });
      } catch (err) {
        console.warn(`[compat] cannot add chrome.tabs.${name}: ${err.message}`);
      }
    }
  }
}

const isWorker = process.type === 'service-worker';
const isExtensionPage = !isWorker && typeof location !== 'undefined' && location.protocol === 'chrome-extension:';

if (isWorker || isExtensionPage) {
  try {
    contextBridge.exposeInMainWorld('__ordinanceCompat', {
      call: (method, args) => ipcRenderer.invoke('ordx:call', method, args),
      listen: (eventName, add) => ipcRenderer.send('ordx:listen', eventName, add),
      subscribe: (callback) => {
        ipcRenderer.on('ordx:event', (_event, eventName, args) => callback(eventName, args));
      },
    });
    contextBridge.executeInMainWorld({ func: installCompat });
  } catch (err) {
    console.error('[compat] failed to install extension API shims', err);
  }
}
