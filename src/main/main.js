'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, session, Menu } = require('electron');
const { BrowserWindowController } = require('./window');
const { Bookmarks, History, Settings } = require('./store');

// Tests (and power users) can point the profile somewhere else.
if (process.env.ORDINANCE_USER_DATA) app.setPath('userData', path.resolve(process.env.ORDINANCE_USER_DATA));

const PARTITION = 'persist:ordinance';
const controllers = new Set();
const ctx = {
  session: null,
  settings: null,
  bookmarks: null,
  history: null,
  crx: null,
  getHomePage: () => process.env.ORDINANCE_HOME || ctx.settings.get('homePage'),
};

// --------------------------------------------------------------- helpers

/** Strip the "Electron/x" and app-name tokens so sites see a normal Chrome UA. */
function chromeLikeUserAgent(ua) {
  const names = [app.getName(), 'Electron', 'ordinance-browser'].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return ua.replace(new RegExp(`\\s(${names.join('|')})\\/\\S+`, 'g'), '');
}

function startupUrls(argv) {
  return argv.filter((a) => /^(https?|file):\/\//i.test(a));
}

function createWindow(urls = []) {
  const c = new BrowserWindowController(ctx, { urls });
  controllers.add(c);
  c.on('closed', () => controllers.delete(c));
  return c;
}

const focusedController = () => {
  const win = BrowserWindow.getFocusedWindow();
  return [...controllers].find((c) => c.win === win) || [...controllers].pop() || null;
};

const controllerForUi = (wc) => [...controllers].find((c) => c.ui === wc) || null;

function broadcast(channel, payload) {
  for (const c of controllers) c.send(channel, payload);
}

function refreshAllTabs() {
  for (const c of controllers) c.emitState();
}

// ------------------------------------------------------------------- IPC

/** Register an IPC handler that only the browser's own toolbar UI may call. */
function uiHandle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    const c = controllerForUi(event.sender);
    if (!c) throw new Error(`${channel}: sender is not a browser window`);
    return fn(c, ...args);
  });
}

function registerIpc() {
  uiHandle('ui:ready', (c) => {
    c.emitState();
    c.emitLayout();
    return true;
  });
  uiHandle('ui:layout', (c, insets) => c.setInsets(insets || {}));

  uiHandle('tabs:new', (c, url) => {
    const tab = c.createTab({ url: url || ctx.getHomePage() });
    return tab.id;
  });
  uiHandle('tabs:close', (c, id) => c.closeTab(Number(id)));
  uiHandle('tabs:activate', (c, id) => c.activateTab(Number(id)));
  uiHandle('tabs:move', (c, id, toIndex) => c.moveTab(Number(id), Number(toIndex)));

  uiHandle('nav:go', (c, input) => c.navigate(String(input ?? '')));
  uiHandle('nav:back', (c) => c.goBack());
  uiHandle('nav:forward', (c) => c.goForward());
  uiHandle('nav:reload', (c) => c.reload());
  uiHandle('nav:stop', (c) => c.stop());
  uiHandle('nav:home', (c) => c.goHome());
  uiHandle('nav:open', (c, url) => {
    if (typeof url !== 'string' || !/^(https?|file):/i.test(url)) return false;
    if (c.activeTab) c.load(c.activeTab, url);
    return true;
  });

  uiHandle('bookmarks:list', () => ctx.bookmarks.list());
  uiHandle('bookmarks:toggle', (c) => {
    const tab = c.activeTab;
    const url = tab && (tab.errorFor || tab.url);
    if (!url || !/^(https?|file):/i.test(url)) return false;
    const added = ctx.bookmarks.toggle({ url, title: tab.title });
    refreshAllTabs();
    broadcast('bookmarks:changed');
    return added;
  });
  uiHandle('bookmarks:remove', (_c, id) => {
    const removed = ctx.bookmarks.remove(String(id));
    refreshAllTabs();
    broadcast('bookmarks:changed');
    return removed;
  });

  uiHandle('history:list', (_c, query) => ctx.history.list({ query: String(query || '') }));
  uiHandle('history:remove', (_c, id) => ctx.history.remove(String(id)));
  uiHandle('history:clear', () => ctx.history.clear());
}

