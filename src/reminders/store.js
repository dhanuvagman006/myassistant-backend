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
    `SELECT id, text, due_at, repeat, anchor_day, deliver, call_job_id FROM reminders
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
    // A SERIES THAT CALLS MUST KEEP CALLING. The occurrence that just
    // passed spent its job. Rolling the time forward without queueing a
    // call for the new one turned "I'll call you every day" into a push
    // after day one — and only setDone() re-queued, which never runs for
    // someone who answers the call instead of ticking the row off.
    let jobId = null;
    if (r.deliver === "call") {
      await cancelCall(r.call_job_id);
      jobId = await queueCall(userId, r.id, r.text, next);
    }
    // done is reset too: the next occurrence has not happened yet.
    await run(
      "UPDATE reminders SET due_at = $1, done = 0, call_job_id = $3 WHERE id = $2",
      [next, r.id, jobId]
    );
  }
  return stale.length;
}

/**
 * QUEUE THE CALL THAT GOES WITH A REMINDER.
 *
 * His instruction, 2026-09-21: "when user says remind me, by default it
 * should be call and reminder, not just push notification." A push is
 * easy to miss and impossible to acknowledge; a call is neither.
 *
 * ONE JOB ROW, not a poller — the queue already survives restarts and
 * already knows how to run something at a time. The phone still gets its
 * local notification either way, so a user who is in a meeting sees the
 * reminder even if they decline the call.
 *
 * Returns the job id so cancelling the reminder can cancel the call.
 */
async function queueCall(userId, reminderId, text, dueAt) {
  if (!userId || !dueAt || dueAt <= Date.now()) return null;
  try {
    const agent = require("../agents/agentCall");
    if (!agent.enabled()) return null; // calling not configured — push only
    return await require("../infra/jobs").enqueue(
      "reminder_call",
      { reminderId, text: String(text || "").slice(0, 300) },
      { userId, delayMs: dueAt - Date.now() }
    );
  } catch (e) {
    // A reminder that saved but could not queue its call is still a
    // reminder. Never fail the save over the call.
    console.warn("reminder call could not be queued:", e.message);
    return null;
  }
}

/** Drop a queued reminder call — the reminder moved, was done, or is gone. */
async function cancelCall(jobId) {
  if (!jobId) return;
  await run(
    "UPDATE jobs SET status='cancelled', updated_at=$2 WHERE id=$1 AND status='pending'",
    [jobId, Date.now()]
  ).catch((e) => console.warn("reminder call cancel failed:", e.message));
}

async function create(userId, text, dueAt = null, ring = "gentle", opts = {}) {
  const t = String(text || "").trim().slice(0, 300);
  if (!t) return null;
  const repeat = recurrence.normalize(opts.repeat);
  // Only a dated reminder can repeat — "every Tuesday" with no time is
  // not a series, it is a note.
  const anchorDay = repeat && dueAt
    ? recurrence.anchorDayOf(dueAt, opts.tzOffsetMin) : 0;
  const wantRing = ring === "alarm" ? "alarm" : "gentle";
  // A CALL IS PLACED ONLY WHEN THE CALLER ASKED FOR ONE.
  //
  // "Remind me at 9" spoken to the assistant passes deliver:"call"
  // explicitly, which is what he asked for. But defaulting to "call"
  // also armed every path that files a reminder ON the user's behalf —
  // a shared timetable filing 15 dated events, the action items from a
  // call transcript, the Today screen's + button — so the phone rang for
  // things nobody asked to be rung about, at real money per call.
  // Opting IN keeps his instruction and stops the surprises.
  // An undated note-to-self has nothing to ring about either way.
  const wantDeliver = opts.deliver === "call" && dueAt ? "call" : "notify";

  // THE SAME REMINDER, SAID TWICE, IS ONE REMINDER.
  //
  // "Remind me about the meeting at 4" followed by "make that one ring"
  // produced TWO rows for 16:00 — one gentle, one alarm — and both fired.
  // The second utterance is a correction of the first, not a new thing to
  // be reminded of, so it updates rather than inserts.
  //
  // Matched on the same text at close to the same time. A two-minute
  // window absorbs the re-parse of a spoken time without merging
  // reminders that were genuinely meant to be separate; identical text at
  // an identical minute is one intention expressed twice.
  const WINDOW_MS = 120_000;
  const existing = await one(
    `SELECT * FROM reminders
      WHERE user_id = $1 AND done = 0 AND lower(text) = lower($2)
        AND ((due_at IS NULL AND $3::bigint IS NULL)
             OR (due_at IS NOT NULL AND $3::bigint IS NOT NULL
                 AND abs(due_at - $3::bigint) <= $4))
      ORDER BY id DESC LIMIT 1`,
    [userId, t, dueAt || null, WINDOW_MS]
  );
  if (existing) {
    // Take the LOUDER of the two: asking for a ring after a quiet one is
    // an upgrade, and silently keeping the gentle setting would ignore
    // what they just asked for.
    const nextRing = wantRing === "alarm" || existing.ring === "alarm" ? "alarm" : "gentle";
    // The time may have just moved, so the old call is wrong — drop it
    // and queue one for the time that now stands.
    await cancelCall(existing.call_job_id);
    const when = dueAt || existing.due_at;
    const jobId = wantDeliver === "call"
      ? await queueCall(userId, existing.id, t, when) : null;
    return one(
      `UPDATE reminders SET due_at = $3, ring = $4, repeat = $5, anchor_day = $6,
              deliver = $7, call_job_id = $8
        WHERE user_id = $1 AND id = $2 RETURNING *`,
      [userId, existing.id, when, nextRing,
       dueAt ? repeat : existing.repeat, anchorDay || existing.anchor_day,
       wantDeliver, jobId]
    );
  }

  const row = await one(
    `INSERT INTO reminders (user_id, text, due_at, created_at, ring, repeat, anchor_day, deliver)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [userId, t, dueAt || null, Date.now(), wantRing,
     dueAt ? repeat : "", anchorDay, wantDeliver]
  );
  if (row && wantDeliver === "call") {
    const jobId = await queueCall(userId, row.id, t, dueAt);
    if (jobId) {
      await run("UPDATE reminders SET call_job_id = $2 WHERE id = $1", [row.id, jobId])
        .catch(() => {});
      row.call_job_id = jobId;
    } else {
      // Calling is off on this deployment, or the queue refused. Say so
      // in the row rather than leaving a promise nothing will keep.
      await run("UPDATE reminders SET deliver = 'notify' WHERE id = $1", [row.id])
        .catch(() => {});
      row.deliver = "notify";
    }
  }
  return row;
}

