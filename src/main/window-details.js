'use strict';

/**
 * Make chrome.windows report each window's tabs the way Chrome does.
 *
 * electron-chrome-extensions 4.10.0 (the latest release) builds a window's
 * `tabs` list only from tabs whose details were already cached by an earlier
 * chrome.tabs call, and then caches that window object until the window
 * closes. A window made by chrome.windows.create therefore comes back with
 * `tabs: []`, and so does every later windows.get/getAll for it. Extension
 * code written for Chrome reads `win.tabs[0].id` and throws
 * "Cannot read properties of undefined (reading 'id')", which is how Claude in
 * Chrome's tabs_context_mcp (createIfEmpty) failed in Chrome2.
 *
 * This replaces the library's window-details builder on its WindowsAPI
 * instance: tabs are listed fresh on every call, in tab-strip order, each
 * with its real index and the same details chrome.tabs reports for it. The
 * library's own handlers call these methods through `this`, so the instance
 * properties take over without patching node_modules.
 */

/**
 * @param {object} windowsApi electron-chrome-extensions' WindowsAPI instance (crx.api.windows)
 * @param {object} tabsApi    its TabsAPI instance (crx.api.tabs)
 * @param {(win: Electron.BrowserWindow) => Electron.WebContents[] | null} orderedTabs
 *   the window's tabs in strip order, or null for a window the browser doesn't
 *   manage (popups, sign-in windows), which then falls back to the library's own
 *   tab-to-window mapping
 * @returns {boolean} false when the library no longer has the internals this
 *   relies on (it is pinned to an exact version for that reason, and e2e test
 *   12 fails if the fix is missing)
 */
function installWindowDetailsFix(windowsApi, tabsApi, orderedTabs) {
  const store = windowsApi && windowsApi.ctx && windowsApi.ctx.store;
  if (
    !store ||
    !(store.tabDetailsCache instanceof Map) ||
    !(store.tabs instanceof Set) ||
    !(store.tabToWindow instanceof WeakMap) ||
    typeof windowsApi.createWindowDetails !== 'function' ||
    !tabsApi ||
    typeof tabsApi.createTabDetails !== 'function'
  ) {
    return false;
  }
  const build = windowsApi.createWindowDetails.bind(windowsApi);
  const cache = store.tabDetailsCache;

  const tabsOf = (win) => {
    const ordered = orderedTabs(win);
    if (ordered) return ordered;
    return [...store.tabs].filter((tab) => {
      const owner = store.tabToWindow.get(tab);
      return owner && !owner.isDestroyed() && owner.id === win.id;
    });
  };

  // The tab as chrome.tabs reports it. A tab chrome.tabs hasn't reported yet
  // is described fresh but NOT cached: a window can be announced before its
  // first tab is marked active, and a cached copy made then would keep
  // `active: false` (the library only refreshes it on the next page update).
  const tabDetails = (wc) => {
    if (cache.has(wc.id)) return cache.get(wc.id);
    const details = tabsApi.createTabDetails(wc);
    cache.delete(wc.id);
    return details;
  };

  windowsApi.createWindowDetails = (win) => {
    const details = build(win);
    details.tabs = tabsOf(win)
      .filter((wc) => wc && !wc.isDestroyed())
      .map((wc, index) => ({ ...tabDetails(wc), index, windowId: win.id }));
    return details;
  };
  // Never serve a stale snapshot (the library keeps one until the window closes).
  windowsApi.getWindowDetails = (win) => windowsApi.createWindowDetails(win);
  return true;
}

module.exports = { installWindowDetailsFix };
