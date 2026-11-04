'use strict';

/* global browserAPI */
const api = window.browserAPI;
const $ = (sel) => document.querySelector(sel);
const PANEL_WIDTH = 340;
const TAB_MIME = 'application/x-ordinance-tab';

const state = {
  tabs: [],
  activeId: null,
  panel: null, // 'bookmarks' | 'history' | 'extensions' | null
  sidePanel: null,
  extensions: [],
  editingAddress: false,
  dragId: null,
};

const activeTab = () => state.tabs.find((t) => t.id === state.activeId) || null;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

const icon = (d) => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
};
const X_PATH = 'M18 6L6 18M6 6l12 12';

// ------------------------------------------------------------------ layout

function reportLayout() {
  const top = Math.round($('#chrome').getBoundingClientRect().height);
  document.documentElement.style.setProperty('--chrome-h', `${top}px`);
  api.setLayout({ top, right: state.panel ? PANEL_WIDTH : 0 });
}
new ResizeObserver(reportLayout).observe($('#chrome'));

// -------------------------------------------------------------------- tabs

function renderTabs() {
  if (state.dragId != null) return; // never rebuild the strip mid-drag
  $('#tabs').replaceChildren(...state.tabs.map(tabElement));
}

function tabElement(tab) {
  const active = tab.id === state.activeId;
  let lead;
  if (tab.loading) lead = el('span', { class: 'spinner', 'aria-hidden': true });
  else if (tab.favicon) {
    lead = el('img', { class: 'favicon', src: tab.favicon, alt: '' });
    lead.addEventListener('error', () => lead.replaceWith(el('span', { class: 'globe' })));
  } else lead = el('span', { class: 'globe', 'aria-hidden': true });

  const close = el('button', { class: 'close icon-btn', 'aria-label': 'Close tab', title: 'Close tab (Ctrl+W)' }, icon(X_PATH));
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    api.closeTab(tab.id);
  });

  const node = el(
    'div',
    {
      class: `tab${active ? ' active' : ''}${tab.groupColor ? ' grouped' : ''}`,
      role: 'tab',
      'aria-selected': String(active),
      draggable: 'true',
      title: `${tab.title}\n${tab.url}`,
      dataset: { id: tab.id },
    },
    lead,
    el('span', { class: 'title' }, tab.title || tab.url || 'New Tab'),
    tab.debuggedBy ? el('span', { class: 'debug-dot', title: `${tab.debuggedBy} is debugging this tab` }) : null,
    close,
  );
  if (tab.groupColor) node.style.setProperty('--group-color', tab.groupColor);

  node.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('.close')) api.activateTab(tab.id);
  });
  node.addEventListener('auxclick', (e) => {
    if (e.button === 1) api.closeTab(tab.id);
  });

  // Drag to reorder (HTML5 drag and drop; main process owns the order).
  node.addEventListener('dragstart', (e) => {
    state.dragId = tab.id;
    e.dataTransfer.setData(TAB_MIME, String(tab.id));
    e.dataTransfer.effectAllowed = 'move';
    node.classList.add('dragging');
  });
  node.addEventListener('dragover', (e) => {
    if (state.dragId == null || state.dragId === tab.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const after = isAfter(e, node);
    node.classList.toggle('drop-after', after);
    node.classList.toggle('drop-before', !after);
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-before', 'drop-after'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const id = Number(e.dataTransfer.getData(TAB_MIME)) || state.dragId;
    dropTab(id, tab.id, isAfter(e, node));
  });
  node.addEventListener('dragend', endDrag);
  return node;
}

const isAfter = (e, node) => {
  const r = node.getBoundingClientRect();
  return e.clientX > r.left + r.width / 2;
};

function dropTab(dragId, overId, after) {
  const order = state.tabs.map((t) => t.id);
  const from = order.indexOf(dragId);
  if (from < 0) return endDrag();
  let to = overId == null ? order.length - 1 : order.indexOf(overId) + (after ? 1 : 0);
  if (overId != null && from < to) to -= 1;
  // Optimistic local reorder so the strip does not flicker back.
  const [moved] = state.tabs.splice(from, 1);
  state.tabs.splice(Math.max(0, Math.min(to, state.tabs.length)), 0, moved);
  endDrag();
  api.moveTab(dragId, to);
}

function endDrag() {
  state.dragId = null;
  renderTabs();
}

// Dropping on the empty part of the strip moves the tab to the end.
$('#tabstrip').addEventListener('dragover', (e) => {
  if (state.dragId != null) e.preventDefault();
});
$('#tabstrip').addEventListener('drop', (e) => {
  if (state.dragId == null) return;
  e.preventDefault();
  dropTab(state.dragId, null, true);
});

