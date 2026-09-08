/**
 * JOB HANDLERS — everything the durable queue (infra/jobs.js) knows how
 * to execute. Registered once at boot; jobs.start() polls afterwards.
 *
 * Until this file existed the queue was write-only: docs enqueued
 * "document.index" work that no handler ever picked up, so document
 * chunks/embeddings were never built and content search ranked on
 * titles alone.
 */
const jobs = require("./jobs");
const { one, run } = require("../db");

/** Chunk + embed a saved document for content search. Idempotent. */
async function documentIndex(payload) {
  const { userId, documentId, text } = payload || {};
  if (!userId || !documentId || !text) return;
  await require("../docs/intelligence").indexDocument(userId, documentId, text);
}

/**
 * A task the user scheduled for later ("order biryani from Swiggy at
 * 11", "call Allen at 11 pm and tell him to bring my laptop") — executed
 * by the same agent runtime that answers live conversations, with the
 * user's full context, memory and tools. The outcome lands as a push.
 *
 * DELIBERATELY NO RETRY: a crash halfway through "order food" must not
 * order twice. The handler reports failure to the user instead of
 * throwing, so the queue never re-runs it.
 */
const STALE_AFTER_MS = 45 * 60 * 1000;

async function scheduledTask(payload, job) {
  const task = String(payload?.task || "").trim();
  const userId = job.user_id;
  if (!task || !userId) return;
  const tz = Number.isFinite(payload?.tzOffsetMin) ? payload.tzOffsetMin : 330;

  // Fired long after its time (server was down at the scheduled moment):
  // executing a food order hours late is worse than skipping it. A
  // recurring task skips THIS occurrence but keeps its future ones.
  if (Date.now() - Number(job.run_after) > STALE_AFTER_MS) {
    await notify(userId, "Missed scheduled task",
        `I couldn't run "${short(task)}" at its scheduled time (the server ` +
        `was unreachable). ` +
        (payload?.repeat
          ? "The next scheduled run is unaffected."
          : "Ask me again if you still want it."));
    await reenqueueIfRecurring(job);
    return;
  }

  let outcome = "";
  let failed = false;
  try {
    const res = await require("../agents/runtime").runAgentTurn(
      `[SCHEDULED TASK] It is now the scheduled time. Execute this task I ` +
        `scheduled earlier, exactly as stated: "${task}". You are running ` +
        `in the background on the server WITHOUT my phone in hand: any ` +
        `tool that only OPENS something on the device (camera, WhatsApp, ` +
        `apps, screens) will NOT actually happen — never claim it did. ` +
        `To make a phone call, use place_phone_call — my own phone will ` +
        `be told to dial it right now. To SEND SOMEONE A MESSAGE, use ` +
        `send_agent_message — it delivers by itself; NEVER the WhatsApp ` +
        `tool here, which only pre-fills a draft waiting for a tap that ` +
        `will never come. ` +
        `Ordering, agent messages, reminders and search work normally. I ` +
        `already authorized this when I scheduled it — do NOT ask for ` +
        `confirmation, just do it. Then state the outcome in one or two ` +
        `short sentences; they will reach me as a notification.`,
      // approved: the user consented when they SCHEDULED the task — the
      // high-risk confirmation gate has nobody to ask here, and without
      // this it silently swallowed the whole action: place_phone_call
      // returned needsConfirmation, the turn ended with empty text, and
      // the outcome push said "Done." over a call that never happened.
      { userId, tzOffsetMin: tz, approved: true }
    );
    if (res?.needsConfirmation) {
      // Defensive: should be impossible with approved:true, but a lied
      // "Done." must never come back.
      failed = true;
      outcome =
        `I couldn't do it — "${short(task)}" needed a confirmation I ` +
        `can't get in the background.`;
    } else {
      outcome = String(res?.text || "").trim() || "Done.";
    }

    // Device actions have no device here. Calls the server CAN place
    // itself (the Exotel relay); anything else that reached this point
    // did NOT happen, whatever the model just said — say so.
    const HARMLESS = new Set(["documents", "translator", "search_results"]);
    let neededPhone = false;
    for (const a of res?.deviceActions || []) {
      const t = String(a?.type || "");
      if (t === "resolve_and_call") {
        const r = await placeScheduledCall(userId, a);
        outcome = `${outcome} ${r.line}`.trim();
        if (!r.ok) failed = true;
      } else if (!HARMLESS.has(t)) {
        neededPhone = true;
      }
    }
    if (neededPhone) {
      failed = true;
      outcome =
        `${outcome} — but part of this needed your phone in hand (an app ` +
        `or screen on the device) and could not actually run in the ` +
        `background.`.trim();
    }
  } catch (e) {
    failed = true;
    outcome = `I couldn't complete it: ${String(e.message).slice(0, 160)}`;
  }
  await notify(
    userId,
    failed ? "Scheduled task failed" : `Done: ${short(task)}`,
    outcome.slice(0, 400)
  );
  // Keep the outcome on the job row so "what happened to my 11 pm order?"
  // has an answer (list tool reads it).
  await run(`UPDATE jobs SET last_error=$2, updated_at=$3 WHERE id=$1`, [
    job.id, (failed ? "FAILED: " : "OK: ") + outcome.slice(0, 280), Date.now(),
  ]);
  // A failed occurrence does not end the series — tomorrow gets its chance.
  await reenqueueIfRecurring(job);
}

