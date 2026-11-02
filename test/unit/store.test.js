'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Bookmarks, History, Settings } = require('../../src/main/store');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ordinance-store-'));

test('bookmarks persist to bookmarks.json and survive reload', () => {
  const dir = tmpDir();
  const b = new Bookmarks(dir);
  b.add({ url: 'https://a.test/', title: 'A' });
  b.add({ url: 'https://a.test/', title: 'dupe' });
  b.add({ url: 'https://b.test/', title: 'B' });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'bookmarks.json'), 'utf8'));
  assert.equal(onDisk.bookmarks.length, 2);
  const again = new Bookmarks(dir);
  assert.deepEqual(again.list().map((x) => x.title), ['A', 'B']);
  assert.equal(again.toggle({ url: 'https://a.test/' }), false);
  assert.equal(new Bookmarks(dir).has('https://a.test/'), false);
});

test('history records http(s) only, collapses repeats, newest first', () => {
  const dir = tmpDir();
  const h = new History(dir);
  h.add({ url: 'https://one.test/', title: 'One' });
  h.add({ url: 'https://one.test/', title: 'One again' });
  h.add({ url: 'data:text/html,hi' });
  h.add({ url: 'chrome-extension://abc/page.html' });
  h.add({ url: 'https://two.test/', title: 'Two' });
  h.flush();
  const list = new History(dir).list();
  assert.deepEqual(list.map((e) => e.url), ['https://two.test/', 'https://one.test/']);
  assert.equal(list[1].title, 'One again');
  assert.equal(h.list({ query: 'two' }).length, 1);
  h.clear();
  assert.equal(new History(dir).list().length, 0);
});

test('history is capped at maxEntries', () => {
  const h = new History(tmpDir(), { maxEntries: 3 });
  for (let i = 0; i < 5; i++) h.add({ url: `https://x.test/${i}` });
  assert.deepEqual(h.list().map((e) => e.url), ['https://x.test/4', 'https://x.test/3', 'https://x.test/2']);
  h.flush();
});

test('corrupt JSON is moved aside, not fatal', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'bookmarks.json'), '{not json');
  const b = new Bookmarks(dir);
  assert.equal(b.list().length, 0);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('bookmarks.json.corrupt-')));
});

test('settings default to DuckDuckGo home/search', () => {
  const s = new Settings(tmpDir());
  assert.equal(s.get('homePage'), 'https://duckduckgo.com/');
  assert.equal(s.get('searchUrl'), 'https://duckduckgo.com/?q=');
  assert.deepEqual(s.get('extensions'), []);
});
