/**
 * Letterboxd DTDD Integration - Background Script
 * Handles CORS proxying for Does The Dog Die API requests
 */

// Open settings page when extension icon is clicked
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.name === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    return false;
  }

  if (msg.name !== 'DTDD_FETCH') {
    return false;
  }

  (async () => {
    try {
      const headers = { Accept: 'application/json' };

      // Add API key if configured
      const data = await chrome.storage.sync.get('dtdd-key');
      if (data['dtdd-key']) {
        headers['X-API-KEY'] = data['dtdd-key'];
      }

      const response = await fetch(msg.url, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        sendResponse({ error: `HTTP ${response.status}`, data: null });
        return;
      }

      const json = await response.json();
      sendResponse({ error: null, data: json });
    } catch (e) {
      sendResponse({ error: e.message, data: null });
    }
  })();

  return true;
});
