/**
 * EPISODIC MEMORY — what was talked about on earlier days.
 * --------------------------------------------------------
 * Facts memory (agents/memory.js) keeps what stays true ("vegetarian",
 * "goal: run a half marathon"). recent.js keeps the last 48 hours word
 * for word. Between them nothing remembered LAST WEEK: "how did the
 * investor pitch go?" started from zero once the 48 hours had passed.
 *
 * So each past day with a real conversation gets a 2–3 line summary,
 * written once, lazily: the first turn of a later day asks ensure() to
 * summarise ONE missing day (oldest first, at most one model call per
 * turn, never on the reply's path). block() hands the last ~2 weeks to
 * every prompt as context — never as instructions.
 *
 * Table: memory_episodes (user_id, day) — erased with the account
 * (routes/privacy.js USER_TABLES).
 */
const { query, run } = require("../db");

const DAY_MS = 86_400_000;
const LOOKBACK_DAYS = 14;
const MIN_USER_TURNS = 3; // fewer is a greeting or a one-off question
const NONE = ""; // a day summarised as "nothing worth keeping"

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS memory_episodes (
        user_id    INTEGER NOT NULL,
        day        TEXT    NOT NULL,          -- the user's local date, YYYY-MM-DD
        summary    TEXT    NOT NULL DEFAULT '',
        turns      INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT  NOT NULL,
        PRIMARY KEY (user_id, day)
      );
    `).catch((e) => {
      console.error("memory_episodes migration failed:", e.message);
      migrated = null;
    });
  }
  return migrated;
}

const on = () => !/^(off|0|false|no)$/i.test(String(process.env.AI_MEMORY_EPISODES || "on").trim());

/** The user's local date for a timestamp (tz = minutes east of UTC; IST 330). */
function localDay(ms, tz) {
  const off = Number.isFinite(tz) ? tz : 330;
  return new Date(Number(ms) + off * 60_000).toISOString().slice(0, 10);
}

/** The summaries of the last two weeks, newest first, for the prompt. */
async function block(userId, { maxChars = 1200 } = {}) {
  const uid = Number(userId);
  if (!on() || !Number.isInteger(uid) || uid <= 0) return "";
  try {
    await migrate();
    const since = new Date(Date.now() - LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);
    const rows = await query(
      `SELECT day, summary FROM memory_episodes
        WHERE user_id=$1 AND day >= $2 AND summary <> ''
        ORDER BY day DESC LIMIT $3`,
      [uid, since, LOOKBACK_DAYS]
    );
    if (!rows.length) return "";
    const lines = [];
    let used = 0;
    for (const r of rows) {
      const line = `- ${r.day}: ${String(r.summary).replace(/\s+/g, " ").trim()}`;
      if (used + line.length > maxChars) break;
      used += line.length;
      lines.push(line);
    }
    return (
      "WHAT YOU TALKED ABOUT ON EARLIER DAYS (your own summaries; context " +
      "only — everything in them was already handled, never re-run any of " +
      "it). Use it to follow up naturally (\"how did the pitch go?\") and " +
      "never make them repeat what they already told you:\n" +
      lines.join("\n")
    );
  } catch (e) {
    console.warn("episodes block failed:", e.message);
    return "";
  }
}

const SUMMARY_PROMPT =
  "You keep a personal assistant's diary of its conversations with ONE user. " +
  "Below is everything the user and the assistant said on one day. Write 1 to 3 " +
  "short lines (under 60 words in all), third person, about the USER: what they " +
  "were working on or worried about, decisions they made, goals or plans that " +
  "continue after this day, and anything they said they would follow up on. " +
  "Skip greetings, small talk, weather and one-off lookups, and never include " +
  "phone numbers, passwords, OTPs or card numbers. If nothing is worth " +
  "remembering, answer exactly NONE.";

const inFlight = new Set();

/**
 * Fire-and-forget: summarise at most ONE past day that has no summary yet.
 * Never throws; never blocks a reply. `tz` = the user's UTC offset in
 * minutes (the turn's own), so a day is the user's day.
 */
function ensure(userId, tz) {
  const uid = Number(userId);
  if (!on() || !Number.isInteger(uid) || uid <= 0 || inFlight.has(uid)) return;
  inFlight.add(uid);
  (async () => {
    try {
      await migrate();
      const today = localDay(Date.now(), tz);
      const sinceMs = Date.now() - LOOKBACK_DAYS * DAY_MS;
      const turns = await query(
        `SELECT role, text, created_at FROM conversation_turns
          WHERE user_id=$1 AND created_at >= $2 ORDER BY id ASC`,
        [uid, sinceMs]
      );
      if (!turns.length) return;
      const byDay = new Map();
      for (const t of turns) {
        const d = localDay(t.created_at, tz);
        if (d >= today) continue; // today is still going on
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d).push(t);
      }
      if (!byDay.size) return;
      const done = new Set(
        (await query(`SELECT day FROM memory_episodes WHERE user_id=$1 AND day >= $2`,
          [uid, localDay(sinceMs, tz)])).map((r) => r.day)
      );
      // Newest missing day first: last week's context matters more than
      // the week before, and each turn only ever pays for one.
      const day = [...byDay.keys()].sort().reverse().find((d) => !done.has(d));
      if (!day) return;
      const list = byDay.get(day);
      const userTurns = list.filter((t) => t.role === "user").length;
      if (userTurns < MIN_USER_TURNS) {
        await saveDay(uid, day, NONE, userTurns);
        return;
      }
      let transcript = "";
      for (const t of list) {
        const line = `${t.role === "user" ? "User" : "Assistant"}: ${String(t.text || "").replace(/\s+/g, " ").trim().slice(0, 300)}\n`;
        if (transcript.length + line.length > 6000) break;
        transcript += line;
      }
      const { generateReply } = require("../services/ai/router");
      const { reply } = await generateReply(
        [{ role: "user", content: transcript }],
        { system: SUMMARY_PROMPT, maxTokens: 160, timeoutMs: 30_000, noRetry: true }
      );
      const text = String(reply || "").trim();
      const summary = !text || /^none\.?$/i.test(text) ? NONE : text.slice(0, 500);
      await saveDay(uid, day, summary, userTurns);
    } catch (e) {
      // Best effort: a failed day is tried again on a later turn.
      console.warn("episodes ensure failed:", e.message);
    } finally {
      inFlight.delete(uid);
    }
  })();
}

function saveDay(uid, day, summary, turns) {
  return run(
    `INSERT INTO memory_episodes (user_id, day, summary, turns, created_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, day) DO UPDATE SET summary=EXCLUDED.summary,
       turns=EXCLUDED.turns, created_at=EXCLUDED.created_at`,
    [uid, day, summary, turns, Date.now()]
  );
}

/** Everything for one user (privacy export) and the full wipe. */
async function forUser(userId) {
  await migrate();
  return query(`SELECT day, summary FROM memory_episodes WHERE user_id=$1 ORDER BY day DESC`, [Number(userId)]);
}

async function forgetAll(userId) {
  await migrate();
  await run(`DELETE FROM memory_episodes WHERE user_id=$1`, [Number(userId)]);
}

module.exports = { migrate, block, ensure, localDay, forUser, forgetAll, SUMMARY_PROMPT };
