const apiKeyInput = document.getElementById("apiKey");
const sourceLangSelect = document.getElementById("sourceLang");
const targetLangSelect = document.getElementById("targetLang");
const modelSelect = document.getElementById("model");
const saveBtn = document.getElementById("saveBtn");
const translateBtn = document.getElementById("translateBtn");
const clearBtn = document.getElementById("clearBtn");
const displayToggle = document.getElementById("displayToggle");
const statusEl = document.getElementById("status");

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = "status " + type;
}

function sendToTab(action, extra, callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0] || !tabs[0].url || !tabs[0].url.includes("youtube.com/watch")) {
      if (callback) callback(null, "Navigate to a YouTube video first.");
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, { action, ...extra }, (resp) => {
      if (chrome.runtime.lastError) {
        if (callback) callback(null, "Could not reach content script. Try reloading.");
        return;
      }
      if (callback) callback(resp);
    });
  });
}

// ---- Load settings + query live state on open ----

chrome.storage.local.get(
  ["apiKey", "sourceLang", "targetLang", "model"],
  (result) => {
    if (result.apiKey) apiKeyInput.value = result.apiKey;
    if (result.sourceLang) sourceLangSelect.value = result.sourceLang;
    if (result.targetLang) targetLangSelect.value = result.targetLang;
    if (result.model) modelSelect.value = result.model;
  }
);

// Query content script for current state (translation in progress, display mode, etc.)
sendToTab("getState", {}, (state) => {
  if (!state) return;
  // Show live status
  if (state.translating && state.lastStatus) {
    setStatus(state.lastStatus.message, state.lastStatus.type);
    translateBtn.disabled = true;
  } else if (state.active && state.subtitleCount > 0) {
    setStatus(`Displaying ${state.subtitleCount} dual subtitles.`, "success");
  }
  // Sync display mode toggle
  if (state.displayMode) {
    updateDisplayToggle(state.displayMode);
  }
});

// ---- Save settings ----

saveBtn.addEventListener("click", () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) { setStatus("Please enter an API key.", "error"); return; }
  const sourceLang = sourceLangSelect.value;
  const targetLang = targetLangSelect.value;
  if (sourceLang === targetLang) {
    setStatus("Source and target languages must differ.", "error");
    return;
  }
  chrome.storage.local.set(
    { apiKey, sourceLang, targetLang, model: modelSelect.value },
    () => setStatus("Settings saved.", "success")
  );
});

// ---- Translate ----

translateBtn.addEventListener("click", () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) { setStatus("Please enter and save an API key first.", "error"); return; }

  chrome.storage.local.set({
    apiKey,
    sourceLang: sourceLangSelect.value,
    targetLang: targetLangSelect.value,
    model: modelSelect.value,
  });

  setStatus("Starting translation...", "info");
  translateBtn.disabled = true;

  sendToTab("startTranslation", {}, (resp, err) => {
    if (err) { setStatus(err, "error"); translateBtn.disabled = false; return; }
    if (resp && resp.error) { setStatus(resp.error, "error"); translateBtn.disabled = false; }
    else if (resp && resp.status) { setStatus(resp.status, "info"); }
  });
});

// ---- Display mode toggle ----

function updateDisplayToggle(mode) {
  displayToggle.querySelectorAll(".dt-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
}

displayToggle.addEventListener("click", (e) => {
  const btn = e.target.closest(".dt-btn");
  if (!btn) return;
  const mode = btn.dataset.mode;
  updateDisplayToggle(mode);
  sendToTab("setDisplayMode", { mode });
});

// ---- Clear ----

clearBtn.addEventListener("click", () => {
  sendToTab("clearSubtitles", {}, (resp, err) => {
    if (err) { setStatus(err, "error"); return; }
    setStatus("Subtitles and cache cleared.", "success");
  });
});

// ---- Live status updates ----

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "translationStatus") {
    const type = message.type || "info";
    setStatus(message.message, type);
    if (type === "success" || type === "error") {
      translateBtn.disabled = false;
    }
  }
});
