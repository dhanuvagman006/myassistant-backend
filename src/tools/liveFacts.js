/**
 * LIVE FACTS — keyless answers for the questions a search engine was only
 * ever a middleman for.
 *
 * Web search on this deployment runs on Gemini's grounding, whose free
 * daily bucket is small; once it is spent EVERY question falls through to
 * Wikipedia, which cannot tell anyone the temperature. Measured on the
 * live key: every model returns 429, and the keyless engines are all
 * bot-blocked (DuckDuckGo serves an anomaly page, SearXNG a captcha).
 *
 * These two APIs need no key, no account and no card, and for their own
 * questions they are BETTER than a grounded search — a forecast from the
 * meteorological source beats a language model's summary of a web page.
 * So they run FIRST for those questions, not merely as a fallback, and
 * the search quota is left for the questions that actually need it.
 *
 * Deliberately narrow. Two things answered properly beats ten answered
 * approximately, and anything not covered here says so plainly instead of
 * guessing.
 */
const TIMEOUT = 9000;

/**
 * Indian cities are indexed under their current names, and the older ones
 * return either nothing or the wrong country entirely: "Bangalore" finds
 * NOTHING, and "Mangalore" finds a town in TASMANIA, population 421. A
 * user asking for the weather at home would have been given Australia's.
 */
const CITY_ALIASES = {
  bangalore: "Bengaluru",
  bengaluru: "Bengaluru",
  mangalore: "Mangaluru",
  mangaluru: "Mangaluru",
  bombay: "Mumbai",
  madras: "Chennai",
  calcutta: "Kolkata",
  mysore: "Mysuru",
  poona: "Pune",
  trivandrum: "Thiruvananthapuram",
  baroda: "Vadodara",
  cochin: "Kochi",
  pondicherry: "Puducherry",
  gurgaon: "Gurugram",
};

const WEATHER_RE =
  /\b(weather|forecast|temperature|how (hot|cold)|raining|rain|humidity|climate)\b/i;
const RATE_RE =
  /\b(exchange rate|conversion rate|currency|usd|dollar|euro|pound|dirham|riyal|yen)\b.*\b(rate|to|in|inr|rupee|rupees)\b|\b(rupee|inr)\b.*\b(dollar|usd|euro|pound)\b/i;

/** "weather in Mangalore tomorrow" → "Mangaluru" */
function placeFrom(q) {
  const m = /\b(?:in|at|for)\s+([A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*){0,2})/.exec(q) ||
    /\b(?:in|at|for)\s+([a-z][\w'’.-]*(?:\s+[a-z][\w'’.-]*){0,2})/i.exec(q);
  let place = m ? m[1].trim() : "";
  place = place.replace(/\b(today|tomorrow|now|tonight|this week|right now)\b/gi, "").trim();
  if (!place) return "";
  return CITY_ALIASES[place.toLowerCase()] || place;
}

async function geocode(place, { lat, lng } = {}) {
  const name = CITY_ALIASES[String(place).toLowerCase()] || place;
  const url =
    "https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&format=json&name=" +
    encodeURIComponent(name);
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`geocode ${r.status}`);
  const j = await r.json();
  const hits = j.results || [];
  if (!hits.length) return null;
  // Nearest to the user when we know where they are; otherwise the
  // biggest place by population, which is what a bare city name means.
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return hits.slice().sort((a, b) =>
      (a.latitude - lat) ** 2 + (a.longitude - lng) ** 2 -
      ((b.latitude - lat) ** 2 + (b.longitude - lng) ** 2))[0];
  }
  return hits.slice().sort((a, b) => (b.population || 0) - (a.population || 0))[0];
}

const WMO = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "foggy", 48: "freezing fog", 51: "light drizzle", 53: "drizzle",
  55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
  66: "freezing rain", 67: "heavy freezing rain", 71: "light snow",
  73: "snow", 75: "heavy snow", 80: "light showers", 81: "showers",
  82: "violent showers", 95: "thunderstorms", 96: "thunderstorms with hail",
  99: "severe thunderstorms with hail",
};

