/**
 * CHAT — the WhatsApp-style view over the agent-message rail.
 *
 * The same agent_messages rows that the assistant SPEAKS also render as
 * chat threads here: one thread per counterpart, bubbles both ways,
 * documents inline. Typing in the chat and telling the assistant to
 * "message Allen" land in the same place — one rail, two faces.
 *
 *   GET  /chat/threads        one row per counterpart, newest first
 *   GET  /chat/thread/:phone  full history with them; marks incoming READ
 *                             (read in chat must not be re-spoken later)
 *   POST /chat/send           {phone, text} → deliver + push nudge
 */
const router = require("express").Router();
const { query, one, run } = require("../db");
const { normalizePhone } = require("../users/phone");

const uidOf = (req) => {
  const n = Number(req.user?.sub);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** The caller's own verified number — their inbox address. */
async function myPhone(uid) {
  const u = await one(`SELECT phone_number FROM users WHERE id=$1`, [uid]);
  return u?.phone_number || null;
}

router.get("/threads", async (req, res) => {
  const uid = uidOf(req);
  if (!uid) return res.status(401).json({ error: "sign in" });
  const mine = await myPhone(uid);

  // Outgoing: rows I sent. Incoming: rows addressed to my number.
  const [out, inc] = await Promise.all([
    query(
      `SELECT m.id, m.to_phone_number AS phone, m.message, m.created_at,
              m.document_id, m.from_document_id, u.name
         FROM agent_messages m
         LEFT JOIN users u ON u.phone_number = m.to_phone_number
        WHERE m.from_user_id = $1
        ORDER BY m.id DESC LIMIT 500`,
      [uid]
    ),
    mine
      ? query(
          `SELECT m.id, u.phone_number AS phone, m.message, m.created_at,
                  m.status, m.document_id, m.from_document_id, u.name
             FROM agent_messages m
             LEFT JOIN users u ON u.id = m.from_user_id
            WHERE m.to_phone_number = $1
            ORDER BY m.id DESC LIMIT 500`,
          [mine]
        )
      : [],
  ]);

  const threads = new Map(); // phone -> {phone,name,last,lastAt,unread}
  const touch = (phone, name, text, at, unreadDelta) => {
    if (!phone) return;
    const t = threads.get(phone) || {
      phone, name: null, last: "", lastAt: 0, unread: 0,
    };
    if (name && !t.name) t.name = name;
    if (Number(at) > t.lastAt) {
      t.lastAt = Number(at);
      t.last = text;
    }
    t.unread += unreadDelta;
    threads.set(phone, t);
  };
  for (const m of out) touch(m.phone, m.name, m.message, m.created_at, 0);
  for (const m of inc) {
    touch(m.phone, m.name, m.message, m.created_at, m.status === "unread" ? 1 : 0);
  }

  res.json({
    threads: [...threads.values()]
      .sort((a, b) => b.lastAt - a.lastAt)
      .map((t) => ({
        phone: t.phone,
        name: t.name || t.phone,
        last: String(t.last || "").slice(0, 120),
        lastAt: t.lastAt,
        unread: t.unread,
      })),
  });
});

router.get("/thread/:phone", async (req, res) => {
  const uid = uidOf(req);
  if (!uid) return res.status(401).json({ error: "sign in" });
  const them = normalizePhone(req.params.phone) || req.params.phone;
  const mine = await myPhone(uid);

  const [out, inc] = await Promise.all([
    query(
      `SELECT id, message, created_at, status, auto, deleted, document_id, from_document_id
         FROM agent_messages
        WHERE from_user_id = $1 AND to_phone_number = $2
        ORDER BY id ASC LIMIT 500`,
      [uid, them]
    ),
    mine
      ? query(
          `SELECT m.id, m.message, m.created_at, m.status, m.auto, m.deleted,
                  m.document_id, m.from_document_id
             FROM agent_messages m
             JOIN users u ON u.id = m.from_user_id
            WHERE m.to_phone_number = $1 AND u.phone_number = $2
            ORDER BY m.id ASC LIMIT 500`,
          [mine, them]
        )
      : [],
  ]);

  // Read in chat = read. The voice path only speaks status='unread', so
  // without this, everything read on screen gets re-announced out loud.
  const unreadIds = inc.filter((m) => m.status === "unread").map((m) => m.id);
  if (unreadIds.length) {
    await run(
      `UPDATE agent_messages SET status='read' WHERE id = ANY($1::bigint[])`,
      [unreadIds]
    ).catch(() => {});
  }

  // WHAT THIS PERSON HAS CLEARED OR HIDDEN. Their own copy of a
  // conversation is theirs to prune; nobody else's view changes.
  const [pref, hidden] = await Promise.all([
    one(
      `SELECT cleared_before FROM chat_prefs
        WHERE user_id=$1 AND kind='direct' AND ref=$2`,
      [uid, them]
    ).catch(() => null),
    query(
      `SELECT message_id FROM chat_hidden_messages WHERE user_id=$1 AND kind='direct'`,
      [uid]
    ).catch(() => []),
  ]);
  const clearedBefore = Number(pref?.cleared_before || 0);
  const hiddenIds = new Set(hidden.map((h) => Number(h.message_id)));
  const visible = (m) =>
    Number(m.id) > clearedBefore && !hiddenIds.has(Number(m.id));

  const items = [
    ...out.filter(visible).map((m) => ({
      id: Number(m.id),
      mine: true,
      deleted: Number(m.deleted) === 1,
      text: Number(m.deleted) === 1 ? "" : m.message,
      at: Number(m.created_at),
      auto: m.auto === 1,
      // Each side references the copy it OWNS (auth on /docs/:id/file).
      documentId: m.from_document_id ? Number(m.from_document_id) : null,
    })),
    ...inc.filter(visible).map((m) => ({
      id: Number(m.id),
      mine: false,
      deleted: Number(m.deleted) === 1,
      text: Number(m.deleted) === 1 ? "" : m.message,
      at: Number(m.created_at),
      auto: m.auto === 1,
      documentId: m.document_id ? Number(m.document_id) : null,
    })),
  ].sort((a, b) => a.at - b.at || a.id - b.id);

  res.json({ items });
});

/* ------------------------------------------------------------------ */
/* MANAGING A DIRECT THREAD                                            */
/* ------------------------------------------------------------------ */

/** Clear my copy of a conversation. Theirs is untouched. */
router.post("/thread/:phone/clear", async (req, res) => {
  const uid = uidOf(req);
  if (!uid) return res.status(401).json({ error: "sign in" });
  const them = normalizePhone(req.params.phone) || req.params.phone;
  const mine = await myPhone(uid);
  const last = await one(
    `SELECT COALESCE(MAX(id),0) AS id FROM agent_messages
      WHERE (from_user_id=$1 AND to_phone_number=$2)
         OR (to_phone_number=$3 AND from_user_id IN
              (SELECT id FROM users WHERE phone_number=$2))`,
    [uid, them, mine || ""]
  ).catch(() => ({ id: 0 }));
  await setPref(uid, them, { cleared_before: Number(last.id) });
  res.json({ cleared: true });
});

router.post("/thread/:phone/mute", async (req, res) => {
  const uid = uidOf(req);
  if (!uid) return res.status(401).json({ error: "sign in" });
  const them = normalizePhone(req.params.phone) || req.params.phone;
  const muted = req.body?.muted === true;
  await setPref(uid, them, { muted: muted ? 1 : 0 });
  res.json({ muted });
});

/**
 * Delete one message. ?everyone=1 unsends your own — a tombstone, not a
 * row removal, because the other side has already seen it and their
 * client needs something to replace it with.
 */
router.delete("/message/:id", async (req, res) => {
  const uid = uidOf(req);
  if (!uid) return res.status(401).json({ error: "sign in" });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "bad id" });
  const mine = await myPhone(uid);
  const msg = await one(
    `SELECT from_user_id, to_phone_number FROM agent_messages WHERE id=$1`, [id]
  ).catch(() => null);
  if (!msg) return res.status(404).json({ error: "no such message" });
  // It has to be a message I can see at all — mine, or addressed to me.
  const involved =
    Number(msg.from_user_id) === uid ||
    (mine && String(msg.to_phone_number) === String(mine));
  if (!involved) return res.status(403).json({ error: "not your message" });

  if (String(req.query.everyone || "") === "1") {
    if (Number(msg.from_user_id) !== uid) {
      return res.status(403).json({ error: "you can only unsend your own messages" });
    }
    await run(`UPDATE agent_messages SET deleted=1, message='' WHERE id=$1`, [id])
      .catch(() => {});
    return res.json({ deleted: "everyone" });
  }
  await run(
    `INSERT INTO chat_hidden_messages (user_id, kind, message_id)
     VALUES ($1,'direct',$2) ON CONFLICT DO NOTHING`,
    [uid, id]
  ).catch(() => {});
  res.json({ deleted: "me" });
});

