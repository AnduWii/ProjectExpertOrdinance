'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

test('[Address bar & navigation] URLs, Google search, back, forward, reload, home', async (t) => {
  const server = await h.startServer();
  const { app, ui } = await h.launch({ userData: h.tempProfile('nav'), home: `${server.origin}/` });
  t.after(async () => {
    await app.close().catch(() => {});
    await server.close();
  });
  const active = async () => {
    const s = await h.mainState(app);
    return s.tabs.find((x) => x.id === s.activeId);
  };
  const go = async (text) => {
    await ui.fill('#address', text);
    await ui.press('#address', 'Enter');
  };
  await h.waitUntil(async () => (await active())?.title === 'Home Fixture', { message: 'home page' });

  await t.test('back/forward are disabled on a fresh tab', async () => {
    assert.equal(await ui.isDisabled('#back'), true);
    assert.equal(await ui.isDisabled('#forward'), true);
  });

  await t.test('typing a bare host:port/path loads it as a URL', async () => {
    await go(`localhost:${server.port}/page1`);
    await h.waitUntil(async () => (await active()).title === 'Page One', { message: 'Page One' });
    assert.equal((await active()).url, `${server.origin}/page1`);
    await h.waitUntil(async () => (await ui.inputValue('#address')) === `${server.origin}/page1`, { message: 'address shows URL' });
  });

  await t.test('typing words searches Google', async () => {
    // The test network cannot reach google.com, so capture the request the
    // browser makes and answer it locally.
    await app.evaluate(({ session }, origin) => {
      const ses = session.fromPartition('persist:ordinance');
      globalThis.__searchRequests = [];
      ses.webRequest.onBeforeRequest({ urls: ['https://www.google.com/*'] }, (details, callback) => {
        globalThis.__searchRequests.push(details.url);
        const q = new URL(details.url).searchParams.get('q');
        callback({ redirectURL: `${origin}/named/${encodeURIComponent(`Search stub: ${q}`)}` });
      });
    }, server.origin);
    await go('hello world');
    await h.waitUntil(async () => (await active()).title === 'Search stub: hello world', { message: 'search stub page' });
    const requests = await app.evaluate(() => globalThis.__searchRequests);
    assert.equal(requests[0], 'https://www.google.com/search?q=hello%20world');
    await app.evaluate(({ session }) => session.fromPartition('persist:ordinance').webRequest.onBeforeRequest(null));
  });

  await t.test('back and forward buttons walk history', async () => {
    await go(`${server.origin}/page1`);
    await h.waitUntil(async () => (await active()).title === 'Page One', { message: 'Page One' });
    await go(`${server.origin}/page2`);
    await h.waitUntil(async () => (await active()).title === 'Page Two', { message: 'Page Two' });
    await h.waitUntil(async () => !(await ui.isDisabled('#back')), { message: 'back enabled' });
    await ui.click('#back');
    await h.waitUntil(async () => (await active()).title === 'Page One', { message: 'back to Page One' });
    await h.waitUntil(async () => !(await ui.isDisabled('#forward')), { message: 'forward enabled' });
    await ui.click('#forward');
    await h.waitUntil(async () => (await active()).title === 'Page Two', { message: 'forward to Page Two' });
  });

  await t.test('reload button reloads the page', async () => {
    await go(`${server.origin}/counter`);
    await h.waitUntil(async () => /^Counter \d+$/.test((await active()).title), { message: 'counter page' });
    const first = Number((await active()).title.split(' ')[1]);
    await h.waitUntil(async () => !(await active()).loading, { message: 'load finished' });
    await ui.click('#reload');
    await h.waitUntil(async () => (await active()).title === `Counter ${first + 1}`, { message: 'counter incremented' });
  });

  await t.test('home button goes to the home page', async () => {
    await ui.click('#home');
    await h.waitUntil(async () => (await active()).title === 'Home Fixture', { message: 'home page' });
    assert.equal((await active()).url, `${server.origin}/`);
  });

  await t.test('unreachable sites show an error page but keep the URL', async () => {
    await go('http://localhost:1/nothing');
    await h.waitUntil(async () => (await active()).title === "Can't reach this page", { message: 'error page' });
    await h.waitUntil(async () => (await ui.inputValue('#address')) === 'http://localhost:1/nothing', { message: 'URL kept' });
  });
});
