'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

test('[Site permissions] sensitive permissions prompt instead of being auto-granted', async (t) => {
  const server = await h.startServer();
  const { app } = await h.launch({ userData: h.tempProfile('perm'), home: `${server.origin}/` });
  t.after(async () => {
    await app.close().catch(() => {});
    await server.close();
  });
  await h.waitUntil(async () => (await h.mainState(app)).tabs[0]?.title === 'Home Fixture', { message: 'home page' });
  const tabId = (await h.mainState(app)).activeId;

  // Replace the native prompt: answer with `response` and record what was asked.
  const stubPrompt = (response) =>
    app.evaluate(({ dialog }, r) => {
      globalThis.__prompts = [];
      dialog.showMessageBox = async (_win, opts) => {
        globalThis.__prompts.push(opts.message);
        return { response: r };
      };
    }, response);
  const requestNotifications = () =>
    app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('Notification.requestPermission()', true), tabId);

  await t.test('Block answers deny the request and are remembered', async () => {
    await stubPrompt(1);
    assert.equal(await requestNotifications(), 'denied');
    assert.equal(await requestNotifications(), 'denied');
    const prompts = await app.evaluate(() => globalThis.__prompts);
    assert.deepEqual(prompts, [`localhost:${server.port} wants to show notifications`], 'asked exactly once');
  });

  await t.test('Allow answers grant the request for that origin only', async () => {
    await stubPrompt(0);
    await app.evaluate(({ webContents }, [id, url]) => webContents.fromId(id).loadURL(url), [tabId, `http://127.0.0.1:${server.port}/page1`]);
    await h.waitUntil(async () => (await h.mainState(app)).tabs[0].title === 'Page One', { message: 'second origin' });
    assert.equal(await requestNotifications(), 'granted');
    const prompts = await app.evaluate(() => globalThis.__prompts);
    assert.deepEqual(prompts, [`127.0.0.1:${server.port} wants to show notifications`]);
  });

  await t.test('permissions with no prompt text are denied outright', async () => {
    const result = await app.evaluate(({ webContents }, id) =>
      webContents.fromId(id).executeJavaScript('navigator.permissions.query({ name: "camera" }).then((s) => s.state)', true), tabId);
    assert.notEqual(result, 'granted');
  });
});
