# Ordinance Browser

A minimal desktop web browser built on Electron 45.2.1 (Chromium 156 engine) with tabs, an address bar, bookmarks, history, and Chrome extension support. It also adds compatibility shims so agent-style extensions such as **Claude in Chrome** have the side panel, debugger and tab-group APIs they rely on.

![Ordinance Browser with an extension side panel open](docs/screenshot.png)

## Features

| Area | What you get |
|---|---|
| Tabs | Open (`+`, Ctrl/Cmd+T), close (`×`, middle-click, Ctrl/Cmd+W), switch (click, Ctrl+Tab), drag to reorder. Links that open new windows become tabs next to their opener; real popups (e.g. OAuth) stay popups. |
| Address bar | Accepts URLs (`example.com`, `localhost:3000`, `https://…`) or search terms, which go to **DuckDuckGo**. Back, forward, reload/stop and home buttons. Unreachable pages show an error page that keeps the URL. |
| Robustness | Video/HTML fullscreen hides the toolbar and fills the window (Esc exits). A crashed tab shows a "This page crashed" page and Reload brings it back. |
| Bookmarks | Star button (Ctrl/Cmd+D) and a Bookmarks panel. Stored in `bookmarks.json`. |
| History | Every page visit, newest first, searchable, single delete or clear all. Stored in `history.json`. |
| Extensions | **Load unpacked…** from a folder with `session.extensions.loadExtension`. Extensions are re-loaded on every start, with toolbar buttons, popups, side panels and content scripts. Permissions this browser can't honour are flagged in the Extensions panel. |
| Agent extension support | `chrome.debugger` (CDP), `chrome.sidePanel`, `chrome.tabGroups`, `chrome.tabs.group/captureVisibleTab`, `chrome.identity.launchWebAuthFlow`, with Chrome's "… started debugging this tab" banner and its Cancel button. |
| Site permissions | Camera, microphone, location, notifications and similar requests ask Allow/Block once per site. Electron would otherwise grant them all silently. |

## Requirements

* Node.js 22 (tested with 22.23.4) and npm 10
* Runs on Windows 10+, macOS 13 (Ventura)+ and Linux x64/arm64, matching Electron 45's support matrix

All dependency versions are pinned exactly (`.npmrc` has `save-exact=true`):

| Package | Version | Why |
|---|---|---|
| `electron` | 45.2.1 | Chromium engine and runtime |
| `electron-chrome-extensions` | 4.10.0 | `chrome.tabs`, `windows`, `action`, `contextMenus`, `cookies`, `notifications`, `webNavigation`, native messaging |
| `electron-builder` (dev) | 26.18.0 | Windows/macOS packaging |
| `playwright-core` (dev) | 1.64.1 | End-to-end tests (Electron driver, no browser downloads) |

## Setup

```bash
git clone https://github.com/AnduWii/ProjectExpertOrdinance.git
```

```bash
cd ProjectExpertOrdinance
```

```bash
npm ci
```

```bash
npm start
```

`npm start` opens the browser on the home page (DuckDuckGo). Pass URLs to open them as tabs: `npm start -- https://example.com`.

### Where your data lives

Everything is plain JSON in the app's user-data folder:

| OS | Folder |
|---|---|
| Windows | `%APPDATA%\Ordinance Browser` |
| macOS | `~/Library/Application Support/Ordinance Browser` |
| Linux | `~/.config/Ordinance Browser` |

* `bookmarks.json`: `{ "version": 1, "bookmarks": [{ "id", "url", "title", "createdAt" }] }`
* `history.json`: `{ "version": 1, "entries": [{ "id", "url", "title", "visitedAt" }] }`. Capped at 5,000 entries; repeat visits to the same URL are collapsed.
* `settings.json`: `homePage`, `searchUrl` (default `https://duckduckgo.com/?q=`), `extensions` (folders to load at start-up) and `ignoredExtensions` (drop-in folders you removed)
* `extensions/`: any unpacked extension folder dropped here is loaded automatically. Removing one in the Extensions panel keeps it removed after a restart.