async function weather(q, ctx = {}) {
  const place = placeFrom(q);
  let spot = null;
  if (place) {
    spot = await geocode(place, ctx).catch(() => null);
    if (!spot) {
      return {
        ok: false,
        error: "place_not_found",
        data: { hint: `No such place as "${place}" was found. Ask which town they mean.` },
      };
    }
  } else if (Number.isFinite(ctx.lat) && Number.isFinite(ctx.lng)) {
    spot = { latitude: ctx.lat, longitude: ctx.lng, name: "your location" };
  } else {
    return {
      ok: false,
      error: "no_place",
      data: { hint: "Ask WHICH place. Do not guess, and do not use a remembered one." },
    };
  }

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${spot.latitude}&longitude=${spot.longitude}` +
    "&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m" +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code" +
    "&timezone=auto&forecast_days=3";
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`forecast ${r.status}`);
  const j = await r.json();
  const c = j.current || {};
  const d = j.daily || {};
  const where = spot.name + (spot.admin1 ? `, ${spot.admin1}` : "");
  const now =
    `${where}: ${Math.round(c.temperature_2m)}°C, ${WMO[c.weather_code] || "—"}, ` +
    `humidity ${c.relative_humidity_2m}%, wind ${Math.round(c.wind_speed_10m)} km/h`;
  const days = (d.time || []).slice(0, 3).map((t, i) =>
    `${t}: ${Math.round(d.temperature_2m_min[i])}–${Math.round(d.temperature_2m_max[i])}°C, ` +
    `${WMO[d.weather_code[i]] || "—"}, rain ${d.precipitation_probability_max[i]}%`
  );
  return {
    ok: true,
    provider: "open-meteo",
    data: { place: where, current: c, daily: d },
    speak: [now, ...days].join("\n"),
    note:
      "This is the real forecast from the meteorological service, not a web " +
      "page. Answer from it in one or two natural sentences — never read the " +
      "numbers out like a table.",
  };
}

const CURRENCIES = {
  dollar: "USD", dollars: "USD", usd: "USD", euro: "EUR", euros: "EUR",
  eur: "EUR", pound: "GBP", pounds: "GBP", gbp: "GBP", rupee: "INR",
  rupees: "INR", inr: "INR", dirham: "AED", aed: "AED", riyal: "SAR",
  sar: "SAR", yen: "JPY", jpy: "JPY", aud: "AUD", cad: "CAD", chf: "CHF",
  sgd: "SGD", myr: "MYR", cny: "CNY", yuan: "CNY",
};

async function rate(q) {
  const found = [];
  for (const w of String(q).toLowerCase().split(/[^a-z]+/)) {
    const code = CURRENCIES[w];
    if (code && !found.includes(code)) found.push(code);
  }
  // A bare "dollar rate" from an Indian user means dollar-to-rupee.
  const from = found[0];
  const to = found[1] || (from === "INR" ? "USD" : "INR");
  if (!from || from === to) {
    return { ok: false, error: "no_currency", data: { hint: "Ask which two currencies." } };
  }
  const r = await fetch(
    `https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`,
    { signal: AbortSignal.timeout(TIMEOUT) }
  );
  if (!r.ok) throw new Error(`rates ${r.status}`);
  const j = await r.json();
  const v = j.rates && j.rates[to];
  if (!v) throw new Error("no rate returned");
  return {
    ok: true,
    provider: "frankfurter",
    data: { from, to, rate: v, date: j.date },
    speak: `1 ${from} = ${v} ${to} (reference rate, ${j.date})`,
    note:
      "This is the daily reference rate from the European Central Bank. It " +
      "is not a bank's buy/sell rate, so say 'around' rather than quoting it " +
      "as what they would be charged.",
  };
}

/** Which specialist, if any, owns this question. */
function handlerFor(q) {
  const s = String(q || "");
  if (WEATHER_RE.test(s)) return weather;
  if (RATE_RE.test(s)) return rate;
  return null;
}

/** @returns a result envelope, or null when no specialist applies. */
async function tryLiveFact(q, ctx = {}) {
  const h = handlerFor(q);
  if (!h) return null;
  try {
    return await h(q, ctx);
  } catch (e) {
    console.warn("liveFacts:", e.message);
    return null; // fall through to the normal search chain
  }
}

module.exports = { tryLiveFact, handlerFor, placeFrom, geocode, CITY_ALIASES };