async function setDone(userId, id, done, { tzOffsetMin = 330 } = {}) {
  if (done) {
    // FINISHING ONE OCCURRENCE IS NOT ENDING THE SERIES. Ticking off
    // today's "take the tablets" moves it to tomorrow; only remove()
    // ends it.
    const cur = await one(
      "SELECT * FROM reminders WHERE user_id = $1 AND id = $2",
      [userId, id]
    );
    // DONE MEANS DON'T RING ME. Ticking a reminder off and then being
    // phoned about it anyway is the app arguing with the user.
    await cancelCall(cur && cur.call_job_id);
    if (cur && cur.repeat && cur.due_at) {
      const next = recurrence.advanceTo(Date.now(), Number(cur.due_at), cur.repeat, {
        tzOffsetMin,
        anchorDay: Number(cur.anchor_day) || 0,
      });
      if (next) {
        // The series continues, so the NEXT occurrence gets its own call.
        const jobId = cur.deliver === "call"
          ? await queueCall(userId, id, cur.text, next) : null;
        return (await run(
          "UPDATE reminders SET due_at = $1, done = 0, call_job_id = $4 WHERE user_id = $2 AND id = $3",
          [next, userId, id, jobId]
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
  const nextText = text != null ? String(text).trim().slice(0, 300) : cur.text;
  const nextDue = dueAt !== undefined ? dueAt : cur.due_at;
  // MOVING A REMINDER MOVES ITS CALL. Without this, "push it to five"
  // left the four o'clock call queued and the phone rang at four.
  let jobId = cur.call_job_id;
  if (cur.deliver === "call" && (nextDue !== cur.due_at || nextText !== cur.text)) {
    await cancelCall(cur.call_job_id);
    jobId = await queueCall(userId, id, nextText, nextDue);
  }
  return one(
    "UPDATE reminders SET text = $1, due_at = $2, call_job_id = $5 WHERE user_id = $3 AND id = $4 RETURNING *",
    [nextText, nextDue, userId, id, jobId]
  );
}

async function remove(userId, id) {
  const cur = await one(
    "SELECT call_job_id FROM reminders WHERE user_id = $1 AND id = $2",
    [userId, id]
  ).catch(() => null);
  await cancelCall(cur && cur.call_job_id);
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

module.exports = {
  queueCall, cancelCall, list, create, setDone, update, remove, upcomingText, rollForward };
