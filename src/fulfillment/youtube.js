/**
 * YOUTUBE RESOLUTION — turn "play Tum Hi Ho" into a video that actually
 * starts playing.
 *
 * The difference this module exists for:
 *
 *   search link   youtube.com/results?search_query=tum+hi+ho
 *                 → opens a LIST. The user still has to pick and tap. The
 *                   song does not play.
 *
 *   watch link    youtube.com/watch?v=Umqb9KENgmk
 *                 → opens that video and begins playback immediately.
 *
 * To produce the second we need the video id, which means one lookup
 * against the YouTube Data API. That needs YOUTUBE_API_KEY. Without a key
 * we fall back to the search link and the caller says so honestly rather
 * than claiming the song is playing.
 *
 * Env:
 *   YOUTUBE_API_KEY   from console.cloud.google.com (YouTube Data API v3).
 *                     Free quota is 10k units/day; a search costs 100, so
 *                     ~100 song requests per day per key.
 */

const API = "https://www.googleapis.com/youtube/v3/search";

function enabled() {
  return Boolean(process.env.YOUTUBE_API_KEY);
}

/**
 * Finds the best video for a spoken music request.
 * Returns { videoId, title, channel } or null — null meaning "fall back to
 * a search link", never "pretend it worked".
 */
async function resolveVideo(query, { music = true } = {}) {
  if (!enabled() || !query) return null;
  const params = new URLSearchParams({
    part: "snippet",
    q: String(query),
    type: "video",
    maxResults: "1",
    // Music category keeps "play Shape of You" off vlogs and reaction
    // videos; it is a hint, not a filter, so a non-music request still
    // resolves sensibly.
    ...(music ? { videoCategoryId: "10" } : {}),
    // Embeddable + not age-gated: these are the videos that reliably start
    // playing rather than bouncing to a sign-in wall.
    videoEmbeddable: "true",
    key: process.env.YOUTUBE_API_KEY,
  });

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${API}?${params}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    const item = (j.items || [])[0];
    if (!item || !item.id || !item.id.videoId) return null;
    return {
      videoId: item.id.videoId,
      title: item.snippet?.title || query,
      channel: item.snippet?.channelTitle || null,
    };
  } catch (_) {
    // A lookup failure is not a reason to fail the request — the search
    // link still gets the user to their song in one more tap.
    return null;
  }
}

/**
 * The URL to hand the phone.
 *
 * On Android we target the YouTube app by package so it opens there rather
 * than in a browser tab, with the same https URL as the fallback for
 * devices without the app.
 */
function watchUrl(videoId, platform) {
  const https = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  if (String(platform || "").toLowerCase() !== "android") return https;
  return (
    `intent://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` +
    `#Intent;scheme=https;package=com.google.android.youtube;` +
    `S.browser_fallback_url=${encodeURIComponent(https)};end`
  );
}

function searchUrl(query, platform) {
  const q = encodeURIComponent(String(query || ""));
  const https = `https://www.youtube.com/results?search_query=${q}`;
  if (String(platform || "").toLowerCase() !== "android") return https;
  return (
    `intent://www.youtube.com/results?search_query=${q}` +
    `#Intent;scheme=https;package=com.google.android.youtube;` +
    `S.browser_fallback_url=${encodeURIComponent(https)};end`
  );
}

module.exports = { enabled, resolveVideo, watchUrl, searchUrl };
