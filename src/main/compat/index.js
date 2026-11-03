'use strict';

/**
 * Chrome API compatibility layer for extensions that Electron (and
 * electron-chrome-extensions) do not cover. It exists mainly so agent-style
 * extensions such as Claude in Chrome have the APIs they rely on:
 *
 *   chrome.debugger   -> Electron's webContents.debugger (Chrome DevTools Protocol)
 *   chrome.sidePanel  -> a WebContentsView docked on the right of the window
 *   chrome.tabGroups  -> groups tracked here, colour shown on the tab strip
 *   chrome.tabs.group / ungroup / captureVisibleTab
 *   chrome.identity.launchWebAuthFlow / getRedirectURL
 *
 * The renderer half lives in src/preload/compat-preload.js and is injected
 * into extension service workers and chrome-extension:// pages only.
 */

const path = require('node:path');
const { ipcMain, BrowserWindow } = require('electron');
const { localize } = require('../extensions');

const PRELOAD = path.join(__dirname, '..', '..', 'preload', 'compat-preload.js');
const GROUP_COLORS = {
  grey: '#5f6368',
  blue: '#1a73e8',
  red: '#d93025',
  yellow: '#f9ab00',
  green: '#188038',
  pink: '#d01884',
  purple: '#a142f4',
  cyan: '#007b83',
  orange: '#fa903e',
};
const COLOR_NAMES = Object.keys(GROUP_COLORS);

class CompatError extends Error {}

function extensionIdFromUrl(url) {
  const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(url || '');
  return m ? m[1] : null;
}

class ExtensionCompat {
  /**
   * @param {object} opts
   * @param {Electron.Session} opts.session
   * @param {() => Set<import('../window').BrowserWindowController>} opts.getControllers
   * @param {() => import('../window').BrowserWindowController | null} opts.getFocusedController
   * @param {(id: string) => Electron.Extension | null} opts.getExtension
   */
  constructor({ session, getControllers, getFocusedController, getExtension }) {
    this.session = session;
    this.getControllers = getControllers;
    this.getFocusedController = getFocusedController;
    this.getExtension = getExtension;

    this.listeners = new Map(); // extensionId -> Map(eventName -> {worker: bool, frames: Set<WebFrameMain>})
    this.workers = new WeakSet();
    this.debuggees = new Map(); // tabId -> {extensionId, cleanup}
    this.sidePanelState = new Map(); // extensionId -> {path, enabled, openPanelOnActionClick, tabs: Map}
    this.groups = new Map(); // groupId -> {id, title, color, collapsed, windowId}
    this.tabGroup = new Map(); // tabId -> groupId
    this.nextGroupId = 1;
  }

  // ------------------------------------------------------------ plumbing

  /** Must run before electron-chrome-extensions is constructed (see compat-preload.js). */
  registerPreloads() {
    this.session.registerPreloadScript({ id: 'ordinance-compat-frame', type: 'frame', filePath: PRELOAD });
    this.session.registerPreloadScript({ id: 'ordinance-compat-sw', type: 'service-worker', filePath: PRELOAD });

    ipcMain.handle('ordx:call', (event, method, args) => this.onCall(event, method, args));
    ipcMain.on('ordx:listen', (event, eventName, add) => this.onListen(event, eventName, add));

    this.session.serviceWorkers.on('running-status-changed', ({ runningStatus, versionId }) => {
      if (runningStatus !== 'starting') return;
      const worker = this.session.serviceWorkers.getWorkerFromVersionID(versionId);
      if (!worker || this.workers.has(worker) || !worker.scope?.startsWith('chrome-extension://')) return;
      this.workers.add(worker);
      worker.ipc.handle('ordx:call', (event, method, args) => this.onCall(event, method, args));
      worker.ipc.on('ordx:listen', (event, eventName, add) => this.onListen(event, eventName, add));
    });
  }

  senderExtensionId(event) {
    if (event.type === 'service-worker' || event.serviceWorker) {
      return extensionIdFromUrl(event.serviceWorker?.scope);
    }
    return extensionIdFromUrl(event.senderFrame?.url);
  }

