/**
 * MEETING NEGOTIATION — Hari arranges it, end to end.
 *
 *   "Set up a call with Ravi sometime next week."
 *
 *   1. find times the user is genuinely free (freeslots.js — real calendar)
 *   2. phone Ravi and offer them
 *   3. hear which one he takes
 *   4. put it in the calendar
 *   5. tell the user what was agreed
 *
 * The user does nothing after the first sentence. This is the feature that
 * is hardest to fake and hardest to copy, because every piece of it —
 * telephony, calendar, contact resolution — has to already work.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It never books a slot the calendar says is taken, and it never books
 * anything the other party did not actually agree to. If the reply is
 * ambiguous ("yeah maybe Thursday could work"), that is reported to the
 * user as ambiguous and nothing is written to the diary — a meeting in the
 * calendar that the other person does not know about is worse than no
 * meeting at all.
 */
const agentCall = require("../agents/agentCall");
const freeslots = require("./freeslots");
const store = require("../fulfillment/store");
const { generateReply } = require("../services/ai/router");

/* ------------------------------------------------------------------ *
 * STARTING
 * ------------------------------------------------------------------ */

/** The task string the call-script writer turns into speech. */
function callTask({ contactName, purpose, slots, userName }) {
  const times = slots.map((s) => s.label).join(", or ");
  return (
    `Ask ${contactName} which of these times suits them for ${purpose || "a meeting"} ` +
    `with ${userName || "them"}: ${times}. Ask them to pick one, or say what ` +
    `would suit them better, and tell me exactly what they said.`
  );
}

/**
 * Opens a negotiation: records it, then phones the contact.
 *
 * @returns {{ok:true, taskId, callId, slots}|{ok:false, reason:string}}
 */
async function start({ userId, userName, contact, purpose, slots, lang }) {
  if (!agentCall.enabled()) return { ok: false, reason: "telephony" };
  if (!contact?.phone) return { ok: false, reason: "no_phone" };
  if (!slots?.length) return { ok: false, reason: "no_slots" };

  // Ledger first, same rule as every other errand: a crash mid-call must
  // leave a traceable task rather than a vanished one.
  const row = await store.create(userId, {
    kind: "meeting",
    provider: "phone",
    path: "call",
    title: `Meeting with ${contact.name}`,
    venue: contact.name,
    phone: contact.phone,
    details: {
      purpose: purpose || null,
      slots: slots.map((s) => ({ startMs: s.startMs, endMs: s.endMs, label: s.label })),
    },
    status: "calling",
  });

  try {
    const { id } = await agentCall.start({
      userId,
      userName,
      toNumber: contact.phone,
      contactName: contact.name,
      task: callTask({ contactName: contact.name, purpose, slots, userName }),
      lang: lang || null,
    });
    await store.update(row.id, { call_id: id });
    return { ok: true, taskId: row.id, callId: id, slots };
  } catch (e) {
    const reason = e?.code === "quota" ? "quota" : "failed";
    await store.update(row.id, {
      status: "failed",
      outcome: `Could not start the call: ${String(e?.message || e).slice(0, 120)}`,
    });
    return { ok: false, reason, taskId: row.id };
  }
}

/* ------------------------------------------------------------------ *
 * INTERPRETING THE REPLY
 * ------------------------------------------------------------------ */

const PARSE_PROMPT = [
  "You are reading what someone said on a phone call when offered a few",
  "meeting times. Decide, strictly, what they agreed to.",
  "",
  "Return STRICT JSON only, no markdown:",
  '{"agreed":true|false,"slot_index":<0-based index of the slot they chose, or null>,',
  ' "counter":"<a different time they proposed, in their words, or empty>",',
  ' "note":"<anything else the user should know, or empty>"}',
  "",
  "RULES:",
  '- agreed=true ONLY for a clear acceptance of one specific offered slot.',
  '- "maybe", "that could work", "let me check", "probably" are NOT agreement.',
  "  Set agreed=false and put what they said in note.",
  "- If they proposed a different time, agreed=false and put it in counter.",
  "- If you cannot tell, agreed=false. A wrongly booked meeting is worse",
  "  than an unbooked one.",
].join("\n");

/**
 * @returns {{agreed:boolean, slotIndex:number|null, counter:string, note:string}}
 */
