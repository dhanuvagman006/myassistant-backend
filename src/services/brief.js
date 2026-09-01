/**
 * TODAY BRIEF — one aggregation for the busy professional's home screen
 * and for the spoken "give me my brief" (the daily_brief tool).
 *
 * Composes, per user:
 *   • agenda    — open reminders (due soon or undated) + today's calendar
 *                 events when Google is linked, time-sorted
 *   • promises  — open commitments Hari heard the user make
 *   • messages  — UNREAD agent-to-agent messages (preview only: they are
 *                 marked read exclusively when a live session speaks them,
 *                 so the dashboard must never consume them)
 *   • people    — contacts who are verified app users ("your circle")
 *   • weather   — one line for the header chip
 *   • headlines — three top headlines (free Google News RSS)
 *
 * Every branch is independent and optional: one failed source removes its
 * section, never the brief. Nothing here writes anything.
 */
const db = require("../db");
const reminders = require("../reminders/store");

const DAY_MS = 24 * 3600 * 1000;

function localParts(ms, tzOffsetMin) {
  const d = new Date(ms + tzOffsetMin * 60_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate(), wd: d.getUTCDay() };
}

/// "due today" / "due tomorrow" / "due Mon" / "overdue" for a chip.
function dueLabel(dueMs, tzOffsetMin, now = Date.now()) {
  if (!Number.isFinite(dueMs)) return null;
  if (dueMs < now - 60_000) return "overdue";
  const a = localParts(now, tzOffsetMin);
  const b = localParts(dueMs, tzOffsetMin);
  const days = Math.round(
    (Date.UTC(b.y, b.m, b.day) - Date.UTC(a.y, a.m, a.day)) / DAY_MS
  );
  if (days <= 0) return "due today";
  if (days === 1) return "due tomorrow";
  if (days < 7) {
    return "due " + ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][b.wd];
  }
  return null;
}

async function agendaOf(uid, tzOffsetMin) {
  const out = [];
  const now = Date.now();

  try {
    const rows = await reminders.list(uid);
    for (const r of rows) {
      if (r.done) continue;
      const due = Number(r.due_at);
      // Show what needs attention NOW: overdue, next 36 hours, or undated.
      if (Number.isFinite(due) && due > 0 && due - now > 36 * 3600_000) continue;
      out.push({
        kind: "reminder",
        id: r.id,
        title: String(r.text || "").slice(0, 140),
        at: Number.isFinite(due) && due > 0 ? due : null,
      });
    }
  } catch (_) {}

  // Calendar only when the user linked Google; null means not linked.
  try {
    const gapi = require("../google/api");
    const events = await gapi.upcomingEvents(uid, { days: 1, max: 8 });
    for (const e of events || []) {
      const at = Date.parse(e.start);
      out.push({
        kind: "meeting",
        title:
          String(e.title || "Meeting").slice(0, 120) +
          (e.location ? ` · ${String(e.location).slice(0, 40)}` : ""),
        at: Number.isFinite(at) ? at : null,
      });
    }
  } catch (_) {}

  // Timed first (soonest up), undated last.
  out.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  return out.slice(0, 10);
}

async function promisesOf(uid, tzOffsetMin) {
  try {
    const rows = await require("../commitments/service").list(uid, {
      status: "open",
      limit: 6,
    });
    return rows.map((c) => ({
      id: c.id,
      text:
        (c.owed_to ? `To ${c.owed_to}: ` : "") +
        String(c.text || "").slice(0, 140),
      due_label: dueLabel(Number(c.due_at), tzOffsetMin),
    }));
  } catch (_) {
    return [];
  }
}

/// Unread inbox PREVIEW. Read-only by design — see the module comment.
async function messagesOf(phoneNumber) {
  if (!phoneNumber) return [];
  try {
    const rows = await db.query(
      `SELECT m.message, u.name AS from_name
         FROM agent_messages m
         LEFT JOIN users u ON u.id = m.from_user_id
        WHERE m.status = 'unread' AND m.to_phone_number = $1
        ORDER BY m.created_at DESC LIMIT 4`,
      [phoneNumber]
    );
    return rows.map((r) => ({
      from: r.from_name || "Someone",
      text: String(r.message || "").slice(0, 160),
    }));
  } catch (_) {
    return [];
  }
}

