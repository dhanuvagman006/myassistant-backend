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
      -- THE LEDGER (requested_action -> tool_selected -> tool_arguments ->
      -- execution_result -> final_response). The table recorded WHICH tool
      -- ran and whether it worked; the three questions that actually come
      -- up when a turn goes wrong — what did the user ask, what arguments
      -- did the model choose, what did we say back — were spread across
      -- two tables or nowhere at all.
      ALTER TABLE executed_actions ADD COLUMN IF NOT EXISTS intent TEXT NOT NULL DEFAULT '';
      ALTER TABLE executed_actions ADD COLUMN IF NOT EXISTS args TEXT NOT NULL DEFAULT '';
      ALTER TABLE executed_actions ADD COLUMN IF NOT EXISTS result TEXT NOT NULL DEFAULT '';
      ALTER TABLE executed_actions ADD COLUMN IF NOT EXISTS reply TEXT NOT NULL DEFAULT '';
      -- Every tool execution is written now, not only the ones that reach
      -- into the world: "why did you answer that?" needs the lookup that
      -- produced the answer. The world flag keeps the two apart, so questions
      -- that mean "what did you DO" still get actions, not every search.
      ALTER TABLE executed_actions ADD COLUMN IF NOT EXISTS world INTEGER NOT NULL DEFAULT 1;
      CREATE INDEX IF NOT EXISTS idx_exec_user ON executed_actions(user_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_exec_session ON executed_actions(session_id, id DESC);
      -- Repeat suppression looks up (user, tool, target) inside a short
      -- window on every guarded action; without this it scans the user's
      -- whole history on the most latency-sensitive path in the product.
      CREATE INDEX IF NOT EXISTS idx_exec_repeat
        ON executed_actions(user_id, tool, created_at DESC);
    `).catch((e) => {
      console.error("executed_actions migration failed:", e.message);
      migrated = null;
    });
  }
  return migrated;
}

const KEEP_PER_USER = 800; // every execution lands here now, not only world actions
const clean = (s, n) => String(s ?? "").trim().slice(0, n);

/**
 * The argument that best identifies WHAT an action was aimed at, so a
 * record reads as "place_phone_call → Jeevan B2" rather than raw JSON.
 */
function targetOf(tool, args = {}) {
  const a = args || {};
  const first =
    a.name || a.contact_name || a.client_name || a.business_name || a.to ||
    a.query || a.q || a.app || a.url || a.destination || a.dish ||
    a.restaurant || a.title || a.text || a.message || a.topic || a.action ||
    a.service || a.person || a.from;
  // An UNRESOLVABLE target must stay empty, never the literal string '""'.
  // It used to stringify undefined into two quote characters, which then
  // compared equal to every other unresolvable target — so "order biryani"
  // and "order a pizza" thirty seconds later were treated as one request.
  // Callers read "" as "I cannot identify this action" and skip matching.
  if (typeof first === "string") return clean(first, 120);
  if (first === undefined || first === null) return "";
  const s = clean(JSON.stringify(first), 120);
  return s === '""' ? "" : s;
}

/**
 * The arguments the model chose, as stored text. Secrets never belong in
 * a trail that the admin panel renders, so the same redaction the metrics
 * logger uses is applied first.
 */
function argsText(args) {
  try {
    const redacted = require("../infra/observability").redact(args || {});
    return clean(JSON.stringify(redacted), 1000);
  } catch (_) {
    try { return clean(JSON.stringify(args || {}), 1000); } catch (_) { return ""; }
  }
}

/** A one-line, human-readable form of what the tool returned. */
function resultText(res) {
  if (!res || typeof res !== "object") return clean(res, 300);
  if (res.error) return clean("error: " + res.error, 300);
  if (res.speak) return clean(res.speak, 300);
  if (res.repeated) return "suppressed as a repeat";
  if (res.deviceAction) return clean("device action: " + (res.deviceAction.type || "?"), 300);
  try { return clean(JSON.stringify(res.data ?? ""), 300); } catch (_) { return ""; }
}

/**
 * Writes for ONE user run in order. record() and attachReply() are both
 * fire-and-forget, and the reply landed first often enough to matter: the
 * UPDATE ran against rows that did not exist yet, so the turn's answer was
 * simply missing from the ledger.
 */
const writeChains = new Map();
function serialize(uid, fn) {
  const prev = writeChains.get(uid) || Promise.resolve();
  const next = prev.then(fn).catch((e) =>
    console.warn("executed_actions write failed:", e.message)
  );
  writeChains.set(uid, next);
  next.finally(() => {
    if (writeChains.get(uid) === next) writeChains.delete(uid);
  });
  return next;
}

/** Record one tool execution. Never throws — logging must not break a turn. */
function record(userId, { sessionId, turnId, tool, args, ok, detail, surface, intent, result, world }) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0 || !tool) return;
  return serialize(uid, async () => {
    await migrate();
    await run(
      `INSERT INTO executed_actions
         (user_id, session_id, turn_id, tool, target, ok, detail, surface,
          created_at, intent, args, result, world)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [uid, clean(sessionId, 80), clean(turnId, 40), clean(tool, 60),
       targetOf(tool, args), ok === false ? 0 : 1, clean(detail, 300),
       clean(surface, 20), Date.now(),
       clean(intent, 400), argsText(args),
       typeof result === "string" ? clean(result, 300) : resultText(result),
       world === false ? 0 : 1]
    );
    await run(
      `DELETE FROM executed_actions WHERE user_id = $1 AND id NOT IN
         (SELECT id FROM executed_actions WHERE user_id = $1 ORDER BY id DESC LIMIT $2)`,
      [uid, KEEP_PER_USER]
    );
  });
}

