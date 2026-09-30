/**
 * GET /brief — the home dashboard's single aggregate fetch.
 * Query: lat, lng (optional, for the weather chip); without them the
 * X-Geo-Lat / X-Geo-Lng headers every app request carries.
 * Header: X-TZ-Offset (minutes east of UTC; defaults to IST 330).
 */
const router = require("express").Router();
const { tzFromReq } = require("../services/tz");
const { buildBrief } = require("../services/brief");

router.get("/", async (req, res) => {
  const uid = Number(req.user?.sub);
  if (!Number.isInteger(uid) || uid <= 0) {
    // Dev/appKey sessions have no user row — an EMPTY brief, not an error,
    // so the home screen renders its calm state instead of a banner.
    return res.json({
      name: null, weather_line: null, weather_note: null, agenda: [], tomorrow: [], dates: [],
      promises: [], messages: [], people: [], people_count: 0, headlines: [],
    });
  }
  // WHERE THE PHONE IS (2026-09-29). The app never put lat/lng in the
  // query — it sends its last fix as headers on every request — so the
  // weather chip only appeared for a profile with a city typed in.
  let lat = parseFloat(req.query.lat);
  let lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    lat = parseFloat(req.get("X-Geo-Lat"));
    lng = parseFloat(req.get("X-Geo-Lng"));
  }
  try {
    const brief = await buildBrief(uid, { lat, lng, tzOffsetMin: tzFromReq(req) });
    res.json(brief);
  } catch (e) {
    console.error("brief failed:", e.message);
    res.status(500).json({ error: "brief failed" });
  }
});

/**
 * GET|POST /brief/script — "Play my morning" (2026-09-30): the brief as a
 * 45–75 second spoken script (services/briefScript.js). POST may carry
 * the phone's missed calls, which the server never sees otherwise:
 *   { missedCalls: [{ name, count }] }
 * → { part, title, greeting, script, sentences[], seconds,
 *     offer: { kind, say, label, request, meetingId? }, source, empty }
 * Same location headers and X-TZ-Offset as GET /brief.
 */
async function script(req, res) {
  const uid = Number(req.user?.sub);
  const briefScript = require("../services/briefScript");
  const tzOffsetMin = tzFromReq(req);
  const missedCalls = briefScript.missedFromBody(req.body);
  if (!Number.isInteger(uid) || uid <= 0) {
    // Dev/appKey sessions: the calm, empty day — never an error.
    const empty = { agenda: [], tomorrow: [], dates: [], promises: [], messages: [] };
    return res.json(await briefScript.scriptFor(0, empty, { tzOffsetMin, missedCalls }));
  }
  let lat = parseFloat(req.query.lat);
  let lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    lat = parseFloat(req.get("X-Geo-Lat"));
    lng = parseFloat(req.get("X-Geo-Lng"));
  }
  try {
    const brief = await buildBrief(uid, { lat, lng, tzOffsetMin });
    res.json(await briefScript.scriptFor(uid, brief, { tzOffsetMin, missedCalls }));
  } catch (e) {
    console.error("brief script failed:", e.message);
    res.status(500).json({ error: "brief script failed" });
  }
}
router.get("/script", script);
router.post("/script", script);

/**
 * GET /brief/calendar?y=2026&m=9 — one month of commitments for the home
 * calendar: reminders, promises, recurring finance due-days, and Google
 * Calendar meetings when linked. Day-keyed so the client just paints.
 * Every source is optional; a failed one drops out silently.
 */
router.get("/calendar", async (req, res) => {
  const uid = Number(req.user?.sub);
  const now = new Date();
  const y = Number(req.query.y) || now.getFullYear();
  const m = Number(req.query.m) || now.getMonth() + 1; // 1-12
  if (!Number.isInteger(uid) || uid <= 0) {
    return res.json({ year: y, month: m, days: {} });
  }
  const tz = tzFromReq(req);

  const days = {}; // "17" -> [{kind, title, id?, del?}]
  // [del] names the REST collection a DELETE /:id goes to, so the app can
  // remove items straight from the calendar popup. Google meetings carry
  // no del — they belong to Google Calendar, not us.
  const add = (day, kind, title, extra = {}) => {
    if (!Number.isInteger(day) || day < 1 || day > 31) return;
    (days[day] ||= []).push({
      kind,
      title: String(title || "").slice(0, 90),
      ...extra,
    });
  };
  /// Day-of-month in the user's timezone, or null if outside this month.
  const dayOf = (ms) => {
    const d = new Date(ms + tz * 60_000);
    return d.getUTCFullYear() === y && d.getUTCMonth() + 1 === m
      ? d.getUTCDate()
      : null;
  };

  try {
    const rows = await require("../reminders/store").list(uid);
    for (const r of rows) {
      if (r.done) continue;
      const due = Number(r.due_at);
      const d = Number.isFinite(due) && due > 0 ? dayOf(due) : null;
      if (d) add(d, "reminder", r.text, { id: r.id, del: "reminders", at: due });
    }
  } catch (_) {}

  try {
    const rows = await require("../commitments/service").list(uid, {
      status: "open",
      limit: 100,
    });
    for (const c of rows) {
      const due = Number(c.due_at);
      const d = Number.isFinite(due) && due > 0 ? dayOf(due) : null;
      if (d) {
        add(d, "promise", (c.owed_to ? `To ${c.owed_to}: ` : "") + c.text, {
          id: c.id,
          del: "commitments",
          at: due,
        });
      }
    }
  } catch (_) {}

  // EMIs and incomes recur monthly on their due_day.
  try {
    const items = await require("./finance").listItems(uid);
    for (const it of items) {
      const dd = Number(it.due_day);
      if (!Number.isInteger(dd) || dd < 1 || dd > 31) continue;
      const label =
        it.name + (Number.isFinite(it.amount) ? ` · ₹${Math.round(it.amount)}` : "");
      add(dd, it.kind === "income" ? "income" : "payment", label, {
        id: it.id,
        del: "finance",
      });
    }
  } catch (_) {}

  // Saved birthdays/anniversaries ("Allen's birthday is 26 May") land on
  // their day every year — the visible proof the date was saved, which a
  // push-only nudge never gave.
  try {
    const rows = await require("../db").query(
      `SELECT pd.day, pd.label, c.name
         FROM person_dates pd JOIN clients c ON c.id = pd.person_id
        WHERE pd.user_id = $1 AND pd.month = $2`,
      [uid, m]
    );
    for (const r of rows) {
      add(Number(r.day), "birthday", `🎂 ${r.name}'s ${r.label}`);
    }
  } catch (_) {}

  // Google Calendar meetings, when the account is linked.
  try {
    const events = await require("../google/api").upcomingEvents(uid, {
      days: 45,
      max: 50,
    });
    for (const e of events || []) {
      const at = Date.parse(e.start);
      const d = Number.isFinite(at) ? dayOf(at) : null;
      // [at] (epoch ms) lets the Calendar screen show the time; all-day
      // events and finance days carry none. Older apps ignore it.
      if (d) add(d, "meeting", e.title || "Meeting", e.allDay ? {} : { at });
    }
  } catch (_) {}

  res.json({ year: y, month: m, days });
});

module.exports = router;
