/**
 * THE ASSISTANT IN A GROUP.
 * -------------------------
 * His ask, 2026-09-22: "the agent has access to the group and here
 * instead of the user the agents will be responding for the message sent
 * based on the information it has about the user, and it should not
 * hallucinate and should not respond for the things it don't know, and
 * should communicate with the user when user is back… understand his
 * characteristics and how he might respond."
 *
 * FOUR RULES HOLD THIS TOGETHER, and every one of them exists because
 * the obvious version is worse:
 *
 *  1. THE PERSON GETS FIRST REFUSAL. Nothing is answered for anyone
 *     until a delay has passed and they still have not read it. An
 *     assistant that replies in two seconds is not helping, it is
 *     talking over its own user — and it makes the group feel answered
 *     by a machine even when the words are right.
 *
 *  2. IT ANSWERS ONLY FROM FACTS IT HAS. The model is handed the user's
 *     actual calendar shape, their open commitments and what it has been
 *     told to remember, and it is told plainly that anything outside
 *     that list is not answerable. "It should not respond for the things
 *     it don't know" is not a style note; it is the whole safety
 *     property of this feature.
 *
 *  3. WHEN IN DOUBT IT SAYS NOTHING AND TELLS THE USER. Silence is
 *     always available and always safe. A wrong "yes, he's free
 *     Saturday" costs someone a Saturday.
 *
 *  4. AN ASSISTANT NEVER ANSWERS AN ASSISTANT. Replies are written with
 *     via='agent' and those rows never trigger another reply, or two
 *     absent members' assistants would hold a conversation with each
 *     other all afternoon.
 *
 * ON HONESTY. He asked that the reply not be labelled per message and
 * read as the user's own. It is stored as via='agent' either way — the
 * record is always true even where the bubble is not — and the group
 * screen states once, to everyone in it, that members' assistants may
 * answer while they are away. That is what makes the unlabelled message
 * fair: nobody in the room is under an illusion about how the room
 * works, which is a different thing from deceiving them message by
 * message.
 */
const db = require("../db");
const push = require("../services/push");
const { generateReply } = require("../services/ai/router");

/** How long the person has to answer for themselves before the
 *  assistant considers it. Long enough to pick up a phone, short enough
 *  that the group is not left hanging. */
const GRACE_MS = Number(process.env.GROUP_AGENT_GRACE_MS || 3 * 60_000);

/* ------------------------------------------------------------------ */
/* FAN-OUT                                                             */
/* ------------------------------------------------------------------ */

/**
 * A message landed in a group. Nudge everyone else, and line up an
 * assistant reply for anyone who has switched one on.
 */
async function onGroupMessage({ groupId, messageId, fromUserId, text }) {
  const [group, members] = await Promise.all([
    db.one(`SELECT title FROM chat_groups WHERE id=$1`, [groupId]).catch(() => null),
    db.query(
      `SELECT x.user_id, x.agent_replies, u.name, u.fcm_token,
              COALESCE((SELECT muted FROM chat_prefs p
                         WHERE p.user_id = x.user_id AND p.kind='group'
                           AND p.ref = x.group_id::text), 0) AS muted
         FROM chat_group_members x
         JOIN users u ON u.id = x.user_id
        WHERE x.group_id=$1 AND x.user_id <> $2`,
      [groupId, fromUserId]
    ).catch(() => []),
  ]);
  const sender = await db
    .one(`SELECT name FROM users WHERE id=$1`, [fromUserId])
    .catch(() => null);
  const senderName = String(sender?.name || "").split(" ")[0] || "Someone";
  const title = group?.title || "Group";

  for (const m of members) {
    // MUTED MEANS MUTED. A mute that still buzzes is worse than no mute
    // at all — the assistant may still answer for them, it just does not
    // make their phone light up about the group they asked to quieten.
    if (m.fcm_token && Number(m.muted) !== 1) {
      push
        .sendNotification(m.fcm_token, title, `${senderName}: ${String(text).slice(0, 140)}`, {
          kind: "group_message",
          groupId: String(groupId),
        })
        .catch(() => {});
    }
    if (Number(m.agent_replies) === 1) {
      await require("../infra/jobs")
        .enqueue(
          "group_agent_reply",
          { groupId, messageId, forUserId: Number(m.user_id), fromUserId, text },
          { userId: Number(m.user_id), delayMs: GRACE_MS }
        )
        .catch((e) => console.warn("group agent not queued:", e.message));
    }
  }
}