/**
 * Shared upsert for a direct thread's per-person settings.
 *
 * The placeholders start at $3 because 'direct' is written as a literal
 * rather than a parameter. The first cut numbered them from $4 (copied
 * from the group version, where kind IS a parameter) and then filtered a
 * placeholder out of the array to compensate — which silently wrote the
 * wrong column. Values are never juggled to fit a query string.
 */
async function setPref(userId, phone, patch) {
  const cols = Object.keys(patch);
  const sets = cols.map((c, i) => `${c}=$${i + 3}`).join(", ");
  await run(
    `INSERT INTO chat_prefs (user_id, kind, ref, ${cols.join(", ")})
     VALUES ($1,'direct',$2,${cols.map((_, i) => `$${i + 3}`).join(",")})
     ON CONFLICT (user_id, kind, ref) DO UPDATE SET ${sets}`,
    [userId, phone, ...cols.map((c) => patch[c])]
  ).catch((e) => console.error("chat pref:", e.message));
}

router.post("/send", async (req, res) => {
  const uid = uidOf(req);
  if (!uid) return res.status(401).json({ error: "sign in" });
  const them = normalizePhone(String(req.body?.phone || ""));
  const text = String(req.body?.text || "").trim().slice(0, 2000);
  if (!them || !text) return res.status(400).json({ error: "phone and text required" });

  const recipient = await one(
    `SELECT id, name, fcm_token FROM users
      WHERE phone_number = $1 AND phone_verified_at IS NOT NULL LIMIT 1`,
    [them]
  );
  if (!recipient) {
    return res.status(404).json({ error: "That person isn't on the app yet." });
  }
  const row = await one(
    `INSERT INTO agent_messages (from_user_id, to_phone_number, message, created_at)
     VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
    [uid, them, text, Date.now()]
  );
  if (recipient.fcm_token) {
    try {
      const me = await one(`SELECT name FROM users WHERE id=$1`, [uid]);
      await require("../services/push").sendNotification(
        recipient.fcm_token,
        me?.name ? `${me.name.split(" ")[0]} sent you a message` : "New message",
        "Open the app to read it.",
        { kind: "agent_message" }
      );
    } catch (_) {}
  }
  res.json({
    ok: true,
    item: { id: Number(row.id), mine: true, text, at: Number(row.created_at), auto: false, documentId: null },
  });
});

module.exports = router;