  onListen(event, eventName, add = true) {
    const extensionId = this.senderExtensionId(event);
    if (!extensionId || typeof eventName !== 'string') return;
    let byEvent = this.listeners.get(extensionId);
    if (!byEvent) this.listeners.set(extensionId, (byEvent = new Map()));
    let entry = byEvent.get(eventName);
    if (!entry) byEvent.set(eventName, (entry = { worker: false, frames: new Set() }));
    const isWorker = event.type === 'service-worker' || !!event.serviceWorker;
    if (isWorker) entry.worker = add || entry.worker;
    else if (event.senderFrame) {
      if (add) entry.frames.add(event.senderFrame);
      else entry.frames.delete(event.senderFrame);
    }
  }

  /** Deliver an event to every context of `extensionId` that listens for it. */
  dispatch(extensionId, eventName, ...args) {
    const entry = this.listeners.get(extensionId)?.get(eventName);
    if (!entry) return;
    for (const frame of entry.frames) {
      try {
        if (frame.isDestroyed?.() || frame.detached) entry.frames.delete(frame);
        else frame.send('ordx:event', eventName, args);
      } catch {
        entry.frames.delete(frame);
      }
    }
    if (entry.worker) {
      this.session.serviceWorkers
        .startWorkerForScope(`chrome-extension://${extensionId}/`)
        .then((worker) => worker.send('ordx:event', eventName, args))
        .catch((err) => console.warn(`[compat] could not deliver ${eventName} to ${extensionId}: ${err.message}`));
    }
  }

  broadcast(permission, eventName, ...args) {
    for (const extensionId of this.listeners.keys()) {
      if (this.hasPermission(extensionId, permission)) this.dispatch(extensionId, eventName, ...args);
    }
  }

  hasPermission(extensionId, permission) {
    const manifest = this.getExtension(extensionId)?.manifest || {};
    return [...(manifest.permissions || []), ...(manifest.optional_permissions || [])].includes(permission);
  }

  require(extensionId, permission) {
    if (!this.hasPermission(extensionId, permission)) {
      throw new CompatError(`'${permission}' permission is required`);
    }
  }

  async onCall(event, method, args = []) {
    const extensionId = this.senderExtensionId(event);
    try {
      if (!extensionId || !this.getExtension(extensionId)) throw new CompatError('Caller is not an installed extension');
      const fn = this.methods[method];
      if (!fn) throw new CompatError(`Unknown method ${method}`);
      const result = await fn.call(this, { extensionId, event }, ...(Array.isArray(args) ? args : []));
      return { result: result === undefined ? null : result };
    } catch (err) {
      return { error: err instanceof CompatError ? err.message : String(err?.message || err) };
    }
  }

  // --------------------------------------------------------------- helpers

  findTab(tabId) {
    for (const c of this.getControllers()) {
      const tab = c.tabs.get(tabId);
      if (tab) return { controller: c, tab };
    }
    return null;
  }

  tabOrThrow(tabId) {
    const found = Number.isInteger(tabId) ? this.findTab(tabId) : null;
    if (!found) throw new CompatError(`No tab with id: ${tabId}.`);
    return found;
  }

  controllerFor({ tabId, windowId } = {}) {
    if (Number.isInteger(tabId)) return this.tabOrThrow(tabId).controller;
    if (Number.isInteger(windowId)) {
      const c = [...this.getControllers()].find((x) => x.win.id === windowId);
      if (!c) throw new CompatError(`No window with id: ${windowId}.`);
      return c;
    }
    const c = this.getFocusedController();
    if (!c) throw new CompatError('No browser window is open.');
    return c;
  }

  extensionName(extensionId) {
    const ext = this.getExtension(extensionId);
    return ext ? localize(ext.path, ext.manifest || {}, ext.name) : extensionId;
  }

  refreshTab(tabId) {
    const found = this.findTab(tabId);
    if (!found) return;
    found.controller.emitState();
    // Lets electron-chrome-extensions fire chrome.tabs.onUpdated.
    found.tab.wc.emit('tab-updated');
  }

