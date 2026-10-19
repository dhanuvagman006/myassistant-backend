/**
 * BORN TODAY (2026-10-19) — Home's birthday card, in the place the weather
 * card had. His spec: "today's birthday … a list of names of celebrities
 * whose birthday is today … focus on Indian celebrities".
 *
 * The names come from Wikidata, never from a model: living people with
 * Indian citizenship whose birth date (day precision) falls on today's
 * India date, ranked by how many Wikipedias have an article on them —
 * the best public measure of how well known someone is. Wikipedia's own
 * "on this day" list was tried first; it had four Indian names today, one
 * with the wrong year.
 *
 * Fetched once per India day for everyone, kept in memory and on the data
 * volume (DATA_DIR/birthdays/<YYYY-MM-DD>.json), so a restart does not
 * query again. A failed fetch serves an empty list and retries after
 * RETRY_MS; the card simply does not show.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(
  process.env.DATA_DIR || path.join(__dirname, "..", "..", "data"),
  "birthdays"
);
const ENDPOINT = "https://query.wikidata.org/sparql";
const UA = "HariAssistant/1.0 (https://api.hariassistant.tech; myassistant658@gmail.com)";
const LIMIT = 12;
const MIN_SITELINKS = 8;
const RETRY_MS = 10 * 60_000;
// Not for a family home screen.
const UNSUITABLE = /porn|adult (film|actress|actor|model)|erotic|criminal|gangster|terrorist/i;

/** YYYY-MM-DD in India. */
function indiaDate(now = new Date()) {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

function query(month, day) {
  return `SELECT ?p ?name ?desc ?born ?links (SAMPLE(?pic) AS ?img) WHERE {
  ?p wdt:P27 wd:Q668; wdt:P31 wd:Q5;
     p:P569/psv:P569 [ wikibase:timeValue ?born; wikibase:timePrecision 11 ] .
  FILTER(MONTH(?born) = ${month} && DAY(?born) = ${day} && YEAR(?born) > 1920)
  FILTER NOT EXISTS { ?p wdt:P570 ?died }
  ?p wikibase:sitelinks ?links . FILTER(?links >= ${MIN_SITELINKS})
  ?p rdfs:label ?name . FILTER(LANG(?name) = "en")
  OPTIONAL { ?p schema:description ?desc . FILTER(LANG(?desc) = "en") }
  OPTIONAL { ?p wdt:P18 ?pic }
} GROUP BY ?p ?name ?desc ?born ?links ORDER BY DESC(?links) LIMIT ${LIMIT * 2}`;
}

/** "Indian actor and politician (born 1957)" → "Actor and politician". */
function role(desc) {
  let d = String(desc || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  d = d.replace(/^Indian\s+/i, "");
  return d ? d[0].toUpperCase() + d.slice(1) : "";
}

/** A Commons file URL as a small thumbnail. */
function thumb(img) {
  if (!img) return null;
  const u = String(img).replace(/^http:/, "https:");
  return u.includes("Special:FilePath/") ? `${u}?width=240` : null;
}

async function fetchDay(date) {
  const [y, m, d] = date.split("-").map(Number);
  const url = `${ENDPOINT}?query=${encodeURIComponent(query(m, d))}`;
  const res = await fetch(url, {
    headers: { Accept: "application/sparql-results+json", "User-Agent": UA },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`wikidata ${res.status}`);
  const body = await res.json();
  // Someone with two recorded birth years comes back twice: keep the
  // first (best-ranked) row, and say no age rather than a wrong one.
  const byId = new Map();
  for (const b of body.results.bindings) {
    const name = b.name && b.name.value;
    const id = b.p.value.split("/").pop();
    const desc = (b.desc && b.desc.value) || "";
    if (!name || /^Q\d+$/.test(name) || UNSUITABLE.test(desc)) continue;
    const year = Number(String(b.born.value).slice(0, 4));
    const had = byId.get(id);
    if (had) {
      if (had.year !== year) had.age = null;
      continue;
    }
    byId.set(id, {
      id,
      name,
      role: role(desc),
      age: year ? y - year : null,
      photo: thumb(b.img && b.img.value),
      year,
    });
  }
  const people = [...byId.values()].slice(0, LIMIT).map(({ year, ...p }) => p);
  return { date, people };
}

const cache = new Map(); // date → { date, people }
let inflight = null;
let failedAt = 0;

function readSaved(date) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, `${date}.json`), "utf8"));
  } catch {
    return null;
  }
}

function save(day) {
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(path.join(ROOT, `${day.date}.json`), JSON.stringify(day));
    // Keep a week.
    for (const f of fs.readdirSync(ROOT).sort().slice(0, -7)) fs.unlinkSync(path.join(ROOT, f));
  } catch (e) {
    console.error("birthdays save:", e.message);
  }
}

/** Today's list: { date, people: [{ id, name, role, age, photo }] }. */
async function today(now = new Date()) {
  const date = indiaDate(now);
  if (cache.has(date)) return cache.get(date);
  const saved = readSaved(date);
  if (saved && Array.isArray(saved.people)) {
    cache.set(date, saved);
    return saved;
  }
  if (Date.now() - failedAt < RETRY_MS) return { date, people: [] };
  if (!inflight) {
    inflight = fetchDay(date)
      .then((day) => {
        cache.clear();
        cache.set(date, day);
        save(day);
        return day;
      })
      .catch((e) => {
        failedAt = Date.now();
        console.error("birthdays fetch:", e.message);
        return { date, people: [] };
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

module.exports = { today, indiaDate, role, _query: query, _fetchDay: fetchDay };
