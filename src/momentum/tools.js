/**
 * MOMENTUM BY VOICE — "my top three today are…", "done with the report",
 * "start a 25-minute focus", "how am I doing this week?".
 *
 * Owner, 2026-09-25: "plan and add some features that make much better
 * and keeps user motivated and productive". The same writes as the app's
 * Momentum card (service.js), so a list set by voice is the list on Home.
 *
 * WHAT THE PHONE HEARS. A write answers the app with a `momentum_updated`
 * notice so an open Home redraws at once; it asks the phone for nothing,
 * so it is marked `notice` and the write counts as finished (contract.js
 * outcomeOf). start_focus is a real device action: the phone opens the
 * Focus screen, which starts and logs the session itself — build 111+.
 * Older builds are sent neither: they would not know what to do with them.
 *
 * WHAT IT SAYS. Short and warm, never guilt: a zero is not read back as a
 * failing, and the owner is "Sir" or "Ma'am", never their name (owner.js).
 */
const svc = require("./service");
const S = require("./streak");
const { minutesText } = require("./nudges");
const { offsetOr } = require("../services/tz");

const APP_BUILD = 111;

/** Sent after a write, to builds that know it; nothing to older ones. */
function notice(ctx) {
  const build = Number(ctx && ctx.appBuild) || 0;
  return build && build < APP_BUILD ? undefined : { type: "momentum_updated", notice: true };
}

async function titleFor(userId) {
  try {
    const u = await require("../db").findById(userId);
    return require("../agents/owner").honorific(u || {});
  } catch (_) {
    return "Sir";
  }
}

const tzOf = (ctx) => offsetOr(ctx && ctx.tzOffsetMin);
const todayOf = (ctx) => S.localDay(Date.now(), tzOf(ctx));

/** A spoken phrase as a title: one line, 80 characters, cut at a word. */
function shortTitle(raw) {
  let t = String(raw ?? "").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  if (t.length > svc.MAX_TITLE) {
    t = t.slice(0, svc.MAX_TITLE + 1);
    const cut = t.lastIndexOf(" ");
    t = (cut > 40 ? t.slice(0, cut) : t.slice(0, svc.MAX_TITLE)).trim();
  }
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

/** "a", "a and b", "a, b and c" */
function listText(items) {
  const xs = items.map((x) => String(x));
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

const STOP = new Set(("the a an my to of for and or with on in at it this that is was " +
  "i me done did finished finish complete completed tick off mark just have has").split(" "));
const tokens = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9ऀ-෿\s]/g, " ")
  .split(/\s+/).filter((w) => w.length >= 2 && !STOP.has(w)).map((w) => w.replace(/s$/, ""));

/** The best match for spoken words among `items` by shared words; null if none or a tie. */
function matchByWords(words, items, textOf) {
  const want = new Set(tokens(words));
  if (!want.size) return null;
  let best = null;
  let bestScore = 0;
  let tie = false;
  for (const it of items) {
    const have = tokens(textOf(it));
    const score = have.filter((w) => want.has(w)).length;
    if (score > bestScore) {
      best = it;
      bestScore = score;
      tie = false;
    } else if (score && score === bestScore) {
      tie = true;
    }
  }
  return bestScore && !tie ? best : null;
}

const ORDINALS = [
  [/^(1|one|first|1st|top)$/, 0],
  [/^(2|two|second|2nd)$/, 1],
  [/^(3|three|third|3rd)$/, 2],
];

