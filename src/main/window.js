'use strict';

/**
 * One browser window: the HTML toolbar UI (the BrowserWindow's own
 * webContents) plus one WebContentsView per tab, and an optional extension
 * side panel docked on the right.
 */

const path = require('node:path');
const EventEmitter = require('node:events');
const { BrowserWindow, WebContentsView, Menu, clipboard } = require('electron');
const { normalizeInput } = require('./url');

const SIDE_PANEL_WIDTH = 400;
const SIDE_PANEL_HEADER = 34;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CANT_REACH = "Can't reach this page";
const CRASHED = 'This page crashed';

function errorPage(heading, url, detail) {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(heading)}</title>
<style>body{font:15px system-ui,sans-serif;margin:12vh auto;max-width:560px;padding:0 24px;color:#333}
h1{font-size:22px}code{background:#f2f2f2;padding:2px 6px;border-radius:4px;word-break:break-all}</style>
<h1>${escapeHtml(heading)}</h1><p><code>${escapeHtml(url)}</code></p>
<p>${escapeHtml(detail)}</p>`;
}

const tabWebPreferences = (session) => ({
  session,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  // Lets the extension-API preloads run inside chrome-extension:// iframes
  // that extensions embed in pages. Sandboxed, so no Node access is granted.
  nodeIntegrationInSubFrames: true,
});

class BrowserWindowController extends EventEmitter {
  /**
   * @param {object} ctx shared app context (see main.js)
   * @param {{urls?: string[]}} [options]
   */
  constructor(ctx, { urls = [] } = {}) {
    super();
    this.ctx = ctx;
    this.tabs = new Map();
    this.order = [];
    this.activeId = null;
    this.insets = { top: 84, right: 0 };
    this.sidePanel = null;
    this.fullscreenTabId = null; // tab whose page is in HTML (video) fullscreen
    this.exitWindowFullscreen = false;
    this.statePending = false;
    this.destroyed = false;

    this.win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 560,
      minHeight: 360,
      title: 'Ordinance Browser',
      show: false,
      backgroundColor: '#eef0f3',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'ui-preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.ui = this.win.webContents;
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    this.win.once('ready-to-show', () => this.win.show());
    for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) {
      this.win.on(ev, () => this.layout());
    }
    this.win.on('closed', () => this.destroy());

    const initial = urls.length ? urls : [ctx.getHomePage()];
    initial.forEach((url, i) => this.createTab({ url, active: i === 0 }));
  }

  // ---------------------------------------------------------------- tabs

  get activeTab() {
    return this.tabs.get(this.activeId) || null;
  }

  createTab({ url, active = true, index, openerId } = {}) {
    const view = new WebContentsView({ webPreferences: tabWebPreferences(this.ctx.session) });
    view.setBackgroundColor('#ffffffff');
    const wc = view.webContents;
    const tab = { id: wc.id, view, wc, title: 'New Tab', url: url || '', favicon: null, loading: false, errorFor: null };
    this.tabs.set(tab.id, tab);

    let pos = this.order.length;
    if (Number.isInteger(index)) pos = Math.max(0, Math.min(index, this.order.length));
    else if (openerId != null && this.order.includes(openerId)) pos = this.order.indexOf(openerId) + 1;
    this.order.splice(pos, 0, tab.id);

    this.wireTab(tab);
    this.ctx.crx?.addTab(wc, this.win);
    if (url) this.load(tab, url);
    if (active || this.activeId == null) this.activateTab(tab.id);
    else this.emitState();
    return tab;
  }

  wireTab(tab) {
    const { wc } = tab;
    const update = () => this.emitState();

    wc.on('did-start-loading', () => {
      tab.loading = true;
      update();
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      update();
    });
    wc.on('did-navigate', (_e, url) => this.onNavigated(tab, url, true));
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) this.onNavigated(tab, url, false);
    });
    wc.on('page-title-updated', (_e, title) => {
      if (tab.errorFor) return;
      tab.title = title;
      this.ctx.history.updateTitle(tab.url, title);
      update();
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons?.[0] || null;
      update();
    });
    wc.on('did-fail-load', (_e, code, description, validatedURL, isMainFrame) => {
      // -3 is ERR_ABORTED: user stopped, or a download/redirect replaced it.
      if (!isMainFrame || code === -3) return;
      this.showErrorPage(tab, validatedURL, CANT_REACH, `${description} (${code})`);
    });
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      if (this.fullscreenTabId === tab.id) this.setPageFullscreen(tab, false);
      const url = tab.errorFor || tab.url;
      const detail = `Reason: ${details.reason}. Reload to try again.`;
      // The next navigation starts a fresh renderer. Chromium may still be
      // tearing the dead one down, so retry while the tab reports crashed.
      let attempts = 0;
      const show = () => {
        if (wc.isDestroyed()) return;
        attempts += 1;
        this.showErrorPage(tab, url, CRASHED, detail);
        setTimeout(() => {
          if (!wc.isDestroyed() && wc.isCrashed() && attempts < 5) show();
        }, 1000);
      };
      setTimeout(show, 50);
    });

    // Video/HTML fullscreen: the page takes the whole window, toolbar hidden.
    wc.on('enter-html-full-screen', () => this.setPageFullscreen(tab, true));
    wc.on('leave-html-full-screen', () => this.setPageFullscreen(tab, false));
    wc.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && this.fullscreenTabId === tab.id) {
        wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
      }
    });

    wc.setWindowOpenHandler(({ url, disposition }) => {
      // Real popups (window.open with features) stay popups so OAuth flows
      // that rely on window.opener keep working; everything else is a tab.
      if (disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { width: 520, height: 680, webPreferences: tabWebPreferences(this.ctx.session) },
        };
      }
      this.createTab({ url, active: disposition !== 'background-tab', openerId: tab.id });
      return { action: 'deny' };
    });

    wc.on('context-menu', (_e, params) => this.showContextMenu(tab, params));
    wc.on('destroyed', () => {
      if (this.tabs.has(tab.id)) this.closeTab(tab.id);
    });
  }

  showErrorPage(tab, url, heading, detail) {
    tab.errorFor = url;
    tab.url = url;
    tab.title = heading;
    tab.wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorPage(heading, url, detail))).catch(() => {});
    this.emitState();
  }

  setPageFullscreen(tab, on) {
    if (on) {
      this.fullscreenTabId = tab.id;
      if (!this.win.isFullScreen()) {
        this.exitWindowFullscreen = true;
        this.win.setFullScreen(true);
      }
    } else if (this.fullscreenTabId === tab.id) {
      this.fullscreenTabId = null;
      if (this.exitWindowFullscreen && !this.win.isDestroyed()) this.win.setFullScreen(false);
      this.exitWindowFullscreen = false;
    }
    this.layout();
  }

  onNavigated(tab, url, fullNavigation) {
    if (url.startsWith('data:text/html') && tab.errorFor) return; // our error page
    tab.errorFor = null;
    tab.url = url;
    if (fullNavigation) tab.favicon = null;
    this.ctx.history.add({ url, title: tab.wc.getTitle() });
    this.emitState();
  }

  load(tab, url) {
    tab.url = url;
    tab.wc.loadURL(url).catch(() => {
      /* surfaced through did-fail-load */
    });
  }

  navigate(input, tabId = this.activeId) {
    const tab = this.tabs.get(tabId);
    const url = normalizeInput(input, this.ctx.settings.get('searchUrl'));
    if (!tab || !url) return null;
    this.load(tab, url);
    tab.wc.focus();
    this.emitState();
    return url;
  }

  activateTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const prev = this.activeTab;
    if (prev && prev !== tab) {
      if (this.fullscreenTabId === prev.id) {
        prev.wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
        this.setPageFullscreen(prev, false);
      }
      this.win.contentView.removeChildView(prev.view);
    }
    this.activeId = id;
    this.win.contentView.addChildView(tab.view);
    this.layout();
    this.ctx.crx?.selectTab(tab.wc);
    this.emitState();
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const idx = this.order.indexOf(id);
    this.order.splice(idx, 1);
    this.tabs.delete(id);
    const wasActive = this.activeId === id;
    if (this.fullscreenTabId === id) this.setPageFullscreen(tab, false);
    if (wasActive) {
      this.win.contentView.removeChildView(tab.view);
      this.activeId = null;
    }
    this.ctx.onTabClosed?.(tab, this);
    try {
      this.ctx.crx?.removeTab(tab.wc);
    } catch {
      /* already untracked */
    }
    if (!tab.wc.isDestroyed()) tab.wc.close();

    if (this.order.length === 0) {
      if (!this.win.isDestroyed()) this.win.close();
      return;
    }
    if (wasActive) this.activateTab(this.order[idx] ?? this.order[idx - 1]);
    else this.emitState();
  }

  moveTab(id, toIndex) {
    const from = this.order.indexOf(id);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(Number(toIndex), this.order.length - 1));
    if (from === to) return false;
    this.order.splice(from, 1);
    this.order.splice(to, 0, id);
    this.emitState();
    return true;
  }

  cycleTab(delta) {
    if (!this.order.length) return;
    const i = this.order.indexOf(this.activeId);
    this.activateTab(this.order[(i + delta + this.order.length) % this.order.length]);
  }

  // ---------------------------------------------------------- navigation

  goBack() {
    const h = this.activeTab?.wc.navigationHistory;
    if (h?.canGoBack()) h.goBack();
  }

  goForward() {
    const h = this.activeTab?.wc.navigationHistory;
    if (h?.canGoForward()) h.goForward();
  }

  reload() {
    const tab = this.activeTab;
    if (!tab) return;
    if (tab.errorFor) this.load(tab, tab.errorFor);
    else tab.wc.reload();
  }

  stop() {
    this.activeTab?.wc.stop();
  }

  goHome() {
    const tab = this.activeTab;
    if (tab) this.load(tab, this.ctx.getHomePage());
  }

  // ----------------------------------------------------------- side panel

  openSidePanel({ extensionId, url, title }) {
    if (this.sidePanel?.extensionId === extensionId) {
      if (this.sidePanel.url !== url) {
        this.sidePanel.url = url;
        this.sidePanel.view.webContents.loadURL(url).catch(() => {});
      }
      return;
    }
    this.closeSidePanel();
    const view = new WebContentsView({ webPreferences: tabWebPreferences(this.ctx.session) });
    view.setBackgroundColor('#ffffffff');
    this.win.contentView.addChildView(view);
    this.sidePanel = { extensionId, url, title, view };
    view.webContents.loadURL(url).catch(() => {});
    this.layout();
    this.emitLayout();
    this.emit('side-panel-opened', extensionId);
  }

  closeSidePanel() {
    const panel = this.sidePanel;
    if (!panel) return;
    this.sidePanel = null;
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(panel.view);
    if (!panel.view.webContents.isDestroyed()) panel.view.webContents.close();
    this.layout();
    this.emitLayout();
    this.emit('side-panel-closed', panel.extensionId);
  }

  // --------------------------------------------------------------- layout

  setInsets({ top, right }) {
    if (Number.isFinite(top)) this.insets.top = Math.max(0, Math.round(top));
    if (Number.isFinite(right)) this.insets.right = Math.max(0, Math.round(right));
    this.layout();
  }

  layout() {
    if (this.win.isDestroyed()) return;
    const [w, h] = this.win.getContentSize();
    const tab = this.activeTab;
    const fullscreen = !!tab && this.fullscreenTabId === tab.id;
    if (this.sidePanel) this.sidePanel.view.setVisible(!fullscreen);
    if (fullscreen) {
      tab.view.setBounds({ x: 0, y: 0, width: w, height: h });
      return;
    }
    const { top, right } = this.insets;
    const side = this.sidePanel ? SIDE_PANEL_WIDTH : 0;
    if (tab) {
      tab.view.setBounds({ x: 0, y: top, width: Math.max(0, w - side - right), height: Math.max(0, h - top) });
    }
    if (this.sidePanel) {
      this.sidePanel.view.setBounds({
        x: w - side,
        y: top + SIDE_PANEL_HEADER,
        width: side,
        height: Math.max(0, h - top - SIDE_PANEL_HEADER),
      });
    }
  }

  // ---------------------------------------------------------- UI updates

  send(channel, payload) {
    if (!this.ui.isDestroyed()) this.ui.send(channel, payload);
  }

  tabState(tab) {
    const h = tab.wc.isDestroyed() ? null : tab.wc.navigationHistory;
    return {
      id: tab.id,
      title: tab.title,
      url: tab.errorFor || tab.url,
      favicon: tab.favicon,
      loading: tab.loading,
      canGoBack: !!h?.canGoBack(),
      canGoForward: !!h?.canGoForward(),
      bookmarked: this.ctx.bookmarks.has(tab.errorFor || tab.url),
      ...(this.ctx.decorateTab ? this.ctx.decorateTab(tab) : {}),
    };
  }

  emitState() {
    if (this.statePending || this.destroyed) return;
    this.statePending = true;
    setImmediate(() => {
      this.statePending = false;
      if (this.destroyed) return;
      this.send('tabs:state', {
        activeId: this.activeId,
        tabs: this.order.map((id) => this.tabState(this.tabs.get(id))),
      });
    });
  }

  emitLayout() {
    this.send('layout:state', {
      sidePanel: this.sidePanel
        ? { extensionId: this.sidePanel.extensionId, title: this.sidePanel.title, width: SIDE_PANEL_WIDTH, header: SIDE_PANEL_HEADER }
        : null,
    });
  }

  // --------------------------------------------------------- context menu

  showContextMenu(tab, params) {
    const items = [];
    if (params.linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => this.createTab({ url: params.linkURL, active: false, openerId: tab.id }) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      );
    }
    if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' });
    else if (params.selectionText) items.push({ role: 'copy' }, { type: 'separator' });
    items.push(
      { label: 'Back', enabled: tab.wc.navigationHistory.canGoBack(), click: () => tab.wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: tab.wc.navigationHistory.canGoForward(), click: () => tab.wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => tab.wc.reload() },
    );
    const extItems = this.ctx.crx?.getContextMenuItems(tab.wc, params) || [];
    if (extItems.length) items.push({ type: 'separator' }, ...extItems);
    items.push({ type: 'separator' }, { label: 'Inspect', click: () => tab.wc.inspectElement(params.x, params.y) });
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  // -------------------------------------------------------------- teardown

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const tab of this.tabs.values()) {
      this.ctx.onTabClosed?.(tab, this);
      if (!tab.wc.isDestroyed()) tab.wc.close();
    }
    this.tabs.clear();
    this.order = [];
    if (this.sidePanel && !this.sidePanel.view.webContents.isDestroyed()) this.sidePanel.view.webContents.close();
    this.sidePanel = null;
    this.emit('closed');
  }
}

module.exports = { BrowserWindowController, SIDE_PANEL_WIDTH, SIDE_PANEL_HEADER };
