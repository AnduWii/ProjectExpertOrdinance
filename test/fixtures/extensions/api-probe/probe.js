// Shared by the service worker (importScripts) and the extension page.
const PROBE_PATHS = [
  'accessibilityFeatures', 'action', 'action.onClicked', 'action.openPopup', 'alarms', 'bookmarks', 'browsingData',
  'commands', 'contentSettings', 'contextMenus', 'cookies', 'debugger', 'debugger.attach', 'declarativeContent',
  'declarativeNetRequest', 'desktopCapture', 'dns', 'dom', 'downloads', 'extension', 'fontSettings', 'gcm',
  'history', 'i18n', 'identity', 'identity.launchWebAuthFlow', 'idle', 'instanceID', 'management',
  'notifications', 'offscreen', 'omnibox', 'pageCapture', 'permissions', 'power', 'printerProvider', 'privacy',
  'processes', 'proxy', 'readingList', 'runtime', 'runtime.connectNative', 'runtime.sendNativeMessage',
  'runtime.openOptionsPage', 'scripting', 'scripting.executeScript', 'search', 'sessions', 'sidePanel',
  'sidePanel.open', 'sidePanel.setPanelBehavior', 'storage', 'storage.local', 'storage.sync', 'storage.session',
  'storage.managed', 'system', 'system.cpu', 'system.display', 'system.memory', 'system.storage', 'tabCapture',
  'tabGroups', 'tabs', 'tabs.query', 'tabs.create', 'tabs.update', 'tabs.remove', 'tabs.group', 'tabs.ungroup',
  'tabs.captureVisibleTab', 'tabs.sendMessage', 'topSites', 'tts', 'ttsEngine', 'userScripts',
  'webAuthenticationProxy', 'webNavigation', 'webRequest', 'windows', 'windows.create',
];
function probeChrome() {
  const out = {};
  for (const p of PROBE_PATHS) {
    let v = globalThis.chrome;
    for (const part of p.split('.')) v = v == null ? undefined : v[part];
    out[p] = v === undefined ? 'missing' : typeof v;
  }
  return { keys: Object.keys(globalThis.chrome || {}).sort(), paths: out };
}
