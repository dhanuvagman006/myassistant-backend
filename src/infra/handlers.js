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
 * throwing, so the queue never re-runs it. The one exception is a
 * TRANSIENT failure before anything in the world was done (see
 * retryable below): that run is queued again, a little later, by hand.
 */
const STALE_AFTER_MS = 45 * 60 * 1000;

/**
 * A BUSY MODEL IS A MOMENT, NOT AN OUTCOME. Production, 2026-09-25: all
 * seven scheduled tasks that evening ended "Scheduled task failed" — six
 * on a 503 "high demand" from the chat model, one on a timeout — and the
 * call, message or order simply never happened. Such a run is queued
 * again (a minute later, then three) before the failure push goes out,
 * but only while nothing in the world has been done: a run that already
 * placed the call must never place it twice.
 */
const RETRY_DELAYS_MS = [60_000, 3 * 60_000];

/** A 5xx or a timeout — worth another go. A spent quota or a refusal is not. */
function isTransient(e) {
  const status = Number(e?.status) || 0;
  if (status >= 500 && status <= 504) return true;
  const m = String(e?.message || e || "");
  return e?.name === "TimeoutError" || /\b50[0234]\b/.test(m) || /timed out|timeout|aborted/i.test(m);
}

/**
 * Did this job's run already DO anything? Then it never runs again.
 * Every tool the turn started counts, not only world actions: email_send,
 * start_task, deep_research and add_finance_item are not filed as world
 * actions, and a second copy of any of them is the double effect this
 * guards (review, 2026-09-27). A run that died before its first tool —
 * on the model, where 2026-09-25's runs died — loses nothing going again.
 */
function actedAlready(userId, sessionId, started = []) {
  if (started.length) return true;
  const state = require("../agents/sessionState").get(userId, sessionId);
  return !!state && state.executed.length > 0;
}

/**
 * Queue this job's payload again after the next retry delay. Returns the
 * wait in minutes, or 0 when the retries are spent or the queue refused.
 */
