/**
 * NEWS TOOL — Google News RSS (free, no API key). Top headlines for the
 * user's region; optional topic search. 10-minute cache.
 */
const TIMEOUT = 8000;
const cache = new Map();
const TTL = 10 * 60 * 1000;

function decode(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

/**
 * @param {{topic?:string, lang?:string, country?:string, max?:number}} opts
 * @returns {Promise<{title:string, source:string}[]>}
 */
async function getHeadlines({ topic, lang = "en-IN", country = "IN", max = 6 } = {}) {
  const base = topic
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}`
    : "https://news.google.com/rss";
  const url = `${base}${base.includes("?") ? "&" : "?"}hl=${lang}&gl=${country}&ceid=${country}:${lang.split("-")[0]}`;

  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < TTL) return hit.data.slice(0, max);

  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`news ${r.status}`);
  const xml = await r.text();

  // Titles look like "Headline text - Source Name". Skip the feed title.
  const items = [];
  const re = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>(?:[\s\S]*?<link>([\s\S]*?)<\/link>)?/g;
  let m;
  while ((m = re.exec(xml)) && items.length < 12) {
    const raw = decode(m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim());
    const dash = raw.lastIndexOf(" - ");
    items.push({
      title: dash > 0 ? raw.slice(0, dash) : raw,
      source: dash > 0 ? raw.slice(dash + 3) : "",
      link: m[2] ? decode(m[2].replace(/<!\[CDATA\[|\]\]>/g, "").trim()) : "",
    });
  }
  cache.set(url, { ts: Date.now(), data: items });
  return items.slice(0, max);
}

function describe(items, topic) {
  if (!items || items.length === 0) return "";
  const head = topic ? `Top headlines about "${topic}":` : "Top headlines right now:";
  return (
    head + "\n" +
    items.map((h, i) => `${i + 1}. ${h.title}${h.source ? ` (${h.source})` : ""}`).join("\n")
  );
}

/* ------------------------------------------------------------------ *
 * NOT THE SAME SIX HEADLINES EVERY TIME
 *
 * getHeadlines collects twelve items and returned the first six, from a
 * cache. So "what's the news" twice in a minute read out the identical
 * list, and the BRICS summit was recited to the user over and over. The
 * second half of the feed was already fetched and simply never used.
 *
 * This remembers what a user has been told and serves them what they have
 * not heard. When everything has been heard it falls back to the newest —
 * repeating is better than saying nothing — and starts over, because by
 * then the feed itself has usually moved on.
 * ------------------------------------------------------------------ */
const SEEN_TTL = 6 * 60 * 60_000;
const seen = new Map(); // userId -> { ts, titles: Set<string> }

function seenFor(userId) {
  const key = String(userId || "");
  const hit = seen.get(key);
  if (hit && Date.now() - hit.ts < SEEN_TTL) return hit;
  const fresh = { ts: Date.now(), titles: new Set() };
  seen.set(key, fresh);
  return fresh;
}

/**
 * Pick up to [max] headlines this user has not already been read.
 * Marks whatever it returns as heard.
 */
function freshFor(userId, items, max = 6) {
  const all = Array.isArray(items) ? items : [];
  if (!userId || !all.length) return all.slice(0, max);

  const rec = seenFor(userId);
  let picked = all.filter((h) => !rec.titles.has(h.title)).slice(0, max);

  // Heard all of them. Start the cycle again rather than going silent —
  // and clear first, so the next ask is not immediately "seen" too.
  if (!picked.length) {
    rec.titles.clear();
    rec.ts = Date.now();
    picked = all.slice(0, max);
  }
  for (const h of picked) rec.titles.add(h.title);
  return picked;
}

/** Test seam / sign-out: forget what a user has been told. */
function forget(userId) {
  seen.delete(String(userId || ""));
}

module.exports = { getHeadlines, describe, freshFor, forget };
