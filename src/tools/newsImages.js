/**
 * A PICTURE FOR EVERY STORY (2026-09-25).
 *
 * Owner, 2026-09-25: "update how we read the news and how it is dispayed
 * now need card style with images.stacked swipe to see or tap to explan".
 * A card is mostly its picture, and the news index leaves some stories
 * without one. The article's own page nearly always names a preview image
 * — the og:image a chat app shows when the link is pasted — so that is
 * looked up for the stories that arrived without a picture.
 *
 * ON A BUDGET, because the deck waits for it: each page gets 2.5 s and at
 * most 256 KB (the tags live in <head>), four pages at a time, and the
 * whole lookup stops waiting after 3 s. A story still without a picture
 * gets the app's gradient card, never a spinner. Answers — "this page has
 * no image" included — are kept per page for a day, so a story costs its
 * lookup once.
 *
 * The URLs come from the news index, not from the user, but they are
 * still fetched through safeFetch: a story link must never be a way into
 * this server's own network.
 */
const { safeFetch } = require("../services/safeFetch");

const PAGE_TIMEOUT_MS = 2500;
const MAX_BYTES = 256 * 1024;
const CONCURRENCY = 4;
const BUDGET_MS = 3000;
const FOUND_TTL_MS = 24 * 60 * 60_000;
// A page that timed out or refused us may simply have been slow: asked
// again in an hour, not tomorrow.
const FAILED_TTL_MS = 60 * 60_000;
const MAX_ENTRIES = 2000;

/** The order a page's own tags are trusted in. */
const PREFERENCE = [
  "og:image:secure_url", "og:image", "og:image:url",
  "twitter:image", "twitter:image:src", "image_src",
];

const ENTITY = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", "#39": "'" };
function decode(v) {
  return String(v || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (ENTITY[k] !== undefined) return ENTITY[k];
    const n = k.startsWith("#x") ? parseInt(k.slice(2), 16) : k.startsWith("#") ? Number(k.slice(1)) : NaN;
    if (Number.isFinite(n) && n > 0 && n <= 0x10ffff) {
      try { return String.fromCodePoint(n); } catch (_) { return m; }
    }
    return m;
  });
}

/** name → value for one tag, attributes in any order and either quote. */
function attrsOf(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m;
  while ((m = re.exec(tag))) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decode(m[2] ?? m[3] ?? m[4] ?? "").trim();
  }
  return out;
}

/**
 * An image URL the phone can actually draw, or "": resolved against the
 * page, https only (a release build refuses plain http), no data: or
 * script URLs, and no SVG (the app's image decoder cannot draw one).
 */
function usableImageUrl(raw, baseUrl) {
  const v = String(raw || "").trim();
  if (!v || v.length > 2048 || /^(data|javascript|blob):/i.test(v)) return "";
  let u;
  try {
    u = new URL(v, baseUrl || undefined);
  } catch (_) {
    return "";
  }
  if (u.protocol !== "https:") return "";
  if (/\.svgz?$/i.test(u.pathname)) return "";
  return u.href;
}

/**
 * THE PAGE'S OWN PREVIEW IMAGE, from its HTML. Pure — no network — so the
 * odd shapes pages really use can be pinned in tests: content before
 * property, single quotes, entities in the URL, a relative path, a
 * twitter:image with no og:image, nothing at all.
 */
function extractPreviewImage(html, baseUrl) {
  const text = String(html || "").slice(0, MAX_BYTES);
  const found = {};
  for (const tag of text.match(/<meta\b[^>]*>/gi) || []) {
    const a = attrsOf(tag);
    const key = (a.property || a.name || "").toLowerCase();
    if (key && a.content && PREFERENCE.includes(key) && !(key in found)) {
      found[key] = a.content;
    }
  }
  for (const tag of text.match(/<link\b[^>]*>/gi) || []) {
    const a = attrsOf(tag);
    if (String(a.rel || "").toLowerCase() === "image_src" && a.href && !found.image_src) {
      found.image_src = a.href;
    }
  }
  for (const key of PREFERENCE) {
    const url = usableImageUrl(found[key], baseUrl);
    if (url) return url;
  }
  return "";
}

