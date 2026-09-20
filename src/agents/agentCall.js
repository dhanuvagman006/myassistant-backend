/**
 * AGENT CALLS — Hari phones a real number, speaks on the user's behalf
 * (or wakes the user themself), and reports the true outcome.
 *
 * Provider: BOLNA — an Indian +91 caller ID, a hosted agent driven by
 * per-call variables, reporting back through a webhook. It is the only
 * one: Retell was removed on 2026-09-20 (his call), Plivo and Exotel
 * before it. The feature stays hidden (503 → the app falls back to a
 * direct dial) until all three env vars are set:
 *   BOLNA_API_KEY  BOLNA_FROM_NUMBER  BOLNA_AGENT_ID
 * plus PUBLIC_BASE_URL for webhooks. No answer → automatic redial after
 * AGENT_CALL_RETRY_MS (default 5 min), up to AGENT_CALL_MAX_ATTEMPTS
 * (default 3); the final outcome is pushed to the user's phone.
 */

const crypto = require("crypto");
const { generateReply } = require("../services/ai/router");

function cfg() {
  return {
    base: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
    dailyLimit: Number(process.env.AGENT_CALL_DAILY_LIMIT || 20),
    bolnaKey: process.env.BOLNA_API_KEY || "",
    bolnaFrom: process.env.BOLNA_FROM_NUMBER || "",
    bolnaAgent: process.env.BOLNA_AGENT_ID || "",
    retryMs: Number(process.env.AGENT_CALL_RETRY_MS || 5 * 60 * 1000),
    maxAttempts: Number(process.env.AGENT_CALL_MAX_ATTEMPTS || 3),
  };
}

function provider() {
  const c = cfg();
  // BOLNA ONLY (his call, 2026-09-20: "use Bolna AI, remove other call
  // services"). Retell was removed with its engine, webhook and env —
  // one provider means one code path to keep honest.
  if (c.bolnaKey && c.bolnaFrom && c.bolnaAgent) return "bolna";
  return null;
}

function enabled() {
  return Boolean(provider() && cfg().base);
}

// ---------------- IN-MEMORY CALL STORE ----------------
// Calls live minutes, not days: a Map with TTL is enough. A pod restart
// drops pending redial timers — the push on the final outcome is the
// contract the user can rely on, not the timer.

const calls = new Map(); // id -> record
const CALL_TTL_MS = 15 * 60 * 1000;

function gc() {
  const now = Date.now();
  for (const [id, c] of calls) {
    if (now - c.createdAt > CALL_TTL_MS) calls.delete(id);
  }
  for (const [execId, rec] of bolnaExecs) {
    if (now - rec.createdAt > CALL_TTL_MS) bolnaExecs.delete(execId);
  }
}
setInterval(gc, 5 * 60 * 1000).unref?.();

const dayCounts = new Map(); // `${userId}:${yyyy-mm-dd}` -> n
function bumpDaily(userId) {
  const key = `${userId}:${new Date().toISOString().slice(0, 10)}`;
  const today = key.slice(-10);
  for (const k of dayCounts.keys()) {
    if (!k.endsWith(today)) dayCounts.delete(k);
  }
  const n = (dayCounts.get(key) || 0) + 1;
  dayCounts.set(key, n);
  return n;
}
function dailyCount(userId) {
  return dayCounts.get(`${userId}:${new Date().toISOString().slice(0, 10)}`) || 0;
}

// ---------------- TASK MODE ----------------

// "ask / find out / when / what time" => two-way; otherwise a one-way notice.
const ASK_RX =
  /\b(ask|find out|check|confirm|whether|when|what time|what|how|is (he|she|it|they)|are (they|you)|can (you|he|she|they)|will (he|she|they)|did (he|she|they))\b/i;

function detectMode(task) {
  return ASK_RX.test(String(task || "")) ? "ask" : "inform";
}

/** Preview-only: the opening line the agent would say (LLM round-trip —
 *  live calls never pay it; the hosted agent speaks from its own prompt). */
async function buildScript({ userName, contactName, task, lang }) {
  const mode = detectMode(task);
  const who = userName ? userName : "the caller";
  const sys =
    "You write a SHORT phone script for an AI assistant calling someone ON " +
    "BEHALF OF a user. You speak to the CONTACT, not the user. Warm, brief, " +
    "natural. Identify yourself in one clause as calling on " +
    `${who}'s behalf. ` +
    (mode === "ask"
      ? "ASK the contact the user's question. "
      : "INFORM the contact; do not ask a question. ") +
    "Reply with STRICT JSON only, no markdown: " +
    '{"speech":"<the main thing you say>","closing":"<a short sign-off>"}. ' +
    "Keep speech to 1-2 sentences. Use ONLY the language of code " +
    `"${(lang || "en").slice(0, 2)}" (fallback to simple English). ` +
    "Never invent details the user did not give.";
  const user =
    `User's name: ${who}. Contact's name: ${contactName}. ` +
    `What the user asked me to do: "${task}".`;
  try {
    const { reply } = await generateReply([{ role: "user", content: user }], { system: sys });
    const parsed = JSON.parse(stripFences(reply));
    const speech = String(parsed.speech || "").trim();
    if (speech) return { mode, speech };
  } catch (_) {}
  return {
    mode,
    speech:
      mode === "ask"
        ? `Hello, I'm calling on behalf of ${who}. ${task}`
        : `Hello, I'm calling on behalf of ${who} with a message. ${task}`,
  };
}

