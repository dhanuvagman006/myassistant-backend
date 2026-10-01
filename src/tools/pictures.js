/**
 * A PICTURE OF SOMEONE OR SOMETHING, IN THE APP (2026-10-01).
 *
 * Client: "when I say show image of someone the image should pop up, but
 * it's opening Instagram". The prompts sent 'show me images of X' to
 * open_app, which hands the phone to another app. A picture request is
 * answered HERE: find one on the web, download it, save it as a document
 * and the app pops it full screen — the same show_image path a generated
 * image takes. Instagram opens only when the user says Instagram.
 *
 * SOURCES, IN ORDER. Brave's image search (the web search key; the plan
 * may not include it, which just means the next source), then Wikipedia's
 * lead image for the subject, then Wikipedia's search for the subject.
 * Each candidate is downloaded through safeFetch — the URL came from a
 * third party, so it must never be a way into this server's own network —
 * and must really be an image under IMAGE_MAX. The first that downloads
 * is the answer; nothing is ever invented.
 */
const { safeFetch } = require("../services/safeFetch");

const SEARCH_TIMEOUT_MS = 6000;
const FETCH_TIMEOUT_MS = 8000;
const IMAGE_MAX = 6 * 1024 * 1024;
const IMAGE_MIME = /^image\/(jpeg|png|webp|gif)$/i;
const UA = "Mozilla/5.0 (Android) MyAssistant/1.0";

/** Brave image results → [{url, page, title, source}]. [] when the plan
 *  lacks image search, the key is missing, or nothing came back. */
async function braveImages(subject, count) {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return [];
  try {
    const params = new URLSearchParams({ q: subject, count: String(count), safesearch: "strict", spellcheck: "1" });
    const r = await fetch(`https://api.search.brave.com/res/v1/images/search?${params}`, {
      headers: { accept: "application/json", "x-subscription-token": key },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!r.ok) {
      console.warn(`pictures: brave images ${r.status} — trying wikipedia`);
      return [];
    }
    const j = await r.json();
    return (j.results || [])
      .map((x) => ({
        url: (x.properties && x.properties.url) || (x.thumbnail && x.thumbnail.src) || "",
        page: x.url || "",
        title: String(x.title || "").trim(),
        source: String(x.source || "").trim(),
      }))
      .filter((x) => /^https?:\/\//i.test(x.url));
  } catch (e) {
    console.warn(`pictures: brave images failed — ${e.message}`);
    return [];
  }
}

/** Wikipedia's lead image for the article the subject names, then for the
 *  best search hit. Public figures, places and things nearly always have one. */
async function wikipediaImages(subject) {
  const out = [];
  const title = subject.trim().replace(/\s+/g, "_");
  const pull = async (url) => {
    const r = await fetch(url, { headers: { accept: "application/json", "user-agent": UA }, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    return r.ok ? r.json() : null;
  };
  try {
    const j = await pull(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    if (j && j.type !== "disambiguation") {
      const page = (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) || "";
      const thumb = j.thumbnail && j.thumbnail.source;
      // A phone-sized rendition first (the original can be 5 MB+): the
      // thumbnail link carries its width, so 1280px is the same path.
      if (thumb && /\/\d+px-/.test(thumb)) out.push({ url: thumb.replace(/\/\d+px-/, "/1280px-"), page, title: j.title || subject, source: "Wikipedia" });
      const orig = j.originalimage && j.originalimage.source;
      if (orig) out.push({ url: orig, page, title: j.title || subject, source: "Wikipedia" });
    }
  } catch (_) { /* next */ }
  if (out.length) return out;
  try {
    const params = new URLSearchParams({ action: "query", generator: "search", gsrsearch: subject, gsrlimit: "3", prop: "pageimages", piprop: "original", format: "json", origin: "*" });
    const j = await pull(`https://en.wikipedia.org/w/api.php?${params}`);
    const pages = Object.values((j && j.query && j.query.pages) || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
    for (const p of pages) {
      if (p.original && p.original.source) out.push({ url: p.original.source, page: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(p.title).replace(/ /g, "_"))}`, title: p.title, source: "Wikipedia" });
    }
  } catch (_) { /* nothing */ }
  return out;
}

/** The image bytes, or null when the link is not a usable image. */
async function fetchImage(url) {
  try {
    const r = await safeFetch(url, { headers: { "user-agent": UA, accept: "image/*" } }, { timeoutMs: FETCH_TIMEOUT_MS });
    if (!r.ok) return null;
    const mime = String(r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_MIME.test(mime)) return null;
    const reader = r.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > IMAGE_MAX) { try { await reader.cancel(); } catch (_) {} return null; }
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks.map(Buffer.from));
    // A tracking pixel or a broken thumbnail is not a picture of anyone.
    if (buffer.length < 4096) return null;
    return { buffer, mime };
  } catch (_) {
    return null;
  }
}

/**
 * The first picture of `subject` that really downloads:
 * { buffer, mime, url, page, title, source } — or null.
 */
async function findPicture(subject) {
  const q = String(subject || "").trim();
  if (!q) return null;
  const candidates = [...(await braveImages(q, 6))];
  if (candidates.length < 2) candidates.push(...(await wikipediaImages(q)));
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    const img = await fetchImage(c.url);
    if (img) return { ...img, ...c };
  }
  return null;
}

module.exports = { findPicture, braveImages, wikipediaImages, fetchImage };
