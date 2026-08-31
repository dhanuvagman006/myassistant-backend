/**
 * MARKET & STOCKS HUB — live data, not the hardcoded mock it replaced
 * (the mock is why the screen looked identical for days).
 *
 *   quotes   — Yahoo Finance v8 chart endpoint (keyless, verified live):
 *              current price, day change, 5-day trend for a liquid NSE
 *              watchlist + Nifty 50 / Sensex. 10-minute cache.
 *   analysis — one Gemini call over the REAL numbers picks the buy/avoid
 *              lists and writes a market summary; cached ~1h so the hub
 *              refreshes through the trading day without burning quota.
 *              If the model is unavailable, momentum-based fallback text
 *              keeps the screen honest (never stale fiction).
 *   news     — Google News RSS, market topic (existing free news tool).
 *
 * Response shape is a superset of the old one (invest/sell/news kept) so
 * older app builds keep working; new builds also render summary+indices.
 * Everything here is general market information — not personal advice —
 * and the summary says so.
 */
const router = require("express").Router();

const WATCHLIST = [
  ["TCS.NS", "TCS", "Tata Consultancy Services"],
  ["INFY.NS", "INFY", "Infosys"],
  ["RELIANCE.NS", "RELIANCE", "Reliance Industries"],
  ["HDFCBANK.NS", "HDFCBANK", "HDFC Bank"],
  ["ICICIBANK.NS", "ICICIBANK", "ICICI Bank"],
  ["SBIN.NS", "SBIN", "State Bank of India"],
  ["BHARTIARTL.NS", "BHARTIARTL", "Bharti Airtel"],
  ["ITC.NS", "ITC", "ITC"],
  ["LT.NS", "LT", "Larsen & Toubro"],
  ["TATAMOTORS.NS", "TATAMOTORS", "Tata Motors"],
  ["SUNPHARMA.NS", "SUNPHARMA", "Sun Pharma"],
  ["MARUTI.NS", "MARUTI", "Maruti Suzuki"],
];
const INDICES = [
  ["^NSEI", "Nifty 50"],
  ["^BSESN", "Sensex"],
];

const QUOTE_TTL = 10 * 60_000;
const AI_TTL = 60 * 60_000;
const quoteCache = new Map(); // yahooSym -> {ts, data}
let aiCache = null; // {ts, analysis}

async function fetchQuote(yahooSym) {
  const hit = quoteCache.get(yahooSym);
  if (hit && Date.now() - hit.ts < QUOTE_TTL) return hit.data;
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/` +
    `${encodeURIComponent(yahooSym)}?range=5d&interval=1d`;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`yahoo ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  const closes = (res?.indicators?.quote?.[0]?.close || []).filter(
    (c) => Number.isFinite(c)
  );
  const price = Number(res?.meta?.regularMarketPrice ?? closes.at(-1));
  if (!Number.isFinite(price) || closes.length < 2) throw new Error("no data");
  const prev = closes.length >= 2 ? closes.at(-2) : price;
  const first = closes[0];
  const data = {
    price: Math.round(price * 100) / 100,
    dayPct: Math.round(((price - prev) / prev) * 1000) / 10,
    weekPct: Math.round(((price - first) / first) * 1000) / 10,
  };
  quoteCache.set(yahooSym, { ts: Date.now(), data });
  return data;
}

const pct = (n) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;

/** Momentum fallback when the AI is out of quota — honest, data-driven. */
function fallbackAnalysis(rows) {
  const sorted = [...rows].sort((a, b) => b.dayPct - a.dayPct);
  const line = (s) =>
    `${s.dayPct >= 0 ? "Up" : "Down"} ${pct(Math.abs(s.dayPct)).replace("+", "")} today, ` +
    `${pct(s.weekPct)} over the week — ${s.dayPct >= 0 ? "positive" : "weak"} momentum.`;
  return {
    summary:
      "Live watchlist view based on today's price action. " +
      "General market information, not investment advice.",
    invest: sorted.slice(0, 3).map((s) => ({ symbol: s.symbol, reason: line(s) })),
    sell: sorted.slice(-2).reverse().map((s) => ({ symbol: s.symbol, reason: line(s) })),
  };
}

