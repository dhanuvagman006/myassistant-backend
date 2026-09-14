/**
 * PLACES — now answered by WEB SEARCH, not by the Google Places API.
 *
 * The Places API (New) was disabled on the project and every searchText
 * call returned 403. That failure was caught and swallowed into an
 * OpenStreetMap fallback, so for months local questions were quietly
 * served by OSM tag matching: nothing ever had a rating, "best fish
 * restaurants in Mangalore" returned nothing at all, and bare
 * "restaurants" returned ten. The neighbourhood was fine; the integration
 * was not.
 *
 * Owner's decision (2026-09-14): drop it and use the web. Measured on the
 * same question, search returns the Tripadvisor and EazyDiner roundups
 * with actual names — Shetty Lunch Home, Janatha Lunch Home, Karavali —
 * which is what somebody asking for the "best" ones wanted in the first
 * place, and what Places could not express.
 *
 * This module stays only as a shim for the callers that already existed.
 * Nothing here returns coordinates, ratings or distances any more, because
 * a web result does not carry them — and inventing them is exactly the
 * kind of confident wrongness this codebase keeps removing.
 */
const webSearch = require("../../tools/webSearch");

/**
 * @returns rows shaped like the old ones, minus every field a web page
 *          cannot honestly supply (rating, distance, price, openNow, lat/lng).
 */
async function searchPlaces({ q, lat, lng, near = "" }) {
  const where = String(near || "").trim();
  const query = where ? `${q} in ${where}` : q;
  const out = await webSearch.run(query, { lat, lng }).catch(() => null);
  if (!out || !out.ok || !Array.isArray(out.data)) return [];
  return out.data
    .filter((r) => r && (r.title || r.snippet))
    .slice(0, 8)
    .map((r) => ({
      name: r.title || "",
      address: "",
      snippet: r.snippet || "",
      url: r.url || "",
      rating: null,
      ratingCount: null,
      price: null,
      openNow: null,
      distanceKm: null,
      lat: undefined,
      lng: undefined,
      phone: null,
      photoRef: null,
    }));
}

/** A short digest for the model. No ratings or distances — see above. */
function describePlaces(list) {
  if (!list || !list.length) return "";
  return list
    .slice(0, 5)
    .map((p) => [p.name, p.snippet].filter(Boolean).join(" — "))
    .join("\n");
}

module.exports = { searchPlaces, describePlaces };
