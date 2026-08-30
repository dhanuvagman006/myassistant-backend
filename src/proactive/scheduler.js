/**
 * PROACTIVE — the things Hari does without being asked.
 *
 * Everything else in this codebase is reactive: the user speaks, Hari
 * answers. This is the half that makes an assistant feel like staff rather
 * than a search box — the nudge before a promise slips, the briefing before
 * a meeting starts.
 *
 * THREE SWEEPS, one timer:
 *
 *   commitments  Something the user promised is coming due. Nudge once,
 *                well before the deadline, naming the person it is owed to.
 *
 *   meetings     A calendar event starts soon. Push a brief: who they are
 *                meeting, their case file, what was last discussed, and
 *                anything still owed to them.
 *
 *   fares        A watched flight route is re-priced; alert on a real drop
 *                or when the user's target is met.
 *
 * THE RULE THAT MAKES PROACTIVE TOLERABLE: never interrupt twice for the
 * same thing. A commitment carries `nudged_at`; a meeting brief records the
 * event id in `kv`. An assistant that repeats itself gets its
 * notifications turned off, and then the useful one never arrives either.
 *
 * QUIET HOURS are respected for anything non-urgent — a 3am nudge about
 * Friday's proposal is a reason to uninstall.
 */
const { query, one, run } = require("../db");
const push = require("../services/push");
const commitments = require("../commitments/service");

const SWEEP_MS = Number(process.env.PROACTIVE_SWEEP_MS || 10 * 60 * 1000);
const QUIET_START = Number(process.env.QUIET_HOURS_START || 22); // 22:00
const QUIET_END = Number(process.env.QUIET_HOURS_END || 7); //  07:00
const MEETING_LEAD_MS = Number(process.env.MEETING_BRIEF_LEAD_MS || 25 * 60 * 1000);

let timer = null;

/** Local hour for a user, from their stored tz offset (defaults to IST). */
function localHour(tzOffsetMin = 330) {
  return new Date(Date.now() + tzOffsetMin * 60_000).getUTCHours();
}

function inQuietHours(tzOffsetMin) {
  const h = localHour(tzOffsetMin);
  return QUIET_START > QUIET_END
    ? h >= QUIET_START || h < QUIET_END
    : h >= QUIET_START && h < QUIET_END;
}

/* ------------------------------------------------------------------ *
 * SWEEP 1 — COMMITMENT NUDGES
 * ------------------------------------------------------------------ */

async function sweepCommitments() {
  let due = [];
  try {
    due = await commitments.dueSoon({ withinMs: 4 * 60 * 60 * 1000 });
  } catch (_) {
    return 0;
  }

  let sent = 0;
  for (const c of due) {
    if (!c.fcm_token) {
      // No device registered. Still mark it, or the row is re-examined on
      // every sweep forever.
      await commitments.markNudged(c.id).catch(() => {});
      continue;
    }
    if (inQuietHours(330)) continue; // try again after quiet hours

    const overdue = Number(c.due_at) < Date.now();
    const who = c.owed_to ? ` to ${c.owed_to}` : "";
    try {
      await push.sendNotification(
        c.fcm_token,
        overdue ? "Overdue" : "Due soon",
        `You said you'd ${lowerFirst(c.text)}${who}.`
      );
      await commitments.markNudged(c.id);
      sent++;
    } catch (_) {}
  }
  return sent;
}

function lowerFirst(s) {
  const t = String(s || "").trim();
  return t ? t[0].toLowerCase() + t.slice(1) : t;
}

/* ------------------------------------------------------------------ *
 * SWEEP 2 — PRE-MEETING BRIEFS
 * ------------------------------------------------------------------ */

/**
 * Users with Google linked AND a device to notify. Anyone else cannot be
 * briefed, so they are never scanned — this keeps the sweep proportional
 * to the users who can actually benefit rather than to the whole table.
 */
async function briefableUsers() {
  return query(
    `SELECT u.id, u.fcm_token
       FROM users u JOIN google_tokens g ON g.user_id = u.id
      WHERE u.fcm_token IS NOT NULL AND u.fcm_token <> ''
      LIMIT 200`
  ).catch(() => []);
}

async function alreadyBriefed(userId, eventId) {
  const k = `brief:${userId}:${eventId}`;
  const row = await one(`SELECT v FROM kv WHERE k=$1`, [k]).catch(() => null);
  return Boolean(row);
}

