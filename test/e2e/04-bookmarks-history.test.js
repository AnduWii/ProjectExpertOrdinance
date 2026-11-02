'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./harness');

test('[Bookmarks & history] stored locally as JSON', async (t) => {
  const server = await h.startServer();
  const userData = h.tempProfile('bh');
  let { app, ui } = await h.launch({ userData, home: `${server.origin}/` });
  t.after(async () => {
    await app.close().catch(() => {});
    await server.close();
  });
  const readJson = (name) => JSON.parse(fs.readFileSync(path.join(userData, name), 'utf8'));
  const active = async () => {
    const s = await h.mainState(app);
    return s.tabs.find((x) => x.id === s.activeId);
  };
  const go = async (url, title) => {
    await ui.fill('#address', url);
    await ui.press('#address', 'Enter');
    await h.waitUntil(async () => (await active()).title === title, { message: title });
  };

  await t.test('star bookmarks the page into bookmarks.json', async () => {
    await go(`${server.origin}/page1`, 'Page One');
    await ui.click('#bookmark-star');
    await h.waitUntil(async () => (await ui.getAttribute('#bookmark-star', 'aria-pressed')) === 'true', { message: 'star on' });
    const data = readJson('bookmarks.json');
    assert.equal(data.bookmarks.length, 1);
    assert.equal(data.bookmarks[0].url, `${server.origin}/page1`);
    assert.equal(data.bookmarks[0].title, 'Page One');
  });

  await t.test('bookmarks panel lists and opens bookmarks', async () => {
    await go(`${server.origin}/page2`, 'Page Two');
    assert.equal(await ui.getAttribute('#bookmark-star', 'aria-pressed'), 'false');
    await ui.click('#toggle-bookmarks');
    await ui.waitForSelector('#bookmark-list li');
    assert.match(await ui.textContent('#bookmark-list'), /Page One/);
    await ui.click('#bookmark-list li .open');
    await h.waitUntil(async () => (await active()).title === 'Page One', { message: 'opened bookmark' });
  });

  await t.test('bookmarks survive a restart', async () => {
    await app.close();
    ({ app, ui } = await h.launch({ userData, home: `${server.origin}/page1` }));
    await h.waitUntil(async () => (await active())?.title === 'Page One', { message: 'Page One after restart' });
    await h.waitUntil(async () => (await ui.getAttribute('#bookmark-star', 'aria-pressed')) === 'true', { message: 'still starred' });
  });

  await t.test('deleting from the panel updates bookmarks.json', async () => {
    await ui.click('#toggle-bookmarks');
    await ui.waitForSelector('#bookmark-list li');
    await ui.click('#bookmark-list li .remove');
    await h.waitUntil(async () => readJson('bookmarks.json').bookmarks.length === 0, { message: 'bookmark removed' });
    await h.waitUntil(async () => (await ui.getAttribute('#bookmark-star', 'aria-pressed')) === 'false', { message: 'star off' });
  });

  await t.test('visits are recorded in history.json with titles', async () => {
    await go(`${server.origin}/named/Alpha`, 'Alpha');
    await go(`${server.origin}/named/Beta`, 'Beta');
    await h.waitUntil(
      () => {
        const urls = readJson('history.json').entries.map((e) => `${e.title}|${e.url}`);
        return urls.includes(`Alpha|${server.origin}/named/Alpha`) && urls.includes(`Beta|${server.origin}/named/Beta`);
      },
      { message: 'history entries flushed' },
    );
  });

  await t.test('history panel lists newest first and searches', async () => {
    await ui.click('#toggle-history');
    await ui.waitForSelector('#history-list li');
    const first = await ui.textContent('#history-list li >> nth=0');
    assert.match(first, /Beta/);
    await ui.fill('#history-search', 'alpha');
    await h.waitUntil(async () => (await ui.$$('#history-list li')).length === 1, { message: 'filtered to one' });
    assert.match(await ui.textContent('#history-list'), /Alpha/);
    await ui.fill('#history-search', '');
    h.screenshot('history-panel');
  });

  await t.test('removing one entry and clearing all update history.json', async () => {
    await h.waitUntil(async () => (await ui.$$('#history-list li')).length > 1, { message: 'full list' });
    const before = readJson('history.json').entries.length;
    await ui.click('#history-list li >> nth=0 >> .remove');
    await h.waitUntil(() => readJson('history.json').entries.length === before - 1, { message: 'one removed' });
    await ui.click('#history-clear');
    await h.waitUntil(() => readJson('history.json').entries.length === 0, { message: 'history cleared' });
    await h.waitUntil(async () => !(await ui.isHidden('#history-empty')), { message: 'empty state' });
  });
});