If a saved extension can't be loaded at start-up (for example, its folder was moved), the Extensions panel lists it with the error and a button to forget it.

Writes are atomic (temp file + rename). A corrupt file is renamed to `*.corrupt-<timestamp>`, not overwritten.

### Keyboard shortcuts

| Action | Windows / Linux | macOS |
|---|---|---|
| New tab / close tab | Ctrl+T / Ctrl+W | ⌘T / ⌘W |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab | same |
| Focus address bar | Ctrl+L | ⌘L |
| Reload | Ctrl+R, F5 | ⌘R |
| Back / forward | Alt+← / Alt+→ | ⌘[ / ⌘] |
| Home | Alt+Home | ⇧⌘H |
| Bookmark page / bookmarks panel | Ctrl+D / Ctrl+Shift+O | ⌘D / ⇧⌘O |
| History panel | Ctrl+H | ⌘Y |
| Page DevTools | Ctrl+Shift+I | ⌥⌘I |

## Extensions

1. Click the **grid icon** in the toolbar, then click **Load unpacked…**.
2. Pick the folder that contains `manifest.json`.
3. The extension's button appears in the toolbar. Click it to open its popup, its side panel, or fire `chrome.action.onClicked`.

The browser loads extensions with `session.extensions.loadExtension`. Electron 36 deprecated `session.loadExtension` and moved it to `session.extensions`; the code falls back to the old call on older Electron. Electron does not remember extensions between runs, so the browser saves the folder path in `settings.json` and re-loads it on start.

Only unpacked extensions work. `.crx` files and the Chrome Web Store do not.

### Manifest V3 APIs Electron does not support

Measured, not copied from docs. A probe extension requesting every MV3 permission ran in bare Electron 45.2.1 and inside this browser; see [docs/extension-api-support.md](docs/extension-api-support.md) for the full tables and raw JSON.

**Missing from Electron 45 itself.** Bare `session.extensions.loadExtension` gives no namespace for any of these:
`accessibilityFeatures`, `bookmarks`, `browsingData`, `commands`, `contentSettings`, `contextMenus`, `cookies`, `debugger`, `declarativeContent`, `desktopCapture`, `downloads`, `fontSettings`, `gcm`, `history`, `identity`, `instanceID`, `notifications`, `omnibox`, `pageCapture`, `privacy`, `processes`, `readingList`, `search`, `sessions`, `sidePanel`, `tabCapture`, `tabGroups`, `topSites`, `tts`, `ttsEngine`, `userScripts`, `webAuthenticationProxy`, `webNavigation`, `windows`.
Electron's `chrome.tabs` lacks `create`, `remove`, `group`, `ungroup` and `captureVisibleTab`. `chrome.system.display` exists but every call fails. `chrome.storage.managed` is unsupported.

**What this browser adds back:**

* `electron-chrome-extensions`: `contextMenus`, `cookies`, `notifications`, `webNavigation`, `windows`, the rest of `chrome.tabs`, `action` popups/onClicked, and `runtime.connectNative`
* Its own shims: `debugger`, `sidePanel`, `tabGroups`, `identity` (`launchWebAuthFlow`, `getRedirectURL`), `tabs.group/ungroup/captureVisibleTab`

**Still unsupported here:** `accessibilityFeatures`, `bookmarks`, `browsingData`, `contentSettings`, `declarativeContent`, `desktopCapture`, `fontSettings`, `gcm`, `history`, `instanceID`, `omnibox`, `pageCapture`, `processes`, `readingList`, `search`, `sessions`, `tabCapture`, `tts`, `ttsEngine`, `userScripts`, `webAuthenticationProxy`.
`downloads`, `privacy`, `topSites` and `commands` exist only as no-op stubs from electron-chrome-extensions, so extension keyboard shortcuts never fire. `system.display` always errors.

Working in bare Electron 45, though its docs don't list them: `alarms` (fires), `offscreen`, `declarativeNetRequest` dynamic rules, `idle`, `system.cpu`, `system.memory`, `storage.session`.