async function retryLater(kind, payload, userId) {
  const tries = Number(payload?.retry) || 0;
  if (tries >= RETRY_DELAYS_MS.length) return 0;
  try {
    await jobs.enqueue(kind, { ...payload, retry: tries + 1 }, {
      userId, delayMs: RETRY_DELAYS_MS[tries],
    });
    return RETRY_DELAYS_MS[tries] / 60_000;
  } catch (e) {
    console.error(`${kind} retry enqueue failed:`, e.message);
    return 0;
  }
}

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
  let retryable = false;
  const jobSessionId = `job:${job.id || job.jobId || Date.now()}`;
  const started = []; // every tool this run began (actedAlready)
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
      },
      (type, e) => { if (type === "tool_start") started.push(String(e?.name || "")); }
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
    // itself (the telephony relay); anything else that reached this point
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
    retryable = isTransient(e) && !actedAlready(userId, jobSessionId, started);
  }
  if (retryable) {
    // The retry carries the time this occurrence was DUE, so a daily
    // series rolls on from 9:00 and not from the 9:01 retry.
    const mins = await retryLater("scheduled_task",
      { ...payload, dueAt: Number(payload?.dueAt) || Number(job.run_after) }, userId);
    if (mins) {
      // No push and no next occurrence: the retry reports, and rolls on.
      try {
        await run(`UPDATE jobs SET last_error=$2, updated_at=$3 WHERE id=$1`, [
          job.id, `RETRYING in ${mins} min: ${outcome.slice(0, 240)}`, Date.now(),
        ]);
      } catch (e) {
        console.error("scheduled_task retry note failed:", e.message);
      }
      return;
    }
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
  // A retried occurrence (retryLater) rolls on from when it was DUE, and a
  // first run moved to "a minute from now" (schedule_task) from the time
  // the user asked for; the next occurrence carries neither.
  const { retry: _retry, dueAt, repeatFrom, ...p } = job.payload || {};
  if (!["daily", "weekly", "monthly"].includes(p.repeat)) return;
  try {
    let next = nextOccurrence(
      Number(repeatFrom) || Number(dueAt) || Number(job.run_after), p.repeat, p);
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

// One definition of "when next", shared with reminders — the month-end
// arithmetic is easy to get subtly wrong twice.
function nextOccurrence(fromMs, repeat, payload) {
  return require("../reminders/recurrence").nextOccurrence(fromMs, repeat, {
    tzOffsetMin: payload?.tzOffsetMin,
    anchorDay: payload?.anchorDay,
  });
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

  // A SPOKEN NUMBER IS ALREADY THE ANSWER. "Call my driver on 63601 39965
  // at 4am" reaches here with the NUMBER as the name, and searching the
  // address book for a digit string never matches — so the whole thing
  // fell through to "I've asked your phone to dial it", which at 4 a.m.
  // is a tap nobody is awake to make. The app's live path has handled
  // this since day one; the scheduled path never learned it.
  const dialled = name.replace(/[^\d+]/g, "");
  if (dialled.replace(/\D/g, "").length >= 7 && dialled.length >= name.length - 4) {
    phone = dialled;
    resolvedName = action?.contact_name || action?.contactName || "there";
  }

  try {
    if (phone) throw { skip: true }; // already have it
    const out = await require("../users/resolve").resolveContact(userId, name, { limit: 2 });
    if (out.match?.phone) {
      phone = out.match.phone;
      resolvedName = out.match.name || name;
    } else if (out.candidates?.length === 1 && out.candidates[0].phone) {
      phone = out.candidates[0].phone;
      resolvedName = out.candidates[0].name || name;
    }
  } catch (e) {
    if (!e?.skip) console.warn("scheduled agent call resolve failed:", e.message);
  }
  if (!phone) {
    // A MESSAGE TO DELIVER IS NEVER HANDED BACK TO THE USER'S PHONE.
    //
    // This used to fall through to placeScheduledCall, which pushes a
    // "📞 Time to call X" notification and returns ok:true — so the job
    // was filed as DONE and the user was told the call was "starting on
    // your phone now". At 4 a.m. nobody taps that notification, and the
    // message they asked to be delivered simply never was. Say what
    // actually happened instead.
    return {
      ok: false,
      replaceOutcome: true,
      line:
        `I couldn't place the call to ${name} — I don't have a number for ` +
        `them in your contacts, so nothing was dialled and the message was ` +
        `not delivered. Save their number, or give me the number itself.`,
    };
  }

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
      // Whatever the user decided when they scheduled it; absent means
      // one attempt, never an invented retry.
      retryTimes: action?.retry_times,
      retryGapMinutes: action?.retry_gap_minutes,
      tone: action?.tone,
    });
    callId = started.id;
  } catch (e) {
    console.warn("scheduled agent call start failed:", e?.message || e?.code);
    return placeScheduledCall(userId, action);
  }
  // The row is created by agentCall.start() now, for every caller — a
  // second one here would give the Calls screen two rows per call.

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
      // NOT "the call is starting now" — this is a notification waiting
      // for a tap, and saying otherwise is how a call nobody made got
      // reported as a call that happened.
      line: `I've sent a reminder to your phone to call ${name} — it needs a tap to dial.`,
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

async function notify(userId, title, body, kind = "scheduled_task") {
  try {
    const u = await one(`SELECT fcm_token FROM users WHERE id=$1`, [userId]);
    if (u?.fcm_token) {
      await require("../services/push").sendNotification(u.fcm_token, title, body, {
        kind,
      });
    }
  } catch (e) {
    console.error(`${kind} notify failed:`, e.message);
  }
}

/**
 * THE REST OF A PLAN — the crank a voice turn could not wait for.
 *
 * start_task runs a plan for as long as a conversation can hold its
 * breath (taskDriver.TURN_BUDGET_MS); what is left is queued here
 * (taskDriver.handOff) and runs on with nobody holding the phone, so it
 * runs as a background turn does: unattended tools refused, a step that
 * needs a yes parked, not guessed. The outcome is pushed, or the next
 * crank is queued and that one reports.
 *
 * Never thrown from: a step may be a world action, and the queue must
 * not run one twice. A crank that breaks stops its plan and says so.
 */
