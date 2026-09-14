/**
 * NEARBY PLACES (C3) — restaurants, shops, services with ratings,
 * distance, price level, open-now and photos.
 *
 *   1. Google Places API (New) when GOOGLE_PLACES_API_KEY is set —
 *      full data: ratings, price, hours, phone, photos.
 *   2. OpenStreetMap Nominatim fallback (free, no key) — names,
 *      addresses and distances only, so the feature never dies.
 *
 * 5-minute cache per (query, ~250 m grid cell): repeated "restaurants
 * near me" from the same block is free and instant.
 */
const TIMEOUT = 8000;
const cache = new Map();
const TTL = 5 * 60 * 1000;

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, d = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * d) / 2) ** 2 +
    Math.cos(lat1 * d) * Math.cos(lat2 * d) *
      Math.sin(((lng2 - lng1) * d) / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const PRICE = { PRICE_LEVEL_INEXPENSIVE: "₹", PRICE_LEVEL_MODERATE: "₹₹",
  PRICE_LEVEL_EXPENSIVE: "₹₹₹", PRICE_LEVEL_VERY_EXPENSIVE: "₹₹₹₹" };

async function googlePlaces(q, lat, lng, near) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return null;
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT),
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": key,
      "x-goog-fieldmask":
        "places.displayName,places.rating,places.userRatingCount," +
        "places.priceLevel,places.currentOpeningHours.openNow," +
        "places.formattedAddress,places.location," +
        "places.nationalPhoneNumber,places.photos",
    },
    body: JSON.stringify({
      textQuery: near ? `${q} near ${near}` : q,
      maxResultCount: 10,
      // BIAS TO WHERE THEY ARE ONLY WHEN THEY DID NOT SAY WHERE.
      //
      // A 5 km circle around the user was applied to EVERY search, so
      // "wine shop near the KSRTC bus stand in Bejai, Mangalore" was
      // looked for within 5 km of a phone in another city and answered
      // "I'm not finding any" — three times in one session, for places
      // that plainly exist. When the request names a locality, the text
      // query is the location and a bias somewhere else only fights it.
      ...(!near && Number.isFinite(lat) && Number.isFinite(lng)
        ? { locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 5000 } } }
        : {}),
    }),
  });
  if (!r.ok) {
    // A 403 here is almost always "Places API (New) has not been used in
    // this project before or it is disabled" — a console setting, not a
    // transient failure. Swallowed into the OSM fallback it looked like
    // patchy local coverage for months: no ratings on anything, "best
    // fish restaurants in Mangalore" returning nothing while bare
    // "restaurants" returned ten. Say it loudly enough to be found.
    let detail = "";
    try {
      const body = await r.json();
      detail = (body && body.error && body.error.message) || "";
    } catch (_) {}
    if (r.status === 403 || r.status === 401) {
      console.error(
        `PLACES API NOT USABLE (${r.status}) — falling back to OpenStreetMap, ` +
        `which has no ratings and much weaker coverage. ${detail.slice(0, 200)}`
      );
    }
    throw new Error(`places ${r.status}${detail ? ": " + detail.slice(0, 120) : ""}`);
  }
  const data = await r.json();
  return (data.places || []).map((p) => ({
    name: p.displayName?.text || "",
    rating: p.rating || null,
    ratingCount: p.userRatingCount || null,
    price: PRICE[p.priceLevel] || null,
    openNow: p.currentOpeningHours?.openNow ?? null,
    address: p.formattedAddress || "",
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    phone: p.nationalPhoneNumber || null,
    photoRef: p.photos?.[0]?.name || null,
  }));
}

async function osmPlaces(q, lat, lng, near = "") {
  // WHEN THEY NAMED A PLACE, SEARCH THAT PLACE. The fallback only ever
  // searched a 10 km box around the user, so "in Mangalore" was dropped
  // on the floor — fine while the user happened to be there, wrong the
  // moment they asked about anywhere else.
  const where = String(near || "").trim();
  const query = where ? `${q} ${where}` : q;
  const box = !where && Number.isFinite(lat) && Number.isFinite(lng)
    ? `&viewbox=${lng - 0.05},${lat + 0.05},${lng + 0.05},${lat - 0.05}&bounded=1`
    : "";
  const r = await fetch(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=10&q=${encodeURIComponent(query)}${box}`,
    {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { "user-agent": "MyAssistant/1.0" }, // Nominatim requires one
    }
  );
  if (!r.ok) throw new Error(`nominatim ${r.status}`);
  const data = await r.json();
  return data.map((p) => ({
    name: p.name || p.display_name.split(",")[0],
    rating: null, ratingCount: null, price: null, openNow: null,
    address: p.display_name,
    lat: parseFloat(p.lat), lng: parseFloat(p.lon),
    phone: null, photoRef: null,
  }));
}

async function searchPlaces({ q, lat, lng, near = "" }) {
  const where = String(near || "").trim();
  const key = `${q.toLowerCase()}|${where.toLowerCase()}:${(lat || 0).toFixed(3)}:${(lng || 0).toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;

  let list;
  try {
    list = (await googlePlaces(q, lat, lng, where)) ?? (await osmPlaces(q, lat, lng, where));
  } catch (_) {
    list = await osmPlaces(q, lat, lng, where); // Google down → OSM still answers
  }
  // Distances are only meaningful relative to the user. When they asked
  // about somewhere else, "2.3 km" would be measured from the wrong point
  // and read as a lie, so it is left off.
  if (!where && Number.isFinite(lat) && Number.isFinite(lng)) {
    for (const p of list) {
      p.distanceKm = Number.isFinite(p.lat)
        ? Math.round(haversineKm(lat, lng, p.lat, p.lng) * 10) / 10
        : null;
    }
    list.sort((a, b) => (a.distanceKm ?? 99) - (b.distanceKm ?? 99));
  }
  cache.set(key, { ts: Date.now(), data: list });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return list;
}

/** Compact one-liner list for the chat tool block (spoken answers). */
function describePlaces(list) {
  if (!list?.length) return "";
  return list.slice(0, 5).map((p) =>
    [
      p.name,
      p.rating ? `${p.rating}★ (${p.ratingCount})` : null,
      p.distanceKm != null ? `${p.distanceKm} km` : null,
      p.price,
      p.openNow === true ? "open now" : p.openNow === false ? "closed" : null,
    ].filter(Boolean).join(", ")
  ).join("\n");
}

module.exports = { searchPlaces, describePlaces };