/**
 * Recurring tasks live as a CHAIN of one-shot rows: each completed (or
 * skipped-stale) occurrence enqueues the next, so exactly one pending row
 * exists per series and cancel_scheduled_task ends the whole thing.
 */
async function reenqueueIfRecurring(job) {
  const p = job.payload || {};
  if (!["daily", "weekly", "monthly"].includes(p.repeat)) return;
  try {
    let next = nextOccurrence(Number(job.run_after), p.repeat, p);
    // Catch up past a long outage without queueing a backlog of stale runs.
    while (next <= Date.now()) next = nextOccurrence(next, p.repeat, p);
    await jobs.enqueue("scheduled_task", p, {
      userId: job.user_id,
      delayMs: next - Date.now(),
    });
  } catch (e) {
    console.error("recurring re-enqueue failed:", e.message);
  }
}

function nextOccurrence(fromMs, repeat, payload) {
  if (repeat === "daily") return fromMs + 86_400_000;
  if (repeat === "weekly") return fromMs + 7 * 86_400_000;
  // monthly: same LOCAL day-of-month and time. The anchor day survives
  // clamping (scheduled for the 31st → 28 Feb → back to 31 Mar).
  const tz = Number.isFinite(payload?.tzOffsetMin) ? payload.tzOffsetMin : 330;
  const local = new Date(fromMs + tz * 60_000);
  const anchor = Number(payload?.anchorDay) || local.getUTCDate();
  const m = local.getUTCMonth() + 1;
  const target = new Date(local);
  target.setUTCDate(1); // avoid rollover while changing the month
  target.setUTCMonth(m);
  const daysInMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(anchor, daysInMonth));
  return target.getTime() - tz * 60_000;
}

/**
 * A scheduled call rings out from the USER'S OWN PHONE — Dhanush wants
 * to watch his handset dial Allen at 2 pm, not have a robot voice call
 * on his behalf. The server's part is one high-priority push: with the
 * app in the foreground the phone dials by itself the moment it lands;
 * otherwise the notification's tap places the call.
 */
async function placeScheduledCall(userId, action) {
  const name = String(action?.name || "").trim() || "them";
  const message = String(action?.message || "").slice(0, 200);
  try {
    const u = await one(`SELECT fcm_token FROM users WHERE id=$1`, [userId]);
    if (!u?.fcm_token) {
      return {
        ok: false,
        line: `I couldn't reach your phone to place the call to ${name} — no device is registered.`,
      };
    }
    await require("../services/push").sendNotification(
      u.fcm_token,
      `📞 Time to call ${name}`,
      message
        ? `To tell them: ${message}`
        : "Tap if the call doesn't start by itself.",
      { kind: "scheduled_call", name, message }
    );
    return {
      ok: true,
      line: `I've asked your phone to dial ${name} — the call should be starting on it now.`,
    };
  } catch (e) {
    return {
      ok: false,
      line: `I couldn't trigger the call to ${name}: ${String(e.message).slice(0, 120)}`,
    };
  }
}

function short(task) {
  return task.length > 48 ? `${task.slice(0, 45)}…` : task;
}

async function notify(userId, title, body) {
  try {
    const u = await one(`SELECT fcm_token FROM users WHERE id=$1`, [userId]);
    if (u?.fcm_token) {
      await require("../services/push").sendNotification(u.fcm_token, title, body, {
        type: "scheduled_task",
      });
    }
  } catch (e) {
    console.error("scheduled_task notify failed:", e.message);
  }
}

function install() {
  jobs.register("document.index", documentIndex);
  jobs.register("scheduled_task", scheduledTask);
}

module.exports = { install };
