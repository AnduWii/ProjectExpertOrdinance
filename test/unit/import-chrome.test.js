'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { parseBookmarks, parseHistory, chromeTimeToIso, importFrom, listSources } = require('../../src/main/import-chrome');
const { Bookmarks, History } = require('../../src/main/store');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `chrome2-${name}-`));

function writeBookmarks(dir) {
  const data = {
    roots: {
      bookmark_bar: {
        type: 'folder',
        name: 'Bookmarks bar',
        children: [
          { type: 'url', name: 'Example', url: 'https://example.com/' },
          {
            type: 'folder',
            name: 'Work',
            children: [
              { type: 'url', name: 'Docs', url: 'https://docs.example.com/' },
              { type: 'url', name: 'Dup', url: 'https://example.com/' }, // duplicate URL
            ],
          },
          { type: 'url', name: 'JS', url: 'javascript:void(0)' }, // skipped (not http/file)
        ],
      },
      other: { type: 'folder', name: 'Other', children: [{ type: 'url', name: 'Other site', url: 'https://other.test/' }] },
      synced: { type: 'folder', name: 'Mobile', children: [] },
    },
  };
  fs.writeFileSync(path.join(dir, 'Bookmarks'), JSON.stringify(data));
}

// Chrome microseconds since 1601 for a given JS Date.
const toChromeTime = (date) => (date.getTime() + 11644473600000) * 1000;

function writeHistory(dir, rows) {
  const db = new DatabaseSync(path.join(dir, 'History'));
  db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INT, last_visit_time INT)');
  const insert = db.prepare('INSERT INTO urls (url, title, visit_count, last_visit_time) VALUES (?, ?, ?, ?)');
  for (const r of rows) insert.run(r.url, r.title, 1, toChromeTime(r.date));
  db.close();
}

test('parseBookmarks flattens folders, keeps order, dedupes, drops non-web URLs', () => {
  const dir = tmp('bm');
  writeBookmarks(dir);
  const items = parseBookmarks(path.join(dir, 'Bookmarks'));
  assert.deepEqual(
    items.map((b) => b.url),
    ['https://example.com/', 'https://docs.example.com/', 'https://other.test/'],
  );
  assert.equal(items[0].title, 'Example');
});

test('chromeTimeToIso converts the 1601 microsecond epoch', () => {
  const when = new Date('2026-01-02T03:04:05.000Z');
  assert.equal(chromeTimeToIso(toChromeTime(when)), when.toISOString());
});

test('parseHistory reads newest-first and survives a live -wal sidecar', () => {
  const dir = tmp('hist');
  writeHistory(dir, [
    { url: 'https://a.test/', title: 'A', date: new Date('2026-01-01T00:00:00Z') },
    { url: 'https://b.test/', title: 'B', date: new Date('2026-02-01T00:00:00Z') },
  ]);
  fs.writeFileSync(path.join(dir, 'History-wal'), 'pretend wal'); // copied, not parsed
  const rows = parseHistory(path.join(dir, 'History'), { tmpDir: tmp('scratch') });
  assert.deepEqual(rows.map((r) => r.url), ['https://b.test/', 'https://a.test/']);
  assert.equal(rows[0].visitedAt, '2026-02-01T00:00:00.000Z');
});

test('importFrom merges bookmarks and history into the stores, skipping duplicates', () => {
  const src = tmp('profile');
  writeBookmarks(src);
  writeHistory(src, [
    { url: 'https://a.test/', title: 'A', date: new Date('2026-01-01T00:00:00Z') },
    { url: 'https://b.test/', title: 'B', date: new Date('2026-03-01T00:00:00Z') },
  ]);

  const profile = tmp('chrome2');
  const bookmarks = new Bookmarks(profile);
  const history = new History(profile);
  bookmarks.add({ url: 'https://example.com/', title: 'Already here' }); // pre-existing dup
  history.add({ url: 'https://b.test/', title: 'B already' });

  const result = importFrom(src, { bookmarks, history }, { tmpDir: tmp('scratch') });
  assert.equal(result.bookmarksAdded, 2, 'example.com already present, so only 2 new');
  assert.equal(result.historyAdded, 1, 'b.test already present, so only a.test added');
  assert.deepEqual(result.errors, []);

  // Reload from disk to confirm it persisted.
  assert.equal(new Bookmarks(profile).list().length, 3);
  const urls = new History(profile).list().map((e) => e.url);
  assert.ok(urls.includes('https://a.test/') && urls.includes('https://b.test/'));
});

test('importFrom can import only bookmarks', () => {
  const src = tmp('profile2');
  writeBookmarks(src);
  writeHistory(src, [{ url: 'https://a.test/', title: 'A', date: new Date() }]);
  const profile = tmp('chrome2b');
  const stores = { bookmarks: new Bookmarks(profile), history: new History(profile) };
  const result = importFrom(src, stores, { history: false, tmpDir: tmp('scratch') });
  assert.ok(result.bookmarksAdded > 0);
  assert.equal(result.historyAdded, 0);
});

test('listSources returns an array and never throws when nothing is installed', () => {
  assert.ok(Array.isArray(listSources()));
});
