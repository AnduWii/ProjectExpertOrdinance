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

// Chrome's install-prompt wording for the permissions that warrant one.
const PERMISSION_WARNINGS = {
  debugger: 'Access the page debugger backend',
  tabs: 'Read your browsing history',
  webNavigation: 'Read your browsing history',
  tabGroups: 'View and manage your tab groups',
  history: 'Read and change your browsing history',
  bookmarks: 'Read and change your bookmarks',
  nativeMessaging: 'Communicate with cooperating native applications',
  notifications: 'Display notifications',
  downloads: 'Manage your downloads',
  clipboardRead: 'Read data you copy and paste',
  clipboardWrite: 'Modify data you copy and paste',
  desktopCapture: 'Capture content of your screen',
  tabCapture: 'Capture content of your screen',
  geolocation: 'Detect your physical location',
  management: 'Manage your apps, extensions, and themes',
  privacy: 'Change your privacy-related settings',
  proxy: 'Read and change all your data on all websites',
  pageCapture: 'Read and change all your data on all websites',
};

const ALL_SITES = /^(<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*)$/;

/** Human-readable list of what an extension can do, for the install prompt. */
function describePermissions(manifest) {
  const perms = [...(manifest.permissions || [])];
  const hosts = [
    ...(manifest.host_permissions || []),
    ...perms.filter((p) => typeof p === 'string' && p.includes('://')),
    ...(manifest.content_scripts || []).flatMap((c) => c.matches || []),
  ];
  const out = [];
  if (hosts.some((h) => ALL_SITES.test(h)) || perms.includes('<all_urls>')) out.push('Read and change all your data on all websites');
  else if (hosts.length) out.push(`Read and change your data on ${[...new Set(hosts)].slice(0, 3).join(', ')}${hosts.length > 3 ? ' and more' : ''}`);
  for (const p of perms) if (PERMISSION_WARNINGS[p]) out.push(PERMISSION_WARNINGS[p]);
  return [...new Set(out)];
}

module.exports = { PROVIDERS, SUPPORTED, STUBS, MISSING, UNSUPPORTED, unsupportedPermissions, describePermissions };
