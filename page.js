// This script runs in the MAIN world (YouTube's page context).
// It intercepts YouTube's own timedtext requests to capture subtitle data,
// bypassing the exp=xpe experiment flag that breaks direct fetching.

const interceptedSubtitles = {};
let pendingResolve = null;

// ---- Intercept XMLHttpRequest (YouTube uses XHR for timedtext) ----

const OrigXHR = XMLHttpRequest;
const origOpen = OrigXHR.prototype.open;
const origSend = OrigXHR.prototype.send;

OrigXHR.prototype.open = function (method, url, ...rest) {
  this._dualSubsUrl = typeof url === "string" ? url : "";
  return origOpen.call(this, method, url, ...rest);
};

OrigXHR.prototype.send = function (...args) {
  if (this._dualSubsUrl && this._dualSubsUrl.includes("/api/timedtext")) {
    this.addEventListener("load", function () {
      try {
        if (this.responseText && this.responseText.trim()) {
          const url = new URL(this._dualSubsUrl, location.origin);
          const lang = url.searchParams.get("lang") || "unknown";
          const fmt = url.searchParams.get("fmt") || "xml";
          const kind = url.searchParams.get("kind") || "";
          const key = lang + ":" + kind;

          interceptedSubtitles[key] = {
            text: this.responseText,
            fmt: fmt,
            lang: lang,
            kind: kind,
          };

          // If someone is waiting for this data, resolve immediately
          if (pendingResolve && pendingResolve.lang === lang) {
            pendingResolve.resolve(interceptedSubtitles[key]);
            pendingResolve = null;
          }
        }
      } catch (e) {
        // ignore interception errors
      }
    });
  }
  return origSend.call(this, ...args);
};

// ---- Also intercept fetch (in case YouTube uses it) ----

const origFetch = window.fetch;
window.fetch = async function (input, init) {
  const url = typeof input === "string" ? input : input instanceof Request ? input.url : "";
  const resp = await origFetch.call(this, input, init);

  if (url.includes("/api/timedtext")) {
    try {
      const cloned = resp.clone();
      const text = await cloned.text();
      if (text && text.trim()) {
        const parsed = new URL(url, location.origin);
        const lang = parsed.searchParams.get("lang") || "unknown";
        const fmt = parsed.searchParams.get("fmt") || "xml";
        const kind = parsed.searchParams.get("kind") || "";
        const key = lang + ":" + kind;

        interceptedSubtitles[key] = { text, fmt, lang, kind };

        if (pendingResolve && pendingResolve.lang === lang) {
          pendingResolve.resolve(interceptedSubtitles[key]);
          pendingResolve = null;
        }
      }
    } catch (e) {
      // ignore
    }
  }

  return resp;
};

// ---- Trigger YouTube to load captions ----

function triggerCaptionLoad(langCode) {
  try {
    const player = document.getElementById("movie_player");
    if (!player) return false;

    // Get available tracks
    const tracklist = player.getOption("captions", "tracklist");
    if (!tracklist || !tracklist.length) return false;

    // Find matching track
    let track = tracklist.find(
      (t) => t.languageCode === langCode
    );
    if (!track) track = tracklist[0]; // fallback to first available

    // Enable captions with this track — this triggers YouTube to fetch the data
    player.setOption("captions", "track", track);
    return true;
  } catch (e) {
    return false;
  }
}

function getVideoIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("v");
}

// ---- Message handler ----

window.addEventListener("message", async (event) => {
  if (event.source !== window || !event.data) return;

  if (event.data.type === "DUAL_SUBS_GET_TRACKS") {
    // Return available tracks from the player
    let tracks = null;
    try {
      const player = document.getElementById("movie_player");
      if (player && player.getOption) {
        const tracklist = player.getOption("captions", "tracklist");
        if (tracklist && tracklist.length) {
          tracks = tracklist.map((t) => ({
            languageCode: t.languageCode,
            kind: t.kind || "",
            name: t.displayName || t.languageName || t.languageCode,
          }));
        }
      }
    } catch (e) {
      // ignore
    }

    // Fallback: ytInitialPlayerResponse
    if (!tracks) {
      try {
        if (typeof ytInitialPlayerResponse !== "undefined" && ytInitialPlayerResponse) {
          const ct =
            ytInitialPlayerResponse.captions &&
            ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer &&
            ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
          if (ct) {
            tracks = ct.map((t) => ({
              languageCode: t.languageCode,
              kind: t.kind || "",
              name: (t.name && t.name.simpleText) || t.languageCode,
              baseUrl: t.baseUrl,
            }));
          }
        }
      } catch (e) {
        // ignore
      }
    }

    window.postMessage(
      { type: "DUAL_SUBS_TRACKS_RESULT", tracks: tracks || null },
      "*"
    );
  }

  if (event.data.type === "DUAL_SUBS_GET_SUBTITLES") {
    const { langCode, requestId } = event.data;
    const key = langCode + ":" + "asr";
    const keyManual = langCode + ":";

    // Check if we already intercepted subtitles for this language
    let data = interceptedSubtitles[key] || interceptedSubtitles[keyManual];

    if (data) {
      window.postMessage(
        { type: "DUAL_SUBS_SUBTITLES_RESULT", requestId, data },
        "*"
      );
      return;
    }

    // Trigger YouTube to load captions and wait for interception
    triggerCaptionLoad(langCode);

    // Wait up to 10 seconds for the intercepted data
    const timeout = setTimeout(() => {
      if (pendingResolve && pendingResolve.requestId === requestId) {
        pendingResolve.resolve(null);
        pendingResolve = null;
      }
    }, 10000);

    const result = await new Promise((resolve) => {
      // Check again in case it arrived during triggerCaptionLoad
      const existing = interceptedSubtitles[key] || interceptedSubtitles[keyManual];
      if (existing) {
        clearTimeout(timeout);
        resolve(existing);
        return;
      }
      pendingResolve = { resolve, lang: langCode, requestId };
    });

    clearTimeout(timeout);
    window.postMessage(
      { type: "DUAL_SUBS_SUBTITLES_RESULT", requestId, data: result },
      "*"
    );
  }

  // Keep the plain fetch handler for non-timedtext URLs if needed
  if (event.data.type === "DUAL_SUBS_FETCH") {
    const { url, requestId } = event.data;
    try {
      const resp = await origFetch(url, { credentials: "include" });
      const text = await resp.text();
      window.postMessage(
        { type: "DUAL_SUBS_FETCH_RESULT", requestId, text },
        "*"
      );
    } catch (e) {
      window.postMessage(
        { type: "DUAL_SUBS_FETCH_RESULT", requestId, error: e.message },
        "*"
      );
    }
  }
});

window.postMessage({ type: "DUAL_SUBS_PAGE_READY" }, "*");