// ------------------------------------------------------------------ navbar

function displayUrl(url) {
  return !url || url === 'about:blank' ? '' : url;
}

function renderNav() {
  const tab = activeTab();
  $('#back').disabled = !tab?.canGoBack;
  $('#forward').disabled = !tab?.canGoForward;
  const reload = $('#reload');
  reload.classList.toggle('loading', !!tab?.loading);
  reload.title = tab?.loading ? 'Stop' : 'Reload (Ctrl+R)';
  reload.setAttribute('aria-label', tab?.loading ? 'Stop' : 'Reload');
  if (!state.editingAddress) $('#address').value = displayUrl(tab?.url);
  $('#bookmark-star').setAttribute('aria-pressed', String(!!tab?.bookmarked));
  document.title = tab?.title ? `${tab.title} – Chrome2` : 'Chrome2';

  const banner = $('#debug-banner');
  if (tab?.debuggedBy) {
    $('#debug-text').textContent = `"${tab.debuggedBy}" started debugging this tab.`;
    banner.hidden = false;
  } else banner.hidden = true;
}

$('#new-tab').addEventListener('click', () => api.newTab());
$('#back').addEventListener('click', () => api.back());
$('#forward').addEventListener('click', () => api.forward());
$('#reload').addEventListener('click', () => (activeTab()?.loading ? api.stop() : api.reload()));
$('#home').addEventListener('click', () => api.home());
$('#debug-cancel').addEventListener('click', () => api.stopDebugging(state.activeId));

const address = $('#address');
address.addEventListener('focus', () => {
  state.editingAddress = true;
  address.select();
});
address.addEventListener('blur', () => {
  state.editingAddress = false;
  renderNav();
});
address.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    state.editingAddress = false;
    renderNav();
    address.select();
  }
});
$('#address-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = address.value.trim();
  if (!value) return;
  state.editingAddress = false;
  address.blur();
  api.go(value);
});

$('#bookmark-star').addEventListener('click', async () => {
  await api.toggleBookmark();
});

$('#import-browser').addEventListener('click', async () => {
  await api.importFromBrowser();
  if (state.panel === 'bookmarks') renderBookmarks();
});

// --------------------------------------------------------- side panel

function renderLayout() {
  const sp = state.sidePanel;
  document.documentElement.style.setProperty('--side-w', sp ? `${sp.width}px` : '0px');
  $('#sidepanel-header').hidden = !sp;
  $('#sidepanel-title').textContent = sp?.title || '';
  renderExtensionActions();
}
$('#sidepanel-close').addEventListener('click', () => api.closeSidePanel());

// ------------------------------------------------------- extension actions

