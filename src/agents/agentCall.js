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
 * plus PUBLIC_BASE_URL for webhooks. No answer → a redial only when the
 * call asked for one (retryTimes / retryGapMinutes, see start()); the
 * final outcome is pushed to the user's phone.
 */

const crypto = require("crypto");
const { generateReply } = require("../services/ai/router");
const { DEFAULT_TONE } = require("./callAgentConfig");

function cfg() {
  return {
    base: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
    dailyLimit: Number(process.env.AGENT_CALL_DAILY_LIMIT || 20),
    bolnaKey: process.env.BOLNA_API_KEY || "",
    bolnaFrom: process.env.BOLNA_FROM_NUMBER || "",
    bolnaAgent: process.env.BOLNA_AGENT_ID || "",
    // The man's voice is a second agent built from the same definition
    // (callAgentConfig; scripts/bolna_agents.js). Absent, every call is
    // the woman's.
    bolnaAgentMale: process.env.BOLNA_AGENT_ID_MALE || "",
    defaultGender: process.env.BOLNA_DEFAULT_VOICE === "man" ? "man" : "woman",
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

/**
 * SIR OR MA'AM.
 *
 * His instruction, 2026-09-21: "say hello Sir, don't say their name
 * directly". Which honorific is not a guess we can dodge — "sir" to
 * somebody's mother is worse than using her name — so it is read from
 * the contact's own name through the table that already exists for
 * assistant names (users/voiceGender), which knows Indian names and asks
 * the model once for anything it does not.
 *
 * Unknown stays "sir", because that is the word he asked for and because
 * a neutral greeting with no honorific at all sounds like a robocall.
 */
async function honorificFor(name) {
  // A NUMBER IS NOT A NAME (2026-09-26). "Call 6360139965 and tell him…"
  // sent the digits to the name-gender model, the start of the call waited
  // on it, the phone gave up after 20 s and dialled the number ITSELF —
  // while the relayed call went out a moment later to a busy line. No
  // letters, nothing to guess from: the default at once.
  if (!/\p{L}/u.test(String(name || ""))) return "sir";
  try {
    // Never more than two seconds: a slow guess must not hold up the call.
    const g = await Promise.race([
      require("../users/voiceGender").nameGender(name),
      new Promise((resolve) => setTimeout(() => resolve(null), 2000).unref?.()),
    ]);
    if (g === "female") return "ma'am";
  } catch (_) {
    // The model being unreachable must never stop a call going out.
  }
  return "sir";
}

/**
 * WHO SHE IS TALKING TO, AND HOW SHE SAYS IT.
 *
 * A call to the OWNER THEMSELF (a reminder or wake-up call) used to put
 * their first name in every slot — the welcome line opened "Hello,
 * hariraj?" — on the idea that their own assistant using their name was
 * warm. The owner, 2026-09-24: "never ever respond by calling users name,
 * always mention sir or ma'am — know their name but don't use it unless
 * it's necessary"; and 2026-09-25, from that very call's transcript:
 * "only for this user calling by name". A self-call never needs the name
 * (she is not checking she has the right person — she rang their own
 * number for them), so it is not sent at all: the welcome line, the
 * contact and the "user" the prompt talks about are all "Sir" or "Ma'am"
 * from the profile (owner.honorific), and the prompt already in the
 * dashboard cannot say a name it was never given.
 *
 * A call to someone else keeps its rules: "sir"/"ma'am" from the
 * contact's name, first name only for checking, and the owner's name so
 * she can say whose assistant is calling.
 */
async function addressFor(rec) {
  if (rec.selfCall) {
    let title = "Sir";
    try {
      const me = rec.userId ? await require("../db").findById(rec.userId) : null;
      title = require("./owner").honorific(me || {});
    } catch (_) {
      // The profile being unreadable must never stop the reminder going out.
    }
    return { honorific: title, contact_name: title, user_name: title };
  }
  return {
    honorific: await honorificFor(rec.contactName),
    // First name only — see spokenName().
    contact_name: spokenName(rec.contactName),
    user_name: rec.userName || "the caller",
  };
}

async function bolnaPlaceCall({ to, rec }) {
  const c = cfg();
  // ONE AGENT FOR EVERYBODY. Each user used to be able to build their own
  // Bolna agent from a settings screen in the Hub; he had that screen
  // removed on 2026-09-21, and a per-user agent nobody can see or edit is
  // a copy of the configuration that silently stops receiving fixes —
  // the polite, human-sounding prompt shipped the same day would have
  // reached every user EXCEPT the ones who had once opened the screen.
  // src/agents/callAgentConfig.js is the single definition; this is the
  // single agent it is pushed to.
  const agentId = rec.gender === "man" && c.bolnaAgentMale ? c.bolnaAgentMale : c.bolnaAgent;
  // RESOLVED BEFORE THE DIAL CLOCK STARTS.
  //
  // This used to sit inline in the body object, AFTER
  // `signal: AbortSignal.timeout(15000)`. Object properties evaluate in
  // source order, so the 15-second dial budget began ticking and THEN we
  // waited on honorificFor — which, for a name outside the built-in
  // table, makes a model call with a 30-second ceiling of its own. A
  // slow lookup burned the whole budget and fetch was handed an
  // already-aborted signal, so the call never left the building.
  const who = await addressFor(rec);
  // The user's own number rides along for connect_to_user (transfer).
  const me = rec.userId ? await require("../db").findById(rec.userId).catch(() => null) : null;
  const cac = require("./callAgentConfig");
  const langCode = rec.language && cac.LANGUAGES[rec.language.code] ? rec.language.code : null;
  const r = await fetch("https://api.bolna.ai/call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.bolnaKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      agent_id: agentId,
      recipient_phone_number: to,
      from_phone_number: c.bolnaFrom,
      user_data: {
        // A call in another language is told so, and given the words as
        // written (callLanguage.taskFor; 2026-09-26, the client's
        // Malayalam message that came out "in a different Chinese
        // language").
        task: require("./callLanguage").taskFor(rec.task || "", rec.language),
        language: rec.language ? rec.language.name : "",
        // See addressFor(): never the owner's own name on a self-call.
        contact_name: who.contact_name,
        user_name: who.user_name,
        mode: rec.selfCall ? "self" : rec.mode || "inform",
        // How she addresses them, and what the welcome line says
        // ("Hello, {{honorific}}?"). Never empty — an empty one opened
        // every wake-up call with a literal "Hello, ?" — and on a
        // self-call "Sir"/"Ma'am", never the name (addressFor).
        // Resolved above the fetch.
        honorific: who.honorific,
        // THE PROMPT SAYS "HOW YOU SOUND: {{tone}}" AND NOTHING WAS
        // FILLING IT IN. The tool collected a tone, the route passed it,
        // start() dropped it on the floor and the agent was left reading
        // its own placeholder — so every call, including the ones he
        // said were not polite enough, went out with no manner
        // specified at all. The default is the polite one.
        tone: require("./callTone").withAudioTags(rec.tone || DEFAULT_TONE),
        // Woman or man: the prompt's first line and its grammar paragraph.
        persona: cac.persona(rec.gender),
        gender_rules: cac.genderRules(rec.gender, who.user_name),
        // Which language the call opens in, by name for the prompt.
        language: langCode ? cac.LANGUAGES[langCode].name : "English",
        // Mid-call tools identify the call by this.
        call_ref: rec.id,
        user_phone: String(me?.phone_number || ""),
      },
      // The agent is multilingual: open in the message's language and
      // let the platform switch voice and hearing if they change.
      ...(langCode && langCode !== "en" ? { agent_data: { language: langCode } } : {}),
      // Calling hours (callAgentConfig.CALL_HOURS) are for strangers; a
      // 5 a.m. wake-up the user asked for, or an urgent message, goes out.
      ...(rec.selfCall || /urgent/i.test(rec.tone || "") ? { bypass_call_guardrails: true } : {}),
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
  // "call-disconnected" (2026-10-08, prod): Bolna's word for the line
  // dropping. After a real conversation a "completed" follows with the
  // transcript; a call hung up while still ringing gets NOTHING after it,
  // and the row sat at "dialing" for ever. Nobody spoke → no answer now.
  if (status === "call-disconnected" && ["dialing", "in_progress"].includes(rec.state)) {
    const spoke = /^user\s*:/im.test(String(body?.transcript || ""));
    if (!spoke && !(Number(body?.conversation_duration) > 0)) {
      handleNoAnswer(rec);
      return true;
    }
  }
  // What the call cost (ops/spend.js), once per execution.
  if (TERMINAL.has(status)) require("../ops/spend").bolna(rec.userId, body);
  if (!TERMINAL.has(status)) {
    if (rec.state === "dialing" && /progress|answered|connected|started|ongoing/.test(status)) {
      rec.state = "in_progress";
    } else if (!["queued", "scheduled", "rescheduled", "initiated", "ringing", "in-progress", "in_progress", "call-disconnected"].includes(status)) {
      console.warn("bolna: unfamiliar status", JSON.stringify(status), "— treated as still running");
    }
    return true;
  }
  // "summarizing" is finishCompleted reading the outcome: a second
  // "completed" delivery in that window must not set the reminders twice.
  if (!["dialing", "in_progress"].includes(rec.state)) return true; // duplicate

  if (status === "busy" || status === "no-answer" || status === "no_answer") {
    handleNoAnswer(rec);
    return true;
  }
  if (status === "completed") {
    const secs = Number(body?.conversation_duration || 0);
    const transcript = String(body?.transcript || "");
    rec.answer = transcript.slice(0, 4000) || rec.answer;
    // The recording, for the Calls screen (Bolna keeps it; we keep the link).
    const rurl = body?.telephony_data?.recording_url;
    if (rurl && /^https?:\/\//.test(String(rurl))) rec.recording = String(rurl).slice(0, 500);

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
  // What the caller noted mid-call outranks a summary: it is the one line
  // the caller chose to pass on ("he will pay by Friday").
  const noted = (rec.notes || []).join(" ").trim();
  const said = noted || summary || theirWords(rec.answer);
  rec.result = said
    ? rec.selfCall
      ? `I called you as asked. ${said}`
      : `I spoke with ${rec.contactName}. ${summary ? said : `They said: "${said}"`}`
    : rec.result ||
      (rec.selfCall
        ? `I called you and delivered the reminder: ${rec.task}`
        : `I spoke with ${rec.contactName} and passed on: ${rec.task}`);
  // What comes next — a promise, a callback — becomes a reminder before
  // the report goes out (agents/callOutcome). The report waits a moment
  // for it, never forever.
  rec.state = "summarizing";
  const done = () => { rec.state = "completed"; settle(rec); };
  let timer;
  Promise.race([
    require("./callOutcome").record(rec),
    new Promise((res) => { timer = setTimeout(res, 20_000); timer.unref?.(); }),
  ])
    .then((o) => { if (o && o.line) rec.result = `${rec.result} ${o.line}`; })
    .catch(() => {})
    .finally(() => { clearTimeout(timer); done(); });
}

/**
 * No pickup. With attempts left: tell the poller "no answer, retrying in
 * N minutes" and redial after the pause; the eventual outcome travels by
 * push (the app stops polling after ~3 minutes).
 */
function handleNoAnswer(rec) {
  const c = cfg();
  // The POLICY ON THIS CALL wins; the deployment values are only a
  // fallback for records made before the policy existed.
  const maxAttempts = Number(rec.maxAttempts) || 1;
  const retryMs = Number(rec.retryMs) || c.retryMs;
  const mins = Math.max(1, Math.round(retryMs / 60000));
  if (rec.attempt >= maxAttempts) {
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

  // THE RETRY IS A JOB, NOT A TIMER.
  //
  // It used to be an in-process setTimeout, so a restart anywhere inside
  // the six minutes between attempts silently dropped the remaining
  // calls — and a 5 a.m. wake-up that stops after one unanswered ring is
  // the product failing at the only job it had. The queue survives a
  // deploy, a crash and a node move; the worker picks it up on its next
  // 2-second poll.
  if (rec.retryTimer) { clearTimeout(rec.retryTimer); rec.retryTimer = null; }
  require("../infra/jobs")
    .enqueue("agent_call_retry", {
      id: rec.id,
      userId: rec.userId,
      userName: rec.userName,
      to: rec.to,
      contactName: rec.contactName,
      task: rec.task,
      lang: rec.lang,
      // The retry speaks the same language as the first attempt.
      language: rec.language || null,
      mode: rec.mode,
      tone: rec.tone || "",
      gender: rec.gender || "woman",
      selfCall: rec.selfCall,
      attempt: rec.attempt + 1,
      maxAttempts: rec.maxAttempts,
      retryMs: rec.retryMs,
    }, { userId: rec.userId, delayMs: retryMs })
    .catch((e) => {
      // Falling back to the timer is better than losing the retry
      // outright, and it is loud so the queue failure gets noticed.
      console.error("agent-call retry could not be queued:", e.message);
      rec.retryTimer = setTimeout(() => redial(rec), retryMs);
      rec.retryTimer.unref?.();
    });
}

/**
 * Run a queued retry. The in-memory record is usually still here; after a
 * restart it is not, so the job payload carries everything needed to dial
 * again — and REUSES THE SAME id, so the task_outcomes row keeps being
 * updated instead of a second one appearing for the same call.
 */
async function retryFromJob(payload = {}) {
  const id = String(payload.id || "");
  if (!id || !enabled()) return;
  let rec = calls.get(id);

  if (rec) {
    // A later attempt already reached them, or one is on the line right
    // now — either way this job is stale.
    if (["completed", "failed"].includes(rec.state)) return;
    if (rec.state === "dialing" || rec.state === "in_progress") return;
  } else {
    rec = {
      id,
      token: crypto.randomBytes(8).toString("hex"),
      userId: payload.userId || null,
      to: payload.to,
      contactName: payload.contactName,
      task: payload.task || "",
      lang: payload.lang || "en",
      language: payload.language && payload.language.name ? payload.language : null,
      userName: payload.userName || null,
      mode: payload.mode || "inform",
      // A retry must sound like the call it is retrying — a pod restart
      // in between must not turn a firm reminder into a cheerful one.
      tone: String(payload.tone || "").slice(0, require("./callTone").MAX),
      gender: pickGender(payload.gender),
      notes: [],
      recording: null,
      state: "no_answer",
      result: null,
      answer: null,
      providerRef: null,
      createdAt: Date.now(),
      attempt: Math.max(1, Number(payload.attempt) || 2) - 1,
      retryPending: true,
      pushOutcome: true,
      selfCall: Boolean(payload.selfCall),
      maxAttempts: Number(payload.maxAttempts) || 1,
      retryMs: Number(payload.retryMs) || cfg().retryMs,
    };
    calls.set(id, rec);
  }
  rec.attempt = Math.max(1, Number(payload.attempt) || rec.attempt + 1) - 1;
  await redial(rec);
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
    // Logged (numbers blanked) and alerted inside — see noteProviderFailure.
    noteProviderFailure(e);
    rec.state = "failed";
    rec.result = rec.selfCall
      ? "I couldn't place the repeat call to your phone."
      : `I couldn't reach ${rec.contactName} on the repeat call.`;
    settle(rec);
  }
}

async function placeByProvider(rec) {
  const ref = await bolnaPlaceCall({ to: rec.to, rec });
  // A call went out, so whatever was wrong has been fixed.
  trouble.callerRejectedAt = 0;
  return ref;
}

// ---------------- WHEN THE CALLING SERVICE SAYS NO ----------------

/**
 * THE CALLING SERVICE REJECTING OUR OWN NUMBER.
 *
 * 2026-09-24, all day: every call died on Bolna's 400 "Calling
 * from_number +91… doesn't exist for plivo. Please check your agent
 * telephony provider." — the agent's telephony had been switched away
 * from the carrier that owns our number. Nothing the phone or the owner
 * does fixes that; only the dashboard does. Three things follow from it:
 *
 *  1. The DEVELOPER sees it: one item in the admin panel's Feedback list
 *     per hour (feedback/store.alert), with the service's own words.
 *  2. The LOGS say how often, never who: counts only. The service's reply
 *     can carry a phone number, and a contact's number has no business in
 *     a log line.
 *  3. For a short while afterwards the assistant stops pretending it can
 *     relay a message (relayDown): place_phone_call tells the phone to
 *     dial the contact directly and SAYS that the calling service failed,
 *     instead of promising a call that will fail the same way. It clears
 *     on the first call that goes out, or after RELAY_DOWN_MS.
 */
const CALLER_REJECTED = /doesn'?t\s+exist\s+for\s+([a-z0-9_.-]+)/i;
const RELAY_DOWN_MS = Number(process.env.AGENT_CALL_DOWN_MS || 10 * 60 * 1000);
const HOUR = 3600 * 1000;
const trouble = {
  callerRejectedAt: 0, // last time the service rejected our caller number
  alertedAt: 0,        // last ops alert raised from this process
  windowStart: 0,      // start of the current hour of counting
  count: 0,            // rejections in that hour — the only thing logged
};

/** Every phone-number-shaped run of digits, except OUR caller number
 *  when `keep` names it (it is not a contact's, and it is the point). */
function redactNumbers(text, keep = "") {
  const own = String(keep || "").replace(/[^\d]/g, "");
  return String(text || "").replace(/\+?\d[\d\s().-]{6,}\d/g, (m) => {
    const digits = m.replace(/[^\d]/g, "");
    return own && digits === own ? m : "[number]";
  });
}

/** The service's own sentence out of "bolna call 400: {json}". */
function providerMessage(err) {
  const raw = String(err?.message || err || "");
  const body = raw.replace(/^bolna call \d+:\s*/i, "");
  try {
    const j = JSON.parse(body);
    const m = j?.message || j?.detail || j?.error;
    if (m) return String(typeof m === "string" ? m : JSON.stringify(m)).trim();
  } catch (_) {}
  return body.trim();
}

/**
 * Called wherever placing a call threw. Returns what kind of failure it
 * was ("caller_rejected" | "provider"). Never throws: a broken alert must
 * not turn a failed call into a crashed request.
 */
function noteProviderFailure(err) {
  const msg = providerMessage(err);
  const m = msg.match(CALLER_REJECTED);
  if (!m) {
    console.warn("agent-call: the calling service refused a call:",
      redactNumbers(msg).slice(0, 200));
    return "provider";
  }
  const now = Date.now();
  trouble.callerRejectedAt = now;
  if (now - trouble.windowStart > HOUR) {
    trouble.windowStart = now;
    trouble.count = 0;
  }
  trouble.count += 1;
  console.error(
    `agent-call: calling service rejected the caller number ` +
    `(${trouble.count} in the last hour)`
  );
  if (now - trouble.alertedAt >= HOUR) {
    trouble.alertedAt = now;
    const said = redactNumbers(msg, cfg().bolnaFrom).replace(/\s+/g, " ").slice(0, 220);
    try {
      require("../feedback/store")
        .alert(`Calling service rejected the caller number: ${said}`, {
          details:
            "Every call the assistant places fails until the agent's telephony " +
            "provider in the calling dashboard is set back to the carrier that " +
            "owns the caller number. The phone falls back to a direct dial.",
        })
        .catch((e) => console.warn("agent-call: ops alert not filed:", e.message));
    } catch (e) {
      console.warn("agent-call: ops alert not filed:", e.message);
    }
  }
  return "caller_rejected";
}

/** Did the service reject our caller number recently? Then a relayed
 *  message would fail the same way — dial directly and say so. */
function relayDown() {
  return trouble.callerRejectedAt > 0 &&
    Date.now() - trouble.callerRejectedAt < RELAY_DOWN_MS;
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
        extra: {
          recording_url: rec.recording || "",
          notes: rec.notes || [],
          voice: rec.gender || "woman",
          language: rec.language ? rec.language.code : "en",
          // Who was dialled, so a call back can be matched to this user
          // (agents/inboundCalls.js).
          to_last10: String(rec.to || "").replace(/\D/g, "").slice(-10),
        },
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

// ---------------- CALLS THAT NEVER REPORTED BACK ----------------

/**
 * A CALLS ROW NOTHING WILL EVER CLOSE.
 *
 * A call's state lives in this process, and only a webhook or a poller
 * settles its row. A restart mid-call, or a webhook that never came, left
 * it "dialing" for good (production, 2026-09-27: 63 h and 160 h) — the
 * user was never told, and check_task_outcomes kept saying the phone was
 * dialling. The proactive sweep calls this every ten minutes: a row still
 * dialling STALE_MS after its last attempt is closed as failed and the
 * user is pushed, once (the UPDATE is the claim). A redial that is queued,
 * or went out within STALE_MS, keeps its row open — with the user's own
 * retry gap, "dialing" for an hour can be the truth. A row left over from
 * days ago is closed without a push: news that late is only noise.
 *
 * The older of two rows for ONE call is the copy the voice path used to
 * make beside start()'s; the webhook settles only the newest, so the copy
 * is not a call of its own and is removed rather than reported.
 */
const STALE_MS = Number(process.env.AGENT_CALL_STALE_MS || 20 * 60 * 1000);
const STALE_PUSH_WITHIN_MS = 6 * HOUR;
const NO_RESULT = "no result came back from the call";

async function closeStale({ olderThanMs = STALE_MS } = {}) {
  const db = require("../db");
  await require("../outcomes/store").migrate();
  const now = Date.now();
  const cutoff = now - olderThanMs;
  await db.run(
    `DELETE FROM task_outcomes t
      WHERE t.kind = 'agent_call' AND t.status = 'dialing' AND t.external_id <> ''
        AND t.updated_at < $1
        AND EXISTS (SELECT 1 FROM task_outcomes o
                     WHERE o.user_id = t.user_id AND o.external_id = t.external_id
                       AND o.id > t.id)`,
    [cutoff]
  );
  const closed = await db.query(
    `UPDATE task_outcomes t SET status = 'failed', reason = $2, updated_at = $3
      WHERE t.kind = 'agent_call' AND t.status = 'dialing' AND t.updated_at < $1
        AND NOT EXISTS (SELECT 1 FROM jobs j
                         WHERE j.user_id = t.user_id AND j.kind = 'agent_call_retry'
                           AND t.external_id <> '' AND j.payload->>'id' = t.external_id
                           AND (j.status IN ('pending', 'running') OR j.updated_at >= $1))
      RETURNING t.user_id, t.target, t.created_at`,
    [cutoff, NO_RESULT, now]
  );
  for (const r of closed) {
    if (Number(r.created_at) < now - STALE_PUSH_WITHIN_MS) continue;
    try {
      const user = await db.findById(r.user_id);
      if (!user?.fcm_token) continue;
      const who = r.target || "them";
      await require("../services/push").sendNotification(
        user.fcm_token,
        `No result from the call to ${who}`,
        `No result came back from the call to ${who}, so I can't say whether it got through.`,
        { kind: "agent_call", state: "failed" }
      );
    } catch (_) {
      // One unreachable phone must not stop the rest being told.
    }
  }
  if (closed.length) console.log(`agent-call: closed ${closed.length} call(s) with no result`);
  return closed.length;
}

// ---------------- PUBLIC API ----------------

async function preview({ userName, contactName, task, lang }) {
  const script = await buildScript({ userName, contactName, task, lang });
  return { opening: script.speech, allowed: true, reason: null, mode: script.mode };
}

/**
 * Place an agent call. Returns { id } (202). Throws { code:"unavailable" }
 * when telephony isn't configured, { code:"quota" } over the daily limit,
 * or { code:"failed", reason:"caller_rejected"|"provider", message } when
 * the calling service refused — `message` is a plain sentence, never the
 * service's reply (see noteProviderFailure).
 */
async function start({ userId, userName, toNumber, contactName, task, lang, selfCall, retryTimes, retryGapMinutes, tone, gender }) {
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
    // Which language the call speaks: the one chosen when it was
    // confirmed, else named, else the message's own script.
    language: require("./callLanguage").recall(userId, task) ||
      require("./callLanguage").resolve({ requested: lang, message: task }),
    userName: userName || null,
    mode: detectMode(task),
    // HOW SHE SOUNDS, from the situation when the user did not say
    // (dues → firm, a wish → warm, bad news → gentle; agents/callTone.js).
    // The owner, 2026-10-01: "loan recovery needs one voice, wishing
    // another". A tone the user asked for wins.
    tone: require("./callTone").resolve({ requested: tone, task, selfCall }).tone,
    // Whose voice: the one asked for ("in a male voice"), else the default.
    gender: pickGender(gender),
    // What the caller noted for the user mid-call (note_for_user).
    notes: [],
    recording: null,
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
    // WHAT TO DO IF NOBODY PICKS UP — the USER'S decision, not ours.
    //
    // This used to be a fixed 3 attempts / 3 minutes for every call.
    // Retrying a call nobody asked to have retried is the assistant
    // deciding to ring someone repeatedly on the user's behalf, which is
    // theirs to choose (his call, 2026-09-20: "if you are not specified
    // to remind them three times or call after three minutes, do not do
    // that — just ask the user"). Absent an instruction: ONE attempt.
    maxAttempts: Math.min(Math.max(Number(retryTimes) >= 0 ? Number(retryTimes) + 1 : 1, 1), 5),
    retryMs: Math.min(Math.max((Number(retryGapMinutes) || 0) * 60_000, 60_000), 60 * 60_000),
  };
  calls.set(rec.id, rec);

  // EVERY CALL LEAVES A ROW, whoever started it.
  //
  // Only the scheduled path used to create one, so a call placed from the
  // app — the way they are actually made — existed nowhere afterwards:
  // the spoken result was the whole record, and missing it meant it was
  // gone. settle() updates this row by external id when the provider
  // reports back, which is what fills the Calls screen.
  let filed = null;
  if (userId) {
    filed = require("../outcomes/store")
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
    const reason = noteProviderFailure(e);
    rec.state = "failed";
    rec.result = `I couldn't start the call to ${contactName} just now.`;
    // The row must exist before it is settled: callers no longer file a
    // failed row of their own, so a refusal quicker than the INSERT would
    // otherwise leave this call "dialing".
    await filed;
    settle(rec);
    // THE SERVICE'S OWN WORDS STAY ON THE SERVER. Callers put `message`
    // into things the owner reads — a task's outcome, a tool result the
    // model speaks — and the raw reply named the provider and carried a
    // phone number ("from_number +91… doesn't exist for plivo"). The log
    // and the admin alert have the detail; the owner gets the plain fact.
    throw {
      code: "failed",
      reason,
      message: "the calling service could not place the call",
    };
  }
  return { id: rec.id };
}

/** Poll status. `answer` is the RAW transcript — callers that act on the
 *  reply (the meeting negotiator) need the words, not a summary. */
function status(id) {
  const rec = calls.get(id);
  if (!rec) return null;
  return {
    state: rec.state, result: rec.result, answer: rec.answer || null,
    recording: rec.recording || null, notes: rec.notes || [], voice: rec.gender || "woman",
  };
}

function pickGender(g) {
  const s = String(g || "").toLowerCase();
  if (/^(man|male|m|he|him|boy|gent)/.test(s)) return "man";
  if (/^(woman|female|f|she|her|girl|lady)/.test(s)) return "woman";
  return cfg().defaultGender;
}

// ---------------- MID-CALL TOOLS ----------------
// Bolna calls these while the call is live (callAgentConfig.apiTools);
// the caller names the call by the reference it was given.

/** What the caller tells us for the user; kept on the call and in the outcome. */
function toolNote({ call_ref, note }) {
  const rec = calls.get(String(call_ref || ""));
  const text = String(note || "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (!rec) return { ok: false, error: "unknown call" };
  if (!text) return { ok: false, error: "empty note" };
  rec.notes = rec.notes || [];
  if (rec.notes.length < 5 && !rec.notes.includes(text)) rec.notes.push(text);
  return { ok: true, saved: true };
}

/** When the user is free on a day — from their Google calendar, when linked. */
async function toolFreeTime({ call_ref, day }) {
  const rec = calls.get(String(call_ref || ""));
  if (!rec || !rec.userId) return { status: "unknown", reason: "unknown call" };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || "").trim());
  if (!m) return { status: "unknown", reason: "day must be YYYY-MM-DD" };
  try {
    const linked = await require("../google/tokens").accessToken(rec.userId).catch(() => null);
    if (!linked) return { status: "unknown", reason: "calendar not linked" };
    const gapi = require("../google/api");
    const events = await gapi.upcomingEvents(rec.userId, { days: 60, max: 100 });
    if (!Array.isArray(events)) return { status: "unknown", reason: "calendar not available" };
    const busy = events
      .filter((e) => String(e.start || e.startAt || "").slice(0, 10) === day || String(e.date || "").slice(0, 10) === day)
      .map((e) => ({ title: String(e.title || e.summary || "busy").slice(0, 60), start: e.start || e.startAt || "", end: e.end || e.endAt || "" }))
      .slice(0, 12);
    return {
      status: "ok", day, busy,
      suggestion: busy.length
        ? "Offer a time that does not overlap the busy slots, and say the user will confirm."
        : "Nothing is booked that day; offer a time and say the user will confirm.",
    };
  } catch (e) {
    return { status: "unknown", reason: String(e.message || e).slice(0, 80) };
  }
}

/** Dispatch for routes/agentCall.js (POST /agent-call/bolna/tool/:secret/:name). */
async function tool(name, body) {
  if (name === "note_for_user") return toolNote(body || {});
  if (name === "check_free_time") return toolFreeTime(body || {});
  if (name === "leave_message") return require("./inboundCalls").leaveMessage(body || {});
  return { ok: false, error: "unknown tool" };
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
  retryFromJob,
  enabled,
  provider,
  bolnaWebhook,
  preview,
  start,
  status,
  get,
  tool,
  relayDown,
  closeStale,
  // For tests: the live call map and the completion step.
  _calls: calls,
  _finishCompleted: finishCompleted,
  // For tests: the failure bookkeeping, and a way to clear it.
  _trouble: trouble,
  redactNumbers,
  // For tests: how a call addresses the person it rings.
  _addressFor: addressFor,
  _resetTrouble() {
    Object.assign(trouble, { callerRejectedAt: 0, alertedAt: 0, windowStart: 0, count: 0 });
  },
};
