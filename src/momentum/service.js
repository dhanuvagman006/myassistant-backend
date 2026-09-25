/**
 * MOMENTUM — Today's 3, habits, focus sessions and the streak they feed.
 *
 * Owner, 2026-09-25: "plan and add some features that make much better
 * and keeps user motivated and productive". Reminders and promises say
 * what is DUE; nothing helped decide what MATTERS today, helped focus on
 * it, or showed progress and celebrated it. This module is the data half:
 * four tables, one summary, and the writes the app and the voice tools
 * share. The rules of the streak itself live in streak.js.
 *
 * Every day here is the USER'S local date ('YYYY-MM-DD'): the app sends
 * its own date and its X-TZ-Offset, and "today" is never the server's
 * idea of it. Writes are serialised per user (an advisory lock), which is
 * what keeps "at most 3 a day" and "at most 12 habits" true when two taps
 * race each other.
 */
const { query, one, tx } = require("../db");
const S = require("./streak");

const MAX_PRIORITIES = 3;
const MAX_HABITS = 12;
const MAX_TITLE = 80;
const FOCUS_MIN = 5;
const FOCUS_MAX = 180;
// A session planned for 180 can run past it with "+5 min"; this is the
// ceiling on what one session may log, not a planning limit.
const FOCUS_LOG_MAX = 300;
// pg_advisory_xact_lock(class, key): the class keeps our keys apart from
// anyone else's use of advisory locks on this database.
const LOCK_CLASS = 7710;

async function migrate(exec) {
  await exec(`
    -- TODAY'S 3: what would make a day a win. At most three per local day.
    CREATE TABLE IF NOT EXISTS momentum_priorities (
      id         BIGSERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      day        TEXT NOT NULL,                -- the user's local 'YYYY-MM-DD'
      position   INTEGER NOT NULL DEFAULT 0,
      title      TEXT NOT NULL,
      done       INTEGER NOT NULL DEFAULT 0,
      -- The local day it was ticked, which is the day the streak credits
      -- (normally the same as day; not for one ticked a day late).
      done_day   TEXT,
      done_at    BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_momentum_priorities_user
      ON momentum_priorities(user_id, day);

    -- SMALL DAILY HABITS (water, a walk, ten pages). Removing one archives
    -- it: the days it was ticked stay in the streak they helped build.
    CREATE TABLE IF NOT EXISTS momentum_habits (
      id         BIGSERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      title      TEXT NOT NULL,
      emoji      TEXT NOT NULL DEFAULT '',
      remind_at  TEXT NOT NULL DEFAULT '',     -- local 'HH:MM', '' = no reminder
      archived   INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_momentum_habits_user
      ON momentum_habits(user_id, archived);

    -- One row per habit per local day it was ticked.
    CREATE TABLE IF NOT EXISTS momentum_habit_checks (
      id         BIGSERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      habit_id   BIGINT NOT NULL,
      day        TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE (habit_id, day)
    );
    CREATE INDEX IF NOT EXISTS idx_momentum_checks_user
      ON momentum_habit_checks(user_id, day);

    -- FOCUS SESSIONS. Started by the app, finished by the app with the
    -- minutes actually done; the day is the local day it started.
    CREATE TABLE IF NOT EXISTS momentum_focus (
      id          BIGSERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      label       TEXT NOT NULL DEFAULT '',
      planned_min INTEGER NOT NULL,
      actual_min  INTEGER NOT NULL DEFAULT 0,
      completed   INTEGER NOT NULL DEFAULT 0,  -- 1 = ran its full length
      day         TEXT NOT NULL,
      started_at  BIGINT NOT NULL,
      ended_at    BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_momentum_focus_user
      ON momentum_focus(user_id, day);
  `);
}

/* ------------------------------------------------------------------ *
 * VALIDATION
 * ------------------------------------------------------------------ */

/** A refusal the caller can show as it is: status + a plain sentence. */
class MomentumError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new MomentumError(400, msg);
const notFound = (what) => new MomentumError(404, `${what} not found`);