async function taskContinue(payload, job) {
  const userId = job.user_id;
  const taskId = Number(payload?.taskId);
  if (!userId || !taskId) return;
  const tasks = require("../agents/tasks");
  const driver = require("../agents/taskDriver");
  const task = await tasks.get(userId, taskId).catch(() => null);
  // Cancelled, finished or parked since it was queued: nothing to add.
  if (!task || task.status !== tasks.STATUS.RUNNING) return;
  // Picked up long after it was queued (the server was down): the rest of
  // a plan asked for an hour ago is not done now, unasked — the rule a
  // scheduled task keeps (STALE_AFTER_MS). Stopped, and said.
  if (Date.now() - Number(job.run_after) > STALE_AFTER_MS) {
    const stopped = await tasks.cancel(userId, taskId, "too late to carry on").catch(() => null);
    await notify(userId, `Stopped: ${short(task.goal)}`,
      `${driver.summarise(stopped || task)} The rest was due long ago, so I did not run it.`, "task");
    return;
  }

  // ITS OWN SESSION, as a scheduled task has — carrying the taint of what
  // the plan has already read. A step that fetched a web page or an email
  // made the rest of the turn untrusted (registry.markTurnUntrusted), and
  // the rest of the plan must not come back clean in a fresh session.
  const registry = require("../tools/registry");
  const sessionState = require("../agents/sessionState");
  const sessionId = `task:${taskId}`;
  const session = sessionState.begin(userId, sessionId, { surface: "background" });
  const readUntrusted = task.steps.some((s) => s.status === tasks.STEP.DONE &&
    (registry.UNTRUSTED_SOURCES.has(s.tool) || registry.get(s.tool)?.source === "mcp"));
  const earlier = task.sessionId ? sessionState.get(userId, task.sessionId) : null;
  if (readUntrusted || typeof earlier?.__untrustedAt === "number") session.__untrustedAt = Date.now();

  const tz = Number.isFinite(payload?.tzOffsetMin) ? payload.tzOffsetMin : 330;
  let out;
  try {
    out = await driver.runWithin(userId, taskId, {
      userId, tzOffsetMin: tz, background: true, source: "background",
      session, sessionId, intent: task.goal,
      ...(payload?.approved === true ? { approved: true } : {}),
    }, { budgetMs: driver.BACKGROUND_BUDGET_MS, hop: Number(payload?.hop) || 0 });
  } catch (e) {
    console.error(`task_continue ${taskId} failed:`, e.message);
    out = { task: await tasks.cancel(userId, taskId,
      `stopped: ${String(e.message).slice(0, 160)}`).catch(() => null) };
  } finally {
    sessionState.end(userId, sessionId);
  }
  if (out.handedOff) return; // the next crank reports
  const left = out.task || task;
  // Out of cranks with steps still to run: stopped, not left RUNNING.
  if (out.exhausted) await tasks.cancel(userId, taskId, "ran out of time").catch(() => null);
  const title =
    left.status === tasks.STATUS.DONE ? `Done: ${short(left.goal)}` :
    left.status === tasks.STATUS.BLOCKED ? `Needs you: ${short(left.goal)}` :
    `Stopped: ${short(left.goal)}`;
  await notify(userId, title, driver.summarise(left, out), "task");
}

/**
 * DEEP RESEARCH — a question worth more than one search.
 *
 * Runs as a JOB, never inside a turn. Six searches and a synthesis take
 * thirty to sixty seconds, and a voice conversation cannot be held open
 * that long: the user would sit in silence and conclude it had crashed.
 * So the turn says it is working on it, this produces a written brief,
 * saves it to their documents, and a push tells them it is ready.
 *
 * Every claim in the brief carries the source it came from. A research
 * brief that blends the model's own recollection into cited findings is
 * worse than no brief, because it reads as if it were all sourced.
 */