## Claude in Chrome

**Status: the APIs it relies on are implemented and tested with a stand-in extension. Claude in Chrome itself has not been run in this browser.** The build environment could not download it: the network policy blocks the Chrome Web Store. The real extension may still fail for reasons nobody can see until it runs. Anthropic officially supports Claude in Chrome on Google Chrome only, and an extension update can break things at any time.

What is covered, and tested end-to-end by [`test/e2e/05-agent-extension.test.js`](test/e2e/05-agent-extension.test.js) using [`test/fixtures/extensions/agent-standin`](test/fixtures/extensions/agent-standin):

* Toolbar click opens the extension's side panel (`side_panel.default_path` + `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`)
* `chrome.debugger.attach` / `sendCommand` / `onEvent` / `detach`, driving a tab via CDP: `Runtime.evaluate`, `Page.captureScreenshot`, `Input.dispatchMouseEvent` clicks, `Input.insertText` typing, `Page.reload` events. Chrome's error for a second attach and the "is debugging this tab" banner are both reproduced.
* `chrome.tabs.create` + `tabs.group` + `tabGroups.update` (the group colour shows on the tab), `scripting.executeScript`, `tabs.captureVisibleTab`, `storage`, `identity.launchWebAuthFlow`
* None of these shims leak into normal web pages

To try it:

1. In Google Chrome, install Claude in Chrome, open `chrome://extensions`, turn on **Developer mode**, and note its ID and version.
2. Copy the installed folder somewhere stable. Chrome keeps it at:
   * macOS: `~/Library/Application Support/Google/Chrome/Default/Extensions/<id>/<version>_0`
   * Windows: `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\<id>\<version>_0`
   * Linux: `~/.config/google-chrome/Default/Extensions/<id>/<version>_0`
3. In Ordinance Browser, use **Load unpacked…** on that copy. Folders copied from a Chrome profile, including their `_metadata` directory, load unchanged. If the manifest has a `key` field, the extension keeps its Chrome ID, which its sign-in redirects and native-messaging hosts depend on.
4. Sign in to claude.ai in a tab of this browser. Cookies live in this browser's profile, not Chrome's.

Known gaps that may matter for it:

* **Claude Code / Claude Desktop integration** uses native messaging. electron-chrome-extensions looks for host manifests in Chrome's locations (`NativeMessagingHosts` folders on macOS/Linux, the HKCU/HKLM `Software\Google\Chrome\NativeMessagingHosts` registry keys on Windows) and in `<user data>/NativeMessagingHosts`. A host only answers if its `allowed_origins` lists the extension ID, so the ID must match (see step 3). This path is untested.
* No automatic updates: copy a new version and load it again.
* Not implemented: per-tab side-panel switching (the panel is per window), `tabs.onMoved` events, and the `downloads`, `history`, `bookmarks`, `tabCapture`, `desktopCapture` and `system.display` APIs. If the extension needs one of these, that feature will not work.

## Build installers

```bash
npm run dist:win
```

```bash
npm run dist:mac
```

Outputs land in `dist/`:

| Command | Produces |
|---|---|
| `npm run dist:win` | `Ordinance Browser-<ver>-win-x64.exe` and `-win-arm64.exe` (NSIS installers), a combined `-win.exe`, and `.zip` portable builds |
| `npm run dist:mac` | `-mac-x64.dmg`, `-mac-arm64.dmg` and matching `.zip` files, **ad-hoc signed** |
| `npm run dist:mac:signed` | Same, signed with the Developer ID certificate in your keychain or `CSC_LINK`, hardened runtime on. Notarisation is not configured. |
| `npm run dist:linux` | x64 AppImage |
| `npm run pack` | Unpacked app for the current OS (quick smoke test) |

Notes:

* **Build on the target OS.** DMGs need macOS (`hdiutil`, `sips`). From Linux, electron-builder can make macOS `.zip` files but cannot sign them, and Apple-silicon Macs refuse unsigned modified apps. Windows installers can be built on Linux or macOS only with Wine (64- and 32-bit) installed; the `.zip` targets need nothing extra.
* **Code signing.** Without certificates the Windows installer triggers SmartScreen and the ad-hoc-signed Mac app triggers Gatekeeper on other machines. On macOS 15+ open it once, then use **System Settings → Privacy & Security → Open Anyway** (right-click → Open no longer bypasses Gatekeeper), or run `xattr -dr com.apple.quarantine "/Applications/Ordinance Browser.app"`. electron-builder 26 does not ad-hoc sign by itself, which is why `dist:mac` passes `-c.mac.identity=-`.
* **CI.** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs unit and end-to-end tests on Ubuntu, then builds natively on `windows-2025` and `macos-15` and uploads the installers as workflow artifacts. Actions are pinned to commit SHAs.

## Tests

```bash
npm test
```

```bash
npm run test:e2e
```

* `npm test`: unit tests for URL/search parsing, the JSON stores and the extension support table (Node's built-in test runner)
* `npm run test:e2e`: launches the real app with Playwright's Electron driver and exercises tabs, navigation, extensions, bookmarks/history, the agent stand-in, site permissions, fullscreen, crash recovery and extension load errors. Set `ORDINANCE_APP_PATH=/path/to/packaged/binary` to test a packaged build instead of `electron .`.

On Linux the e2e suite needs a display (`xvfb-run -a npm run test:e2e` on a headless box) and **must not run as root**. Chromium refuses to run as root unless given `--no-sandbox`, and Electron skips service-worker preloads without the sandbox, which breaks every MV3 extension API this browser adds. On Ubuntu 24.04 you may also need `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`. The harness launches with `chromiumSandbox: true` for the same reason; Playwright otherwise adds `--no-sandbox` on Linux.

## Known limitations

* **Extensions:** unpacked only; no Chrome Web Store, `.crx` files or auto-update. See the unsupported API list above. Extensions are not available in private/in-memory sessions (an Electron restriction), so there is no incognito mode. Per electron-chrome-extensions, MV2 background pages are always persistent. If the app's own `session.webRequest` is used, `chrome.webRequest` listeners stop firing.
* **Address bar:** no suggestions or autocomplete. Host detection is heuristic: `node.js` is treated as a domain because there is no public-suffix list.
* **Browser features not built:** downloads manager UI (Electron shows a plain save dialog), password manager, autofill, sync, reader mode, multiple profiles, session restore, tab pinning, tab drag between windows, and a visible collapse/title UI for tab groups (only the colour shows).
* **Site permissions** are remembered only until restart, with no settings page to review them.
* **Security model:** tabs run sandboxed with context isolation and no Node.js. The toolbar UI talks to the main process over a fixed IPC allow-list. Extension shims check the calling extension's manifest permissions in the main process. Electron's Chromium is patched on Electron's release schedule, not Chrome's, so keep `electron` current.
* **Sites that sniff the browser:** the user agent drops the `Electron/` token so sites see a normal Chrome UA, but `navigator.userAgentData.brands` still differs from Google Chrome.

## Project layout

```
src/main/main.js            app start-up, IPC, menu, extension wiring
src/main/window.js          one window: tab views, side panel, layout
src/main/url.js             address-bar input -> URL or DuckDuckGo search
src/main/store.js           bookmarks/history/settings JSON files
src/main/extensions.js      load/remove/persist unpacked extensions
src/main/extension-support.js  measured API support table
src/main/compat/index.js    debugger, sidePanel, tabGroups, identity (main side)
src/main/permissions.js     site permission prompts
src/preload/ui-preload.js   toolbar UI bridge
src/preload/compat-preload.js  extension API shims (extension contexts only)
src/renderer/               toolbar UI (HTML/CSS/JS)
test/unit, test/e2e         tests; test/fixtures/extensions holds test extensions
```

## License

MIT. See [LICENSE](LICENSE).