async function markBriefed(userId, eventId) {
  const k = `brief:${userId}:${eventId}`;
  await run(
    `INSERT INTO kv (k, v) VALUES ($1,$2) ON CONFLICT (k) DO NOTHING`,
    [k, String(Date.now())]
  ).catch(() => {});
}

/**
 * Builds the brief for one meeting: the case file, the last thing
 * discussed, and anything still owed to them.
 *
 * Everything here comes from data the user already gave us. Nothing is
 * inferred about the other party.
 */
async function buildBrief(userId, event) {
  const parts = [];
  const names = (event.attendees || []).filter(Boolean);

  // The person's own file, if they are a client/patient the user keeps.
  for (const name of names.slice(0, 2)) {
    const bare = String(name).split("@")[0].replace(/[._]/g, " ").trim();
    const client = await one(
      `SELECT id, name, summary FROM clients
        WHERE user_id=$1 AND lower(name) LIKE $2 LIMIT 1`,
      [userId, `%${bare.toLowerCase()}%`]
    ).catch(() => null);
    if (!client) continue;

    if (client.summary) parts.push(`${client.name}: ${client.summary}`);
    const note = await one(
      `SELECT note FROM client_notes WHERE client_id=$1 ORDER BY id DESC LIMIT 1`,
      [client.id]
    ).catch(() => null);
    if (note?.note) parts.push(`Last note: ${String(note.note).slice(0, 160)}`);
  }

  // Anything the user promised these people and hasn't done — the single
  // most useful thing to know walking into a room.
  if (names.length) {
    const owed = await query(
      `SELECT text, owed_to FROM commitments
        WHERE user_id=$1 AND status='open'
          AND owed_to <> '' AND (${names.map((_, i) => `lower($${i + 2}) LIKE '%' || lower(owed_to) || '%'`).join(" OR ")})
        LIMIT 3`,
      [userId, ...names.map((n) => String(n))]
    ).catch(() => []);
    for (const o of owed) parts.push(`You owe ${o.owed_to}: ${o.text}`);
  }

  return parts;
}

async function sweepMeetings() {
  const users = await briefableUsers();
  if (!users.length) return 0;

  const gapi = require("../google/api");
  let sent = 0;

  for (const u of users) {
    let prep;
    try {
      prep = await gapi.meetingPrep(u.id);
    } catch (_) {
      continue;
    }
    if (!prep?.event?.start) continue;

    const startsIn = new Date(prep.event.start).getTime() - Date.now();
    // Only the window just before it starts. Too early and it is forgotten;
    // after it starts it is useless.
    if (startsIn <= 0 || startsIn > MEETING_LEAD_MS) continue;
    if (await alreadyBriefed(u.id, prep.event.id)) continue;

    const extra = await buildBrief(u.id, prep.event);
    const mins = Math.max(1, Math.round(startsIn / 60000));
    const withWho = prep.event.attendees?.length
      ? ` with ${prep.event.attendees.slice(0, 2).join(", ")}`
      : "";

    const body =
      extra.length
        ? extra.join(" · ").slice(0, 480)
        : prep.emails?.length
          ? `Recent: ${prep.emails[0].subject}`
          : "No notes on file.";

    try {
      await push.sendNotification(
        u.fcm_token,
        `${prep.event.title} in ${mins} min${withWho}`,
        body
      );
      await markBriefed(u.id, prep.event.id);
      sent++;
    } catch (_) {}
  }
  return sent;
}

/* ------------------------------------------------------------------ *
 * SWEEP 4 — THE MORNING BRIEF
 * ------------------------------------------------------------------ */
// One push at the start of the user's day: agenda, unread messages,
// promises still open, weather. The same aggregation the home dashboard
// and the spoken daily_brief use (services/brief.js) — three views, one
// truth. Delivered once per LOCAL day (kv key morning:{uid}:{date}), only
// inside the delivery window, and only when there is actually something
// to say — a daily push about an empty day trains the user to swipe
// every notification away, including the ones that matter.
// Tune with MORNING_BRIEF_HOUR (default 8, local) and
// MORNING_BRIEF_WINDOW_H (default 3); disable with MORNING_BRIEF=off.

const MORNING_HOUR = Number(process.env.MORNING_BRIEF_HOUR || 8);
const MORNING_WINDOW_H = Number(process.env.MORNING_BRIEF_WINDOW_H || 3);

/** Minutes east of UTC for a user row; tolerates empty/IANA values. */
function tzOffsetOf(u) {
  const n = Number(u?.timezone);
  return Number.isFinite(n) && Math.abs(n) <= 840 ? n : 330;
}