function renderExtensionActions() {
  const holder = $('#extension-actions');
  holder.replaceChildren(
    ...state.extensions
      .filter((x) => x.hasAction || x.hasSidePanel)
      .map((x) => {
        const btn = el(
          'button',
          {
            class: `icon-btn${state.sidePanel?.extensionId === x.id ? ' open' : ''}`,
            title: x.name,
            'aria-label': x.name,
            dataset: { extensionId: x.id },
          },
          x.icon ? el('img', { src: x.icon, alt: '' }) : el('span', {}, x.name.slice(0, 1).toUpperCase()),
        );
        btn.addEventListener('click', () => {
          const r = btn.getBoundingClientRect();
          api.activateExtension(x.id, { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
        });
        return btn;
      }),
  );
}

// ------------------------------------------------------------------ panels

function setPanel(view) {
  state.panel = view;
  const panel = $('#panel');
  panel.hidden = !view;
  for (const b of panel.querySelectorAll('.panel-tabs [data-view]')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  for (const s of panel.querySelectorAll('section[data-view]')) s.classList.toggle('active', s.dataset.view === view);
  $('#toggle-bookmarks').setAttribute('aria-pressed', String(view === 'bookmarks'));
  $('#toggle-history').setAttribute('aria-pressed', String(view === 'history'));
  $('#toggle-extensions').setAttribute('aria-pressed', String(view === 'extensions'));
  reportLayout();
  refreshPanel();
}

const togglePanel = (view) => setPanel(state.panel === view ? null : view);

function refreshPanel() {
  if (state.panel === 'bookmarks') renderBookmarks();
  if (state.panel === 'history') renderHistory();
  if (state.panel === 'extensions') renderExtensions();
}

$('#toggle-bookmarks').addEventListener('click', () => togglePanel('bookmarks'));
$('#toggle-history').addEventListener('click', () => togglePanel('history'));
$('#toggle-extensions').addEventListener('click', () => togglePanel('extensions'));
$('#panel-close').addEventListener('click', () => setPanel(null));
for (const b of document.querySelectorAll('.panel-tabs [data-view]')) b.addEventListener('click', () => setPanel(b.dataset.view));

function listItem({ primary, secondary, onOpen, onRemove, removeLabel = 'Remove', lead, extra }) {
  const remove = onRemove
    ? el('button', { class: 'icon-btn small remove', 'aria-label': removeLabel, title: removeLabel, onclick: onRemove }, icon(X_PATH))
    : null;
  const body = el(
    onOpen ? 'button' : 'div',
    { class: 'open', ...(onOpen ? { onclick: onOpen, type: 'button' } : {}) },
    el('span', { class: 'primary' }, primary),
    secondary ? el('span', { class: 'secondary' }, secondary) : null,
    extra || null,
  );
  return el('li', {}, lead || null, body, remove);
}

async function renderBookmarks() {
  const items = await api.listBookmarks();
  $('#bookmark-list').replaceChildren(
    ...items.map((b) =>
      listItem({
        primary: b.title,
        secondary: b.url,
        onOpen: () => api.openUrl(b.url),
        onRemove: async () => {
          await api.removeBookmark(b.id);
          renderBookmarks();
        },
        removeLabel: 'Delete bookmark',
      }),
    ),
  );
  $('#bookmark-empty').hidden = items.length > 0;
}

let historyTimer;
async function renderHistory() {
  const items = await api.listHistory($('#history-search').value);
  $('#history-list').replaceChildren(
    ...items.map((h) =>
      listItem({
        primary: h.title || h.url,
        secondary: `${new Date(h.visitedAt).toLocaleString()} · ${h.url}`,
        onOpen: () => api.openUrl(h.url),
        onRemove: async () => {
          await api.removeHistory(h.id);
          renderHistory();
        },
        removeLabel: 'Remove from history',
      }),
    ),
  );
  $('#history-empty').hidden = items.length > 0;
}
$('#history-search').addEventListener('input', () => {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(renderHistory, 120);
});
$('#history-clear').addEventListener('click', async () => {
  await api.clearHistory();
  renderHistory();
});

async function renderExtensions() {
  const items = state.extensions;
  const errors = await api.listExtensionErrors();
  $('#extension-errors').replaceChildren(
    ...errors.map((e) =>
      listItem({
        primary: 'Failed to load',
        secondary: e.path,
        extra: el('span', { class: 'warn' }, e.error),
        onRemove: () => api.forgetExtension(e.path),
        removeLabel: 'Forget this extension',
      }),
    ),
  );
  $('#extension-list').replaceChildren(
    ...items.map((x) =>
      listItem({
        primary: `${x.name} ${x.version}`,
        secondary: `${x.source === 'webstore' ? 'Chrome Web Store' : 'Unpacked'} · ${x.id}`,
        lead: x.icon ? el('img', { class: 'ext-icon', src: x.icon, alt: '' }) : null,
        extra: x.unsupported?.length
          ? el('span', { class: 'warn' }, `Not available in this browser: ${x.unsupported.join(', ')}`)
          : null,
        onRemove: () => api.removeExtension(x.id),
        removeLabel: `Remove ${x.name}`,
      }),
    ),
  );
  $('#extension-empty').hidden = items.length + errors.length > 0;
}

$('#extension-webstore').addEventListener('click', () => api.openWebStore());

$('#extension-load').addEventListener('click', async () => {
  const result = await api.loadExtension();
  if (result?.error) window.alert(`Could not load extension:\n\n${result.error}`);
});

// ------------------------------------------------------------------ wiring

api.on('tabs:state', (s) => {
  state.tabs = s.tabs;
  state.activeId = s.activeId;
  renderTabs();
  renderNav();
});
api.on('layout:state', (s) => {
  state.sidePanel = s.sidePanel;
  renderLayout();
});
api.on('extensions:state', (list) => {
  state.extensions = list;
  renderExtensionActions();
  if (state.panel === 'extensions') renderExtensions();
});
api.on('bookmarks:changed', () => {
  if (state.panel === 'bookmarks') renderBookmarks();
});
api.on('ui:command', ({ command, view }) => {
  if (command === 'focus-address') {
    address.focus();
    address.select();
  } else if (command === 'toggle-panel') togglePanel(view);
});

api.ready().then(reportLayout);
