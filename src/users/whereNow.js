/**
 * WHERE THE OWNER IS NOW — one line every conversation starts with.
 *
 * A client in Bengaluru asked for "the Lalit … near the golf club" and was
 * given a hotel in Goa (2026-09-24): the search went out as "Lalit Hotel
 * near golf club" with only the neighbourhood, or nothing, to place it, and
 * the web's best match for "Lalit golf" is a resort in Goa. The phone sends
 * its coordinates with every request; this turns them into "Koramangala,
 * Bengaluru" once (cached by the rounded point), so the model knows the
 * city before it speaks and every local search carries it.
 *
 * Nothing here is shown to anyone but the model, and a failed lookup
 * simply leaves the line out.
 */
const TTL = 30 * 60_000;
const cache = new Map(); // "12.972,77.594" -> { at, where }

// Places people name as the city — used to tell "a different city" apart.
// Spellings the same city goes by are grouped.
const CITIES = [
  ["bengaluru", "bangalore"], ["mumbai", "bombay"], ["delhi", "new delhi"], ["chennai", "madras"],
  ["kolkata", "calcutta"], ["hyderabad", "secunderabad"], ["pune"], ["goa", "panaji", "panjim", "calangute", "candolim", "margao"],
  ["mangaluru", "mangalore"], ["mysuru", "mysore"], ["kochi", "cochin"], ["thiruvananthapuram", "trivandrum"],
  ["jaipur"], ["udaipur"], ["jodhpur"], ["agra"], ["gurugram", "gurgaon"], ["noida"], ["ahmedabad"], ["surat"],
  ["chandigarh"], ["lucknow"], ["varanasi"], ["bhubaneswar"], ["visakhapatnam", "vizag"], ["coimbatore"],
  ["madurai"], ["indore"], ["bhopal"], ["nagpur"], ["srinagar"], ["shimla"], ["manali"], ["rishikesh"],
  ["dehradun"], ["amritsar"], ["kovalam"], ["munnar"], ["ooty"], ["hubli", "hubballi"], ["belgaum", "belagavi"],
  ["udupi"], ["dubai"], ["singapore"], ["london"], ["new york"],
];

const norm = (s) => String(s || "").toLowerCase();

/** The group of names a city goes by, or [name] when it is not listed. */
function aliasesOf(city) {
  const c = norm(city).trim();
  if (!c) return [];
  return CITIES.find((g) => g.some((n) => c === n || c.includes(n))) || [c];
}

/**
 * Does [text] name a DIFFERENT city from [city] (and not [city] itself)?
 * "The LaLiT Golf & Spa Resort Goa" for an owner in Bengaluru -> true.
 */
function namesOtherCity(text, city) {
  const t = ` ${norm(text).replace(/[^a-z0-9]+/g, " ")} `;
  const mine = aliasesOf(city);
  if (!mine.length) return false;
  if (mine.some((n) => t.includes(` ${n} `))) return false;
  return CITIES.some((g) => g !== mine && !g.some((n) => mine.includes(n)) &&
    g.some((n) => t.includes(` ${n} `)));
}

/** Does [text] already name a place (a listed city)? */
function namesAPlace(text) {
  const t = ` ${norm(text).replace(/[^a-z0-9]+/g, " ")} `;
  return CITIES.some((g) => g.some((n) => t.includes(` ${n} `)));
}

/** "Koramangala, Bengaluru" — area and city, or whichever is known. */
function label(where) {
  if (!where) return "";
  const area = String(where.area || "").trim();
  const city = String(where.city || "").trim();
  if (area && city && norm(area) !== norm(city)) return `${area}, ${city}`;
  return city || area;
}

/**
 * Where the coordinates are, as { area, city, label }, or null.
 * @param geocode injectable for tests; defaults to the builtins' reverse geocoder
 */
async function whereNow(lat, lng, { geocode } = {}) {
  // Number(null) is 0 — a missing fix must not become the Gulf of Guinea.
  if (lat == null || lng == null || lat === "" || lng === "") return null;
  const la = Number(lat), ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || (la === 0 && ln === 0)) return null;
  const key = `${la.toFixed(3)},${ln.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.where;
  const look = geocode || require("../tools/builtins").reverseGeocode;
  let w = null;
  try { w = await look(la, ln); } catch (_) { w = null; }
  const where = w ? { area: w.area || "", city: w.city || "", label: label(w) } : null;
  cache.set(key, { at: Date.now(), where });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return where;
}

/** The system-prompt line, or "" when the place is unknown. */
async function whereLine(lat, lng, opts) {
  const w = await whereNow(lat, lng, opts);
  if (!w || !w.label) return "";
  return `WHERE THE OWNER IS NOW: ${w.label} (from their phone). Use it for anything "near me", local ` +
    `places and their addresses, weather, rides and local search — always search WITH this city ` +
    `(e.g. "<place> ${w.city || w.label} address") unless they name another place, and never ask ` +
    `which city they are in.`;
}

module.exports = { whereNow, whereLine, label, namesOtherCity, namesAPlace, aliasesOf };
