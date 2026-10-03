/**
 * THE MY ASSISTANT NUMBER, ANSWERED (2026-10-03, the owner: "set up inbound
 * calling … go with your decision").
 *
 * Our calls go out from one Bolna number. Until now nobody answered it, so
 * a person calling back after our assistant called them heard nothing.
 * Bolna's inbound agent answers it; before it speaks it asks lookup() who
 * is calling (Bolna gives us 3 s, then goes on without):
 *
 *   user      one of our users, from the number they verified: their own
 *             assistant by phone — what is on today, and a note for later
 *   callback  someone our assistant called for a user in the last 7 days:
 *             whose assistant this is and what the call was about, then
 *             their answer or message is taken for that user
 *   unknown   anyone else: a polite line, and a message only if they name
 *             one of our users (it is kept for the admin, never guessed
 *             onto someone's phone)
 *
 * leave_message is the agent's tool: the words reach the user as a push and
 * a row on the Calls screen. A caller is untrusted: nothing about the user
 * (other numbers, whereabouts, plans) is ever handed to the agent for them.
 */
const db = require("../db");

const CALLBACK_WINDOW_MS = 7 * 24 * 3600 * 1000;
const last10 = (n) => String(n || "").replace(/\D/g, "").slice(-10);
const firstName = (s) => String(s || "").trim().split(/\s+/)[0] || "";
const honorific = (g) => (/^f/i.test(String(g || "")) ? "Ma'am" : /^m/i.test(String(g || "")) ? "Sir" : "");

/** Our user whose verified number this is. */
async function userByNumber(ten) {
  const rows = await db.query(
    `SELECT id, name, gender, preferred_language, fcm_token, phone_number FROM users
      WHERE phone_number IS NOT NULL AND right(regexp_replace(phone_number, '\\D', '', 'g'), 10) = $1
      ORDER BY id LIMIT 1`,
    [ten]
  );
  return rows[0] || null;
}

/** The latest call our assistant placed to this number, within the window. */
async function lastCallTo(ten) {
  const rows = await db.query(
    `SELECT t.user_id, t.target, t.detail, t.created_at, u.name, u.gender, u.phone_number
       FROM task_outcomes t JOIN users u ON u.id = t.user_id
      WHERE t.kind = 'agent_call' AND t.extra->>'to_last10' = $1 AND t.created_at > $2
      ORDER BY t.created_at DESC LIMIT 1`,
    [ten, Date.now() - CALLBACK_WINDOW_MS]
  );
  return rows[0] || null;
}

/** Today's reminders, as one short line for the user calling in. */
async function todayLine(userId) {
  try {
    // Today in India, whatever the server's clock zone.
    const IST = 5.5 * 3600 * 1000;
    const start = { getTime: () => Math.floor((Date.now() + IST) / 86400000) * 86400000 - IST };
    const rows = await db.query(
      `SELECT text AS title, due_at AS remind_at FROM reminders
        WHERE user_id = $1 AND due_at >= $2 AND due_at < $3 AND done = 0
        ORDER BY due_at LIMIT 5`,
      [userId, start.getTime(), start.getTime() + 24 * 3600 * 1000]
    );
    if (!rows.length) return "nothing scheduled";
    return rows
      .map((r) => `${new Date(Number(r.remind_at)).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })} ${r.title}`)
      .join("; ");
  } catch (_) {
    return "";
  }
}

/**
 * Who is calling, as the agent's {{variables}}. Never throws: an empty
 * answer still lets the call go on as "unknown".
 */
async function lookup(contactNumber) {
  const ten = last10(contactNumber);
  if (ten.length !== 10) return { caller_kind: "unknown" };
  try {
    const user = await userByNumber(ten);
    if (user) {
      return {
        caller_kind: "user",
        caller_ref: ten,
        user_name: firstName(user.name),
        honorific: honorific(user.gender),
        user_language: String(user.preferred_language || ""),
        today: await todayLine(user.id),
      };
    }
    const call = await lastCallTo(ten);
    if (call) {
      return {
        caller_kind: "callback",
        caller_ref: ten,
        user_name: firstName(call.name),
        contact_name: String(call.target || ""),
        call_reason: String(call.detail || "").slice(0, 300),
        // Only for the transfer tool; the prompt never says it aloud.
        user_phone: String(call.phone_number || ""),
      };
    }
  } catch (e) {
    console.error("inbound lookup failed:", e.message);
  }
  return { caller_kind: "unknown", caller_ref: ten };
}

/** leave_message: the caller's words, to the user they are for. */
async function leaveMessage({ contact_number, message, caller_name } = {}) {
  const text = String(message || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!text) return { ok: false, error: "empty message" };
  const ten = last10(contact_number);
  const who = String(caller_name || "").trim().slice(0, 60);
  let userId = null;
  let fromUser = false;
  if (ten.length === 10) {
    const user = await userByNumber(ten).catch(() => null);
    if (user) {
      userId = user.id;
      fromUser = true;
    } else {
      const call = await lastCallTo(ten).catch(() => null);
      if (call) userId = call.user_id;
    }
  }
  if (!userId) {
    console.log(`inbound: message from an unknown caller …${ten.slice(-4)} kept for the admin: ${text.slice(0, 120)}`);
    return { ok: true, saved: "admin" };
  }
  const label = fromUser ? "Your note by phone" : `${who || `…${ten.slice(-4)}`} called back`;
  await require("../outcomes/store")
    .create(userId, { kind: "inbound_call", target: who || `…${ten.slice(-4)}`, detail: text, status: "completed", path: "relay" })
    .catch(() => {});
  try {
    const user = await db.findById(userId);
    if (user && user.fcm_token) {
      await require("../services/push").sendNotification(user.fcm_token, label, text.slice(0, 180), { kind: "inbound_call" });
    }
  } catch (_) {}
  return { ok: true, saved: "user" };
}

module.exports = { lookup, leaveMessage, last10 };
