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
  const jobSessionId = `job:${job.id || job.jobId || Date.now()}`;
  try {
    const res = await require("../agents/runtime").runAgentTurn(
      `[SCHEDULED TASK] It is now the scheduled time. Execute this task I ` +
        `scheduled earlier, exactly as stated: "${task}". You are running ` +
        `in the background on the server WITHOUT my phone in hand: any ` +
        `tool that only OPENS something on the device (camera, WhatsApp, ` +
        `apps, screens) will NOT actually happen — never claim it did. ` +
        `To make a phone call, use place_phone_call — with a message/` +
        `question attached the assistant places and handles the call ` +
        `itself and the true result is reported; without one my own ` +
        `phone is told to dial. To SEND SOMEONE A MESSAGE, use ` +
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
      // ITS OWN SESSION. Every scheduled run used to fall back to a
      // constant key, so a user's background jobs shared one state object
      // for an hour — the executed list, the active entity and any pending
      // action carried from one scheduled task into the next. A job is a
      // session of exactly one turn.
      {
        userId, tzOffsetMin: tz, approved: true, background: true,
        sessionId: jobSessionId,
        source: "background",
        intent: task,
      }
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
        // With a MESSAGE and the conversational relay configured, the
        // agent places the call ITSELF at the scheduled time, talks to the
        // person, and the push carries their actual answer — "Allen said
        // he's attending." Anything else falls back to ringing the user's
        // own phone to dial.
        const r = a.message
          ? await placeScheduledAgentCall(userId, a)
          : await placeScheduledCall(userId, a);
        outcome = r.replaceOutcome ? r.line : `${outcome} ${r.line}`.trim();
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
  // OUTSIDE the failure path on purpose, and swallowed on purpose: if
  // this bookkeeping write throws, the queue would flip a COMPLETED job
  // back to pending and re-run it — the double-biryani bug. Losing the
  // outcome note is the lesser evil; the push above already went out.
  try {
    await run(`UPDATE jobs SET last_error=$2, updated_at=$3 WHERE id=$1`, [
      job.id, (failed ? "FAILED: " : "OK: ") + outcome.slice(0, 280), Date.now(),
    ]);
  } catch (e) {
    console.error("scheduled_task outcome write failed (not retried):", e.message);
  }
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
/**
 * Scheduled ASK/TELL call, placed by the AGENT itself: resolve the contact
 * from the server-synced address book, let the conversational relay talk
 * to them, wait for the real result, and hand back the person's answer as
 * the outcome. Falls back to the tap-to-dial push when the relay is off,
 * the name doesn't resolve to exactly one person, or the call can't start.
 */
async function placeScheduledAgentCall(userId, action) {
  const agentCall = require("../agents/agentCall");
  const name = String(action?.name || "").trim() || "them";
  const message = String(action?.message || "").slice(0, 400);
  if (!agentCall.enabled()) return placeScheduledCall(userId, action);

  let phone = null;
  let resolvedName = name;
  try {
    const out = await require("../users/resolve").resolveContact(userId, name, { limit: 2 });
    if (out.match?.phone) {
      phone = out.match.phone;
      resolvedName = out.match.name || name;
    } else if (out.candidates?.length === 1 && out.candidates[0].phone) {
      phone = out.candidates[0].phone;
      resolvedName = out.candidates[0].name || name;
    }
  } catch (e) {
    console.warn("scheduled agent call resolve failed:", e.message);
  }
  if (!phone) return placeScheduledCall(userId, action); // user dials themselves

  let callId;
  try {
    const u = await one(`SELECT name FROM users WHERE id=$1`, [userId]);
    const started = await agentCall.start({
      userId,
      userName: u?.name ? String(u.name).split(" ")[0] : null,
      toNumber: phone,
      contactName: resolvedName,
      task: message,
      lang: null,
    });
    callId = started.id;
  } catch (e) {
    console.warn("scheduled agent call start failed:", e?.message || e?.code);
    return placeScheduledCall(userId, action);
  }
  try {
    require("../outcomes/store").create(userId, {
      kind: "agent_call", target: resolvedName, detail: message,
      status: "dialing", path: "relay", externalId: callId,
    }).catch(() => {});
  } catch (_) {}

  // Wait for the terminal state — the whole point is reporting the answer.
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = agentCall.status(callId);
    if (!st) break;
    if (st.state === "completed") {
      return { ok: true, replaceOutcome: true, line: st.result || `I spoke with ${resolvedName}.` };
    }
    if (st.state === "no_answer") {
      return { ok: false, replaceOutcome: true, line: st.result || `${resolvedName} didn't pick up.` };
    }
    if (st.state === "failed") {
      return { ok: false, replaceOutcome: true, line: st.result || `The call to ${resolvedName} failed.` };
    }
  }
  return {
    ok: false,
    replaceOutcome: true,
    line: `I called ${resolvedName} but didn't get a result back in time — check Task outcomes for what happened.`,
  };
}

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
        kind: "scheduled_task",
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
