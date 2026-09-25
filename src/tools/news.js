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
 *
 * CARDS, 2026-09-25. Owner: "update how we read the news and how it is
 * dispayed now need card style with images.stacked swipe to see or tap
 * to explan". Every story now carries what a card needs — a stable id,
 * the publisher's picture and a small copy of it, the publisher's icon
 * and the exact publication time — in the one shape the voice deck, the
 * News screen and read_news_story all share.
 */
const crypto = require("crypto");
const TIMEOUT = 9000;
const searchCache = require("./searchCache");
const newsImages = require("./newsImages");

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


/**
 * HOW MANY THEY ASKED FOR, READ FROM THEIR OWN WORDS.
 *
 * The model is told to set `count`, and usually does — but "top 4 news"
 * arriving as ten is exactly the complaint this is meant to end, and a
 * judgement call is the wrong mechanism for a number the user said out
 * loud. Reading it from the utterance makes it deterministic: if they
 * said a number, that is the number.
 *
 * Deliberately narrow. Only a count that sits next to a news word counts,
 * so "top 5 news" is five headlines while "5 point action plan for BRICS"
 * and "iPhone 17" are left alone.
 */
const WORD_NUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  a: 1, an: 1, couple: 2, few: 3,
};
const NEWS_WORD = "(?:news|headlines?|stories|story|updates?|articles?)";

function countFromText(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  const num = "(\\d{1,2}|" + Object.keys(WORD_NUM).join("|") + ")";
  // "top 4 news" / "5 headlines" / "give me three stories"
  const m =
    new RegExp(`\\b(?:top|best|latest|first|main)?\\s*${num}\\s+(?:of\\s+)?${NEWS_WORD}\\b`).exec(t) ||
    new RegExp(`\\b${NEWS_WORD}\\s*[:-]?\\s*${num}\\b`).exec(t);
  if (!m) return null;
  const raw = m[1];
  const n = /^\d+$/.test(raw) ? Number(raw) : WORD_NUM[raw];
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, 10);
}

/** A story's id: the first 12 hex of sha1(url) — the app derives the same. */
function storyId(url) {
  return crypto.createHash("sha1").update(String(url || "")).digest("hex").slice(0, 12);
}

/** A picture or icon the phone can load: https only (release builds refuse http). */
function httpsOnly(u) {
  const s = String(u || "").trim();
  return /^https:\/\/\S+$/i.test(s) && s.length <= 2048 ? s : "";
}

/**
 * page_age ("2026-09-25T08:10:00", UTC, usually without a zone) as ISO,
 * or null. A time in the future is a wrong time, not an early one.
 */