function stripFences(s) {
  return String(s || "").replace(/```json/gi, "").replace(/```/g, "").trim();
}

// ---------------- BOLNA ----------------

// Bolna's webhook carries no custom metadata: executions are matched by
// execution id, and only the CURRENT attempt's id is live on the record.
const bolnaExecs = new Map(); // execution_id -> rec

async function bolnaPlaceCall({ to, rec }) {
  const c = cfg();
  const r = await fetch("https://api.bolna.ai/call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.bolnaKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      agent_id: c.bolnaAgent,
      recipient_phone_number: to,
      from_phone_number: c.bolnaFrom,
      user_data: {
        task: rec.task || "",
        contact_name: rec.contactName || "there",
        user_name: rec.userName || "the caller",
        mode: rec.selfCall ? "self" : rec.mode || "inform",
      },
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`bolna call ${r.status}: ${body.slice(0, 200)}`);
  }
  const j = await r.json();
  const execId = String(j.execution_id || "");
  if (!execId) throw new Error("bolna call: no execution_id in response");
  rec.bolnaExec = execId;
  bolnaExecs.set(execId, rec);
  return execId;
}

/** Webhook: the raw execution, POSTed several times as status advances —
 *  handlers must be idempotent, and "completed" alone does NOT mean anyone
 *  spoke (a voicemail pickup completes with conversation_duration 0). */
function bolnaWebhook(body) {
  const execId = String(body?.id || body?.execution_id || "");
  const rec = bolnaExecs.get(execId);
  if (!rec || rec.bolnaExec !== execId) return false; // stale attempt / unknown

  const status = String(body?.status || "").toLowerCase();
  if (["queued", "scheduled", "rescheduled", "ringing", "in-progress"].includes(status)) {
    if (rec.state === "dialing" && status === "in-progress") rec.state = "in_progress";
    return true;
  }
  if (!["dialing", "in_progress", "summarizing"].includes(rec.state)) return true; // duplicate

  if (status === "busy" || status === "no-answer") {
    handleNoAnswer(rec);
    return true;
  }
  if (status === "completed") {
    const secs = Number(body?.conversation_duration || 0);
    const transcript = String(body?.transcript || "");
    const theySpoke = /^user\s*:/im.test(transcript);
    // An INFORM call counts once it was heard (secs > 0); an ASK needs the
    // contact's words; a WAKE-UP call needs the USER'S words — a voicemail
    // greeting must never count as the user being awake.
    if (secs <= 0 || (!theySpoke && (rec.selfCall || rec.mode === "ask"))) {
      handleNoAnswer(rec);
      return true;
    }
    rec.answer = transcript.slice(0, 4000) || rec.answer;
    finishCompleted(rec, String(body?.summary || "").trim());
    return true;
  }
  // failed / canceled / stopped / error / balance-low
  rec.retryPending = false;
  rec.state = "failed";
  rec.result =
    status === "balance-low"
      ? "The call couldn't be placed — the calling balance is used up and needs a top-up."
      : `I couldn't complete the call to ${rec.selfCall ? "your phone" : rec.contactName}.`;
  settle(rec);
  return true;
}

// ---------------- OUTCOME + REDIAL ----------------

function finishCompleted(rec, summary) {
  rec.result = summary
    ? rec.selfCall
      ? `I called you as asked. ${summary}`
      : `I spoke with ${rec.contactName}. ${summary}`
    : rec.result ||
      (rec.selfCall
        ? `I called you and delivered the reminder: ${rec.task}`
        : `I spoke with ${rec.contactName} and passed on: ${rec.task}`);
  rec.state = "completed";
  settle(rec);
}

/**
 * No pickup. With attempts left: tell the poller "no answer, retrying in
 * N minutes" and redial after the pause; the eventual outcome travels by
 * push (the app stops polling after ~3 minutes).
 */
function handleNoAnswer(rec) {
  const c = cfg();
  const mins = Math.max(1, Math.round(c.retryMs / 60000));
  if (rec.attempt >= c.maxAttempts) {
    rec.retryPending = false;
    rec.state = "no_answer";
    rec.result = rec.selfCall
      ? `I called your phone ${rec.attempt} times but you didn't pick up: ${rec.task}`
      : `${rec.contactName} didn't pick up — I tried ${rec.attempt} times, so the message wasn't delivered.`;
    settle(rec);
    return;
  }
  rec.retryPending = true;
  rec.state = "no_answer"; // the app's poller treats this as terminal and speaks it
  rec.result =
    `${rec.selfCall ? "You" : rec.contactName} didn't pick up. ` +
    `I'll call again in ${mins} minute${mins === 1 ? "" : "s"} and let you know.`;
  rec.pushOutcome = true;
  if (rec.retryTimer) clearTimeout(rec.retryTimer);
  rec.retryTimer = setTimeout(() => redial(rec), c.retryMs);
  rec.retryTimer.unref?.();
}

