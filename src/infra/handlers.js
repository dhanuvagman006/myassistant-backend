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
  // executing a food order hours late is worse than skipping it.
  if (Date.now() - Number(job.run_after) > STALE_AFTER_MS) {
    await notify(userId, "Missed scheduled task",
        `I couldn't run "${short(task)}" at its scheduled time (the server ` +
        `was unreachable). Ask me again if you still want it.`);
    return;
  }

  let outcome = "";
  let failed = false;
  try {
    const res = await require("../agents/runtime").runAgentTurn(
      `[SCHEDULED TASK] It is now the scheduled time. Execute this task I ` +
        `scheduled earlier, exactly as stated: "${task}". You are running ` +
        `in the background on the server — I am not in a conversation and ` +
        `my phone screen is unavailable, so do not use tools that need the ` +
        `device (camera, translator, opening screens); everything else ` +
        `(ordering, agent messages, calls, reminders, search) works ` +
        `normally. I already authorized this when I scheduled it — do NOT ` +
        `ask for confirmation, just do it. Then state the outcome in one ` +
        `or two short sentences; they will reach me as a notification.`,
      { userId, tzOffsetMin: tz }
    );
    outcome = String(res?.text || "").trim() || "Done.";
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
