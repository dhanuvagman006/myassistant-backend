/**
 * THE RECEPTIONIST — Hari answers the user's phone.
 *
 * A caller dials the user's Hari number. Plivo hits our answer webhook, and
 * from there this module runs a real spoken conversation: it works out who
 * is calling, decides whether to put them through, and otherwise finds out
 * what they want, answers what it safely can, takes a message, and reports
 * back to the user the moment the call ends.
 *
 * WHY THIS IS THE HARD HALF OF TELEPHONY
 * --------------------------------------
 * An outbound agent call knows its own script — we wrote it. An inbound
 * call is open-ended: a stranger says anything, and the assistant is
 * speaking on the user's behalf to someone who may be a client, a family
 * member, or a scammer. So the constraints are tighter than anywhere else
 * in this codebase:
 *
 *   • Hari never invents facts about the user. Where they are, whether they
 *     will call back, what they charge — unless the user configured an
 *     answer, the honest reply is that she will pass the message on.
 *   • She never confirms anything binding. An appointment is only offered
 *     when the user has explicitly enabled it.
 *   • She never reveals the user's whereabouts, other numbers, or client
 *     information to a caller. A caller is an untrusted party.
 *
 * TURN LIMIT: a phone call with an AI that will not end is worse than a
 * voicemail. MAX_TURNS caps it and the wrap-up is always polite.
 */
const crypto = require("crypto");
const { query, one, run } = require("../db");
const { generateReply } = require("../services/ai/router");

const MAX_TURNS = 6;
const CALL_TTL_MS = 30 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * CONFIG (shares the outbound Plivo credentials)
 * ------------------------------------------------------------------ */

function cfg() {
  return {
    base: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
    voice: process.env.PLIVO_VOICE || "Polly.Aditi",
    asrLang: process.env.PLIVO_ASR_LANG || "en-IN",
  };
}

function enabled() {
  return Boolean(process.env.PUBLIC_BASE_URL);
}

/* ------------------------------------------------------------------ *
 * LIVE CALL STORE — short-lived, in process, like outbound agent calls
 * ------------------------------------------------------------------ */

const live = new Map(); // callId -> record

setInterval(() => {
  const now = Date.now();
  for (const [id, c] of live) if (now - c.startedAt > CALL_TTL_MS) live.delete(id);
}, 5 * 60 * 1000).unref?.();

function get(callId, token) {
  const rec = live.get(callId);
  if (!rec || rec.token !== token) return null;
  return rec;
}

/* ------------------------------------------------------------------ *
 * SETTINGS
 * ------------------------------------------------------------------ */

const DEFAULTS = {
  enabled: true,
  mode: "screen_unknown",
  forward_to: null,
  vip: "",
  availability: "",
  may_book: false,
};

async function getSettings(userId) {
  const row = await one(`SELECT * FROM inbound_settings WHERE user_id=$1`, [userId]);
  if (row) return row;
  // No row yet: fall back to the user's own verified number as the forward
  // target, so forwarding works the moment a number is assigned.
  const u = await one(`SELECT phone_number FROM users WHERE id=$1`, [userId]).catch(() => null);
  return { ...DEFAULTS, user_id: userId, forward_to: u?.phone_number || null };
}

async function saveSettings(userId, patch) {
  const cur = await getSettings(userId);
  const next = { ...DEFAULTS, ...cur, ...patch };
  await run(
    `INSERT INTO inbound_settings
       (user_id, enabled, mode, forward_to, vip, availability, may_book, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_id) DO UPDATE SET
       enabled=$2, mode=$3, forward_to=$4, vip=$5, availability=$6,
       may_book=$7, updated_at=$8`,
    [
      userId, next.enabled !== false, next.mode || "screen_unknown",
      next.forward_to || null, next.vip || "", next.availability || "",
      next.may_book === true, Date.now(),
    ]
  );
  return getSettings(userId);
}

/* ------------------------------------------------------------------ *
 * ANSWERING
 * ------------------------------------------------------------------ */

