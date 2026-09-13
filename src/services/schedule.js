/**
 * THE DAY'S COMMITMENTS, in one list.
 *
 * Deliberately NOT an "appointments" feature. A doctor's clinic list, a
 * lawyer's hearings, a consultant's meetings and anybody's dentist
 * appointment are the same question — "what am I committed to on this
 * day" — and the answer has to come from every place a commitment can be
 * made, or the count at the top is a lie:
 *
 *   calendar  Google events (where most meetings actually live)
 *   bookings  the booking ledger — kind=doctor|restaurant|travel|…
 *   recalls   client/patient recalls scheduled from the practice tools
 *   reminders time-bound reminders that are really commitments
 *
 * Each source is independent and optional: one failing removes its own
 * rows, never the list. Nothing here writes anything.
 */
const db = require("../db");
const reminders = require("../reminders/store");
const practice = require("../practice/store");
const google = require("../google/api");

const DAY_MS = 24 * 3600 * 1000;

/**
 * The user's local day as a UTC window. Times are stored as epoch ms, so
 * "today" depends entirely on where they are — a clinic list computed in
 * UTC would start at 5:30 a.m. in India and drop the evening's patients.
 */
function dayWindow(tzOffsetMin, dayOffset = 0) {
  const shifted = Date.now() + tzOffsetMin * 60_000 + dayOffset * DAY_MS;
  const d = new Date(shifted);
  const startLocal = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const start = startLocal - tzOffsetMin * 60_000;
  return { start, end: start + DAY_MS };
}

function hhmm(ms, tzOffsetMin) {
  const d = new Date(ms + tzOffsetMin * 60_000);
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  const ampm = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${ampm}`;
}

function dayLabel(dayOffset) {
  return dayOffset === 0 ? "today" : dayOffset === 1 ? "tomorrow"
    : dayOffset === -1 ? "yesterday" : "";
}

/** Google's events carry ISO strings or bare dates; both become epoch ms. */
function isoToMs(iso) {
  if (!iso) return null;
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isFinite(t) ? t : null;
}

async function calendarItems(userId, win) {
  // upcomingEvents only looks FORWARD from now, so a day already under way
  // would lose the appointments earlier in it. Ask for enough days to
  // cover the window and filter here.
  const days = Math.max(1, Math.ceil((win.end - Date.now()) / DAY_MS) + 1);
  const evs = await google.upcomingEvents(userId, { days, max: 50 });
  if (!evs) return []; // Google not linked — not an error
  return evs
    .map((e) => ({ e, at: isoToMs(e.start) }))
    .filter(({ at }) => at !== null && at >= win.start && at < win.end)
    .map(({ e, at }) => ({
      kind: "meeting",
      title: e.title,
      who: "",
      where: e.location || "",
      at,
      allDay: Boolean(e.allDay),
      note: "",
      source: "calendar",
    }));
}

async function bookingItems(userId, win) {
  const rows = await db.query(
    `SELECT id, kind, title, venue, party_size, when_at, notes
       FROM bookings
      WHERE user_id = $1 AND status = 'confirmed'
        AND when_at IS NOT NULL AND when_at >= $2 AND when_at < $3
      ORDER BY when_at ASC`,
    [userId, win.start, win.end]
  );
  return rows.map((r) => ({
    kind: r.kind === "doctor" ? "appointment" : r.kind || "booking",
    title: r.title,
    who: "",
    where: r.venue || "",
    at: Number(r.when_at),
    allDay: false,
    note: [r.party_size ? `${r.party_size} people` : "", r.notes || ""]
      .filter(Boolean).join(" · "),
    source: "booking",
  }));
}

async function recallItems(userId, win) {
  const rows = await practice.listRecalls(userId, { dueBefore: win.end, limit: 200 });
  const due = rows.filter((r) => Number(r.due_at) >= win.start);
  if (!due.length) return [];
  // One query for the names rather than one per recall.
  const ids = [...new Set(due.map((r) => Number(r.client_id)))];
  const people = await db.query(
    `SELECT id, name, kind, summary FROM clients WHERE user_id = $1 AND id = ANY($2::bigint[])`,
    [userId, ids]
  );
  const byId = new Map(people.map((p) => [Number(p.id), p]));
  return due.map((r) => {
    const p = byId.get(Number(r.client_id));
    return {
      kind: p && p.kind === "patient" ? "patient" : "client",
      title: p ? p.name : "Client recall",
      who: p ? p.name : "",
      where: "",
      at: Number(r.due_at),
      allDay: false,
      note: [r.note || "", p && p.summary ? p.summary : ""].filter(Boolean).join(" · "),
      source: "recall",
    };
  });
}

async function reminderItems(userId, win, tzOffsetMin) {
  const rows = await reminders.list(userId, { tzOffsetMin });
  return rows
    .filter((r) => {
      const at = Number(r.due_at || r.dueAt || 0);
      return at >= win.start && at < win.end;
    })
    .map((r) => ({
      kind: "reminder",
      title: r.text || r.title || "Reminder",
      who: "",
      where: "",
      at: Number(r.due_at || r.dueAt),
      allDay: false,
      note: "",
      source: "reminder",
    }));
}

/**
 * Everything the user is committed to on one local day, time-sorted.
 * @returns {{ dayOffset, label, total, items: object[], sources: string[] }}
 */
async function forDay(userId, { dayOffset = 0, tzOffsetMin = 330 } = {}) {
  const win = dayWindow(tzOffsetMin, dayOffset);
  const settled = await Promise.allSettled([
    calendarItems(userId, win),
    bookingItems(userId, win),
    recallItems(userId, win),
    reminderItems(userId, win, tzOffsetMin),
  ]);
  const names = ["calendar", "bookings", "recalls", "reminders"];
  const items = [];
  const failed = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else {
      failed.push(names[i]);
      console.warn(`schedule: ${names[i]} failed:`, r.reason && r.reason.message);
    }
  });

  items.sort((a, b) => (a.allDay ? 0 : a.at) - (b.allDay ? 0 : b.at));
  return {
    dayOffset,
    label: dayLabel(dayOffset),
    total: items.length,
    // A SOURCE THAT FAILED IS NOT AN EMPTY SOURCE. The caller says "I
    // couldn't reach your calendar" rather than "nothing scheduled",
    // which would be a lie the user acts on.
    failed,
    items: items.map((x) => ({
      ...x,
      time: x.allDay ? "All day" : hhmm(x.at, tzOffsetMin),
    })),
  };
}

module.exports = { forDay, dayWindow, hhmm };