/** Test seam: the fetch every page read goes through. */
let pageFetch = safeFetch;

/**
 * The start of a page, up to its </head> or [maxBytes], whichever is
 * first. The deadline covers reading the body too (safeFetch's timeout).
 */
async function readHead(url, { timeoutMs = PAGE_TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  const r = await pageFetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
  }, { timeoutMs });
  if (!r.ok) throw new Error(`the page returned ${r.status}`);
  const mime = String(r.headers.get("content-type") || "").toLowerCase();
  if (mime && !/html/.test(mime)) {
    try { await r.body?.cancel(); } catch (_) {}
    return { html: "", url: r.url || url };
  }
  const reader = r.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.length;
      // The tags are in <head>; the article body is not needed.
      if (/<\/head>/i.test(Buffer.from(value).toString("latin1"))) break;
    }
  } finally {
    try { await reader.cancel(); } catch (_) {}
  }
  return { html: Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8"), url: r.url || url };
}

const cache = new Map(); // article url -> { at, ttl, image }
const inflight = new Map(); // article url -> Promise<string>

function remember(url, image, ttl) {
  cache.delete(url);
  cache.set(url, { at: Date.now(), ttl, image });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

function cached(url) {
  const hit = cache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(url);
    return null;
  }
  return hit;
}

/** The preview image for one article, from the day's memory when it can. */
async function lookup(url) {
  const hit = cached(url);
  if (hit) return hit.image;
  if (inflight.has(url)) return inflight.get(url);
  const job = (async () => {
    try {
      const page = await readHead(url);
      const image = extractPreviewImage(page.html, page.url);
      remember(url, image, FOUND_TTL_MS);
      return image;
    } catch (_) {
      remember(url, "", FAILED_TTL_MS);
      return "";
    }
  })().finally(() => inflight.delete(url));
  inflight.set(url, job);
  return job;
}

/**
 * Stories without an `image` get their page's preview image, within
 * [budgetMs]. Returns NEW objects; the ones passed in are never touched,
 * so a lookup finishing after the budget cannot change a list that has
 * already been sent (it still lands in the per-page memory for next time).
 */
async function enrich(items, { budgetMs = BUDGET_MS, concurrency = CONCURRENCY } = {}) {
  const list = Array.isArray(items) ? items : [];
  const todo = list.filter((x) => x && !x.image && /^https?:\/\//i.test(String(x.url || "")));
  if (!todo.length) return list.slice();
  const found = new Map();
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < todo.length) {
      const item = todo[next++];
      const image = await lookup(item.url).catch(() => "");
      if (image) found.set(item.url, image);
    }
  };
  let timer = null;
  await Promise.race([
    Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, todo.length)) }, worker)),
    new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); }),
  ]);
  clearTimeout(timer);
  stopped = true; // pages already asked for finish into the memory; no new ones start
  return list.map((x) =>
    x && !x.image && found.has(x.url) ? { ...x, image: found.get(x.url) } : x
  );
}

/**
 * A cached list was saved before some lookups finished: fill in what the
 * per-page memory has learned since. No network.
 */
function fillFromMemory(items) {
  return (Array.isArray(items) ? items : []).map((x) => {
    if (!x || x.image || !x.url) return x;
    const hit = cached(x.url);
    return hit && hit.image ? { ...x, image: hit.image } : x;
  });
}

module.exports = {
  extractPreviewImage, usableImageUrl, readHead, lookup, enrich, fillFromMemory,
  PAGE_TIMEOUT_MS, MAX_BYTES, CONCURRENCY, BUDGET_MS,
  _setFetch(fn) { pageFetch = fn || safeFetch; },
  _forget() { cache.clear(); inflight.clear(); },
};
