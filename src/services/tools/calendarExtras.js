/**
 * CALENDAR EXTRAS (2026-09-30) — the "more than a calendar" layer for the
 * app's Calendar screen: Indian national and Kerala holidays, festivals,
 * international days and a few dated global events.
 *
 *   extras({ from, to, region }) → { region, from, to, items: [
 *     { date, end?, kind: 'holiday'|'festival'|'world_day'|'event',
 *       title, scope, tentative, bank?, note, source } ] }
 *
 * The curated files in src/services/tools/calendar-data are the source of truth and work
 * on their own. Google's public "Holidays in India" calendar (no auth) is a
 * supplement for minor festivals the files do not list: fetched at most
 * once a day, 4 s timeout, the last good copy kept when a fetch fails, and
 * a failure never reaches the caller.
 */
const india = require("./calendar-data/india.json");
const world = require("./calendar-data/world.json");

const ICS_URL =
  "https://calendar.google.com/calendar/ical/en.indian%23holiday%40group.v.calendar.google.com/public/basic.ics";
const ICS_TTL = 24 * 3600_000;
const ICS_RETRY = 30 * 60_000; // after a failure, wait before trying again
const ICS_TIMEOUT = 4000;
const MAX_DAYS = 93;
const REGIONS = new Set(["IN", "IN-KL"]);

// ── dates (all plain calendar dates, handled in UTC) ──────────────────
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
function validIso(s) {
  if (typeof s !== "string" || !ISO.test(s)) return false;
  const d = toDate(s);
  return !Number.isNaN(d.getTime()) && iso(d) === s;
}
const addDays = (s, n) => iso(new Date(toDate(s).getTime() + n * 86400_000));
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400_000);

/**
 * Parses the query into a window: from/to (YYYY-MM-DD) or y&m (a month).
 * Returns { from, to } or { error }.
 */
function parseRange(q = {}) {
  if (q.from || q.to) {
    const from = String(q.from || "");
    const to = String(q.to || q.from || "");
    if (!validIso(from) || !validIso(to)) return { error: "from/to must be YYYY-MM-DD" };
    if (to < from) return { error: "to is before from" };
    if (daysBetween(from, to) + 1 > MAX_DAYS) return { error: `at most ${MAX_DAYS} days` };
    return { from, to };
  }
  const now = new Date();
  const y = q.y !== undefined ? Number(q.y) : now.getUTCFullYear();
  const m = q.m !== undefined ? Number(q.m) : now.getUTCMonth() + 1;
  if (!Number.isInteger(y) || y < 1970 || y > 2100 || !Number.isInteger(m) || m < 1 || m > 12) {
    return { error: "y/m out of range" };
  }
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const to = iso(new Date(Date.UTC(y, m, 0)));
  return { from, to };
}

/** Kerala, roughly: the state's bounding box. */
function regionFromGeo(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return lat >= 8.1 && lat <= 12.85 && lng >= 74.8 && lng <= 77.45 ? "IN-KL" : "IN";
}

/**
 * query ?region= → the phone's X-Geo headers → IN-KL (the app's users are
 * in Kerala today; the profile keeps location only as free text).
 */
function resolveRegion(req) {
  const raw = String(req.query?.region || "").toUpperCase().replace("_", "-");
  if (raw === "KL") return "IN-KL";
  if (REGIONS.has(raw)) return raw;
  const lat = parseFloat(req.query?.lat ?? req.get?.("X-Geo-Lat"));
  const lng = parseFloat(req.query?.lng ?? req.get?.("X-Geo-Lng"));
  return regionFromGeo(lat, lng) || "IN-KL";
}

// ── curated rows ──────────────────────────────────────────────────────
function curatedIndia(from, to, region) {
  const out = [];
  for (const r of india.items) {
    if (r.date < from && (r.end || r.date) < from) continue;
    if (r.date > to) continue;
    if (r.scope !== "national" && r.scope !== region) continue;
    if ((r.except || []).includes(region)) continue;
    let kind = r.kind;
    let note = r.note || null;
    if ((r.holidayIn || []).includes(region)) kind = "holiday";
    if (kind === "holiday" && (r.workdayIn || []).includes(region)) {
      kind = "festival";
      note = "Central government holiday; a working day in Kerala";
    }
    out.push({
      date: r.date,
      ...(r.end ? { end: r.end } : {}),
      kind,
      title: r.title,
      scope: r.scope,
      tentative: !!r.tentative,
      bank: region === "IN-KL" && !!r.bank && kind !== "festival",
      note,
      source: "curated",
    });
  }
  return out;
}

function eachYear(from, to) {
  const ys = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) ys.push(y);
  return ys;
}

function recurring(from, to, rows, defaults) {
  const out = [];
  for (const y of eachYear(from, to)) {
    for (const r of rows) {
      const date = `${y}-${r.md}`;
      if (!validIso(date) || date < from || date > to) continue;
      out.push({
        date,
        kind: r.kind || defaults.kind,
        title: r.title,
        scope: r.scope || defaults.scope,
        tentative: !!r.tentative,
        bank: false,
        note: r.note || null,
        source: "curated",
      });
    }
  }
  return out;
}

/** The nth weekday (1=Mon..7=Sun) of a month, as YYYY-MM-DD. */
function nthWeekday(y, month, nth, weekday) {
  const first = new Date(Date.UTC(y, month - 1, 1));
  const dow = first.getUTCDay() || 7;
  const day = 1 + ((weekday - dow + 7) % 7) + (nth - 1) * 7;
  return iso(new Date(Date.UTC(y, month - 1, day)));
}

