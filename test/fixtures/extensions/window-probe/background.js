// The probe runs in the side panel document; the worker only keeps the
// extension alive and mirrors how agent extensions open their panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
