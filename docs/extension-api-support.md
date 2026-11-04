# Extension API support (measured)

Measured on **Electron 45.2.1** and **electron-chrome-extensions 4.10.0** by loading
[`test/fixtures/extensions/api-probe`](../test/fixtures/extensions/api-probe). That
extension requests every Manifest V3 permission, then reports from its service
worker which `chrome.*` namespaces exist and whether a real call succeeds.

* **Bare Electron**: `session.extensions.loadExtension` with nothing else, i.e. what Electron itself supports.
* **Chrome2**: the same probe inside this app (Electron + electron-chrome-extensions + `src/main/compat` shims).

Raw output: [`api-probe/electron-45.2.1-bare.json`](api-probe/electron-45.2.1-bare.json),
[`api-probe/ordinance-browser.json`](api-probe/ordinance-browser.json).
Re-generate with `npm run test:e2e` (writes `test/.tmp/api-probe.json`).

## Namespaces in the extension service worker

"present" means the namespace exists. That alone does not mean it works; see the call results below.

| API | Bare Electron 45 | Chrome2 | Provided by |
|---|---|---|---|
| `chrome.accessibilityFeatures` | — | — | not available |
| `chrome.action` | present | present | Electron (state) + library (toolbar, popups, onClicked) |
| `chrome.alarms` | present | present | Electron |
| `chrome.bookmarks` | — | — | not available |
| `chrome.browsingData` | — | — | not available |
| `chrome.commands` | — | present | library (stub: getAll returns [], onCommand never fires) |
| `chrome.contentSettings` | — | — | not available |
| `chrome.contextMenus` | — | present | library |
| `chrome.cookies` | — | present | library |
| `chrome.debugger` | — | present | shim |
| `chrome.declarativeContent` | — | — | not available |
| `chrome.declarativeNetRequest` | present | present | Electron |
| `chrome.desktopCapture` | — | — | not available |
| `chrome.dns` | present | present | Electron (exposed, not exercised) |
| `chrome.dom` | present | present | Electron (exposed, not exercised) |
| `chrome.downloads` | — | present | library (stub, calls do nothing) |
| `chrome.extension` | present | present | Electron (partial: getURL, getBackgroundPage, lastError) |
| `chrome.fontSettings` | — | — | not available |
| `chrome.gcm` | — | — | not available |
| `chrome.history` | — | — | not available |
| `chrome.i18n` | present | present | Electron |
| `chrome.identity` | — | present | shim (launchWebAuthFlow, getRedirectURL) |
| `chrome.idle` | present | present | Electron |
| `chrome.instanceID` | — | — | not available |
| `chrome.management` | present | present | Electron |
| `chrome.notifications` | — | present | library |
| `chrome.offscreen` | present | present | Electron |
| `chrome.omnibox` | — | — | not available |
| `chrome.pageCapture` | — | — | not available |
| `chrome.permissions` | present | present | Electron |
| `chrome.power` | present | present | Electron (exposed, not exercised) |
| `chrome.printerProvider` | present | present | Electron (exposed, not exercised) |
| `chrome.privacy` | — | present | library (stub) |
| `chrome.processes` | — | — | not available |
| `chrome.proxy` | present | present | Electron (exposed, not exercised) |
| `chrome.readingList` | — | — | not available |
| `chrome.runtime` | present | present | Electron |
| `chrome.scripting` | present | present | Electron |
| `chrome.search` | — | — | not available |
| `chrome.sessions` | — | — | not available |
| `chrome.sidePanel` | — | present | shim |
| `chrome.storage` | present | present | Electron |
| `chrome.system.cpu` | present | present | Electron |
| `chrome.system.display` | present | present | Electron exposes it but every call fails: "System display API is not available." |
| `chrome.system.memory` | present | present | Electron |
| `chrome.system.storage` | present | present | Electron (exposed, not exercised) |
| `chrome.tabCapture` | — | — | not available |
| `chrome.tabGroups` | — | present | shim |
| `chrome.tabs` | present | present | Electron (query/update/sendMessage) + library (create/remove/…) + shim (group/ungroup/captureVisibleTab) |
| `chrome.topSites` | — | present | library (stub) |
| `chrome.tts` | — | — | not available |
| `chrome.ttsEngine` | — | — | not available |
| `chrome.userScripts` | — | — | not available |
| `chrome.webAuthenticationProxy` | — | — | not available |
| `chrome.webNavigation` | — | present | library |
| `chrome.webRequest` | present | present | Electron |
| `chrome.windows` | — | present | library |

## Real calls from the service worker

| Call | Bare Electron 45 | Chrome2 |
|---|---|---|
| `storage.local` | ok | ok |
| `storage.session` | ok | ok |
| `alarms (fires)` | ok | ok |
| `offscreen.createDocument` | ok | ok |
| `declarativeNetRequest.updateDynamicRules` | ok | ok |
| `system.display.getInfo` | error | error |
| `system.cpu.getInfo` | ok | ok |
| `system.memory.getInfo` | ok | ok |
| `idle.queryState` | ok | ok |
| `permissions.getAll` | ok | ok |
| `management.getSelf` | ok | ok |
| `scripting.getRegisteredContentScripts` | ok | ok |
| `tabs.query` | ok | ok |
| `windows.getAll` | error | ok |
| `cookies.getAll` | error | ok |
| `contextMenus.create` | error | ok |
| `action.setBadgeText` | ok | ok |
| `notifications.getAll` | error | ok |
| `webNavigation.getAllFrames` | error | ok |
| `debugger.getTargets` | error | ok |
| `sidePanel.getPanelBehavior` | error | ok |
| `tabGroups.query` | error | ok |
| `identity.getRedirectURL` | error | ok |
| `bookmarks.getTree` | error | error |
| `history.search` | error | error |
| `downloads.search` | error | error |
| `commands.getAll` | error | ok |
