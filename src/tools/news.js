/**
 * NEWS — headlines for the panel, not for the voice.
 *
 * Reading ten headlines aloud takes well over a minute and nobody
 * remembers the fourth. So the headlines go ON SCREEN, scrollable, while
 * the assistant says one sentence about the top few — and tapping one
 * opens that story for it to actually read.
 *
 * Sourced from Brave's news index rather than a general web search: the
 * news endpoint carries a real publication age per story, which is the
 * difference between today's news and an article that merely mentions
 * the subject. Cached for twenty minutes in the shared store, so the
 * second person to ask this morning costs nothing and gets the answer
 * instantly.
 */
const TIMEOUT = 9000;
const searchCache = require("./searchCache");

/** "3 hours ago" -> 180. Used to sort and to drop anything stale. */
function ageMinutes(age) {
  const m = /(\d+)\s*(minute|hour|day|week)/i.exec(String(age || ""));
  if (!m) return 24 * 60; // unknown age sorts as a day old, never first
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return unit === "minute" ? n
    : unit === "hour" ? n * 60
    : unit === "day" ? n * 1440
    : n * 10080;
}

const ENTITY = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'",
  "&lt;": "<", "&gt;": ">", "&nbsp;": " ", "&rsquo;": "’", "&ldquo;": "“",
  "&rdquo;": "”", "&hellip;": "…", "&ndash;": "–", "&mdash;": "—" };
function clean(t) {
  return String(t || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&[#a-zA-Z0-9]{2,8};/g, (m) => {
      const k = m.toLowerCase();
      if (ENTITY[k] !== undefined) return ENTITY[k];
      const num = /^&#(?:x([0-9a-f]+)|(\d+));$/i.exec(m);
      if (num) {
        const n = num[1] ? parseInt(num[1], 16) : Number(num[2]);
        if (Number.isFinite(n) && n >= 0 && n <= 0x10ffff) {
          try { return String.fromCodePoint(n); } catch (_) { return m; }
        }
      }
      return m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Two outlets running the same wire copy produce two near-identical
 * headlines, and a list of ten that is really six stories looks broken.
 * Compared on significant words rather than characters, so "PM Modi
 * welcomes BRICS leaders" and "Modi welcomes BRICS leaders at summit"
 * collapse into one.
 */
function sameStory(a, b) {
  const words = (s) =>
    new Set(
      String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !GENERIC.has(w))
    );
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size) >= 0.75;
}

/**
 * Words every headline shares. Counting them collapsed twenty distinct
 * stories into six, because "Top 10 News Today" and "Latest news updates"
 * looked like the same story to a plain word overlap.
 */
const GENERIC = new Set(
  ("news today latest live update updates breaking headlines india indian " +
   "top story stories report reports september 2026 read more full").split(" ")
);

/**
 * NOT A STORY. A live score page, a streaming guide or a "Top 10
 * headlines" listicle is a container for news rather than news, and it
 * cannot be read aloud or expanded into anything. They rank well for a
 * generic query, so they have to be excluded by shape.
 */
const NOT_A_STORY =
  /\blive tv\b|live streaming|where to watch|\blive blog\b|live score|live updates|toss result|playing xi|\d+\/\d+ in \d+(\.\d+)? overs|\btop \d+\b.*\b(headlines|news)\b|news channel|free live/i;

/**
 * The index returns Telugu and Hindi pages for an English query, and a
 * ratio alone does not catch them. Publishers append a Latin SEO slug to
 * their own headline —
 *
 *   "BRICS समिट में भारत की 5 बड़ी कूटनीतिक जीत... PM मोदी ने कैसे साधा
 *    संतुलन? - brics summit india five diplomatic wins for india"
 *
 * — which lifted that title to 74% Latin and sailed past a 60% floor,
 * while the part actually shown to the reader is entirely Devanagari.
 *
 * A RUN is the honest test. Latin headlines borrow the odd foreign word
 * or accented name; they do not contain four unbroken characters of
 * another script. That is a headline written in that script.
 */
const NON_LATIN_RUN =
  /[\p{Script=Devanagari}\p{Script=Telugu}\p{Script=Tamil}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Bengali}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Oriya}\p{Script=Arabic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{M}]{4,}/u;

function mostlyLatin(t) {
  const text = String(t || "");
  if (NON_LATIN_RUN.test(text)) return false;
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (!letters.length) return false;
  const latin = (letters.match(/[\p{Script=Latin}]/gu) || []).length;
  return latin / letters.length >= 0.6;
}

async function headlines({ topic = "", count = 10, sort = "relevance" } = {}) {
  // "top news today" matched AGGREGATORS — "NDTV Live TV", "Top 10 Hindi
  // News Headlines" — rather than stories, because those pages are
  // literally titled that. A plain country term returns actual reporting;
  // country=IN below is what localises it.
  const q = (topic && topic.trim()) || "India";
  const shape = `news:${q.toLowerCase()}`;
  const hit = await searchCache.get(shape).catch(() => null);
  if (hit) return { ...hit, cached: true };

  if (!process.env.BRAVE_SEARCH_API_KEY) {
    throw new Error("no news provider configured");
  }
  const params = new URLSearchParams({
    q,
    count: "20", // over-fetch: deduplication and the age filter discard some
    country: process.env.SEARCH_COUNTRY || "IN",
    search_lang: "en",
    text_decorations: "0",
    freshness: "pd",
    extra_snippets: "1",
  });
  const r = await fetch(
    `https://api.search.brave.com/res/v1/news/search?${params}`,
    {
      headers: {
        accept: "application/json",
        "x-subscription-token": process.env.BRAVE_SEARCH_API_KEY,
      },
      signal: AbortSignal.timeout(TIMEOUT),
    }
  );
  if (r.status === 429) throw new Error("news rate limit");
  if (!r.ok) throw new Error(`news ${r.status}`);
  const j = await r.json();

  const rows = [];
  for (const x of j.results || []) {
    const title = clean(x.title);
    if (!title || !x.url) continue;
    if (NOT_A_STORY.test(title)) continue;
    if (!mostlyLatin(title)) continue;
    if (rows.some((p) => sameStory(p.title, title))) continue;
    rows.push({
      title,
      url: x.url,
      source: clean((x.meta_url && x.meta_url.hostname) || "").replace(/^www\./, ""),
      age: clean(x.age),
      ageMins: ageMinutes(x.age),
      snippet: clean(x.description).slice(0, 400),
      extra: (x.extra_snippets || []).map(clean).filter(Boolean).slice(0, 2),
      thumbnail: (x.thumbnail && (x.thumbnail.src || x.thumbnail.original)) || "",
    });
  }
  // RECENCY IS NOT IMPORTANCE, and sorting by it destroyed the index's own
  // ranking. Brave returns news in relevance order — which is roughly what
  // a person means by "top" or "best" news — and re-sorting purely on age
  // replaced that with whatever happened to be published most recently.
  // It is why our headlines and Google's looked like different days: they
  // were answering "what matters", we were answering "what just landed".
  //
  // Only an explicit ask for the LATEST re-orders by clock.
  if (sort === "recent") rows.sort((a, b) => a.ageMins - b.ageMins);
  const out = {
    topic: topic || "today",
    sort,
    items: rows.slice(0, Math.max(1, Math.min(count, 10))),
  };
  searchCache.put(shape, q, out, true).catch(() => {}); // live: 20 min
  return { ...out, cached: false };
}

module.exports = { headlines, ageMinutes, sameStory, clean, NOT_A_STORY, mostlyLatin };
