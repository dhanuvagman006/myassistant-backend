/**
 * GROUPS, AND WHO IS ALREADY HERE.
 * --------------------------------
 *   GET  /chat/directory        my contacts, split into on-app and not
 *   GET  /chat/invite           the text to send the ones who are not
 *   POST /chat/groups           {title, members:[userId]} → create
 *   GET  /chat/groups           my groups, newest activity first
 *   GET  /chat/groups/:id       the messages, and marks them read
 *   POST /chat/groups/:id/send  {text}
 *   POST /chat/groups/:id/agent {enabled} → may my assistant answer here
 *
 * His ask, 2026-09-22: a new-chat button for people already using the
 * app, an invite section for those who are not, groups built from the
 * first list — "and here the twist is our agent has the access to the
 * group", answering for a member who is away.
 *
 * WHAT THIS FILE DOES AND DOES NOT DO. It is the plumbing: membership,
 * messages, unread state, and the per-member switch that decides whether
 * an assistant may speak for someone here. The decision of WHETHER to
 * answer, and what, is agents/groupAgent.js — kept apart because one is
 * a data model that must never guess and the other is a judgement call
 * that must never invent.
 *
 * THE DIRECTORY ONLY EVER SHOWS PEOPLE ALREADY IN YOUR ADDRESS BOOK.
 * It answers "which of MY contacts are here", never "who else exists" —
 * the same bargain WhatsApp makes, and the only one a contact of yours
 * has implicitly agreed to.
 */
const router = require("express").Router();
const { query, one, run } = require("../db");

