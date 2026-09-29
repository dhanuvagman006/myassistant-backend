/**
 * ASSISTANT FUNCTIONS (Android AppFunctions, Android 16+) — what Gemini and
 * other system agents may do in My Assistant without opening it. The app's
 * native AppFunctionService calls these with its narrow "appfn" key
 * (./token.js); a normal session token works as well.
 *
 * Every call runs the SAME tool the assistant runs, through
 * registry.execute, so its gates, the audit trail and the actions ledger
 * apply — recorded with source "appfunctions". Nothing destructive, no
 * messaging, no money: add, read, tick, remind, plan, log.
 *
 * Header X-TZ-Offset: the device's UTC offset in minutes (IST = 330).
 * Without it, the user's saved offset, else IST.
 *
 *   POST /shopping/add     {items:[{name, quantity?, unit?, details?, store?}]}
 *                          → {added:[{name, amountText, category}], merged:[…], count}
 *   GET  /shopping?category=
 *                          → {items:[{name, amountText, details, category, store}], count}
 *   POST /shopping/bought  {names:[…]} → {checked:[…], notFound:[…], ambiguous:[{name, candidates}]}
 *   POST /reminders        {text, dueDateTime?} → {id, text, dueAt, dueText}
 *   GET  /reminders?days=7 → {reminders:[{id, text, dueAt, dueText}]}
 *   POST /today            {title} → {added, priorities:[titles]}
 *   POST /habits/log       {habit} → {habit, doneToday:true, streak}
 *   GET  /my-day           → {date, priorities:[{title, done}], reminders:[…],
 *                             habitsDue:[names], shoppingCount, summary}
 *
 * count = the unticked lines on the list (in the category asked for).
 * dueAt = ISO-8601 in the device's offset; dueText = "tomorrow at 9 am".
 *
 * Errors (JSON): 400 {error:"bad_input", message} · 404 {error:"habit_not_found",
 * habits} · 409 {error:"today_full", priorities} · 409 {error:"needs_confirmation",
 * summary, message} · 422 {error:"not_done", message} · 429 {error:"too_many_requests"}.
 */
const router = require("express").Router();
const crypto = require("crypto");
const registry = require("../tools/registry");
const audit = require("../audit/log");
const { offsetOr } = require("../services/tz");
const N = require("../shopping/normalize");
const shopStore = require("../shopping/store");
const momentum = require("../momentum/service");
const { shortTitle } = require("../momentum/tools");
const S = require("../momentum/streak");

const CONFIRM_MESSAGE = "Open My Assistant to confirm this.";
const MAX_TEXT = 300;
const MAX_TITLE = 120;
const MAX_DAYS = 90;

/* ---------------------------- answers ---------------------------- */

class Answer {
  constructor(status, body) {
    this.status = status;
    this.body = body;
  }
}
const answer = (status, body) => {
  throw new Answer(status, body);
};
const bad = (message) => answer(400, { error: "bad_input", message });
const notDone = (res) =>
  answer(422, { error: "not_done", message: String((res && res.error) || "that could not be done").slice(0, 300) });

