/**
 * MOMENTUM — `npm run test:momentum`.
 *
 * Owner, 2026-09-25: "plan and add some features that make much better
 * and keeps user motivated and productive". These pin:
 *   (a) the streak rules, pure: what counts, the one forgiven day a week,
 *       today never being a miss, the best of the last 365 days, local
 *       dates, milestones;
 *   (b) the routes against a real database: the summary's shape, the
 *       limits, other people's ids, moving to tomorrow, habit ticks,
 *       focus sessions, promises kept, every write answering with the
 *       fresh summary;
 *   (c) the voice tools, their spoken lines and the build gates;
 *   (d) the nudge rules and the sweep: one a day, never in quiet hours,
 *       only for people who use it.
 *
 * Nothing leaves the machine: no push is sent (the sweep's sender is a
 * stub) and no model is called.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const assert = require("assert");
const express = require("express");
const S = require("../src/momentum/streak");
const nudges = require("../src/momentum/nudges");

let passed = 0;
async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

/** A set of active day numbers from strings. */
const days = (...xs) => new Set(xs.map(S.dayNum));
/** Day string k days before `base`. */
const back = (base, k) => S.addDays(base, -k);

(async () => {
  /* ================================================================ *
   * (a) THE RULES
   * ================================================================ */
  console.log("\nlocal dates");

  await atest("dates are real calendar dates in YYYY-MM-DD", () => {
    assert.ok(S.isDay("2026-09-25"));
    assert.ok(!S.isDay("2026-02-30"));
    assert.ok(!S.isDay("2026-9-5"));
    assert.ok(!S.isDay("25-09-2026"));
    assert.ok(!S.isDay(null));
    assert.strictEqual(S.addDays("2026-12-31", 1), "2027-01-01");
    assert.strictEqual(S.addDays("2024-03-01", -1), "2024-02-29");
    assert.strictEqual(S.weekday("2026-09-27"), 0, "27 Sep 2026 is a Sunday");
  });

  await atest("a day is the user's own date, not the server's", () => {
    const t = Date.parse("2026-09-25T20:00:00Z");
    assert.strictEqual(S.localDay(t, 0), "2026-09-25");
    assert.strictEqual(S.localDay(t, 330), "2026-09-26", "01:30 in India is already tomorrow");
    assert.strictEqual(S.localDay(Date.parse("2026-09-26T03:00:00Z"), -300), "2026-09-25",
      "22:00 in New York is still today");
    assert.strictEqual(S.localHour(t, 330), 1);
  });

  console.log("\nthe streak");
  const T = "2026-09-25";
  const t = S.dayNum(T);

  await atest("consecutive days count, and today counts once it is active", () => {
    const a = days(T, back(T, 1), back(T, 2), back(T, 3));
    const c = S.currentStreak(a, t);
    assert.strictEqual(c.count, 4);
    assert.strictEqual(c.activeToday, true);
    assert.deepStrictEqual(c.forgiven, []);
  });

  await atest("today is never a miss while it is still today", () => {
    const a = days(back(T, 1), back(T, 2), back(T, 3));
    const c = S.currentStreak(a, t);
    assert.strictEqual(c.count, 3, "the streak stands on yesterday");
    assert.strictEqual(c.activeToday, false);
  });

  await atest("one missed day is forgiven, and does not add to the count", () => {
    const a = days(T, back(T, 2), back(T, 3));
    const c = S.currentStreak(a, t);
    assert.strictEqual(c.count, 3);
    assert.deepStrictEqual(c.forgiven.map(S.dayStr), [back(T, 1)]);
  });

  await atest("two misses in a row end it", () => {
    const a = days(T, back(T, 3), back(T, 4));
    assert.strictEqual(S.currentStreak(a, t).count, 1);
  });

  await atest("at most one forgiven day in any 7 days", () => {
    // misses 2 and 6 days ago: 4 apart, so the second ends the streak
    const a = days(T, back(T, 1), back(T, 3), back(T, 4), back(T, 5), back(T, 7), back(T, 8));
    const c = S.currentStreak(a, t);
    assert.strictEqual(c.count, 5, "today, 1, 3, 4, 5 — the miss at 6 is not forgiven");
    // misses exactly 7 days apart: both forgiven
    const b = new Set();
    for (let k = 0; k <= 16; k++) if (k !== 2 && k !== 9) b.add(t - k);
    const d = S.currentStreak(b, t);
    assert.strictEqual(d.count, 15);
    assert.deepStrictEqual(d.forgiven.map((f) => t - f), [2, 9]);
  });

  await atest("yesterday's miss is forgiven while today can still save it", () => {
    const facts = S.streakFacts([back(T, 2), back(T, 3), back(T, 4)], T);
    assert.strictEqual(facts.current, 3, "the streak is at risk, not gone");
    assert.strictEqual(facts.activeToday, false);
    assert.strictEqual(facts.graceUsedThisWeek, true, "the week's grace is spent");
    assert.deepStrictEqual(facts.forgiven, [back(T, 1)]);
    // Tomorrow, with nothing done today either, it is over.
    const tomorrow = S.addDays(T, 1);
    assert.strictEqual(S.streakFacts([back(T, 2), back(T, 3), back(T, 4)], tomorrow).current, 0);
  });

  await atest("a streak cannot end on its forgiven day", () => {
    // Active 5..3 days ago, missed 2 and 1: not a streak any more.
    assert.strictEqual(S.currentStreak(days(back(T, 3), back(T, 4), back(T, 5)), t).count, 0);
  });

  await atest("nothing at all is a streak of zero, with no grace spent", () => {
    const f = S.streakFacts([], T);
    assert.deepStrictEqual(
      { c: f.current, b: f.best, a: f.activeToday, g: f.graceUsedThisWeek },
      { c: 0, b: 0, a: false, g: false });
  });

  await atest("best is the longest run in the last 365 days, and never below current", () => {
    const a = new Set();
    for (let k = 40; k < 60; k++) a.add(t - k); // 20 days, a month and a half ago
    for (let k = 0; k < 4; k++) a.add(t - k); // 4 now
    assert.strictEqual(S.bestStreak(a, t), 20);
    const old = new Set();
    for (let k = 370; k < 400; k++) old.add(t - k); // 30 days, over a year ago
    old.add(t);
    assert.strictEqual(S.bestStreak(old, t), 1, "a run older than 365 days does not count");
    const f = S.streakFacts([T, back(T, 1)], T);
    assert.ok(f.best >= f.current);
  });

  await atest("best finds a run a greedy scan would split", () => {
    // A x A A A x A (oldest → newest): only one of the two misses can be
    // forgiven, either way 4 active days.
    const a = days(back(T, 6), back(T, 4), back(T, 3), back(T, 2), T);
    assert.strictEqual(S.bestStreak(a, t), 4);
  });

  console.log("\nwhat counts as a day");

  await atest("a win, a habit, 10 minutes of focus or a promise kept makes a day", () => {
    const book = S.ledger({
      prioritiesDone: { "2026-09-20": 1 },
      habitChecks: { "2026-09-21": 2 },
      focusMin: { "2026-09-22": 10, "2026-09-23": 9 },
      promisesKept: { "2026-09-24": 1 },
    });
    assert.deepStrictEqual(S.activeDaysOf(book).sort(),
      ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-24"]);
    assert.strictEqual(book.get("2026-09-23").active, false, "9 minutes is not a day");
    assert.strictEqual(book.get("2026-09-24").wins, 1, "a promise kept is a win");
  });

  await atest("the week: seven days, oldest first, totals and the best day", () => {
    const book = S.ledger({
      prioritiesDone: { "2026-09-23": 3, "2026-09-25": 3 },
      focusMin: { "2026-09-23": 25, "2026-09-25": 50 },
      habitChecks: { "2026-09-19": 1, "2026-09-24": 2 },
    });
    const w = S.weekOf(book, "2026-09-25", ["2026-09-22"]);
    assert.deepStrictEqual(w.days.map((d) => d.day),
      ["2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"]);
    assert.strictEqual(w.wins, 6);
    assert.strictEqual(w.focusMin, 75);
    assert.strictEqual(w.habitsKept, 3);
    assert.strictEqual(w.bestDay, "2026-09-25", "tie on wins → more focus");
    assert.strictEqual(w.days[3].forgiven, true);
    assert.strictEqual(S.weekOf(S.ledger({}), "2026-09-25").bestDay, null, "an empty week has no best day");
  });

  await atest("milestones: thresholds, and once reached they stay reached", () => {
    const m = S.milestones({ bestStreakDays: 7, focusTotalMin: 600, winsTotal: 49 }, T);
    const earned = m.list.filter((x) => x.earned).map((x) => x.id);
    assert.deepStrictEqual(earned, ["streak_3", "streak_7", "focus_10h"]);
    assert.deepStrictEqual(Object.keys(m.newly), ["streak_3", "streak_7", "focus_10h"]);
    assert.deepStrictEqual(m.list.map((x) => x.id), [
      "streak_3", "streak_7", "streak_14", "streak_30", "streak_50", "streak_100",
      "focus_10h", "focus_50h", "focus_100h", "wins_50"]);
    const later = S.milestones({ bestStreakDays: 2, focusTotalMin: 600, winsTotal: 50 }, "2027-11-01",
      { streak_3: "2026-09-25", streak_7: "2026-09-25", focus_10h: "2026-09-25" });
    const s7 = later.list.find((x) => x.id === "streak_7");
    assert.strictEqual(s7.earned, true, "a streak milestone does not un-earn itself");
    assert.strictEqual(s7.earnedOn, "2026-09-25");
    assert.deepStrictEqual(later.newly, { wins_50: "2027-11-01" });
  });

  console.log("\nthe nudges");
  const base = {
    hour: 20, weekday: 3, sentToday: false, usedRecently: true,
    priorities: { total: 3, done: 2 }, streak: { current: 5, activeToday: true },
    week: { wins: 0, focusMin: 0, habitsKept: 0, bestDay: null },
  };
  const env = { QUIET_HOURS_START: "22", QUIET_HOURS_END: "7" };

  await atest("8 pm: today's list is not all done", () => {
    const n = nudges.pickNudge(base, env);
    assert.strictEqual(n.kind, "evening");
    assert.strictEqual(n.body, "2 of 3 done — finish one more, or move it to tomorrow?");
    assert.strictEqual(nudges.pickNudge({ ...base, priorities: { total: 3, done: 3 } }, env), null,
      "all done: nothing to say");
    assert.strictEqual(nudges.pickNudge({ ...base, priorities: { total: 0, done: 0 } }, env), null);
    const none = nudges.pickNudge({ ...base, priorities: { total: 2, done: 0 },
      streak: { current: 1, activeToday: false } }, env);
    assert.ok(!/\b0 of\b/.test(none.body), "a zero is never read back to them");
  });

  await atest("9 pm: a streak of 3+ with nothing done today", () => {
    const g = { ...base, hour: 21, streak: { current: 5, activeToday: false } };
    const n = nudges.pickNudge(g, env);
    assert.strictEqual(n.kind, "streak");
    assert.strictEqual(n.body, "One small win keeps your 5-day streak going.");
    assert.strictEqual(nudges.pickNudge({ ...g, streak: { current: 2, activeToday: false } }, env), null);
    assert.strictEqual(nudges.pickNudge({ ...g, streak: { current: 9, activeToday: true } }, env), null);
  });

  await atest("Sunday 7 pm: the week, and nothing for an empty week", () => {
    const w = { ...base, hour: 19, weekday: 0,
      week: { wins: 14, focusMin: 190, habitsKept: 12, bestDay: "2026-09-23" } };
    const n = nudges.pickNudge(w, env);
    assert.strictEqual(n.kind, "weekly");
    assert.strictEqual(n.body, "This week: 14 wins, 3 h 10 min of focus, 12 habits kept. Best day: Wednesday.");
    assert.strictEqual(nudges.pickNudge({ ...w, week: { wins: 0, focusMin: 0, habitsKept: 0 } }, env), null);
    assert.strictEqual(nudges.pickNudge({ ...w, weekday: 3 }, env), null, "only on Sunday");
  });

  await atest("one a day, never in quiet hours, only for people who use it, and a switch", () => {
    assert.strictEqual(nudges.pickNudge({ ...base, sentToday: true }, env), null);
    assert.strictEqual(nudges.pickNudge({ ...base, usedRecently: false }, env), null);
    assert.strictEqual(nudges.pickNudge(base, { ...env, QUIET_HOURS_START: "20" }), null);
    assert.strictEqual(nudges.pickNudge(base, { ...env, MOMENTUM_NUDGES: "off" }), null);
    assert.strictEqual(nudges.enabled({}), true, "on by default");
    assert.strictEqual(nudges.pickNudge({ ...base, hour: 15 }, env), null);
  });

  await atest("the sweep sends at most one a day per user, claimed before sending", async () => {
    const at = Date.parse("2026-09-23T14:40:00Z"); // 20:10 in India, a Wednesday
    const claimed = new Set();
    const sent = [];
    const deps = {
      candidates: async () => [
        { id: 1, fcm_token: "t1", tz_offset_min: 330 },
        { id: 2, fcm_token: "t2", tz_offset_min: 330 },
        { id: 3, fcm_token: "t3", tz_offset_min: 0 }, // 14:40 in London: no window
      ],
      sentToday: async (uid, day) => claimed.has(`${uid}:${day}`),
      claim: async (uid, day) => {
        if (claimed.has(`${uid}:${day}`)) return false;
        claimed.add(`${uid}:${day}`);
        return true;
      },
      summary: async (uid) => ({
        priorities: uid === 1
          ? [{ done: true }, { done: false }, { done: false }]
          : [{ done: true }],
        streak: { current: 4, activeToday: true },
        week: { wins: 1, focusMin: 0, habitsKept: 0, bestDay: null },
      }),
      send: async (u, n) => { sent.push({ uid: u.id, kind: n.kind, body: n.body }); return true; },
    };
    assert.strictEqual(await nudges.sweep({ now: at, deps, env }), 1);
    assert.deepStrictEqual(sent, [{ uid: 1, kind: "evening",
      body: "1 of 3 done — finish one more, or move the rest to tomorrow?" }]);
    // Ten minutes later: already sent today.
    assert.strictEqual(await nudges.sweep({ now: at + 600_000, deps, env }), 0);
    // And at 21:10, when the guard would fire, the day's one push is spent.
    deps.summary = async () => ({ priorities: [], streak: { current: 6, activeToday: false },
      week: { wins: 0, focusMin: 0, habitsKept: 0 } });
    assert.strictEqual(await nudges.sweep({ now: at + 3600_000, deps, env }), 1, "user 2 gets the guard");
    assert.strictEqual(sent[1].uid, 2);
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(await nudges.sweep({ now: at, deps, env: { ...env, MOMENTUM_NUDGES: "0" } }), 0);
  });

  /* ================================================================ *
   * (b) THE ROUTES, AGAINST THE DATABASE
   * ================================================================ */
  const db = require("../src/db");
  await db.init();
  const svc = require("../src/momentum/service");
  const stamp = String(Date.now()).slice(-8);
  const mkUser = async (tag, gender = null) =>
    (await db.createUser({ email: `momentum-${tag}-${stamp}@example.test`, name: `Priya ${tag}`, gender })).id;
  const A = await mkUser("a");
  const B = await mkUser("b", "female");
  const C = await mkUser("c");
  const users = [A, B, C];

  const app = express();
  app.use(express.json());
  app.use("/momentum", (req, _res, next) => {
    req.user = { sub: String(req.get("x-test-user") || "") };
    next();
  }, require("../src/momentum/routes"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/momentum`;
  const TZ = 330;
  const today = S.localDay(Date.now(), TZ);
  const tomorrow = S.addDays(today, 1);
  const api = async (method, path, body, user = A, q = `?day=${today}`) => {
    const r = await fetch(`${baseUrl}${path}${q}`, {
      method,
      headers: { "content-type": "application/json", "x-test-user": String(user), "x-tz-offset": String(TZ) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  console.log("\nthe summary");

  await atest("an empty account has the whole shape, with seven days in every row", async () => {
    const { status, body: s } = await api("GET", "");
    assert.strictEqual(status, 200);
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.day, today);
    assert.deepStrictEqual(s.priorities, []);
    assert.deepStrictEqual(s.habits, []);
    assert.deepStrictEqual(s.focus, { todayMin: 0, weekMin: 0, totalMin: 0 });
    assert.deepStrictEqual(s.streak, { current: 0, best: 0, activeToday: false, graceUsedThisWeek: false });
    assert.strictEqual(s.week.days.length, 7);
    assert.strictEqual(s.week.days[6].day, today, "oldest first, ending today");
    for (const d of s.week.days) {
      for (const k of ["day", "active", "wins", "focusMin"]) assert.ok(k in d, `week day has ${k}`);
    }
    for (const k of ["wins", "focusMin", "habitsKept", "bestDay"]) assert.ok(k in s.week, `week has ${k}`);
    assert.strictEqual(s.milestones.length, 10);
    assert.deepStrictEqual(Object.keys(s.milestones[0]).slice(0, 3), ["id", "label", "earned"]);
  });

  await atest("a bad day or no account is refused", async () => {
    assert.strictEqual((await api("GET", "", undefined, A, "?day=2026-13-01")).status, 400);
    assert.strictEqual((await api("GET", "", undefined, "", "")).status, 401);
    const noDay = await api("GET", "", undefined, A, "");
    assert.strictEqual(noDay.body.day, today, "no ?day= means today by their clock");
  });

  console.log("\nToday's 3");
  let ids;

  await atest("set today's three; every write answers with the fresh summary", async () => {
    const r = await api("PUT", "/priorities", { day: today, items: [
      { title: "Finish the report" }, { title: "  Call   the bank " }, { title: "Walk 30 minutes" }] });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.priorities.map((p) => [p.title, p.done, p.position]),
      [["Finish the report", false, 0], ["Call the bank", false, 1], ["Walk 30 minutes", false, 2]]);
    assert.ok(r.body.streak && r.body.week && r.body.milestones, "the whole summary comes back");
    ids = r.body.priorities.map((p) => p.id);
  });

  await atest("limits: three a day, 80 characters, a real day", async () => {
    const four = await api("PUT", "/priorities", { day: today,
      items: [{ title: "a" }, { title: "b" }, { title: "c" }, { title: "d" }] });
    assert.strictEqual(four.status, 400);
    assert.match(four.body.error, /at most 3/);
    const long = await api("PUT", "/priorities", { day: today, items: [{ title: "x".repeat(81) }] });
    assert.strictEqual(long.status, 400);
    assert.match(long.body.error, /too long/);
    assert.strictEqual((await api("PUT", "/priorities", { day: "tomorrow", items: [] })).status, 400);
    assert.strictEqual((await api("PUT", "/priorities", { day: today, items: [{ title: "  " }] })).status, 400);
    const after = await api("GET", "");
    assert.strictEqual(after.body.priorities.length, 3, "a refused write changed nothing");
  });

  await atest("ticking one makes today count, and the tick survives a rewrite of the list", async () => {
    const r = await api("PATCH", `/priorities/${ids[0]}`, { done: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.priorities[0].done, true);
    assert.strictEqual(r.body.streak.activeToday, true);
    assert.strictEqual(r.body.streak.current, 1);
    assert.strictEqual(r.body.week.days[6].wins, 1);
    // Rename the second, drop the third, add a new one: the tick stays.
    const w = await api("PUT", "/priorities", { day: today, items: [
      { id: ids[0], title: "Finish the report" }, { id: ids[1], title: "Call the bank about the loan" },
      { title: "Book the dentist" }] });
    assert.strictEqual(w.status, 200);
    assert.deepStrictEqual(w.body.priorities.map((p) => [p.title, p.done]),
      [["Finish the report", true], ["Call the bank about the loan", false], ["Book the dentist", false]]);
    ids = w.body.priorities.map((p) => p.id);
    const row = await db.one(`SELECT done_day FROM momentum_priorities WHERE id = $1`, [ids[0]]);
    assert.strictEqual(row.done_day, today, "credited to the day it was ticked");
  });

  await atest("move to tomorrow, and a full tomorrow says so", async () => {
    const r = await api("PATCH", `/priorities/${ids[2]}`, { day: tomorrow });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.priorities.length, 2, "gone from today");
    const t2 = await api("GET", "", undefined, A, `?day=${tomorrow}`);
    assert.deepStrictEqual(t2.body.priorities.map((p) => p.title), ["Book the dentist"]);
    await api("PUT", "/priorities", { day: tomorrow, items: [
      { id: t2.body.priorities[0].id, title: "Book the dentist" }, { title: "Plan the trip" }, { title: "Gym" }] });
    const full = await api("PATCH", `/priorities/${ids[1]}`, { day: tomorrow });
    assert.strictEqual(full.status, 409);
    assert.match(full.body.error, /already has 3/);
  });

  await atest("rename, untick and delete", async () => {
    let r = await api("PATCH", `/priorities/${ids[1]}`, { title: "Call the bank" });
    assert.strictEqual(r.body.priorities[1].title, "Call the bank");
    assert.strictEqual((await api("PATCH", `/priorities/${ids[1]}`, { done: "yes" })).status, 400);
    r = await api("DELETE", `/priorities/${ids[1]}`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.priorities.map((p) => p.title), ["Finish the report"]);
    assert.strictEqual((await api("DELETE", `/priorities/${ids[1]}`)).status, 404, "already gone");
  });

  await atest("someone else's ids are not found", async () => {
    assert.strictEqual((await api("PATCH", `/priorities/${ids[0]}`, { done: false }, B)).status, 404);
    assert.strictEqual((await api("DELETE", `/priorities/${ids[0]}`, undefined, B)).status, 404);
    const put = await api("PUT", "/priorities", { day: today, items: [{ id: ids[0], title: "mine now" }] }, B);
    assert.strictEqual(put.status, 404);
    assert.strictEqual((await api("PATCH", `/priorities/abc`, { done: true })).status, 404);
    const mine = await api("GET", "");
    assert.strictEqual(mine.body.priorities[0].title, "Finish the report");
    assert.strictEqual(mine.body.priorities[0].done, true, "B could not untick A's");
  });

  console.log("\nhabits");
  let water;

  await atest("add, tick, untick; each habit has its own streak and seven dots", async () => {
    const r = await api("POST", "/habits", { title: "Drink water", emoji: "💧", remindAt: "09:00" });
    assert.strictEqual(r.status, 200);
    water = r.body.habitId;
    assert.ok(Number.isInteger(water));
    const h = r.body.habits.find((x) => x.id === water);
    assert.deepStrictEqual(
      { t: h.title, e: h.emoji, r: h.remindAt, d: h.doneToday, s: h.streak, n: h.last7.length },
      { t: "Drink water", e: "💧", r: "09:00", d: false, s: 0, n: 7 });
    // Ticked yesterday and the day before (fixing forgotten ticks), then today.
    await api("PUT", `/habits/${water}/check`, { day: back(today, 2), done: true });
    await api("PUT", `/habits/${water}/check`, { day: back(today, 1), done: true });
    const t = await api("PUT", `/habits/${water}/check`, { day: today, done: true });
    const w = t.body.habits.find((x) => x.id === water);
    assert.strictEqual(w.doneToday, true);
    assert.strictEqual(w.streak, 3);
    assert.deepStrictEqual(w.last7, [false, false, false, false, true, true, true]);
    const again = await api("PUT", `/habits/${water}/check`, { day: today, done: true });
    assert.strictEqual(again.status, 200, "ticking twice is harmless");
    const un = await api("PUT", `/habits/${water}/check`, { day: today, done: false });
    assert.strictEqual(un.body.habits.find((x) => x.id === water).doneToday, false);
    await api("PUT", `/habits/${water}/check`, { day: today, done: true });
  });

  await atest("habit limits: a real time, the last week only, twelve at most", async () => {
    assert.strictEqual((await api("POST", "/habits", { title: "Read", remindAt: "9am" })).status, 400);
    assert.strictEqual((await api("POST", "/habits", { title: "" })).status, 400);
    assert.strictEqual((await api("PUT", `/habits/${water}/check`, { day: back(today, 9), done: true })).status, 400);
    assert.strictEqual((await api("PUT", `/habits/${water}/check`, { day: today })).status, 400);
    for (let i = 0; i < 11; i++) {
      const r = await api("POST", "/habits", { title: `Habit ${i}` }, C);
      assert.strictEqual(r.status, 200, r.body.error);
    }
    const twelfth = await api("POST", "/habits", { title: "Habit 11" }, C);
    assert.strictEqual(twelfth.status, 200);
    const thirteenth = await api("POST", "/habits", { title: "One too many" }, C);
    assert.strictEqual(thirteenth.status, 409);
    assert.match(thirteenth.body.error, /12/);
  });

  await atest("rename and remove; a removed habit's days stay in the streak", async () => {
    const before = (await api("GET", "")).body.streak;
    let r = await api("PATCH", `/habits/${water}`, { title: "Water, 8 glasses", remindAt: "" });
    const h = r.body.habits.find((x) => x.id === water);
    assert.strictEqual(h.title, "Water, 8 glasses");
    assert.strictEqual(h.remindAt, null);
    assert.strictEqual((await api("PATCH", `/habits/${water}`, {}, B)).status, 404);
    assert.strictEqual((await api("PUT", `/habits/${water}/check`, { day: today, done: true }, B)).status, 404);
    r = await api("DELETE", `/habits/${water}`);
    assert.strictEqual(r.status, 200);
    assert.ok(!r.body.habits.some((x) => x.id === water));
    assert.deepStrictEqual(r.body.streak, before, "archiving never rewrites the streak");
    assert.strictEqual((await api("DELETE", `/habits/${water}`)).status, 404);
    assert.strictEqual((await api("PUT", `/habits/${water}/check`, { day: today, done: true })).status, 404);
  });

  console.log("\nfocus");

  await atest("5 to 180 minutes; the minutes done are logged", async () => {
    assert.strictEqual((await api("POST", "/focus", { plannedMin: 4 })).status, 400);
    assert.strictEqual((await api("POST", "/focus", { plannedMin: 181 })).status, 400);
    assert.strictEqual((await api("POST", "/focus", { plannedMin: 25.5 })).status, 400);
    const s = await api("POST", "/focus", { plannedMin: 25, label: "The report" }, B);
    assert.strictEqual(s.status, 200);
    const fid = s.body.focusId;
    assert.ok(Number.isInteger(fid));
    assert.strictEqual(s.body.streak.activeToday, false, "a session started is not yet a day");
    assert.strictEqual((await api("PATCH", `/focus/${fid}`, { actualMin: 25, completed: true }, A)).status, 404,
      "not A's session");
    assert.strictEqual((await api("PATCH", `/focus/${fid}`, { actualMin: -1, completed: true }, B)).status, 400);
    const f = await api("PATCH", `/focus/${fid}`, { actualMin: 30, completed: true }, B);
    assert.strictEqual(f.status, 200);
    assert.deepStrictEqual(f.body.focus, { todayMin: 30, weekMin: 30, totalMin: 30 });
    assert.strictEqual(f.body.streak.activeToday, true, "10+ minutes of focus makes the day");
    const row = await db.one(`SELECT planned_min, actual_min, completed, ended_at FROM momentum_focus WHERE id = $1`, [fid]);
    assert.deepStrictEqual([row.planned_min, row.actual_min, row.completed], [25, 30, 1]);
    assert.ok(row.ended_at > 0);
  });

  await atest("a session ended early still counts the minutes it ran", async () => {
    const s = await api("POST", "/focus", { plannedMin: 45 }, C);
    const f = await api("PATCH", `/focus/${s.body.focusId}`, { actualMin: 12, completed: false }, C);
    assert.strictEqual(f.body.focus.todayMin, 12);
    assert.strictEqual(f.body.streak.activeToday, true);
  });

  console.log("\nhistory, promises and milestones");

  await atest("a promise kept counts as a win and a day", async () => {
    const at = Date.now();
    await db.run(`INSERT INTO commitments (user_id, text, status, created_at, updated_at)
                  VALUES ($1, 'Send Ravi the deck', 'done', $2, $2)`, [C, at]);
    const s = (await api("GET", "", undefined, C)).body;
    assert.strictEqual(s.week.days[6].wins, 1);
    assert.strictEqual(s.streak.activeToday, true);
  });

  await atest("a week of history: the streak, its forgiven day, best and milestones", async () => {
    // Priorities done on six of the last eight days, missing 3 days ago.
    for (const k of [1, 2, 4, 5, 6, 7]) {
      const d = back(today, k);
      await db.run(`INSERT INTO momentum_priorities (user_id, day, position, title, done, done_day, done_at, created_at, updated_at)
                    VALUES ($1, $2, 0, 'Old win', 1, $2, 0, 0, 0)`, [B, d]);
    }
    const s = (await api("GET", "", undefined, B)).body;
    assert.strictEqual(s.streak.activeToday, true, "B focused today");
    assert.strictEqual(s.streak.current, 7, "today + 1, 2, 4, 5, 6, 7 — 3 days ago forgiven");
    assert.strictEqual(s.streak.graceUsedThisWeek, true);
    assert.strictEqual(s.week.days.find((d) => d.day === back(today, 3)).forgiven, true);
    assert.strictEqual(s.streak.best, 7);
    const earned = s.milestones.filter((m) => m.earned).map((m) => m.id);
    assert.deepStrictEqual(earned, ["streak_3", "streak_7"]);
    const kept = await db.one(`SELECT v FROM kv WHERE k = $1`, [`momentum:${B}:earned`]);
    assert.deepStrictEqual(Object.keys(JSON.parse(kept.v)).sort(), ["streak_3", "streak_7"]);
    // Over a year later the streak itself is out of the window; the
    // milestone it earned is not.
    const later = (await api("GET", "", undefined, B, `?day=${S.addDays(today, 400)}`)).body;
    assert.strictEqual(later.streak.best, 0);
    assert.ok(later.milestones.find((m) => m.id === "streak_7").earned, "milestones are kept");
  });

  /* ================================================================ *
   * (c) THE VOICE TOOLS
   * ================================================================ */
  console.log("\nby voice");
  const registry = require("../src/tools/registry");
  require("../src/tools/builtins").registerBuiltins();
  registry.seal();
  const contract = require("../src/tools/contract");
  const run = (name, args, ctx = {}) =>
    registry.get(name).execute(registry.coerceArgs(registry.get(name), args),
      { userId: C, tzOffsetMin: TZ, appBuild: 111, ...ctx });
  await db.run(`DELETE FROM momentum_priorities WHERE user_id = $1`, [C]);

  await atest("plan_my_day sets today's list and says it back, as Sir, never by name", async () => {
    const r = await run("plan_my_day", { priorities: ["finish the report.", "call the bank", "a 30 minute walk"] });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.speak, "Got it, Sir. Today's three: finish the report, call the bank and a 30 minute walk.");
    assert.ok(!/Priya/.test(r.speak));
    assert.deepStrictEqual(r.deviceAction, { type: "momentum_updated", notice: true });
    assert.strictEqual(contract.outcomeOf(r), contract.OUTCOME.OK, "a notice is not a dispatch");
    const list = await svc.prioritiesFor(C, today);
    assert.deepStrictEqual(list.map((p) => p.title), ["Finish the report", "Call the bank", "A 30 minute walk"]);
  });

  await atest("plan_my_day: more than three, or a full day, is a question", async () => {
    const four = await run("plan_my_day", { priorities: ["a", "b", "c", "d"] });
    assert.strictEqual(four.ok, false);
    assert.match(four.error, /which three/);
    const full = await run("plan_my_day", { priorities: ["Pay rent"] });
    assert.strictEqual(full.ok, false);
    assert.match(full.error, /already has 3/);
    assert.strictEqual((await svc.prioritiesFor(C, today)).length, 3);
  });

  await atest("complete_priority by number, by words, and all of them", async () => {
    let r = await run("complete_priority", { which: "second" });
    assert.strictEqual(r.speak, "Ticked off call the bank. 1 of 3 done, Sir.");
    r = await run("complete_priority", { which: "I finished the report" });
    assert.match(r.speak, /Ticked off finish the report\. 2 of 3 done/);
    r = await run("complete_priority", { which: "the report" });
    assert.match(r.speak, /already ticked off/);
    r = await run("complete_priority", { which: "the gym thing" });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /1\. Finish the report/);
  });

  await atest("a fresh list replaces the unfinished ones and never takes back a win", async () => {
    const r = await run("plan_my_day", { priorities: ["Finish the report", "Pay rent"], replace: true });
    assert.strictEqual(r.ok, true, r.error);
    const list = await svc.prioritiesFor(C, today);
    assert.deepStrictEqual(list.map((p) => [p.title, Number(p.done)]),
      [["Finish the report", 1], ["Pay rent", 0], ["Call the bank", 1]],
      "the walk (not started) went; the bank call (done) stayed");
    const all = await run("complete_priority", { which: "all" });
    assert.strictEqual(all.speak, "That's all 3 done, Sir — a winning day.");
    const over = await run("plan_my_day", { priorities: ["Gym", "Groceries"], replace: true });
    assert.strictEqual(over.ok, false);
    assert.match(over.error, /3 of today's are already done/);
  });

  await atest("add_habit: a spoken time, a sensible emoji, no twins, and Ma'am for her", async () => {
    await db.run(`UPDATE momentum_habits SET archived = 1 WHERE user_id = $1`, [B]);
    const r = await run("add_habit", { title: "drink more water", remind_at: "9 am" }, { userId: B });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.speak, "Added drink more water to your habits, Ma'am. I'll remind you at 9 am every day.");
    const h = (await svc.activeHabits(B))[0];
    assert.deepStrictEqual([h.title, h.emoji, h.remind_at], ["Drink more water", "💧", "09:00"]);
    const twin = await run("add_habit", { title: "Drink more water" }, { userId: B });
    assert.match(twin.speak, /already tracking/);
    assert.strictEqual((await run("add_habit", { title: "Read", remind_at: "half past" }, { userId: B })).ok, false);
    const old = await run("add_habit", { title: "Stretch", remind_at: "19:30" }, { userId: B, appBuild: 110 });
    assert.match(old.speak, /needs the latest app update/);
    assert.strictEqual(old.deviceAction, undefined, "an older app is sent nothing new");
    const full = await run("add_habit", { title: "Yet another" });
    assert.strictEqual(full.ok, false);
    assert.match(full.error, /drop/);
  });

  await atest("check_habit by words, with the days running", async () => {
    const r = await run("check_habit", { habit: "water" }, { userId: B });
    assert.strictEqual(r.ok, true, r.error);
    assert.match(r.speak, /^Ticked off drink more water for today, Ma'am\.$/);
    const miss = await run("check_habit", { habit: "gym" }, { userId: B });
    assert.strictEqual(miss.ok, false);
    assert.match(miss.error, /Drink more water/);
  });

  await atest("start_focus: 25 by default, 5 to 180, and only for build 111+", async () => {
    const r = await run("start_focus", {});
    assert.deepStrictEqual(r.deviceAction, { type: "start_focus", minutes: 25, label: "" });
    assert.strictEqual(contract.outcomeOf(r), contract.OUTCOME.DISPATCHED, "the phone has not answered yet");
    const l = await run("start_focus", { minutes: 45, label: "the quarterly report" });
    assert.strictEqual(l.speak, "Starting a 45-minute focus on the quarterly report. I'll let you know when it's time for a break.");
    assert.strictEqual((await run("start_focus", { minutes: 200 })).ok, false);
    assert.strictEqual(registry.get("start_focus").minAppBuild, 111);
    const names = (build) => registry.declarations({ deviceCaps: { build } }).map((d) => d.name);
    assert.ok(!names(110).includes("start_focus"), "an older app is not offered it");
    assert.ok(names(111).includes("start_focus"));
    assert.ok(names(110).includes("plan_my_day"), "the list itself works on any build");
  });

  await atest("momentum_status: streak, today and the week, gently", async () => {
    const r = await run("momentum_status", {});
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.speak,
      "You've started a streak today, Sir. Today: all 3 done and 12 min of focus. " +
      "This week: 4 wins and 12 min of focus. Today is your best day.");
    // A list not started is not read back as a zero.
    await run("plan_my_day", { priorities: ["Gym", "Groceries"] }, { userId: A });
    await db.run(`UPDATE momentum_priorities SET done = 0 WHERE user_id = $1`, [A]);
    const a = await run("momentum_status", {}, { userId: A });
    assert.match(a.speak, /Today: 3 on your list/);
    assert.match(a.speak, /Next up: finish the report\./);
    assert.ok(!/\b0 of\b|failed|missed/i.test(a.speak), a.speak);
    const fresh = await mkUser("d");
    users.push(fresh);
    const empty = await run("momentum_status", {}, { userId: fresh });
    assert.strictEqual(empty.speak,
      "Sir, one small win today starts a streak. No list for today yet — tell me three wins you want.");
  });

  await atest("open_app_screen opens Momentum and Focus on build 111, not before", async () => {
    const tool = registry.get("open_app_screen");
    assert.ok(tool.inputSchema.properties.screen.enum.includes("momentum"));
    assert.ok(tool.inputSchema.properties.screen.enum.includes("focus"));
    const ok = await tool.execute({ screen: "momentum" }, { appBuild: 111 });
    assert.deepStrictEqual(ok.deviceAction, { type: "open_app_screen", screen: "momentum" });
    const old = await tool.execute({ screen: "focus" }, { appBuild: 109 });
    assert.strictEqual(old.ok, false);
    assert.match(old.error, /update/);
  });

  await atest("the writes are world actions the claim check can see", () => {
    for (const n of ["plan_my_day", "complete_priority", "add_habit", "check_habit", "start_focus"]) {
      assert.ok(registry.isWorldAction(n), `${n} is not a world action`);
    }
    assert.ok(!registry.isWorldAction("momentum_status"), "a read is not");
    const cc = require("../src/agents/claimCheck");
    const cases = [
      ["I've set today's three for you.", "plan_my_day"],
      ["Opening your focus timer now.", "start_focus"],
      ["I've set a 25-minute focus session.", "start_focus"],
      ["Logged your water for today.", "check_habit"],
      ["I've saved that to your habits.", "add_habit"],
    ];
    for (const [said, tool] of cases) {
      assert.strictEqual(cc.check(said, [{ tool, ok: true }]).ok, true, `"${said}" contradicted despite ${tool}`);
      assert.strictEqual(cc.check(said, []).ok, false, `"${said}" with nothing run must be corrected`);
    }
  });

  await atest("the four tables and the nudge keys go with the account", () => {
    const privacy = require("../src/routes/privacy");
    const listed = new Set(privacy.USER_TABLES.map(([t, c]) => `${t}.${c}`));
    for (const t of ["momentum_priorities", "momentum_habits", "momentum_habit_checks", "momentum_focus"]) {
      assert.ok(listed.has(`${t}.user_id`), `${t} is not erased or exported`);
    }
    assert.strictEqual(typeof require("../src/proactive/scheduler").sweepMomentum, "function");
  });

  // Tidy up after ourselves.
  server.close();
  for (const u of users) {
    for (const t of ["momentum_priorities", "momentum_habits", "momentum_habit_checks", "momentum_focus", "commitments"]) {
      await db.run(`DELETE FROM ${t} WHERE user_id = $1`, [u]);
    }
    await db.run(`DELETE FROM kv WHERE k LIKE $1`, [`momentum:${u}:%`]);
    await db.run(`DELETE FROM users WHERE id = $1`, [u]);
  }
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
