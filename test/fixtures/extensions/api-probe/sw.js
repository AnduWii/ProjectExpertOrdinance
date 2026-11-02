importScripts('probe.js');

// Calls each API for real; "present" is not the same as "works".
async function functionalChecks() {
  const check = (name, fn, ms = 4000) =>
    Promise.race([
      Promise.resolve()
        .then(fn)
        .then(
          (v) => [name, 'ok', v],
          (e) => [name, 'error', String((e && e.message) || e)],
        ),
      new Promise((r) => setTimeout(() => r([name, 'timeout']), ms)),
    ]);
  const lastErrorCb = (resolve, reject) => (v) => (chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(v ?? true));
  const results = await Promise.all([
    check('storage.local', async () => { await chrome.storage.local.set({ a: 1 }); return (await chrome.storage.local.get('a')).a; }),
    check('storage.session', async () => { await chrome.storage.session.set({ b: 2 }); return (await chrome.storage.session.get('b')).b; }),
    check('alarms (fires)', () => new Promise((res) => { chrome.alarms.onAlarm.addListener((a) => res(a.name)); chrome.alarms.create('probe', { when: Date.now() + 300 }); })),
    check('offscreen.createDocument', async () => { await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: 'probe' }); return true; }),
    check('declarativeNetRequest.updateDynamicRules', async () => {
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [{ id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: '||blocked.invalid' } }] });
      return (await chrome.declarativeNetRequest.getDynamicRules()).length;
    }),
    check('system.display.getInfo', async () => (await chrome.system.display.getInfo()).length),
    check('system.cpu.getInfo', async () => (await chrome.system.cpu.getInfo()).numOfProcessors),
    check('system.memory.getInfo', async () => (await chrome.system.memory.getInfo()).capacity > 0),
    check('idle.queryState', () => chrome.idle.queryState(60)),
    check('permissions.getAll', async () => (await chrome.permissions.getAll()).permissions.length),
    check('management.getSelf', async () => (await chrome.management.getSelf()).name),
    check('scripting.getRegisteredContentScripts', async () => (await chrome.scripting.getRegisteredContentScripts()).length),
    check('tabs.query', async () => (await chrome.tabs.query({})).length),
    check('windows.getAll', async () => (await chrome.windows.getAll()).length),
    check('cookies.getAll', async () => (await chrome.cookies.getAll({})).length),
    check('contextMenus.create', () => new Promise((res, rej) => chrome.contextMenus.create({ id: 'probe', title: 'Probe' }, lastErrorCb(res, rej)))),
    check('action.setBadgeText', async () => { await chrome.action.setBadgeText({ text: '1' }); return true; }),
    check('notifications.getAll', async () => Object.keys(await chrome.notifications.getAll()).length),
    check('webNavigation.getAllFrames', async () => { const [t] = await chrome.tabs.query({}); return (await chrome.webNavigation.getAllFrames({ tabId: t.id })).length; }),
    check('debugger.getTargets', async () => (await chrome.debugger.getTargets()).length),
    check('sidePanel.getPanelBehavior', async () => await chrome.sidePanel.getPanelBehavior()),
    check('tabGroups.query', async () => (await chrome.tabGroups.query({})).length),
    check('identity.getRedirectURL', () => chrome.identity.getRedirectURL('cb')),
    check('bookmarks.getTree', async () => (await chrome.bookmarks.getTree()).length),
    check('history.search', async () => (await chrome.history.search({ text: '' })).length),
    check('downloads.search', async () => (await chrome.downloads.search({})).length),
    check('commands.getAll', async () => (await chrome.commands.getAll()).length),
  ]);
  return Object.fromEntries(results.map(([n, s, v]) => [n, v === undefined ? s : `${s}: ${JSON.stringify(v)}`]));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg === 'probe') sendResponse(probeChrome());
  if (msg === 'functional') {
    functionalChecks().then(sendResponse);
    return true;
  }
});
