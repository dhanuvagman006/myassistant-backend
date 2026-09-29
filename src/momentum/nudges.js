/**
 * MOMENTUM NUDGES — at most one gentle push a day, for people who use it.
 *
 * Owner, 2026-09-25: "plan and add some features that make much better
 * and keeps user motivated and productive". A nudge is the part of that
 * which can backfire: a streak app that nags is an app whose
 * notifications get switched off. So:
 *
 *   20:00  EVENING CHECK-IN — Today's 3 were set and are not all done:
 *          "2 of 3 done — finish one more, or move it to tomorrow?"
 *   21:00  STREAK GUARD — a streak of 3 days or more, and nothing done
 *          today yet: "One small win keeps your 5-day streak going."
 *   Sun 19:00  THE WEEK — wins, focus and habits, and the best day.
 *
 *   - at most ONE momentum push per user per local day (kv
 *     momentum:<uid>:<YYYY-MM-DD>, claimed before sending, so two pods or
 *     two sweeps cannot both send);
 *   - never in quiet hours (QUIET_HOURS_START/END, as the scheduler);
 *   - only for someone who used Momentum in the last 14 days — nobody is
 *     nagged about a feature they never picked up;
 *   - never guilt: a zero is never read back to them, and an empty week
 *     sends nothing at all;
 *   - MOMENTUM_NUDGES=off switches the lot off (on by default).
 *
 * The choice is a pure function (pickNudge), so the rules are tested
 * without a clock or a database; sweep() only gathers facts and sends.
 */
const S = require("./streak");

const DAY_MS = 86_400_000;
const RECENT_MS = 14 * DAY_MS;
const EVENING_HOUR = 20;
const GUARD_HOUR = 21;
const WEEKLY_HOUR = 19;
const GUARD_MIN_STREAK = 3;

// Off since Momentum left the app (2026-09-29); MOMENTUM_NUDGES=on brings
// them back.
function enabled(env = process.env) {
  return /^(on|1|true|yes)$/i.test(String(env.MOMENTUM_NUDGES || "off").trim());
}

