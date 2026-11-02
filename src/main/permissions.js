'use strict';

/**
 * Site permission prompts. Electron grants every permission request by
 * default (camera, microphone, location, ...), which is wrong for a browser.
 * Here: harmless permissions are allowed, sensitive ones prompt once per
 * origin (remembered until restart), everything else is denied. Installed
 * extensions get what they ask for, as their manifest already declared it.
 */

const { dialog, BrowserWindow } = require('electron');

const ALWAYS_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'persistent-storage', 'background-sync']);

const PROMPTS = {
  media: 'use your camera and/or microphone',
  geolocation: 'know your location',
  'geolocation-approximate': 'know your approximate location',
  notifications: 'show notifications',
  'clipboard-read': 'see text and images copied to the clipboard',
  'display-capture': 'see the contents of your screen',
  midi: 'use your MIDI devices',
  midiSysex: 'get full control of your MIDI devices',
  'idle-detection': 'know when you are actively using this device',
  'local-fonts': 'use the fonts installed on this device',
  'window-management': 'manage windows on all your displays',
  'screen-wake-lock': 'keep your screen on',
  keyboardLock: 'capture all keyboard input',
  openExternal: 'open an external application',
  'storage-access': 'use cookies and site data from other sites',
  'top-level-storage-access': 'use cookies and site data from other sites',
  'local-network-access': 'access devices on your local network',
  'local-network': 'access devices on your local network',
};

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
}

class PermissionManager {
  /**
   * @param {{session: Electron.Session, isInstalledExtension: (id: string) => boolean}} opts
   */
  constructor({ session, isInstalledExtension }) {
    this.session = session;
    this.isInstalledExtension = isInstalledExtension;
    this.decisions = new Map(); // "origin|permission" -> boolean
    this.pending = new Map(); // "origin|permission" -> Promise<boolean>
  }

  install() {
    this.session.setPermissionRequestHandler((wc, permission, callback, details) => {
      this.decide(wc, permission, details).then(callback, () => callback(false));
    });
    this.session.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      const origin = originOf(requestingOrigin);
      if (this.isExtensionOrigin(origin) || ALWAYS_ALLOW.has(permission)) return true;
      return this.decisions.get(`${origin}|${permission}`) === true;
    });
  }

  isExtensionOrigin(origin) {
    const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
    return !!m && this.isInstalledExtension(m[1]);
  }

  describe(permission, details) {
    if (permission === 'media') {
      const types = details?.mediaTypes || [];
      if (types.includes('video') && types.includes('audio')) return 'use your camera and microphone';
      if (types.includes('video')) return 'use your camera';
      if (types.includes('audio')) return 'use your microphone';
    }
    return PROMPTS[permission];
  }

  async decide(wc, permission, details = {}) {
    const origin = originOf(details.requestingUrl || wc.getURL());
    if (this.isExtensionOrigin(origin) || ALWAYS_ALLOW.has(permission)) return true;
    const what = this.describe(permission, details);
    if (!what || !/^https?:/.test(origin)) return false;

    const key = `${origin}|${permission}`;
    if (this.decisions.has(key)) return this.decisions.get(key);
    if (this.pending.has(key)) return this.pending.get(key);

    const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const prompt = dialog
      .showMessageBox(parent, {
        type: 'question',
        buttons: ['Allow', 'Block'],
        defaultId: 1,
        cancelId: 1,
        message: `${new URL(origin).host} wants to ${what}`,
        detail: 'Your choice is remembered for this site until the browser restarts.',
      })
      .then(({ response }) => {
        const allowed = response === 0;
        this.decisions.set(key, allowed);
        this.pending.delete(key);
        return allowed;
      });
    this.pending.set(key, prompt);
    return prompt;
  }
}

module.exports = { PermissionManager, ALWAYS_ALLOW, PROMPTS };
