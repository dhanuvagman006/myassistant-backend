/**
 * NEWS CARDS — run with `npm run test:news` (2026-09-25).
 *
 * Owner, 2026-09-25: "update how we read the news and how it is dispayed
 * now need card style with images.stacked swipe to see or tap to explan".
 *
 * No network: the news index, the RSS feed and every article page are
 * fixtures below, the shared cache is an in-memory stand-in with the real
 * one's rule (only `ok:true` answers are kept), and the one test that
 * needs a socket (the page reader's byte cap and deadline) talks to a
 * server on 127.0.0.1. What is pinned:
 *   - every story carries the card's fields: id, picture, small picture,
 *     publisher icon, exact time;
 *   - the answer is cached at last, per topic and order, and a cached
 *     list serves any count;
 *   - a story without a picture gets its page's own preview image, four
 *     pages at a time, within the budget;
 *   - GET /news/feed, with and without a news key;
 *   - "read me the second one" / "the cricket story" (read_news_story),
 *     the news_focus it sends, and its build gate;
 *   - open_app_screen "news" on a new app and an old one.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";
process.env.BRAVE_SEARCH_API_KEY = "test-key";

const assert = require("assert");
const crypto = require("crypto");
const http = require("http");
const { APP_ROOT } = require("./app-root");

let passed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
function section(title) { queue.push({ title }); }

async function run() {
  for (const item of queue) {
    if (item.title) {
      console.log(`\n${item.title}`);
      continue;
    }
    try {
      await item.fn();
      passed++;
      console.log(`  ok  ${item.name}`);
    } catch (e) {
      console.error(`  FAIL ${item.name}\n       ${e.stack || e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(
    `\n${passed}/${queue.filter((q) => q.fn).length} passed` +
      `${process.exitCode ? " — with failures above" : ""}\n`
  );
}

/* ------------------------------------------------------------------ *
 * FIXTURES
 * ------------------------------------------------------------------ */

/** Brave's page_age: UTC, no zone, e.g. "2026-09-25T08:10:00". */
const ago = (hours) => new Date(Date.now() - hours * 3600e3).toISOString().slice(0, 19);
const sha12 = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);

function story(n, title, hours, extra = {}) {
  return {
    type: "news_result",
    title,
    url: `https://www.paper${n}.in/news/story-${n}.html`,
    description: `Summary of story ${n}. It is two sentences long.`,
    age: `${Math.max(1, Math.round(hours))} hours ago`,
    page_age: ago(hours),
    meta_url: {
      scheme: "https", netloc: `www.paper${n}.in`, hostname: `www.paper${n}.in`,
      favicon: `https://imgs.search.example/fav/${n}.png`, path: "› news",
    },
    thumbnail: {
      src: `https://imgs.search.example/thumb/${n}.jpg`,
      original: `https://cdn.paper${n}.in/pics/${n}.jpg`,
    },
    extra_snippets: [`More about story ${n}.`, `Even more about story ${n}.`, "A third one."],
    ...extra,
  };
}

const BRAVE = {
  type: "news",
  results: [
    story(1, "India beat Australia by six wickets to win the cricket series in Mumbai", 2),
    // No picture from the index at all: its page's og:image (relative).
    story(2, "Budget 2026: what the new tax slabs mean for salaried workers", 5, {
      url: "https://www.livemint.example/budget-2026-tax-slabs.html",
      thumbnail: undefined,
    }),
    // A plain-http original is useless to a release build: the small copy
    // stays, and the page's twitter:image is looked up for the big one.
    story(3, "Monsoon arrives early in Kerala as rainfall runs above normal", 1, {
      url: "https://weather.example/monsoon-kerala.html",
      thumbnail: { src: "https://imgs.search.example/thumb/3.jpg", original: "http://cdn.weather.example/3.jpg" },
    }),
    story(4, "Election commission announces dates for three state assembly polls", 0.5),
    story(5, "Sensex closes at a record high as banking shares rally", 3),
    // No exact time: the minutes come from "4 hours ago".
    story(6, "ISRO schedules the next crewed mission test for December", 4, { page_age: undefined }),
    // A time in the future is a wrong time, not an early one.
    story(7, "Film festival opens with a restored classic from 1975", 6, { page_age: "2099-01-01T00:00:00" }),
    story(8, "Doctors warn of a rise in dengue cases after heavy rain", 7),
    story(9, "Chipmaker opens a design centre in Bengaluru with 2,000 jobs", 8),
    story(10, "Railways add 40 festival special trains for Diwali travel", 9),
    story(11, "Football league final moves to a larger stadium in Kolkata", 10),
    story(12, "Startup raises funds to build electric three-wheelers", 11),
    // Everything below is filtered out.
    story(13, "NDTV 24x7 Live TV: watch the latest news", 1),
    story(14, "India beat Australia to win the cricket series in Mumbai", 2),
    story(15, "भारत ने ऑस्ट्रेलिया को हराया, मुंबई में सीरीज जीती", 2),
    { ...story(16, "A story with no link", 2), url: "" },
  ],
};

