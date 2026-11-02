'use strict';

/**
 * Which Chrome extension APIs work in this browser, and who provides them.
 * Measured with test/fixtures/extensions/api-probe on Electron 45.2.1 +
 * electron-chrome-extensions 4.10.0 (see docs/extension-api-support.md).
 */

const PROVIDERS = {
  electron: 'Electron 45 built-in',
  library: 'electron-chrome-extensions 4.10.0',
  shim: 'this browser (src/main/compat)',
};

/** API -> provider, for namespaces that were called successfully. */
const SUPPORTED = {
  runtime: 'electron',
  storage: 'electron',
  scripting: 'electron',
  i18n: 'electron',
  alarms: 'electron',
  offscreen: 'electron',
  declarativeNetRequest: 'electron',
  idle: 'electron',
  management: 'electron',
  permissions: 'electron',
  'system.cpu': 'electron',
  'system.memory': 'electron',
  webRequest: 'electron',
  tabs: 'electron+library+shim',
  action: 'electron+library',
  windows: 'library',
  cookies: 'library',
  contextMenus: 'library',
  notifications: 'library',
  webNavigation: 'library',
  nativeMessaging: 'library',
  debugger: 'shim',
  sidePanel: 'shim',
  tabGroups: 'shim',
  identity: 'shim',
};

/** Present as an object but calls do nothing useful. */
const STUBS = ['downloads', 'privacy', 'topSites', 'system.display'];

/** No chrome.* namespace at all. */
const MISSING = [
  'accessibilityFeatures',
  'bookmarks',
  'browsingData',
  'contentSettings',
  'declarativeContent',
  'desktopCapture',
  'favicon',
  'fontSettings',
  'gcm',
  'history',
  'pageCapture',
  'processes',
  'readingList',
  'search',
  'sessions',
  'tabCapture',
  'tts',
  'ttsEngine',
  'userScripts',
  'webAuthenticationProxy',
];

const UNSUPPORTED = [...MISSING, ...STUBS];

/** Manifest permissions this browser cannot honour (shown as a warning in the UI). */
function unsupportedPermissions(manifest) {
  const requested = [...(manifest.permissions || []), ...(manifest.optional_permissions || [])].filter(
    (p) => typeof p === 'string',
  );
  const out = requested.filter((p) => UNSUPPORTED.includes(p) || UNSUPPORTED.includes(p.split('.')[0]));
  return [...new Set(out)];
}

module.exports = { PROVIDERS, SUPPORTED, STUBS, MISSING, UNSUPPORTED, unsupportedPermissions };
