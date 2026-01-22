/**
 * Letterboxd DTDD - Background Script
 * Handles CORS proxying for DTDD requests
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.name !== 'DTDD_FETCH') {
    return false;
  }

  (async () => {
    try {
      const headers = { Accept: 'application/json' };

      // Add API key if configured
      const data = await chrome.storage.sync.get('dtdd-apikey');
      if (data['dtdd-apikey']) {
        headers['X-API-KEY'] = data['dtdd-apikey'];
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
