/**
 * WEB SEARCH — provider adapter.
 *
 * §28: no fake implementations. If no provider is configured this returns
 * an honest failure the agent reports as "I can't search the web yet",
 * rather than inventing results. Adding a key switches it on with no other
 * code change.
 *
 * Supported (first configured wins):
 *   BRAVE_SEARCH_API_KEY      https://api.search.brave.com
 *   TAVILY_API_KEY            https://tavily.com
 *   GOOGLE_CSE_KEY + GOOGLE_CSE_CX   Google Programmable Search
 *   (fallback) GEMINI_API_KEY — Gemini search grounding: a fast text model
 *   answers the query with the googleSearch grounding tool. Not a fake:
 *   the answer is grounded in real search results with real source URLs.
 *   Grounding has its own (small, free-tier) quota, so a dedicated search
 *   key above is still the reliable choice — this keeps search working
 *   at all when none is set (the live models reject the googleSearch tool
 *   in-session, so this is their only live-data path).
 */
const TIMEOUT_MS = 8000;

/**
 * Providers to try IN ORDER. Keyed providers first (best quality), then
 * Gemini grounding, then DuckDuckGo — which needs no key and no quota, so
 * search can never be dead. One provider failing (429, outage, no
 * results) falls through to the next instead of failing the user's turn.
 */
function providerChain() {
  const chain = [];
  // OpenAI's own search first (2026-10-02): it reads the pages and writes
  // the answer. SEARCH_PROVIDER=brave puts the old chain back in front.
  if (require("../services/ai/openai").ready() && process.env.SEARCH_PROVIDER !== "brave") chain.push("openai");
  if (process.env.BRAVE_SEARCH_API_KEY) chain.push("brave");
  if (process.env.TAVILY_API_KEY) chain.push("tavily");
  if (process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX) chain.push("google");
  chain.push("wikipedia");
  return chain;
}

/**
 * The shape of a question, ignoring the decorations a model bolts on:
 * stop words, dates and numbers. "flights from Noida to Bangalore
 * tomorrow" and "flights from Noida to Bangalore tomorrow time and price
 * 2026-09-12" share one shape, and should share one search.
 */
const FP_STOP = new Set(
  ("the a an of for from to in on at and or with what when how much many " +
   "is are was were do does did please tell me my i you it this that today " +
   "tomorrow now current currently latest time times price prices cost").split(" ")
);
function fingerprint(q) {
  return [
    ...new Set(
      String(q).toLowerCase()
        .replace(/\d{4}-\d{2}-\d{2}/g, " ")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !FP_STOP.has(w))
    ),
  ].sort().join(" ");
}

/** Kept for callers/diagnostics that ask "what will be used first". */
function provider() {
  return providerChain()[0] || null;
}

// Successful searches are cached briefly: the same question asked twice in
// a conversation ("who is the PM of India?" ×3 in one minute, observed)
// must not burn a second unit of the tiny free-tier quota.
/**
 * Questions whose answer changes by the day or the hour. An encyclopedia
 * article is never an answer to one of these.
 */
const LIVE_QUESTION =
  /\b(today|tonight|tomorrow|now|current|currently|latest|live|price|prices|rate|rates|cost|fare|fares|flight|flights|weather|forecast|news|score|scores|open|closing|stock|share|gold|petrol|diesel|exchange|traffic|timing|timings|schedule|available|availability)\b/i;

const searchCache = require("./searchCache");

const RESULT_TTL = 10 * 60_000;
const resultCache = new Map(); // normalized query -> { ts, out }

