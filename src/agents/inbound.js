/**
 * INBOUND AGENT-MESSAGE AUTO-RESPONDER.
 *
 * When someone's assistant delivers a message to this user, the user may
 * be away for hours — but some messages ask something their assistant can
 * acknowledge IMMEDIATELY from their data ("can we meet on the 13th?").
 * This module runs once per delivered human-initiated message and, when
 * the message is a scheduling/availability question, sends the asker an
 * interim reply on the recipient's behalf:
 *
 *   "Dhanush has a commitment that day — I'll check with him for a good
 *    time and get back to you."
 *
 * PRIVACY: the reply may say busy/free, NEVER what the commitment is.
 * The original message stays UNREAD, so the recipient still hears the
 * question next time they open the app and answers it personally — the
 * auto-reply is a courtesy acknowledgement, not the final answer.
 *
 * LOOP SAFETY: replies are inserted directly (not via the tool) and
 * marked auto=1; this hook only runs from the send_agent_message tool, so
 * an auto-reply can never trigger another auto-reply. One reply per
 * inbound message, LLM failure = silent no-op.
 */
const db = require("../db");
const push = require("../services/push");
const { generateReply } = require("../services/ai/router");

/** "2026-09-13: 2 commitments" lines for the next [days] days. */
async function busyLines(userId, days = 21) {
  const now = Date.now();
  const end = now + days * 86400_000;
  const rows = await db
    .query(
      `SELECT due_at FROM reminders
        WHERE user_id=$1 AND done=0 AND due_at BETWEEN $2 AND $3
       UNION ALL
       SELECT due_at FROM commitments
        WHERE user_id=$1 AND status='open' AND due_at BETWEEN $2 AND $3`,
      [userId, now, end]
    )
    .catch(() => []);
  const byDay = new Map();
  for (const r of rows) {
    const d = new Date(Number(r.due_at)).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + 1);
  }
  if (!byDay.size) return "(no scheduled items in this window)";
  return [...byDay.entries()]
    .sort()
    .map(([d, n]) => `${d}: ${n} item${n === 1 ? "" : "s"}`)
    .join("\n");
}

function firstName(s) {
  return String(s || "").trim().split(/\s+/)[0] || "them";
}

async function onMessageDelivered({ toUserId, fromUserId, fromName, text }) {
  try {
    const uid = Number(toUserId);
    const fid = Number(fromUserId);
    if (!Number.isFinite(uid) || uid <= 0 || !Number.isFinite(fid) || fid <= 0) return;

    const owner = (await db.query(`SELECT name FROM users WHERE id=$1`, [uid]))[0];
    const asker = (await db.query(
      `SELECT name, phone_number, fcm_token FROM users WHERE id=$1 AND phone_verified_at IS NOT NULL`,
      [fid]
    ))[0];
    if (!owner || !asker || !asker.phone_number) return;
    const ownerFirst = firstName(owner.name);
    const askerFirst = firstName(fromName || asker.name);

    const busy = await busyLines(uid);
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const system =
      `You are ${ownerFirst}'s personal assistant, handling an incoming message ` +
      `from ${askerFirst} while ${ownerFirst} is away. Decide whether the message ` +
      `asks about ${ownerFirst}'s availability or proposes a meeting/call/visit at ` +
      `some date or time. If it does NOT (a greeting, plain information, a question ` +
      `only ${ownerFirst} can answer), output exactly {"respond":false}. ` +
      `If it DOES, compose ONE short interim reply (max 2 sentences) speaking AS ` +
      `${ownerFirst}'s assistant, in first person ("I"). Use the schedule data to say ` +
      `whether ${ownerFirst} already has something that day or looks free — but ` +
      `NEVER name, describe or count the commitments; only "has a prior commitment" ` +
      `or "looks free". The availability you report is ${ownerFirst}'s own — refer ` +
      `to ${ownerFirst} by name, never to ${askerFirst}. ALWAYS end by saying you ` +
      `will check with ${ownerFirst} and get back soon. Output STRICT JSON, nothing ` +
      `else. Example: {"respond":true,"reply":"${ownerFirst} looks free that day — ` +
      `I'll confirm with him and get back to you soon."}`;
    const user =
      `Today is ${today}.\n` +
      `Message from ${askerFirst}: "${String(text).slice(0, 500)}"\n\n` +
      `${ownerFirst}'s scheduled items (next 3 weeks):\n${busy}`;

    console.log(`inbound: evaluating message from ${askerFirst} (${fid}) to ${ownerFirst} (${uid})`);
    const out = await generateReply([{ role: "user", content: user }], { system });
    const raw = String(out?.reply || "").replace(/```json|```/g, "").trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) {
      console.warn(`inbound: model returned no JSON: ${raw.slice(0, 160)}`);
      return;
    }
    let parsed;
    try { parsed = JSON.parse(m[0]); } catch (_) {
      console.warn(`inbound: unparseable JSON: ${m[0].slice(0, 160)}`);
      return;
    }
    if (parsed.respond !== true || !parsed.reply || typeof parsed.reply !== "string") {
      console.log(`inbound: decided not to auto-reply (respond=${parsed.respond})`);
      return;
    }
    const reply = parsed.reply.trim().slice(0, 500);
    if (!reply) return;

    await db.query(
      `INSERT INTO agent_messages (from_user_id, to_phone_number, message, created_at, auto)
       VALUES ($1, $2, $3, $4, 1)`,
      [uid, asker.phone_number, reply, Date.now()]
    );
    console.log(`inbound: auto-replied for user ${uid} to ${askerFirst} (user ${fid})`);
    if (asker.fcm_token) {
      await push.sendNotification(
        asker.fcm_token,
        `${ownerFirst}'s assistant replied`,
        "Open the app and your assistant will read it to you.",
        { kind: "agent_message" }
      );
    }
  } catch (e) {
    console.warn("inbound: auto-respond skipped:", e.message);
  }
}

module.exports = { onMessageDelivered };
