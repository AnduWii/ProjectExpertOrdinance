'use strict';

/**
 * Runs only on chromewebstore.google.com (registered with a URL match in
 * main.js). The store shows "Switch to Chrome to install extensions" unless
 * the browser's client-hint brands include "Google Chrome". Electron reports
 * only "Chromium", so present the brand list Google Chrome would.
 * electron-chrome-web-store already adjusts navigator.userAgent here.
 */

const { contextBridge } = require('electron');

function presentAsChrome(version) {
  const major = String(version).split('.')[0];
  const brands = [
    { brand: 'Google Chrome', version: major },
    { brand: 'Chromium', version: major },
    { brand: 'Not_A Brand', version: '24' },
  ];
  const fullVersionList = [
    { brand: 'Google Chrome', version },
    { brand: 'Chromium', version },
    { brand: 'Not_A Brand', version: '24.0.0.0' },
  ];
  const real = navigator.userAgentData;
  const platform = real ? real.platform : '';
  const data = {
    brands,
    mobile: false,
    platform,
    async getHighEntropyValues(hints) {
      const base = real ? await real.getHighEntropyValues(hints) : {};
      return { ...base, brands, fullVersionList, uaFullVersion: version };
    },
    toJSON() {
      return { brands, mobile: false, platform };
    },
  };
  Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => data, configurable: true });
}

if (typeof location !== 'undefined' && location.hostname === 'chromewebstore.google.com') {
  try {
    contextBridge.executeInMainWorld({ func: presentAsChrome, args: [process.versions.chrome] });
  } catch (err) {
    console.error('[chrome2] web store brand override failed', err);
  }
}
