/**
 * AGENT-MESSAGE INBOX (behind appAuth) — the receiving half of
 * agent-to-agent messaging. The sender's tool queues rows in
 * agent_messages and fires a push nudge; the recipient's APP calls these
 * to fetch what's waiting and have Hari speak it aloud.
 *
 * GET  /messages/unread          → { messages: [{id, from, message, at, auto}] }
 *   A video note also carries media:'video' and media_url, the
 *   recipient's own copy at /docs/<id>/file (bearer auth), which
 *   AvatarMessageService.showPending downloads and plays (2026-09-26).
 *   Up to 10 text rows and up to 10 media rows, oldest first.
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
  // TWO QUEUES, EACH WITH ITS OWN LIMIT. The app reads this list twice:
  // the voice path keeps only text rows, the video popup only media rows.
  // Under one "10 oldest" limit, ten old unread texts pushed a new video
  // note out of the answer, so the popup found nothing and the note was
  // never shown (review, 2026-09-26) — and media first would starve the
  // texts the same way. So: the 10 oldest of each, in time order.
  const rows = await db
    .query(
      `SELECT * FROM (
         (SELECT m.id, m.message, m.created_at, m.auto, m.media, m.document_id,
                 u.name AS from_name
            FROM agent_messages m
            LEFT JOIN users u ON u.id = m.from_user_id
           WHERE m.status = 'unread' AND m.to_phone_number = $1 AND m.media = ''
           ORDER BY m.created_at ASC LIMIT 10)
         UNION ALL
         (SELECT m.id, m.message, m.created_at, m.auto, m.media, m.document_id,
                 u.name AS from_name
            FROM agent_messages m
            LEFT JOIN users u ON u.id = m.from_user_id
           WHERE m.status = 'unread' AND m.to_phone_number = $1 AND m.media <> ''
           ORDER BY m.created_at ASC LIMIT 10)
       ) x
       ORDER BY created_at ASC, id ASC`,
      [phone]
    )
    .catch(() => []);
  res.json({
    messages: rows.map((r) => ({
      id: r.id,
      from: r.from_name || "Someone",
      message: String(r.message || ""),
      at: Number(r.created_at) || null,
      // Sent by the other person's ASSISTANT, not typed by them — the app
      // phrases these "X's assistant said" instead of "X said".
      auto: Number(r.auto) === 1,
      // Only on video notes, so a plain message keeps its old shape. The
      // URL is RELATIVE (the app prefixes its base URL) and is the
      // recipient's own document, which /docs serves only to its owner.
      ...(r.media && r.document_id
        ? { media: String(r.media), media_url: `/docs/${Number(r.document_id)}/file` }
        : {}),
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