/// Contacts who are verified users of the app — the user's reachable
/// circle (their assistant can deliver messages to these people).
async function peopleOf(uid) {
  try {
    const rows = await db.query(
      `SELECT c.name, c.phone
         FROM contacts c
         JOIN users u ON u.phone_number = c.phone
                     AND u.phone_verified_at IS NOT NULL
        WHERE c.user_id = $1 AND u.id <> $1
        ORDER BY c.name ASC LIMIT 24`,
      [uid]
    );
    return rows.map((r) => ({
      name: String(r.name || "").slice(0, 60),
      phone: String(r.phone || ""),
    }));
  } catch (_) {
    return [];
  }
}

/// Yesterday's screen time in one line ("4h 10m yesterday · most: YouTube
/// 2h 5m"), or null until the phone has synced any usage data.
async function screenTimeOf(uid) {
  try {
    const { usageOf } = require("../routes/usage");
    const rows = await usageOf(uid, { days: 2 });
    const y = new Date(Date.now() - 24 * 3600_000);
    const day = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
    const yest = rows.filter((r) => r.day === day);
    if (!yest.length) return null;
    const total = yest.reduce((s, r) => s + r.minutes, 0);
    const top = yest[0];
    const fmt = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
    return `${fmt(total)} yesterday · most: ${top.app_name} ${fmt(top.minutes)}`;
  } catch (_) {
    return null;
  }
}

async function weatherLineOf({ lat, lng, city }) {
  try {
    const weather = require("./tools/weather");
    const w = await weather.getWeather({ lat, lng, city });
    if (!w?.current) return null;
    const t = Math.round(w.current.tempC);
    const cond = String(w.current.condition || "").replace(/^\w/, (c) =>
      c.toUpperCase()
    );
    return `${cond} · ${t}°C`;
  } catch (_) {
    return null;
  }
}

async function headlinesOf() {
  try {
    const news = require("./tools/news");
    const items = await news.getHeadlines({ max: 3 });
    return (items || []).map((h) => ({
      title: String(h.title || "").slice(0, 140),
      source: String(h.source || "").slice(0, 40),
      url: String(h.link || "").slice(0, 500),
    }));
  } catch (_) {
    return [];
  }
}

/**
 * @param {number} uid   verified positive user id
 * @param {{lat?:number,lng?:number,tzOffsetMin?:number}} opts
 */
async function buildBrief(uid, opts = {}) {
  const tz = Number.isFinite(opts.tzOffsetMin) ? opts.tzOffsetMin : 330;

  let profile = null;
  try {
    profile = await require("../users/context").getProfile(uid);
  } catch (_) {}

  const city =
    !Number.isFinite(opts.lat) && profile?.user?.location
      ? String(profile.user.location)
      : undefined;

  const [agenda, promises, messages, people, weather_line, headlines, screen_time] =
    await Promise.all([
      agendaOf(uid, tz),
      promisesOf(uid, tz),
      messagesOf(profile?.user?.phone_number || null),
      peopleOf(uid),
      weatherLineOf({ lat: opts.lat, lng: opts.lng, city }),
      headlinesOf(),
      screenTimeOf(uid),
    ]);

  return {
    name: profile?.user?.name ? String(profile.user.name).split(" ")[0] : null,
    weather_line,
    agenda,
    promises,
    messages,
    people,
    people_count: people.length,
    headlines,
    screen_time,
  };
}

/// Spoken form for the daily_brief voice tool — short, warm, concrete.
function speakBrief(b) {
  const bits = [];
  const timed = b.agenda.filter((a) => a.at);
  if (b.agenda.length === 0) {
    bits.push("Your schedule is clear today.");
  } else {
    const first = b.agenda[0];
    bits.push(
      `You have ${b.agenda.length} thing${b.agenda.length === 1 ? "" : "s"} on your plate` +
        (timed.length && first.at
          ? `, starting with ${first.title}`
          : `, including ${first.title}`) +
        "."
    );
  }
  if (b.messages.length) {
    bits.push(
      `${b.messages.length} unread message${b.messages.length === 1 ? "" : "s"} — the latest is from ${b.messages[0].from}: ${b.messages[0].text}.`
    );
  }
  if (b.promises.length) {
    bits.push(
      `You still owe: ${b.promises
        .slice(0, 2)
        .map((p) => p.text)
        .join("; ")}.`
    );
  }
  if (b.weather_line) bits.push(`Weather: ${b.weather_line}.`);
  return bits.join(" ");
}

module.exports = { buildBrief, speakBrief };
