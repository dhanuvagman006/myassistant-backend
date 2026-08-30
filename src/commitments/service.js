/**
 * COMMITMENTS — the promises the user makes, tracked to completion.
 *
 * "I'll send Ravi the proposal by Friday." "Tell them I'll call back
 * tomorrow." A professional is judged almost entirely on whether those
 * happen, and they are exactly the things that get lost — said in passing,
 * never written down, remembered only when the other person chases.
 *
 * Hari already hears them. This module catches them, files them with a
 * deadline and a person, and nudges before they slip.
 *
 * TWO DESIGN CONSTRAINTS
 * ----------------------
 * 1. EXTRACTION MUST NOT COST LATENCY. It needs a model call, so it never
 *    runs inside the turn — `extractAsync` is fire-and-forget after the
 *    reply is already on its way to the user, exactly like memory
 *    extraction. A commitment that lands half a second late is fine; a
 *    spoken reply that lands half a second late is not.
 *
 * 2. FALSE POSITIVES ARE WORSE THAN MISSES. A list full of things the user
 *    never promised is noise they will stop reading, and then the real
 *    commitment is lost too. The prompt demands a FIRST-PERSON, SPECIFIC,
 *    FUTURE undertaking and rejects everything else — musings, questions,
 *    and things other people promised.
 */
const chrono = require("chrono-node");
const { query, one, run } = require("../db");
const { generateReply } = require("../services/ai/router");

/* ------------------------------------------------------------------ */