function publishedAtOf(pageAge) {
  const s = String(pageAge || "").trim();
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z`
    : /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s
    : `${s}Z`;
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t > Date.now() + 60 * 60_000) return null;
  return new Date(t).toISOString();
}

/**
 * The News screen's topic chips, as queries. "Top" is the country term
 * the voice path has always used (see headlines below); "India" is asked
 * as national news so the two chips are not the same deck twice.
 */
const TOPIC_QUERY = {
  top: "", today: "", india: "India national news", tech: "technology",
};
function queryFor(topic) {
  const t = String(topic || "").trim();
  const mapped = TOPIC_QUERY[t.toLowerCase()];
  return (mapped !== undefined ? mapped : t) || "India";
}

/** The most a caller can ask for; the cached list holds all of them. */
const MAX_STORIES = 20;

async function headlines({ topic = "", count = 10, sort = "relevance" } = {}) {
  // "top news today" matched AGGREGATORS — "NDTV Live TV", "Top 10 Hindi
  // News Headlines" — rather than stories, because those pages are
  // literally titled that. A plain country term returns actual reporting;
  // country=IN below is what localises it.
  const q = queryFor(topic);
  const order = sort === "recent" ? "recent" : "relevance";
  const n = Math.max(1, Math.min(Math.trunc(Number(count)) || 10, MAX_STORIES));
  // CACHED PER TOPIC AND ORDER, SLICED AFTER (2026-09-25). This used to be
  // stored without `ok`, which searchCache refuses, so no answer was ever
  // cached and every "news" cost a search call. Its key also ignored the
  // count and the order: fixed alone, "the top two stories" would then
  // have answered the next "ten headlines" with two. The whole filtered
  // list is kept now and each caller takes its own count.
  const shape = `news:v2:${order}:${q.toLowerCase()}`;
  const hit = await searchCache.get(shape).catch(() => null);
  if (hit && Array.isArray(hit.items)) {
    return {
      ok: true,
      topic: hit.topic,
      sort: order,
      items: newsImages.fillFromMemory(hit.items).slice(0, n),
      cached: true,
    };
  }

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
    const publishedAt = publishedAtOf(x.page_age);
    rows.push({
      id: storyId(x.url),
      title,
      url: x.url,
      source: clean((x.meta_url && x.meta_url.hostname) || "").replace(/^www\./, ""),
      age: clean(x.age),
      // The exact time when the index has it; its "3 hours ago" otherwise.
      ageMins: publishedAt
        ? Math.max(0, Math.round((Date.now() - Date.parse(publishedAt)) / 60_000))
        : ageMinutes(x.age),
      publishedAt,
      snippet: clean(x.description).slice(0, 400),
      extra: (x.extra_snippets || []).map(clean).filter(Boolean).slice(0, 2),
      // `original` is the publisher's own full-size picture; `src` is the
      // index's small copy, kept as the fallback the card tries second.
      image: httpsOnly(x.thumbnail && x.thumbnail.original),
      thumbnail: httpsOnly(x.thumbnail && x.thumbnail.src),
      favicon: httpsOnly(x.meta_url && x.meta_url.favicon),
    });
    if (rows.length >= MAX_STORIES) break;
  }
  // RECENCY IS NOT IMPORTANCE, and sorting by it destroyed the index's own
  // ranking. Brave returns news in relevance order — which is roughly what
  // a person means by "top" or "best" news — and re-sorting purely on age
  // replaced that with whatever happened to be published most recently.
  // It is why our headlines and Google's looked like different days: they
  // were answering "what matters", we were answering "what just landed".
  //
  // Only an explicit ask for the LATEST re-orders by clock.
  if (order === "recent") rows.sort((a, b) => a.ageMins - b.ageMins);
  const items = await newsImages.enrich(rows);
  const out = { ok: true, topic: topic || "today", sort: order, items };
  searchCache.put(shape, q, out, true).catch(() => {}); // live: 20 min
  return { ...out, items: items.slice(0, n), cached: false };
}

/**
 * THE SAME STORIES WITHOUT A NEWS KEY. The free RSS headlines carry no
 * pictures, summaries or times, so their cards are the gradient kind —
 * but the deck and the News screen still work.
 */
function fromRss(h) {
  const url = String((h && h.link) || "");
  return {
    id: storyId(url || (h && h.title)),
    title: String((h && h.title) || ""),
    url,
    source: String((h && h.source) || ""),
    age: "",
    ageMins: null,
    publishedAt: null,
    snippet: "",
    extra: [],
    image: "",
    thumbnail: "",
    favicon: "",
  };
}

/**
 * Stories for the deck and the News screen: the news index when it is
 * configured, the RSS headlines when it is not — or when it fails, since
 * yesterday's layout with today's headlines beats an empty screen.
 */
async function feed({ topic = "", count = 12, sort = "relevance" } = {}) {
  const n = Math.max(1, Math.min(Math.trunc(Number(count)) || 12, MAX_STORIES));
  if (process.env.BRAVE_SEARCH_API_KEY) {
    try {
      const out = await headlines({ topic, count: n, sort });
      if (out.items.length) return out;
    } catch (e) {
      console.warn(`news: index failed, using RSS: ${String(e.message).slice(0, 120)}`);
    }
  }
  const rss = require("../services/tools/news");
  const q = queryFor(topic);
  const rows = await rss.getHeadlines({
    // Top stories are the feed's own front page, not a search.
    topic: String(topic || "").trim() && !/^(top|today)$/i.test(topic) ? q : undefined,
    max: n,
  });
  return {
    ok: true,
    topic: topic || "today",
    sort: sort === "recent" ? "recent" : "relevance",
    items: rows.map(fromRss).filter((s) => s.title),
    cached: false,
    fallback: "rss",
  };
}

/* ------------------------------------------------------------------ *
 * "READ ME THE SECOND ONE"
 *
 * The deck on the screen is numbered in the order it was sent, so "the
 * second one" and "the cricket story" can only be answered from THAT
 * list — not from a fresh search, whose order may already have moved.
 * Kept per user for half an hour: long enough for a conversation about
 * the morning's news, short enough that "the second one" tomorrow does
 * not reach back to a deck nobody is looking at.
 * ------------------------------------------------------------------ */
const SHOWN_TTL_MS = 30 * 60_000;
const shown = new Map(); // user id -> { at, topic, items }

function userKey(userId) {
  const k = String(userId ?? "").trim();
  return k && k !== "undefined" && k !== "null" ? k : "";
}

function rememberShown(userId, topic, items) {
  const key = userKey(userId);
  if (!key || !Array.isArray(items) || !items.length) return;
  shown.delete(key);
  shown.set(key, {
    at: Date.now(),
    topic: String(topic || ""),
    items: items.map((s) => ({
      id: s.id, title: s.title, url: s.url, source: s.source,
      snippet: s.snippet || "", extra: Array.isArray(s.extra) ? s.extra : [],
    })),
  });
  // One entry per active user; a busy morning must not grow this forever.
  while (shown.size > 5000) shown.delete(shown.keys().next().value);
}

function lastShown(userId) {
  const hit = shown.get(userKey(userId));
  if (!hit) return null;
  if (Date.now() - hit.at > SHOWN_TTL_MS) {
    shown.delete(userKey(userId));
    return null;
  }
  return hit;
}

const ORDINAL = {
  first: 1, one: 1, second: 2, two: 2, third: 3, three: 3, fourth: 4, four: 4,
  fifth: 5, five: 5, sixth: 6, six: 6, seventh: 7, seven: 7, eighth: 8, eight: 8,
  ninth: 9, nine: 9, tenth: 10, ten: 10, eleventh: 11, eleven: 11,
  twelfth: 12, twelve: 12, top: 1,
};
const PICK_STOP = new Set(
  ("the and for with from that this about tell more read what whats says said " +
   "story stories news headline headlines article one please give know some " +
   "into over after your their them they have has had was were will just").split(" ")
);

function keywords(text) {
  return new Set(
    String(text || "").toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !PICK_STOP.has(w) && !GENERIC.has(w))
      // "elections" finds "election": a plural is not a different story.
      .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
  );
}

/**
 * Which story [which] means: its number on the deck ("2", "2nd", "the
 * second one", "last") or words from it ("the cricket story"). Headline
 * words count double against summary words; a tie goes to the higher
 * story. Returns { index, item } or null — never a guess.
 */
function pickStory(items, which) {
  const list = Array.isArray(items) ? items : [];
  const w = String(which ?? "").trim().toLowerCase().replace(/[?!.,]+$/g, "");
  if (!list.length || !w) return null;
  const at = (i) => (i >= 1 && i <= list.length ? { index: i - 1, item: list[i - 1] } : null);

  if (/^(?:the\s+)?(?:last|final|bottom)(?:\s+(?:one|story|headline|news))?$/.test(w)) {
    return at(list.length);
  }
  const num = /^(?:the\s+)?(?:number\s+|no\.?\s*|#|story\s+|headline\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+(?:one|story|headline|news|item))?$/.exec(w);
  if (num) return at(Number(num[1]));
  const ord = /^(?:the\s+)?([a-z]+)(?:\s+(?:one|story|headline|news|item))?$/.exec(w);
  if (ord && ORDINAL[ord[1]]) return at(ORDINAL[ord[1]]);

  const want = keywords(w);
  if (!want.size) return null;
  let best = null;
  list.forEach((item, index) => {
    const title = keywords(item.title);
    const body = keywords([item.snippet, ...(item.extra || [])].join(" "));
    let score = 0;
    for (const k of want) {
      if (title.has(k)) score += 2;
      else if (body.has(k)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { index, item, score };
  });
  return best ? { index: best.index, item: best.item } : null;
}

module.exports = {
  headlines, feed, ageMinutes, sameStory, clean, NOT_A_STORY, mostlyLatin, countFromText,
  storyId, publishedAtOf, queryFor, fromRss, MAX_STORIES,
  rememberShown, lastShown, pickStory,
  _forgetShown: () => shown.clear(),
};