function worldRows(from, to) {
  const out = recurring(from, to, world.recurring, { kind: "world_day", scope: "world" });
  for (const y of eachYear(from, to)) {
    for (const r of world.nth || []) {
      const date = nthWeekday(y, r.month, r.nth, r.weekday);
      if (date < from || date > to) continue;
      out.push({ date, kind: "world_day", title: r.title, scope: "world", tentative: false, bank: false, note: null, source: "curated" });
    }
  }
  for (const e of world.events || []) {
    // A multi-day event shows while any of it overlaps the window.
    if ((e.end || e.date) < from || e.date > to) continue;
    out.push({
      date: e.date,
      ...(e.end ? { end: e.end } : {}),
      kind: "event",
      title: e.title,
      scope: "world",
      tentative: !!e.tentative,
      bank: false,
      note: e.note || null,
      source: "curated",
    });
  }
  return out;
}

// ── Google's public India holiday calendar (optional) ─────────────────
const ics = { events: null, fetchedAt: 0, failedAt: 0, inflight: null };

/** Minimal ICS reader: all-day VEVENTs → [{ date, title, observance }]. */
function parseIcs(text) {
  const lines = String(text || "").replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") {
      if (cur && cur.date && cur.title) out.push(cur);
      cur = null;
    } else if (cur) {
      const m = line.match(/^DTSTART[^:]*:(\d{4})(\d{2})(\d{2})/);
      if (m) cur.date = `${m[1]}-${m[2]}-${m[3]}`;
      else if (line.startsWith("SUMMARY:")) cur.title = line.slice(8).replace(/\\,/g, ",").trim();
      else if (line.startsWith("DESCRIPTION:")) cur.observance = /^DESCRIPTION:Observance/.test(line);
    }
  }
  return out;
}

async function loadIcs({ fetchImpl = global.fetch, now = Date.now() } = {}) {
  const fresh = ics.events && now - ics.fetchedAt < ICS_TTL;
  const resting = now - ics.failedAt < ICS_RETRY;
  if (fresh || resting || typeof fetchImpl !== "function") return ics.events;
  if (!ics.inflight) {
    ics.inflight = (async () => {
      try {
        const r = await fetchImpl(ICS_URL, { signal: AbortSignal.timeout(ICS_TIMEOUT) });
        if (!r || !r.ok) throw new Error(`ics ${r && r.status}`);
        const events = parseIcs(await r.text());
        if (!events.length) throw new Error("ics empty");
        ics.events = events;
        ics.fetchedAt = now;
      } catch (_) {
        ics.failedAt = now; // keep the stale copy, if any
      } finally {
        ics.inflight = null;
      }
    })();
  }
  await ics.inflight;
  return ics.events;
}

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !["jayanti", "jayanthi", "tentative", "first", "festival"].includes(w));

/** Google observances the curated rows do not already cover (same day or a close title within 3 days). */
function icsRows(events, from, to, have) {
  const out = [];
  for (const e of events || []) {
    if (e.date < from || e.date > to) continue;
    // Public holidays are the curated files' job; only observances add.
    if (!e.observance) continue;
    if (/new year|christmas eve/i.test(e.title)) continue;
    const words = norm(e.title);
    const dup = have.some((h) => {
      const hw = norm(h.title);
      // "Onam" vs "Thiruvonam", "Maha Navami" vs "Mahanavami".
      const shared = words.some((w) => hw.some((x) => x.includes(w) || w.includes(x)));
      return shared && Math.abs(daysBetween(h.date, e.date)) <= 3;
    });
    if (dup) continue;
    out.push({ date: e.date, kind: "festival", title: e.title, scope: "national", tentative: /tentative/i.test(e.title), bank: false, note: null, source: "google" });
  }
  return out;
}

// ── the answer ────────────────────────────────────────────────────────
const cache = new Map(); // "from|to|region|icsStamp" → items
const ORDER = { holiday: 0, festival: 1, event: 2, world_day: 3 };

async function extras({ from, to, region = "IN-KL", useIcs = true, fetchImpl } = {}) {
  if (!REGIONS.has(region)) region = "IN-KL";
  let events = null;
  if (useIcs) {
    try {
      events = await loadIcs({ fetchImpl });
    } catch (_) {
      events = null;
    }
  }
  const key = `${from}|${to}|${region}|${events ? ics.fetchedAt : 0}`;
  const hit = cache.get(key);
  if (hit) return { region, from, to, items: hit };

  const base = [
    ...curatedIndia(from, to, region),
    ...recurring(from, to, india.recurring || [], { kind: "event", scope: "national" }),
    ...worldRows(from, to),
  ];
  const items = [...base, ...icsRows(events, from, to, base)].sort(
    (a, b) => a.date.localeCompare(b.date) || ORDER[a.kind] - ORDER[b.kind] || a.title.localeCompare(b.title)
  );
  if (cache.size > 200) cache.clear();
  cache.set(key, items);
  return { region, from, to, items };
}

/** Express handler for GET /tools/calendar/extras. Never a 5xx for an outside source. */
async function handler(req, res) {
  const range = parseRange(req.query || {});
  if (range.error) return res.status(400).json({ error: range.error });
  const region = resolveRegion(req);
  try {
    res.set("Cache-Control", "private, max-age=3600");
    res.json(await extras({ ...range, region }));
  } catch (_) {
    // Curated only, no outside source: this cannot fail on the network.
    res.json(await extras({ ...range, region, useIcs: false }));
  }
}

module.exports = {
  extras,
  handler,
  parseRange,
  resolveRegion,
  regionFromGeo,
  nthWeekday,
  parseIcs,
  _ics: ics,
  _cache: cache,
  MAX_DAYS,
};