// ------------------------------------------------------------------ menu

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const withController = (fn) => () => {
    const c = focusedController();
    if (c) fn(c);
  };
  const uiCommand = (command, extra = {}) =>
    withController((c) => {
      c.ui.focus();
      c.send('ui:command', { command, ...extra });
    });
  const pageWc = (c) => c.activeTab?.wc;

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: withController((c) => { c.createTab({ url: ctx.getHomePage() }); c.ui.focus(); c.send('ui:command', { command: 'focus-address' }); }) },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: withController((c) => c.closeTab(c.activeId)) },
        { type: 'separator' },
        { label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: uiCommand('focus-address') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: withController((c) => c.reload()) },
        { label: 'Reload', accelerator: 'F5', visible: false, click: withController((c) => c.reload()) },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: withController((c) => { const wc = pageWc(c); if (wc) wc.setZoomLevel(wc.getZoomLevel() + 0.5); }) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: withController((c) => { const wc = pageWc(c); if (wc) wc.setZoomLevel(wc.getZoomLevel() - 0.5); }) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: withController((c) => pageWc(c)?.setZoomLevel(0)) },
        { type: 'separator' },
        { label: 'Developer Tools (Page)', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: withController((c) => pageWc(c)?.toggleDevTools()) },
        { label: 'Developer Tools (Browser UI)', click: withController((c) => c.ui.openDevTools({ mode: 'detach' })) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: isMac ? 'Cmd+[' : 'Alt+Left', click: withController((c) => c.goBack()) },
        { label: 'Forward', accelerator: isMac ? 'Cmd+]' : 'Alt+Right', click: withController((c) => c.goForward()) },
        { label: 'Home', accelerator: isMac ? 'Shift+Cmd+H' : 'Alt+Home', click: withController((c) => c.goHome()) },
        { type: 'separator' },
        { label: 'Show History', accelerator: isMac ? 'Cmd+Y' : 'Ctrl+H', click: uiCommand('toggle-panel', { view: 'history' }) },
      ],
    },
    {
      label: 'Bookmarks',
      submenu: [
        {
          label: 'Bookmark This Page',
          accelerator: 'CmdOrCtrl+D',
          click: withController((c) => {
            const tab = c.activeTab;
            const url = tab && (tab.errorFor || tab.url);
            if (!url || !/^(https?|file):/i.test(url)) return;
            ctx.bookmarks.toggle({ url, title: tab.title });
            refreshAllTabs();
            broadcast('bookmarks:changed');
          }),
        },
        { label: 'Show Bookmarks', accelerator: 'CmdOrCtrl+Shift+O', click: uiCommand('toggle-panel', { view: 'bookmarks' }) },
      ],
    },
    {
      label: 'Tab',
      submenu: [
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: withController((c) => c.cycleTab(1)) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: withController((c) => c.cycleTab(-1)) },
        { type: 'separator' },
        { label: 'Extensions', click: uiCommand('toggle-panel', { view: 'extensions' }) },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const c = focusedController() || createWindow();
    for (const url of startupUrls(argv)) c.createTab({ url });
    if (c.win.isMinimized()) c.win.restore();
    c.win.focus();
  });

  app.userAgentFallback = chromeLikeUserAgent(app.userAgentFallback);

  app.whenReady().then(async () => {
    const dir = app.getPath('userData');
    ctx.settings = new Settings(dir);
    ctx.bookmarks = new Bookmarks(dir);
    ctx.history = new History(dir);
    ctx.session = session.fromPartition(PARTITION);
    ctx.session.setUserAgent(chromeLikeUserAgent(ctx.session.getUserAgent()));

    registerIpc();
    buildMenu();
    createWindow(startupUrls(process.argv));

    app.on('activate', () => {
      if (controllers.size === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => ctx.history?.flush());
}

module.exports = { ctx, controllers, createWindow };
