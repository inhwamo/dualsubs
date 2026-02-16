const apiKeyInput = document.getElementById("apiKey");
const sourceLangSelect = document.getElementById("sourceLang");
const targetLangSelect = document.getElementById("targetLang");
const saveBtn = document.getElementById("saveBtn");
const translateBtn = document.getElementById("translateBtn");
const statusEl = document.getElementById("status");

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = "status " + type;
}

// Load saved settings on open
chrome.storage.local.get(
  ["apiKey", "sourceLang", "targetLang"],
  (result) => {
    if (result.apiKey) apiKeyInput.value = result.apiKey;
    if (result.sourceLang) sourceLangSelect.value = result.sourceLang;
    if (result.targetLang) targetLangSelect.value = result.targetLang;
  }
);

saveBtn.addEventListener("click", () => {
  const apiKey = apiKeyInput.value.trim();
  const sourceLang = sourceLangSelect.value;
  const targetLang = targetLangSelect.value;

  if (!apiKey) {
    setStatus("Please enter an API key.", "error");
    return;
  }
  if (sourceLang === targetLang) {
    setStatus("Source and target languages must differ.", "error");
    return;
  }

  chrome.storage.local.set({ apiKey, sourceLang, targetLang }, () => {
    setStatus("Settings saved.", "success");
  });
});

translateBtn.addEventListener("click", () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setStatus("Please enter and save an API key first.", "error");
    return;
  }

  // Save current settings before translating
  chrome.storage.local.set({
    apiKey,
    sourceLang: sourceLangSelect.value,
    targetLang: targetLangSelect.value,
  });

  setStatus("Starting translation...", "info");
  translateBtn.disabled = true;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) {
      setStatus("No active tab found.", "error");
      translateBtn.disabled = false;
      return;
    }

    const tab = tabs[0];
    if (!tab.url || !tab.url.includes("youtube.com/watch")) {
      setStatus("Navigate to a YouTube video first.", "error");
      translateBtn.disabled = false;
      return;
    }

    chrome.tabs.sendMessage(
      tab.id,
      { action: "startTranslation" },
      (response) => {
        if (chrome.runtime.lastError) {
          setStatus(
            "Could not reach content script. Try reloading the page.",
            "error"
          );
          translateBtn.disabled = false;
          return;
        }
        if (response && response.error) {
          setStatus(response.error, "error");
          translateBtn.disabled = false;
        } else if (response && response.status) {
          setStatus(response.status, "info");
        }
      }
    );
  });
});

// Listen for status updates from the content script
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "translationStatus") {
    const type = message.type || "info";
    setStatus(message.message, type);
    if (type === "success" || type === "error") {
      translateBtn.disabled = false;
    }
  }
});