/** Index named by an ordinal ("second", "number 2", "the last one"), or null. */
function ordinalIndex(which, n) {
  let w = String(which || "").toLowerCase().replace(/[#.]/g, " ");
  w = w.replace(/\b(the|number|no|item|priority|task)\b/g, " ").replace(/\s+/g, " ").trim();
  w = w.replace(/^(first|second|third|last|final|1st|2nd|3rd) one$/, "$1");
  if (/^(last|final)$/.test(w)) return n ? n - 1 : null;
  for (const [rx, i] of ORDINALS) if (rx.test(w)) return i < n ? i : null;
  return null;
}

/** Emoji for a habit nobody picked one for. */
function emojiFor(title) {
  const t = String(title).toLowerCase();
  const pick = [
    [/water|drink|hydrat/, "💧"], [/walk|steps|run|jog/, "🚶"], [/read|book|pages/, "📖"],
    [/meditat|breath|pray|yoga|stretch/, "🧘"], [/gym|exercise|workout|push.?up|train/, "💪"],
    [/sleep|bed/, "😴"], [/journal|write|diary/, "✍️"], [/fruit|veg|salad|eat|diet/, "🍎"],
    [/study|learn|practi[cs]e|course/, "🎯"], [/call|family|mom|mum|dad|parent/, "📞"],
  ].find(([rx]) => rx.test(t));
  return pick ? pick[1] : "✅";
}

/** "7", "7am", "7:30 pm", "19:30", "07:00" → "HH:MM"; null if it is not a time. */
function parseTime(raw) {
  const s = String(raw ?? "").trim().toLowerCase().replace(/\./g, "");
  if (!s) return "";
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3] === "pm" && h !== 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** "9:00 am" for speech. */
function spokenTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The spoken answer to "how am I doing?" — two or three short sentences. */
function statusLine(s, title) {
  const bits = [];
  const st = s.streak;
  if (st.current >= 2 && st.activeToday) bits.push(`You're on a ${st.current}-day streak, ${title}.`);
  else if (st.current >= 2) bits.push(`${title}, one small win today keeps your ${st.current}-day streak going.`);
  else if (st.activeToday) bits.push(`You've started a streak today, ${title}.`);
  else bits.push(`${title}, one small win today starts a streak.`);

  const total = s.priorities.length;
  const done = s.priorities.filter((p) => p.done).length;
  const today = [];
  // Never "0 of 3": a list not started yet is a list, not a failing.
  if (total) today.push(done === total ? `all ${total} done` : done ? `${done} of ${total} done` : `${total} on your list`);
  if (s.focus.todayMin) today.push(`${minutesText(s.focus.todayMin)} of focus`);
  const habitsToday = s.habits.filter((h) => h.doneToday).length;
  if (habitsToday) today.push(`${habitsToday} of ${s.habits.length} habits`);
  if (today.length) bits.push(`Today: ${listText(today)}.`);
  if (!total) bits.push("No list for today yet — tell me three wins you want.");
  const next = s.priorities.find((p) => !p.done);
  if (next) bits.push(`Next up: ${lowerFirst(next.title)}.`);

  const w = s.week;
  const week = [];
  if (w.wins) week.push(`${w.wins} ${w.wins === 1 ? "win" : "wins"}`);
  if (w.focusMin) week.push(`${minutesText(w.focusMin)} of focus`);
  if (w.habitsKept) week.push(`${w.habitsKept} ${w.habitsKept === 1 ? "habit" : "habits"} kept`);
  if (week.length) {
    const best = w.bestDay ? (w.bestDay === s.day ? " Today is your best day." :
      ` ${DAY_NAMES[S.weekday(w.bestDay)]} was your best day.`) : "";
    bits.push(`This week: ${listText(week)}.${best}`);
  }
  return bits.join(" ");
}

function registerMomentumTools(registry) {
  registry.register({
    name: "plan_my_day",
    description:
      "TODAY'S 3 — set the user's top priorities for today, the three wins that would make " +
      "the day count: 'my top three today are…', 'today I want to finish the report, call " +
      "the bank and go for a walk', 'plan my day', 'my priorities for today', 'add X to " +
      "today's list'. Pass each as a short phrase in their words, most important first. " +
      "Adds to today's list; when they give a fresh list and today already has some, set " +
      "replace true. At most 3 a day — if they name more, ask which three matter most. " +
      "Home shows them with tick boxes. Not for anything with a time: 'remind me at 5' is " +
      "create_reminder.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        priorities: {
          type: "array",
          items: { type: "string" },
          description: "1 to 3 short phrases, most important first",
        },
        replace: {
          type: "boolean",
          description: "true to replace today's list instead of adding to it",
        },
      },
      required: ["priorities"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const uid = Number(ctx.userId);
      const day = todayOf(ctx);
      const seen = new Set();
      const asked = (args.priorities || []).map(shortTitle).filter((t) => {
        const k = t.toLowerCase();
        if (!t || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (!asked.length) return { ok: false, error: "no priorities given — ask what would make today a win" };
      if (asked.length > svc.MAX_PRIORITIES) {
        return {
          ok: false,
          error: `that is ${asked.length} — ask which three matter most today`,
          data: { heard: asked },
        };
      }
      const have = await svc.prioritiesFor(uid, day);
      const byTitle = new Map(have.map((p) => [p.title.toLowerCase(), p]));
      let items;
      if (args.replace || !have.length) {
        // A title said again keeps its tick, and what is already DONE
        // today stays: a fresh list replaces the unfinished ones, it does
        // not take back a win (or the day it made count).
        const said = new Set(asked.map((t) => t.toLowerCase()));
        const doneKept = have.filter((p) => Number(p.done) && !said.has(p.title.toLowerCase()));
        items = [
          ...asked.map((t) => ({ id: byTitle.get(t.toLowerCase())?.id ?? null, title: t })),
          ...doneKept.map((p) => ({ id: p.id, title: p.title })),
        ];
        if (items.length > svc.MAX_PRIORITIES) {
          return {
            ok: false,
            error: `${doneKept.length} of today's are already done (${doneKept.map((p) => `"${p.title}"`).join(", ")}) ` +
              `and stay; only ${svc.MAX_PRIORITIES - doneKept.length} more fit — ask which`,
            data: { done: doneKept.map((p) => p.title) },
          };
        }
      } else {
        const fresh = asked.filter((t) => !byTitle.has(t.toLowerCase()));
        if (have.length + fresh.length > svc.MAX_PRIORITIES) {
          return {
            ok: false,
            error: `today already has ${have.length}: ${have.map((p) => `"${p.title}"`).join(", ")} — ` +
              "ask whether to replace them (replace true) or which to drop",
            data: { today: have.map((p) => p.title) },
          };
        }
        items = [
          ...have.map((p) => ({ id: p.id, title: p.title })),
          ...fresh.map((t) => ({ id: null, title: t })),
        ];
      }
      try {
        await svc.setPriorities(uid, day, items);
      } catch (e) {
        if (e instanceof svc.MomentumError) return { ok: false, error: e.message };
        throw e;
      }
      const title = await titleFor(uid);
      const names = items.map((i) => lowerFirst(i.title));
      const speak = items.length === 1
        ? `Got it, ${title}. Today's priority: ${names[0]}.`
        : `Got it, ${title}. Today's ${items.length === 3 ? "three" : "two"}: ${listText(names)}.`;
      return {
        ok: true,
        speak,
        data: { day, priorities: items.map((i) => i.title) },
        deviceAction: notice(ctx),
      };
    },
  });

  registry.register({
    name: "complete_priority",
    description:
      "Tick off one of TODAY'S 3 priorities — 'I finished the report', 'done with the first " +
      "one', 'tick off the bank call', 'mark number two done', 'I did all three'. `which` is " +
      "a number or ordinal (1, 'second', 'last'), 'all', or words from the priority. " +
      "done false unticks it. A PROMISE made to someone is complete_commitment; a reminder " +
      "is update_reminder.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        which: { type: "string", description: "1-3, 'first'/'second'/'last', 'all', or words from it" },
        done: { type: "boolean", description: "false to untick it; default true" },
      },
      required: ["which"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const uid = Number(ctx.userId);
      const tz = tzOf(ctx);
      const day = todayOf(ctx);
      const done = args.done !== false;
      const list = await svc.prioritiesFor(uid, day);
      if (!list.length) {
        return { ok: false, error: "no priorities are set for today — offer to set them (plan_my_day)" };
      }
      const which = String(args.which || "").trim();
      let targets;
      if (/^(all|all of them|all three|everything|both)$/i.test(which)) {
        targets = list;
      } else {
        const i = ordinalIndex(which, list.length);
        const hit = i !== null ? list[i] : matchByWords(which, list, (p) => p.title);
        if (!hit) {
          return {
            ok: false,
            error: `not sure which one — today's list is ${list.map((p, k) => `${k + 1}. ${p.title}`).join("; ")}. ` +
              "Ask which, or if it was a promise use complete_commitment",
            data: { today: list.map((p) => p.title) },
          };
        }
        targets = [hit];
      }
      const title = await titleFor(uid);
      if (targets.length === 1 && Boolean(Number(targets[0].done)) === done) {
        return {
          ok: true,
          speak: done ? `That one's already ticked off, ${title}.` : `That one isn't ticked, ${title}.`,
          data: { title: targets[0].title, done },
        };
      }
      for (const p of targets) await svc.patchPriority(uid, p.id, { done }, { tz });
      const after = await svc.prioritiesFor(uid, day);
      const n = after.filter((p) => Number(p.done)).length;
      const speak = !done
        ? `Unticked ${lowerFirst(targets[0].title)}, ${title}.`
        : n === after.length
          ? `That's all ${after.length} done, ${title} — a winning day.`
          : `Ticked off ${lowerFirst(targets[0].title)}. ${n} of ${after.length} done, ${title}.`;
      return {
        ok: true,
        speak,
        data: { done: n, total: after.length, ticked: targets.map((p) => p.title) },
        deviceAction: notice(ctx),
      };
    },
  });

  registry.register({
    name: "add_habit",
    description:
      "Start tracking a small DAILY HABIT — 'track drinking water', 'add a habit to walk 20 " +
      "minutes', 'I want to read 10 pages every day', 'help me build a habit of meditating, " +
      "remind me at 7 am'. Habits sit on Home as chips to tick each day, each with its own " +
      "streak. remind_at is an optional daily reminder time as 24-hour 'HH:MM' ('07:00', " +
      "'21:30'). At most 12 habits.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The habit, short: 'Drink water', 'Read 10 pages'" },
        emoji: { type: "string", description: "One emoji for it. Optional." },
        remind_at: { type: "string", description: "Daily reminder time, 24-hour 'HH:MM'. Optional." },
      },
      required: ["title"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const uid = Number(ctx.userId);
      const name = shortTitle(args.title);
      if (!name) return { ok: false, error: "no habit given — ask what they want to do each day" };
      const remindAt = parseTime(args.remind_at);
      if (remindAt === null) {
        return { ok: false, error: `"${args.remind_at}" is not a time — ask again, or pass remind_at as HH:MM` };
      }
      const title = await titleFor(uid);
      const habits = await svc.activeHabits(uid);
      const twin = habits.find((h) => h.title.toLowerCase() === name.toLowerCase());
      if (twin) {
        return { ok: true, speak: `You're already tracking ${lowerFirst(twin.title)}, ${title}.`, data: { id: Number(twin.id) } };
      }
      let id;
      try {
        id = await svc.addHabit(uid, {
          title: name,
          emoji: args.emoji ? String(args.emoji).trim().slice(0, 16) : emojiFor(name),
          remindAt,
        });
      } catch (e) {
        if (e instanceof svc.MomentumError) {
          return {
            ok: false,
            error: e.status === 409
              ? `they already track ${habits.length} habits — ask which one to drop first`
              : e.message,
            data: { habits: habits.map((h) => h.title) },
          };
        }
        throw e;
      }
      const build = Number(ctx.appBuild) || 0;
      const reminder = !remindAt ? ""
        : build && build < APP_BUILD
          ? " The daily reminder needs the latest app update."
          : ` I'll remind you at ${spokenTime(remindAt)} every day.`;
      return {
        ok: true,
        speak: `Added ${lowerFirst(name)} to your habits, ${title}.${reminder}`,
        data: { id, title: name, remindAt: remindAt || null },
        deviceAction: notice(ctx),
      };
    },
  });

  registry.register({
    name: "check_habit",
    description:
      "Tick off one of the user's HABITS for today — 'I drank my water', 'done my walk', " +
      "'mark reading done', 'I meditated'. `habit` is words from the habit's name. done " +
      "false unticks it. If they have no such habit, offer to add it (add_habit).",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        habit: { type: "string", description: "Words from the habit's name" },
        done: { type: "boolean", description: "false to untick it; default true" },
      },
      required: ["habit"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const uid = Number(ctx.userId);
      const tz = tzOf(ctx);
      const day = todayOf(ctx);
      const done = args.done !== false;
      const habits = await svc.activeHabits(uid);
      if (!habits.length) {
        return { ok: false, error: "they track no habits yet — offer to add this one (add_habit)" };
      }
      const hit = habits.length === 1 && !tokens(args.habit).length
        ? habits[0]
        : matchByWords(args.habit, habits, (h) => h.title);
      if (!hit) {
        return {
          ok: false,
          error: `no habit like "${args.habit}" — they track ${habits.map((h) => h.title).join(", ")}. ` +
            "Ask which, or offer to add it",
          data: { habits: habits.map((h) => h.title) },
        };
      }
      await svc.checkHabit(uid, hit.id, { day, done }, { tz });
      const s = await svc.summary(uid, day, { tz });
      const h = s.habits.find((x) => x.id === Number(hit.id));
      const title = await titleFor(uid);
      const speak = !done
        ? `Unticked ${lowerFirst(hit.title)} for today, ${title}.`
        : h && h.streak >= 2
          ? `Ticked off ${lowerFirst(hit.title)} — ${h.streak} days running, ${title}.`
          : `Ticked off ${lowerFirst(hit.title)} for today, ${title}.`;
      return {
        ok: true,
        speak,
        data: { habit: hit.title, done, streak: h ? h.streak : 0 },
        deviceAction: notice(ctx),
      };
    },
  });

  registry.register({
    name: "start_focus",
    // The Focus screen ships in app build 111; an older app would drop
    // the action after the assistant had said the timer was running.
    minAppBuild: APP_BUILD,
    deviceAction: true,
    description:
      "Start a FOCUS SESSION — a calm countdown for deep work on the phone: 'start a " +
      "25-minute focus on the report', 'focus mode for an hour', 'pomodoro', 'help me " +
      "concentrate for 45 minutes'. Opens the focus timer; the minutes are logged when it " +
      "ends and a break is offered. minutes 5 to 180 (default 25); label is what they are " +
      "focusing on, if they said. A plain countdown ('set a timer for 10 minutes') is " +
      "set_timer.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        minutes: { type: "integer", description: "5 to 180; default 25" },
        label: { type: "string", description: "What they are focusing on. Optional." },
      },
    },
    async execute(args) {
      const minutes = args.minutes === undefined ? 25 : Math.round(Number(args.minutes));
      if (!Number.isFinite(minutes) || minutes < svc.FOCUS_MIN || minutes > svc.FOCUS_MAX) {
        return { ok: false, error: `a focus session runs ${svc.FOCUS_MIN} to ${svc.FOCUS_MAX} minutes` };
      }
      const label = shortTitle(args.label || "");
      return {
        ok: true,
        deviceAction: { type: "start_focus", minutes, label },
        speak: `Starting a ${minutes}-minute focus${label ? ` on ${lowerFirst(label)}` : ""}. ` +
          "I'll let you know when it's time for a break.",
      };
    },
  });

  registry.register({
    name: "momentum_status",
    description:
      "How the user is doing — their STREAK, today's 3, focus time, habits and the week: " +
      "'how am I doing this week?', 'what's my streak?', 'how productive was I today?', " +
      "'what's left on my list today?', 'my progress'. Read-only.",
    risk: "low",
    inputSchema: { type: "object", properties: {} },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const uid = Number(ctx.userId);
      const s = await svc.summary(uid, todayOf(ctx), { tz: tzOf(ctx) });
      const title = await titleFor(uid);
      return {
        ok: true,
        speak: statusLine(s, title),
        data: {
          streak: s.streak,
          today: {
            done: s.priorities.filter((p) => p.done).map((p) => p.title),
            left: s.priorities.filter((p) => !p.done).map((p) => p.title),
            habits: s.habits.map((h) => ({ title: h.title, done: h.doneToday, streak: h.streak })),
            focusMin: s.focus.todayMin,
          },
          week: { wins: s.week.wins, focusMin: s.week.focusMin, habitsKept: s.week.habitsKept, bestDay: s.week.bestDay },
        },
      };
    },
  });
}

module.exports = {
  registerMomentumTools, statusLine, parseTime, ordinalIndex, matchByWords, shortTitle, emojiFor, notice,
  APP_BUILD,
};
