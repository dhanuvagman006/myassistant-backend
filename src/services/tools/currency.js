/**
 * CURRENCY (C4) — live exchange rates via frankfurter.app (ECB data,
 * free, no API key), and a keyless fallback for the currencies the ECB
 * does not publish (see FALLBACK). 1-hour cache — rates don't move
 * faster than that for conversational purposes, and it keeps us well
 * under any limits.
 */
const cache = new Map();
const TTL = 60 * 60 * 1000;

const WORDS = {
  dollar: "USD", dollars: "USD", usd: "USD", buck: "USD", bucks: "USD",
  rupee: "INR", rupees: "INR", inr: "INR", "₹": "INR",
  euro: "EUR", euros: "EUR", eur: "EUR", "€": "EUR",
  pound: "GBP", pounds: "GBP", gbp: "GBP", "£": "GBP",
  yen: "JPY", jpy: "JPY", "¥": "JPY",
  dirham: "AED", dirhams: "AED", aed: "AED",
  riyal: "SAR", riyals: "SAR", sar: "SAR",
  "singapore dollar": "SGD", sgd: "SGD",
  "australian dollar": "AUD", aud: "AUD",
  "canadian dollar": "CAD", cad: "CAD",
  franc: "CHF", francs: "CHF", chf: "CHF",
  yuan: "CNY", cny: "CNY", rmb: "CNY",
  won: "KRW", krw: "KRW",
  baht: "THB", thb: "THB",
  ringgit: "MYR", myr: "MYR",
};

const CODE_RE = new RegExp(
  `\\b(${Object.keys(WORDS).sort((a, b) => b.length - a.length).join("|")})\\b`,
  "gi"
);

/** Detects a conversion ask; returns {amount, from, to} or null. */
function parseCurrencyAsk(msg) {
  const codes = [];
  let m;
  CODE_RE.lastIndex = 0;
  while ((m = CODE_RE.exec(msg)) && codes.length < 2) {
    const code = WORDS[m[1].toLowerCase()];
    if (!codes.includes(code)) codes.push(code);
  }
  if (codes.length < 2) return null;
  const amt = msg.match(/(\d[\d,]*(?:\.\d+)?)/);
  return {
    amount: amt ? parseFloat(amt[1].replace(/,/g, "")) : 1,
    from: codes[0],
    to: codes[1],
  };
}

/** "AED", "aed" or "dirham" → "AED"; anything else → "". */
function codeOf(s) {
  const t = String(s || "").trim();
  const word = WORDS[t.toLowerCase()];
  if (word) return word;
  return /^[a-z]{3}$/i.test(t) ? t.toUpperCase() : "";
}

/**
 * THE ECB LIST IS NOT ENOUGH. frankfurter publishes the ~30 currencies
 * the European Central Bank does, so the dirham, the riyal and the
 * Moroccan dirham all answered 404 — 6 of 6 conversions failed in
 * production (2026-09-26), and Gulf currencies are among the ones Indian
 * users ask about most. The fallback is a free, keyless daily feed of
 * ~200 currencies (fawazahmed0 exchange-api, public domain), served from
 * two independent hosts.
 */
const FALLBACK = [
  (f) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${f}.json`,
  (f) => `https://latest.currency-api.pages.dev/v1/currencies/${f}.json`,
];

async function fromEcb(from, to) {
  const r = await fetch(
    `https://api.frankfurter.app/latest?from=${from}&to=${to}`,
    { signal: AbortSignal.timeout(6000) }
  );
  if (!r.ok) throw new Error(`fx ${r.status}`);
  const rate = (await r.json()).rates?.[to];
  if (!rate) throw new Error("fx: no rate");
  return rate;
}

async function fromFallback(from, to) {
  const f = from.toLowerCase();
  const ask = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`fx fallback ${r.status}`);
    const rate = Number((await r.json())?.[f]?.[to.toLowerCase()]);
    if (rate > 0) return rate;
    throw new Error("fx fallback: no rate");
  };
  // Both hosts at once: one after the other, a host that hangs (an
  // egress rule that drops, rather than refuses) cost the spoken answer
  // two full timeouts on top of frankfurter's.
  try {
    return await Promise.any(FALLBACK.map((url) => ask(url(f))));
  } catch (e) {
    throw (e.errors && e.errors[e.errors.length - 1]) || e;
  }
}

/**
 * @throws an Error with code "NO_RATE" when no source has the pair, so
 *         the caller can say so plainly instead of passing on "fx 404".
 */
async function getRate(from, to) {
  const a = codeOf(from);
  const b = codeOf(to);
  const noRate = (why) =>
    Object.assign(new Error(`no live rate for ${a || from} to ${b || to} (${why})`), { code: "NO_RATE" });
  if (!a || !b) throw noRate("not a currency code");
  if (a === b) return 1;
  const key = `${a}:${b}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.rate;
  let rate;
  try {
    rate = await fromEcb(a, b);
  } catch (e) {
    try {
      rate = await fromFallback(a, b);
    } catch (e2) {
      throw noRate(`${e.message}; ${e2 && e2.message}`);
    }
  }
  cache.set(key, { ts: Date.now(), rate });
  return rate;
}

module.exports = { parseCurrencyAsk, getRate, codeOf };