const ARTICLE_HTML = {
  "https://www.livemint.example/budget-2026-tax-slabs.html":
    `<html><head><title>Budget</title>
     <meta content="/images/budget.jpg" property="og:image">
     <meta name="twitter:image" content="https://www.livemint.example/tw.jpg">
     </head><body><p>The budget…</p></body></html>`,
  "https://weather.example/monsoon-kerala.html":
    `<html><head><meta name='twitter:image' content='https://weather.example/pics/monsoon.jpg?w=1200&amp;h=630'></head></html>`,
};

const RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
<title>Top stories - Google News</title>
<item><title>Parliament passes the data protection bill - The Hindu</title><link>https://news.google.com/rss/articles/CBMiA?oc=5</link><pubDate>Thu, 25 Sep 2026 07:00:00 GMT</pubDate></item>
<item><title>Monsoon covers the whole country two weeks early - Hindustan Times</title><link>https://news.google.com/rss/articles/CBMiB?oc=5</link></item>
<item><title>Gold prices ease ahead of the festival season - Mint</title><link>https://news.google.com/rss/articles/CBMiC?oc=5</link></item>
</channel></rss>`;

/* ------------------------------------------------------------------ *
 * STUBS — nothing leaves this machine.
 * ------------------------------------------------------------------ */

const calls = { brave: 0, rss: 0, braveFail: false };
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("https://api.search.brave.com/")) {
    calls.brave++;
    assert.strictEqual(init.headers["x-subscription-token"], "test-key");
    if (calls.braveFail) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify(BRAVE), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  if (u.startsWith("https://news.google.com/rss")) {
    calls.rss++;
    return new Response(RSS, { status: 200, headers: { "content-type": "application/rss+xml" } });
  }
  throw new Error(`test tried to reach the network: ${u}`);
};

// The shared cache, in memory, with the real one's only rule that matters
// here: an answer without ok:true is never stored (searchCache.put).
const searchCache = require("../src/tools/searchCache");
const store = new Map();
const puts = [];
searchCache.get = async (shape) => {
  const hit = store.get(shape);
  return hit ? { ...JSON.parse(hit), cached: true } : null;
};
searchCache.put = async (shape, query, out) => {
  puts.push({ shape, out });
  if (!out || out.ok !== true) return;
  store.set(shape, JSON.stringify(out));
};

const newsImages = require("../src/tools/newsImages");
let pageCalls = [];
function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
function servePages() {
  newsImages._setFetch(async (url) => {
    pageCalls.push(String(url));
    const html = ARTICLE_HTML[String(url)];
    return html ? htmlResponse(html) : htmlResponse("not found", 404);
  });
}
servePages();

function fresh() {
  store.clear();
  puts.length = 0;
  calls.brave = 0;
  calls.rss = 0;
  calls.braveFail = false;
  pageCalls = [];
  newsImages._forget();
  servePages();
}

const news = require("../src/tools/news");
const registry = require("../src/tools/registry");
require("../src/tools/builtins").registerBuiltins();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
section("every story carries what a card needs");

test("id, full picture, small picture, publisher icon and exact time", async () => {
  fresh();
  const out = await news.headlines({ count: 10 });
  assert.strictEqual(out.ok, true);
  const s = out.items[0];
  const raw = BRAVE.results[0];
  assert.strictEqual(s.id, sha12(raw.url), "the id is the first 12 hex of sha1(url)");
  assert.match(s.id, /^[0-9a-f]{12}$/);
  assert.strictEqual(s.title, raw.title);
  assert.strictEqual(s.url, raw.url);
  assert.strictEqual(s.source, "paper1.in", "the hostname, www. dropped");
  assert.strictEqual(s.image, raw.thumbnail.original, "image is the publisher's own picture");
  assert.strictEqual(s.thumbnail, raw.thumbnail.src, "thumbnail is the index's small copy");
  assert.strictEqual(s.favicon, raw.meta_url.favicon);
  assert.strictEqual(s.publishedAt, new Date(raw.page_age + "Z").toISOString());
  assert.ok(Math.abs(s.ageMins - 120) <= 1, `ageMins from the exact time: ${s.ageMins}`);
  assert.strictEqual(s.age, "2 hours ago");
  assert.deepStrictEqual(s.extra, ["More about story 1.", "Even more about story 1."], "two extras at most");
  assert.ok(s.snippet.startsWith("Summary of story 1"));
});

test("the same story always gets the same id", async () => {
  assert.strictEqual(news.storyId("https://a.example/x"), news.storyId("https://a.example/x"));
  assert.notStrictEqual(news.storyId("https://a.example/x"), news.storyId("https://a.example/y"));
  assert.strictEqual(news.storyId("https://a.example/x"), sha12("https://a.example/x"));
});

test("page_age: UTC without a zone, a date alone, garbage, the future", () => {
  assert.strictEqual(news.publishedAtOf("2026-09-25T08:10:00"), "2026-09-25T08:10:00.000Z");
  assert.strictEqual(news.publishedAtOf("2026-09-25T08:10:00+05:30"), "2026-09-25T02:40:00.000Z");
  assert.strictEqual(news.publishedAtOf("2026-09-25"), "2026-09-25T00:00:00.000Z");
  assert.strictEqual(news.publishedAtOf(""), null);
  assert.strictEqual(news.publishedAtOf("yesterday"), null);
  assert.strictEqual(news.publishedAtOf("2099-01-01T00:00:00"), null);
});

test("no exact time: minutes from the index's own words; a future time is dropped", async () => {
  fresh();
  const out = await news.headlines({ count: 12 });
  const isro = out.items.find((x) => /ISRO/.test(x.title));
  assert.strictEqual(isro.publishedAt, null);
  assert.strictEqual(isro.ageMins, 240);
  const film = out.items.find((x) => /Film festival/.test(x.title));
  assert.strictEqual(film.publishedAt, null, "2099 is a wrong date, not an early one");
  assert.strictEqual(film.ageMins, 360);
});

test("the old filters still hold: no live TV, no wire duplicate, no Hindi, no linkless", async () => {
  fresh();
  const out = await news.headlines({ count: 20 });
  assert.strictEqual(out.items.length, 12, out.items.map((x) => x.title).join(" | "));
  assert.ok(!out.items.some((x) => /Live TV/i.test(x.title)));
  assert.strictEqual(out.items.filter((x) => /Australia/.test(x.title)).length, 1);
  assert.ok(!out.items.some((x) => /भारत/.test(x.title)));
});

test("a picture only when it is https", async () => {
  fresh();
  const out = await news.headlines({ count: 3 });
  const monsoon = out.items.find((x) => /Monsoon/.test(x.title));
  assert.strictEqual(monsoon.thumbnail, "https://imgs.search.example/thumb/3.jpg");
  assert.notStrictEqual(monsoon.image, "http://cdn.weather.example/3.jpg", "plain http is never offered");
});

/* ------------------------------------------------------------------ */
section("cached at last — per topic and order, any count");

test("the answer is stored with ok:true, so a second ask costs no search", async () => {
  fresh();
  await news.headlines({ count: 10 });
  assert.strictEqual(calls.brave, 1);
  assert.strictEqual(puts.length, 1);
  assert.strictEqual(puts[0].out.ok, true, "searchCache refuses anything without ok:true");
  const again = await news.headlines({ count: 10 });
  assert.strictEqual(calls.brave, 1, "the second ask went to the network");
  assert.strictEqual(again.cached, true);
  assert.strictEqual(again.ok, true);
});

test("a cached two is not served to a request for ten", async () => {
  fresh();
  const two = await news.headlines({ count: 2 });
  assert.strictEqual(two.items.length, 2);
  const ten = await news.headlines({ count: 10 });
  assert.strictEqual(calls.brave, 1, "one search answers both");
  assert.strictEqual(ten.items.length, 10, "the whole filtered list was cached, then sliced");
  assert.deepStrictEqual(ten.items.slice(0, 2).map((x) => x.id), two.items.map((x) => x.id));
  const twelve = await news.headlines({ count: 50 });
  assert.strictEqual(twelve.items.length, 12, "a count above the list is the whole list");
});

test("'latest' is its own order, and relevance keeps the index's ranking", async () => {
  fresh();
  const top = await news.headlines({ count: 12 });
  const latest = await news.headlines({ count: 12, sort: "recent" });
  assert.strictEqual(calls.brave, 2, "the order is part of the key");
  assert.strictEqual(top.items[0].id, sha12(BRAVE.results[0].url), "relevance is not re-sorted");
  const mins = latest.items.map((x) => x.ageMins);
  assert.deepStrictEqual(mins, [...mins].sort((a, b) => a - b), `newest first: ${mins}`);
  assert.match(latest.items[0].title, /Election/, "30 minutes old comes first");
  // And each order is served from its own entry afterwards.
  const latest2 = await news.headlines({ count: 3, sort: "recent" });
  assert.strictEqual(calls.brave, 2);
  assert.deepStrictEqual(latest2.items.map((x) => x.id), latest.items.slice(0, 3).map((x) => x.id));
});

test("topics do not share an entry", async () => {
  fresh();
  await news.headlines({ topic: "sports", count: 5 });
  await news.headlines({ count: 5 });
  assert.strictEqual(calls.brave, 2);
  await news.headlines({ topic: "Sports", count: 5 });
  assert.strictEqual(calls.brave, 2, "the same topic in another case is the same entry");
});

test("a failed search is not cached", async () => {
  fresh();
  calls.braveFail = true;
  await assert.rejects(news.headlines({ count: 5 }), /news 500/);
  calls.braveFail = false;
  const ok = await news.headlines({ count: 5 });
  assert.strictEqual(calls.brave, 2, "the failure was served from the cache");
  assert.strictEqual(ok.items.length, 5);
});

test("a picture found after the list was cached reaches the next reader", async () => {
  fresh();
  // First ask: the budget runs out before the budget story's page answers.
  let release;
  const gate = new Promise((r) => { release = r; });
  newsImages._setFetch(async (url) => {
    if (String(url).includes("budget")) await gate;
    const html = ARTICLE_HTML[String(url)];
    return html ? htmlResponse(html) : htmlResponse("nope", 404);
  });
  const first = await newsImages.enrich(
    [{ url: "https://www.livemint.example/budget-2026-tax-slabs.html", image: "" }],
    { budgetMs: 50 }
  );
  assert.strictEqual(first[0].image, "", "not found within the budget");
  release();
  await sleep(20);
  const later = newsImages.fillFromMemory(
    [{ url: "https://www.livemint.example/budget-2026-tax-slabs.html", image: "" }]
  );
  assert.strictEqual(later[0].image, "https://www.livemint.example/images/budget.jpg",
    "the late answer was kept for the next reader");
  servePages();
});

/* ------------------------------------------------------------------ */
section("a picture for the stories that came without one");

test("the page's og:image, resolved against the page", async () => {
  fresh();
  const out = await news.headlines({ count: 3 });
  const budget = out.items.find((x) => /Budget/.test(x.title));
  assert.strictEqual(budget.image, "https://www.livemint.example/images/budget.jpg");
  assert.strictEqual(budget.thumbnail, "", "no small copy from the index for this one");
  const monsoon = out.items.find((x) => /Monsoon/.test(x.title));
  assert.strictEqual(monsoon.image, "https://weather.example/pics/monsoon.jpg?w=1200&h=630",
    "twitter:image when there is no og:image, entities decoded");
  // Only the stories without a picture were looked up.
  assert.deepStrictEqual(pageCalls.sort(), [
    "https://weather.example/monsoon-kerala.html",
    "https://www.livemint.example/budget-2026-tax-slabs.html",
  ]);
});

test("extractor: og:image in either attribute order and either quote", () => {
  const x = newsImages.extractPreviewImage;
  assert.strictEqual(
    x('<meta property="og:image" content="https://a.example/1.jpg">', "https://a.example/p"),
    "https://a.example/1.jpg");
  assert.strictEqual(
    x("<meta content='https://a.example/2.jpg' property='og:image' />", "https://a.example/p"),
    "https://a.example/2.jpg");
  assert.strictEqual(
    x('<META PROPERTY="OG:IMAGE" CONTENT="https://a.example/3.jpg?a=1&amp;b=2">', "https://a.example/p"),
    "https://a.example/3.jpg?a=1&b=2");
});

test("extractor: the secure URL first, then og:image, then twitter:image", () => {
  const x = newsImages.extractPreviewImage;
  const both = '<meta name="twitter:image" content="https://a.example/tw.jpg">' +
    '<meta property="og:image" content="https://a.example/og.jpg">' +
    '<meta property="og:image:secure_url" content="https://a.example/secure.jpg">';
  assert.strictEqual(x(both, "https://a.example/"), "https://a.example/secure.jpg");
  assert.strictEqual(x('<meta name="twitter:image" content="https://a.example/tw.jpg">', "https://a.example/"),
    "https://a.example/tw.jpg");
  assert.strictEqual(x('<link rel="image_src" href="/src.jpg">', "https://a.example/a/b"),
    "https://a.example/src.jpg");
});

test("extractor: relative and protocol-relative paths", () => {
  const x = newsImages.extractPreviewImage;
  assert.strictEqual(x('<meta property="og:image" content="img/p.jpg">', "https://a.example/news/story.html"),
    "https://a.example/news/img/p.jpg");
  assert.strictEqual(x('<meta property="og:image" content="//cdn.a.example/p.jpg">', "https://a.example/x"),
    "https://cdn.a.example/p.jpg");
});

test("extractor: nothing there is nothing, not a guess", () => {
  const x = newsImages.extractPreviewImage;
  assert.strictEqual(x("<html><head><title>No pictures</title></head></html>", "https://a.example/"), "");
  assert.strictEqual(x("", "https://a.example/"), "");
  assert.strictEqual(x(null, null), "");
  assert.strictEqual(x('<meta property="og:title" content="https://a.example/not-an-image.jpg">', "https://a.example/"), "");
});

test("extractor: malformed, unsafe or undrawable values are refused", () => {
  const x = newsImages.extractPreviewImage;
  const base = "https://a.example/story";
  for (const bad of [
    "http://a.example/plain-http.jpg", // release builds refuse http
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "https://[broken/p.jpg",
    "https://a.example/logo.svg",
    "",
    "   ",
  ]) {
    assert.strictEqual(x(`<meta property="og:image" content="${bad}">`, base), "", `accepted ${bad}`);
  }
  // A relative path on an http page resolves to http: refused too.
  assert.strictEqual(x('<meta property="og:image" content="/p.jpg">', "http://a.example/"), "");
  // A bad og:image does not hide a good twitter:image.
  assert.strictEqual(
    x('<meta property="og:image" content="javascript:x"><meta name="twitter:image" content="https://a.example/ok.jpg">', base),
    "https://a.example/ok.jpg");
});

test("four pages at a time, never more", async () => {
  fresh();
  let active = 0;
  let peak = 0;
  newsImages._setFetch(async (url) => {
    active++;
    peak = Math.max(peak, active);
    await sleep(25);
    active--;
    const n = /p(\d+)$/.exec(String(url))[1];
    return htmlResponse(`<meta property="og:image" content="https://img.example/${n}.jpg">`);
  });
  const items = Array.from({ length: 10 }, (_, i) => ({ url: `https://c.example/p${i}`, image: "" }));
  const out = await newsImages.enrich(items, { budgetMs: 5000 });
  assert.ok(peak <= 4, `${peak} pages at once`);
  assert.ok(peak >= 2, "they did run side by side");
  assert.deepStrictEqual(out.map((x) => x.image), items.map((_, i) => `https://img.example/${i}.jpg`));
  assert.ok(items.every((x) => x.image === ""), "the list passed in is never changed");
  servePages();
});