async function run(query, ctx = {}) {
  const chain = providerChain();
  const q = String(query || "").trim().slice(0, 300);
  if (!q) return { ok: false, error: "empty query" };

  // SPECIALISTS FIRST. Weather and exchange rates have keyless sources
  // that are better than a grounded search for their own questions — a
  // forecast from the meteorological service beats a model's summary of a
  // weather page — and answering them here leaves the tiny search quota
  // for the questions that genuinely need a search engine.
  const specialist = await require("./liveFacts").tryLiveFact(q, ctx);
  if (specialist) return specialist;

  const cacheKey = q.toLowerCase();
  const hit = resultCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < RESULT_TTL) return hit.out;
  const isLive = LIVE_QUESTION.test(q);

  // NEAR-DUPLICATES COUNT AS THE SAME QUESTION. One turn asking about
  // flights ran two searches — "flights from Noida to Bangalore tomorrow"
  // and the same thing with "time and price 2026-09-12" bolted on — which
  // spends two of a very small daily allowance to answer one question,
  // and the second, over-specific one is usually the worse of the two.
  // THE SHAPE MUST CARRY isLive, because the RESULTS depend on it.
  // fingerprint() deliberately strips "price", "today", "latest" and the
  // rest as noise — which are the very words LIVE_QUESTION keys on. So
  // "best laptops 2026" and "best laptops 2026 price" reduce to ONE shape
  // while being searched differently (one day-restricted, one not) and
  // cached with different TTLs. Whichever landed first was served to the
  // other, under the wrong freshness and for the wrong length of time.
  const shape = fingerprint(q) + (isLive ? " \u2022live" : "");
  for (const [, v] of resultCache) {
    if (v.shape === shape && Date.now() - v.ts < RESULT_TTL) return v.out;
  }

  // THE SHARED STORE. Memory above is this process's own; this is every
  // user's. One person asking for today's headlines answers it for the
  // next person, and it survives a deploy — which the in-memory cache
  // never did. Live questions keep 20 minutes, settled facts a day.
  const shared = await searchCache.get(shape);
  if (shared) {
    resultCache.set(cacheKey, { ts: Date.now(), out: shared, shape });
    return shared;
  }

  let results = [];
  let lastError = "";
  let used = "";
  let blocked = false; // any provider refused us, not merely found nothing
  for (const p of chain) {
    try {
      const r = await BACKENDS[p](q, { isLive, stable: require("./pageText").prefersStablePages(q), lat: ctx.lat, lng: ctx.lng });
      if (r && r.length) {
        results = r;
        used = p;
        break;
      }
      lastError = `${p}: no results`;
    } catch (e) {
      lastError = `${p}: ${String(e.message).slice(0, 120)}`;
      // REMEMBER AN OUTAGE ACROSS THE WHOLE CHAIN. lastError only holds
      // the final provider's message, and the chain ends on Wikipedia —
      // so a quota exhaustion two providers earlier was reported as
      // "wikipedia: no results", i.e. as an absence rather than an
      // outage.
      if (/rate.?limit|429|quota|exhaust|timeout|ECONN/i.test(e.message || "")) {
        blocked = true;
      }
      console.warn(`web search ${lastError} — trying next provider`);
    }
  }
  if (!results.length) {
    // "I COULD NOT LOOK" IS NOT "IT DOES NOT EXIST".
    //
    // The free grounding quota runs out several times a day, and the
    // chain then falls to Wikipedia, which has nothing for a local
    // business or a named professional. The model saw a bare "search
    // failed" and told the user "I'm not finding any wine shops near the
    // bus stand" — which reads as the shop not existing, about a shop
    // that has been there thirty years. The distinction has to reach the
    // model or it will keep reporting an outage as an absence.
    const unavailable =
      blocked || /rate.?limit|429|quota|no provider|timeout|ECONN/i.test(lastError);
    return {
      ok: false,
      error: unavailable
        ? "the web search is temporarily unavailable (rate limit), so nothing could be looked up"
        : `search failed (${lastError || "no results"})`,
      note: unavailable
        ? "SAY YOU COULD NOT SEARCH, not that nothing was found. The search " +
          "did not run — reporting 'I couldn't find any' about a place that " +
          "may well exist is wrong and the user can tell. Say the search is " +
          "unavailable for a moment, and offer to open a map or the site " +
          "instead. Do NOT answer the question from your own memory as " +
          "though you had looked it up."
        : undefined,
    };
  }

  // A LIVE QUESTION DESERVES A REAL ANSWER OR A STRAIGHT NO.
  //
  // When every real provider is spent, the chain lands on Wikipedia — and
  // "gold rate today India" comes back as the Reserve Bank of India's
  // article. That is not an answer to a question about today, and handing
  // it over as one is how the assistant ended up telling a user to go and
  // check IndiGo themselves. If the question is plainly about something
  // that CHANGES and all we have is an encyclopedia, say so.
  if (used === "wikipedia" && LIVE_QUESTION.test(q)) {
    return {
      ok: false,
      error: "search_unavailable",
      data: {
        query: q,
        hint:
          "Live web search is unavailable right now (the provider's quota is " +
          "spent), and an encyclopedia cannot answer a question about prices, " +
          "times, rates, weather or news TODAY. Say in ONE short line that " +
          "you cannot look that up at the moment, and offer to open the page " +
          "on their phone. Do NOT guess the figure, do NOT answer from " +
          "memory as though it were current, and do NOT tell them to go and " +
          "search for it themselves.",
      },
    };
  }
  try {
    // AN ENCYCLOPEDIA IS NOT A WEB SEARCH, and the model has to be told.
    // Asked for flight times and prices, the Wikipedia fallback returned
    // five Delhi Metro articles; handed over as plain numbered results
    // they read as a failed search, and the reply told the user to go
    // check IndiGo themselves. Naming the fallback lets the answer be
    // "I can't get live prices" instead of a shrug dressed as research.
    const fallback = used === "wikipedia";
    const out = {
      provider: used,
      ok: true,
      data: results,
      // Compact digest for the model to summarise from.
      speak: used === "openai"
        ? results[0].snippet
        : results
            .slice(0, 5)
            .map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`)
            .join("\n"),
      ...(fallback
        ? {
            note:
              "THESE ARE WIKIPEDIA ARTICLES, not live web results — the web " +
              "search providers were unavailable, so this is the last-resort " +
              "encyclopedia. They will NOT contain prices, timetables, " +
              "availability or anything else that changes. If that is what " +
              "was asked for, say in ONE line that you cannot get live " +
              "prices or times right now, and offer to open the site for " +
              "them. Never tell them to go and look it up themselves, and " +
              "never present these articles as an answer to a live question.",
          }
        : {}),
    };
    // "What are the flight timings from Mangalore to Bangalore" (the
    // owner, 2026-10-01): three searches, pages whose snippets carried no
    // times, and the assistant offered Google. When the question wants
    // figures and the snippets have none, read the top pages and hand
    // over the lines that carry times and prices. SEARCH_DEEP_READ=off
    // switches it off.
    if (!fallback && process.env.SEARCH_DEEP_READ !== "off") {
      const pt = require("./pageText");
      const kind = pt.figureKind(q);
      if (used !== "openai" && pt.wantsFigures(q) && !pt.hasFigures(results, kind)) {
        const pages = await deepRead(results, { kind });
        if (pages.length) {
          out.data = { results, pages };
          out.speak += "\n" + pages.map((p) => `From ${p.site}: ${p.lines.join(" | ")}`).join("\n");
          out.note =
            "The figures the question asked for are in `pages` (read from the top results). " +
            "Answer from them in your own words — the specific times or prices, with the site " +
            "they came from. Do NOT offer to open a website for a question; only if they want " +
            "to book or buy.";
        } else {
          out.note =
            "No page carried the exact figures. Say plainly what you found (which airlines, " +
            "how long, typical times) and that the exact timetable was not in reach — do NOT " +
            "offer to open Google; offer open_webpage only if they want to book.";
        }
      }
    }
    resultCache.set(cacheKey, { ts: Date.now(), out, shape });
    if (resultCache.size > 200) {
      resultCache.delete(resultCache.keys().next().value);
    }
    // Write-through, fire and forget: a cache write must never delay or
    // fail the answer the user is waiting for.
    searchCache.put(shape, q, out, isLive).catch(() => {});
    return out;
  } catch (e) {
    return { ok: false, error: `search failed: ${String(e.message).slice(0, 300)}` };
  }
}

const BACKENDS = {
  /**
   * OPENAI — the first provider since 2026-10-02: one call searches, reads
   * the pages and writes the answer with its sources, so the brain gets
   * the figures themselves (a flight time, today's rate) instead of six
   * snippets to guess from. The answer is the first result, marked
   * `answer: true`; the sources follow it as plain results.
   */
  async openai(q) {
    const openai = require("../services/ai/openai");
    const r = await openai.webSearch(q, { location: { country: process.env.SEARCH_COUNTRY || "IN" } });
    if (!r.text) return [];
    return [
      { title: "Answer from a live web search (just now)", snippet: r.text.slice(0, 1500), url: r.sources[0] ? r.sources[0].url : "", answer: true },
      ...r.sources.map((src) => ({ title: src.title, snippet: "", url: src.url })),
    ];
  },
  /**
   * WIKIPEDIA — keyless, unmetered, never blocked. The last resort under
   * every quota so search is never fully dead: testers hit "my search
   * tool is still acting up" for a whole session when the only provider
   * (Gemini grounding) ran out of its tiny daily bucket. Encyclopedic
   * only, and the results say so, so the model never presents this as a
   * live web search.
   */
  async wikipedia(q) {
    const r = await fetch(
      "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=" +
        encodeURIComponent(q),
      { signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    if (!r.ok) throw new Error(`wikipedia ${r.status}`);
    const j = await r.json();
    return (j.query?.search || []).map((x) => ({
      title: `${x.title} (Wikipedia)`,
      snippet: String(x.snippet || "").replace(/<[^>]*>/g, "").replace(/&quot;/g, '"'),
      url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(String(x.title).replace(/ /g, "_")),
    }));
  },

  /**
   * BRAVE — the primary provider, and the first one on this deployment
   * with an index of its own. Gemini grounding was answering "I'm not
   * finding any" about a wine shop that has stood opposite a bus stand
   * for thirty years, because its tiny free bucket was spent and the
   * chain fell through to Wikipedia. Measured on the live key, Brave
   * returns that shop, today's gold rate carrying today's date, and a
   * celebrity's real Instagram handle ranked first.
   *
   * Four parameters do most of that work, and all four are deliberate:
   *   country            results for Indian users, not American ones —
   *                      the default is "us", which is how a Mangalore
   *                      question got answered from the wrong continent
   *   text_decorations=0 no <strong> markup for a voice reply to read out
   *   extra_snippets=1   several passages per page instead of one line
   *   freshness=pd       a question about TODAY only looks at today
   */
  async brave(q, opts = {}) {
    // Brave returns HTML, so snippets carry both tags and ENTITIES —
    // "today&#x27;s gold rate", "18k &amp; 22k", "up 0.4&deg;". A voice
    // reply reads those out literally, so they are decoded here rather
    // than left for the model to tidy up (which it does not reliably do).
    const ENTITY = {
      "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
      "&apos;": "'", "&nbsp;": " ", "&rsquo;": "’", "&lsquo;": "‘",
      "&ldquo;": "“", "&rdquo;": "”", "&hellip;": "…",
      "&ndash;": "–", "&mdash;": "—", "&deg;": "°",
      "&times;": "×", "&middot;": "·", "&eacute;": "é",
      "&trade;": "™", "&reg;": "®", "&copy;": "©",
      "&bull;": "•", "&euro;": "€", "&pound;": "£",
    };
    const clean = (t) =>
      String(t || "")
        .replace(/<[^>]*>/g, "")
        .replace(/&[#a-zA-Z0-9]{2,8};/g, (m) => {
          const k = m.toLowerCase();
          if (ENTITY[k] !== undefined) return ENTITY[k];
          // A NUMERIC ENTITY IS ATTACKER-ADJACENT INPUT: it comes from
          // whatever HTML a third-party page happened to contain.
          // String.fromCodePoint THROWS on anything above U+10FFFF, and an
          // uncaught throw here discards the entire search for the query —
          // one malformed "&#1234567;" on one page would have looked to
          // the user like the whole web being unreachable.
          const num = /^&#(?:x([0-9a-f]+)|(\d+));$/i.exec(m);
          if (num) {
            const n = num[1] ? parseInt(num[1], 16) : Number(num[2]);
            if (Number.isFinite(n) && n >= 0 && n <= 0x10ffff) {
              try {
                return String.fromCodePoint(n);
              } catch (_) {
                return m;
              }
            }
          }
          return m;
        })
        .replace(/\s+/g, " ")
        .trim();

    const ask = async (freshness) => {
      const params = new URLSearchParams({
        q,
        count: "8",
        country: process.env.SEARCH_COUNTRY || "IN",
        search_lang: "en",
        text_decorations: "0",
        extra_snippets: "1",
        safesearch: "moderate",
      });
      if (freshness) params.set("freshness", freshness);

      const r = await fetch(
        `https://api.search.brave.com/res/v1/web/search?${params}`,
        {
          headers: {
            accept: "application/json",
            "accept-encoding": "gzip",
            "x-subscription-token": process.env.BRAVE_SEARCH_API_KEY,
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }
      );
      // The words "rate limit" have to survive into this message: the chain
      // above reads it to tell an OUTAGE apart from an absence, and saying
      // "I found nothing" when we never looked is the bug that started all
      // of this.
      if (r.status === 429) throw new Error("brave 429 rate limit");
      if (!r.ok) throw new Error(`brave ${r.status}`);
      const j = await r.json();

      // AN INFOBOX IS AN ANSWER, not a link to one. "Who is the prime
      // minister of India" comes back with the entry itself; leading with
      // it saves the model inferring a fact from three page titles.
      const lead = [];
      const ib = (j.infobox && j.infobox.results ? j.infobox.results : [])[0];
      if (ib && (ib.long_desc || ib.description)) {
        lead.push({
          title: clean(ib.title),
          snippet: clean(ib.long_desc || ib.description).slice(0, 600),
          url: ib.url || ib.website_url || "",
        });
      }

      // Brave stamps each story with its age ("6 hours ago"). That stamp is
      // the whole difference between news and an article that merely
      // mentions the subject, so it is carried into the snippet.
      //
      // CAPPED AT THREE. Only the first five entries reach `speak`, which
      // is all the model reads on the text path — an unbounded news block
      // could fill every one of them and hide the page actually carrying
      // the figure that was asked for.
      const news = ((j.news && j.news.results) || []).slice(0, 3).map((n) => ({
        title: clean(n.title),
        snippet: (n.age ? `[${clean(n.age)}] ` : "") + clean(n.description),
        url: n.url || "",
      }));

      const web = ((j.web && j.web.results) || []).map((x) => ({
        title: clean(x.title),
        snippet: [clean(x.description), ...(x.extra_snippets || []).map(clean)]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 700),
        url: x.url || "",
        ...(x.page_age ? { date: String(x.page_age).slice(0, 10) } : {}),
      }));

      // Dated stories lead a live question; for a settled one the ranked
      // web results are the better answer and the news merely rides along.
      return [...lead, ...(freshness ? [...news, ...web] : [...web, ...news])]
        .filter((x) => x.title || x.snippet)
        .slice(0, 10);
    };

    // "What's the news" asked twice in a day must not return the same four
    // stories, so a live question is restricted to the past day first.
    // …unless it is a timetable or a route: the settled page beats the one
    // touched today, which was about another route (pageText.prefersStablePages).
    let out = await ask(opts.isLive && !opts.stable ? "pd" : null);

    // A DAY-RESTRICTED SEARCH THAT FINDS NOTHING IS NOT AN ABSENCE.
    //
    // LIVE_QUESTION matches on words like "open", "timing", "schedule" and
    // "available" — questions whose answer is current but whose PAGE is
    // years old. "What time does the wine shop opposite the bus stand
    // open" returns eight results unrestricted and ZERO with freshness=pd,
    // and the empty result walked the chain down to Wikipedia, where the
    // live-question guard reported it to the user as the search provider's
    // quota being spent. That is the exact "I could not look" lie this
    // module exists to prevent, so the restriction is retried away rather
    // than believed. Searching twice is affordable; lying is not.
    if (!out.length && opts.isLive) out = await ask(null);
    return out;
  },

  async tavily(q) {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: q,
        max_results: 6,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`tavily ${r.status}`);
    const j = await r.json();
    return (j.results || []).map((x) => ({
      title: x.title,
      snippet: x.content,
      url: x.url,
    }));
  },

  async google(q) {
    const u =
      `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_CSE_KEY}` +
      `&cx=${process.env.GOOGLE_CSE_CX}&num=6&q=${encodeURIComponent(q)}`;
    const r = await fetch(u, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new Error(`google cse ${r.status}`);
    const j = await r.json();
    return (j.items || []).map((x) => ({
      title: x.title,
      snippet: x.snippet,
      url: x.link,
    }));
  },
};

