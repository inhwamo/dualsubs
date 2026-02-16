// This script runs in the MAIN world (YouTube's page context).
// It has access to page JS variables and makes fetches with YouTube's cookies.
// Communicates with content.js (ISOLATED world) via window.postMessage.

// Get caption tracks via the innertube /player API. The page HTML's
// captionTracks URLs contain an exp=xpe experiment flag that causes
// YouTube's timedtext API to return empty responses. The innertube API
// returns clean URLs without this flag.
async function getTracksViaInnertube(videoId) {
  try {
    const apiKey =
      (typeof ytcfg !== "undefined" && ytcfg.get && ytcfg.get("INNERTUBE_API_KEY")) ||
      "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
    const clientName =
      (typeof ytcfg !== "undefined" && ytcfg.get && ytcfg.get("INNERTUBE_CLIENT_NAME")) ||
      "WEB";
    const clientVersion =
      (typeof ytcfg !== "undefined" && ytcfg.get && ytcfg.get("INNERTUBE_CLIENT_VERSION")) ||
      "2.20250101.00.00";

    const resp = await fetch(
      "/youtubei/v1/player?key=" + apiKey + "&pretend_wifi=1",
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId: videoId,
          context: {
            client: {
              clientName: clientName,
              clientVersion: clientVersion,
              hl: navigator.language || "en",
            },
          },
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      }
    );

    const data = await resp.json();
    const tracks =
      data &&
      data.captions &&
      data.captions.playerCaptionsTracklistRenderer &&
      data.captions.playerCaptionsTracklistRenderer.captionTracks;
    return tracks || null;
  } catch (e) {
    return null;
  }
}

function getVideoIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("v");
}

window.addEventListener("message", async (event) => {
  if (event.source !== window || !event.data) return;

  if (event.data.type === "DUAL_SUBS_GET_TRACKS") {
    let tracks = null;

    // Method 1: innertube /player API (returns URLs without exp=xpe bug)
    const videoId = getVideoIdFromUrl();
    if (videoId) {
      tracks = await getTracksViaInnertube(videoId);
    }

    // Method 2: ytInitialPlayerResponse (may have broken URLs, used as last resort)
    if (!tracks) {
      try {
        if (typeof ytInitialPlayerResponse !== "undefined" && ytInitialPlayerResponse) {
          tracks =
            ytInitialPlayerResponse.captions &&
            ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer &&
            ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
        }
      } catch (e) {
        // ignore
      }
    }

    // Method 3: player object
    if (!tracks) {
      try {
        const player = document.getElementById("movie_player");
        if (player && player.getPlayerResponse) {
          const resp = player.getPlayerResponse();
          tracks =
            resp &&
            resp.captions &&
            resp.captions.playerCaptionsTracklistRenderer &&
            resp.captions.playerCaptionsTracklistRenderer.captionTracks;
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

  if (event.data.type === "DUAL_SUBS_FETCH") {
    const { url, requestId } = event.data;
    try {
      const resp = await fetch(url, { credentials: "include" });
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
