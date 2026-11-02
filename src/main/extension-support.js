'use strict';

/**
 * Which Chrome extension APIs work in this browser, and who provides them.
 *
 * Sources:
 *  - "electron": Electron 45.2.1 built-in support
 *    (https://github.com/electron/electron/blob/v45.2.1/docs/api/extensions.md)
 *  - "library":  electron-chrome-extensions 4.10.0 polyfills
 *  - "shim":     this repo's compatibility layer (src/main/compat)
 *
 * The "unsupported" list was verified empirically by test/e2e (api-probe),
 * which loads an extension requesting every permission below and checks
 * which `chrome.*` namespaces exist in its service worker and pages.
 */

const SUPPORTED = {
  'devtools.inspectedWindow': 'electron',
  'devtools.network': 'electron',
  'devtools.panels': 'electron',
  extension: 'electron (partial)',
  i18n: 'electron',
  management: 'electron (partial)',
  scripting: 'electron',
  webRequest: 'electron',
  runtime: 'electron + library',
  storage: 'electron + library (local, sync on disk; session/managed limited)',
  tabs: 'electron + library + shim (group/ungroup/captureVisibleTab)',
  action: 'library',
  browserAction: 'library',
  contextMenus: 'library',
  cookies: 'library',
  notifications: 'library',
  webNavigation: 'library',
  windows: 'library',
  nativeMessaging: 'library (reads Chrome native-messaging host manifests)',
  debugger: 'shim (CDP via webContents.debugger)',
  sidePanel: 'shim (docked side panel)',
  tabGroups: 'shim (groups tracked in memory, colour shown on tab)',
  identity: 'shim (launchWebAuthFlow, getRedirectURL only)',
};

/** Manifest permissions that grant nothing usable here. */
const UNSUPPORTED = [
  'alarms',
  'bookmarks',
  'browsingData',
  'commands',
  'contentSettings',
  'declarativeContent',
  'declarativeNetRequest',
  'declarativeNetRequestWithHostAccess',
  'declarativeNetRequestFeedback',
  'desktopCapture',
  'dns',
  'downloads',
  'favicon',
  'fontSettings',
  'gcm',
  'history',
  'idle',
  'offscreen',
  'pageCapture',
  'power',
  'privacy',
  'processes',
  'proxy',
  'readingList',
  'search',
  'sessions',
  'system.cpu',
  'system.display',
  'system.memory',
  'system.storage',
  'tabCapture',
  'topSites',
  'tts',
  'ttsEngine',
  'userScripts',
  'webAuthenticationProxy',
];

// Permissions that are not API namespaces (host access, flags) and are fine.
const NEUTRAL = new Set(['activeTab', 'background', 'unlimitedStorage', 'clipboardRead', 'clipboardWrite', 'geolocation']);

function unsupportedPermissions(manifest) {
  const requested = [...(manifest.permissions || []), ...(manifest.optional_permissions || [])].filter(
    (p) => typeof p === 'string' && !p.includes('://') && p !== '<all_urls>' && !NEUTRAL.has(p),
  );
  return [...new Set(requested.filter((p) => UNSUPPORTED.includes(p)))];
}

module.exports = { SUPPORTED, UNSUPPORTED, unsupportedPermissions };
