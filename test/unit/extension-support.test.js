'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { unsupportedPermissions } = require('../../src/main/extension-support');

test('flags permissions with no working API', () => {
  const manifest = {
    permissions: ['storage', 'tabs', 'debugger', 'sidePanel', 'bookmarks', 'downloads', 'accessibilityFeatures.read', 'activeTab'],
    optional_permissions: ['history', 'https://example.com/*'],
  };
  assert.deepEqual(unsupportedPermissions(manifest).sort(), ['accessibilityFeatures.read', 'bookmarks', 'downloads', 'history']);
});

test('a manifest with only supported permissions has no warnings', () => {
  assert.deepEqual(unsupportedPermissions({ permissions: ['storage', 'scripting', 'tabGroups', 'identity', 'alarms'] }), []);
  assert.deepEqual(unsupportedPermissions({}), []);
});