function cleanTitle(raw, what = "title") {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!t) throw bad(`${what} is empty`);
  if (t.length > MAX_TITLE) throw bad(`${what} is too long (${MAX_TITLE} characters at most)`);
  return t;
}

function cleanDay(raw, what = "day") {
  if (!S.isDay(raw)) throw bad(`${what} must be a date like 2026-09-25`);
  return raw;
}

function cleanEmoji(raw) {
  if (raw === undefined || raw === null) return "";
  const e = String(raw).trim();
  if (e.length > 16 || /\s/.test(e)) throw bad("emoji must be a single emoji");
  return e;
}

const TIME_RX = /^([01]\d|2[0-3]):([0-5]\d)$/;
function cleanTime(raw) {
  if (raw === undefined || raw === null || raw === "") return "";
  const t = String(raw).trim();
  if (!TIME_RX.test(t)) throw bad("remindAt must be a time like 09:00");
  return t;
}

function wholeNumber(raw, what, min, max) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw bad(`${what} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

const today = (tz) => S.localDay(Date.now(), tz);
const lockUser = (c, userId) =>
  c.query(`SELECT pg_advisory_xact_lock($1, $2)`, [LOCK_CLASS, userId]);

/* ------------------------------------------------------------------ *
 * TODAY'S 3
 * ------------------------------------------------------------------ */

async function prioritiesFor(userId, day) {
  return query(
    `SELECT id, title, done, position FROM momentum_priorities
      WHERE user_id = $1 AND day = $2 ORDER BY position, id`,
    [userId, day]
  );
}

/**
 * Replaces one day's list. Items that carry the id of one of that day's
 * priorities keep it (and its done state); items without an id are new;
 * that day's priorities left out are removed.
 */
async function setPriorities(userId, day, items) {
  cleanDay(day);
  if (!Array.isArray(items)) throw bad("items must be a list");
  if (items.length > MAX_PRIORITIES) throw bad(`at most ${MAX_PRIORITIES} priorities a day`);
  const clean = items.map((it) => ({
    id: it && it.id !== undefined && it.id !== null ? Number(it.id) : null,
    title: cleanTitle(it && it.title),
  }));
  const ids = clean.filter((i) => i.id !== null).map((i) => i.id);
  if (ids.some((id) => !Number.isSafeInteger(id))) throw bad("bad id");
  if (new Set(ids).size !== ids.length) throw bad("the same priority is listed twice");
  const now = Date.now();
  return tx(async (c) => {
    await lockUser(c, userId);
    const have = (await c.query(
      `SELECT id FROM momentum_priorities WHERE user_id = $1 AND day = $2`, [userId, day]
    )).rows.map((r) => Number(r.id));
    const mine = new Set(have);
    for (const id of ids) if (!mine.has(id)) throw notFound("priority");
    const drop = have.filter((id) => !ids.includes(id));
    if (drop.length) {
      await c.query(`DELETE FROM momentum_priorities WHERE user_id = $1 AND id = ANY($2::bigint[])`,
        [userId, drop]);
    }
    for (const [pos, it] of clean.entries()) {
      if (it.id !== null) {
        await c.query(
          `UPDATE momentum_priorities SET title = $3, position = $4, updated_at = $5
            WHERE user_id = $1 AND id = $2`, [userId, it.id, it.title, pos, now]);
      } else {
        await c.query(
          `INSERT INTO momentum_priorities (user_id, day, position, title, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $5)`, [userId, day, pos, it.title, now]);
      }
    }
  });
}

/**
 * Ticks, renames or moves one priority. `day` moves it (usually to
 * tomorrow); the target day must have room.
 */
async function patchPriority(userId, id, patch = {}, { tz } = {}) {
  const pid = Number(id);
  if (!Number.isSafeInteger(pid)) throw notFound("priority");
  const now = Date.now();
  return tx(async (c) => {
    await lockUser(c, userId);
    const row = (await c.query(
      `SELECT * FROM momentum_priorities WHERE user_id = $1 AND id = $2`, [userId, pid]
    )).rows[0];
    if (!row) throw notFound("priority");
    const sets = [];
    const vals = [userId, pid];
    const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (patch.title !== undefined) set("title", cleanTitle(patch.title));
    if (patch.done !== undefined) {
      if (typeof patch.done !== "boolean") throw bad("done must be true or false");
      if (patch.done !== Boolean(Number(row.done))) {
        set("done", patch.done ? 1 : 0);
        set("done_day", patch.done ? today(tz) : null);
        set("done_at", patch.done ? now : null);
      }
    }
    if (patch.day !== undefined && patch.day !== row.day) {
      const to = cleanDay(patch.day);
      const there = (await c.query(
        `SELECT count(*)::int AS n, coalesce(max(position), -1)::int AS last
           FROM momentum_priorities WHERE user_id = $1 AND day = $2`, [userId, to]
      )).rows[0];
      if (there.n >= MAX_PRIORITIES) {
        throw new MomentumError(409, `that day already has ${MAX_PRIORITIES} priorities`);
      }
      set("day", to);
      set("position", there.last + 1);
    }
    if (!sets.length) return;
    set("updated_at", now);
    await c.query(`UPDATE momentum_priorities SET ${sets.join(", ")} WHERE user_id = $1 AND id = $2`, vals);
  });
}

async function deletePriority(userId, id) {
  const pid = Number(id);
  if (!Number.isSafeInteger(pid)) throw notFound("priority");
  const r = await one(
    `DELETE FROM momentum_priorities WHERE user_id = $1 AND id = $2 RETURNING id`, [userId, pid]);
  if (!r) throw notFound("priority");
}

/* ------------------------------------------------------------------ *
 * HABITS
 * ------------------------------------------------------------------ */

async function activeHabits(userId) {
  return query(
    `SELECT id, title, emoji, remind_at FROM momentum_habits
      WHERE user_id = $1 AND archived = 0 ORDER BY id`, [userId]);
}

/** @returns the new habit's id */
async function addHabit(userId, { title, emoji, remindAt } = {}) {
  const t = cleanTitle(title);
  const e = cleanEmoji(emoji);
  const r = cleanTime(remindAt);
  const now = Date.now();
  return tx(async (c) => {
    await lockUser(c, userId);
    const n = (await c.query(
      `SELECT count(*)::int AS n FROM momentum_habits WHERE user_id = $1 AND archived = 0`, [userId]
    )).rows[0].n;
    if (n >= MAX_HABITS) throw new MomentumError(409, `at most ${MAX_HABITS} habits — remove one first`);
    const row = (await c.query(
      `INSERT INTO momentum_habits (user_id, title, emoji, remind_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`, [userId, t, e, r, now]
    )).rows[0];
    return Number(row.id);
  });
}

async function liveHabit(c, userId, id) {
  const hid = Number(id);
  if (!Number.isSafeInteger(hid)) throw notFound("habit");
  const row = (await c.query(
    `SELECT * FROM momentum_habits WHERE user_id = $1 AND id = $2 AND archived = 0`, [userId, hid]
  )).rows[0];
  if (!row) throw notFound("habit");
  return row;
}

async function patchHabit(userId, id, patch = {}) {
  return tx(async (c) => {
    const row = await liveHabit(c, userId, id);
    const sets = [];
    const vals = [userId, row.id];
    const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (patch.title !== undefined) set("title", cleanTitle(patch.title));
    if (patch.emoji !== undefined) set("emoji", cleanEmoji(patch.emoji));
    if (patch.remindAt !== undefined) set("remind_at", cleanTime(patch.remindAt));
    if (!sets.length) return;
    set("updated_at", Date.now());
    await c.query(`UPDATE momentum_habits SET ${sets.join(", ")} WHERE user_id = $1 AND id = $2`, vals);
  });
}

async function archiveHabit(userId, id) {
  return tx(async (c) => {
    const row = await liveHabit(c, userId, id);
    await c.query(`UPDATE momentum_habits SET archived = 1, updated_at = $3 WHERE user_id = $1 AND id = $2`,
      [userId, row.id, Date.now()]);
  });
}

/**
 * Ticks (or unticks) a habit for a day. Only the last week can be
 * changed: enough to fix a forgotten tick, not enough to rewrite history.
 */
async function checkHabit(userId, id, { day, done } = {}, { tz } = {}) {
  cleanDay(day);
  if (typeof done !== "boolean") throw bad("done must be true or false");
  const t = today(tz);
  const age = S.dayNum(t) - S.dayNum(day);
  if (age < -1 || age > 7) throw bad("only the last 7 days can be ticked");
  return tx(async (c) => {
    const row = await liveHabit(c, userId, id);
    if (done) {
      await c.query(
        `INSERT INTO momentum_habit_checks (user_id, habit_id, day, created_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (habit_id, day) DO NOTHING`,
        [userId, row.id, day, Date.now()]);
    } else {
      await c.query(`DELETE FROM momentum_habit_checks WHERE user_id = $1 AND habit_id = $2 AND day = $3`,
        [userId, row.id, day]);
    }
    // A tick is use: it keeps the evening nudges pointed at someone who
    // is actually using this.
    await c.query(`UPDATE momentum_habits SET updated_at = $3 WHERE user_id = $1 AND id = $2`,
      [userId, row.id, Date.now()]);
  });
}

/* ------------------------------------------------------------------ *
 * FOCUS
 * ------------------------------------------------------------------ */

/** @returns the new session's id */
async function startFocus(userId, { plannedMin, label } = {}, { tz } = {}) {
  const planned = wholeNumber(plannedMin, "plannedMin", FOCUS_MIN, FOCUS_MAX);
  const l = label === undefined || label === null || String(label).trim() === ""
    ? "" : cleanTitle(label, "label");
  const now = Date.now();
  const row = await one(
    `INSERT INTO momentum_focus (user_id, label, planned_min, day, started_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`, [userId, l, planned, today(tz), now]);
  return Number(row.id);
}

async function finishFocus(userId, id, { actualMin, completed } = {}) {
  const fid = Number(id);
  if (!Number.isSafeInteger(fid)) throw notFound("focus session");
  const minutes = wholeNumber(actualMin, "actualMin", 0, FOCUS_LOG_MAX);
  if (typeof completed !== "boolean") throw bad("completed must be true or false");
  const r = await one(
    `UPDATE momentum_focus SET actual_min = $3, completed = $4, ended_at = $5
      WHERE user_id = $1 AND id = $2 RETURNING id`,
    [userId, fid, minutes, completed ? 1 : 0, Date.now()]);
  if (!r) throw notFound("focus session");
}

/* ------------------------------------------------------------------ *
 * THE SUMMARY
 * ------------------------------------------------------------------ */

const countBy = (rows, key = "day", val = "n") => {
  const out = {};
  for (const r of rows) out[r[key]] = (out[r[key]] || 0) + Number(r[val] || 0);
  return out;
};

const earnedKey = (uid) => `momentum:${uid}:earned`;

/**
 * Everything the app shows, for one local day (see the plan's summary
 * JSON). `day` is "today" for every streak and week figure in it.
 */
async function summary(userId, day, { tz = 330 } = {}) {
  cleanDay(day);
  const floor = S.addDays(day, -(S.WINDOW_DAYS - 1));
  // Promises are stamped in epoch ms; a day of slack either side of the
  // window, and each one is placed on the user's own calendar below.
  const floorMs = Date.parse(floor + "T00:00:00Z") - (Number(tz) || 0) * 60_000 - 86_400_000;

  const [priorities, habits, doneRows, checkRows, focusRows, promiseRows, totals, kept] =
    await Promise.all([
      prioritiesFor(userId, day),
      activeHabits(userId),
      query(`SELECT done_day AS day, count(*)::int AS n FROM momentum_priorities
              WHERE user_id = $1 AND done = 1 AND done_day >= $2 GROUP BY done_day`, [userId, floor]),
      query(`SELECT habit_id, day FROM momentum_habit_checks WHERE user_id = $1 AND day >= $2`,
        [userId, floor]),
      query(`SELECT day, coalesce(sum(actual_min), 0)::int AS n FROM momentum_focus
              WHERE user_id = $1 AND day >= $2 GROUP BY day`, [userId, floor]),
      query(`SELECT updated_at FROM commitments
              WHERE user_id = $1 AND status = 'done' AND updated_at >= $2`, [userId, floorMs]),
      one(`SELECT
             (SELECT count(*)::int FROM momentum_priorities WHERE user_id = $1 AND done = 1) AS wins,
             (SELECT count(*)::int FROM commitments WHERE user_id = $1 AND status = 'done') AS kept,
             (SELECT coalesce(sum(actual_min), 0)::int FROM momentum_focus WHERE user_id = $1) AS focus`,
        [userId]),
      one(`SELECT v FROM kv WHERE k = $1`, [earnedKey(userId)]),
    ]);

  const promisesKept = {};
  for (const r of promiseRows) {
    const d = S.localDay(Number(r.updated_at), tz);
    if (d >= floor && d <= day) promisesKept[d] = (promisesKept[d] || 0) + 1;
  }
  const byHabit = new Map();
  for (const r of checkRows) {
    const hid = Number(r.habit_id);
    if (!byHabit.has(hid)) byHabit.set(hid, []);
    byHabit.get(hid).push(r.day);
  }
  const book = S.ledger({
    prioritiesDone: countBy(doneRows),
    promisesKept,
    habitChecks: countBy(checkRows.map((r) => ({ day: r.day, n: 1 }))),
    focusMin: countBy(focusRows),
  });
  const streak = S.streakFacts(S.activeDaysOf(book), day);
  const week = S.weekOf(book, day, streak.forgiven);
  const days7 = S.last7(day);

  const habitList = habits.map((h) => {
    const ticks = byHabit.get(Number(h.id)) || [];
    const f = S.streakFacts(ticks, day);
    const set = new Set(ticks);
    return {
      id: Number(h.id),
      title: h.title,
      emoji: h.emoji || "",
      remindAt: h.remind_at || null,
      doneToday: set.has(day),
      streak: f.current,
      best: f.best,
      last7: days7.map((d) => set.has(d)),
    };
  });

  const focusByDay = countBy(focusRows);
  let weekMin = 0;
  for (const d of days7) weekMin += focusByDay[d] || 0;

  let keptMilestones = {};
  try { keptMilestones = kept ? JSON.parse(kept.v) || {} : {}; } catch (_) {}
  const ms = S.milestones({
    bestStreakDays: streak.best,
    focusTotalMin: Number(totals?.focus || 0),
    winsTotal: Number(totals?.wins || 0) + Number(totals?.kept || 0),
  }, day, keptMilestones);
  if (Object.keys(ms.newly).length) {
    // Kept for good: a streak milestone must not un-earn itself when the
    // streak that earned it slips out of the 365-day window.
    await query(
      `INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
      [earnedKey(userId), JSON.stringify({ ...keptMilestones, ...ms.newly })]
    ).catch(() => {});
  }

  return {
    ok: true,
    day,
    priorities: priorities.map((p) => ({
      id: Number(p.id),
      title: p.title,
      done: Boolean(Number(p.done)),
      position: Number(p.position),
    })),
    habits: habitList,
    focus: {
      todayMin: focusByDay[day] || 0,
      weekMin,
      totalMin: Number(totals?.focus || 0),
    },
    streak: {
      current: streak.current,
      best: streak.best,
      activeToday: streak.activeToday,
      graceUsedThisWeek: streak.graceUsedThisWeek,
    },
    week,
    milestones: ms.list,
  };
}

module.exports = {
  migrate, summary, MomentumError,
  prioritiesFor, setPriorities, patchPriority, deletePriority,
  activeHabits, addHabit, patchHabit, archiveHabit, checkHabit,
  startFocus, finishFocus,
  MAX_PRIORITIES, MAX_HABITS, MAX_TITLE, FOCUS_MIN, FOCUS_MAX,
};