async function interpret(rawAnswer, slots) {
  const said = String(rawAnswer || "").trim();
  if (!said) return { agreed: false, slotIndex: null, counter: "", note: "" };

  const offered = slots.map((s, i) => `${i}: ${s.label}`).join("\n");
  try {
    const { reply } = await generateReply(
      [{ role: "user", content: `Times offered:\n${offered}\n\nThey said: "${said}"` }],
      { system: PARSE_PROMPT }
    );
    const j = JSON.parse(String(reply || "").replace(/```json|```/g, "").trim());
    const idx = Number.isInteger(j.slot_index) ? j.slot_index : null;
    return {
      agreed: j.agreed === true && idx !== null && idx >= 0 && idx < slots.length,
      slotIndex: idx,
      counter: String(j.counter || "").slice(0, 200),
      note: String(j.note || "").slice(0, 300),
    };
  } catch (_) {
    // Cannot parse: treat as not agreed. Never book on a guess.
    return { agreed: false, slotIndex: null, counter: "", note: said.slice(0, 200) };
  }
}

/* ------------------------------------------------------------------ *
 * FINISHING
 * ------------------------------------------------------------------ */

/**
 * Follows the call to its end, interprets the reply, books the slot if one
 * was genuinely agreed, and returns the sentence to speak to the user.
 *
 * @returns {Promise<{spoken:string, booked:boolean, startMs?:number}>}
 */
async function awaitAndBook({
  userId, taskId, callId, contactName, purpose, slots, tzOffsetMin = 330,
  onStatus, isCancelled,
}) {
  const deadline = Date.now() + 3 * 60 * 1000;
  let last = null;
  let final = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if (isCancelled && isCancelled()) {
      await store.update(taskId, { status: "cancelled", outcome: "Cancelled while ringing." });
      return { spoken: "Alright, I've stopped that.", booked: false };
    }
    const st = agentCall.status(callId);
    if (!st) break;
    if (st.state !== last) {
      last = st.state;
      onStatus?.(st.state);
    }
    if (["completed", "no_answer", "failed"].includes(st.state)) {
      final = st;
      break;
    }
  }

  if (!final || final.state === "no_answer") {
    await store.update(taskId, {
      status: "failed",
      outcome: `${contactName} didn't answer, so nothing is booked.`,
    });
    return {
      spoken: `${contactName} didn't pick up, so nothing's booked. Want me to try again later?`,
      booked: false,
    };
  }
  if (final.state === "failed") {
    await store.update(taskId, { status: "failed", outcome: "The call didn't go through." });
    return { spoken: `I couldn't get through to ${contactName}, so nothing's booked.`, booked: false };
  }

  const verdict = await interpret(final.answer, slots);

  if (!verdict.agreed) {
    const detail = verdict.counter
      ? `they suggested ${verdict.counter} instead`
      : verdict.note
        ? `they said: ${verdict.note}`
        : "they didn't commit to one";
    await store.update(taskId, {
      status: "failed",
      outcome: `No time agreed — ${detail}.`,
    });
    // Nothing goes in the diary. This is the important branch.
    return {
      spoken: `I spoke to ${contactName} but nothing's fixed — ${detail}. Shall I offer different times?`,
      booked: false,
    };
  }

  const slot = slots[verdict.slotIndex];

  // Book it. If the calendar write fails, say so — an agreed meeting the
  // user does not know is unbooked is the worst possible outcome here.
  let booked = false;
  try {
    const gapi = require("../google/api");
    await gapi.createEvent(userId, {
      title: `${purpose || "Meeting"} with ${contactName}`,
      startMs: slot.startMs,
      endMs: slot.endMs,
      description: `Arranged by your assistant over the phone with ${contactName}.`,
    });
    booked = true;
  } catch (e) {
    console.error("negotiator: calendar write failed:", e.message || e);
  }

  await store.update(taskId, {
    status: "confirmed",
    when_at: slot.startMs,
    outcome: `${contactName} agreed ${slot.label}${booked ? " — in your calendar" : " (calendar write failed)"}.`,
  });

  return {
    spoken: booked
      ? `Done — ${contactName} agreed ${slot.label}, and it's in your calendar.`
      : `${contactName} agreed ${slot.label}, but I couldn't write it to your calendar — please add it yourself.`,
    booked,
    startMs: slot.startMs,
  };
}

module.exports = { start, interpret, awaitAndBook, callTask, findSlots: freeslots.findSlots };