/** Recent actions for a user, newest first. */
async function recent(userId, { limit = 12, sinceMs, sessionId, tool, includeLookups = false } = {}) {
  await migrate();
  const params = [Number(userId)];
  // "Did you call her?" and "why did settings open?" mean world actions.
  // A lookup is an execution, not something the user thinks of as done.
  let where = includeLookups ? "user_id = $1" : "user_id = $1 AND world = 1";
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

/**
 * Mark recent records for this tool+target as failed. A world action is
 * logged when it is DISPATCHED, which for a phone call is long before
 * anything rings: the user still has to approve the card and the handset
 * still has to find the contact. When that later step fails or is
 * declined, the optimistic ok=1 row is what repeat suppression reads, and
 * the user is refused a retry of something that never happened.
 */
async function invalidate(userId, tool, target, { windowMs = 10 * 60_000, detail = "" } = {}) {
  await migrate();
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0 || !tool) return 0;
  const t = clean(target, 120);
  const params = [uid, clean(tool, 60), Date.now() - windowMs, clean(detail, 300)];
  let where = "user_id = $1 AND tool = $2 AND created_at >= $3 AND ok = 1";
  if (t) { params.push(t); where += ` AND lower(target) = lower($${params.length})`; }
  return run(`UPDATE executed_actions SET ok = 0, detail = $4 WHERE ${where}`, params)
    .catch((e) => { console.warn("invalidate failed:", e.message); return 0; });
}

/**
 * Close the ledger for a turn: every action it took gets the answer the
 * user finally received. Without it a row ends at "the tool succeeded"
 * and cannot show what was actually said — which is the half of the
 * record that told us the assistant had claimed things it never did.
 */
function attachReply(userId, turnId, reply) {
  const uid = Number(userId);
  const t = clean(turnId, 40);
  if (!Number.isInteger(uid) || uid <= 0 || !t || !reply) return;
  // Queued behind this user's inserts — see serialize(). Unqueued, the
  // update ran before the rows it was meant to update existed.
  return serialize(uid, async () => {
    await migrate();
    await run(
      "UPDATE executed_actions SET reply = $1 WHERE user_id = $2 AND turn_id = $3 AND reply = ''",
      [clean(reply, 600), uid, t]
    );
  });
}

/**
 * One turn end to end: what was asked, which tools were chosen with which
 * arguments, what each returned, and what was said back.
 */
async function ledger(userId, { limit = 40, sessionId, turnId } = {}) {
  await migrate();
  const params = [Number(userId)];
  let where = "user_id = $1";
  if (sessionId) { params.push(clean(sessionId, 80)); where += ` AND session_id = $${params.length}`; }
  if (turnId) { params.push(clean(turnId, 40)); where += ` AND turn_id = $${params.length}`; }
  params.push(Math.min(Math.max(Number(limit) || 40, 1), 200));
  const rows = await query(
    `SELECT * FROM executed_actions WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  // Group by turn so one request reads as one entry, however many tools
  // it took — the model often calls three in a breath.
  const turns = new Map();
  for (const r of rows) {
    const key = r.turn_id || `row:${r.id}`;
    if (!turns.has(key)) {
      turns.set(key, {
        turnId: r.turn_id || "",
        sessionId: r.session_id || "",
        at: Number(r.created_at),
        intent: r.intent || "",
        reply: r.reply || "",
        surface: r.surface || "",
        steps: [],
      });
    }
    const t = turns.get(key);
    if (!t.intent && r.intent) t.intent = r.intent;
    if (!t.reply && r.reply) t.reply = r.reply;
    t.steps.unshift({
      tool: r.tool,
      target: r.target || "",
      args: r.args || "",
      ok: Number(r.ok) === 1,
      result: r.result || "",
      detail: r.detail || "",
      at: Number(r.created_at),
    });
  }
  return [...turns.values()];
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

module.exports = {
  migrate, record, recent, didRun, findRecent, invalidate, attachReply,
  ledger, describe, targetOf, argsText,
};