async function aiAnalysis(rows, indices) {
  if (aiCache && Date.now() - aiCache.ts < AI_TTL) return aiCache.analysis;
  try {
    const { generateReply } = require("../services/ai/router");
    const table = rows
      .map((s) => `${s.symbol}: ₹${s.price}, today ${pct(s.dayPct)}, 5-day ${pct(s.weekPct)}`)
      .join("\n");
    const idx = indices
      .map((i) => `${i.name}: today ${pct(i.dayPct)}, 5-day ${pct(i.weekPct)}`)
      .join("; ");
    const { reply } = await generateReply(
      [
        {
          role: "user",
          content:
            `Indian market snapshot right now — indices: ${idx}\nWatchlist:\n${table}`,
        },
      ],
      {
        system:
          "You are a sharp Indian equity market analyst writing for a " +
          "personal-assistant app. From the LIVE data given (use only it — " +
          "no invented events), return STRICT JSON, no markdown:\n" +
          '{"summary":"2-3 sentences on today\'s market mood and what to watch",' +
          '"invest":[{"symbol":"...","reason":"one specific sentence grounded in its numbers"}],' +
          '"sell":[{"symbol":"...","reason":"..."}]}\n' +
          "Pick 3 invest (strong/steady momentum) and 2 sell/avoid (weak " +
          "momentum) from the watchlist symbols only. End the summary with " +
          "'Not investment advice.'",
      }
    );
    const clean = String(reply || "").replace(/```json|```/g, "").trim();
    const a = JSON.parse(clean);
    if (!a?.summary || !Array.isArray(a.invest) || !Array.isArray(a.sell)) {
      throw new Error("bad shape");
    }
    aiCache = { ts: Date.now(), analysis: a };
    return a;
  } catch (e) {
    console.warn("stocks ai analysis fallback:", e.message);
    return fallbackAnalysis(rows);
  }
}

router.get("/", async (_req, res) => {
  try {
    const [stockResults, indexResults] = await Promise.all([
      Promise.allSettled(
        WATCHLIST.map(async ([y, symbol, name]) => ({
          symbol,
          name,
          ...(await fetchQuote(y)),
        }))
      ),
      Promise.allSettled(
        INDICES.map(async ([y, name]) => ({ name, ...(await fetchQuote(y)) }))
      ),
    ]);
    const rows = stockResults.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const indices = indexResults.filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (!rows.length) throw new Error("no quotes available");

    const bySymbol = Object.fromEntries(rows.map((s) => [s.symbol, s]));
    const analysis = await aiAnalysis(rows, indices);
    // The AI names symbols; prices/changes ALWAYS come from the live rows.
    const enrich = (list) =>
      (list || [])
        .map((e) => bySymbol[e.symbol] && {
          symbol: e.symbol,
          name: bySymbol[e.symbol].name,
          price: bySymbol[e.symbol].price,
          change: pct(bySymbol[e.symbol].dayPct),
          reason: String(e.reason || "").slice(0, 220),
        })
        .filter(Boolean);
    let invest = enrich(analysis.invest);
    let sell = enrich(analysis.sell);
    if (!invest.length || !sell.length) {
      const fb = fallbackAnalysis(rows);
      if (!invest.length) invest = enrich(fb.invest);
      if (!sell.length) sell = enrich(fb.sell);
    }

    let news = [];
    try {
      const items = await require("../services/tools/news").getHeadlines({
        topic: "Indian stock market Nifty Sensex",
        max: 5,
      });
      news = items.map((h) => ({
        headline: h.title,
        source: h.source || "Markets",
        time: "today",
      }));
    } catch (_) {}

    res.json({
      summary: String(analysis.summary || "").slice(0, 600),
      indices: indices.map((i) => ({
        name: i.name,
        price: i.price,
        change: pct(i.dayPct),
      })),
      updated_at: Date.now(),
      invest,
      sell,
      news,
    });
  } catch (e) {
    console.error("stocks hub:", e.message);
    res.status(503).json({ error: "market data unavailable right now" });
  }
});

module.exports = router;