test("the budget holds: a page that never answers does not hold the deck", async () => {
  fresh();
  newsImages._setFetch(async (url) => {
    if (String(url).includes("never")) return new Promise(() => {});
    return htmlResponse('<meta property="og:image" content="https://img.example/fast.jpg">');
  });
  const items = [
    { url: "https://d.example/never-1", image: "" },
    { url: "https://d.example/fast-1", image: "" },
    { url: "https://d.example/has-one", image: "https://img.example/already.jpg" },
  ];
  const t0 = Date.now();
  const out = await newsImages.enrich(items, { budgetMs: 150 });
  const took = Date.now() - t0;
  assert.ok(took < 1000, `waited ${took} ms`);
  assert.strictEqual(out[0].image, "", "the silent page is left for the gradient card");
  assert.strictEqual(out[1].image, "https://img.example/fast.jpg");
  assert.strictEqual(out[2].image, "https://img.example/already.jpg", "a story with a picture is never looked up");
  servePages();
});

test("the default budget is about three seconds, four at a time, 2.5 s a page", () => {
  assert.ok(newsImages.BUDGET_MS >= 2500 && newsImages.BUDGET_MS <= 3500, `${newsImages.BUDGET_MS}`);
  assert.ok(newsImages.CONCURRENCY <= 4);
  assert.strictEqual(newsImages.PAGE_TIMEOUT_MS, 2500);
  assert.strictEqual(newsImages.MAX_BYTES, 256 * 1024);
});