  /** Extra per-tab state for the toolbar UI. */
  decorateTab(tab) {
    const groupId = this.tabGroup.get(tab.id);
    const group = groupId != null ? this.groups.get(groupId) : null;
    const debuggee = this.debuggees.get(tab.id);
    return {
      groupId: group ? group.id : -1,
      groupColor: group ? GROUP_COLORS[group.color] : null,
      debuggedBy: debuggee ? this.extensionName(debuggee.extensionId) : null,
    };
  }

  /** Called by electron-chrome-extensions when it builds a chrome.tabs.Tab. */
  assignTabDetails(details, wc) {
    const groupId = this.tabGroup.get(wc.id);
    details.groupId = groupId ?? -1;
  }

  onTabClosed(tab) {
    if (this.debuggees.has(tab.id)) this.debuggees.get(tab.id).cleanup('target_closed');
    for (const s of this.sidePanelState.values()) s.tabs.delete(tab.id);
    const groupId = this.tabGroup.get(tab.id);
    if (groupId != null) {
      this.tabGroup.delete(tab.id);
      this.pruneGroup(groupId);
    }
  }

  // ----------------------------------------------------------- side panel

  panelState(extensionId) {
    let s = this.sidePanelState.get(extensionId);
    if (!s) {
      const manifest = this.getExtension(extensionId)?.manifest || {};
      s = {
        path: manifest.side_panel?.default_path || null,
        enabled: true,
        openPanelOnActionClick: false,
        tabs: new Map(),
      };
      this.sidePanelState.set(extensionId, s);
    }
    return s;
  }

  panelUrl(extensionId, tabId) {
    const s = this.panelState(extensionId);
    const tabOpts = Number.isInteger(tabId) ? s.tabs.get(tabId) : null;
    const enabled = tabOpts?.enabled ?? s.enabled;
    const p = tabOpts?.path || s.path;
    if (!enabled || !p) return null;
    return `chrome-extension://${extensionId}/${p.replace(/^\//, '')}`;
  }

  openSidePanel(controller, extensionId) {
    const url = this.panelUrl(extensionId, controller.activeId);
    if (!url) throw new CompatError('No side panel is configured for this extension.');
    controller.openSidePanel({ extensionId, url, title: this.extensionName(extensionId) });
  }

  /** Toolbar button click. Returns true if the click was handled as "open side panel". */
  handleActionClick(controller, extensionId) {
    const ext = this.getExtension(extensionId);
    if (!ext) return false;
    const s = this.panelState(extensionId);
    const action = ext.manifest?.action || ext.manifest?.browser_action;
    // No action at all but a side panel: the button can only mean "open panel".
    const panelOnly = !action && !!s.path;
    if (!s.openPanelOnActionClick && !panelOnly) return false;
    if (controller.sidePanel?.extensionId === extensionId) controller.closeSidePanel();
    else this.openSidePanel(controller, extensionId);
    return true;
  }

  onSidePanelChange(controller, extensionId, opened) {
    const info = { windowId: controller.win.id, path: this.panelState(extensionId).path };
    if (opened) this.dispatch(extensionId, 'sidePanel.onOpened', info);
    else this.dispatch(extensionId, 'sidePanel.onClosed', info);
  }

  // ------------------------------------------------------------- debugger

