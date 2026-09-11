/**
 * RECENT CONVERSATION MEMORY — continuity across sessions.
 * --------------------------------------------------------
 * Every voice/chat exchange is appended here durably, and every NEW
 * session gets the tail injected into its prompt. This is what lets
 * "give me strategies for the meeting" work a minute after "you have a
 * meeting with Allen tomorrow" — even though those are two different
 * live sessions that otherwise start blank.
 *
 * Deliberately small: a rolling window, not a transcript archive. The
 * durable stores (facts memory, reminders, clients, outcomes) remain the
 * long-term truth; this only carries the thread of the conversation.
 */
const { query, one, run } = require("../db");

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id         BIGSERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL,
        role       TEXT NOT NULL,
        text       TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_convturns_user ON conversation_turns(user_id, id DESC);
      -- Analytics columns (admin panel): how long the answer took, which
      -- surface it came from, which tools ran, and the app build that
      -- asked. Added by ALTER so existing rows survive.
      ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS latency_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS source     TEXT NOT NULL DEFAULT '';
      ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS tools      TEXT NOT NULL DEFAULT '';
      ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS app_build  INTEGER NOT NULL DEFAULT 0;
      -- Ties a question to ITS answer. Without it the admin view paired an
      -- answer with whatever user line happened to sit above it, which put
      -- a brief's answer under "Call Jeevan B2" and made a working call
      -- look broken.
      ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS turn_id    TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_convturns_turn ON conversation_turns(turn_id);
      CREATE INDEX IF NOT EXISTS idx_convturns_time ON conversation_turns(created_at DESC);
    `).catch((e) => {
      console.error("conversation_turns migration failed:", e.message);
      migrated = null;
    });
  }
  return migrated;
}

// Kept per user. The PROMPT only ever reads the newest dozen; the rest
// is the admin panel's window into what testers actually asked.
const KEEP_PER_USER = 400;

/**
 * Fire-and-forget append. System lines and empties are never stored.
 * @param meta {latencyMs, source: 'voice'|'live'|'chat', tools: string[], appBuild}
 */
// Writes are SERIALISED per user. These calls are fire-and-forget, so two
// inserts issued back to back (the question, then its answer) could land
// out of order and invert their ids — which is exactly how a working call
// appeared, in the admin panel, to have been answered with a daily brief.
const writeChains = new Map(); // uid -> promise

function append(userId, role, text, meta = {}) {
  const uid = Number(userId);
  const t = String(text || "").trim().slice(0, 1200);
  if (!Number.isInteger(uid) || uid <= 0 || !t) return;
  if (t.startsWith("[SYSTEM") || t.startsWith("[SCHEDULED")) return;
  const prev = writeChains.get(uid) || Promise.resolve();
  const next = prev.then(async () => {
    await migrate();
    await run(
      `INSERT INTO conversation_turns
         (user_id, role, text, created_at, latency_ms, source, tools, app_build, turn_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        uid,
        role === "assistant" ? "assistant" : "user",
        t,
        Date.now(),
        Math.max(0, Math.round(Number(meta.latencyMs) || 0)),
        String(meta.source || "").slice(0, 20),
        (Array.isArray(meta.tools) ? meta.tools.join(", ") : String(meta.tools || "")).slice(0, 300),
        Math.max(0, Number(meta.appBuild) || 0),
        String(meta.turnId || "").slice(0, 40),
      ]
    );
    await run(
      `DELETE FROM conversation_turns WHERE user_id = $1 AND id NOT IN
         (SELECT id FROM conversation_turns WHERE user_id = $1 ORDER BY id DESC LIMIT $2)`,
      [uid, KEEP_PER_USER]
    );
  }).catch((e) => console.warn("recent append failed:", e.message));
  writeChains.set(uid, next);
  if (writeChains.size > 500) writeChains.clear(); // bounded; chains are short
}

/* ------------------------------------------------------------------ */
/* ADMIN VIEWS — every turn, paired, with timings                      */
/* ------------------------------------------------------------------ */

/**
 * Question/answer pairs newest-first for the admin panel: each assistant
 * turn joined to the user turn that preceded it, with the answer's
 * latency, surface, tools and app build.
 */
