'use strict';

// Import bookmarks and history from another Chromium browser. A fake Chrome
// profile is built on disk, then the real in-app flow runs with the native
// dialogs stubbed to make choices.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const h = require('./harness');

const toChromeTime = (date) => (date.getTime() + 11644473600000) * 1000;

function fakeChromeProfile(dir = h.tempProfile('fake-chrome')) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'Bookmarks'),
    JSON.stringify({
      roots: {
        bookmark_bar: {
          type: 'folder',
          name: 'Bookmarks bar',
          children: [
            { type: 'url', name: 'Imported One', url: 'https://imported-one.test/' },
            { type: 'folder', name: 'Folder', children: [{ type: 'url', name: 'Imported Two', url: 'https://imported-two.test/' }] },
          ],
        },
        other: { type: 'folder', children: [] },
        synced: { type: 'folder', children: [] },
      },
    }),
  );
  const db = new DatabaseSync(path.join(dir, 'History'));
  db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INT, last_visit_time INT)');
  const ins = db.prepare('INSERT INTO urls (url, title, visit_count, last_visit_time) VALUES (?, ?, 1, ?)');
  ins.run('https://history-a.test/', 'History A', toChromeTime(new Date('2026-01-01T00:00:00Z')));
  ins.run('https://history-b.test/', 'History B', toChromeTime(new Date('2026-05-01T00:00:00Z')));
  db.close();
  return dir;
}

// Make runImportFlow use our fake profile and answer the native dialogs.
// `folder` is what the "Choose Folder…" picker returns (null = cancelled).
async function arrange(app, { source, responses, folder = null }) {
  await app.evaluate(
    ({ dialog }, [src, resp, picked]) => {
      const ctx = globalThis.__ordinance.ctx;
      ctx.importSourcesOverride = src ? [{ id: src, browser: 'Google Chrome', profile: 'Default', bookmarkCount: 2, hasHistory: true }] : [];
      globalThis.__dialogs = [];
      let i = 0;
      dialog.showMessageBox = async (_win, opts) => {
        globalThis.__dialogs.push({ message: opts.message, buttons: opts.buttons, detail: opts.detail });
        return { response: resp[i++] ?? 0 };
      };
      dialog.showOpenDialog = async (_win, opts) => {
        globalThis.__dialogs.push({ picker: true, defaultPath: opts.defaultPath, properties: opts.properties });
        return picked ? { canceled: false, filePaths: [picked] } : { canceled: true, filePaths: [] };
      };
    },
    [source, responses, folder],
  );
}