test("a page is looked up once, not on every ask", async () => {
  fresh();
  const items = [{ url: "https://www.livemint.example/budget-2026-tax-slabs.html", image: "" }];
  await newsImages.enrich(items);
  await newsImages.enrich(items);
  await newsImages.lookup(items[0].url);
  assert.strictEqual(pageCalls.length, 1, `fetched ${pageCalls.length} times`);
  // A page that failed is not asked again straight away either.
  await newsImages.enrich([{ url: "https://nowhere.example/404", image: "" }]);
  await newsImages.enrich([{ url: "https://nowhere.example/404", image: "" }]);
  assert.strictEqual(pageCalls.filter((u) => u.includes("nowhere")).length, 1);
});

test("the page reader stops at 256 KB, at </head>, and at its deadline", async () => {
  newsImages._setFetch(null); // the real safeFetch, against 127.0.0.1
  const sf = require("../src/services/safeFetch");
  sf._TEST_ALLOW.add("127.0.0.1");
  let sentBig = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    if (req.url === "/big") {
      const chunk = "<p>" + "x".repeat(16 * 1024) + "</p>";
      let n = 0;
      const pump = () => {
        while (n < 64) {
          n++;
          sentBig += chunk.length;
          if (!res.write(chunk)) return res.once("drain", pump);
        }
        res.end();
      };
      pump();
    } else if (req.url === "/head") {
      res.write('<html><head><meta property="og:image" content="/p.jpg"></head>');
      setTimeout(() => res.end("<body>late</body></html>"), 4000).unref();
    } else {
      res.write("<html><head>"); // and then nothing, ever
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const big = await newsImages.readHead(`${base}/big`, { timeoutMs: 5000 });
    assert.ok(big.html.length <= newsImages.MAX_BYTES, `read ${big.html.length} bytes`);
    assert.ok(big.html.length > 200 * 1024, "and did read up to the cap");

    let t0 = Date.now();
    const head = await newsImages.readHead(`${base}/head`, { timeoutMs: 3000 });
    assert.ok(Date.now() - t0 < 2000, "it waited for the body after </head>");
    assert.match(head.html, /og:image/);

    t0 = Date.now();
    await assert.rejects(newsImages.readHead(`${base}/stall`, { timeoutMs: 300 }));
    assert.ok(Date.now() - t0 < 2000, `a stalled page held it for ${Date.now() - t0} ms`);
  } finally {
    sf._TEST_ALLOW.delete("127.0.0.1");
    server.closeAllConnections();
    server.close();
    servePages();
  }
});

