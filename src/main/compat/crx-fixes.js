'use strict';

/**
 * Two defects in electron-chrome-extensions 4.10.0 break agent-style
 * extensions (Claude in Chrome among them). Both are corrected from the
 * outside: no file under node_modules is modified, and no extension is
 * repackaged.
 *
 * 1. `chrome.windows.*` always reports `tabs: []`.
 *
 *    ExtensionStore.addTab() registers the owning window *before* it emits
 *    'tab-added':
 *
 *      addTab(tab, window) {
 *        this.tabs.add(tab); this.tabToWindow.set(tab, window);
 *        this.addWindow(window);      // -> WindowsAPI.observeWindow -> onCreated
 *        this.emit('tab-added', tab); // -> TabsAPI.observeTab -> caches tab details
 *      }
 *
 *    addWindow() makes WindowsAPI build the window's details, and those are
 *    assembled by reading `store.tabDetailsCache` for each tab in the window:
 *
 *      tabs: [...].map((tab) => this.ctx.store.tabDetailsCache.get(tab.id)).filter(Boolean)
 *
 *    At that instant no tab has been cached yet, so every lookup is undefined,
 *    `.filter(Boolean)` empties the array, and the result is written to
 *    `store.windowDetailsCache`. getWindowDetails() returns that cached object
 *    forever — nothing invalidates it when tabs appear. So
 *
 *      const win = await chrome.windows.create({ url });
 *      win.tabs[0].id
 *
 *    throws "Cannot read properties of undefined (reading 'id')".
 *
 *    Fix: drop the cached window details whenever tab details are built or a
 *    tab goes away. getWindowDetails() then recomputes from a populated cache.
 *
 * 2. `chrome.tabs.query` ignores `lastFocusedWindow` and `currentWindow`.
 *
 *    TabsAPI.query() only understands `windowId`, so the standard
 *    `{ active: true, lastFocusedWindow: true }` returns the active tab of
 *    *every* window rather than one tab.
 *
 *    Fix: translate those flags to `windowId: -2` (WINDOW_ID_CURRENT), which
 *    the library already compares against its last-focused window.
 *
 * Each patch feature-detects the internals it needs and reports whether it
 * applied, so a library upgrade that changes shape degrades to current
 * behaviour instead of breaking start-up.
 */

const WINDOW_ID_CURRENT = -2;

/** The library's internal store, only if it looks the way these fixes expect. */
function storeOf(crx) {
  const store = crx && crx.ctx && crx.ctx.store;
  return store && store.windowDetailsCache instanceof Map ? store : null;
}

/**
 * Forget cached `chrome.windows` details so the next read is rebuilt from the
 * current tabs. Clearing every entry (rather than one window's) keeps this
 * independent of the library's tab->window bookkeeping; the cache holds one
 * small object per browser window and is rebuilt on demand.
 *
 * @returns {boolean} true when the cache was reachable and cleared
 */
function invalidateWindowDetails(crx) {
  const store = storeOf(crx);
  if (!store) return false;
  store.windowDetailsCache.clear();
  return true;
}

/**
 * Make `chrome.tabs.query` honour `lastFocusedWindow` / `currentWindow` by
 * rewriting them to the `windowId` sentinel the library already handles.
 *
 * @returns {boolean} true when the handler was wrapped (or already wrapped)
 */
function patchTabsQuery(crx) {
  const router = crx && crx.ctx && crx.ctx.router;
  const handlers = router && router.handlers;
  if (!handlers || typeof handlers.get !== 'function' || typeof router.handle !== 'function') return false;

  const original = handlers.get('tabs.query');
  if (!original || typeof original.callback !== 'function') return false;
  if (original.ordinanceWindowScoped) return true;

  const inner = original.callback;
  const callback = (event, info, ...rest) => {
    const query = { ...(info || {}) };
    const scoped = query.lastFocusedWindow === true || query.currentWindow === true;
    // Unknown keys are ignored by the library; drop them either way so the
    // filter never sees a flag it silently skips.
    delete query.lastFocusedWindow;
    delete query.currentWindow;
    if (scoped && query.windowId === undefined) query.windowId = WINDOW_ID_CURRENT;
    return inner(event, query, ...rest);
  };

  router.handle('tabs.query', callback, {
    extensionContext: original.extensionContext,
    allowRemote: original.allowRemote,
    permission: original.permission,
  });
  const installed = handlers.get('tabs.query');
  if (installed) installed.ordinanceWindowScoped = true;
  return true;
}

/**
 * Apply every fix to a freshly constructed ElectronChromeExtensions instance.
 * Never throws: a fix that cannot be applied is reported and skipped.
 *
 * @returns {{tabsQuery: boolean, windowDetails: boolean}}
 */
function applyCrxFixes(crx) {
  const applied = { tabsQuery: false, windowDetails: !!storeOf(crx) };

  try {
    applied.tabsQuery = patchTabsQuery(crx);
  } catch (err) {
    console.warn(`[compat] could not scope chrome.tabs.query to the focused window: ${err.message}`);
  }

  if (!applied.tabsQuery) {
    console.warn('[compat] chrome.tabs.query will ignore lastFocusedWindow/currentWindow (extension library changed shape)');
  }
  if (!applied.windowDetails) {
    console.warn('[compat] chrome.windows.* may report empty tab lists (extension library changed shape)');
  }
  return applied;
}

module.exports = { applyCrxFixes, invalidateWindowDetails, patchTabsQuery, WINDOW_ID_CURRENT };