async function deepResearch(payload = {}) {
  const userId = Number(payload.userId);
  const question = String(payload.question || "").trim();
  if (!Number.isInteger(userId) || userId <= 0 || !question) return;

  const search = require("../tools/webSearch");
  const ai = require("../services/ai/router");
  const store = require("../actions/store");
  const started = Date.now();

  const fail = async (why) => {
    store.record(userId, {
      tool: "deep_research", args: { question }, ok: false, world: false,
      intent: question, detail: why, result: why, surface: "background",
      decision: "ran", ms: Date.now() - started,
    });
    await notify(userId, "Research didn't finish", why);
  };
  let filed = false;

  try {
    // 1. Break the question up. Several angles find things one query does
    //    not — and the search cache is keyed on the query, so varied
    //    sub-questions also mean genuinely fresh results.
    let subs = [];
    try {
      const { reply } = await ai.generateReply(
        [{ role: "user", content:
          `Break this research question into 3 to 6 distinct web search ` +
          `queries that together answer it. Cover different angles, not ` +
          `rephrasings.\n\nQuestion: "${question}"\n\n` +
          `Reply with ONLY a JSON object: {"queries":["...","..."]}` }],
        { system: "You plan web research. You reply with JSON and nothing else." }
      );
      const m = /\{[\s\S]*\}/.exec(String(reply || ""));
      const plan = m ? JSON.parse(m[0]) : null;
      subs = Array.isArray(plan?.queries) ? plan.queries.filter(Boolean).slice(0, 6) : [];
    } catch (_) {}
    if (!subs.length) subs = [question];

    // 2. Search them all at once.
    const results = await Promise.all(
      subs.map((q) =>
        search.run(q).then((r) => ({ q, r })).catch(() => ({ q, r: null }))
      )
    );
    const sources = [];
    const unattributed = [];
    for (const { q, r } of results) {
      // webSearch.run returns its hits as `data` directly — an array, not
      // an envelope. Reading data.results would have found nothing.
      const items = r && r.ok && Array.isArray(r.data) ? r.data : [];
      for (const it of items.slice(0, 6)) {
        if (!it) continue;
        const url = String(it.url || it.link || "").slice(0, 400);
        const text = String(it.snippet || it.description || "").slice(0, 1200);
        if (url) {
          sources.push({
            query: q,
            title: String(it.title || "").slice(0, 200),
            snippet: text.slice(0, 400),
            url,
          });
        } else if (text) {
          // THE GEMINI PROVIDER'S ANSWER HAS NO URL. Its grounded reply
          // arrives as {title:"Web answer", snippet:<the answer>, url:""}
          // with citation chunks after it — so requiring a URL threw away
          // the single most substantial thing the search returned, and when
          // grounding produced no chunks it threw away everything and the
          // job reported "no search provider returned anything".
          //
          // Kept, but kept SEPARATE: it cannot be cited as a numbered
          // source, and the synthesis is told so.
          unattributed.push({ query: q, text });
        }
      }
    }
    if (!sources.length && !unattributed.length) {
      return fail("No search provider returned anything for that question.");
    }

    // 3. One synthesis over everything found.
    const numbered = sources
      .map((sc, i) => `[${i + 1}] ${sc.title}\n${sc.snippet}\n${sc.url}`)
      .join("\n\n");
    const unsourced = unattributed.length
      ? "\n\nSEARCH SUMMARIES (no URL — these are the search engine's own " +
        "answers. You may use them, but you may NOT give them a citation " +
        "number, and where they are your only support say so in the text):\n" +
        unattributed.map((u) => `• (${u.query}) ${u.text}`).join("\n")
      : "";
    const { reply: brief } = await ai.generateReply(
      [{ role: "user", content:
      `Write a research brief answering: "${question}"\n\n` +
      `Use ONLY the sources below. Cite them inline as [1], [2] and so on. ` +
      `Where sources disagree, say so and cite both. Where the sources do ` +
      `not answer part of the question, say that plainly instead of filling ` +
      `the gap from your own knowledge — an unsourced sentence in a cited ` +
      `brief is worse than an admitted gap.\n\n` +
      `Structure: a two-sentence answer first, then the findings as short ` +
      `paragraphs, then "Sources" listing each number with its URL.\n\n` +
      `SOURCES:\n${numbered}${unsourced}` }],
      { system:
        "You write sourced research briefs. Every claim carries the number " +
        "of the source it came from. You never add a fact the sources do " +
        "not contain." }
    );
    const text = String(brief || "").trim();
    if (text.length < 80) return fail("The research came back empty.");

    // 4. Keep it where they keep everything else.
    const docs = require("../docs/store");
    const stamp = new Date().toISOString().slice(0, 10);
    const title = `Research: ${short(question)}`;
    const row = await docs.createDocument(userId, {
      buffer: Buffer.from(
        `${title}\n${stamp}\n\n${text}\n`, "utf8"
      ),
      filename: `research-${stamp}.txt`,
      mime: "text/plain",
      note: question,
    });
    filed = true;
    try {
      await docs.setMetadata(userId, row.id, {
        title, category: "other", docDate: stamp,
        summary: text.slice(0, 1000), tags: "research", fullText: text,
      });
    } catch (_) {}

    store.record(userId, {
      tool: "deep_research", args: { question }, ok: true, world: false,
      intent: question, surface: "background", decision: "ran",
      ms: Date.now() - started,
      result:
        `${sources.length} cited sources` +
        (unattributed.length ? ` + ${unattributed.length} search summaries` : "") +
        ` across ${subs.length} searches → document ${row.id}`,
      reply: text.slice(0, 600),
    });
    await notify(userId, "Your research is ready", short(question));
  } catch (e) {
    // A busy model is a moment (RETRY_DELAYS_MS): the whole job runs
    // again a little later — nothing was filed, so nothing doubles.
    if (!filed && isTransient(e)) {
      const mins = await retryLater("deep_research", payload, userId);
      if (mins) {
        console.warn(`deep_research: ${String(e.message).slice(0, 120)} — again in ${mins} min`);
        return;
      }
    }
    await fail(String(e.message).slice(0, 160));
  }
}

