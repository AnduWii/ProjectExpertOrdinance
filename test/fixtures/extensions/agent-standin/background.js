// Mirrors how agent extensions behave: the toolbar button opens a side panel,
// and the agent drives a tab it opened through the Chrome DevTools Protocol.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForComplete(tabId, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && tab.url && tab.url !== 'about:blank') return tab;
    await sleep(100);
  }
  throw new Error('tab did not finish loading');
}

async function runAgent() {
  const steps = [];
  const step = (name, value) => steps.push({ name, value });
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const origin = new URL(active.url).origin;

  // 1. Open a working tab and put it in a coloured group.
  const tab = await chrome.tabs.create({ url: `${origin}/agent-target`, active: true });
  await waitForComplete(tab.id);
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, { title: 'Agent', color: 'orange' });
  const group = await chrome.tabGroups.get(groupId);
  step('group', group);

  // 2. Drive the page through CDP.
  const target = { tabId: tab.id };
  const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  const events = new Set();
  const onEvent = (source, method) => {
    if (source.tabId === tab.id) events.add(method);
  };
  chrome.debugger.onEvent.addListener(onEvent);
  await chrome.debugger.attach(target, '1.3');

  let secondAttachError = null;
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    secondAttachError = err.message;
  }

  await send('Page.enable');
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const title = await evaluate('document.title');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const box = JSON.parse(await evaluate('JSON.stringify(document.querySelector("#target").getBoundingClientRect())'));
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  const clicks = await evaluate('window.__clicks');
  await evaluate('document.querySelector("#field").focus()');
  await send('Input.insertText', { text: 'typed by agent' });
  const typed = await evaluate('window.__typed');
  const targets = await chrome.debugger.getTargets();
  await sleep(1500); // keep the "is debugging this tab" banner up long enough to observe
  await send('Page.reload');
  const start = Date.now();
  while (!events.has('Page.loadEventFired') && Date.now() - start < 8000) await sleep(100);
  await chrome.debugger.detach(target);
  chrome.debugger.onEvent.removeListener(onEvent);

  // 3. Other APIs agents commonly use.
  const [{ result: scripted }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.title });
  const visible = await chrome.tabs.captureVisibleTab({ format: 'png' });
  await chrome.storage.local.set({ lastRun: Date.now() });
  const authUrl = `${origin}/auth/start?redirect=${encodeURIComponent(chrome.identity.getRedirectURL('cb'))}`;
  const authResult = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });

  return {
    tabId: tab.id,
    title,
    screenshotBytes: shot.data.length,
    clicks,
    typed,
    secondAttachError,
    targetAttached: targets.find((t) => t.tabId === tab.id)?.attached,
    eventsSeen: [...events],
    scripted,
    visiblePrefix: visible.slice(0, 22),
    groupId,
    group,
    authResult,
    steps,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'run-agent') {
    runAgent().then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
    return true;
  }
});