async function redial(rec) {
  if (!calls.has(rec.id)) calls.set(rec.id, rec); // survive a GC sweep mid-wait
  rec.attempt += 1;
  rec.retryPending = false;
  rec.retryTimer = null;
  rec.state = "dialing";
  rec.result = null;
  rec.answer = null;
  rec.createdAt = Date.now(); // restart the TTL clock for this attempt
  try {
    rec.providerRef = await placeByProvider(rec);
    if (rec.userId) bumpDaily(rec.userId);
  } catch (e) {
    console.error("agent-call redial failed:", e.message || e);
    rec.state = "failed";
    rec.result = rec.selfCall
      ? "I couldn't place the repeat call to your phone."
      : `I couldn't reach ${rec.contactName} on the repeat call.`;
    settle(rec);
  }
}

function placeByProvider(rec) {
  return bolnaPlaceCall({ to: rec.to, rec });
}

/** Terminal states only: mirror into task_outcomes, and push the outcome
 *  to the user's phone when nothing is polling for it any more. */
function settle(rec) {
  try {
    if (!["completed", "failed", "no_answer"].includes(rec.state)) return;
    if (rec.retryPending) return; // not final — a redial is on the clock
    require("../outcomes/store")
      .updateByExternalId(rec.id, {
        status: rec.state,
        detail: rec.result ? String(rec.result).slice(0, 400) : rec.task,
      })
      .catch(() => {});
    if (rec.pushOutcome && rec.userId && !rec.pushed) {
      rec.pushed = true; // several webhook events settle — push once
      pushOutcome(rec).catch(() => {});
    }
  } catch (_) {}
}

async function pushOutcome(rec) {
  const user = await require("../db").findById(rec.userId);
  if (!user?.fcm_token) return;
  const title =
    rec.state === "completed"
      ? (rec.selfCall ? "I called you" : `Call to ${rec.contactName} done`)
      : rec.state === "no_answer"
        ? (rec.selfCall ? "Missed my calls" : `Couldn't reach ${rec.contactName}`)
        : "Call didn't go through";
  await require("../services/push").sendNotification(
    user.fcm_token,
    title,
    String(rec.result || rec.task || "").slice(0, 180),
    { kind: "agent_call", state: rec.state }
  );
}

// ---------------- PUBLIC API ----------------

async function preview({ userName, contactName, task, lang }) {
  const script = await buildScript({ userName, contactName, task, lang });
  return { opening: script.speech, allowed: true, reason: null, mode: script.mode };
}

/**
 * Place an agent call. Returns { id } (202). Throws { code:"unavailable" }
 * when telephony isn't configured, or { code:"quota" } over the daily limit.
 */
async function start({ userId, userName, toNumber, contactName, task, lang, selfCall }) {
  if (!enabled()) throw { code: "unavailable" };
  const to = normalizeNumber(toNumber);
  if (!to) throw { code: "bad_number" };
  if (userId && dailyCount(userId) >= cfg().dailyLimit) throw { code: "quota" };

  const rec = {
    id: crypto.randomBytes(12).toString("hex"),
    token: crypto.randomBytes(8).toString("hex"),
    userId: userId || null,
    to,
    contactName,
    task,
    lang: lang || "en",
    userName: userName || null,
    mode: detectMode(task),
    state: "dialing",
    result: null,
    answer: null,
    providerRef: null,
    createdAt: Date.now(),
    attempt: 1,
    retryPending: false,
    // Self wake-up calls are never followed by a poller — push from the
    // start; relayed calls start polled and switch to push on first retry.
    pushOutcome: Boolean(selfCall),
    selfCall: Boolean(selfCall),
  };
  calls.set(rec.id, rec);

  try {
    rec.providerRef = await placeByProvider(rec);
    if (userId) bumpDaily(userId);
  } catch (e) {
    rec.state = "failed";
    rec.result = `I couldn't start the call to ${contactName} just now.`;
    settle(rec);
    throw { code: "failed", message: String(e.message || e) };
  }
  return { id: rec.id };
}

/** Poll status. `answer` is the RAW transcript — callers that act on the
 *  reply (the meeting negotiator) need the words, not a summary. */
function status(id) {
  const rec = calls.get(id);
  if (!rec) return null;
  return { state: rec.state, result: rec.result, answer: rec.answer || null };
}

function get(id) {
  return calls.get(id) || null;
}

function normalizeNumber(n) {
  const s = String(n || "").replace(/[^\d+]/g, "");
  if (!s) return null;
  if (s.startsWith("+")) return s;
  if (/^\d{10}$/.test(s)) return `+91${s}`; // bare Indian mobile
  return `+${s}`;
}

module.exports = {
  enabled,
  provider,
  bolnaWebhook,
  preview,
  start,
  status,
  get,
};