/**
 * VIDEO GENERATION — a job, because it takes minutes.
 *
 * Measured in production: three keyframes at 1536x864 plus the encode is
 * around a hundred seconds, and four is well past two minutes. A voice
 * turn cannot be held open that long — the user sits in silence and
 * concludes it crashed, which is the same failure deep research had. So
 * the turn says it is being made, this makes it, and a push says it is
 * ready.
 */
async function videoJob(payload = {}) {
  const userId = Number(payload.userId);
  const prompt = String(payload.prompt || "").trim();
  if (!Number.isInteger(userId) || userId <= 0 || !prompt) return;

  const store = require("../actions/store");
  const started = Date.now();
  const fail = async (why) => {
    store.record(userId, {
      tool: "generate_video", args: { prompt }, ok: false, world: false,
      intent: prompt, detail: why, result: why, surface: "background",
      decision: "ran", ms: Date.now() - started,
    });
    await notify(userId, "The video didn't finish", why);
  };

  let vid;
  try {
    vid = await require("../services/videogen").generateVideo(prompt, {
      aspect: payload.aspect || "wide",
      seconds: Math.min(Math.max(Number(payload.seconds) || 8, 5), 15),
      frames: 3,
    });
  } catch (e) {
    return fail(String(e.message).slice(0, 160));
  }

  try {
    const docs = require("../docs/store");
    const row = await docs.createDocument(userId, {
      buffer: vid.buffer,
      filename: `hari-video-${Date.now()}.mp4`,
      mime: vid.mime,
      note: prompt,
    });
    await docs
      .setMetadata(userId, row.id, {
        title: `Video — ${short(prompt)}`,
        category: "other",
        docDate: new Date().toISOString().slice(0, 10),
        summary:
          vid.kind === "veo"
            ? `AI-generated video from: ${prompt}`
            : `AI-generated clip (${vid.frames} generated frames, crossfaded ` +
              `with a slow camera move) from: ${prompt}`,
        tags: ["generated", "video"],
        fullText: `AI-generated video. Prompt: ${prompt}`,
      })
      .catch(() => null);
    store.record(userId, {
      tool: "generate_video", args: { prompt }, ok: true, world: false,
      intent: prompt, surface: "background", decision: "ran",
      ms: Date.now() - started,
      result: `${vid.kind}, ${vid.frames || "?"} frames, ${Math.round(vid.buffer.length / 1024)} kB → document ${row.id}`,
    });
    await notify(userId, "Your video is ready", short(prompt));
  } catch (e) {
    await fail(`the video was made but could not be saved: ${String(e.message).slice(0, 120)}`);
  }
}

