/**
 * FLIGHT SEARCH — provider adapter (§20).
 *
 * §32: no fabricated availability, ever. With no provider configured this
 * returns an honest "not configured" that the agent relays; it never
 * invents a flight number, time or price.
 *
 * Providers (first configured wins):
 *   AMADEUS_CLIENT_ID + AMADEUS_CLIENT_SECRET   (self-service API)
 *   DUFFEL_API_TOKEN                            (Duffel)
 */
const TIMEOUT_MS = 12_000;

/**
 * Amadeus runs two entirely separate environments with different hosts AND
 * different credentials. This was pinned to the test host, so a production
 * key would have authenticated against the sandbox and returned sandbox
 * inventory — plausible-looking flights that cannot be booked.
 * Set AMADEUS_ENV=production once you have live credentials.
 */
function amadeusHost() {
  return String(process.env.AMADEUS_ENV || "test").toLowerCase() === "production"
    ? "https://api.amadeus.com"
    : "https://test.api.amadeus.com";
}

function provider() {
  if (process.env.AMADEUS_CLIENT_ID && process.env.AMADEUS_CLIENT_SECRET) return "amadeus";
  if (process.env.DUFFEL_API_TOKEN) return "duffel";
  return null;
}

/** IATA code if given one, else null — we do not guess airports. */
function iata(s) {
  const v = String(s || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(v) ? v : null;
}

// Only well-known unambiguous city→primary-airport mappings. Anything else
// is asked about rather than assumed, so we never search the wrong city.
const CITY_IATA = {
  BANGALORE: "BLR", BENGALURU: "BLR", DELHI: "DEL", "NEW DELHI": "DEL",
  MUMBAI: "BOM", BOMBAY: "BOM", CHENNAI: "MAA", KOLKATA: "CCU",
  HYDERABAD: "HYD", MANGALORE: "IXE", MANGALURU: "IXE", GOA: "GOI",
  PUNE: "PNQ", KOCHI: "COK", COCHIN: "COK", AHMEDABAD: "AMD",
  JAIPUR: "JAI", LUCKNOW: "LKO", TRIVANDRUM: "TRV", COIMBATORE: "CJB",
};

function resolveAirport(input) {
  const direct = iata(input);
  if (direct) return direct;
  const key = String(input || "").trim().toUpperCase();
  return CITY_IATA[key] || null;
}

let amadeusToken = { value: null, expires: 0 };

async function amadeusAuth() {
  if (amadeusToken.value && Date.now() < amadeusToken.expires) return amadeusToken.value;
  const r = await fetch(`${amadeusHost()}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.AMADEUS_CLIENT_ID,
      client_secret: process.env.AMADEUS_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`amadeus auth ${r.status}`);
  const j = await r.json();
  amadeusToken = {
    value: j.access_token,
    expires: Date.now() + (j.expires_in - 60) * 1000,
  };
  return amadeusToken.value;
}

const BACKENDS = {
  async amadeus({ from, to, date, adults }) {
    const token = await amadeusAuth();
    const u = new URL(`${amadeusHost()}/v2/shopping/flight-offers`);
    u.searchParams.set("originLocationCode", from);
    u.searchParams.set("destinationLocationCode", to);
    u.searchParams.set("departureDate", date);
    u.searchParams.set("adults", String(adults || 1));
    u.searchParams.set("max", "6");
    u.searchParams.set("currencyCode", "INR");
    const r = await fetch(u, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`amadeus ${r.status}`);
    const j = await r.json();
    return (j.data || []).map((o) => {
      const seg = o.itineraries[0].segments;
      return {
        carrier: seg[0].carrierCode,
        flight: `${seg[0].carrierCode}${seg[0].number}`,
        departure: seg[0].departure.at,
        arrival: seg[seg.length - 1].arrival.at,
        stops: seg.length - 1,
        price: `${o.price.currency} ${o.price.total}`,
      };
    });
  },

  async duffel({ from, to, date, adults }) {
    const r = await fetch("https://api.duffel.com/air/offer_requests?return_offers=true", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Duffel-Version": "v2",
        authorization: `Bearer ${process.env.DUFFEL_API_TOKEN}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        data: {
          slices: [{ origin: from, destination: to, departure_date: date }],
          passengers: Array.from({ length: adults || 1 }, () => ({ type: "adult" })),
          cabin_class: "economy",
        },
      }),
    });
    if (!r.ok) throw new Error(`duffel ${r.status}`);
    const j = await r.json();
    return (j.data?.offers || []).slice(0, 6).map((o) => {
      const seg = o.slices[0].segments;
      return {
        carrier: o.owner?.name || seg[0].operating_carrier?.iata_code,
        flight: `${seg[0].operating_carrier?.iata_code}${seg[0].operating_carrier_flight_number}`,
        departure: seg[0].departing_at,
        arrival: seg[seg.length - 1].arriving_at,
        stops: seg.length - 1,
        price: `${o.total_currency} ${o.total_amount}`,
      };
    });
  },
};

/**
 * @returns {ok:true,data} | {ok:false,error} | {ok:false,needsArgs:[…]}
 */
async function search({ from, to, date, adults = 1 }) {
  const p = provider();
  if (!p) {
    // No airline API key. That is NOT a dead end, and it must not be
    // reported to the user as a technical failure — they asked a question
    // that a search can answer perfectly well. The message is addressed to
    // the MODEL, telling it what to do next, because "I'm unable to check
    // due to a technical issue" is the worst possible reply to "what are
    // the flight timings?".
    return {
      ok: false,
      error:
        "no airline booking API is configured, so I have no live fare data. " +
        "DO NOT tell the user this failed or mention a technical issue. " +
        "Instead, look the flight schedule up with Google Search (or " +
        "web_search) and answer from that, making clear the times are " +
        "indicative and should be confirmed on the airline's site.",
    };
  }
  const o = resolveAirport(from);
  const d = resolveAirport(to);
  // Ask rather than guess which airport was meant (§20).
  const missing = [];
  if (!o) missing.push("origin airport (a city I know or a 3-letter code)");
  if (!d) missing.push("destination airport (a city I know or a 3-letter code)");
  if (missing.length) return { ok: false, needsArgs: missing };

  // DATE. An ISO date is used as given. Anything else is parsed properly:
  // this used to fall through to "tomorrow" for any unrecognised string, so
  // "next Friday" quietly returned tomorrow's flights and the user would
  // only find out at the airport. An unparseable date is now a question.
  let day;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
    day = date;
  } else if (date) {
    let parsed = null;
    try {
      parsed = require("chrono-node").parseDate(String(date), new Date(), { forwardDate: true });
    } catch (_) {}
    if (!parsed) {
      return { ok: false, needsArgs: [`a clearer travel date (I couldn't read "${date}")`] };
    }
    day = parsed.toISOString().slice(0, 10);
  } else {
    day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  }

  try {
    const flights = await BACKENDS[p]({ from: o, to: d, date: day, adults });
    if (!flights.length) {
      return { ok: false, error: `no flights found for ${o}→${d} on ${day}` };
    }
    return {
      ok: true,
      data: flights,
      speak: flights
        .slice(0, 3)
        .map(
          (f) =>
            `${f.flight} departs ${String(f.departure).slice(11, 16)}, ` +
            `${f.stops === 0 ? "non-stop" : `${f.stops} stop`}, ${f.price}`
        )
        .join("; "),
    };
  } catch (e) {
    return { ok: false, error: `flight search failed: ${String(e.message).slice(0, 160)}` };
  }
}

module.exports = { search, provider, resolveAirport, CITY_IATA, amadeusHost };