const uidOf = (req) => {
  const n = Number(req.user?.sub);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** 401 and null, or the id. Every route starts with this. */
function me(req, res) {
  const uid = uidOf(req);
  if (!uid) {
    res.status(401).json({ error: "sign in" });
    return null;
  }
  return uid;
}

/** Am I in this group? Everything else depends on this being right. */
async function membership(groupId, uid) {
  return one(
    `SELECT * FROM chat_group_members WHERE group_id=$1 AND user_id=$2`,
    [groupId, uid]
  ).catch(() => null);
}

/* ------------------------------------------------------------------ */
/* WHO IS ALREADY HERE                                                 */
/* ------------------------------------------------------------------ */

router.get("/directory", async (req, res) => {
  const uid = me(req, res);
  if (uid === null) return;
  try {
    // One pass over the synced address book, joined against verified
    // numbers. A contact with no row in users is someone to invite.
    const rows = await query(
      `SELECT c.name, c.phone, u.id AS user_id, u.name AS app_name
         FROM contacts c
         LEFT JOIN users u
           ON u.phone_number = c.phone AND u.id <> $1
        WHERE c.user_id = $1
        ORDER BY lower(c.name)
        LIMIT 2000`,
      [uid]
    );
    const onApp = [];
    const invite = [];
    const seen = new Set();
    for (const r of rows) {
      if (r.user_id) {
        if (seen.has(r.user_id)) continue; // two saved numbers, one person
        seen.add(r.user_id);
        onApp.push({ userId: r.user_id, name: r.name || r.app_name || "", phone: r.phone });
      } else {
        invite.push({ name: r.name || "", phone: r.phone });
      }
    }
    res.json({ onApp, invite });
  } catch (e) {
    console.error("chat directory:", e.message);
    res.status(502).json({ error: "could not read your contacts" });
  }
});

router.get("/invite", async (req, res) => {
  const uid = me(req, res);
  if (uid === null) return;
  const u = await one(`SELECT name FROM users WHERE id=$1`, [uid]).catch(() => null);
  const first = String(u?.name || "").split(" ")[0];
  res.json({
    text:
      (first ? `${first} is using ` : "I'm using ") +
      "My Assistant — it takes calls, reminders and messages off your " +
      "plate. Get it here: https://hariassistant.tech",
  });
});

/* ------------------------------------------------------------------ */
/* GROUPS                                                              */
/* ------------------------------------------------------------------ */

router.post("/groups", async (req, res) => {
  const uid = me(req, res);
  if (uid === null) return;
  const title = String(req.body?.title || "").trim().slice(0, 80);
  const wanted = Array.isArray(req.body?.members) ? req.body.members : [];
  if (!title) return res.status(400).json({ error: "a group needs a name" });

  // ONLY REAL USERS, AND ONLY PEOPLE YOU HAVE. Trusting the ids the
  // client sent would let anyone add a stranger to a group by guessing a
  // number, so each one is checked against the caller's own contacts.
  const ids = [...new Set(wanted.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    .filter((n) => n !== uid)
    .slice(0, 100);
  let members = [];
  if (ids.length) {
    members = await query(
      `SELECT DISTINCT u.id
         FROM users u
         JOIN contacts c ON c.phone = u.phone_number AND c.user_id = $1
        WHERE u.id = ANY($2::int[])`,
      [uid, ids]
    ).catch(() => []);
  }

  const now = Date.now();
  try {
    const g = await one(
      `INSERT INTO chat_groups (title, created_by, created_at)
       VALUES ($1,$2,$3) RETURNING *`,
      [title, uid, now]
    );
    const all = [uid, ...members.map((m) => Number(m.id))];
    for (const m of all) {
      await run(
        `INSERT INTO chat_group_members (group_id, user_id, joined_at)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [g.id, m, now]
      );
    }
    res.status(201).json({ group: { id: Number(g.id), title, members: all.length } });
  } catch (e) {
    console.error("create group:", e.message);
    res.status(502).json({ error: "could not create the group" });
  }
});

router.get("/groups", async (req, res) => {
  const uid = me(req, res);
  if (uid === null) return;
  try {
    const rows = await query(
      `SELECT g.id, g.title, g.created_at,
              (SELECT COUNT(*)::int FROM chat_group_members x WHERE x.group_id = g.id) AS members,
              (SELECT body FROM chat_group_messages m
                WHERE m.group_id = g.id ORDER BY m.id DESC LIMIT 1) AS last,
              (SELECT from_user_id FROM chat_group_messages m
                WHERE m.group_id = g.id ORDER BY m.id DESC LIMIT 1) AS last_from,
              (SELECT created_at FROM chat_group_messages m
                WHERE m.group_id = g.id ORDER BY m.id DESC LIMIT 1) AS last_at,
              (SELECT COUNT(*)::int FROM chat_group_messages m
                WHERE m.group_id = g.id AND m.id > me.last_read_id
                  AND m.from_user_id <> $1) AS unread,
              me.agent_replies
         FROM chat_groups g
         JOIN chat_group_members me ON me.group_id = g.id AND me.user_id = $1
        ORDER BY COALESCE(
          (SELECT created_at FROM chat_group_messages m
            WHERE m.group_id = g.id ORDER BY m.id DESC LIMIT 1), g.created_at) DESC
        LIMIT 200`,
      [uid]
    );
    res.json({
      groups: rows.map((r) => ({
        id: Number(r.id),
        title: r.title,
        members: r.members,
        last: r.last || "",
        lastAt: Number(r.last_at || r.created_at),
        unread: r.unread || 0,
        agentReplies: Number(r.agent_replies) === 1,
      })),
    });
  } catch (e) {
    console.error("list groups:", e.message);
    res.status(502).json({ error: "could not load your groups" });
  }
});

router.get("/groups/:id", async (req, res) => {
  const uid = me(req, res);
  if (uid === null) return;
  const gid = Number(req.params.id);
  if (!Number.isInteger(gid)) return res.status(400).json({ error: "bad group" });
  const mine = await membership(gid, uid);
  if (!mine) return res.status(404).json({ error: "not in that group" });

  try {
    const [group, rows, people] = await Promise.all([
      one(`SELECT id, title FROM chat_groups WHERE id=$1`, [gid]),
      query(
        `SELECT m.id, m.from_user_id, m.body, m.via, m.created_at, u.name
           FROM chat_group_messages m
           LEFT JOIN users u ON u.id = m.from_user_id
          WHERE m.group_id = $1
          ORDER BY m.id DESC LIMIT 300`,
        [gid]
      ),
      query(
        `SELECT u.id, u.name FROM chat_group_members x
           JOIN users u ON u.id = x.user_id WHERE x.group_id = $1`,
        [gid]
      ),
    ]);

    // READING IS READING. Marking here (rather than on a separate call
    // the app might never make) is what stops a member's assistant
    // answering a question they have already seen.
    const newest = rows.length ? Number(rows[0].id) : Number(mine.last_read_id);
    if (newest > Number(mine.last_read_id)) {
      await run(
        `UPDATE chat_group_members SET last_read_id=$3
          WHERE group_id=$1 AND user_id=$2`,
        [gid, uid, newest]
      ).catch(() => {});
    }

    res.json({
      group: { id: gid, title: group?.title || "", agentReplies: Number(mine.agent_replies) === 1 },
      members: people.map((p) => ({ userId: Number(p.id), name: p.name || "" })),
      messages: rows
        .map((r) => ({
          id: Number(r.id),
          from: Number(r.from_user_id),
          name: r.name || "",
          text: r.body,
          mine: Number(r.from_user_id) === uid,
          at: Number(r.created_at),
        }))
        .reverse(),
    });
  } catch (e) {
    console.error("group thread:", e.message);
    res.status(502).json({ error: "could not load that group" });
  }
});

router.post("/groups/:id/send", async (req, res) => {
  const uid = me(req, res);
  if (uid === null) return;
  const gid = Number(req.params.id);
  const text = String(req.body?.text || "").trim().slice(0, 4000);
  if (!Number.isInteger(gid) || !text) {
    return res.status(400).json({ error: "group and text required" });
  }
  if (!(await membership(gid, uid))) {
    return res.status(404).json({ error: "not in that group" });
  }
  try {
    const row = await insertMessage(gid, uid, text, "user");
    res.status(201).json({ id: Number(row.id), at: Number(row.created_at) });
    // Delivery and any assistant reply happen after the sender has their
    // answer — a slow model must never hold up the send.
    setImmediate(() => {
      require("../agents/groupAgent")
        .onGroupMessage({ groupId: gid, messageId: Number(row.id), fromUserId: uid, text })
        .catch((e) => console.error("group fan-out:", e.message));
    });
  } catch (e) {
    console.error("group send:", e.message);
    res.status(502).json({ error: "could not send that" });
  }
});

router.post("/groups/:id/agent", async (req, res) => {
  const uid = me(req, res);
  if (uid === null) return;
  const gid = Number(req.params.id);
  if (!(await membership(gid, uid))) {
    return res.status(404).json({ error: "not in that group" });
  }
  const on = req.body?.enabled === true;
  await run(
    `UPDATE chat_group_members SET agent_replies=$3 WHERE group_id=$1 AND user_id=$2`,
    [gid, uid, on ? 1 : 0]
  ).catch(() => {});
  res.json({ enabled: on });
});

/** The one place a group message is written, whoever is speaking. */
async function insertMessage(groupId, fromUserId, body, via) {
  return one(
    `INSERT INTO chat_group_messages (group_id, from_user_id, body, via, created_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
    [groupId, fromUserId, String(body).slice(0, 4000), via === "agent" ? "agent" : "user", Date.now()]
  );
}

module.exports = router;
module.exports.insertMessage = insertMessage;