function xmlEscape(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function say(text) {
  return `<Speak voice="${cfg().voice}">${xmlEscape(text)}</Speak>`;
}

function response(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

/** Ask a question and listen for the answer. */
function ask(rec, text) {
  const c = cfg();
  const action = `${c.base}/inbound/plivo/${rec.callId}/${rec.token}/gather`;
  return response(
    `<GetInput inputType="speech" action="${action}" method="POST" ` +
      `speechEndTimeout="auto" language="${c.asrLang}">${say(text)}</GetInput>` +
      // Nothing heard: say goodbye rather than hanging in silence.
      say("I didn't catch that. I'll let them know you called. Goodbye.") +
      `<Hangup/>`
  );
}

function hangup(text) {
  return response(say(text) + `<Hangup/>`);
}

/**
 * Entry point for the Plivo answer webhook.
 * @param {{to:string, from:string, callUuid:string}} p
 * @returns {Promise<string>} Plivo XML
 */
async function onAnswer({ to, from, callUuid }) {
  const number = normalize(to);
  const caller = normalize(from);

  const owner = await one(
    `SELECT user_id FROM inbound_numbers WHERE phone=$1`,
    [number]
  ).catch(() => null);

  // A number nobody claims must not be answered as if it were someone's.
  if (!owner) {
    return hangup("Sorry, this number isn't in service. Goodbye.");
  }

  const userId = Number(owner.user_id);
  const settings = await getSettings(userId);
  if (settings.enabled === false) {
    return hangup("Sorry, this line isn't taking calls right now. Goodbye.");
  }

  const [user, contact] = await Promise.all([
    one(`SELECT name FROM users WHERE id=$1`, [userId]).catch(() => null),
    identifyCaller(userId, caller),
  ]);

  const assistantName = await assistantNameFor(userId);
  const userName = user?.name ? String(user.name).split(" ")[0] : "them";

  const rec = {
    callId: crypto.randomBytes(12).toString("hex"),
    token: crypto.randomBytes(8).toString("hex"),
    userId, userName, assistantName,
    from: caller,
    callerName: contact?.name || null,
    known: Boolean(contact),
    settings,
    turns: [],
    turnCount: 0,
    outcome: "answered",
    message: "",
    urgency: "normal",
    summary: "",
    startedAt: Date.now(),
    plivoUuid: callUuid || null,
  };
  live.set(rec.callId, rec);

  // FORWARD: a known contact (or a named VIP) goes straight through, so the
  // people who matter are not made to talk to an assistant. This is the
  // behaviour that makes screening acceptable to use at all.
  if (shouldForward(rec)) {
    rec.outcome = "forwarded";
    const c = cfg();
    const hangupUrl = `${c.base}/inbound/plivo/${rec.callId}/${rec.token}/hangup`;
    return response(
      say(`One moment, connecting you to ${rec.userName}.`) +
        `<Dial action="${hangupUrl}" method="POST" timeout="30" callerId="${xmlEscape(rec.from)}">` +
        `<Number>${xmlEscape(normalize(rec.settings.forward_to))}</Number></Dial>` +
        // Dial fell through — nobody picked up. Take a message instead of
        // dropping the caller.
        say(`${rec.userName} isn't picking up. I'll let them know you called. Goodbye.`) +
        `<Hangup/>`
    );
  }

  const greeting = rec.known
    ? `Hello ${rec.callerName}, this is ${assistantName}, ${rec.userName}'s assistant. ` +
      `They can't take the call right now — can I take a message, or is there something I can help with?`
    : `Hello, this is ${assistantName}, ${rec.userName}'s assistant. ` +
      `They can't take the call right now. May I ask who's calling and what it's about?`;

  return ask(rec, greeting);
}

function shouldForward(rec) {
  const s = rec.settings;
  const to = normalize(s.forward_to);
  if (!to) return false;
  if (s.mode === "take_messages") return false;

  const vip = String(s.vip || "")
    .split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  const isVip =
    rec.callerName && vip.some((v) => rec.callerName.toLowerCase().includes(v));

  if (isVip) return true;
  if (s.mode === "screen_unknown" && rec.known) return true;
  return false; // screen_all, or an unknown caller
}

/* ------------------------------------------------------------------ *
 * THE CONVERSATION
 * ------------------------------------------------------------------ */

function systemFor(rec) {
  const s = rec.settings;
  return [
    `You are ${rec.assistantName}, the personal assistant of ${rec.userName}.`,
    `You are ON A PHONE CALL, answering ${rec.userName}'s phone. The person`,
    `you are speaking to is a CALLER${rec.callerName ? ` named ${rec.callerName}` : " you do not know"}.`,
    "",
    "YOUR JOB: find out who they are and what they want, help if you can,",
    "and take a clear message. Be warm, brief and professional — one or two",
    "short sentences per turn, because this is spoken aloud on a phone.",
    "",
    "HARD RULES:",
    `- NEVER invent facts about ${rec.userName}. If you don't know where they`,
    "  are, when they'll be free, what they charge, or whether they'll agree",
    "  to something, say you'll pass the message on.",
    `- NEVER share ${rec.userName}'s other numbers, address, schedule details,`,
    "  or anything about their other clients. The caller is not verified.",
    "- NEVER agree to anything binding on their behalf.",
    "- If the caller is selling something or it's a spam call, be brief and",
    "  end politely.",
    s.availability
      ? `- On availability you MAY say exactly this and nothing more: "${s.availability}"`
      : "- Do not describe their availability at all — you have not been told it.",
    s.may_book
      ? "- You MAY offer to note down a preferred time for an appointment, but say it must be confirmed."
      : "- You may NOT offer or agree an appointment time. Offer to pass on the request.",
    "",
    "Reply with STRICT JSON only, no markdown:",
    '{"say":"<what you say next, spoken>",',
    ' "done":true|false,',
    ' "outcome":"message|booked|answered|blocked",',
    ' "message":"<the message to pass on, or empty>",',
    ' "urgency":"urgent|normal|low",',
    ' "summary":"<one line for the user: who called and what they want>"}',
    "",
    "Set done=true once you have what you need and have said goodbye.",
    'Use outcome "blocked" for a sales or spam call.',
  ].join("\n");
}

/** One conversational turn. Returns Plivo XML. */
async function onGather(rec, params) {
  const heard = String(params.Speech || params.SpeechResult || "").trim();
  rec.turnCount++;

  if (!heard) {
    return hangup(`Sorry, I couldn't hear you. I'll let ${rec.userName} know you called. Goodbye.`);
  }
  rec.turns.push({ who: "caller", text: heard });

  // Out of turns: wrap up rather than looping a caller forever.
  if (rec.turnCount >= MAX_TURNS) {
    const bye = `Thank you — I have that, and I'll pass it to ${rec.userName} straight away. Goodbye.`;
    rec.turns.push({ who: "assistant", text: bye });
    if (!rec.message) rec.message = heard;
    rec.outcome = rec.outcome === "answered" ? "message" : rec.outcome;
    return hangup(bye);
  }

  let out;
  try {
    const history = rec.turns
      .map((t) => `${t.who === "caller" ? "Caller" : "You"}: ${t.text}`)
      .join("\n");
    const { reply } = await generateReply(
      [{ role: "user", content: history }],
      { system: systemFor(rec) }
    );
    out = JSON.parse(String(reply || "").replace(/```json|```/g, "").trim());
  } catch (_) {
    out = null;
  }

  // The model failed. Do the safe, useful thing rather than improvising:
  // take what was said as the message and end courteously.
  if (!out || typeof out.say !== "string" || !out.say.trim()) {
    const bye = `Thank you — I'll pass that on to ${rec.userName}. Goodbye.`;
    rec.turns.push({ who: "assistant", text: bye });
    rec.message = rec.message || heard;
    rec.outcome = "message";
    rec.summary = rec.summary || `Call from ${rec.callerName || rec.from}`;
    return hangup(bye);
  }

  rec.turns.push({ who: "assistant", text: out.say });
  if (out.message) rec.message = String(out.message).slice(0, 1000);
  if (out.summary) rec.summary = String(out.summary).slice(0, 300);
  if (["urgent", "normal", "low"].includes(out.urgency)) rec.urgency = out.urgency;
  if (["message", "booked", "answered", "blocked"].includes(out.outcome)) {
    rec.outcome = out.outcome;
  }

  if (out.done === true) return hangup(out.say);
  return ask(rec, out.say);
}

/* ------------------------------------------------------------------ *
 * END OF CALL
 * ------------------------------------------------------------------ */

/**
 * Persists the call and notifies the user. Runs on the Plivo hangup
 * callback, so it must never throw back into the webhook.
 */
async function onHangup(rec, params = {}) {
  if (rec.saved) return;
  rec.saved = true;

  // A forwarded call that was answered elsewhere needs no message record,
  // but the user should still see that it happened.
  const dialStatus = String(params.DialStatus || params.DialHangupCause || "").toLowerCase();
  if (rec.outcome === "forwarded" && dialStatus && !dialStatus.includes("completed")) {
    rec.outcome = "missed";
  }

  const durationS = Math.round((Date.now() - rec.startedAt) / 1000);
  if (!rec.summary) {
    rec.summary =
      rec.outcome === "forwarded"
        ? `Call from ${rec.callerName || rec.from} — put through to you`
        : `Call from ${rec.callerName || rec.from}`;
  }

  try {
    await run(
      `INSERT INTO inbound_calls
         (user_id, call_id, from_number, caller_name, known, outcome, summary,
          message, urgency, transcript, duration_s, seen, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,FALSE,$12)`,
      [
        rec.userId, rec.callId, rec.from, rec.callerName, rec.known,
        rec.outcome, rec.summary, rec.message, rec.urgency,
        JSON.stringify(rec.turns).slice(0, 20000), durationS, Date.now(),
      ]
    );
  } catch (e) {
    console.error("inbound: could not save call:", e.message);
  }

  // Tell the user. A spam call is filed silently — the whole point of
  // screening is that it does not interrupt them.
  if (rec.outcome !== "blocked") {
    try {
      const u = await one(`SELECT fcm_token FROM users WHERE id=$1`, [rec.userId]);
      if (u?.fcm_token) {
        const title =
          rec.urgency === "urgent"
            ? `Urgent: ${rec.callerName || "someone"} called`
            : `${rec.callerName || "New caller"} called`;
        await require("../services/push").sendNotification(
          u.fcm_token, title, rec.summary
        );
      }
    } catch (_) {}
  }

  live.delete(rec.callId);
}

/* ------------------------------------------------------------------ *
 * HELPERS
 * ------------------------------------------------------------------ */

function normalize(n) {
  const s = String(n || "").replace(/[^\d+]/g, "");
  if (!s) return null;
  if (s.startsWith("+")) return s;
  if (/^\d{10}$/.test(s)) return `+91${s}`;
  return `+${s}`;
}

/** Is this a number the user knows? Name makes the greeting personal. */
async function identifyCaller(userId, phone) {
  if (!phone) return null;
  const bare = phone.replace(/^\+/, "").slice(-10);
  const row = await one(
    `SELECT name FROM (
       SELECT name FROM contacts WHERE user_id=$1 AND right(regexp_replace(phone,'[^0-9]','','g'),10)=$2
       UNION ALL
       SELECT name FROM clients  WHERE user_id=$1 AND right(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'),10)=$2
     ) m LIMIT 1`,
    [userId, bare]
  ).catch(() => null);
  return row || null;
}

async function assistantNameFor(userId) {
  try {
    const p = await require("../users/context").getProfile(userId);
    return p?.assistant?.name || "Hari";
  } catch (_) {
    return "Hari";
  }
}

/* ------------------------------------------------------------------ *
 * THE USER'S CALL LOG
 * ------------------------------------------------------------------ */

async function listCalls(userId, { limit = 20, unseenOnly = false } = {}) {
  return query(
    `SELECT id, from_number, caller_name, known, outcome, summary, message,
            urgency, duration_s, seen, created_at
       FROM inbound_calls
      WHERE user_id=$1 ${unseenOnly ? "AND seen = FALSE" : ""}
      ORDER BY id DESC LIMIT $2`,
    [userId, Math.min(Number(limit) || 20, 50)]
  );
}

async function markSeen(userId, ids = null) {
  if (ids && ids.length) {
    await run(
      `UPDATE inbound_calls SET seen=TRUE WHERE user_id=$1 AND id = ANY($2::bigint[])`,
      [userId, ids]
    );
  } else {
    await run(`UPDATE inbound_calls SET seen=TRUE WHERE user_id=$1 AND seen=FALSE`, [userId]);
  }
}

module.exports = {
  enabled, cfg,
  onAnswer, onGather, onHangup, get,
  getSettings, saveSettings,
  listCalls, markSeen,
  identifyCaller, shouldForward, normalize,
  MAX_TURNS,
  _live: live,
};