/** Signed-in account id, or null. */
function uidOf(req) {
  const id = Number(req.user && req.user.sub);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Device offset from the header, else the saved one, else IST. */
const tzOf = (req) => offsetOr(req.get("X-TZ-Offset"), offsetOr(req.auth && req.auth.tzOffsetMin));

const handle = (fn) => async (req, res, next) => {
  try {
    const uid = uidOf(req);
    if (!uid) return res.status(401).json({ error: "sign in required" });
    res.json(await fn(req, uid, tzOf(req)));
  } catch (e) {
    if (e instanceof Answer) return res.status(e.status).json(e.body);
    next(e);
  }
};

/**
 * One tool, the assistant's own, for this request. `what` is a short
 * description of the call: it is the ledger's intent and the turn's text.
 */
async function run(req, name, args, what) {
  if (!req._appfnTurn) req._appfnTurn = `appfn-${crypto.randomBytes(6).toString("hex")}`;
  const said = `Phone assistant: ${what}`.slice(0, 300);
  const res = await registry.execute(name, args, {
    source: "appfunctions",
    userId: uidOf(req),
    tzOffsetMin: tzOf(req),
    userText: said,
    intent: said,
    turnId: req._appfnTurn,
    rid: req.requestId || null,
  });
  // A tool that wants the owner's yes is not done from here: nothing ran.
  if (res.needsConfirmation) {
    answer(409, { error: "needs_confirmation", summary: String(res.summary || name), message: CONFIRM_MESSAGE });
  }
  if (res.needsArgs) bad(`missing ${[].concat(res.needsArgs).join(", ")}`);
  return res;
}

/* ---------------------------- words ------------------------------ */

/** "a", "a and b", "a, b and c" */
function listText(xs) {
  const a = xs.map(String);
  if (a.length <= 1) return a.join("");
  return `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
}
/** Mid-sentence: "Call the bank" → "call the bank"; "GST filing" stays. */
const inline = (s) => {
  const t = String(s || "").trim().replace(/[.!?]+$/, "");
  return /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
};
const cleanLine = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/* ---------------------------- time ------------------------------- */

const pad = (n) => String(n).padStart(2, "0");
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];

/** 2026-09-30T09:00:00+05:30 — the instant, written in the device's offset. */
function isoLocal(ms, tz) {
  const d = new Date(ms + tz * 60_000);
  const a = Math.abs(tz);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `${tz < 0 ? "-" : "+"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** "9 am", "5:30 pm" */
function clock(ms, tz) {
  const d = new Date(ms + tz * 60_000);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${pad(m)}` : ""} ${h < 12 ? "am" : "pm"}`;
}

/** "today at 9 am", "tomorrow at 5:30 pm", "on Friday at 9 am", "on 12 October at 9 am". */
function spokenWhen(ms, tz, now = Date.now()) {
  const dayNo = (x) => Math.floor((x + tz * 60_000) / 86_400_000);
  const diff = dayNo(ms) - dayNo(now);
  const d = new Date(ms + tz * 60_000);
  const at = `at ${clock(ms, tz)}`;
  if (diff === 0) return `today ${at}`;
  if (diff === 1) return `tomorrow ${at}`;
  if (diff === -1) return `yesterday ${at}`;
  if (diff > 1 && diff < 7) return `on ${DAY_NAMES[d.getUTCDay()]} ${at}`;
  const year = d.getUTCFullYear() !== new Date(now + tz * 60_000).getUTCFullYear() ? ` ${d.getUTCFullYear()}` : "";
  return `on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year} ${at}`;
}

const ISO_DT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * An ISO-8601 date and time → unix ms. No offset = the device's local time;
 * an explicit offset (or Z) is taken as written. Anything else is bad input
 * — a reminder saved without the time it was meant for never rings.
 */
function parseDue(raw, tz) {
  const s = typeof raw === "string" ? raw.trim() : "";
  const m = s.match(ISO_DT);
  if (!m) {
    bad(`dueDateTime must be an ISO-8601 local date and time, like 2026-09-30T09:00:00 — got "${String(raw).slice(0, 40)}"`);
  }
  const [Y, Mo, D, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[6] || "0"].map(Number);
  const utc = Date.UTC(Y, Mo - 1, D, h, mi, sec);
  const back = new Date(utc);
  if (h > 23 || mi > 59 || sec > 59 || back.getUTCFullYear() !== Y ||
      back.getUTCMonth() !== Mo - 1 || back.getUTCDate() !== D) {
    bad(`dueDateTime "${s.slice(0, 40)}" is not a real date and time`);
  }
  let off = tz;
  if (m[7]) {
    if (/^z$/i.test(m[7])) off = 0;
    else {
      const sign = m[7][0] === "-" ? -1 : 1;
      const digits = m[7].slice(1).replace(":", "");
      off = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
      if (Math.abs(off) > 14 * 60) bad(`dueDateTime "${s.slice(0, 40)}" has an offset that does not exist`);
    }
  }
  return utc - off * 60_000;
}

const reminderOf = (id, text, dueAt, tz) => ({
  id: Number(id) || null,
  text: String(text || ""),
  dueAt: dueAt ? isoLocal(Number(dueAt), tz) : null,
  dueText: dueAt ? spokenWhen(Number(dueAt), tz) : null,
});

/* --------------------------- shopping ---------------------------- */

const ITEM_KEYS = ["quantity", "unit", "details", "store"];
const shopLine = (i) => ({ name: i.name, amountText: i.amount || "", category: i.category });

router.post("/shopping/add", handle(async (req, uid) => {
  const raw = (req.body || {}).items;
  if (!Array.isArray(raw) || !raw.length) {
    bad("items must be a non-empty list of {name, quantity?, unit?, details?, store?}");
  }
  if (raw.length > shopStore.LIMITS.perRequest) bad(`at most ${shopStore.LIMITS.perRequest} items at a time`);
  const items = raw.map((r, i) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) bad(`item ${i + 1} must be an object with a name`);
    if (typeof r.name !== "string" || !r.name.trim()) bad(`item ${i + 1} needs a name`);
    const it = { name: r.name.trim() };
    for (const k of ITEM_KEYS) if (r[k] !== undefined && r[k] !== null && r[k] !== "") it[k] = r[k];
    try {
      shopStore.cleanItem(it, { strict: true, index: i });
    } catch (e) {
      if (e instanceof shopStore.ShoppingError) bad(e.message);
      throw e;
    }
    return it;
  });
  const names = items.map((i) => i.name);
  const res = await run(req, "shopping_list_add", { items }, `add ${listText(names)} to the shopping list`);
  if (res.ok === false) notDone(res);
  const d = res.data || {};
  audit.record(uid, "appfunctions.shopping.added",
    `A phone assistant added ${listText(names)} to your shopping list`);
  return {
    added: (d.added || []).map(shopLine),
    merged: (d.merged || []).map(shopLine),
    count: Number(d.onList) || 0,
  };
}));

router.get("/shopping", handle(async (req) => {
  let category = null;
  const c = req.query.category;
  if (c !== undefined && c !== "") {
    category = typeof c === "string" ? N.normalizeCategory(c) : null;
    if (!category) bad(`category must be one of: ${N.CATEGORY_IDS.join(", ")}`);
  }
  const res = await run(req, "shopping_list_show", { ...(category ? { category } : {}), open: false },
    category ? `read the ${category} lines of the shopping list` : "read the shopping list");
  if (res.ok === false) notDone(res);
  const items = [];
  for (const g of (res.data && res.data.groups) || []) {
    for (const i of g.items || []) {
      items.push({
        name: i.name, amountText: i.amount || "", details: i.details || "",
        category: i.category, store: i.store || "",
      });
    }
  }
  return { items, count: items.length };
}));

router.post("/shopping/bought", handle(async (req, uid) => {
  const raw = (req.body || {}).names;
  if (!Array.isArray(raw) || !raw.length) bad("names must be a non-empty list of item names");
  if (raw.length > shopStore.LIMITS.perRequest) bad(`at most ${shopStore.LIMITS.perRequest} names at a time`);
  const names = raw.map((n, i) => {
    const t = cleanLine(n);
    if (!t) bad(`names[${i}] must be a non-empty string`);
    if (t.length > shopStore.LIMITS.name) bad(`names[${i}] can be at most ${shopStore.LIMITS.name} characters`);
    return t;
  });
  const res = await run(req, "shopping_list_check", { items: names, bought: true },
    `mark ${listText(names)} as bought`);
  // "which_one": nothing ticked because every name matched two lines —
  // still an answer; the agent asks which one.
  if (res.ok === false && res.error !== "which_one") notDone(res);
  const d = res.data || {};
  const checked = d.changed || [];
  if (checked.length) {
    audit.record(uid, "appfunctions.shopping.bought",
      `A phone assistant ticked off ${listText(checked)} on your shopping list`);
  }
  return {
    checked,
    notFound: d.notOnList || [],
    ambiguous: (d.whichOne || []).map((u) => ({ name: u.said, candidates: u.candidates || [] })),
  };
}));

/* --------------------------- reminders --------------------------- */

router.post("/reminders", handle(async (req, uid, tz) => {
  const body = req.body || {};
  const text = cleanLine(body.text);
  if (!text) bad("text is required: what to be reminded of");
  if (text.length > MAX_TEXT) bad(`text can be at most ${MAX_TEXT} characters`);
  let due = null;
  if (body.dueDateTime !== undefined && body.dueDateTime !== null && body.dueDateTime !== "") {
    due = parseDue(body.dueDateTime, tz);
    if (due < Date.now() - 60_000) bad("dueDateTime is in the past — give a future local date and time");
  }
  // quiet: a reminder filed from outside the app is a notification, never
  // a paid phone call (reminders/store.js: calls are opt-in, asked of Hari).
  const args = { text, quiet: true, ...(due ? { due_at: isoLocal(due, tz) } : {}) };
  const res = await run(req, "create_reminder", args,
    `remind me to ${inline(text)}${due ? ` ${spokenWhen(due, tz)}` : ""}`);
  if (res.ok === false || !res.data) notDone(res);
  const r = res.data;
  const out = reminderOf(r.id, r.text, r.due_at, tz);
  audit.record(uid, "appfunctions.reminder.created",
    `A phone assistant set a reminder: ${out.text}${out.dueText ? ` (${out.dueText})` : ""}`);
  return out;
}));

router.get("/reminders", handle(async (req, _uid, tz) => {
  let days = 7;
  const q = req.query.days;
  if (q !== undefined && q !== "") {
    const n = typeof q === "string" && /^\d+$/.test(q) ? Number(q) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) bad(`days must be a whole number from 1 to ${MAX_DAYS}`);
    days = n;
  }
  const res = await run(req, "list_reminders", {}, `list my reminders for the next ${days} days`);
  if (res.ok === false) notDone(res);
  const now = Date.now();
  const end = now + days * 86_400_000;
  const reminders = (Array.isArray(res.data) ? res.data : [])
    .filter((r) => r.kind === "reminder" && r.dueAt && r.dueAt >= now && r.dueAt <= end)
    .sort((a, b) => a.dueAt - b.dueAt)
    .map((r) => reminderOf(r.id, r.text, r.dueAt, tz));
  return { reminders };
}));