  attachDebugger(extensionId, tabId, version, event) {
    const { tab } = this.tabOrThrow(tabId);
    const dbg = tab.wc.debugger;
    if (this.debuggees.has(tabId) || dbg.isAttached()) {
      throw new CompatError(`Another debugger is already attached to the tab with id: ${tabId}.`);
    }
    dbg.attach(version || '1.3');
    // Keep the extension's service worker alive while it drives the tab.
    let keepAlive = null;
    try {
      keepAlive = event.serviceWorker?.startTask?.() || null;
    } catch {
      keepAlive = null;
    }
    const onMessage = (_e, method, params, sessionId) => {
      const source = sessionId ? { tabId, sessionId } : { tabId };
      this.dispatch(extensionId, 'debugger.onEvent', source, method, params);
    };
    const onDetach = (_e, reason) => cleanup(reason === 'target closed' ? 'target_closed' : 'canceled_by_user', false);
    const cleanup = (reason, detachNow = true) => {
      if (this.debuggees.get(tabId)?.cleanup !== cleanup) return;
      this.debuggees.delete(tabId);
      dbg.removeListener('message', onMessage);
      dbg.removeListener('detach', onDetach);
      if (detachNow && !tab.wc.isDestroyed() && dbg.isAttached()) {
        try {
          dbg.detach();
        } catch {
          /* already gone */
        }
      }
      keepAlive?.end?.();
      if (reason) this.dispatch(extensionId, 'debugger.onDetach', { tabId }, reason);
      this.refreshTab(tabId);
    };
    dbg.on('message', onMessage);
    dbg.on('detach', onDetach);
    this.debuggees.set(tabId, { extensionId, cleanup });
    this.refreshTab(tabId);
  }

  /** "Cancel" in the yellow debugging banner. */
  cancelDebugging(tabId) {
    this.debuggees.get(tabId)?.cleanup('canceled_by_user');
  }

  ownedDebuggee(extensionId, target) {
    const tabId = target?.tabId;
    const entry = this.debuggees.get(tabId);
    if (!entry || entry.extensionId !== extensionId) {
      throw new CompatError(`Debugger is not attached to the tab with id: ${tabId}.`);
    }
    return { tabId, entry, tab: this.tabOrThrow(tabId).tab };
  }

  // ------------------------------------------------------------ tab groups

  groupInfo(group) {
    return { id: group.id, title: group.title, color: group.color, collapsed: group.collapsed, windowId: group.windowId };
  }

  pruneGroup(groupId) {
    const used = [...this.tabGroup.values()].includes(groupId);
    if (!used && this.groups.has(groupId)) {
      const group = this.groups.get(groupId);
      this.groups.delete(groupId);
      this.broadcast('tabGroups', 'tabGroups.onRemoved', this.groupInfo(group));
    }
  }

  // ----------------------------------------------------------- API methods

