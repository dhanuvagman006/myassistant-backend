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
    // Three minutes between attempts, three attempts (his spec,
    // 2026-09-20: "max call agent can make is 3 calls and also with 3
    // min gap"). Long enough to reach a phone in another room, short
    // enough that a 5 a.m. wake-up still works as a wake-up.
    retryMs: Number(process.env.AGENT_CALL_RETRY_MS || 3 * 60 * 1000),
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

/**
 * WHAT THE AGENT CALLS THEM ON THE PHONE.
 *
 * Contacts are saved the way the OWNER files them, not the way the person
 * is addressed: "Jeevan Aironotic", "Jeevan friend", "Ravi office". The
 * agent read the whole label out — "Hello, Jeevan Aironotic?" — which is
 * how nobody greets anybody (his call, 2026-09-20).
 *
 * So the spoken name is the first real word, past any honorific. The full
 * saved name is kept on the record, because that is what the USER is told
 * afterwards and they may know two Jeevans.
 */
const TITLES = /^(dr|doctor|mr|mrs|ms|miss|shri|smt|sri|prof|professor|sir|madam)\.?$/i;
function spokenName(name) {
  const words = String(name || "")
    .replace(/[_\-.]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (const w of words) {
    if (TITLES.test(w)) continue;
    // A contact saved as a bare number would otherwise be greeted by
    // having its digits read aloud.
    if (!/[a-z\u0900-\u0DFF]/i.test(w)) continue;
    return w.slice(0, 40);
  }
  return "there";
}

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
        // First name only — see spokenName().
        contact_name: spokenName(rec.contactName),
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
  // AN UNRECOGNISED STATUS IS NOT A FAILURE.
  //
  // This used to be a whitelist of "still going" values with everything
  // else falling through to the failure branch. On 2026-09-20 a real call
  // to a contact was declared "I couldn't complete the call to Jeevan"
  // FOUR SECONDS after it started — while the assistant was still
  // speaking to him. The call ran 26 seconds, delivered its message and
  // was recorded by Bolna as completed; only our reading of one
  // intermediate status was wrong.
  //
  // So the test is inverted: only statuses we KNOW to be terminal end the
  // record, and anything unfamiliar is treated as progress and logged, so
  // a provider adding a status to its vocabulary can never again make the
  // assistant deny a call that is happening.
  const TERMINAL = new Set([
    "completed", "busy", "no-answer", "no_answer", "failed", "error",
    "canceled", "cancelled", "stopped", "balance-low", "balance_low",
  ]);
  if (!TERMINAL.has(status)) {
    if (rec.state === "dialing" && /progress|answered|connected|started|ongoing/.test(status)) {
      rec.state = "in_progress";
    } else if (!["queued", "scheduled", "rescheduled", "ringing", "in-progress", "in_progress"].includes(status)) {
      console.warn("bolna: unfamiliar status", JSON.stringify(status), "— treated as still running");
    }
    return true;
  }
  if (!["dialing", "in_progress", "summarizing"].includes(rec.state)) return true; // duplicate

  if (status === "busy" || status === "no-answer" || status === "no_answer") {
    handleNoAnswer(rec);
    return true;
  }
  if (status === "completed") {
    const secs = Number(body?.conversation_duration || 0);
    const transcript = String(body?.transcript || "");
    rec.answer = transcript.slice(0, 4000) || rec.answer;

    // "COMPLETED" IS THE PROVIDER'S WORD, NOT THE OUTCOME.
    //
    // A voicemail picks up, talks for thirty seconds and completes. So
    // does a phone answered and put straight down. Neither delivered
    // anything, and for a 5 a.m. wake-up neither means the user is awake.
    //
    //   voicemail     → never counts, whatever the duration
    //   any call      → somebody has to have SPOKEN; an answering machine
    //                   that never says "user:" is not a delivery
    //   every call    → they must ACKNOWLEDGE (see acknowledged): a
    //                   mumbled "hello" is how people answer in their
    //                   sleep and how they answer before hanging up, and
    //                   he asked for the chasing to apply to reminders
    //                   and to messages for other people, not only to
    //                   wake-up calls.
    const voicemail = body?.answered_by_voice_mail === true;
    const theySpoke = /^user\s*:/im.test(transcript);
    const reached = secs > 0 && theySpoke && !voicemail;
    // EVERY call, not just a wake-up — see acknowledged().
    const done = reached && acknowledged(transcript);

    if (!done) {
      handleNoAnswer(rec);
      return true;
    }
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

/**
 * DID THE CALL ACTUALLY LAND?
 *
 * His spec, 2026-09-20: "call again until I confirm I woke up" — and then,
 * explicitly: "this should not work only for wake up task, even for other
 * reminder tasks it should work… even informing someone".
 *
 * So the bar is the same for every call the assistant places, whoever it
 * is to. ANSWERING IS NOT ACKNOWLEDGING: "hello" is what someone says
 * half asleep, and it is also what someone says before putting the phone
 * straight down — in both cases nothing was delivered, and treating it as
 * success stops the calling one ring before it has done its job.
 *
 * A call counts only when the other person says something affirmative, in
 * any of the languages these calls happen in, or holds a real exchange
 * (three words or more). The bias is deliberate: one more attempt is a
 * mild annoyance, an undelivered 5 a.m. wake-up or an unpassed message is
 * the product failing at the only job it had.
 */
const AFFIRMATIVE =
  /\b(yes|yeah|yep|ya|ok|okay|okey|sure|awake|i'?m up|got it|alright|right|hmm+|understood|thanks|thank you)\b|हाँ|हां|जी|ठीक|उठ|समझ|ಹೌದು|ಸರಿ|ಎದ್ದೆ|ಎದ್ದಿದ್ದೇನೆ|ಗೊತ್ತಾಯ್ತು|ஆம்|சரி|எழுந்த|అవును|సరే|లేచ|ശരി|ഉണർന്ന/i;

function acknowledged(transcript) {
  const said = String(transcript || "")
    .split(/\r?\n/)
    .filter((l) => /^\s*user\s*:/i.test(l))
    .map((l) => l.replace(/^\s*user\s*:/i, "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!said) return false;
  if (AFFIRMATIVE.test(said)) return true;
  // A real exchange, even without a word we recognise.
  return said.split(/\s+/).filter((w) => w.length > 1).length >= 3;
}

// ---------------- OUTCOME + REDIAL ----------------

/**
 * WHAT THEY ACTUALLY SAID, straight from the transcript.
 *
 * Bolna's own `summary` comes back null often enough that relying on it
 * loses the one thing the user asked for — "report me what he said". The
 * transcript is always there, so their own words are the fallback, not a
 * generic "I passed on your message".
 */
function theirWords(transcript) {
  const lines = String(transcript || "")
    .split(/\r?\n/)
    .filter((l) => /^user\s*:/i.test(l))
    .map((l) => l.replace(/^user\s*:/i, "").trim())
    .filter((l) => l.length > 1);
  if (!lines.length) return "";
  const said = lines.join(" ").replace(/\s+/g, " ").trim();
  return said.length > 300 ? said.slice(0, 297) + "…" : said;
}

function finishCompleted(rec, summary) {
  const said = summary || theirWords(rec.answer);
  rec.result = said
    ? rec.selfCall
      ? `I called you as asked. ${said}`
      : `I spoke with ${rec.contactName}. ${summary ? said : `They said: "${said}"`}`
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
        // The conversation itself, so "what did he say?" is answerable
        // from the Calls screen days later, not just in the moment.
        transcript: rec.answer || "",
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

  // EVERY CALL LEAVES A ROW, whoever started it.
  //
  // Only the scheduled path used to create one, so a call placed from the
  // app — the way they are actually made — existed nowhere afterwards:
  // the spoken result was the whole record, and missing it meant it was
  // gone. settle() updates this row by external id when the provider
  // reports back, which is what fills the Calls screen.
  if (userId) {
    require("../outcomes/store")
      .create(userId, {
        kind: "agent_call",
        target: contactName || to,
        detail: task || "",
        status: "dialing",
        path: "relay",
        externalId: rec.id,
      })
      .catch(() => {});
  }

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
