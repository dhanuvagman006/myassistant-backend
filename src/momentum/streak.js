/**
 * MOMENTUM — the arithmetic of a streak. Pure: no database, no clock.
 *
 * Owner, 2026-09-25: "plan and add some features that make much better
 * and keeps user motivated and productive". The streak the app had counted
 * days the app was OPENED, and lived on the phone (a reinstall wiped it).
 * This one counts days something got DONE and lives on the server.
 *
 * WHAT MAKES A DAY COUNT (an "active" day, in the user's own local date):
 *   - one of Today's 3 ticked off that day;
 *   - a habit ticked for that day;
 *   - 10 or more minutes of focus logged that day (one session or several;
 *     a session ended early still counts the minutes it ran);
 *   - a promise (commitment) marked kept that day.
 *
 * ONE MISSED DAY A WEEK IS FORGIVEN — so a single bad day does not wipe
 * out weeks of effort. Precisely:
 *   - a forgiven day is a single missed day: the day before it is active
 *     (two misses in a row always end a streak);
 *   - two forgiven days are at least 7 days apart, so any 7-day window
 *     holds at most one;
 *   - a forgiven day keeps the streak alive but does not add to it: a
 *     "5-day streak" is five days that got something done;
 *   - TODAY IS NEVER A MISS while it is still today. Until it is active,
 *     the streak counts back from yesterday — and if yesterday was the
 *     missed day, it is forgiven provisionally: the streak is at risk, and
 *     one win today keeps it. (Tomorrow, two misses in a row end it.)
 *
 * The same rule gives each habit its own streak, over the days it was
 * ticked. "Best" is the longest streak inside the last 365 days.
 *
 * Days are 'YYYY-MM-DD' strings at the edges and whole day numbers (days
 * since 1970-01-01) inside, so a year of walking stays cheap.
 */

const DAY_RX = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** How far back a streak may look: best is "over the last 365 days". */
const WINDOW_DAYS = 365;

/** A real calendar date in 'YYYY-MM-DD' form (not 2026-02-30). */
function isDay(s) {
  if (typeof s !== "string" || !DAY_RX.test(s)) return false;
  const t = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** Day number (days since 1970-01-01) of a 'YYYY-MM-DD' string. */
const dayNum = (s) => Math.round(Date.parse(s + "T00:00:00Z") / DAY_MS);

/** 'YYYY-MM-DD' of a day number. */
const dayStr = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** The user's local date at epoch ms `ms`, for an offset in minutes east of UTC. */
function localDay(ms, tzOffsetMin = 0) {
  return new Date(Number(ms) + Number(tzOffsetMin || 0) * 60_000).toISOString().slice(0, 10);
}

/** The user's local hour (0-23) at `ms`. */
function localHour(ms, tzOffsetMin = 0) {
  return new Date(Number(ms) + Number(tzOffsetMin || 0) * 60_000).getUTCHours();
}

const addDays = (day, n) => dayStr(dayNum(day) + n);

/** 0 = Sunday … 6 = Saturday. */
const weekday = (day) => new Date(dayNum(day) * DAY_MS).getUTCDay();

/**
 * The streak that ends on day number `end`, walking back.
 *
 * @param {Set<number>} active  day numbers that got something done
 * @param {number} end          the last day of the run
 * @param {number} floor        the earliest day the walk may look at
 * @param {boolean} openEnd     `end` is yesterday and today is still open:
 *                              `end` itself may be the forgiven miss
 * @returns {{count:number, forgiven:number[]}}
 */
function walkBack(active, end, floor, openEnd = false) {
  let count = 0;
  const forgiven = [];
  for (let d = end; d >= floor; d--) {
    if (active.has(d)) {
      count++;
      continue;
    }
    const mayEndHere = count > 0 || (openEnd && d === end);
    const single = d - 1 >= floor && active.has(d - 1);
    const spaced = forgiven.every((f) => f - d >= 7);
    if (!mayEndHere || !single || !spaced) break;
    forgiven.push(d);
  }
  return { count, forgiven };
}

/**
 * Current streak as of `today` (a day number), over the active set.
 * @returns {{count:number, forgiven:number[], activeToday:boolean}}
 */
function currentStreak(active, today, floor = today - (WINDOW_DAYS - 1)) {
  const activeToday = active.has(today);
  const run = activeToday
    ? walkBack(active, today, floor)
    : walkBack(active, today - 1, floor, true);
  return { ...run, activeToday };
}

/**
 * The longest streak with every day inside [floor, today].
 *
 * Only runs that END on an active day followed by a non-active one (or on
 * today) need walking: a run ending on an earlier active day is the same
 * walk with one day fewer.
 */
function bestStreak(active, today, floor = today - (WINDOW_DAYS - 1)) {
  let best = 0;
  for (const e of active) {
    if (e < floor || e > today) continue;
    if (e !== today && active.has(e + 1)) continue;
    const { count } = walkBack(active, e, floor);
    if (count > best) best = count;
  }
  // The open-ended current streak can only be shorter than a closed walk
  // from its last active day, but taking it too keeps best >= current.
  return Math.max(best, currentStreak(active, today, floor).count);
}

/** Streak facts for one set of active day strings, as the summary reports them. */
function streakFacts(activeDays, todayStr) {
  const today = dayNum(todayStr);
  const active = new Set();
  for (const s of activeDays) if (isDay(s)) active.add(dayNum(s));
  const cur = currentStreak(active, today);
  return {
    current: cur.count,
    best: bestStreak(active, today),
    activeToday: cur.activeToday,
    graceUsedThisWeek: cur.forgiven.some((f) => f > today - 7),
    forgiven: cur.forgiven.map(dayStr),
  };
}

/** The seven days ending `todayStr`, oldest first. */
function last7(todayStr) {
  const t = dayNum(todayStr);
  return [6, 5, 4, 3, 2, 1, 0].map((k) => dayStr(t - k));
}

/* ------------------------------------------------------------------ *
 * A DAY'S LEDGER → ACTIVE DAYS, THE WEEK, MILESTONES
 * ------------------------------------------------------------------ */

/** Focus minutes a day needs before it counts on its own. */
const FOCUS_DAY_MIN = 10;

/**
 * Folds per-day facts into one ledger.
 * @param {object} p
 * @param {Object<string,number>} p.prioritiesDone  day → Today's-3 items ticked
 * @param {Object<string,number>} p.promisesKept    day → commitments kept
 * @param {Object<string,number>} p.habitChecks     day → habit ticks
 * @param {Object<string,number>} p.focusMin        day → focus minutes
 * @returns {Map<string,{wins:number,habits:number,focusMin:number,active:boolean}>}
 */
function ledger({ prioritiesDone = {}, promisesKept = {}, habitChecks = {}, focusMin = {} }) {
  const out = new Map();
  const at = (day) => {
    if (!out.has(day)) out.set(day, { wins: 0, habits: 0, focusMin: 0, active: false });
    return out.get(day);
  };
  for (const [d, n] of Object.entries(prioritiesDone)) at(d).wins += Number(n) || 0;
  for (const [d, n] of Object.entries(promisesKept)) at(d).wins += Number(n) || 0;
  for (const [d, n] of Object.entries(habitChecks)) at(d).habits += Number(n) || 0;
  for (const [d, n] of Object.entries(focusMin)) at(d).focusMin += Number(n) || 0;
  for (const v of out.values()) {
    v.active = v.wins > 0 || v.habits > 0 || v.focusMin >= FOCUS_DAY_MIN;
  }
  return out;
}

const activeDaysOf = (book) =>
  [...book.entries()].filter(([, v]) => v.active).map(([d]) => d);

/**
 * "Your week": the seven days ending today, oldest first, with totals.
 * `bestDay` is the day with the most wins; ties go to more focus, then to
 * more habits, then to the later day. Null for a week with nothing in it.
 */
function weekOf(book, todayStr, forgiven = []) {
  const forgivenSet = new Set(forgiven);
  const days = last7(todayStr).map((day) => {
    const v = book.get(day) || { wins: 0, habits: 0, focusMin: 0, active: false };
    return {
      day,
      active: v.active,
      wins: v.wins,
      focusMin: v.focusMin,
      habits: v.habits,
      forgiven: forgivenSet.has(day),
    };
  });
  const cmp = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  };
  let bestDay = null;
  let bestKey = null;
  for (const d of days) { // oldest first, so ">=" hands a full tie to the later day
    if (!d.wins && !d.focusMin && !d.habits) continue;
    const key = [d.wins, d.focusMin, d.habits];
    if (!bestKey || cmp(key, bestKey) >= 0) {
      bestKey = key;
      bestDay = d.day;
    }
  }
  return {
    days,
    wins: days.reduce((a, d) => a + d.wins, 0),
    focusMin: days.reduce((a, d) => a + d.focusMin, 0),
    habitsKept: days.reduce((a, d) => a + d.habits, 0),
    bestDay,
  };
}

