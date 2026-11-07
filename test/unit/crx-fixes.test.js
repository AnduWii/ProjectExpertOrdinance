'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyCrxFixes, invalidateWindowDetails, patchTabsQuery, WINDOW_ID_CURRENT } = require('../../src/main/compat/crx-fixes');

/** Stand-in for electron-chrome-extensions' internals, same shape as 4.10.0. */
function fakeCrx({ store = true, router = true, queryHandler = true } = {}) {
  const handlers = new Map();
  const calls = [];
  const fakeRouter = {
    handlers,
    handle(name, callback, opts = {}) {
      handlers.set(name, {
        callback,
        extensionContext: typeof opts.extensionContext === 'boolean' ? opts.extensionContext : true,
        allowRemote: typeof opts.allowRemote === 'boolean' ? opts.allowRemote : false,
        permission: typeof opts.permission === 'string' ? opts.permission : undefined,
      });
    },
  };
  if (queryHandler) {
    fakeRouter.handle('tabs.query', (_event, info) => {
      calls.push(info);
      return [];
    });
  }
  return {
    calls,
    crx: {
      ctx: {
        store: store ? { windowDetailsCache: new Map() } : null,
        router: router ? fakeRouter : null,
      },
    },
  };
}

const runQuery = (crx, info) => crx.ctx.router.handlers.get('tabs.query').callback({}, info);

test('[crx-fixes] invalidateWindowDetails clears the stale window cache', () => {
  const { crx } = fakeCrx();
  crx.ctx.store.windowDetailsCache.set(1, { id: 1, tabs: [] });
  crx.ctx.store.windowDetailsCache.set(2, { id: 2, tabs: [] });

  assert.equal(invalidateWindowDetails(crx), true);
  assert.equal(crx.ctx.store.windowDetailsCache.size, 0, 'every cached window is dropped');
});

test('[crx-fixes] invalidateWindowDetails reports failure instead of throwing', () => {
  assert.equal(invalidateWindowDetails(null), false);
  assert.equal(invalidateWindowDetails({}), false);
  assert.equal(invalidateWindowDetails({ ctx: { store: {} } }), false, 'store without the cache is rejected');
});

test('[crx-fixes] tabs.query maps lastFocusedWindow to the current-window sentinel', () => {
  const { crx, calls } = fakeCrx();
  assert.equal(patchTabsQuery(crx), true);

  runQuery(crx, { active: true, lastFocusedWindow: true });

  assert.deepEqual(calls[0], { active: true, windowId: WINDOW_ID_CURRENT });
  assert.ok(!('lastFocusedWindow' in calls[0]), 'the flag the library ignores is removed');
});

test('[crx-fixes] tabs.query maps currentWindow the same way', () => {
  const { crx, calls } = fakeCrx();
  patchTabsQuery(crx);

  runQuery(crx, { active: true, currentWindow: true });

  assert.deepEqual(calls[0], { active: true, windowId: WINDOW_ID_CURRENT });
});

test('[crx-fixes] an explicit windowId is never overwritten', () => {
  const { crx, calls } = fakeCrx();
  patchTabsQuery(crx);

  runQuery(crx, { active: true, lastFocusedWindow: true, windowId: 7 });

  assert.equal(calls[0].windowId, 7);
});

test('[crx-fixes] queries without the flags are passed straight through', () => {
  const { crx, calls } = fakeCrx();
  patchTabsQuery(crx);

  runQuery(crx, { active: true });
  runQuery(crx, undefined);

  assert.deepEqual(calls[0], { active: true }, 'no windowId is invented');
  assert.deepEqual(calls[1], {}, 'a missing query object is tolerated');
});

test('[crx-fixes] patching twice does not wrap the handler twice', () => {
  const { crx, calls } = fakeCrx();
  assert.equal(patchTabsQuery(crx), true);
  assert.equal(patchTabsQuery(crx), true, 'second call is a no-op that still reports success');

  runQuery(crx, { lastFocusedWindow: true });

  assert.equal(calls.length, 1, 'the inner handler ran once');
  assert.deepEqual(calls[0], { windowId: WINDOW_ID_CURRENT });
});

test('[crx-fixes] the wrapped handler keeps the original registration options', () => {
  const { crx } = fakeCrx({ queryHandler: false });
  crx.ctx.router.handle('tabs.query', () => [], { extensionContext: false, allowRemote: true, permission: 'tabs' });

  patchTabsQuery(crx);

  const entry = crx.ctx.router.handlers.get('tabs.query');
  assert.deepEqual(
    { extensionContext: entry.extensionContext, allowRemote: entry.allowRemote, permission: entry.permission },
    { extensionContext: false, allowRemote: true, permission: 'tabs' },
  );
});

test('[crx-fixes] a library that changed shape is reported, not fatal', () => {
  assert.equal(patchTabsQuery({}), false);
  assert.equal(patchTabsQuery({ ctx: { router: { handlers: new Map(), handle() {} } } }), false, 'no tabs.query handler');

  const applied = applyCrxFixes({});
  assert.deepEqual(applied, { tabsQuery: false, windowDetails: false });
});

test('[crx-fixes] applyCrxFixes reports both fixes on a healthy instance', () => {
  const { crx } = fakeCrx();
  assert.deepEqual(applyCrxFixes(crx), { tabsQuery: true, windowDetails: true });
});
