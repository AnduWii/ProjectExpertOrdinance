// Mirrors what an agent extension does when it starts a browser session:
// create a window if it needs one, then read the tab out of the result.
const out = {};

async function cap(name, fn) {
  try {
    const value = await fn();
    out[name] = { ok: true, value: JSON.parse(JSON.stringify(value ?? null)) };
  } catch (err) {
    out[name] = { ok: false, error: String((err && err.message) || err) };
  }
}

(async () => {
  // The exact call that used to resolve with `tabs: []`.
  await cap('createdWindow', () => chrome.windows.create({ url: 'about:blank' }));
  await cap('getAll', () => chrome.windows.getAll({ populate: true }));
  await cap('activeQuery', () => chrome.tabs.query({ active: true, lastFocusedWindow: true }));

  const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  await cap('group', () => chrome.tabs.group({ tabIds: [active[0].id] }));
  await cap('groups', () => chrome.tabGroups.query({}));

  document.getElementById('out').textContent = JSON.stringify(out, null, 2);
  window.__windowProbe = out;
})();
