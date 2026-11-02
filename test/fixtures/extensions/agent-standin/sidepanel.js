(async () => {
  const status = document.getElementById('status');
  const result = await chrome.runtime.sendMessage({ type: 'run-agent' });
  window.__agentResult = result;
  status.textContent = result?.error ? `Failed: ${result.error}` : 'Done';
  document.getElementById('out').textContent = JSON.stringify({ ...result, steps: undefined }, null, 2);
  document.title = result?.error ? 'agent-error' : 'agent-done';
})();
