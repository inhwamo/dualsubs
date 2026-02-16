(() => {
  // Language name to ISO code mapping for subtitle track matching
  const LANG_CODES = {
    French: "fr",
    Korean: "ko",
    "Chinese (Mandarin)": "zh",
    Japanese: "ja",
    Spanish: "es",
    German: "de",
    Portuguese: "pt",
    Italian: "it",
    Russian: "ru",
    Arabic: "ar",
    English: "en",
  };

  let dualSubsState = {
    subtitles: null, // array of {start, dur, text, translation}
    syncInterval: null,
    overlay: null,
    currentVideoId: null,
    active: false,
  };

  // ---- Subtitle Extraction ----

  function getVideoId() {
    const params = new URLSearchParams(window.location.search);
    return params.get("v");
  }

  function extractCaptionTracks() {
    // Try to find captionTracks in page scripts
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const text = script.textContent;
      if (!text.includes("captionTracks")) continue;

      // Find the JSON containing captionTracks
      const match = text.match(/"captionTracks"\s*:\s*(\[.*?\])\s*[,}]/);
      if (match) {
        try {
          return JSON.parse(match[1]);
        } catch {
          // try a broader parse
        }
      }
    }

    // Fallback: try ytInitialPlayerResponse
    if (window.ytInitialPlayerResponse) {
      try {
        const tracks =
          window.ytInitialPlayerResponse.captions
            ?.playerCaptionsTracklistRenderer?.captionTracks;
        if (tracks) return tracks;
      } catch {
        // ignore
      }
    }

    return null;
  }

  function findTrackForLanguage(tracks, langName) {
    const code = LANG_CODES[langName];
    if (!code) return null;

    // Prefer exact language match (manual captions first, then auto-generated)
    const manual = tracks.find(
      (t) => t.languageCode === code && t.kind !== "asr"
    );
    if (manual) return manual;

    const auto = tracks.find((t) => t.languageCode === code);
    if (auto) return auto;

    // For Chinese, also check zh-Hans, zh-Hant, zh-CN, zh-TW
    if (code === "zh") {
      const zhVariant = tracks.find((t) =>
        t.languageCode.startsWith("zh")
      );
      if (zhVariant) return zhVariant;
    }

    return null;
  }

  async function fetchSubtitles(track) {
    const baseUrl = track.baseUrl;

    // Try JSON3 format first
    try {
      const json3Url =
        baseUrl + (baseUrl.includes("?") ? "&" : "?") + "fmt=json3";
      const resp = await fetch(json3Url);
      if (resp.ok) {
        const text = await resp.text();
        if (text && text.trim()) {
          const data = JSON.parse(text);
          const subs = parseJson3Subtitles(data);
          if (subs.length > 0) return subs;
        }
      }
    } catch {
      // JSON3 failed, fall through to XML
    }

    // Fallback: fetch as XML
    const resp = await fetch(baseUrl);
    if (!resp.ok)
      throw new Error(`Failed to fetch subtitles: ${resp.status}`);
    const text = await resp.text();
    if (!text || !text.trim())
      throw new Error("Subtitle track returned empty response.");
    return parseXmlSubtitles(text);
  }

  function parseJson3Subtitles(data) {
    const subtitles = [];
    if (!data.events) return subtitles;

    for (const event of data.events) {
      if (!event.segs) continue;
      const text = event.segs.map((s) => s.utf8 || "").join("").trim();
      if (!text || text === "\n") continue;

      subtitles.push({
        start: (event.tStartMs || 0) / 1000,
        dur: (event.dDurMs || 0) / 1000,
        text: decodeHtmlEntities(text),
      });
    }
    return subtitles;
  }

  function parseXmlSubtitles(xmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "text/xml");
    const nodes = doc.querySelectorAll("text");
    const subtitles = [];

    for (const node of nodes) {
      const start = parseFloat(node.getAttribute("start") || "0");
      const dur = parseFloat(node.getAttribute("dur") || "0");
      const text = decodeHtmlEntities(node.textContent.trim());
      if (text) subtitles.push({ start, dur, text });
    }
    return subtitles;
  }

  function decodeHtmlEntities(text) {
    const el = document.createElement("textarea");
    el.innerHTML = text;
    return el.value;
  }

  // ---- Cache ----

  function cacheKey(videoId, sourceLang, targetLang) {
    return `dualsubs_cache_${videoId}_${sourceLang}_${targetLang}`;
  }

  async function getCachedTranslation(videoId, sourceLang, targetLang) {
    return new Promise((resolve) => {
      const key = cacheKey(videoId, sourceLang, targetLang);
      chrome.storage.local.get([key], (result) => {
        resolve(result[key] || null);
      });
    });
  }

  async function setCachedTranslation(videoId, sourceLang, targetLang, data) {
    const key = cacheKey(videoId, sourceLang, targetLang);
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: data }, resolve);
    });
  }

  // ---- Overlay Display ----

  function createOverlay() {
    // Remove existing overlay if any
    removeOverlay();

    const playerContainer =
      document.querySelector("#movie_player") ||
      document.querySelector(".html5-video-player");
    if (!playerContainer) return null;

    const overlay = document.createElement("div");
    overlay.id = "claude-dual-subs-overlay";

    const originalLine = document.createElement("div");
    originalLine.className = "claude-dual-subs-original";

    const translatedLine = document.createElement("div");
    translatedLine.className = "claude-dual-subs-translated";

    overlay.appendChild(originalLine);
    overlay.appendChild(translatedLine);
    playerContainer.appendChild(overlay);

    return overlay;
  }

  function removeOverlay() {
    const existing = document.getElementById("claude-dual-subs-overlay");
    if (existing) existing.remove();
  }

  function hideYouTubeCaptions() {
    const captionWindow = document.querySelector(
      ".ytp-caption-window-container"
    );
    if (captionWindow) captionWindow.style.display = "none";
  }

  function showYouTubeCaptions() {
    const captionWindow = document.querySelector(
      ".ytp-caption-window-container"
    );
    if (captionWindow) captionWindow.style.display = "";
  }

  function findCurrentSubtitle(time, subtitles) {
    for (const sub of subtitles) {
      if (time >= sub.start && time < sub.start + sub.dur) {
        return sub;
      }
    }
    return null;
  }

  function startSyncLoop() {
    stopSyncLoop();

    const video = document.querySelector("video");
    if (!video || !dualSubsState.subtitles) return;

    const overlay = dualSubsState.overlay;
    if (!overlay) return;

    const originalLine = overlay.querySelector(".claude-dual-subs-original");
    const translatedLine = overlay.querySelector(
      ".claude-dual-subs-translated"
    );

    let lastSubIndex = -1;

    dualSubsState.syncInterval = setInterval(() => {
      const currentTime = video.currentTime;
      const sub = findCurrentSubtitle(currentTime, dualSubsState.subtitles);

      if (sub) {
        const idx = dualSubsState.subtitles.indexOf(sub);
        if (idx !== lastSubIndex) {
          originalLine.textContent = sub.text;
          translatedLine.textContent = sub.translation;
          lastSubIndex = idx;
        }
        overlay.style.visibility = "visible";
      } else {
        if (lastSubIndex !== -1) {
          originalLine.textContent = "";
          translatedLine.textContent = "";
          lastSubIndex = -1;
        }
        overlay.style.visibility = "hidden";
      }
    }, 100);
  }

  function stopSyncLoop() {
    if (dualSubsState.syncInterval) {
      clearInterval(dualSubsState.syncInterval);
      dualSubsState.syncInterval = null;
    }
  }

  // ---- Status Communication ----

  function sendStatus(message, type) {
    chrome.runtime.sendMessage({
      action: "translationStatus",
      message,
      type,
    });
  }

  // ---- Translation Orchestration ----

  async function startTranslation() {
    const videoId = getVideoId();
    if (!videoId) return { error: "Could not determine video ID." };

    const settings = await new Promise((resolve) => {
      chrome.storage.local.get(
        ["apiKey", "sourceLang", "targetLang"],
        resolve
      );
    });

    if (!settings.apiKey) return { error: "No API key configured." };
    const sourceLang = settings.sourceLang || "French";
    const targetLang = settings.targetLang || "English";

    if (sourceLang === targetLang) {
      return { error: "Source and target languages must differ." };
    }

    // Check cache first
    const cached = await getCachedTranslation(videoId, sourceLang, targetLang);
    if (cached) {
      dualSubsState.subtitles = cached;
      dualSubsState.currentVideoId = videoId;
      dualSubsState.active = true;
      hideYouTubeCaptions();
      dualSubsState.overlay = createOverlay();
      startSyncLoop();
      sendStatus("Loaded from cache.", "success");
      return { status: "Loaded from cache." };
    }

    // Extract subtitle tracks
    sendStatus("Extracting subtitles...", "info");
    const tracks = extractCaptionTracks();
    if (!tracks || tracks.length === 0) {
      const msg = "No subtitle tracks found for this video.";
      sendStatus(msg, "error");
      return { error: msg };
    }

    // Find matching track
    let track = findTrackForLanguage(tracks, sourceLang);
    if (!track) {
      // Fallback: try any auto-generated track
      track = tracks.find((t) => t.kind === "asr");
      if (track) {
        sendStatus(
          `No ${sourceLang} track found. Using auto-generated ${track.languageCode} track.`,
          "info"
        );
      }
    }
    if (!track) {
      const available = tracks
        .map((t) => `${t.languageCode}${t.kind === "asr" ? " (auto)" : ""}`)
        .join(", ");
      const msg = `No matching subtitle track found. Available: ${available}`;
      sendStatus(msg, "error");
      return { error: msg };
    }

    // Fetch subtitles
    sendStatus("Fetching subtitle data...", "info");
    let rawSubs;
    try {
      rawSubs = await fetchSubtitles(track);
    } catch (e) {
      const msg = `Failed to fetch subtitles: ${e.message}`;
      sendStatus(msg, "error");
      return { error: msg };
    }

    if (rawSubs.length === 0) {
      const msg = "Subtitle track is empty.";
      sendStatus(msg, "error");
      return { error: msg };
    }

    // Translate via background script
    const batchCount = Math.ceil(rawSubs.length / 250);
    sendStatus(
      `Translating ${rawSubs.length} subtitles${batchCount > 1 ? ` in ${batchCount} batches` : ""}...`,
      "info"
    );

    let result;
    try {
      result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            action: "translateWithClaude",
            apiKey: settings.apiKey,
            subtitles: rawSubs,
            sourceLang,
            targetLang,
          },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (response && response.error) {
              reject(new Error(response.error));
            } else {
              resolve(response);
            }
          }
        );
      });
    } catch (e) {
      const msg = `Translation failed: ${e.message}`;
      sendStatus(msg, "error");
      return { error: msg };
    }

    // Store and display
    dualSubsState.subtitles = result.translated;
    dualSubsState.currentVideoId = videoId;
    dualSubsState.active = true;

    // Cache the result
    await setCachedTranslation(
      videoId,
      sourceLang,
      targetLang,
      result.translated
    );

    hideYouTubeCaptions();
    dualSubsState.overlay = createOverlay();
    startSyncLoop();

    sendStatus(
      `Done! Displaying ${result.translated.length} dual subtitles.`,
      "success"
    );
    return { status: "Translation complete." };
  }

  // ---- Cleanup ----

  function cleanup() {
    stopSyncLoop();
    removeOverlay();
    showYouTubeCaptions();
    dualSubsState.subtitles = null;
    dualSubsState.active = false;
    dualSubsState.overlay = null;
  }

  // ---- SPA Navigation Detection ----

  let lastUrl = location.href;

  function onNavigate() {
    const currentUrl = location.href;
    if (currentUrl === lastUrl) return;
    lastUrl = currentUrl;

    const newVideoId = getVideoId();
    if (newVideoId !== dualSubsState.currentVideoId) {
      cleanup();
      dualSubsState.currentVideoId = null;
    }
  }

  // Listen for YouTube SPA navigation
  document.addEventListener("yt-navigate-finish", onNavigate);

  // Fallback: poll for URL changes
  setInterval(onNavigate, 1000);

  // ---- Message Listener ----

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "startTranslation") {
      startTranslation().then((result) => {
        sendResponse(result);
      });
      return true; // async response
    }
  });
})();
