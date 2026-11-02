'use strict';

// Preload for the browser's own toolbar UI. Exposes a narrow, explicit API;
// web pages in tabs never get this preload.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

const EVENTS = new Set(['tabs:state', 'layout:state', 'extensions:state', 'bookmarks:changed', 'ui:command']);

contextBridge.exposeInMainWorld('browserAPI', {
  ready: invoke('ui:ready'),
  setLayout: invoke('ui:layout'),

  newTab: invoke('tabs:new'),
  closeTab: invoke('tabs:close'),
  activateTab: invoke('tabs:activate'),
  moveTab: invoke('tabs:move'),

  go: invoke('nav:go'),
  back: invoke('nav:back'),
  forward: invoke('nav:forward'),
  reload: invoke('nav:reload'),
  stop: invoke('nav:stop'),
  home: invoke('nav:home'),
  openUrl: invoke('nav:open'),

  listBookmarks: invoke('bookmarks:list'),
  toggleBookmark: invoke('bookmarks:toggle'),
  removeBookmark: invoke('bookmarks:remove'),

  listHistory: invoke('history:list'),
  removeHistory: invoke('history:remove'),
  clearHistory: invoke('history:clear'),

  listExtensions: invoke('extensions:list'),
  loadExtension: invoke('extensions:load'),
  removeExtension: invoke('extensions:remove'),
  activateExtension: invoke('extensions:activate'),
  closeSidePanel: invoke('sidepanel:close'),
  stopDebugging: invoke('debugger:cancel'),

  on(channel, callback) {
    if (!EVENTS.has(channel)) throw new Error(`Unknown event ${channel}`);
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
