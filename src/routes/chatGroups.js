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
 *   PATCH  /chat/groups/:id            rename
 *   POST   /chat/groups/:id/members    {members:[userId]} add people
 *   POST   /chat/groups/:id/leave      leave the group
 *   POST   /chat/groups/:id/clear      clear MY copy of the history
 *   POST   /chat/groups/:id/mute       {muted}
 *   DELETE /chat/groups/:id/messages/:mid?everyone=1
 *   POST   /chat/groups/:id/tasks                       {title, items:[text]} share a task list
 *   GET    /chat/groups/:id/tasks/:listId               one list, fresh
 *   POST   /chat/groups/:id/tasks/:listId/items/:itemId {done} tick / untick
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
const { query, one, run, tx } = require("../db");

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
    // THE LIST OBEYS THE SAME CLEAR AND HIDE THE THREAD DOES. Reading
    // the newest row straight off the table showed a message the owner
    // had just cleared, and counted it as unread on the way out. One
    // LATERAL applies the filter once for the preview, and the unread
    // count uses it too (it also replaces four correlated subqueries).
    const rows = await query(
      `SELECT g.id, g.title, g.created_at,
              (SELECT COUNT(*)::int FROM chat_group_members x WHERE x.group_id = g.id) AS members,
              last.body AS last, last.from_user_id AS last_from,
              last.created_at AS last_at, last.deleted AS last_deleted,
              (SELECT COUNT(*)::int FROM chat_group_messages m
                WHERE m.group_id = g.id AND m.id > me.last_read_id
                  AND m.from_user_id <> $1
                  AND m.id > COALESCE(p.cleared_before, 0)
                  AND NOT EXISTS (
                        SELECT 1 FROM chat_hidden_messages h
                         WHERE h.user_id=$1 AND h.kind='group' AND h.message_id=m.id)
              ) AS unread,
              me.agent_replies,
              COALESCE(p.muted, 0) AS muted
         FROM chat_groups g
         JOIN chat_group_members me ON me.group_id = g.id AND me.user_id = $1
         LEFT JOIN chat_prefs p
                ON p.user_id = $1 AND p.kind = 'group' AND p.ref = g.id::text
         LEFT JOIN LATERAL (
           SELECT m.body, m.from_user_id, m.created_at, m.deleted
             FROM chat_group_messages m
            WHERE m.group_id = g.id
              AND m.id > COALESCE(p.cleared_before, 0)
              AND NOT EXISTS (
                    SELECT 1 FROM chat_hidden_messages h
                     WHERE h.user_id=$1 AND h.kind='group' AND h.message_id=m.id)
            ORDER BY m.id DESC LIMIT 1) last ON true
        ORDER BY COALESCE(last.created_at, g.created_at) DESC
        LIMIT 200`,
      [uid]
    );
    res.json({
      groups: rows.map((r) => ({
        id: Number(r.id),
        title: r.title,
        members: r.members,
        last: Number(r.last_deleted) === 1
          ? "This message was deleted"
          : r.last || "",
        lastAt: Number(r.last_at || r.created_at),
        unread: r.unread || 0,
        agentReplies: Number(r.agent_replies) === 1,
        muted: Number(r.muted) === 1,
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
      one(
        `SELECT g.id, g.title,
                COALESCE((SELECT muted FROM chat_prefs p
                           WHERE p.user_id=$2 AND p.kind='group'
                             AND p.ref=g.id::text), 0) AS muted,
                COALESCE((SELECT cleared_before FROM chat_prefs p
                           WHERE p.user_id=$2 AND p.kind='group'
                             AND p.ref=g.id::text), 0) AS cleared_before
           FROM chat_groups g WHERE g.id=$1`,
        [gid, uid]
      ),
      query(
        `SELECT m.id, m.from_user_id, m.body, m.via, m.deleted, m.created_at, m.task_list_id, u.name
           FROM chat_group_messages m
           LEFT JOIN users u ON u.id = m.from_user_id
          WHERE m.group_id = $1
            -- everything the reader has cleared or hidden for themselves
            AND m.id > COALESCE(
              (SELECT cleared_before FROM chat_prefs
                WHERE user_id=$2 AND kind='group' AND ref=$1::text), 0)
            AND NOT EXISTS (
              SELECT 1 FROM chat_hidden_messages h
               WHERE h.user_id=$2 AND h.kind='group' AND h.message_id=m.id)
          ORDER BY m.id DESC LIMIT 300`,
        [gid, uid]
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
    // `rows` is already filtered by cleared_before, so a member who
    // cleared everything saw rows.length === 0 and last_read_id frozen —
    // while the list went on counting those same messages as unread, for
    // good. Clearing is reading: the watermark moves past them too.
    const newest = Math.max(
      rows.length ? Number(rows[0].id) : 0,
      Number(group?.cleared_before || 0),
      Number(mine.last_read_id)
    );
    if (newest > Number(mine.last_read_id)) {
      await run(
        `UPDATE chat_group_members SET last_read_id=$3
          WHERE group_id=$1 AND user_id=$2`,
        [gid, uid, newest]
      ).catch(() => {});
    }

    const lists = await loadLists(
      rows.filter((r) => r.task_list_id && Number(r.deleted) !== 1).map((r) => Number(r.task_list_id))
    );

    res.json({
      group: {
        id: gid,
        title: group?.title || "",
        agentReplies: Number(mine.agent_replies) === 1,
        // The screen reads this back on every poll; without it the menu
        // reset to "Mute notifications" and the first tap could only
        // ever re-mute.
        muted: Number(group?.muted) === 1,
      },
      members: people.map((p) => ({ userId: Number(p.id), name: p.name || "" })),
      messages: rows
        .map((r) => ({
          id: Number(r.id),
          from: Number(r.from_user_id),
          name: r.name || "",
          text: Number(r.deleted) === 1 ? "" : r.body,
          deleted: Number(r.deleted) === 1,
          mine: Number(r.from_user_id) === uid,
          at: Number(r.created_at),
          ...(r.task_list_id && Number(r.deleted) !== 1 && lists.get(Number(r.task_list_id))
            ? { tasks: lists.get(Number(r.task_list_id)) }
            : {}),
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

/* ------------------------------------------------------------------ */
/* MANAGING A CONVERSATION                                             */
/* ------------------------------------------------------------------ */

/** Rename — anyone in the group; it is a shared room, not a possession. */
router.patch("/groups/:id", async (req, res) => {
  const uid = me(req, res);
  if (uid === null) return;
  const gid = Number(req.params.id);
  const title = String(req.body?.title || "").trim().slice(0, 80);
  if (!title) return res.status(400).json({ error: "a name is required" });
  if (!(await membership(gid, uid))) {
    return res.status(404).json({ error: "not in that group" });
  }
  await run(`UPDATE chat_groups SET title=$2 WHERE id=$1`, [gid, title]).catch(() => {});
  res.json({ title });
});

/** Add people — again only from the caller's own address book. */
router.post("/groups/:id/members", async (req, res) => {
  const uid = me(req, res);
  if (uid === null) return;
  const gid = Number(req.params.id);
  if (!(await membership(gid, uid))) {
    return res.status(404).json({ error: "not in that group" });
  }
  const ids = [...new Set((req.body?.members || []).map(Number))]
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 100);
  if (!ids.length) return res.json({ added: 0 });
  const ok = await query(
    `SELECT DISTINCT u.id FROM users u
       JOIN contacts c ON c.phone = u.phone_number AND c.user_id = $1
      WHERE u.id = ANY($2::int[])`,
    [uid, ids]
  ).catch(() => []);
  let added = 0;
  for (const r of ok) {
    const n = await run(
      `INSERT INTO chat_group_members (group_id, user_id, joined_at)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [gid, Number(r.id), Date.now()]
    ).catch(() => 0);
    if (n) added++;
  }
  res.json({ added });
});

/**
 * Leave.
 *
 * The messages they already sent stay: a group where half the history
 * vanishes when someone walks out is unreadable for everyone left in it.
 * What goes is their membership, and with it their assistant's licence
 * to speak there.
 */
router.post("/groups/:id/leave", async (req, res) => {
  const uid = me(req, res);
  if (uid === null) return;
  const gid = Number(req.params.id);
  await run(`DELETE FROM chat_group_members WHERE group_id=$1 AND user_id=$2`, [gid, uid])
    .catch(() => {});
  // Nobody left — nothing to keep.
  const left = await one(
    `SELECT COUNT(*)::int AS n FROM chat_group_members WHERE group_id=$1`, [gid]
  ).catch(() => ({ n: 1 }));
  if (Number(left.n) === 0) {
    await run(`DELETE FROM chat_group_messages WHERE group_id=$1`, [gid]).catch(() => {});
    await run(`DELETE FROM chat_groups WHERE id=$1`, [gid]).catch(() => {});
  }
  res.json({ left: true });
});

/** Clear MY copy. Everyone else's history is untouched. */
router.post("/groups/:id/clear", async (req, res) => {
  const uid = me(req, res);
  if (uid === null) return;
  const gid = Number(req.params.id);
  if (!(await membership(gid, uid))) {
    return res.status(404).json({ error: "not in that group" });
  }
  const last = await one(
    `SELECT COALESCE(MAX(id),0) AS id FROM chat_group_messages WHERE group_id=$1`, [gid]
  ).catch(() => ({ id: 0 }));
  await upsertPref(uid, "group", String(gid), { cleared_before: Number(last.id) });
  res.json({ cleared: true });
});

router.post("/groups/:id/mute", async (req, res) => {
  const uid = me(req, res);
  if (uid === null) return;
  const gid = Number(req.params.id);
  if (!(await membership(gid, uid))) {
    return res.status(404).json({ error: "not in that group" });
  }
  const muted = req.body?.muted === true;
  await upsertPref(uid, "group", String(gid), { muted: muted ? 1 : 0 });
  res.json({ muted });
});

/**
 * Delete one message.
 *
 * ?everyone=1 is only yours to use on your OWN message, and it leaves a
 * tombstone rather than removing the row — the other side has already
 * seen it, and their client needs something to replace it with.
 * Otherwise it is hidden for you alone.
 */
router.delete("/groups/:id/messages/:mid", async (req, res) => {
  const uid = me(req, res);
  if (uid === null) return;
  const gid = Number(req.params.id);
  const mid = Number(req.params.mid);
  if (!Number.isInteger(gid) || !Number.isInteger(mid)) {
    return res.status(400).json({ error: "bad request" });
  }
  if (!(await membership(gid, uid))) {
    return res.status(404).json({ error: "not in that group" });
  }
  const msg = await one(
    `SELECT from_user_id FROM chat_group_messages WHERE id=$1 AND group_id=$2`,
    [mid, gid]
  ).catch(() => null);
  if (!msg) return res.status(404).json({ error: "no such message" });

  const everyone = String(req.query.everyone || "") === "1";
  if (everyone) {
    if (Number(msg.from_user_id) !== uid) {
      return res.status(403).json({ error: "you can only unsend your own messages" });
    }
    await run(`UPDATE chat_group_messages SET deleted=1, body='' WHERE id=$1`, [mid])
      .catch(() => {});
    return res.json({ deleted: "everyone" });
  }
  await run(
    `INSERT INTO chat_hidden_messages (user_id, kind, message_id)
     VALUES ($1,'group',$2) ON CONFLICT DO NOTHING`,
    [uid, mid]
  ).catch(() => {});
  res.json({ deleted: "me" });
});

/* ------------------------------------------------------------------ */
/* TEAM TASK LISTS (owner, 2026-10-04)                                 */
/* ------------------------------------------------------------------ */
/*
 * A list is a native message (chat_group_messages.task_list_id), so it
 * sits in the thread, scrolls with it, can be unsent like any message, and
 * is opened again from there. ANY member may tick or untick ANY task.
 *
 * CONCURRENCY. A tap sends the state the member wants ({done:true|false}),
 * never "toggle": two people tapping the same task at once each get what
 * they asked for, in one atomic row update, and the final state names the
 * last one. Every change returns the whole list and tells the others'
 * phones (a silent push) to refetch, so all screens converge.
 */

const MAX_TASKS = 30;

/** listId -> {id, title, createdBy, items:[{id,text,doneBy,doneByName,doneAt}]} */
async function loadLists(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const [lists, items] = await Promise.all([
    query(`SELECT id, title, created_by FROM chat_task_lists WHERE id = ANY($1::bigint[])`, [ids]),
    query(
      `SELECT i.id, i.list_id, i.text, i.done_by, i.done_at, u.name AS done_name
         FROM chat_task_items i LEFT JOIN users u ON u.id = i.done_by
        WHERE i.list_id = ANY($1::bigint[]) ORDER BY i.list_id, i.position`,
      [ids]
    ),
  ]);
  for (const l of lists) {
    out.set(Number(l.id), { id: Number(l.id), title: l.title || "", createdBy: Number(l.created_by), items: [] });
  }
  for (const i of items) {
    const l = out.get(Number(i.list_id));
    if (!l) continue;
    l.items.push({
      id: Number(i.id),
      text: i.text,
      doneBy: i.done_by == null ? null : Number(i.done_by),
      doneByName: i.done_by == null ? "" : i.done_name || "",
      doneAt: Number(i.done_at) || 0,
    });
  }
  return out;
}

/** The list if it belongs to this group and its message is not unsent. */
async function listInGroup(listId, gid) {
  return one(
    `SELECT l.id FROM chat_task_lists l
       JOIN chat_group_messages m ON m.task_list_id = l.id AND m.deleted = 0
      WHERE l.id = $1 AND l.group_id = $2`,
    [listId, gid]
  ).catch(() => null);
}

/** Tell the other members: a notification ([text]) or a silent refresh. */
async function tellMembers(gid, uid, text) {
  const push = require("../services/push");
  const rows = await query(
    `SELECT u.fcm_token,
            COALESCE((SELECT muted FROM chat_prefs p WHERE p.user_id = x.user_id
                       AND p.kind='group' AND p.ref = x.group_id::text), 0) AS muted
       FROM chat_group_members x JOIN users u ON u.id = x.user_id
      WHERE x.group_id=$1 AND x.user_id <> $2 AND u.fcm_token IS NOT NULL`,
    [gid, uid]
  ).catch(() => []);
  const g = text ? await one(`SELECT title FROM chat_groups WHERE id=$1`, [gid]).catch(() => null) : null;
  for (const m of rows) {
    const silent = !text || Number(m.muted) === 1;
    push
      .send(m.fcm_token, silent ? null : g?.title || "Group", silent ? null : text, {
        kind: silent ? "group_tasks" : "group_message",
        groupId: String(gid),
      })
      .catch(() => {});
  }
}

router.post("/groups/:id/tasks", async (req, res) => {
  const uid = me(req, res);
  if (uid === null) return;
  const gid = Number(req.params.id);
  const title = String(req.body?.title || "").trim().slice(0, 120);
  const items = (Array.isArray(req.body?.items) ? req.body.items : [])
    .map((t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 200))
    .filter(Boolean);
  if (!Number.isInteger(gid) || !items.length) {
    return res.status(400).json({ error: "add at least one task" });
  }
  if (items.length > MAX_TASKS) return res.status(400).json({ error: `up to ${MAX_TASKS} tasks` });
  if (!(await membership(gid, uid))) return res.status(404).json({ error: "not in that group" });
  try {
    const now = Date.now();
    const msg = await tx(async (c) => {
      const l = (await c.query(
        `INSERT INTO chat_task_lists (group_id, created_by, title, created_at)
         VALUES ($1,$2,$3,$4) RETURNING id`, [gid, uid, title, now])).rows[0];
      await c.query(
        `INSERT INTO chat_task_items (list_id, position, text)
         SELECT $1, n, t FROM unnest($2::text[]) WITH ORDINALITY AS x(t, n)`,
        [l.id, items]
      );
      return (await c.query(
        `INSERT INTO chat_group_messages (group_id, from_user_id, body, via, created_at, task_list_id)
         VALUES ($1,$2,$3,'user',$4,$5) RETURNING id, created_at, task_list_id`,
        [gid, uid, `Task list: ${title || `${items.length} tasks`}`, now, l.id])).rows[0];
    });
    const lists = await loadLists([Number(msg.task_list_id)]);
    res.status(201).json({ id: Number(msg.id), at: Number(msg.created_at), tasks: lists.get(Number(msg.task_list_id)) });
    const u = await one(`SELECT name FROM users WHERE id=$1`, [uid]).catch(() => null);
    const first = String(u?.name || "").split(" ")[0] || "Someone";
    tellMembers(gid, uid, `${first} shared a task list${title ? `: ${title}` : ""}`).catch(() => {});
  } catch (e) {
    console.error("task list create:", e.message);
    res.status(502).json({ error: "could not share that list" });
  }
});

router.get("/groups/:id/tasks/:listId", async (req, res) => {
  const uid = me(req, res);
  if (uid === null) return;
  const gid = Number(req.params.id);
  const lid = Number(req.params.listId);
  if (!Number.isInteger(gid) || !Number.isInteger(lid)) return res.status(400).json({ error: "bad request" });
  if (!(await membership(gid, uid))) return res.status(404).json({ error: "not in that group" });
  if (!(await listInGroup(lid, gid))) return res.status(404).json({ error: "no such list" });
  const lists = await loadLists([lid]).catch(() => new Map());
  if (!lists.get(lid)) return res.status(502).json({ error: "could not load that list" });
  res.json({ tasks: lists.get(lid) });
});

router.post("/groups/:id/tasks/:listId/items/:itemId", async (req, res) => {
  const uid = me(req, res);
  if (uid === null) return;
  const gid = Number(req.params.id);
  const lid = Number(req.params.listId);
  const iid = Number(req.params.itemId);
  if (![gid, lid, iid].every(Number.isInteger) || typeof req.body?.done !== "boolean") {
    return res.status(400).json({ error: "done (true or false) required" });
  }
  if (!(await membership(gid, uid))) return res.status(404).json({ error: "not in that group" });
  if (!(await listInGroup(lid, gid))) return res.status(404).json({ error: "no such list" });
  const done = req.body.done;
  try {
    // One atomic statement; a repeat of the same choice changes nothing.
    const row = await one(
      `UPDATE chat_task_items
          SET done_by = CASE WHEN $3 THEN $4::int ELSE NULL END,
              done_at = CASE WHEN $3 THEN $5::bigint ELSE 0 END,
              version = version + 1
        WHERE id = $1 AND list_id = $2
          AND (done_by IS NULL) = $3
        RETURNING id`,
      [iid, lid, done, uid, Date.now()]
    );
    const exists = row || (await one(`SELECT id FROM chat_task_items WHERE id=$1 AND list_id=$2`, [iid, lid]));
    if (!exists) return res.status(404).json({ error: "no such task" });
    const lists = await loadLists([lid]);
    res.json({ tasks: lists.get(lid) });
    if (row) tellMembers(gid, uid, null).catch(() => {});
  } catch (e) {
    console.error("task tick:", e.message);
    res.status(502).json({ error: "could not update that task" });
  }
});

/** One upsert for every per-conversation setting. */
async function upsertPref(userId, kind, ref, patch) {
  const cols = Object.keys(patch);
  const sets = cols.map((c, i) => `${c}=$${i + 4}`).join(", ");
  await run(
    `INSERT INTO chat_prefs (user_id, kind, ref, ${cols.join(", ")})
     VALUES ($1,$2,$3,${cols.map((_, i) => `$${i + 4}`).join(",")})
     ON CONFLICT (user_id, kind, ref) DO UPDATE SET ${sets}`,
    [userId, kind, ref, ...cols.map((c) => patch[c])]
  ).catch((e) => console.error("chat pref:", e.message));
}

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
module.exports.upsertPref = upsertPref;