  get methods() {
    return {
      // ---- chrome.debugger
      'debugger.attach'({ extensionId, event }, target, requiredVersion) {
        this.require(extensionId, 'debugger');
        this.attachDebugger(extensionId, target?.tabId, requiredVersion, event);
      },
      'debugger.detach'({ extensionId }, target) {
        this.require(extensionId, 'debugger');
        this.ownedDebuggee(extensionId, target).entry.cleanup(null);
      },
      async 'debugger.sendCommand'({ extensionId }, target, method, params) {
        this.require(extensionId, 'debugger');
        const { tab } = this.ownedDebuggee(extensionId, target);
        return tab.wc.debugger.sendCommand(String(method), params || {}, target?.sessionId);
      },
      'debugger.getTargets'({ extensionId }) {
        this.require(extensionId, 'debugger');
        const out = [];
        for (const c of this.getControllers()) {
          for (const id of c.order) {
            const tab = c.tabs.get(id);
            out.push({
              id: String(tab.id),
              tabId: tab.id,
              type: 'page',
              title: tab.title,
              url: tab.wc.getURL(),
              faviconUrl: tab.favicon || undefined,
              attached: this.debuggees.has(tab.id) || tab.wc.debugger.isAttached(),
            });
          }
        }
        return out;
      },

      // ---- chrome.sidePanel
      'sidePanel.setOptions'({ extensionId }, options = {}) {
        this.require(extensionId, 'sidePanel');
        const s = this.panelState(extensionId);
        const target = Number.isInteger(options.tabId) ? s.tabs.get(options.tabId) || {} : s;
        if (typeof options.path === 'string') target.path = options.path;
        if (typeof options.enabled === 'boolean') target.enabled = options.enabled;
        if (Number.isInteger(options.tabId)) s.tabs.set(options.tabId, target);
        // Disabling the panel closes it where it is showing.
        for (const c of this.getControllers()) {
          if (c.sidePanel?.extensionId === extensionId && !this.panelUrl(extensionId, c.activeId)) c.closeSidePanel();
        }
      },
      'sidePanel.getOptions'({ extensionId }, options = {}) {
        this.require(extensionId, 'sidePanel');
        const s = this.panelState(extensionId);
        const t = Number.isInteger(options.tabId) ? s.tabs.get(options.tabId) : null;
        return { ...(t ? { tabId: options.tabId } : {}), path: t?.path || s.path || undefined, enabled: t?.enabled ?? s.enabled };
      },
      'sidePanel.setPanelBehavior'({ extensionId }, behavior = {}) {
        this.require(extensionId, 'sidePanel');
        if (typeof behavior.openPanelOnActionClick === 'boolean') {
          this.panelState(extensionId).openPanelOnActionClick = behavior.openPanelOnActionClick;
        }
      },
      'sidePanel.getPanelBehavior'({ extensionId }) {
        this.require(extensionId, 'sidePanel');
        return { openPanelOnActionClick: this.panelState(extensionId).openPanelOnActionClick };
      },
      'sidePanel.open'({ extensionId }, options = {}) {
        this.require(extensionId, 'sidePanel');
        this.openSidePanel(this.controllerFor(options), extensionId);
      },
      'sidePanel.close'({ extensionId }, options = {}) {
        this.require(extensionId, 'sidePanel');
        const c = this.controllerFor(options);
        if (c.sidePanel?.extensionId === extensionId) c.closeSidePanel();
      },

      // ---- chrome.tabs additions
      'tabs.group'(_caller, options = {}) {
        const tabIds = [].concat(options.tabIds ?? []).map(Number);
        if (!tabIds.length) throw new CompatError('You must specify at least one tab.');
        const first = this.tabOrThrow(tabIds[0]);
        tabIds.forEach((id) => this.tabOrThrow(id));
        let group;
        if (Number.isInteger(options.groupId)) {
          group = this.groups.get(options.groupId);
          if (!group) throw new CompatError(`No group with id: ${options.groupId}.`);
        } else {
          group = {
            id: this.nextGroupId++,
            title: '',
            color: COLOR_NAMES[(this.nextGroupId - 2) % COLOR_NAMES.length],
            collapsed: false,
            windowId: options.createProperties?.windowId ?? first.controller.win.id,
          };
          this.groups.set(group.id, group);
          this.broadcast('tabGroups', 'tabGroups.onCreated', this.groupInfo(group));
        }
        const previous = new Set();
        for (const id of tabIds) {
          if (this.tabGroup.has(id)) previous.add(this.tabGroup.get(id));
          this.tabGroup.set(id, group.id);
          this.refreshTab(id);
        }
        previous.forEach((g) => g !== group.id && this.pruneGroup(g));
        return group.id;
      },
      'tabs.ungroup'(_caller, tabIds) {
        const affected = new Set();
        for (const id of [].concat(tabIds ?? []).map(Number)) {
          if (!this.tabGroup.has(id)) continue;
          affected.add(this.tabGroup.get(id));
          this.tabGroup.delete(id);
          this.refreshTab(id);
        }
        affected.forEach((g) => this.pruneGroup(g));
      },
      async 'tabs.captureVisibleTab'(_caller, windowId, options = {}) {
        if (windowId && typeof windowId === 'object') {
          options = windowId; // captureVisibleTab(options)
          windowId = undefined;
        }
        const c = this.controllerFor(Number.isInteger(windowId) ? { windowId } : {});
        const tab = c.activeTab;
        if (!tab) throw new CompatError('No active tab.');
        const image = await tab.wc.capturePage();
        if (options?.format === 'jpeg') {
          const quality = Number.isInteger(options.quality) ? options.quality : 92;
          return `data:image/jpeg;base64,${image.toJPEG(quality).toString('base64')}`;
        }
        return image.toDataURL();
      },

      // ---- chrome.tabGroups
      'tabGroups.get'({ extensionId }, groupId) {
        this.require(extensionId, 'tabGroups');
        const group = this.groups.get(groupId);
        if (!group) throw new CompatError(`No group with id: ${groupId}.`);
        return this.groupInfo(group);
      },
      'tabGroups.query'({ extensionId }, query = {}) {
        this.require(extensionId, 'tabGroups');
        return [...this.groups.values()]
          .filter((g) => (query.title == null || g.title === query.title) && (query.color == null || g.color === query.color))
          .filter((g) => (query.collapsed == null || g.collapsed === query.collapsed) && (query.windowId == null || g.windowId === query.windowId))
          .map((g) => this.groupInfo(g));
      },
      'tabGroups.update'({ extensionId }, groupId, props = {}) {
        this.require(extensionId, 'tabGroups');
        const group = this.groups.get(groupId);
        if (!group) throw new CompatError(`No group with id: ${groupId}.`);
        if (typeof props.title === 'string') group.title = props.title;
        if (typeof props.collapsed === 'boolean') group.collapsed = props.collapsed;
        if (props.color != null) {
          if (!COLOR_NAMES.includes(props.color)) throw new CompatError(`Invalid color: ${props.color}`);
          group.color = props.color;
        }
        for (const [tabId, g] of this.tabGroup) if (g === groupId) this.refreshTab(tabId);
        this.broadcast('tabGroups', 'tabGroups.onUpdated', this.groupInfo(group));
        return this.groupInfo(group);
      },
      'tabGroups.move'({ extensionId }, groupId) {
        this.require(extensionId, 'tabGroups');
        const group = this.groups.get(groupId);
        if (!group) throw new CompatError(`No group with id: ${groupId}.`);
        return this.groupInfo(group); // tab order inside groups is not modelled
      },

      // ---- chrome.identity
      'identity.launchWebAuthFlow'({ extensionId }, details = {}) {
        this.require(extensionId, 'identity');
        return this.launchWebAuthFlow(extensionId, details);
      },
    };
  }