async function migrate(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS commitments (
      id         BIGSERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      -- The promise, rewritten as a clear task: "Send Ravi the proposal".
      text       TEXT NOT NULL,
      -- Who it is owed to. This is what makes a nudge useful — "you told
      -- RAVI you'd send it" lands differently from a bare reminder.
      owed_to    TEXT NOT NULL DEFAULT '',
      due_at     BIGINT,                    -- epoch ms; NULL = no stated deadline
      -- open | done | cancelled
      status     TEXT NOT NULL DEFAULT 'open',
      -- Where it was overheard: voice | call | inbound | text
      source     TEXT NOT NULL DEFAULT 'voice',
      -- The sentence it came from, so the user can see why we think they
      -- promised this. A tracker you cannot audit is a tracker you distrust.
      quote      TEXT NOT NULL DEFAULT '',
      nudged_at  BIGINT,                    -- last reminder sent, so we don't nag
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_commitments_user
      ON commitments(user_id, status, due_at);
  `);
}

/* ------------------------------------------------------------------ *
 * EXTRACTION
 * ------------------------------------------------------------------ */

// Cheap gate before spending a model call. If none of these appear, the
// user did not promise anything and we skip the round-trip entirely —
// this is what keeps extraction from costing a call on every single turn.
const PROMISE_RX =
  /\b(i'?ll|i will|i'?m going to|i shall|let me|i'?ve got to|i need to|i have to|i must|remind me to|i'?ll get|i'?ll send|i'?ll call|i'?ll check|i'?ll do|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|evening|morning)|before (the )?(eod|end of day|tomorrow))\b/i;

const EXTRACT_PROMPT = [
  "You extract COMMITMENTS the user made about their own future actions.",
  "",
  "A commitment is FIRST PERSON, SPECIFIC and FUTURE: something the user",
  "said THEY would do. Examples that qualify:",
  '  "I\'ll send Ravi the proposal by Friday"',
  '  "Tell her I\'ll call back tomorrow morning"',
  '  "I need to file the GST return before the 20th"',
  "",
  "These DO NOT qualify — return an empty list for them:",
  "  questions, opinions, or musings (\"maybe I should call him\")",
  "  things SOMEONE ELSE promised (\"he said he'd send it\")",
  "  vague intentions with no object (\"I'll try to be better\")",
  "  anything already done (\"I sent it yesterday\")",
  "",
  "Return STRICT JSON only, no markdown:",
  '{"commitments":[{"text":"<imperative task, e.g. Send Ravi the proposal>",',
  ' "owed_to":"<person or empty>","when":"<their words for the deadline, or empty>",',
  ' "quote":"<the exact clause they said>"}]}',
  "",
  "Return {\"commitments\":[]} if there are none. Be strict: a wrong entry",
  "is worse than a missed one.",
].join("\n");

/**
 * Fire-and-forget extraction. Never awaited by a turn, never throws.
 */
function extractAsync(userId, text, { source = "voice" } = {}) {
  if (!userId || !text) return;
  if (!PROMISE_RX.test(text)) return; // no model call for an ordinary sentence
  extract(userId, text, { source }).catch(() => {});
}

async function extract(userId, text, { source = "voice", tzOffsetMin = 330 } = {}) {
  let parsed;
  try {
    const { reply } = await generateReply(
      [{ role: "user", content: String(text).slice(0, 1200) }],
      { system: EXTRACT_PROMPT }
    );
    parsed = JSON.parse(String(reply || "").replace(/```json|```/g, "").trim());
  } catch (_) {
    return [];
  }
  const list = Array.isArray(parsed?.commitments) ? parsed.commitments : [];
  const saved = [];

  for (const c of list.slice(0, 5)) {
    const body = String(c.text || "").trim();
    if (body.length < 4) continue;

    // Resolve the deadline in the user's own local frame.
    let dueAt = null;
    if (c.when) {
      try {
        const ref = new Date(Date.now() + tzOffsetMin * 60_000);
        const d = chrono.parseDate(String(c.when), ref, { forwardDate: true });
        if (d) dueAt = d.getTime() - tzOffsetMin * 60_000;
      } catch (_) {}
    }

    // Don't file the same promise twice because they mentioned it again.
    const dupe = await one(
      `SELECT id FROM commitments
        WHERE user_id=$1 AND status='open' AND lower(text)=lower($2) LIMIT 1`,
      [userId, body]
    ).catch(() => null);
    if (dupe) continue;

    const now = Date.now();
    const row = await one(
      `INSERT INTO commitments
         (user_id, text, owed_to, due_at, status, source, quote, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'open',$5,$6,$7,$7) RETURNING id`,
      [userId, body.slice(0, 300), String(c.owed_to || "").slice(0, 100),
       dueAt, source, String(c.quote || "").slice(0, 300), now]
    ).catch(() => null);
    if (row) saved.push({ id: row.id, text: body, owed_to: c.owed_to, due_at: dueAt });
  }
  return saved;
}

/* ------------------------------------------------------------------ *
 * READING AND CLOSING
 * ------------------------------------------------------------------ */

async function list(userId, { status = "open", limit = 20 } = {}) {
  return query(
    `SELECT * FROM commitments
      WHERE user_id=$1 ${status ? "AND status=$3" : ""}
      ORDER BY (due_at IS NULL), due_at ASC, id DESC
      LIMIT $2`,
    status ? [userId, limit, status] : [userId, limit]
  );
}

/** Closes the best match for what the user just said they'd finished. */
async function complete(userId, description) {
  const q = String(description || "").trim().toLowerCase();
  if (!q) return null;
  const row = await one(
    `SELECT id, text FROM commitments
      WHERE user_id=$1 AND status='open'
        AND (lower(text) LIKE $2 OR lower(owed_to) LIKE $2)
      ORDER BY length(text) ASC LIMIT 1`,
    [userId, `%${q}%`]
  ).catch(() => null);
  if (!row) return null;
  await run(`UPDATE commitments SET status='done', updated_at=$2 WHERE id=$1`, [
    row.id, Date.now(),
  ]);
  return row;
}

async function cancel(userId, id) {
  return run(
    `UPDATE commitments SET status='cancelled', updated_at=$3
      WHERE user_id=$1 AND id=$2`,
    [userId, Number(id), Date.now()]
  );
}

/**
 * Commitments worth nudging about: due within the window, still open, and
 * not nudged in the last 12 hours. The nag guard matters — a tracker that
 * reminds you hourly gets muted, and then it is worth nothing.
 */
async function dueSoon({ withinMs = 4 * 60 * 60 * 1000 } = {}) {
  const now = Date.now();
  return query(
    `SELECT c.*, u.fcm_token
       FROM commitments c JOIN users u ON u.id = c.user_id
      WHERE c.status='open' AND c.due_at IS NOT NULL
        AND c.due_at <= $1
        AND (c.nudged_at IS NULL OR c.nudged_at < $2)
      ORDER BY c.due_at ASC LIMIT 50`,
    [now + withinMs, now - 12 * 60 * 60 * 1000]
  );
}

async function markNudged(id) {
  return run(`UPDATE commitments SET nudged_at=$2 WHERE id=$1`, [id, Date.now()]);
}

module.exports = {
  migrate, extract, extractAsync, list, complete, cancel,
  dueSoon, markNudged, PROMISE_RX,
};