/**
 * A REMINDER THAT RINGS THE PHONE.
 *
 * His instruction, 2026-09-21: "when user says remind me, by default it
 * should be call and reminder, not just push notification."
 *
 * Deliberately NOT a scheduled_task. That runs a whole agent turn to
 * decide what to do; there is nothing to decide here — the words are
 * already written and the number is the user's own. This dials, speaks
 * them, and stops, which is both cheaper and impossible to get wrong.
 *
 * The local notification the phone scheduled fires regardless, so a
 * declined call is still a reminder seen.
 */
async function reminderCall(payload, job) {
  const userId = job?.user_id || payload?.userId;
  const text = String(payload?.text || "").trim();
  if (!userId || !text) return;

  // The user may have ticked it off, moved it or deleted it between the
  // queueing and now — the row is the truth, not this job.
  const row = await one(
    "SELECT done, deliver, due_at FROM reminders WHERE user_id=$1 AND id=$2",
    [userId, Number(payload.reminderId) || 0]
  ).catch(() => null);
  if (payload.reminderId && (!row || row.done || row.deliver !== "call")) return;

  const agent = require("../agents/agentCall");
  if (!agent.enabled()) return; // the push already went out

  const me = await require("../db").findById(userId).catch(() => null);
  const name = me?.name ? String(me.name).split(" ")[0] : "you";
  try {
    await agent.start({
      userId,
      userName: name,
      toNumber: me?.phone_number,
      contactName: name,
      task: `Remind them: ${text}`,
      selfCall: true,
    });
  } catch (e) {
    // Quota, an unverified number, or the provider being down. The
    // notification is the fallback and it has already been scheduled.
    console.warn("reminder call not placed:", e?.message || e?.code || e);
  } finally {
    // THE NEXT ONE IS THIS JOB'S JOB. A repeating reminder's next call was
    // only queued when something listed the reminders — the app opening,
    // a brief being built — so "call me every morning" stopped calling for
    // anyone who didn't open the app that day. This occurrence has just
    // come due, so rolling now advances it and queues the next call.
    await require("../reminders/store").rollForward(userId).catch((e) =>
      console.warn("reminder roll after call failed:", e.message)
    );
  }
}

function install() {
  jobs.register("document.index", documentIndex);
  jobs.register("reminder_call", reminderCall);
  // An assistant answering in a group for a member who is away — runs a
  // few minutes after the message so the person gets first refusal.
  jobs.register("group_agent_reply", (payload) =>
    require("../agents/groupAgent").replyFromJob(payload));
  jobs.register("scheduled_task", scheduledTask);
  // The rest of a plan the turn's time budget cut short (taskDriver.handOff).
  jobs.register("task_continue", taskContinue);
  jobs.register("deep_research", deepResearch);
  jobs.register("generate_video", videoJob);
  // A call retry that survives a restart — see agentCall.handleNoAnswer.
  jobs.register("agent_call_retry", (payload) =>
    require("../agents/agentCall").retryFromJob(payload));
}

module.exports = { install, reminderCall };
