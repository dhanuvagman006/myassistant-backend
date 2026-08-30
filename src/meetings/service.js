/**
 * MEETINGS — capture, then the part that actually matters: what to do next.
 *
 * A transcript is not the deliverable. Nobody rereads an hour of talk. The
 * deliverable is: what was DECIDED, what YOU agreed to do, what THEY agreed
 * to do, and a follow-up message already written.
 *
 * WHERE THE AUDIO COMES FROM
 * --------------------------
 * Either the app sends a transcript it already has, or it sends audio and
 * we transcribe. Both entry points exist because they have different costs:
 * a phone that has already done on-device speech-to-text should not pay for
 * it twice, and a recording made without transcription still has to work.
 *
 * ACTION ITEMS BECOME COMMITMENTS. An action item that lives only in a
 * meeting record is a note; one that enters the commitment tracker gets
 * nudged before it slips. Only the USER'S OWN actions are tracked — we
 * cannot nudge somebody else's client.
 */
const { query, one, run } = require("../db");
const { generateReply } = require("../services/ai/router");

async function migrate(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id          BIGSERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      title       TEXT NOT NULL DEFAULT '',
      -- Who was there, as the user named them.
      participants TEXT NOT NULL DEFAULT '',
      -- Linked case file, when the meeting was about a known client.
      client_id   INTEGER,
      transcript  TEXT NOT NULL DEFAULT '',
      summary     TEXT NOT NULL DEFAULT '',
      decisions   TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
      actions     TEXT NOT NULL DEFAULT '[]',   -- JSON [{text,owner,when,mine}]
      follow_up   TEXT NOT NULL DEFAULT '',     -- drafted message, ready to send
      duration_s  INTEGER NOT NULL DEFAULT 0,
      created_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_meetings_user
      ON meetings(user_id, id DESC);
  `);
}

/* ------------------------------------------------------------------ *
 * ANALYSIS
 * ------------------------------------------------------------------ */

const ANALYSIS_PROMPT = [
  "You are turning a meeting transcript into something the user can act on.",
  "The USER is the person whose assistant you are; other speakers are the",
  "other participants.",
  "",
  "Extract ONLY what was actually said. Do not infer decisions that were",
  "discussed but not settled, and do not invent action items to pad the",
  "list — a wrong action item wastes the user's time chasing something",
  "nobody agreed.",
  "",
  "Return STRICT JSON only, no markdown:",
  "{",
  '  "summary":"<3-4 sentences: what this meeting was about and where it landed>",',
  '  "decisions":["<a thing that was actually settled>"],',
  '  "actions":[{"text":"<the task>","owner":"<who owes it: the user\'s name, or the other person>",',
  '              "when":"<deadline in their words, or empty>","mine":true|false}],',
  '  "follow_up":"<a short message the user can send the others: thanks, what was agreed, what happens next. Written in first person, ready to send, no placeholders>"',
  "}",
  "",
  'Set "mine": true only for actions the USER themselves agreed to do.',
  "If the transcript is too short or garbled to analyse, return empty",
  "arrays and say so in the summary rather than guessing.",
].join("\n");

/**
 * @returns {{summary, decisions:string[], actions:Array, follow_up:string}}
 */
async function analyze(transcript, { userName = "the user", participants = "" } = {}) {
  const text = String(transcript || "").trim();
  if (text.length < 40) {
    return {
      summary: "The recording was too short to get anything useful from.",
      decisions: [], actions: [], follow_up: "",
    };
  }

  const context =
    `The user is ${userName}.` +
    (participants ? ` Participants: ${participants}.` : "") +
    `\n\nTRANSCRIPT:\n${text.slice(0, 24000)}`;

  try {
    const { reply } = await generateReply(
      [{ role: "user", content: context }],
      { system: ANALYSIS_PROMPT }
    );
    const j = JSON.parse(String(reply || "").replace(/```json|```/g, "").trim());
    return {
      summary: String(j.summary || "").slice(0, 2000),
      decisions: Array.isArray(j.decisions) ? j.decisions.slice(0, 12).map(String) : [],
      actions: Array.isArray(j.actions)
        ? j.actions.slice(0, 15).map((a) => ({
            text: String(a.text || "").slice(0, 300),
            owner: String(a.owner || "").slice(0, 100),
            when: String(a.when || "").slice(0, 100),
            mine: a.mine === true,
          })).filter((a) => a.text)
        : [],
      follow_up: String(j.follow_up || "").slice(0, 2000),
    };
  } catch (e) {
    // Honest failure: the transcript is kept, the analysis is not faked.
    return {
      summary: "",
      decisions: [],
      actions: [],
      follow_up: "",
      error: String(e.message || e).slice(0, 200),
    };
  }
}

/* ------------------------------------------------------------------ *
 * SAVING
 * ------------------------------------------------------------------ */

/**
 * Analyses and stores a meeting, and files the user's own action items in
 * the commitment tracker so they get nudged.
 */
async function record(userId, { transcript, title, participants, clientId, durationS, userName, tzOffsetMin }) {
  const analysis = await analyze(transcript, { userName, participants });
  const now = Date.now();

  const row = await one(
    `INSERT INTO meetings
       (user_id, title, participants, client_id, transcript, summary,
        decisions, actions, follow_up, duration_s, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      userId,
      String(title || "").slice(0, 200) || defaultTitle(now, tzOffsetMin),
      String(participants || "").slice(0, 400),
      clientId || null,
      String(transcript || "").slice(0, 200000),
      analysis.summary,
      JSON.stringify(analysis.decisions),
      JSON.stringify(analysis.actions),
      analysis.follow_up,
      Number(durationS) || 0,
      now,
    ]
  );

  // The user's own commitments enter the tracker. Someone else's action
  // item stays in the meeting record — we cannot chase their client for
  // them, and pretending otherwise would fill the tracker with things the
  // user cannot close.
  const chrono = require("chrono-node");
  const mine = analysis.actions.filter((a) => a.mine);
  for (const a of mine) {
    let dueAt = null;
    if (a.when) {
      try {
        const off = Number(tzOffsetMin) || 330;
        const d = chrono.parseDate(a.when, new Date(Date.now() + off * 60_000), { forwardDate: true });
        if (d) dueAt = d.getTime() - off * 60_000;
      } catch (_) {}
    }
    await run(
      `INSERT INTO commitments
         (user_id, text, owed_to, due_at, status, source, quote, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'open','meeting',$5,$6,$6)`,
      [userId, a.text, String(participants || "").split(",")[0]?.trim() || "",
       dueAt, `From meeting: ${title || "meeting"}`, now]
    ).catch(() => {});
  }

  return { id: Number(row.id), ...analysis, tracked: mine.length };
}

function defaultTitle(ms, tzOffsetMin = 330) {
  const d = new Date(ms + tzOffsetMin * 60_000);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return `Meeting on ${days[d.getUTCDay()]}`;
}

async function list(userId, { limit = 10 } = {}) {
  const rows = await query(
    `SELECT id, title, participants, summary, decisions, actions, follow_up,
            duration_s, created_at
       FROM meetings WHERE user_id=$1 ORDER BY id DESC LIMIT $2`,
    [userId, Math.min(Number(limit) || 10, 30)]
  );
  return rows.map(hydrate);
}

async function get(userId, id) {
  const row = await one(
    `SELECT * FROM meetings WHERE user_id=$1 AND id=$2`,
    [userId, Number(id)]
  );
  return hydrate(row);
}

function hydrate(r) {
  if (!r) return null;
  const parse = (v, fb) => {
    try {
      return JSON.parse(v);
    } catch (_) {
      return fb;
    }
  };
  return {
    ...r,
    id: Number(r.id),
    decisions: parse(r.decisions, []),
    actions: parse(r.actions, []),
  };
}

module.exports = { migrate, analyze, record, list, get };