  launchWebAuthFlow(extensionId, { url, interactive = false } = {}) {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new CompatError('Invalid url.');
    const redirectPrefix = `https://${extensionId}.chromiumapp.org/`;
    const parent = this.getFocusedController()?.win;
    return new Promise((resolve, reject) => {
      const win = new BrowserWindow({
        width: 520,
        height: 700,
        parent,
        show: false,
        title: `Sign in – ${this.extensionName(extensionId)}`,
        webPreferences: { session: this.session, sandbox: true, contextIsolation: true },
      });
      let done = false;
      const finish = (err, value) => {
        if (done) return;
        done = true;
        if (!win.isDestroyed()) win.destroy();
        if (err) reject(new CompatError(err));
        else resolve(value);
      };
      const check = (event, target) => {
        if (target.startsWith(redirectPrefix)) {
          event?.preventDefault?.();
          finish(null, target);
        }
      };
      win.webContents.on('will-redirect', (e) => check(e, e.url));
      win.webContents.on('will-navigate', (e) => check(e, e.url));
      win.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
        if (isMainFrame && !failedUrl.startsWith(redirectPrefix) && code !== -3) finish(`Authorization page could not be loaded: ${desc}`);
      });
      win.webContents.once('did-finish-load', () => {
        if (interactive) win.show();
        else finish('User interaction required.');
      });
      win.on('closed', () => finish('The user did not approve access.'));
      win.loadURL(url).catch(() => {});
    });
  }

  /** Tear down state for an extension that was removed. */
  forgetExtension(extensionId) {
    for (const [tabId, entry] of this.debuggees) if (entry.extensionId === extensionId) entry.cleanup(null);
    for (const c of this.getControllers()) if (c.sidePanel?.extensionId === extensionId) c.closeSidePanel();
    this.sidePanelState.delete(extensionId);
    this.listeners.delete(extensionId);
  }
}

module.exports = { ExtensionCompat, GROUP_COLORS, extensionIdFromUrl };