/**
 * The lines with figures from the top two result pages, read through
 * safeFetch (model-visible URLs must not reach this server's own network).
 * [{ site, url, lines }] — pages that fail, time out, or carry no figure
 * are left out.
 */
async function deepRead(results, { max = 5, keep = 2, timeoutMs = 8000, kind } = {}) {
  const pt = require("./pageText");
  const { safeFetch } = require("../services/safeFetch");
  const picks = (results || []).filter((r) => /^https?:\/\//i.test(r.url || "")).slice(0, max);
  const pages = await Promise.all(picks.map(async (r) => {
    try {
      const resp = await safeFetch(r.url, { headers: { "user-agent": "MyAssistant/1.0 (+https://hariassistant.tech)", accept: "text/html" } }, { timeoutMs });
      if (!resp.ok) return null;
      const type = String(resp.headers.get("content-type") || "");
      if (!/text\/html|application\/xhtml/i.test(type)) return null;
      const html = (await resp.text()).slice(0, 600_000);
      const lines = pt.figureLines(pt.extractReadableText(html), 1200, kind);
      if (!lines.length) return null;
      let site = r.url;
      try { site = new URL(r.url).hostname.replace(/^www\./, ""); } catch (_) { /* keep */ }
      return { site, url: r.url, lines };
    } catch (_) {
      return null;
    }
  }));
  // The big booking sites render their timetables in the browser, so the
  // first results often carry nothing; the fifth (trip.com, cleartrip)
  // does. All are read at once; the first two with figures are kept.
  return pages.filter(Boolean).slice(0, keep);
}

/** One named backend, bypassing the chain and the caches — open_public_pdf
 *  needs raw links (Brave honours filetype:pdf), not an answer. */
async function searchWith(name, q, opts = {}) {
  if (!BACKENDS[name]) throw new Error(`no search backend ${name}`);
  return BACKENDS[name](String(q || "").slice(0, 300), opts);
}

module.exports = { run, provider, deepRead, searchWith };
