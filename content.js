(() => {
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

  const MODEL_NAMES = {
    "claude-haiku-4-5-20251001": "Haiku 4.5",
    "claude-sonnet-4-5-20250929": "Sonnet 4.5",
    "claude-opus-4-6": "Opus 4.6",
  };

  let dualSubsState = {
    subtitles: null,
    syncInterval: null,
    overlay: null,
    currentVideoId: null,
    active: false,
    translating: false,
    lastStatus: null, // { message, type } for popup to read on open
    displayMode: "both", // "both" | "original" | "translation" | "off"
  };

  // ---- Dictionary ----

  let dictionary = null;
  let phrasebook = null;
  let dictionaryLoading = false;
  let dictExpanded = false; // Shift toggles expanded tooltip mode

  async function loadDictionary(sourceLang) {
    if (dictionary) return dictionary;
    if (dictionaryLoading) {
      return new Promise((resolve) => {
        const check = setInterval(() => {
          if (!dictionaryLoading) {
            clearInterval(check);
            resolve(dictionary);
          }
        }, 50);
      });
    }

    // Only have fr-en for now
    const code = LANG_CODES[sourceLang];
    if (code !== "fr") return null;

    dictionaryLoading = true;
    try {
      const [dictResp, phraseResp] = await Promise.all([
        fetch(chrome.runtime.getURL("dictionaries/fr-en.json")),
        fetch(chrome.runtime.getURL("dictionaries/fr-en-phrases.json")),
      ]);
      if (dictResp.ok) {
        dictionary = await dictResp.json();
        console.log("[DualSubs] Dictionary loaded:", Object.keys(dictionary).length, "entries");
      }
      if (phraseResp.ok) {
        phrasebook = await phraseResp.json();
        console.log("[DualSubs] Phrasebook loaded:", Object.keys(phrasebook).length, "phrases");
      }
    } catch (e) {
      console.warn("[DualSubs] Dictionary load error:", e.message);
    }
    dictionaryLoading = false;
    return dictionary;
  }

  function lookupWord(word) {
    if (!dictionary) return null;
    // Normalize: lowercase, trim whitespace and punctuation
    const lower = word.trim().toLowerCase().replace(/[''.,!?;:""«»\-]+$/g, "").replace(/^[''""«»]+/g, "");
    if (!lower || lower.length < 2) return null;

    let entry = tryLookup(lower);
    if (entry) return { entry, baseEntry: resolveBase(entry) };

    // Handle French elisions: l'homme -> look up "homme"
    const apostropheIdx = lower.search(/['']/);
    if (apostropheIdx >= 0 && apostropheIdx <= 3) {
      const afterApostrophe = lower.slice(apostropheIdx + 1);
      if (afterApostrophe.length >= 2) {
        entry = tryLookup(afterApostrophe);
        if (entry) return { entry, baseEntry: resolveBase(entry) };
      }
    }

    // Handle hyphenated words: peut-être -> try full, then parts
    if (lower.includes("-")) {
      const parts = lower.split("-");
      for (const part of parts) {
        if (part.length >= 2) {
          entry = tryLookup(part);
          if (entry) return { entry, baseEntry: resolveBase(entry) };
        }
      }
    }

    return null;
  }

  function tryLookup(word) {
    let entry = dictionary[word];
    if (entry) return entry;

    // Try stripping accents for fuzzy match
    const stripped = word.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (stripped !== word) {
      entry = dictionary[stripped];
      if (entry) return entry;
    }

    // Try removing trailing 's' (basic plural)
    if (word.endsWith("s") && word.length > 2) {
      entry = dictionary[word.slice(0, -1)];
      if (entry) return entry;
    }

    return null;
  }

  function resolveBase(entry) {
    if (!entry) return null;
    // Explicit base field (from forms_map)
    if (entry.base && dictionary[entry.base]) {
      return { word: entry.base, ...dictionary[entry.base] };
    }
    // Extract base word from "... of WORD" pattern in definition
    const match = entry.def.match(/\bof\s+([a-zàâäéèêëïîôùûüÿçœæ-]+)\s*$/i);
    if (match) {
      const baseWord = match[1].toLowerCase();
      const baseEntry = dictionary[baseWord];
      if (baseEntry && baseWord !== entry.def) {
        return { word: baseWord, ...baseEntry };
      }
    }
    return null;
  }

  // ---- Communication with page.js (MAIN world) ----

  function requestFromPage(type, extraData) {
    return new Promise((resolve, reject) => {
      const requestId = Math.random().toString(36).slice(2);

      const resultTypes = {
        DUAL_SUBS_GET_TRACKS: "DUAL_SUBS_TRACKS_RESULT",
        DUAL_SUBS_GET_SUBTITLES: "DUAL_SUBS_SUBTITLES_RESULT",
        DUAL_SUBS_FETCH: "DUAL_SUBS_FETCH_RESULT",
      };
      const expectedResult = resultTypes[type];

      function onMessage(event) {
        if (event.source !== window || !event.data) return;
        if (event.data.type !== expectedResult) return;
        if (
          (type === "DUAL_SUBS_FETCH" || type === "DUAL_SUBS_GET_SUBTITLES") &&
          event.data.requestId !== requestId
        )
          return;
        window.removeEventListener("message", onMessage);
        clearTimeout(timer);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data);
      }
      window.addEventListener("message", onMessage);

      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("Timed out waiting for page script"));
      }, 15000);

      window.postMessage({ type, requestId, ...extraData }, "*");
    });
  }

  // ---- Subtitle Extraction ----

  function getVideoId() {
    const params = new URLSearchParams(window.location.search);
    return params.get("v");
  }

  async function getSubtitlesViaInterception(langCode) {
    // Ask page.js to trigger YouTube's caption loading and intercept the data
    const result = await requestFromPage("DUAL_SUBS_GET_SUBTITLES", {
      langCode,
    });
    if (!result.data || !result.data.text) return null;

    const { text, fmt } = result.data;
    console.log("[DualSubs] Subtitle format:", fmt, "length:", text.length);
    if (fmt === "json3" || text.trim().startsWith("{")) {
      try {
        return parseJson3Subtitles(JSON.parse(text));
      } catch (e) {
        console.warn("[DualSubs] JSON3 parse failed, trying XML:", e.message);
      }
    }
    return parseXmlSubtitles(text);
  }

  async function getAvailableTracks() {
    // Ask page.js for track list
    try {
      const result = await requestFromPage("DUAL_SUBS_GET_TRACKS");
      if (result.tracks && result.tracks.length > 0) return result.tracks;
    } catch {
      // fall through
    }

    // Fallback: parse from script tags
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const text = script.textContent;
      if (!text.includes("captionTracks")) continue;

      const marker = '"captionTracks":';
      const idx = text.indexOf(marker);
      if (idx === -1) continue;

      const arrStart = text.indexOf("[", idx + marker.length);
      if (arrStart === -1) continue;

      let depth = 0;
      let inStr = false;
      let esc = false;
      let arrEnd = -1;
      for (let i = arrStart; i < text.length; i++) {
        const ch = text[i];
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === "[") depth++;
        if (ch === "]") {
          depth--;
          if (depth === 0) { arrEnd = i + 1; break; }
        }
      }
      if (arrEnd === -1) continue;

      try {
        const tracks = JSON.parse(text.substring(arrStart, arrEnd));
        if (tracks && tracks.length > 0) return tracks;
      } catch {
        // continue
      }
    }

    return null;
  }

  function findTrackForLanguage(tracks, langName) {
    const code = LANG_CODES[langName];
    if (!code) return null;

    const manual = tracks.find(
      (t) => t.languageCode === code && t.kind !== "asr"
    );
    if (manual) return manual;

    const auto = tracks.find((t) => t.languageCode === code);
    if (auto) return auto;

    if (code === "zh") {
      const zhVariant = tracks.find((t) =>
        t.languageCode.startsWith("zh")
      );
      if (zhVariant) return zhVariant;
    }

    return null;
  }

  function parseJson3Subtitles(data) {
    const subtitles = [];
    if (!data.events) return subtitles;

    for (const event of data.events) {
      if (!event.segs) continue;
      const fullText = event.segs.map((s) => s.utf8 || "").join("").trim();
      if (!fullText || fullText === "\n") continue;

      const eventStartMs = event.tStartMs || 0;
      const eventDurMs = event.dDurMs || event.dDurationMs || 0;
      const eventEndMs = eventStartMs + eventDurMs;

      // Build word-level timing from segments
      const words = [];
      for (let i = 0; i < event.segs.length; i++) {
        const seg = event.segs[i];
        const wordText = (seg.utf8 || "").trim();
        if (!wordText || wordText === "\n") continue;

        const offsetMs = seg.tOffsetMs != null ? seg.tOffsetMs : 0;
        const wordStartMs = eventStartMs + offsetMs;

        // Word end = next segment's start, or event end for last word
        let wordEndMs = eventEndMs;
        for (let j = i + 1; j < event.segs.length; j++) {
          const nextSeg = event.segs[j];
          const nextText = (nextSeg.utf8 || "").trim();
          if (!nextText || nextText === "\n") continue;
          const nextOffsetMs = nextSeg.tOffsetMs != null ? nextSeg.tOffsetMs : 0;
          wordEndMs = eventStartMs + nextOffsetMs;
          break;
        }

        words.push({
          word: wordText,
          start: wordStartMs / 1000,
          end: wordEndMs / 1000,
        });
      }

      subtitles.push({
        start: eventStartMs / 1000,
        dur: eventDurMs / 1000,
        text: decodeHtmlEntities(fullText),
        words: words.length > 0 ? words : null,
      });
    }
    if (subtitles.length > 0) {
      console.log(`[DualSubs] Parsed ${subtitles.length} subtitles`);
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
      if (text) subtitles.push({ start, dur, text, words: null });
    }
    return subtitles;
  }

  function decodeHtmlEntities(text) {
    const el = document.createElement("textarea");
    el.innerHTML = text;
    return el.value;
  }

  // ---- Cache ----

  function cacheKey(videoId, sourceLang, targetLang, model) {
    return `dualsubs_cache_${videoId}_${sourceLang}_${targetLang}_${model}`;
  }

  async function getCachedTranslation(videoId, sourceLang, targetLang, model) {
    return new Promise((resolve) => {
      const key = cacheKey(videoId, sourceLang, targetLang, model);
      chrome.storage.local.get([key], (result) => {
        resolve(result[key] || null);
      });
    });
  }

  async function setCachedTranslation(videoId, sourceLang, targetLang, model, data) {
    const key = cacheKey(videoId, sourceLang, targetLang, model);
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: data }, resolve);
    });
  }

  // ---- Overlay Display ----

  function createOverlay() {
    removeOverlay();

    const playerContainer =
      document.querySelector("#movie_player") ||
      document.querySelector(".html5-video-player");
    if (!playerContainer) return null;

    const overlay = document.createElement("div");
    overlay.id = "claude-dual-subs-overlay";

    // Nav buttons
    const nav = document.createElement("div");
    nav.className = "ds-nav";

    const prevBtn = document.createElement("button");
    prevBtn.className = "ds-nav-btn";
    prevBtn.textContent = "\u25C0";
    prevBtn.title = "Previous subtitle";
    prevBtn.addEventListener("click", () => seekToSubtitle(-1));

    const nextBtn = document.createElement("button");
    nextBtn.className = "ds-nav-btn";
    nextBtn.textContent = "\u25B6";
    nextBtn.title = "Next subtitle";
    nextBtn.addEventListener("click", () => seekToSubtitle(1));

    nav.appendChild(prevBtn);
    nav.appendChild(nextBtn);

    const originalLine = document.createElement("div");
    originalLine.className = "claude-dual-subs-original";

    const translatedLine = document.createElement("div");
    translatedLine.className = "claude-dual-subs-translated";

    overlay.appendChild(nav);
    overlay.appendChild(originalLine);
    overlay.appendChild(translatedLine);

    playerContainer.appendChild(overlay);
    return overlay;
  }

  function seekToSubtitle(direction) {
    const video = document.querySelector("video");
    const subs = dualSubsState.subtitles;
    if (!video || !subs || subs.length === 0) return;

    const currentTime = video.currentTime;

    if (direction > 0) {
      // Next: find first subtitle that starts after current time + small buffer
      for (let i = 0; i < subs.length; i++) {
        if (subs[i].start > currentTime + 0.5) {
          video.currentTime = subs[i].start;
          return;
        }
      }
    } else {
      // Prev: find the subtitle before the current one
      let currentIdx = -1;
      for (let i = subs.length - 1; i >= 0; i--) {
        if (currentTime >= subs[i].start) {
          currentIdx = i;
          break;
        }
      }
      // Go to previous subtitle (or start of current if we're mid-subtitle)
      const target = currentIdx > 0 ? currentIdx - 1 : 0;
      video.currentTime = subs[target].start;
    }
  }

  function removeOverlay() {
    const existing = document.getElementById("claude-dual-subs-overlay");
    if (existing) existing.remove();
    // Also remove any stray tooltips
    const tooltip = document.getElementById("ds-dict-tooltip");
    if (tooltip) tooltip.remove();
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

  // ---- Subtitle Rendering ----

  function renderCombinedSubs(originalLine, translatedLine, subs) {
    // Detach tooltip before clearing so it's not destroyed
    const tooltip = getTooltip();
    if (tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);
    tooltip.style.display = "none";

    originalLine.innerHTML = "";

    // Render all subs' words combined into one line
    subs.forEach((sub, subIdx) => {
      if (subIdx > 0) originalLine.appendChild(document.createTextNode("  "));

      const words = sub.words && sub.words.length > 0
        ? sub.words.map((w) => w.word)
        : sub.text.split(/\s+/);

      words.forEach((word, i) => {
        if (i > 0) originalLine.appendChild(document.createTextNode(" "));
        const span = document.createElement("span");
        span.className = "ds-word";
        span.textContent = word;
        span.dataset.subStart = sub.start;
        span.addEventListener("click", onWordClick);
        span.addEventListener("mouseenter", onWordHover);
        span.addEventListener("mouseleave", onWordLeave);
        originalLine.appendChild(span);
      });
    });

    // Re-attach tooltip container
    originalLine.appendChild(tooltip);

    // Combine translations into one line
    translatedLine.textContent = subs.map((s) => s.translation || "").join("  ");
  }

  function onWordClick(e) {
    e.stopPropagation();
    const time = parseFloat(e.target.dataset.subStart);
    if (!isNaN(time)) {
      const video = document.querySelector("video");
      if (video) video.currentTime = time;
    }
  }

  // ---- Dictionary Tooltip ----

  let tooltipEl = null;

  function getTooltip() {
    if (!tooltipEl) {
      tooltipEl = document.createElement("div");
      tooltipEl.id = "ds-dict-tooltip";
      tooltipEl.className = "ds-dict-tooltip";
      tooltipEl.style.display = "none";
    }
    return tooltipEl;
  }

  function getAdjacentWords(wordSpan, count) {
    // Collect next N word spans (siblings, skipping text nodes)
    const words = [];
    let node = wordSpan.nextSibling;
    while (words.length < count && node) {
      if (node.nodeType === 1 && node.classList.contains("ds-word")) {
        words.push(node.textContent);
      }
      node = node.nextSibling;
    }
    return words;
  }

  function lookupPhrase(wordSpan) {
    if (!phrasebook) return null;
    const word = wordSpan.textContent.trim().toLowerCase();
    const nextWords = getAdjacentWords(wordSpan, 3);
    // Try 4-word, 3-word, 2-word phrases
    for (let len = Math.min(nextWords.length, 3); len >= 1; len--) {
      const phrase = [word, ...nextWords.slice(0, len)].join(" ").toLowerCase()
        .replace(/[''.,!?;:]+$/g, "");
      if (phrasebook[phrase]) {
        return { phrase, entry: phrasebook[phrase] };
      }
    }
    return null;
  }

  function onWordHover(e) {
    const wordSpan = e.target;
    const wordText = wordSpan.textContent;

    const tooltip = getTooltip();

    // Check for multi-word phrase first
    const phraseResult = lookupPhrase(wordSpan);
    if (phraseResult) {
      const { phrase, entry } = phraseResult;
      let html = `<span class="ds-tt-word">${escapeHtml(phrase)}</span>`;
      if (entry.pos) html += `<span class="ds-tt-pos">${escapeHtml(entry.pos)}</span>`;
      html += `<span class="ds-tt-def">${escapeHtml(entry.def)}</span>`;
      // Also show individual word lookup below
      const wordResult = lookupWord(wordText);
      if (wordResult) {
        html += '<span class="ds-tt-base">';
        html += buildTooltipHtml(wordText, wordResult, dictExpanded);
        html += "</span>";
      }
      tooltip.innerHTML = html;
    } else {
      const result = lookupWord(wordText);
      if (!result) {
        tooltip.style.display = "none";
        return;
      }
      tooltip.innerHTML = buildTooltipHtml(wordText, result, dictExpanded);
    }

    // Position above the word
    const originalLine = wordSpan.closest(".claude-dual-subs-original");
    if (originalLine && !originalLine.contains(tooltip)) {
      originalLine.appendChild(tooltip);
    }

    const spanRect = wordSpan.getBoundingClientRect();
    const lineRect = originalLine.getBoundingClientRect();
    tooltip.style.display = "block";
    tooltip.style.left = (spanRect.left - lineRect.left + spanRect.width / 2) + "px";
  }

  function buildTooltipHtml(wordText, result, expanded) {
    const { entry, baseEntry } = result;
    let html = `<span class="ds-tt-word">${escapeHtml(wordText)}</span>`;
    if (entry.pos) html += `<span class="ds-tt-pos">${escapeHtml(entry.pos)}</span>`;
    if (entry.gender) html += `<span class="ds-tt-pos"> (${escapeHtml(entry.gender)})</span>`;

    if (expanded && entry.defs && entry.defs.length > 1) {
      // Show all senses numbered
      html += '<span class="ds-tt-defs">';
      entry.defs.forEach((d, i) => {
        html += `<span class="ds-tt-def">${i + 1}. ${escapeHtml(d)}</span>`;
      });
      html += "</span>";
    } else {
      // Show primary definition (or form-of info)
      const def = entry.def || (baseEntry ? `form of ${baseEntry.word}` : "");
      if (def) html += `<span class="ds-tt-def">${escapeHtml(def)}</span>`;
    }

    // Show base word definition (always for inflected forms)
    if (baseEntry) {
      html += '<span class="ds-tt-base">';
      html += `<span class="ds-tt-word">${escapeHtml(baseEntry.word)}</span>`;
      if (baseEntry.pos) html += `<span class="ds-tt-pos">${escapeHtml(baseEntry.pos)}</span>`;
      if (expanded && baseEntry.defs && baseEntry.defs.length > 1) {
        html += '<span class="ds-tt-defs">';
        baseEntry.defs.forEach((d, i) => {
          html += `<span class="ds-tt-def">${i + 1}. ${escapeHtml(d)}</span>`;
        });
        html += "</span>";
      } else {
        html += `<span class="ds-tt-def">${escapeHtml(baseEntry.def)}</span>`;
      }
      html += "</span>";
    }

    if (expanded) {
      html += '<span class="ds-tt-hint">Shift: collapse</span>';
    } else if ((entry.defs && entry.defs.length > 1) || (baseEntry && baseEntry.defs && baseEntry.defs.length > 1)) {
      html += '<span class="ds-tt-hint">Shift: more</span>';
    }

    return html;
  }

  function onWordLeave() {
    const tooltip = getTooltip();
    tooltip.style.display = "none";
  }

  document.addEventListener("keydown", (e) => {
    // Shift toggles expanded dictionary tooltip
    if (e.key === "Shift" && !e.repeat) {
      dictExpanded = !dictExpanded;
      const tooltip = getTooltip();
      if (tooltip.style.display === "block") {
        const hoveredWord = document.querySelector(".ds-word:hover");
        if (hoveredWord) onWordHover({ target: hoveredWord });
      }
      return;
    }
    // [ and ] for prev/next subtitle
    if (dualSubsState.active && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === "[") { e.preventDefault(); seekToSubtitle(-1); }
      if (e.key === "]") { e.preventDefault(); seekToSubtitle(1); }
    }
  });

  function escapeHtml(text) {
    const el = document.createElement("span");
    el.textContent = text;
    return el.innerHTML;
  }

  // ---- Sync Loop ----

  function startSyncLoop() {
    stopSyncLoop();

    const video = document.querySelector("video");
    if (!video || !dualSubsState.subtitles) return;

    const overlay = dualSubsState.overlay;
    if (!overlay) return;

    const originalLine = overlay.querySelector(".claude-dual-subs-original");
    const translatedLine = overlay.querySelector(".claude-dual-subs-translated");

    let lastIdx = -1;
    let lastMode = null;

    dualSubsState.syncInterval = setInterval(() => {
      const mode = dualSubsState.displayMode;

      if (mode === "off") {
        if (lastMode !== "off") {
          overlay.style.visibility = "hidden";
          lastMode = "off";
        }
        return;
      }

      const currentTime = video.currentTime;
      const subs = dualSubsState.subtitles;

      // Find the latest subtitle that has started
      let currentIdx = -1;
      for (let i = subs.length - 1; i >= 0; i--) {
        if (currentTime >= subs[i].start) {
          currentIdx = i;
          break;
        }
      }
      // Hide if past the last subtitle's end
      if (currentIdx >= 0 && currentIdx === subs.length - 1) {
        const last = subs[currentIdx];
        if (currentTime > last.start + last.dur + 2) {
          currentIdx = -1;
        }
      }

      const modeChanged = mode !== lastMode;
      lastMode = mode;

      if (currentIdx >= 0) {
        if (currentIdx !== lastIdx || modeChanged) {
          renderCombinedSubs(originalLine, translatedLine, [subs[currentIdx]]);
          // Apply display mode
          originalLine.style.display = mode === "translation" ? "none" : "";
          translatedLine.style.display = mode === "original" ? "none" : "";
          lastIdx = currentIdx;
        }
        overlay.style.visibility = "visible";
      } else {
        if (lastIdx !== -1) {
          originalLine.innerHTML = "";
          translatedLine.textContent = "";
          lastIdx = -1;
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
    dualSubsState.lastStatus = { message, type };
    if (type === "success" || type === "error") {
      dualSubsState.translating = false;
    }
    chrome.runtime.sendMessage(
      { action: "translationStatus", message, type },
      () => void chrome.runtime.lastError
    );
  }

  // ---- Translation (runs directly in content script, no service worker) ----

  const BATCH_SIZE = 150;

  async function translateBatch(apiKey, batch, offset, sourceLang, targetLang, model) {
    const numberedLines = batch
      .map((sub, i) => `[${offset + i}] ${sub.text}`)
      .join("\n");

    const systemPrompt =
      `You are a subtitle translator. Translate ${sourceLang} subtitles to natural ${targetLang}. ` +
      "Each line has a number like [0]. " +
      "CRITICAL: Each [N] output MUST be the translation of ONLY source [N]. " +
      "Do NOT move or merge meaning between lines — even if a sentence spans multiple lines, " +
      "translate each fragment separately so they stay time-aligned. " +
      "Output ONLY translated lines with [N] prefixes.";

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: model || "claude-haiku-4-5-20251001",
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: numberedLines }],
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      if (resp.status === 401) throw new Error("Invalid API key.");
      if (resp.status === 429) throw new Error("Rate limited — wait a moment and retry.");
      throw new Error(`API error ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = await resp.json();
    const text = data.content && data.content[0] && data.content[0].text;
    if (!text) throw new Error("Empty response from API.");

    return parseTranslatedLines(text, batch.length, offset);
  }

  function parseTranslatedLines(text, expectedCount, offset) {
    const lines = text.split("\n").filter((l) => l.trim());
    const result = new Array(expectedCount).fill("");

    for (const line of lines) {
      const match = line.match(/^\[(\d+)\]\s*(.*)$/);
      if (match) {
        const idx = parseInt(match[1], 10) - offset;
        if (idx >= 0 && idx < expectedCount) {
          result[idx] = match[2].trim();
        }
      }
    }

    // Fallback: if most indices failed, use positional order
    const filled = result.filter((r) => r).length;
    if (filled < expectedCount * 0.5 && lines.length >= expectedCount * 0.5) {
      for (let i = 0; i < Math.min(lines.length, expectedCount); i++) {
        const clean = lines[i].replace(/^\[\d+\]\s*/, "").trim();
        if (clean) result[i] = clean;
      }
    }

    return result;
  }

  // ---- Translation Orchestration ----

  async function startTranslation() {
    dualSubsState.translating = true;
    const videoId = getVideoId();
    if (!videoId) return { error: "Could not determine video ID." };

    const settings = await new Promise((resolve) => {
      chrome.storage.local.get(
        ["apiKey", "sourceLang", "targetLang", "model"],
        resolve
      );
    });

    if (!settings.apiKey) return { error: "No API key configured." };
    const sourceLang = settings.sourceLang || "French";
    const targetLang = settings.targetLang || "English";
    const model = settings.model || "claude-haiku-4-5-20251001";
    const modelName = MODEL_NAMES[model] || model;

    if (sourceLang === targetLang) {
      return { error: "Source and target languages must differ." };
    }

    // Start loading dictionary (await so it's ready for hover)
    await loadDictionary(sourceLang);

    // Check cache first
    const cached = await getCachedTranslation(videoId, sourceLang, targetLang, model);
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

    // Check available tracks
    sendStatus("Finding subtitle tracks...", "info");
    const tracks = await getAvailableTracks();
    if (!tracks || tracks.length === 0) {
      const msg = "No subtitle tracks found for this video.";
      sendStatus(msg, "error");
      return { error: msg };
    }

    let track = findTrackForLanguage(tracks, sourceLang);
    if (!track) {
      track = tracks.find((t) => t.kind === "asr") || tracks[0];
      sendStatus(
        `No ${sourceLang} track. Using ${track.languageCode} track.`,
        "info"
      );
    }

    // Get subtitle data via interception
    sendStatus("Loading subtitles via YouTube player...", "info");
    let rawSubs = null;
    try {
      rawSubs = await getSubtitlesViaInterception(track.languageCode);
    } catch (e) {
      sendStatus("Interception: " + e.message, "info");
    }

    if (!rawSubs || rawSubs.length === 0) {
      const msg =
        "Could not capture subtitle data. Make sure captions are available.";
      sendStatus(msg, "error");
      return { error: msg };
    }

    // Translate directly from content script (no service worker dependency)
    const batches = [];
    for (let i = 0; i < rawSubs.length; i += BATCH_SIZE) {
      batches.push(rawSubs.slice(i, i + BATCH_SIZE));
    }

    sendStatus(
      `Translating ${rawSubs.length} subtitles with ${modelName}` +
      (batches.length > 1 ? ` (${batches.length} batches)` : "") + "...",
      "info"
    );

    const allTranslations = [];
    try {
      for (let b = 0; b < batches.length; b++) {
        if (batches.length > 1) {
          sendStatus(
            `Translating batch ${b + 1}/${batches.length} with ${modelName}...`,
            "info"
          );
        }
        const parsed = await translateBatch(
          settings.apiKey, batches[b], b * BATCH_SIZE,
          sourceLang, targetLang, model
        );
        allTranslations.push(...parsed);
      }
    } catch (e) {
      const msg = `Translation failed: ${e.message}`;
      sendStatus(msg, "error");
      return { error: msg };
    }

    // Merge — each subtitle gets its own translation at the same index
    const translated = rawSubs.map((sub, i) => ({
      start: sub.start,
      dur: sub.dur,
      text: sub.text,
      words: sub.words || null,
      translation: allTranslations[i] || sub.text,
    }));

    // Store and display
    dualSubsState.subtitles = translated;
    dualSubsState.currentVideoId = videoId;
    dualSubsState.active = true;

    await setCachedTranslation(videoId, sourceLang, targetLang, model, translated);

    hideYouTubeCaptions();
    dualSubsState.overlay = createOverlay();
    startSyncLoop();

    sendStatus(
      `Done! ${translated.length} dual subtitles.`,
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

  document.addEventListener("yt-navigate-finish", onNavigate);
  setInterval(onNavigate, 1000);

  // ---- Message Listener ----

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "startTranslation") {
      startTranslation().then((result) => {
        try { sendResponse(result); } catch (e) { /* popup closed */ }
      });
      return true;
    }
    if (message.action === "getState") {
      sendResponse({
        active: dualSubsState.active,
        translating: dualSubsState.translating,
        lastStatus: dualSubsState.lastStatus,
        displayMode: dualSubsState.displayMode,
        subtitleCount: dualSubsState.subtitles ? dualSubsState.subtitles.length : 0,
      });
      return false;
    }
    if (message.action === "setDisplayMode") {
      dualSubsState.displayMode = message.mode;
      sendResponse({ ok: true });
      return false;
    }
    if (message.action === "clearSubtitles") {
      const videoId = getVideoId();
      cleanup();
      dualSubsState.currentVideoId = null;
      if (videoId) {
        chrome.storage.local.get(null, (items) => {
          const keysToRemove = Object.keys(items).filter(
            (k) => k.startsWith("dualsubs_cache_" + videoId)
          );
          if (keysToRemove.length > 0) {
            chrome.storage.local.remove(keysToRemove);
          }
          sendResponse({ cleared: keysToRemove.length, videoId });
        });
      } else {
        sendResponse({ cleared: 0 });
      }
      return true;
    }
  });
})();
