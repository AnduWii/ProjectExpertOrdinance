// Runs in the extension service worker, where agent extensions such as
// Claude in Chrome make these calls. Each step records its raw result (or
// error) so two browsers can be compared field by field.
const summarizeWindow = (w) =>
  w && {
    id: w.id,
    type: w.type,
    tabsIsArray: Array.isArray(w.tabs),
    tabCount: Array.isArray(w.tabs) ? w.tabs.length : null,
    firstTabId: w.tabs && w.tabs[0] ? w.tabs[0].id : undefined,
    firstTabActive: w.tabs && w.tabs[0] ? w.tabs[0].active : undefined,
    tabIndexes: Array.isArray(w.tabs) ? w.tabs.map((t) => t.index) : null,
  };

async function step(log, name, fn, summarize = (v) => v) {
  try {
    const value = await fn();
    log.push({ name, ok: true, isUndefined: value === undefined, value: summarize(value) });
    return value;
  } catch (err) {
    log.push({ name, ok: false, error: String((err && err.message) || err) });
    return undefined;
  }
}

async function runProbe() {
  const log = [];
  await step(log, 'windows.getAll({populate:true})', () => chrome.windows.getAll({ populate: true }), (ws) => ws.map(summarizeWindow));
  const win = await step(log, 'windows.create({url:"about:blank"})', () => chrome.windows.create({ url: 'about:blank' }), summarizeWindow);
  // What agent code typically does next: take the new window's first tab.
  await step(log, 'createdWindow.tabs[0].id', () => win.tabs[0].id);
  const queried = await step(log, 'tabs.query({windowId})', () => chrome.tabs.query({ windowId: win.id }), (ts) => ts.map((t) => ({ id: t.id, windowId: t.windowId, groupId: t.groupId })));
  const tabId = (win && win.tabs && win.tabs[0] && win.tabs[0].id) ?? (queried && queried[0] && queried[0].id);
  const groupId = await step(log, 'tabs.group({tabIds:[tabId]})', () => chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: win.id } }));
  await step(log, 'tabGroups.update(groupId)', () => chrome.tabGroups.update(groupId, { title: 'Probe', color: 'orange' }), (g) => g && { id: g.id, title: g.title, color: g.color, windowId: g.windowId });
  await step(log, 'tabGroups.query({})', () => chrome.tabGroups.query({}), (gs) => gs.map((g) => ({ id: g.id, title: g.title, windowId: g.windowId })));
  await step(log, 'tabGroups.get(groupId)', () => chrome.tabGroups.get(groupId), (g) => g && { id: g.id, title: g.title });
  await step(log, 'tabs.get(tabId).groupId', () => chrome.tabs.get(tabId), (t) => t && { id: t.id, groupId: t.groupId });
  await step(log, 'tabs.get(tabId)', () => chrome.tabs.get(tabId), (t) => t && { id: t.id, active: t.active, index: t.index, windowId: t.windowId });
  await step(log, 'windows.get(createdId,{populate:true})', () => chrome.windows.get(win.id, { populate: true }), summarizeWindow);
  if (win && win.id !== undefined) await step(log, 'windows.remove(createdId)', () => chrome.windows.remove(win.id));
  return log;
}

// Each tab's index as chrome.tabs and chrome.windows report it, by tab id.
async function indexes(windowId) {
  const byId = (tabs) => Object.fromEntries(tabs.map((t) => [t.id, t.index]));
  const queried = await chrome.tabs.query({ windowId });
  const win = await chrome.windows.get(windowId, { populate: true });
  const got = await Promise.all(queried.map((t) => chrome.tabs.get(t.id)));
  const active = await chrome.tabs.query({ windowId, active: true });
  return { query: byId(queried), get: byId(got), window: byId(win.tabs), active: byId(active) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'run-probe') {
    runProbe().then(sendResponse, (err) => sendResponse([{ name: 'probe', ok: false, error: String(err) }]));
    return true;
  }
  if (msg && msg.type === 'indexes') {
    indexes(msg.windowId).then(sendResponse, (err) => sendResponse({ error: String(err) }));
    return true;
  }
});
globalThis.runProbe = runProbe;
