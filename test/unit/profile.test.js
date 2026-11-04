'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateLegacyProfile } = require('../../src/main/profile');

const appData = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chrome2-appdata-'));

test('moves the "Ordinance Browser" profile into the new Chrome2 folder', () => {
  const root = appData();
  const legacy = path.join(root, 'Ordinance Browser');
  fs.mkdirSync(path.join(legacy, 'Partitions', 'ordinance'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'bookmarks.json'), '{"version":1,"bookmarks":[{"url":"https://a.test/"}]}');
  const current = path.join(root, 'Chrome2');
  // Electron may already have created an empty folder for the new name.
  fs.mkdirSync(current);

  assert.equal(migrateLegacyProfile(root, current), legacy);
  assert.match(fs.readFileSync(path.join(current, 'bookmarks.json'), 'utf8'), /a\.test/);
  assert.ok(fs.existsSync(path.join(current, 'Partitions', 'ordinance')), 'cookies/logins moved too');
  assert.ok(fs.existsSync(path.join(legacy, 'MOVED.txt')));
});

test('never overwrites a Chrome2 profile that is already in use', () => {
  const root = appData();
  fs.mkdirSync(path.join(root, 'Ordinance Browser'));
  fs.writeFileSync(path.join(root, 'Ordinance Browser', 'history.json'), 'old');
  fs.mkdirSync(path.join(root, 'Chrome2'));
  fs.writeFileSync(path.join(root, 'Chrome2', 'history.json'), 'new');
  assert.equal(migrateLegacyProfile(root, path.join(root, 'Chrome2')), null);
  assert.equal(fs.readFileSync(path.join(root, 'Chrome2', 'history.json'), 'utf8'), 'new');
});

test('does nothing when there is no old profile', () => {
  const root = appData();
  assert.equal(migrateLegacyProfile(root, path.join(root, 'Chrome2')), null);
});
