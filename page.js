// This script runs in the MAIN world (YouTube's page context).
// It has access to page JS variables and makes fetches with YouTube's cookies.
// Communicates with content.js (ISOLATED world) via window.postMessage.

window.addEventListener("message", async (event) => {
  if (event.source !== window || !event.data) return;

  if (event.data.type === "DUAL_SUBS_GET_TRACKS") {
    let tracks = null;
    try {
      // Try ytInitialPlayerResponse (available on initial page load)
      if (typeof ytInitialPlayerResponse !== "undefined" && ytInitialPlayerResponse) {
        tracks =
          ytInitialPlayerResponse.captions &&
          ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer &&
          ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
      }

      // Fallback: try the player's internal data
      if (!tracks) {
        const player = document.getElementById("movie_player");
        if (player && player.getPlayerResponse) {
          const resp = player.getPlayerResponse();
          tracks =
            resp &&
            resp.captions &&
            resp.captions.playerCaptionsTracklistRenderer &&
            resp.captions.playerCaptionsTracklistRenderer.captionTracks;
        }
      }
    } catch (e) {
      // ignore
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

// Signal that page.js is ready
window.postMessage({ type: "DUAL_SUBS_PAGE_READY" }, "*");
