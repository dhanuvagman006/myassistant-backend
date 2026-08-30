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

function provider() {
  if (process.env.BRAVE_SEARCH_API_KEY) return "brave";
  if (process.env.TAVILY_API_KEY) return "tavily";
  if (process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX) return "google";
  if (process.env.GEMINI_API_KEY) return "gemini";
  return null;
}

// Successful searches are cached briefly: the same question asked twice in
// a conversation ("who is the PM of India?" ×3 in one minute, observed)
// must not burn a second unit of the tiny free-tier quota.
const RESULT_TTL = 10 * 60_000;
const resultCache = new Map(); // normalized query -> { ts, out }

async function run(query) {
  const p = provider();
  if (!p) {
    return {
      ok: false,
      error:
        "web search is not configured on this server (set BRAVE_SEARCH_API_KEY, " +
        "TAVILY_API_KEY, or GOOGLE_CSE_KEY + GOOGLE_CSE_CX)",
    };
  }
  const q = String(query || "").trim().slice(0, 300);
  if (!q) return { ok: false, error: "empty query" };

  const cacheKey = q.toLowerCase();
  const hit = resultCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < RESULT_TTL) return hit.out;

  try {
    const results = await BACKENDS[p](q);
    if (!results.length) return { ok: false, error: "no results" };
    const out = {
      ok: true,
      data: results,
      // Compact digest for the model to summarise from.
      speak: results
        .slice(0, 5)
        .map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`)
        .join("\n"),
    };
    resultCache.set(cacheKey, { ts: Date.now(), out });
    if (resultCache.size > 200) {
      resultCache.delete(resultCache.keys().next().value);
    }
    return out;
  } catch (e) {
    return { ok: false, error: `search failed: ${String(e.message).slice(0, 300)}` };
  }
}

const BACKENDS = {
  async brave(q) {
    const r = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=6`,
      {
        headers: {
          accept: "application/json",
          "x-subscription-token": process.env.BRAVE_SEARCH_API_KEY,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }
    );
    if (!r.ok) throw new Error(`brave ${r.status}`);
    const j = await r.json();
    return (j.web?.results || []).map((x) => ({
      title: x.title,
      snippet: x.description,
      url: x.url,
    }));
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

  async gemini(q) {
    // MODEL CHOICE MATTERS HERE, measured 2026-08-29: Google meters the
    // built-in Google Search grounding PER MODEL FAMILY. On this key every
    // gemini-3.x model 429s on grounded requests (free-tier allowance is
    // spent/absent) while gemini-2.5-flash grounds fine — which is exactly
    // why the all-2.5 era assistant "just had" real-time info. So search
    // runs on 2.5 by default even though chat runs on 3.5. When the 2.5
    // family retires (2026-10-16) set GEMINI_SEARCH_MODEL, or the main
    // model takes over automatically below.
    const { envModel } = require("../services/ai/router");
    // Every model has its OWN tiny free-tier daily bucket (~20/day on the
    // flash models, measured), so grounding walks a CHAIN of buckets
    // instead of dying with the first.
    const chain = [
      envModel("GEMINI_SEARCH_MODEL", "gemini-2.5-flash"),
      envModel("GEMINI_MODEL", "gemini-3.5-flash-lite"),
      "gemini-flash-lite-latest",
      "gemini-3.6-flash",
    ].filter((m, i, a) => a.indexOf(m) === i);
    const attempt = async (model) => {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": process.env.GEMINI_API_KEY,
          },
          signal: AbortSignal.timeout(12_000),
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text:
                      "Search the web and answer concisely and factually, with " +
                      "concrete figures where they exist: " + q,
                  },
                ],
              },
            ],
            tools: [{ googleSearch: {} }],
            // Skip pre-answer reasoning either way: search+compose needs
            // none, and it costs ~0.8s measured (2.7s vs 3.5s per query).
            ...(/^gemini-3/i.test(model)
              ? { generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } } }
              : /^gemini-2\.5-flash/i.test(model)
                ? { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }
                : {}),
          }),
        }
      );
      return r;
    };
    let r;
    for (const model of chain) {
      r = await attempt(model);
      // 404 = model retired; 429 = that model's bucket is spent for now.
      // Either way the next bucket may still have allowance.
      if (r.status !== 429 && r.status !== 404) break;
    }
    if (r.status === 429) {
      // Every bucket is momentarily dry. This text is READ BY THE MODEL as
      // the tool result — make it an instruction, not a shrug, so the
      // assistant answers instead of refusing ("who is the PM of India"
      // must never die because a rate limiter coughed).
      throw new Error(
        "web search is rate-limited for a few minutes. Do NOT refuse the " +
          "user's question: answer it from your own knowledge if you know " +
          "it, and briefly mention you couldn't double-check it live just " +
          "now. Only if you genuinely do not know the answer, say so and " +
          "suggest trying again in a few minutes."
      );
    }
    if (!r.ok) throw new Error(`gemini grounding ${r.status}`);
    const d = await r.json();
    const answer =
      d.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim() || "";
    if (!answer) throw new Error("gemini grounding returned nothing");
    const sources = (d.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
      .map((c) => ({
        title: c.web?.title || "source",
        snippet: "",
        url: c.web?.uri || "",
      }))
      .filter((s) => s.url)
      .slice(0, 5);
    // The grounded answer itself is the digest; sources ride along for the
    // on-screen citation cards.
    return [{ title: "Web answer", snippet: answer, url: "" }, ...sources];
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

module.exports = { run, provider };
