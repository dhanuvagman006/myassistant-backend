/**
 * EXECUTED ACTIONS — the authoritative record of what the assistant DID.
 * ----------------------------------------------------------------------
 * The model's own recollection is not evidence. Testers hit both failure
 * directions in one session: the assistant claimed it had opened Instagram
 * when no tool had run, and minutes later denied opening Google search
 * when it had. Both were "answered" from the language model's memory of
 * the conversation rather than from a record of execution.
 *
 * Every tool call now lands here — what ran, for whom, in which session
 * and turn, whether it succeeded, and a one-line human summary. Two
 * things read it:
 *   • the claim checker (src/agents/claimCheck.js), which refuses to let
 *     a reply assert an action that did not execute;
 *   • the check_recent_actions tool, which answers "did you call X?" and
 *     "why did settings open?" from fact.
 *
 * actions_log stays what it is — a coarse audit trail for the admin
 * panel. This table is per-turn, carries arguments and is queried by the
 * assistant itself, which actions_log was never shaped for.
 */
const { query, one, run } = require("../db");

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS executed_actions (
        id         BIGSERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        turn_id    TEXT NOT NULL DEFAULT '',
        tool       TEXT NOT NULL,
        target     TEXT NOT NULL DEFAULT '',
        ok         INTEGER NOT NULL DEFAULT 1,
        detail     TEXT NOT NULL DEFAULT '',
        surface    TEXT NOT NULL DEFAULT '',
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_exec_user ON executed_actions(user_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_exec_session ON executed_actions(session_id, id DESC);
    `).catch((e) => {
      console.error("executed_actions migration failed:", e.message);
      migrated = null;
    });
  }
  return migrated;
}

const KEEP_PER_USER = 300;
const clean = (s, n) => String(s ?? "").trim().slice(0, n);

/**
 * The argument that best identifies WHAT an action was aimed at, so a
 * record reads as "place_phone_call → Jeevan B2" rather than raw JSON.
 */
function targetOf(tool, args = {}) {
  const a = args || {};
  const first =
    a.name || a.contact_name || a.client_name || a.to || a.query || a.q ||
    a.app || a.url || a.text || a.topic || a.action || a.service || a.person;
  return clean(typeof first === "string" ? first : JSON.stringify(first ?? ""), 120);
}

/** Record one tool execution. Never throws — logging must not break a turn. */
function record(userId, { sessionId, turnId, tool, args, ok, detail, surface }) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0 || !tool) return;
  (async () => {
    await migrate();
    await run(
      `INSERT INTO executed_actions
         (user_id, session_id, turn_id, tool, target, ok, detail, surface, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uid, clean(sessionId, 80), clean(turnId, 40), clean(tool, 60),
       targetOf(tool, args), ok === false ? 0 : 1, clean(detail, 300),
       clean(surface, 20), Date.now()]
    );
    await run(
      `DELETE FROM executed_actions WHERE user_id = $1 AND id NOT IN
         (SELECT id FROM executed_actions WHERE user_id = $1 ORDER BY id DESC LIMIT $2)`,
      [uid, KEEP_PER_USER]
    );
  })().catch((e) => console.warn("executed_actions write failed:", e.message));
}

/** Recent actions for a user, newest first. */
async function recent(userId, { limit = 12, sinceMs, sessionId, tool } = {}) {
  await migrate();
  const params = [Number(userId)];
  let where = "user_id = $1";
  if (sinceMs) { params.push(sinceMs); where += ` AND created_at >= $${params.length}`; }
  if (sessionId) { params.push(clean(sessionId, 80)); where += ` AND session_id = $${params.length}`; }
  if (tool) { params.push(clean(tool, 60)); where += ` AND tool = $${params.length}`; }
  params.push(Math.min(Math.max(Number(limit) || 12, 1), 100));
  return query(
    `SELECT * FROM executed_actions WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
}

/** Did any of these tools run (successfully) in this window? */
async function didRun(userId, tools, { sinceMs, sessionId } = {}) {
  await migrate();
  const list = (Array.isArray(tools) ? tools : [tools]).map((t) => clean(t, 60));
  if (!list.length) return null;
  const params = [Number(userId), list];
  let where = "user_id = $1 AND tool = ANY($2) AND ok = 1";
  if (sinceMs) { params.push(sinceMs); where += ` AND created_at >= $${params.length}`; }
  if (sessionId) { params.push(clean(sessionId, 80)); where += ` AND session_id = $${params.length}`; }
  return one(`SELECT * FROM executed_actions WHERE ${where} ORDER BY id DESC LIMIT 1`, params);
}

/**
 * The same action, on the same target, already run for this user inside
 * the window — regardless of which session or surface it came from. This
 * is the durable half of repeat suppression; the session's own list only
 * covers one socket.
 */
async function findRecent(userId, tool, target, windowMs = 60_000) {
  await migrate();
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0 || !tool) return null;
  return one(
    `SELECT * FROM executed_actions
      WHERE user_id = $1 AND tool = $2 AND lower(target) = lower($3)
        AND created_at >= $4
      ORDER BY id DESC LIMIT 1`,
    [uid, clean(tool, 60), clean(target, 120), Date.now() - windowMs]
  );
}

/** Plain-language line for one record — what the assistant tells the user. */
function describe(r) {
  const when = new Date(Number(r.created_at)).toLocaleString("en-IN", {
    hour: "numeric", minute: "2-digit", day: "numeric", month: "short",
    timeZone: "Asia/Kolkata",
  });
  const verbs = {
    place_phone_call: "called",
    send_agent_message: "sent a message to",
    send_whatsapp_message: "prepared a WhatsApp message for",
    open_app: "opened",
    open_webpage: "opened a web page for",
    open_service_app: "opened",
    web_search: "searched the web for",
    play_music: "played music",
    create_reminder: "set a reminder",
    update_reminder: "updated a reminder",
    set_alarm: "set an alarm",
    phone_control: "used a phone control",
    capture_document: "opened the camera",
    record_entry: "recorded an entry",
  };
  const verb = verbs[r.tool] || r.tool.replace(/_/g, " ");
  const what = r.target ? ` ${r.target}` : "";
  return `${when}: ${r.ok ? "" : "FAILED — "}${verb}${what}`.trim();
}

module.exports = { migrate, record, recent, didRun, findRecent, describe, targetOf };