function localDateKey(tzOffsetMin) {
  return new Date(Date.now() + tzOffsetMin * 60_000).toISOString().slice(0, 10);
}

function hhmmLocal(ms, tzOffsetMin) {
  const d = new Date(ms + tzOffsetMin * 60_000);
  const h24 = d.getUTCHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m} ${h24 < 12 ? "am" : "pm"}`;
}

/** Compact push body from a Today brief. Exported for tests. */
function morningBody(b, tzOffsetMin) {
  const bits = [];
  if (b.agenda.length) {
    const first = b.agenda[0];
    const at = first.at ? ` at ${hhmmLocal(first.at, tzOffsetMin)}` : "";
    bits.push(
      `${b.agenda.length} on your plate — first: ${first.title}${at}`
    );
  }
  if (b.messages.length) {
    bits.push(
      `${b.messages.length} message${b.messages.length === 1 ? "" : "s"} waiting (${b.messages[0].from})`
    );
  }
  if (b.promises.length) bits.push(`You owe: ${b.promises[0].text}`);
  if (b.weather_line) bits.push(b.weather_line);
  return bits.join(" · ").slice(0, 320);
}

async function sweepMorningBriefs() {
  if (process.env.MORNING_BRIEF === "off") return 0;

  const users = await query(
    `SELECT id, name, fcm_token, timezone FROM users
      WHERE fcm_token IS NOT NULL AND fcm_token <> '' LIMIT 500`
  ).catch(() => []);
  if (!users.length) return 0;

  const { buildBrief } = require("../services/brief");
  let sent = 0;

  for (const u of users) {
    const tz = tzOffsetOf(u);
    const h = localHour(tz);
    if (h < MORNING_HOUR || h >= MORNING_HOUR + MORNING_WINDOW_H) continue;
    if (inQuietHours(tz)) continue;

    const k = `morning:${u.id}:${localDateKey(tz)}`;
    const seen = await one(`SELECT v FROM kv WHERE k=$1`, [k]).catch(() => null);
    if (seen) continue;

    let b;
    try {
      b = await buildBrief(u.id, { tzOffsetMin: tz });
    } catch (_) {
      continue;
    }

    // Mark the day either way: an empty morning stays quiet, and a
    // reminder added at 09:30 belongs to the day already underway, not to
    // a late duplicate push.
    await run(
      `INSERT INTO kv (k, v) VALUES ($1,$2) ON CONFLICT (k) DO NOTHING`,
      [k, String(Date.now())]
    ).catch(() => {});

    if (!b.agenda.length && !b.messages.length && !b.promises.length) continue;

    const first = u.name ? String(u.name).split(" ")[0] : null;
    try {
      const ok = await push.sendNotification(
        u.fcm_token,
        first ? `Good morning, ${first} ☀️` : "Good morning ☀️",
        morningBody(b, tz) || "Your day is ready — tap for your brief."
      );
      if (ok) sent++;
    } catch (_) {}
  }
  return sent;
}

/* ------------------------------------------------------------------ */

/** SWEEP 3 — fare watches. Re-prices routes the user is waiting on. */
async function sweepFares() {
  try {
    const out = await require("../travel/fares").sweep();
    return out.alerts || 0;
  } catch (_) {
    return 0;
  }
}

async function sweep() {
  const results = await Promise.allSettled([
    sweepCommitments(),
    sweepMeetings(),
    sweepFares(),
    sweepMorningBriefs(),
  ]);
  const [nudges, briefs, fares, mornings] = results.map((r) =>
    r.status === "fulfilled" ? r.value : 0
  );
  if (nudges || briefs || fares || mornings) {
    console.log(
      `proactive: ${nudges} nudge(s), ${briefs} brief(s), ${fares} fare alert(s), ${mornings} morning brief(s)`
    );
  }
  return { nudges, briefs, fares, mornings };
}

function start() {
  if (timer) return;
  // A failing sweep must never take the process down — it is background
  // work, and the assistant keeps answering either way.
  timer = setInterval(() => {
    sweep().catch((e) => console.error("proactive sweep failed:", e.message));
  }, SWEEP_MS);
  timer.unref?.();
  console.log(`  proactive: sweeping every ${Math.round(SWEEP_MS / 60000)} min`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  start, stop, sweep,
  sweepCommitments, sweepMeetings, sweepFares, sweepMorningBriefs,
  buildBrief, morningBody,
  inQuietHours, localHour,
};
