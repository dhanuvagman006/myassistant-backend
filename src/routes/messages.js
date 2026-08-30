/**
 * AGENT-MESSAGE INBOX (behind appAuth) — the receiving half of
 * agent-to-agent messaging. The sender's tool queues rows in
 * agent_messages and fires a push nudge; the recipient's APP calls these
 * to fetch what's waiting and have Hari speak it aloud.
 *
 * GET  /messages/unread          → { messages: [{id, from, message, at}] }
 * POST /messages/read { ids }    → { ok }
 *
 * The inbox is addressed by VERIFIED phone number, not user id — that is
 * the identity other agents deliver to (see phone.js). No verified number
 * means an empty inbox, not an error.
 */
const router = require("express").Router();
const db = require("../db");

async function myPhone(req) {
  const uid = Number(req.user?.sub);
  if (!Number.isInteger(uid) || uid <= 0) return null;
  const u = await db.findById(uid);
  return u?.phone_verified_at ? u.phone_number : null;
}

router.get("/unread", async (req, res) => {
  const phone = await myPhone(req).catch(() => null);
  if (!phone) return res.json({ messages: [] });
  const rows = await db
    .query(
      `SELECT m.id, m.message, m.created_at, u.name AS from_name
         FROM agent_messages m
         LEFT JOIN users u ON u.id = m.from_user_id
        WHERE m.status = 'unread' AND m.to_phone_number = $1
        ORDER BY m.created_at ASC LIMIT 10`,
      [phone]
    )
    .catch(() => []);
  res.json({
    messages: rows.map((r) => ({
      id: r.id,
      from: r.from_name || "Someone",
      message: String(r.message || ""),
      at: Number(r.created_at) || null,
    })),
  });
});

router.post("/read", async (req, res) => {
  const phone = await myPhone(req).catch(() => null);
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map(Number)
    .filter(Number.isInteger);
  if (!phone || !ids.length) return res.json({ ok: true });
  // The phone predicate stops one user marking another's mail as read.
  await db
    .run(
      `UPDATE agent_messages SET status = 'read'
        WHERE id = ANY($1) AND to_phone_number = $2`,
      [ids, phone]
    )
    .catch(() => {});
  res.json({ ok: true });
});

module.exports = router;