/* ------------------------------------------------------------------ */
section("GET /news/feed");

async function withFeedServer(fn, uid = "990011") {
  const express = require("express");
  const app = express();
  app.use((req, _res, next) => { req.user = { sub: uid }; next(); });
  app.use("/news", require("../src/routes/news"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const get = (path) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}${path}`, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
    }).on("error", reject);
  });
  try { await fn(get); } finally { server.close(); }
}

const STORY_KEYS = ["id", "title", "url", "source", "age", "ageMins", "publishedAt",
  "snippet", "extra", "image", "thumbnail", "favicon"];

test("returns {ok, topic, items} in the shared story shape, 12 by default", async () => {
  fresh();
  await withFeedServer(async (get) => {
    const r = await get("/news/feed");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.topic, "today");
    assert.strictEqual(r.json.items.length, 12);
    for (const s of r.json.items) {
      assert.deepStrictEqual(Object.keys(s).sort(), [...STORY_KEYS].sort(), JSON.stringify(s));
    }
    const three = await get("/news/feed?count=3&sort=recent");
    assert.strictEqual(three.json.items.length, 3);
    assert.match(three.json.items[0].title, /Election/, "sort=recent is honoured");
    const many = await get("/news/feed?count=500");
    assert.ok(many.json.items.length <= 20, "20 at most");
  });
});

test("a chip topic is searched as its topic, and odd characters are dropped", async () => {
  fresh();
  let q = "";
  const saved = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.search.brave.com/")) q = new URL(String(url)).searchParams.get("q");
    return saved(url, init);
  };
  try {
    await withFeedServer(async (get) => {
      await get("/news/feed?topic=tech");
      assert.strictEqual(q, "technology");
      await get("/news/feed?topic=" + encodeURIComponent("Sports<script>"));
      assert.strictEqual(q, "Sports script");
      await get("/news/feed?topic=India");
      assert.notStrictEqual(q, "India", "the India chip is not the Top deck twice");
    });
  } finally {
    global.fetch = saved;
  }
});

test("what the feed showed is the deck 'the second one' counts from", async () => {
  fresh();
  news._forgetShown();
  await withFeedServer(async (get) => {
    const r = await get("/news/feed?count=5");
    const deck = news.lastShown("990012");
    assert.ok(deck, "the feed was not remembered for this user");
    assert.deepStrictEqual(deck.items.map((x) => x.id), r.json.items.map((x) => x.id));
  }, "990012");
});

test("without a news key: the RSS headlines, in the same shape, with no pictures", async () => {
  fresh();
  const key = process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  try {
    await withFeedServer(async (get) => {
      const r = await get("/news/feed?count=12");
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.ok, true);
      assert.strictEqual(calls.brave, 0);
      assert.strictEqual(calls.rss, 1);
      assert.strictEqual(r.json.items.length, 3);
      const s = r.json.items[0];
      assert.deepStrictEqual(Object.keys(s).sort(), [...STORY_KEYS].sort());
      assert.strictEqual(s.title, "Parliament passes the data protection bill");
      assert.strictEqual(s.source, "The Hindu");
      assert.strictEqual(s.url, "https://news.google.com/rss/articles/CBMiA?oc=5");
      assert.strictEqual(s.id, sha12(s.url));
      assert.strictEqual(s.image, "");
      assert.strictEqual(s.thumbnail, "");
      assert.strictEqual(s.favicon, "");
    });
  } finally {
    process.env.BRAVE_SEARCH_API_KEY = key;
  }
});

test("the index failing falls back to the RSS headlines too", async () => {
  fresh();
  calls.braveFail = true;
  const out = await news.feed({ topic: "markets", count: 5 });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.fallback, "rss");
  assert.ok(out.items.length > 0);
  calls.braveFail = false;
});

/* ------------------------------------------------------------------ */
section("read_news_story — 'read me the second one'");

const ARTICLE = "India won the third one-day international by six wickets on Sunday. " +
  "Chasing 287, the side reached the target with an over to spare. ".repeat(10);

async function withArticles(fn) {
  const rw = registry.get("read_webpage");
  const real = rw.execute;
  const asked = [];
  rw.execute = async ({ url }) => {
    asked.push(url);
    if (/paywall|story-3|monsoon/.test(url)) return { ok: false, error: "the site returned 403" };
    return { ok: true, data: { url, title: "Article", text: ARTICLE, truncated: false } };
  };
  try { await fn(asked); } finally { rw.execute = real; }
}

async function deckFor(uid) {
  fresh();
  const out = await news.headlines({ count: 10 });
  news.rememberShown(uid, out.topic, out.items);
  return out.items;
}

test("by number: the second card comes forward and the article is read", async () => {
  const items = await deckFor(990021);
  await withArticles(async (asked) => {
    const res = await registry.get("read_news_story").execute({ which: "2" }, { userId: 990021 });
    assert.strictEqual(res.ok, true, res.error);
    assert.deepStrictEqual(res.deviceAction, { type: "news_focus", id: items[1].id });
    assert.strictEqual(res.data.number, 2);
    assert.strictEqual(res.data.title, items[1].title);
    assert.match(res.data.text, /six wickets/);
    assert.deepStrictEqual(asked, [items[1].url], "it read THAT story's page");
    assert.match(res.note, /SHORT spoken summary/);
  });
});

test("'the second one', '2nd', 'last' all count from the deck", async () => {
  const items = await deckFor(990022);
  await withArticles(async () => {
    for (const [which, i] of [["the second one", 1], ["2nd", 1], ["first", 0], ["last", items.length - 1], ["story 4", 3]]) {
      const res = await registry.get("read_news_story").execute({ which }, { userId: 990022 });
      assert.strictEqual(res.deviceAction.id, items[i].id, `"${which}"`);
    }
  });
});

test("by words from the headline: 'the cricket story'", async () => {
  const items = await deckFor(990023);
  await withArticles(async () => {
    const cricket = await registry.get("read_news_story").execute({ which: "the cricket story" }, { userId: 990023 });
    assert.strictEqual(cricket.deviceAction.id, items[0].id);
    const dengue = await registry.get("read_news_story").execute({ which: "dengue" }, { userId: 990023 });
    assert.match(dengue.data.title, /dengue/);
    const trains = await registry.get("read_news_story").execute({ which: "festival special trains" }, { userId: 990023 });
    assert.match(trains.data.title, /Railways/);
  });
});

test("no deck on screen: it says so and never guesses a story", async () => {
  news._forgetShown();
  const res = await registry.get("read_news_story").execute({ which: "2" }, { userId: 990024 });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "no_news_on_screen");
  assert.strictEqual(res.deviceAction, undefined, "nothing may come forward");
});

test("one user's deck is not another's", async () => {
  await deckFor(990025);
  const res = await registry.get("read_news_story").execute({ which: "1" }, { userId: 990026 });
  assert.strictEqual(res.ok, false);
});

test("no match, or a number past the end: it asks, with the list", async () => {
  await deckFor(990027);
  for (const which of ["zebra crossing", "15"]) {
    const res = await registry.get("read_news_story").execute({ which }, { userId: 990027 });
    assert.strictEqual(res.ok, false, which);
    assert.strictEqual(res.error, "no_such_story");
    assert.ok(res.data.stories.length >= 10);
    assert.match(res.data.stories[0], /^1\. India beat Australia/);
  }
});

test("a page that cannot be read: the card still comes forward, with its summary", async () => {
  const items = await deckFor(990028);
  await withArticles(async () => {
    const res = await registry.get("read_news_story").execute({ which: "monsoon" }, { userId: 990028 });
    const monsoon = items.find((x) => /Monsoon/.test(x.title));
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.deviceAction, { type: "news_focus", id: monsoon.id });
    assert.strictEqual(res.data.readable, false);
    assert.match(res.data.summary, /Summary of story 3/);
    assert.match(res.note, /could not be read/);
    assert.match(res.note, /Never add details/);
  });
});

test("the deck is forgotten after half an hour", async () => {
  await deckFor(990029);
  const realNow = Date.now;
  Date.now = () => realNow() + 31 * 60_000;
  try {
    assert.strictEqual(news.lastShown(990029), null);
  } finally {
    Date.now = realNow;
  }
});

test("its article text is treated as external content, like read_webpage", async () => {
  await deckFor(990030);
  assert.ok(registry.UNTRUSTED_SOURCES.has("read_news_story"));
  await withArticles(async () => {
    const session = { executed: [] };
    const res = await registry.execute("read_news_story", { which: "1" },
      { userId: 990030, session, turnId: "t-news" });
    assert.strictEqual(res.ok, true, res.error);
    assert.match(res.note, /EXTERNAL CONTENT/);
    assert.ok(session.__untrustedAt, "the turn is marked as having read outside content");
  });
});

test("it is offered to build 111 and newer only", () => {
  const names = (build) => registry.declarations({ deviceCaps: { build } }).map((d) => d.name);
  assert.ok(!names(110).includes("read_news_story"), "an app that cannot move its deck was offered it");
  assert.ok(names(111).includes("read_news_story"));
  assert.ok(registry.limitsFor({ build: 110 }).some((l) => l.tool === "read_news_story" && l.needsBuild === 111));
  assert.strictEqual(registry.get("read_news_story").minAppBuild, 111);
});

test("'bringing up the second story' is backed by it, and unbacked without it", () => {
  const claimCheck = require("../src/agents/claimCheck");
  const backed = claimCheck.check("Bringing up the second story now.", [{ tool: "read_news_story", ok: true }]);
  assert.strictEqual(backed.ok, true, backed.violations.join("; "));
  const bare = claimCheck.check("Bringing up the second story now.", []);
  assert.strictEqual(bare.ok, false);
  assert.ok(claimCheck.FAMILY_TOOLS.has("read_news_story"));
});

/* ------------------------------------------------------------------ */
section("show_news — the deck by voice");

test("the stories go out with their card fields, and become the deck to count from", async () => {
  fresh();
  news._forgetShown();
  const res = await registry.get("show_news").execute({}, { userId: 990031, appBuild: 111 });
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.deviceAction.type, "show_news");
  assert.strictEqual(res.deviceAction.items.length, 10, "ten when no number was said");
  const s = res.deviceAction.items[0];
  for (const k of STORY_KEYS) assert.ok(k in s, `${k} missing from the story`);
  assert.deepStrictEqual(news.lastShown(990031).items.map((x) => x.id), res.deviceAction.items.map((x) => x.id));
  assert.match(res.speak, /^1\. India beat Australia/);
});

test("a build-111 app is told about the swipeable deck and read_news_story", async () => {
  fresh();
  const res = await registry.get("show_news").execute({}, { userId: 990032, appBuild: 111 });
  assert.match(res.note, /deck of cards/i);
  assert.match(res.note, /top three headlines/i);
  assert.match(res.note, /ONE short\s+line each/i);
  assert.match(res.note, /read_news_story/);
  assert.match(res.note, /read me the second one/i);
});

test("an older app is not told to swipe, nor about a tool it does not have", async () => {
  fresh();
  for (const appBuild of [110, undefined]) {
    const res = await registry.get("show_news").execute({}, { userId: 990033, appBuild });
    assert.doesNotMatch(res.note, /swipe|read_news_story|deck/i, `build ${appBuild}`);
    assert.match(res.note, /ON THEIR SCREEN/);
  }
});

test("the count they said still wins", async () => {
  fresh();
  const said = await registry.get("show_news").execute({ count: 10 }, { intent: "give me the top 4 news", appBuild: 111 });
  assert.strictEqual(said.deviceAction.items.length, 4);
  const asked = await registry.get("show_news").execute({ count: 2 }, { appBuild: 111 });
  assert.strictEqual(asked.deviceAction.items.length, 2);
  const capped = await registry.get("show_news").execute({ count: 40 }, { appBuild: 111 });
  assert.strictEqual(capped.deviceAction.items.length, 10, "the voice deck stays at ten");
});

/* ------------------------------------------------------------------ */
section("open_app_screen: news");

test("build 111 opens the News screen", async () => {
  fresh();
  const t = registry.get("open_app_screen");
  assert.ok(t.inputSchema.properties.screen.enum.includes("news"));
  const res = await t.execute({ screen: "news" }, { appBuild: 111 });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.deviceAction, { type: "open_app_screen", screen: "news" });
  assert.match(res.speak, /news/i);
  assert.strictEqual(calls.brave, 0, "no lookup for a screen that fetches its own");
});

test("an older app, or one that does not say, gets the voice deck instead", async () => {
  for (const appBuild of [110, 0, undefined]) {
    fresh();
    news._forgetShown();
    const res = await registry.get("open_app_screen").execute({ screen: "news" }, { appBuild, userId: 990041 });
    assert.strictEqual(res.ok, true, `build ${appBuild}: ${res.error}`);
    assert.strictEqual(res.deviceAction.type, "show_news", `build ${appBuild}`);
    assert.strictEqual(res.deviceAction.items.length, 10);
    assert.ok(news.lastShown(990041), "that deck is the one to count from");
  }
});

test("the other screens are unchanged", async () => {
  const res = await registry.get("open_app_screen").execute({ screen: "reminders" }, { appBuild: 110 });
  assert.deepStrictEqual(res.deviceAction, { type: "open_app_screen", screen: "reminders" });
});

/* ------------------------------------------------------------------ */
section("the app half agrees");

test("the app handles news_focus and can build the News screen", () => {
  const fs = require("fs");
  const engine = fs.readFileSync(APP_ROOT + "/lib/features/assistant/state/assistant_engine.dart", "utf8");
  assert.match(engine, /case 'news_focus':/, "the engine drops news_focus");
  assert.match(engine, /'news' => \(_\)/, "open_app_screen news has no screen to open");
  const model = fs.readFileSync(APP_ROOT + "/lib/models/news_item.dart", "utf8");
  for (const k of STORY_KEYS) {
    assert.ok(model.includes(`'${k}'`), `the app does not read "${k}"`);
  }
});

run().then(() => {
  global.fetch = realFetch;
  // The pg pool (if anything touched it) must not hold the process open.
  process.exit(process.exitCode || 0);
});
