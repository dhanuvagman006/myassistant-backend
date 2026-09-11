/**
 * PER-USER REMINDERS (Postgres)
 * -----------------------------
 * Created two ways: voice ("remind me to call amma tomorrow at 5" via the
 * intent layer in /chat) and the Today screen's + button. The app syncs
 * this list and schedules local notifications for every future due_at.
 * Schema lives in src/db.js init().
 */
const { query, one, run } = require("../db");
const recurrence = require("./recurrence");

async function list(userId, { tzOffsetMin = 330 } = {}) {
  // A REPEATING REMINDER IS NEVER OVERDUE. Roll any whose time has passed
  // to their next occurrence before handing the list over, so the agenda
  // shows "tomorrow 7 am" rather than a stale time from last week — and
  // so the app schedules the right local notification when it syncs.
  await rollForward(userId, tzOffsetMin).catch((e) =>
    console.warn("reminder roll-forward failed:", e.message)
  );
  return query(
    `SELECT * FROM reminders WHERE user_id = $1
     ORDER BY done ASC, due_at ASC NULLS LAST, created_at DESC LIMIT 200`,
    [userId]
  );
}

/** Advance every repeating reminder whose time has gone by. */
async function rollForward(userId, tzOffsetMin = 330) {
  const now = Date.now();
  const stale = await query(
    `SELECT id, due_at, repeat, anchor_day FROM reminders
      WHERE user_id = $1 AND repeat <> '' AND due_at IS NOT NULL AND due_at <= $2
      LIMIT 50`,
    [userId, now]
  );
  for (const r of stale) {
    const next = recurrence.advanceTo(now, Number(r.due_at), r.repeat, {
      tzOffsetMin,
      anchorDay: Number(r.anchor_day) || 0,
    });
    if (!next) continue;
    // done is reset too: the next occurrence has not happened yet.
    await run("UPDATE reminders SET due_at = $1, done = 0 WHERE id = $2", [next, r.id]);
  }
  return stale.length;
}

async function create(userId, text, dueAt = null, ring = "gentle", opts = {}) {
  const t = String(text || "").trim().slice(0, 300);
  if (!t) return null;
  const repeat = recurrence.normalize(opts.repeat);
  // Only a dated reminder can repeat — "every Tuesday" with no time is
  // not a series, it is a note.
  const anchorDay = repeat && dueAt
    ? recurrence.anchorDayOf(dueAt, opts.tzOffsetMin) : 0;
  return one(
    `INSERT INTO reminders (user_id, text, due_at, created_at, ring, repeat, anchor_day)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [userId, t, dueAt || null, Date.now(), ring === "alarm" ? "alarm" : "gentle",
     dueAt ? repeat : "", anchorDay]
  );
}

async function setDone(userId, id, done, { tzOffsetMin = 330 } = {}) {
  if (done) {
    // FINISHING ONE OCCURRENCE IS NOT ENDING THE SERIES. Ticking off
    // today's "take the tablets" moves it to tomorrow; only remove()
    // ends it.
    const cur = await one(
      "SELECT due_at, repeat, anchor_day FROM reminders WHERE user_id = $1 AND id = $2",
      [userId, id]
    );
    if (cur && cur.repeat && cur.due_at) {
      const next = recurrence.advanceTo(Date.now(), Number(cur.due_at), cur.repeat, {
        tzOffsetMin,
        anchorDay: Number(cur.anchor_day) || 0,
      });
      if (next) {
        return (await run(
          "UPDATE reminders SET due_at = $1, done = 0 WHERE user_id = $2 AND id = $3",
          [next, userId, id]
        )) > 0;
      }
    }
  }
  return (await run(
    "UPDATE reminders SET done = $1 WHERE user_id = $2 AND id = $3",
    [done ? 1 : 0, userId, id]
  )) > 0;
}

async function update(userId, id, text, dueAt) {
  const cur = await one("SELECT * FROM reminders WHERE user_id = $1 AND id = $2", [userId, id]);
  if (!cur) return null;
  return one(
    "UPDATE reminders SET text = $1, due_at = $2 WHERE user_id = $3 AND id = $4 RETURNING *",
    [
      text != null ? String(text).trim().slice(0, 300) : cur.text,
      dueAt !== undefined ? dueAt : cur.due_at,
      userId,
      id,
    ]
  );
}

async function remove(userId, id) {
  return (await run("DELETE FROM reminders WHERE user_id = $1 AND id = $2", [userId, id])) > 0;
}

/** Compact upcoming list for AI context / spoken briefings. */
async function upcomingText(userId, { max = 8 } = {}) {
  const rows = (await list(userId)).filter((r) => !r.done).slice(0, max);
  if (rows.length === 0) return "";
  return rows
    .map((r) => {
      const when = r.due_at ? new Date(r.due_at).toISOString() : "no set time";
      return `- [id ${r.id}] ${r.text} (due ${when})`;
    })
    .join("\n");
}

module.exports = { list, create, setDone, update, remove, upcomingText, rollForward };