/* ---------------------------- momentum --------------------------- */

router.post("/today", handle(async (req, uid, tz) => {
  const title = cleanLine((req.body || {}).title);
  if (!title) bad("title is required: one short priority for today");
  if (title.length > MAX_TITLE) bad(`title can be at most ${MAX_TITLE} characters — keep it to a short phrase`);
  const key = shortTitle(title).toLowerCase();
  const before = await momentum.prioritiesFor(uid, S.localDay(Date.now(), tz));
  const had = before.some((p) => String(p.title).toLowerCase() === key);
  const res = await run(req, "plan_my_day", { priorities: [title] }, `add "${title}" to today's priorities`);
  if (res.ok === false) {
    if (res.data && Array.isArray(res.data.today)) {
      answer(409, { error: "today_full", priorities: res.data.today });
    }
    notDone(res);
  }
  if (!had) {
    audit.record(uid, "appfunctions.today.added", `A phone assistant added "${shortTitle(title)}" to Today's 3`);
  }
  return { added: !had, priorities: (res.data && res.data.priorities) || [] };
}));

router.post("/habits/log", handle(async (req, uid) => {
  const habit = cleanLine((req.body || {}).habit);
  if (!habit) bad("habit is required: words from the habit's name");
  if (habit.length > 80) bad("habit can be at most 80 characters");
  const res = await run(req, "check_habit", { habit, done: true }, `log "${habit}" as done today`);
  if (res.ok === false) {
    answer(404, { error: "habit_not_found", habits: (res.data && res.data.habits) || [] });
  }
  const d = res.data || {};
  audit.record(uid, "appfunctions.habit.logged", `A phone assistant ticked off ${d.habit || habit} for today`);
  return { habit: d.habit || habit, doneToday: true, streak: Number(d.streak) || 0 };
}));

