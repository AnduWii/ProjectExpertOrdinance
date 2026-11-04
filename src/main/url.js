'use strict';

/**
 * Turns whatever the user typed into the address bar into a URL to load.
 * Anything that does not look like a URL becomes a Google search.
 */

const DEFAULT_SEARCH_URL = 'https://www.google.com/search?q=';

// Schemes the address bar may navigate to directly. Notably absent:
// `javascript:` (never run script from the omnibox) and `data:`.
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'file:', 'chrome-extension:']);

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;
const TLD = /^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i;

function searchUrl(text, base = DEFAULT_SEARCH_URL) {
  return base + encodeURIComponent(text);
}

function looksLikeHost(host) {
  const bare = host.replace(/:\d{1,5}$/, '');
  if (bare.toLowerCase() === 'localhost') return true;
  if (IPV4.test(bare)) return bare.split('.').every((n) => Number(n) <= 255);
  if (/^\[[0-9a-f:.]+\]$/i.test(bare)) return true; // [IPv6]
  const labels = bare.split('.');
  if (labels.length < 2) return false;
  if (!TLD.test(labels[labels.length - 1])) return false;
  return labels.every((l) => HOST_LABEL.test(l));
}

/**
 * @param {string} input raw address-bar text
 * @param {string} [searchBase] search URL prefix; the query is appended URL-encoded
 * @returns {string|null} absolute URL to load, or null for empty input
 */
function normalizeInput(input, searchBase = DEFAULT_SEARCH_URL) {
  const text = String(input ?? '').trim();
  if (!text) return null;

  if (text.toLowerCase() === 'about:blank') return 'about:blank';

  // Explicit scheme, e.g. https://example.com or file:///tmp/x.html
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (ALLOWED_SCHEMES.has(url.protocol)) return url.href;
    } catch {
      /* fall through to search */
    }
    return searchUrl(text, searchBase);
  }

  // Whitespace means it is a query, not an address.
  if (/\s/.test(text)) return searchUrl(text, searchBase);

  // Bare host, optionally with port and path: example.com, localhost:3000/a
  const hostPart = text.split(/[/?#]/, 1)[0];
  if (looksLikeHost(hostPart)) {
    const bare = hostPart.replace(/:\d{1,5}$/, '').toLowerCase();
    const isLocal = bare === 'localhost' || IPV4.test(bare) || bare.startsWith('[');
    try {
      return new URL(`${isLocal ? 'http' : 'https'}://${text}`).href;
    } catch {
      return searchUrl(text, searchBase);
    }
  }

  return searchUrl(text, searchBase);
}

module.exports = { normalizeInput, searchUrl, DEFAULT_SEARCH_URL };
