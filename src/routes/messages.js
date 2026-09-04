/**
 * AGENT-MESSAGE INBOX (behind appAuth) — the receiving half of
 * agent-to-agent messaging. The sender's tool queues rows in
 * agent_messages and fires a push nudge; the recipient's APP calls these
 * to fetch what's waiting and have Hari speak it aloud.
 *
 * GET  /messages/unread          → { messages: [{id, from, message, at,
 *                                    media, media_url}] }
 * POST /messages/read { ids }    → { ok }
 * GET  /messages/:id/media       → the avatar video/audio for a message
 *                                  addressed to YOUR verified number
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
      `SELECT m.id, m.message, m.created_at, m.media_kind, u.name AS from_name
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
      // '' | 'audio' | 'video' — when set, the sender's AI avatar media is
      // ready at media_url (same bearer auth as every other call).
      media: r.media_kind || "",
      media_url: r.media_kind ? `/messages/${r.id}/media` : null,
    })),
  });
});

/**
 * Stream the generated avatar media for one message. Access rule: you are
 * the VERIFIED owner of the phone number the message was addressed to —
 * the same predicate the inbox uses. No public or signed URLs exist for
 * this media (§10); the app fetches it with its normal bearer token.
 */
router.get("/:id/media", async (req, res) => {
  const phone = await myPhone(req).catch(() => null);
  if (!phone) return res.status(404).json({ error: "not found" });
  const row = await db
    .one(
      `SELECT m.id, m.render_id, r.media_path, r.media_mime
         FROM agent_messages m
         JOIN avatar_renders r ON r.id = m.render_id
        WHERE m.id = $1 AND m.to_phone_number = $2`,
      [Number(req.params.id), phone]
    )
    .catch(() => null);
  const fs = require("fs");
  if (!row?.media_path || !fs.existsSync(row.media_path)) {
    return res.status(404).json({ error: "not found" });
  }
  const stat = fs.statSync(row.media_path);
  res.setHeader("Content-Type", row.media_mime || "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=3600"); // immutable per id
  res.setHeader("Accept-Ranges", "bytes");
  // Range support so video players can seek without downloading twice.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) {
      return res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Content-Length", end - start + 1);
    return fs.createReadStream(row.media_path, { start, end }).pipe(res);
  }
  res.setHeader("Content-Length", stat.size);
  fs.createReadStream(row.media_path).pipe(res);
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