/* ---------------------------- my day ----------------------------- */

/** Two or three plain sentences: priorities, reminders, then habits and the list. */
function daySummary({ priorities, reminders, habitsDue, shoppingCount }, tz) {
  const out = [];
  const left = priorities.filter((p) => !p.done).map((p) => inline(p.title));
  const done = priorities.length - left.length;
  if (!priorities.length) out.push("No priorities are set for today.");
  else if (!left.length) {
    out.push(priorities.length === 1 ? "Today's priority is done." : `All ${priorities.length} of today's priorities are done.`);
  } else out.push(`Still to do today: ${listText(left)}${done ? ` (${done} already done)` : ""}.`);

  if (!reminders.length) out.push("No reminders today.");
  else {
    const shown = reminders.slice(0, 3).map((r) => `${inline(r.text)} at ${clock(Date.parse(r.dueAt), tz)}`);
    const more = reminders.length - shown.length;
    out.push(`${reminders.length === 1 ? "One reminder" : `${reminders.length} reminders`} today: ` +
      `${more > 0 ? `${shown.join(", ")} and ${more} more` : listText(shown)}.`);
  }

  const rest = [];
  if (habitsDue.length) rest.push(`habits still to tick: ${listText(habitsDue.map(inline))}`);
  if (shoppingCount) rest.push(`${shoppingCount} ${shoppingCount === 1 ? "thing" : "things"} on the shopping list`);
  if (rest.length) {
    const s = rest.join("; ");
    out.push(`${s[0].toUpperCase()}${s.slice(1)}.`);
  }
  return out.join(" ");
}

router.get("/my-day", handle(async (req, _uid, tz) => {
  const m = await run(req, "momentum_status", {}, "read today's priorities and habits");
  if (m.ok === false) notDone(m);
  const r = await run(req, "list_reminders", { day: "today" }, "read today's reminders");
  if (r.ok === false) notDone(r);
  const s = await run(req, "shopping_list_show", { open: false }, "count the shopping list");
  if (s.ok === false) notDone(s);

  const today = (m.data && m.data.today) || {};
  const priorities = [
    ...(today.left || []).map((title) => ({ title, done: false })),
    ...(today.done || []).map((title) => ({ title, done: true })),
  ];
  const reminders = (Array.isArray(r.data) ? r.data : [])
    .filter((x) => x.kind === "reminder" && x.dueAt)
    .sort((a, b) => a.dueAt - b.dueAt)
    .map((x) => reminderOf(x.id, x.text, x.dueAt, tz));
  const habitsDue = (today.habits || []).filter((h) => !h.done).map((h) => h.title);
  const shoppingCount = Number(s.data && s.data.toBuy) || 0;
  const day = { priorities, reminders, habitsDue, shoppingCount };
  return { date: S.localDay(Date.now(), tz), ...day, summary: daySummary(day, tz) };
}));

module.exports = router;
module.exports.helpers = { isoLocal, spokenWhen, parseDue, clock, daySummary };
