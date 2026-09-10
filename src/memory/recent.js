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
    `).catch((e) => {
      console.error("conversation_turns migration failed:", e.message);
      migrated = null;
    });
  }
  return migrated;
}

const KEEP_PER_USER = 60;

/** Fire-and-forget append. System lines and empties are never stored. */
function append(userId, role, text) {
  const uid = Number(userId);
  const t = String(text || "").trim().slice(0, 1200);
  if (!Number.isInteger(uid) || uid <= 0 || !t) return;
  if (t.startsWith("[SYSTEM") || t.startsWith("[SCHEDULED")) return;
  (async () => {
    await migrate();
    await run(
      "INSERT INTO conversation_turns (user_id, role, text, created_at) VALUES ($1,$2,$3,$4)",
      [uid, role === "assistant" ? "assistant" : "user", t, Date.now()]
    );
    await run(
      `DELETE FROM conversation_turns WHERE user_id = $1 AND id NOT IN
         (SELECT id FROM conversation_turns WHERE user_id = $1 ORDER BY id DESC LIMIT $2)`,
      [uid, KEEP_PER_USER]
    );
  })().catch((e) => console.warn("recent append failed:", e.message));
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

module.exports = { append, recentBlock };