test('[Import] bookmarks and history from another browser', async (t) => {
  const server = await h.startServer();
  const userData = h.tempProfile('import');
  const { app, ui } = await h.launch({ userData, home: `${server.origin}/` });
  t.after(async () => {
    await app.close().catch(() => {});
    await server.close();
  });
  const readJson = (name) => JSON.parse(fs.readFileSync(path.join(userData, name), 'utf8'));

  await t.test('"Import from another browser…" lives in the Bookmarks panel', async () => {
    await ui.click('#toggle-bookmarks');
    await ui.waitForSelector('#import-browser');
    assert.equal(await ui.textContent('#import-browser'), 'Import from another browser…');
  });

  await t.test('importing Bookmarks + History fills both stores', async () => {
    const src = fakeChromeProfile();
    await arrange(app, { source: src, responses: [0, 0] }); // pick profile 0, then "Bookmarks + History"
    await ui.click('#import-browser');
    await h.waitUntil(() => readJson('bookmarks.json').bookmarks.length === 2, { message: 'bookmarks imported' });
    const bookmarks = readJson('bookmarks.json').bookmarks.map((b) => b.url);
    assert.deepEqual(bookmarks, ['https://imported-one.test/', 'https://imported-two.test/']);
    const history = readJson('history.json').entries.map((e) => e.url);
    assert.ok(history.includes('https://history-a.test/') && history.includes('https://history-b.test/'));

    // The dialogs explained what is and isn't copied.
    const dialogs = await app.evaluate(() => globalThis.__dialogs);
    assert.match(dialogs[0].detail, /never passwords, cookies or logins/i);
    assert.match(dialogs[dialogs.length - 1].message, /Import complete/);
    assert.match(dialogs[dialogs.length - 1].detail, /Added 2 bookmarks and 2 history entries/);

    // The bookmarks panel refreshed to show them.
    await h.waitUntil(async () => (await ui.$$('#bookmark-list li')).length === 2, { message: 'panel shows imported bookmarks' });
  });

  await t.test('re-importing adds nothing (dedupe) and says so', async () => {
    const src = fakeChromeProfile();
    await arrange(app, { source: src, responses: [0, 0] });
    await ui.click('#import-browser');
    await h.waitUntil(async () => (await app.evaluate(() => globalThis.__dialogs)).some((d) => /Import complete/.test(d.message)), { message: 'completed' });
    const dialogs = await app.evaluate(() => globalThis.__dialogs);
    assert.match(dialogs[dialogs.length - 1].detail, /Added 0 bookmarks and 0 history entries/);
    assert.equal(readJson('bookmarks.json').bookmarks.length, 2);
  });

  await t.test('"Bookmarks only" skips history', async () => {
    const src = fakeChromeProfile();
    // Add a fresh history URL so we can prove it was NOT imported.
    const db = new DatabaseSync(path.join(src, 'History'));
    db.prepare('INSERT INTO urls (url, title, visit_count, last_visit_time) VALUES (?, ?, 1, ?)').run(
      'https://should-not-import.test/',
      'Nope',
      toChromeTime(new Date('2026-06-01T00:00:00Z')),
    );
    db.close();
    await arrange(app, { source: src, responses: [0, 1] }); // pick profile 0, then "Bookmarks only"
    await ui.click('#import-browser');
    await h.waitUntil(async () => (await app.evaluate(() => globalThis.__dialogs)).some((d) => /Import complete/.test(d.message)), { message: 'completed' });
    assert.ok(!readJson('history.json').entries.some((e) => e.url === 'https://should-not-import.test/'));
  });

  await t.test('with no other browser installed, it says so and changes nothing', async () => {
    await arrange(app, { source: null, responses: [1] }); // "Cancel"
    const before = readJson('bookmarks.json').bookmarks.length;
    await ui.click('#import-browser');
    await h.waitUntil(async () => (await app.evaluate(() => globalThis.__dialogs)).length === 1, { message: 'info dialog' });
    const [dialog] = await app.evaluate(() => globalThis.__dialogs);
    assert.match(dialog.message, /No other browser found/);
    assert.deepEqual(dialog.buttons, ['Choose Folder…', 'Cancel']);
    assert.equal(readJson('bookmarks.json').bookmarks.length, before);
  });

  await t.test('"Choose Folder…" imports from a browser folder you pick', async () => {
    // Chrome's own folder (not the profile inside it), laid out as on macOS,
    // the way you'd pick it in Finder.
    const chromeDir = path.join(h.tempProfile('picked'), 'Library', 'Application Support', 'Google', 'Chrome');
    const profileDir = fakeChromeProfile(path.join(chromeDir, 'Default'));
    fs.writeFileSync(
      path.join(profileDir, 'Bookmarks'),
      JSON.stringify({
        roots: {
          bookmark_bar: { type: 'folder', children: [{ type: 'url', name: 'Picked', url: 'https://picked-folder.test/' }] },
          other: { type: 'folder', children: [] },
          synced: { type: 'folder', children: [] },
        },
      }),
    );
    fs.writeFileSync(path.join(chromeDir, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Person 1' } } } }));

    // "Choose Folder…" → picker returns chromeDir → one profile, so straight to "Bookmarks + History".
    await arrange(app, { source: null, responses: [0, 0], folder: chromeDir });
    await ui.click('#import-browser');
    await h.waitUntil(async () => (await app.evaluate(() => globalThis.__dialogs)).some((d) => /Import complete/.test(d.message || '')), {
      message: 'import via picked folder completed',
    });
    const dialogs = await app.evaluate(() => globalThis.__dialogs);
    const picker = dialogs.find((d) => d.picker);
    assert.ok(picker, 'the folder picker opened');
    assert.ok(picker.properties.includes('openDirectory'));
    assert.match(dialogs.find((d) => /^Import from /.test(d.message || '')).message, /Google Chrome — Person 1/);
    assert.match(dialogs[dialogs.length - 1].detail, /Added 1 bookmark and/);
    assert.ok(readJson('bookmarks.json').bookmarks.some((b) => b.url === 'https://picked-folder.test/'));
  });
});
