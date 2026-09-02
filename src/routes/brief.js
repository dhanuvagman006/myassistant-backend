/**
 * GET /brief — the home dashboard's single aggregate fetch.
 * Query: lat, lng (optional, for the weather chip).
 * Header: X-TZ-Offset (minutes east of UTC; defaults to IST 330).
 */
const router = require("express").Router();
const { buildBrief } = require("../services/brief");

router.get("/", async (req, res) => {
  const uid = Number(req.user?.sub);
  if (!Number.isInteger(uid) || uid <= 0) {
    // Dev/appKey sessions have no user row — an EMPTY brief, not an error,
    // so the home screen renders its calm state instead of a banner.
    return res.json({
      name: null, weather_line: null, agenda: [], promises: [],
      messages: [], people: [], people_count: 0, headlines: [],
    });
  }
  try {
    const brief = await buildBrief(uid, {
      lat: parseFloat(req.query.lat),
      lng: parseFloat(req.query.lng),
      tzOffsetMin: Number(req.get("X-TZ-Offset")) || 330,
    });
    res.json(brief);
  } catch (e) {
    console.error("brief failed:", e.message);
    res.status(500).json({ error: "brief failed" });
  }
});

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
  const tz = Number(req.get("X-TZ-Offset")) || 330;

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
      if (d) add(d, "reminder", r.text, { id: r.id, del: "reminders" });
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

  // Google Calendar meetings, when the account is linked.
  try {
    const events = await require("../google/api").upcomingEvents(uid, {
      days: 45,
      max: 50,
    });
    for (const e of events || []) {
      const at = Date.parse(e.start);
      const d = Number.isFinite(at) ? dayOf(at) : null;
      if (d) add(d, "meeting", e.title || "Meeting");
    }
  } catch (_) {}

  res.json({ year: y, month: m, days });
});

module.exports = router;
