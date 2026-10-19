/**
 * WHAT TO DO WITH A NOTIFICATION (2026-10-19, owner: "any WhatsApp message
 * or any important thing … even Swiggy or anything. If you need to inform
 * the user, inform; if it's necessary to keep in memory, keep it; or just
 * respond").
 *
 * The phone's notification listener (HariNotificationListener.kt) sends
 * each new notification here — never one that looks like an OTP or a
 * password, which stays on the phone — and gets back one decision:
 *   reply  — a message someone sent them that deserves an answer: the phone
 *            shows the reply pop-up and listens.
 *   inform — worth a glance now (an order arriving, a bill due, a missed
 *            call from family): the phone shows a short pop-up.
 *   none   — everything else (promotions, routine, chatter).
 * A lasting fact worth knowing later is also saved to their memory, where
 * the Memory page shows it and they can remove it.
 *
 * NOTIFY_TRIAGE_DAILY caps the model calls per user per India day (300).
 */
const { generateReply } = require("../services/ai/router");

const OTP_RX = /\b(otp|one[- ]?time (pass(word|code)?|pin)|verification code|passcode|password|pin is|cvv)\b|\b\d{4,8}\b.{0,30}\b(code|otp)\b/i;
const dailyCap = () => {
  const n = Math.floor(Number(process.env.NOTIFY_TRIAGE_DAILY));
  return Number.isFinite(n) && n > 0 ? n : 300;
};
const used = new Map(); // `${uid}:${date}` → count
const indiaDate = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

const SYSTEM = `You sort one phone notification for a busy professional in India. Reply with JSON only:
{"action":"reply"|"inform"|"none","say":"<one short line for a pop-up, max 90 chars>","remember":"<a lasting fact to keep, or empty>"}

action:
- "reply": a PERSON wrote to them directly (chat, SMS, DM, a mention in a group) and the message expects or invites an answer. Only when can_reply is true.
- "inform": not a chat, but worth seeing now: a delivery or ride arriving, an order status change, a payment received or debited, a bill or due date, a booking confirmed, a meeting starting, a missed call, an important alert.
- "none": promotions, offers, newsletters, app nags, social likes, routine background updates, group chatter not addressed to them, anything already obvious.

say: what the pop-up shows, in plain words. For "reply": who and the gist ("Ravi: are you coming at 7?"). For "inform": the point ("Swiggy order arriving in 5 minutes"). Empty for "none".

remember: ONLY a fact that will still matter in days and that they would want recalled later: a booking or PNR with its date, an appointment, a due date with amount, a new address or contact detail someone shared. Write it as one sentence about the user ("Has a dentist appointment on 24 Oct at 5 pm"). NEVER codes, passwords, OTPs, card or account numbers, balances, or chit-chat. Usually empty.`;

/**
 * n: { app, title, text, can_reply, group }
 * → { action, say, remembered }
 */
async function triage(uid, n) {
  const app = String(n.app || "").slice(0, 60);
  const title = String(n.title || "").slice(0, 120);
  const text = String(n.text || "").slice(0, 600);
  const canReply = n.can_reply === true;
  if (!text.trim() && !title.trim()) return { action: "none", say: "", remembered: false };
  // The phone already keeps these back; this is the second lock.
  if (OTP_RX.test(`${title} ${text}`)) return { action: "none", say: "", remembered: false };

  const fallback = canReply
    ? { action: "reply", say: `${title}: ${text}`.slice(0, 90), remembered: false }
    : { action: "none", say: "", remembered: false };
  const key = `${uid}:${indiaDate()}`;
  const count = used.get(key) || 0;
  if (count >= dailyCap()) return fallback;
  used.set(key, count + 1);
  if (used.size > 5000) used.clear();

  let out;
  try {
    const { reply } = await generateReply(
      [{
        role: "user",
        content: JSON.stringify({ app, title, text, can_reply: canReply, group: n.group === true }),
      }],
      { system: SYSTEM, json: true, maxTokens: 200, timeoutMs: 12_000, noRetry: true },
    );
    out = JSON.parse(String(reply || "").replace(/```json|```/g, "").trim());
  } catch (e) {
    console.error("notify triage:", e.message);
    return fallback;
  }
  let action = ["reply", "inform", "none"].includes(out?.action) ? out.action : "none";
  if (action === "reply" && !canReply) action = "inform";
  const say = action === "none" ? "" : String(out?.say || "").replace(/\s+/g, " ").trim().slice(0, 120);

  let remembered = false;
  const fact = String(out?.remember || "").replace(/\s+/g, " ").trim().slice(0, 240);
  // A PNR or booking number is worth keeping; an account or card number is not.
  const MONEY_ID = /\b(a\/c|acct|account|card|debit|credit|upi|ifsc|balance)\b[^.]{0,40}\d{4,}|\b\d{12,19}\b/i;
  if (fact.length >= 8 && !OTP_RX.test(fact) && !MONEY_ID.test(fact)) {
    try {
      const memory = require("../agents/memory");
      const id = await memory.saveMemory(uid, fact, 2, "semantic");
      if (id) await memory.supersede(uid, fact, id);
      remembered = !!id;
    } catch (e) {
      console.error("notify remember:", e.message);
    }
  }
  return { action, say: say || (action === "none" ? "" : fallback.say), remembered };
}

module.exports = { triage, OTP_RX };