async function adminConversations({ q, userId, source, minLatency, limit = 50, offset = 0 } = {}) {
  await migrate();
  const where = ["t.role = 'assistant'"];
  const params = [];
  if (q) {
    params.push(`%${q}%`);
    where.push(`(t.text ILIKE $${params.length} OR EXISTS (
      SELECT 1 FROM conversation_turns p
       WHERE p.user_id = t.user_id AND p.role = 'user'
         AND p.text ILIKE $${params.length}
         AND ((p.turn_id <> '' AND p.turn_id = t.turn_id)
              OR (t.turn_id = '' AND p.id < t.id
                  AND p.created_at > t.created_at - 120000))))`);
  }
  if (Number.isFinite(userId)) { params.push(userId); where.push(`t.user_id = $${params.length}`); }
  if (source) { params.push(source); where.push(`t.source = $${params.length}`); }
  if (Number.isFinite(minLatency) && minLatency > 0) {
    params.push(minLatency); where.push(`t.latency_ms >= $${params.length}`);
  }
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  // The question is the user turn sharing this answer's turn_id. Rows from
  // before turn ids existed fall back to "the user line just above", and
  // that fallback is capped to two minutes so an unrelated older line is
  // never presented as the question.
  return query(
    `SELECT t.id, t.user_id, u.name AS user_name, t.text AS answer,
            t.latency_ms, t.source, t.tools, t.app_build, t.created_at,
            COALESCE(
              (SELECT q.text FROM conversation_turns q
                WHERE q.turn_id <> '' AND q.turn_id = t.turn_id
                  AND q.role = 'user' AND q.user_id = t.user_id
                ORDER BY q.id ASC LIMIT 1),
              (SELECT p.text FROM conversation_turns p
                WHERE t.turn_id = '' AND p.user_id = t.user_id AND p.id < t.id
                  AND p.role = 'user' AND p.created_at > t.created_at - 120000
                ORDER BY p.id DESC LIMIT 1)
            ) AS question
       FROM conversation_turns t LEFT JOIN users u ON u.id = t.user_id
      WHERE ${where.join(" AND ")}
      ORDER BY t.id DESC LIMIT ${lim} OFFSET ${off}`,
    params
  );
}

/** Response-time percentiles, volume by surface, and the busiest tools. */
async function adminStats(days = 7) {
  await migrate();
  const since = Date.now() - days * 86400_000;
  const [latency, bySource, byTool, byDay] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS turns,
              ROUND(AVG(latency_ms))::int AS avg_ms,
              PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY latency_ms)::int AS p50,
              PERCENTILE_DISC(0.9) WITHIN GROUP (ORDER BY latency_ms)::int AS p90,
              MAX(latency_ms)::int AS max_ms
         FROM conversation_turns
        WHERE role='assistant' AND latency_ms > 0 AND created_at > $1`, [since]),
    query(
      `SELECT COALESCE(NULLIF(source,''),'unknown') AS source, COUNT(*)::int AS n,
              ROUND(AVG(NULLIF(latency_ms,0)))::int AS avg_ms
         FROM conversation_turns
        WHERE role='assistant' AND created_at > $1
        GROUP BY 1 ORDER BY n DESC`, [since]),
    query(
      `SELECT trim(tool) AS tool, COUNT(*)::int AS n FROM (
         SELECT unnest(string_to_array(tools, ',')) AS tool
           FROM conversation_turns
          WHERE role='assistant' AND tools <> '' AND created_at > $1) x
        WHERE trim(tool) <> '' GROUP BY 1 ORDER BY n DESC LIMIT 12`, [since]),
    query(
      `SELECT to_char(to_timestamp(created_at/1000.0),'YYYY-MM-DD') AS d,
              COUNT(*)::int AS count
         FROM conversation_turns WHERE role='assistant' AND created_at > $1
        GROUP BY d ORDER BY d`, [since]),
  ]);
  return { latency: latency[0] || {}, bySource, byTool, byDay };
}



/**
 * The conversation tail as a prompt block, oldest first — or "" when
 * there is nothing recent. Capped hard so it can never crowd a prompt.
 */
async function recentBlock(userId, { maxTurns = 12, maxAgeMs = 48 * 3600_000, maxChars = 1700 } = {}) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) return "";
  try {
    await migrate();
    const rows = await query(
      `SELECT role, text, created_at FROM conversation_turns
        WHERE user_id = $1 AND created_at >= $2
        ORDER BY id DESC LIMIT $3`,
      [uid, Date.now() - maxAgeMs, maxTurns]
    );
    if (!rows.length) return "";
    const lines = [];
    let used = 0;
    for (const r of rows) { // newest→oldest; keep newest within budget
      const line = `${r.role === "assistant" ? "You said" : "User said"}: ${r.text}`;
      if (used + line.length > maxChars) break;
      used += line.length;
      lines.push(line);
    }
    lines.reverse();
    return (
      "RECENT CONVERSATION (earlier exchanges, possibly minutes ago in a " +
      "previous session — oldest first). Treat this as things already said: " +
      "never re-ask for details present here, and carry them forward.\n" +
      lines.join("\n")
    );
  } catch (e) {
    console.warn("recentBlock failed:", e.message);
    return "";
  }
}

module.exports = { append, recentBlock, adminConversations, adminStats };