/* ------------------------------------------------------------------ */
/* THE REPLY                                                           */
/* ------------------------------------------------------------------ */

/** Everything true we know about this person that could bear on a reply. */
async function factsFor(userId) {
  const now = Date.now();
  const end = now + 21 * 86400_000;
  const [profile, busy, memories] = await Promise.all([
    db.one(`SELECT name, timezone FROM users WHERE id=$1`, [userId]).catch(() => null),
    db
      .query(
        `SELECT text, due_at FROM reminders
          WHERE user_id=$1 AND done=0 AND due_at BETWEEN $2 AND $3
          ORDER BY due_at LIMIT 40`,
        [userId, now, end]
      )
      .catch(() => []),
    // The user's own remembered facts, through the same reader the
    // assistant uses everywhere else — `agent_memories`, valid rows
    // only, so something they asked to forget cannot resurface here of
    // all places.
    require("./memory").listMemories(userId).catch(() => []),
  ]);

  // WITHOUT TODAY'S DATE THIS FEATURE CANNOT ANSWER ANYTHING.
  //
  // Measured against production before release: asked "are you tied up
  // the day after tomorrow?" with a dentist appointment sitting in the
  // data, the model declined — and said why: "the current date is
  // unknown so I cannot determine if Bilal is free". Nearly every real
  // question is relative ("tomorrow", "this weekend", "tonight"), so an
  // assistant with no clock declines all of them and the feature looks
  // like it is working while never once firing.
  //
  // Their own zone, not the server's: "Saturday" has to mean their
  // Saturday. India when we have not been told otherwise, which is
  // where this product lives.
  const zone = String(profile?.timezone || "").trim() || "Asia/Kolkata";
  const when = (ms) => {
    try {
      return new Date(Number(ms)).toLocaleString("en-IN", {
        timeZone: zone,
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (_) {
      return new Date(Number(ms)).toISOString().slice(0, 16).replace("T", " ");
    }
  };

  const commitments = busy.map((r) => `- ${when(r.due_at)} — ${r.text}`).join("\n");
  const known = memories.map((m) => `- ${m.fact}`).join("\n");
  return {
    name: String(profile?.name || "").split(" ")[0] || "",
    nowText: when(now),
    commitments: commitments || "(nothing in the next three weeks)",
    known: known || "(nothing recorded)",
  };
}

/**
 * Decide, and either speak or stay quiet.
 *
 * Runs from the queue, GRACE_MS after the message. Everything is
 * re-checked here rather than trusted from the payload: in three minutes
 * the person may have read it, answered it, left the group, or turned
 * the whole feature off.
 */
async function replyFromJob(payload = {}) {
  const { groupId, messageId, forUserId, fromUserId } = payload;
  if (!groupId || !messageId || !forUserId) return;

  const mine = await db
    .one(
      `SELECT last_read_id, agent_replies FROM chat_group_members
        WHERE group_id=$1 AND user_id=$2`,
      [groupId, forUserId]
    )
    .catch(() => null);
  if (!mine || Number(mine.agent_replies) !== 1) return; // left, or switched off
  // THEY SAW IT. Their own answer, or their silence, is theirs to give.
  if (Number(mine.last_read_id) >= Number(messageId)) return;

  // SOMEBODY ELSE ALREADY SPOKE. A group where three assistants all
  // answer the same question is worse than one where none does.
  const later = await db
    .one(
      `SELECT COUNT(*)::int AS n FROM chat_group_messages
        WHERE group_id=$1 AND id > $2`,
      [groupId, messageId]
    )
    .catch(() => ({ n: 0 }));
  if (Number(later.n) > 0) return;

  const [msg, facts, recent] = await Promise.all([
    db.one(
      `SELECT m.body, m.via, u.name FROM chat_group_messages m
         LEFT JOIN users u ON u.id = m.from_user_id WHERE m.id=$1`,
      [messageId]
    ).catch(() => null),
    factsFor(forUserId),
    db.query(
      `SELECT m.body, m.from_user_id, u.name FROM chat_group_messages m
         LEFT JOIN users u ON u.id = m.from_user_id
        WHERE m.group_id=$1 AND m.id <= $2 ORDER BY m.id DESC LIMIT 8`,
      [groupId, messageId]
    ).catch(() => []),
  ]);
  if (!msg) return;
  // RULE 4: never answer another assistant.
  if (String(msg.via) === "agent") return;

  // WHO IS WHO, UNAMBIGUOUSLY.
  //
  // The first cut wrote every line as "<first name>: body", and in a
  // group with two Rahuls — or, in the test that caught it, two people
  // whose names both shortened to "Test" — the model read the incoming
  // message as having come from its own user and declined: "the last
  // message is from test themselves, so no reply is needed". Two people
  // sharing a first name is not an edge case in India, it is Tuesday.
  //
  // So the user's own lines are marked as theirs and everyone else is
  // named, and the message under consideration is called out by id.
  const history = recent
    .reverse()
    .map((r) => {
      const who = Number(r.from_user_id) === Number(forUserId)
        ? `${facts.name || "you"} (this is YOU)`
        : String(r.name || "someone").split(" ")[0];
      return `${who}: ${r.body}`;
    })
    .join("\n");

  const system =
    `You are ${facts.name || "the user"}'s personal assistant, writing ONE ` +
    `message in a group chat on their behalf because they have not seen ` +
    `it for a few minutes.\n\n` +
    `RIGHT NOW IT IS ${facts.nowText} where they are. Work out "tomorrow", ` +
    `"the weekend", "tonight" and "the day after" from that — their ` +
    `schedule below is written in the same clock.\n\n` +
    `YOU MAY ONLY USE THE FACTS BELOW. You do not know anything else ` +
    `about ${facts.name || "them"} — not their opinions, not their plans, ` +
    `not what they would think. If answering would need a fact that is ` +
    `not listed, you MUST decline to answer. Guessing on someone's ` +
    `behalf is the one thing that makes this feature harmful: a wrong ` +
    `"yes, he's free Saturday" costs them their Saturday.\n\n` +
    `THEIR SCHEDULE:\n${facts.commitments}\n\n` +
    `WHAT THEY HAVE ASKED TO BE REMEMBERED:\n${facts.known}\n\n` +
    `DECLINE (answer:false) whenever:\n` +
    `- the message is not really addressed to them, or needs no answer\n` +
    `- it asks an opinion, a decision, a commitment, money, or anything ` +
    `personal\n` +
    `- the answer is not plainly in the facts above\n` +
    `- it is emotional, sensitive, or bad news\n` +
    `ANSWER (answer:true) only for the small, factual things: whether ` +
    `their calendar is clear at a stated time, something explicitly ` +
    `recorded above, or a short acknowledgement that does not commit ` +
    `them to anything.\n\n` +
    `WRITE LIKE THEM, NOT LIKE A SERVICE: short, plain, lower-case is ` +
    `fine, no greeting, no sign-off, no "as their assistant", under 25 ` +
    `words. One message.\n\n` +
    `Reply with STRICT JSON only: ` +
    `{"answer":true|false,"text":"…","why":"a few words for their own log"}`;

  const senderName = String(msg.name || "someone").split(" ")[0];
  const user =
    `The group so far (your own lines are marked):\n${history}\n\n` +
    `The message to consider is the LAST one. It was sent by ` +
    `${senderName}, who is NOT you — you are writing as ` +
    `${facts.name || "the user"}. Decide whether to answer it on their ` +
    `behalf.`;

  let decision = null;
  try {
    const { reply } = await generateReply([{ role: "user", content: user }], { system });
    decision = JSON.parse(
      String(reply || "").replace(/```json/gi, "").replace(/```/g, "").trim()
    );
  } catch (e) {
    // A FAILURE AND A DECISION TO STAY QUIET MUST NOT LOOK THE SAME.
    // They did in the first cut, and the only reason the missing-clock
    // bug above was found is that the reason was printed by hand.
    console.warn("group agent could not decide:", e.message);
    return; // silence is the safe failure
  }
  console.log(
    "group agent decision:",
    JSON.stringify({
      group: groupId,
      forUser: forUserId,
      answer: decision?.answer === true,
      why: String(decision?.why || "").slice(0, 120),
    })
  );

  const text = String(decision?.text || "").trim();
  if (decision?.answer !== true || !text) {
    // NOTHING SAID — but the user still hears about it when they return.
    await noteForUser(forUserId, groupId, {
      from: String(msg.name || "someone").split(" ")[0],
      asked: String(msg.body).slice(0, 200),
      why: String(decision?.why || "").slice(0, 120),
      answered: "",
    });
    return;
  }

  const row = await require("../routes/chatGroups")
    .insertMessage(groupId, forUserId, text.slice(0, 500), "agent")
    .catch((e) => {
      console.error("group agent send failed:", e.message);
      return null;
    });
  if (!row) return;

  // The other members are nudged exactly as they would be for a typed
  // message — the room behaves the same way whoever wrote it.
  await notifyOthers(groupId, forUserId, text);
  await noteForUser(forUserId, groupId, {
    from: String(msg.name || "someone").split(" ")[0],
    asked: String(msg.body).slice(0, 200),
    why: String(decision?.why || "").slice(0, 120),
    answered: text,
  });
}

/** Everyone except the speaker gets the same nudge a typed message gives. */
async function notifyOthers(groupId, fromUserId, text) {
  const [group, members, who] = await Promise.all([
    db.one(`SELECT title FROM chat_groups WHERE id=$1`, [groupId]).catch(() => null),
    db.query(
      `SELECT u.fcm_token FROM chat_group_members x JOIN users u ON u.id = x.user_id
        WHERE x.group_id=$1 AND x.user_id <> $2 AND u.fcm_token IS NOT NULL
          AND COALESCE((SELECT muted FROM chat_prefs p
                         WHERE p.user_id = x.user_id AND p.kind='group'
                           AND p.ref = x.group_id::text), 0) <> 1`,
      [groupId, fromUserId]
    ).catch(() => []),
    db.one(`SELECT name FROM users WHERE id=$1`, [fromUserId]).catch(() => null),
  ]);
  const first = String(who?.name || "").split(" ")[0] || "Someone";
  for (const m of members) {
    push
      .sendNotification(m.fcm_token, group?.title || "Group", `${first}: ${text.slice(0, 140)}`, {
        kind: "group_message",
        groupId: String(groupId),
      })
      .catch(() => {});
  }
}

/**
 * "SHOULD COMMUNICATE WITH THE USER WHEN USER IS BACK."
 *
 * The user must never learn from somebody else that their assistant
 * spoke for them. So whatever happened — answered or not — is pushed to
 * them directly, and the words themselves are already sitting in the
 * group where they can read them in context.
 *
 * DELIBERATELY NOT WRITTEN INTO agent_memories. That store is injected
 * into every system prompt the user ever gets; filing "Ravi asked about
 * Saturday" there would make a passing group message part of who they
 * are, forever. A notification is the right size for a notification.
 */
async function noteForUser(userId, groupId, { from, asked, why, answered }) {
  const [group, user] = await Promise.all([
    db.one(`SELECT title FROM chat_groups WHERE id=$1`, [groupId]).catch(() => null),
    db.one(`SELECT fcm_token FROM users WHERE id=$1`, [userId]).catch(() => null),
  ]);
  if (!user?.fcm_token) return;
  const where = group?.title ? group.title : "a group";
  const title = answered ? `I replied for you in ${where}` : `Unanswered in ${where}`;
  const body = answered
    ? `${from}: "${trim(asked, 60)}" — I said: "${trim(answered, 70)}"`
    : `${from}: "${trim(asked, 90)}"${why ? ` — ${trim(why, 40)}` : ""}`;
  push
    .sendNotification(user.fcm_token, title, body, {
      kind: "group_agent_note",
      groupId: String(groupId),
    })
    .catch(() => {});
}

const trim = (s, n) =>
  String(s || "").length > n ? `${String(s).slice(0, n - 1)}…` : String(s || "");

module.exports = { onGroupMessage, replyFromJob, GRACE_MS };