/** Same window as the proactive scheduler's quiet hours (default 22–7). */
function quietAt(hour, env = process.env) {
  const start = Number(env.QUIET_HOURS_START || 22);
  const end = Number(env.QUIET_HOURS_END || 7);
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

/** "45 min", "2 h", "3 h 10 min". */
function minutesText(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/**
 * Which nudge, if any, is due right now.
 *
 * @param {object} f
 * @param {number}  f.hour           the user's local hour
 * @param {number}  f.weekday        0 = Sunday
 * @param {boolean} f.sentToday      a momentum push already went today
 * @param {boolean} f.usedRecently   Momentum used in the last 14 days
 * @param {{total:number, done:number}} f.priorities  today's list
 * @param {{current:number, activeToday:boolean}} f.streak
 * @param {{wins:number, focusMin:number, habitsKept:number, bestDay:string|null}} f.week
 * @returns {null|{kind:string, title:string, body:string}}
 */
function pickNudge(f, env = process.env) {
  if (!enabled(env) || f.sentToday || !f.usedRecently) return null;
  if (quietAt(f.hour, env)) return null;
  const p = f.priorities || { total: 0, done: 0 };
  const st = f.streak || { current: 0, activeToday: false };
  const atRisk = !st.activeToday && st.current >= GUARD_MIN_STREAK;

  if (f.weekday === 0 && f.hour === WEEKLY_HOUR) {
    const w = f.week || {};
    const bits = [];
    if (w.wins) bits.push(plural(w.wins, "win"));
    if (w.focusMin) bits.push(`${minutesText(w.focusMin)} of focus`);
    if (w.habitsKept) bits.push(plural(w.habitsKept, "habit") + " kept");
    if (!bits.length) return null; // an empty week is not news
    const best = w.bestDay && S.isDay(w.bestDay) ? ` Best day: ${DAY_NAMES[S.weekday(w.bestDay)]}.` : "";
    return { kind: "weekly", title: "Your week", body: `This week: ${bits.join(", ")}.${best}` };
  }

  if (f.hour === EVENING_HOUR && p.total > 0 && p.done < p.total) {
    const left = p.total - p.done;
    if (p.done > 0) {
      return {
        kind: "evening",
        title: "Today's three",
        body: `${p.done} of ${p.total} done — finish one more, or move ${left === 1 ? "it" : "the rest"} to tomorrow?`,
      };
    }
    return {
      kind: "evening",
      title: atRisk ? "Keep it going" : "Today's three",
      body: atRisk
        ? `One small win keeps your ${st.current}-day streak going — or move today's list to tomorrow.`
        : "Today's list is still open — one small win counts. Or move it to tomorrow?",
    };
  }

  if (f.hour === GUARD_HOUR && atRisk) {
    return {
      kind: "streak",
      title: "Keep it going",
      body: `One small win keeps your ${st.current}-day streak going.`,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * THE SWEEP — called by the proactive scheduler every 10 minutes
 * ------------------------------------------------------------------ */

/** Minutes east of UTC for a user row, as the scheduler reads it. */
function tzOf(u) {
  const { offsetOr } = require("../services/tz");
  const reported = offsetOr(u?.tz_offset_min, null);
  if (reported !== null) return reported;
  const n = Number(u?.timezone);
  return Number.isFinite(n) && Math.abs(n) <= 840 && u?.timezone !== "" ? n : 330;
}

const keyFor = (uid, day) => `momentum:${uid}:${day}`;

function defaultDeps() {
  const db = require("../db");
  return {
    // Signed-in devices that touched Momentum in the last 14 days.
    candidates: (since) => db.query(
      `SELECT u.id, u.fcm_token, u.timezone, u.tz_offset_min FROM users u
        WHERE u.fcm_token IS NOT NULL AND u.fcm_token <> ''
          AND (EXISTS (SELECT 1 FROM momentum_priorities p WHERE p.user_id = u.id AND p.updated_at > $1)
            OR EXISTS (SELECT 1 FROM momentum_habit_checks c WHERE c.user_id = u.id AND c.created_at > $1)
            OR EXISTS (SELECT 1 FROM momentum_focus f WHERE f.user_id = u.id AND f.started_at > $1)
            OR EXISTS (SELECT 1 FROM momentum_habits h WHERE h.user_id = u.id AND h.updated_at > $1))
        LIMIT 500`, [since]).catch(() => []),
    sentToday: (uid, day) =>
      db.one(`SELECT 1 AS x FROM kv WHERE k = $1`, [keyFor(uid, day)]).then(Boolean, () => true),
    // Claimed BEFORE sending: the one pod whose insert lands sends.
    claim: (uid, day, kind) =>
      db.one(`INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO NOTHING RETURNING k`,
        [keyFor(uid, day), kind]).then(Boolean, () => false),
    summary: (uid, day, tz) => require("./service").summary(uid, day, { tz }),
    send: (u, n) => require("../services/push").sendNotification(
      u.fcm_token, n.title, n.body, { kind: "momentum", nudge: n.kind }),
  };
}

/**
 * One pass over the candidates. Facts are only gathered for someone whose
 * local hour is one a nudge can fall in.
 */
async function sweep({ now = Date.now(), deps = defaultDeps(), env = process.env } = {}) {
  if (!enabled(env)) return 0;
  const users = await deps.candidates(now - RECENT_MS);
  let sent = 0;
  for (const u of users || []) {
    try {
      const tz = tzOf(u);
      const hour = S.localHour(now, tz);
      const day = S.localDay(now, tz);
      if (hour !== EVENING_HOUR && hour !== GUARD_HOUR &&
          !(hour === WEEKLY_HOUR && S.weekday(day) === 0)) continue;
      if (quietAt(hour, env)) continue;
      if (await deps.sentToday(u.id, day)) continue;
      const s = await deps.summary(u.id, day, tz);
      const pick = pickNudge({
        hour,
        weekday: S.weekday(day),
        sentToday: false,
        usedRecently: true, // the candidate query is that test
        priorities: {
          total: s.priorities.length,
          done: s.priorities.filter((x) => x.done).length,
        },
        streak: s.streak,
        week: s.week,
      }, env);
      if (!pick) continue;
      if (!(await deps.claim(u.id, day, pick.kind))) continue;
      if (await deps.send(u, pick)) sent++;
    } catch (e) {
      console.warn("momentum nudge failed:", e.message);
    }
  }
  return sent;
}

module.exports = { pickNudge, sweep, enabled, quietAt, minutesText, keyFor, tzOf };
