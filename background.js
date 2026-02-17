// Background service worker — only handles URL fetching.
// Translation API calls are made directly from the content script
// to avoid MV3 service worker lifecycle issues.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "fetchUrl") {
    fetch(message.url)
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.text();
      })
      .then((text) => sendResponse({ text }))
      .catch((err) => sendResponse({ error: err.message || String(err) }));
    return true;
  }
});
