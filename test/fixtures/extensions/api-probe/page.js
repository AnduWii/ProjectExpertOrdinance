window.__probe = { page: probeChrome(), sw: null, functional: null };
(async () => {
  try {
    window.__probe.sw = await chrome.runtime.sendMessage('probe');
    window.__probe.functional = await chrome.runtime.sendMessage('functional');
  } catch (err) {
    window.__probe.swError = String(err);
  }
  document.title = 'probe-done';
})();
