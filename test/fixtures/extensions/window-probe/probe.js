// Asks the service worker to run the probe and shows the results.
chrome.runtime.sendMessage({ type: 'run-probe' }).then((log) => {
  window.__probe = log;
  document.getElementById('out').textContent = JSON.stringify(log, null, 2);
  document.title = 'Window Probe: done';
});