const MILESTONES = [
  { id: "streak_3", label: "3-day streak", kind: "streak", n: 3 },
  { id: "streak_7", label: "7-day streak", kind: "streak", n: 7 },
  { id: "streak_14", label: "14-day streak", kind: "streak", n: 14 },
  { id: "streak_30", label: "30-day streak", kind: "streak", n: 30 },
  { id: "streak_50", label: "50-day streak", kind: "streak", n: 50 },
  { id: "streak_100", label: "100-day streak", kind: "streak", n: 100 },
  { id: "focus_10h", label: "10 hours of focus", kind: "focus", n: 600 },
  { id: "focus_50h", label: "50 hours of focus", kind: "focus", n: 3000 },
  { id: "focus_100h", label: "100 hours of focus", kind: "focus", n: 6000 },
  { id: "wins_50", label: "50 wins", kind: "wins", n: 50 },
];

/**
 * Which milestones are reached now. `kept` holds the ones reached before
 * ({id: day}), so a streak milestone stays earned after the streak that
 * earned it falls out of the 365-day window.
 * @returns {{list:Array, newly:Object<string,string>}}
 */
function milestones({ bestStreakDays = 0, focusTotalMin = 0, winsTotal = 0 }, todayStr, kept = {}) {
  const have = { streak: bestStreakDays, focus: focusTotalMin, wins: winsTotal };
  const newly = {};
  const list = MILESTONES.map((m) => {
    const reached = have[m.kind] >= m.n;
    if (reached && !kept[m.id]) newly[m.id] = todayStr;
    const earnedOn = kept[m.id] || (reached ? todayStr : null);
    return { id: m.id, label: m.label, earned: Boolean(earnedOn), earnedOn };
  });
  return { list, newly };
}

module.exports = {
  WINDOW_DAYS, FOCUS_DAY_MIN, MILESTONES,
  isDay, dayNum, dayStr, localDay, localHour, addDays, weekday, last7,
  walkBack, currentStreak, bestStreak, streakFacts,
  ledger, activeDaysOf, weekOf, milestones,
};
