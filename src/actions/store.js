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
      -- The name the MODEL passed and the name the HANDSET found are not
      -- the same string: "call mom" resolves to a contact called "Amma
      -- Lobo". Retracting a failed call matched only the first, so the
      -- failure of a call the user made under a nickname stayed recorded
      -- as a success — and check_recent_actions then said it was made.
      ALTER TABLE executed_actions ADD COLUMN IF NOT EXISTS resolved_target TEXT NOT NULL DEFAULT '';
      -- WHY NOTHING HAPPENED. A refusal is a decision, and until now the
      -- assistant declining to act left no trace anywhere: no row, no
      -- audit line, not even a log entry. "It ignored me" and "it asked me
      -- to repeat myself" and "it said it was already doing it" were
      -- indistinguishable afterwards.
      --   ran        the tool executed
      --   refused    a gate declined it (unclear input, permission)
      --   suppressed a repeat of something already under way
      --   clarified  the turn was answered with a question instead
      ALTER TABLE executed_actions ADD COLUMN IF NOT EXISTS decision TEXT NOT NULL DEFAULT 'ran';
      -- Which tool made a turn slow. The aggregate lived in memory and
      -- died with the process.
      ALTER TABLE executed_actions ADD COLUMN IF NOT EXISTS ms INTEGER NOT NULL DEFAULT 0;
      -- The coarse family of the request, so it can be grouped and
      -- counted: "how often does a call request end in a failed call"
      -- cannot be asked of a free-text transcript.
      ALTER TABLE executed_actions ADD COLUMN IF NOT EXISTS intent_kind TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_exec_failures
        ON executed_actions(ok, created_at DESC);
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

// World actions are rare and consequential; lookups are frequent and
// cheap. One shared cap let the second crowd out the first.
const KEEP_WORLD = 600;
const KEEP_LOOKUPS = 400;
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
    return clean(JSON.stringify(redacted), 2000);
  } catch (_) {
    try { return clean(JSON.stringify(args || {}), 2000); } catch (_) { return ""; }
  }
}

/**
 * The family of action a tool belongs to — the groupable label the raw
 * transcript cannot provide. Derived from the claim-check families, so
 * there is one definition of "this is a call" in the codebase.
 */
function intentKindOf(tool) {
  try {
    const { FAMILIES } = require("../agents/claimCheck");
    const f = FAMILIES.find((x) => x.tools.includes(tool));
    if (f) return f.id;
  } catch (_) {}
  if (/^(web_search|deep_research|read_webpage|get_weather|get_news)/.test(tool)) return "lookup";
  if (/^(recall_|check_recent|list_|get_)/.test(tool)) return "recall";
  return "other";
}

/** A one-line, human-readable form of what the tool returned. */
function resultText(res) {
  if (!res || typeof res !== "object") return clean(res, 600);
  if (res.error) return clean("error: " + res.error, 600);
  if (res.repeated) return clean("suppressed: " + (res.note || "already under way"), 600);
  if (res.deviceAction) {
    // The TYPE alone said nothing about what the phone was asked to do.
    // "device action: open_url" with the URL discarded cannot answer
    // "why did Google Search open?" — which is the question that started
    // all of this.
    const a = res.deviceAction;
    const what = a.url || a.app || a.name || a.query || a.package || a.action || "";
    return clean(`device action: ${a.type || "?"}${what ? ` → ${what}` : ""}`, 600);
  }
  if (res.speak) return clean(res.speak, 600);
  try { return clean(JSON.stringify(res.data ?? ""), 600); } catch (_) { return ""; }
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
function record(userId, { sessionId, turnId, tool, args, ok, detail, surface, intent, result, world, decision, ms }) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0 || !tool) return;
  return serialize(uid, async () => {
    await migrate();
    await run(
      `INSERT INTO executed_actions
         (user_id, session_id, turn_id, tool, target, ok, detail, surface,
          created_at, intent, args, result, world, decision, ms, intent_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [uid, clean(sessionId, 80), clean(turnId, 40), clean(tool, 60),
       targetOf(tool, args), ok === false ? 0 : 1, clean(detail, 300),
       clean(surface, 20), Date.now(),
       clean(intent, 400), argsText(args),
       typeof result === "string" ? clean(result, 600) : resultText(result),
       world === false ? 0 : 1,
       clean(decision || "ran", 16), Math.max(0, Math.round(Number(ms) || 0)),
       intentKindOf(tool)]
    );
    // TRIMMED BY KIND, not by recency alone. A user with heavy search
    // traffic used to evict their own call and payment records inside a
    // day — the rows you would actually want to audit were the first to
    // go, because they are the rarest.
    await run(
      `DELETE FROM executed_actions WHERE user_id = $1 AND world = 1 AND id NOT IN
         (SELECT id FROM executed_actions WHERE user_id = $1 AND world = 1
           ORDER BY id DESC LIMIT $2)`,
      [uid, KEEP_WORLD]
    );
    await run(
      `DELETE FROM executed_actions WHERE user_id = $1 AND world = 0 AND id NOT IN
         (SELECT id FROM executed_actions WHERE user_id = $1 AND world = 0
           ORDER BY id DESC LIMIT $2)`,
      [uid, KEEP_LOOKUPS]
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
  if (t) {
    params.push(t);
    const i = params.length;
    // Either name identifies the same attempt.
    where += ` AND (lower(target) = lower($${i}) OR lower(resolved_target) = lower($${i}))`;
  }
  return run(`UPDATE executed_actions SET ok = 0, detail = $4 WHERE ${where}`, params)
    .catch((e) => { console.warn("invalidate failed:", e.message); return 0; });
}

/**
 * The handset found who the user meant. Teach the open row that name, so
 * a later failure report — which only ever knows the resolved contact —
 * can find the attempt it belongs to.
 */
function attachResolvedTarget(userId, tool, requestedTarget, resolvedTarget, { windowMs = 10 * 60_000 } = {}) {
  const uid = Number(userId);
  const req = clean(requestedTarget, 120);
  const got = clean(resolvedTarget, 120);
  if (!Number.isInteger(uid) || uid <= 0 || !tool || !got) return;
  return serialize(uid, async () => {
    await migrate();
    const params = [got, uid, clean(tool, 60), Date.now() - windowMs];
    let where = "user_id = $2 AND tool = $3 AND created_at >= $4 AND resolved_target = ''";
    if (req) { params.push(req); where += ` AND lower(target) = lower($${params.length})`; }
    await run(`UPDATE executed_actions SET resolved_target = $1 WHERE ${where}`, params);
  });
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
        intentKind: r.intent_kind || "",
        reply: r.reply || "",
        surface: r.surface || "",
        steps: [],
      });
    }
    const t = turns.get(key);
    if (!t.intent && r.intent) t.intent = r.intent;
    if (!t.reply && r.reply) t.reply = r.reply;
    if (!t.intentKind && r.intent_kind) t.intentKind = r.intent_kind;
    t.steps.unshift({
      tool: r.tool,
      target: r.target || "",
      resolvedTarget: r.resolved_target || "",
      args: r.args || "",
      ok: Number(r.ok) === 1,
      decision: r.decision || "ran",
      ms: Number(r.ms) || 0,
      result: r.result || "",
      detail: r.detail || "",
      at: Number(r.created_at),
    });
  }
  return [...turns.values()];
}

/**
 * Everything that went wrong recently, across all users. A regression in
 * one tool used to be invisible until somebody complained: an operator
 * had to know which user to open, then read forty turns by eye.
 */
async function failures({ sinceMs, limit = 100, tool, includeRefusals = true } = {}) {
  await migrate();
  const params = [sinceMs || Date.now() - 24 * 3600_000];
  let where = "created_at >= $1 AND (ok = 0" +
    (includeRefusals ? " OR decision <> 'ran'" : "") + ")";
  if (tool) { params.push(clean(tool, 60)); where += ` AND tool = $${params.length}`; }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const rows = await query(
    `SELECT * FROM executed_actions WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  const byTool = new Map();
  for (const r of rows) {
    const key = `${r.tool}|${r.decision || "ran"}`;
    if (!byTool.has(key)) {
      byTool.set(key, { tool: r.tool, decision: r.decision || "ran", n: 0, users: new Set(), last: 0, example: "" });
    }
    const g = byTool.get(key);
    g.n++;
    g.users.add(r.user_id);
    if (Number(r.created_at) > g.last) {
      g.last = Number(r.created_at);
      g.example = r.result || r.detail || "";
    }
  }
  return {
    rows,
    groups: [...byTool.values()]
      .map((g) => ({ ...g, users: g.users.size }))
      .sort((a, b) => b.n - a.n),
  };
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
  const what = r.resolved_target || r.target
    ? ` ${r.resolved_target || r.target}` : "";
  // WHICH APP ACTUALLY OPENED. A tester asked the assistant to laugh, it
  // used play_music, YouTube opened — and a minute later it said "I didn't
  // open YouTube. I played a laughing sound." Both halves were true of the
  // TOOL and the second was false of the PHONE. The record knows which app
  // the device action named; saying it is the difference between a true
  // answer and a denial.
  const opened = /device action: \w+ → (.+)$/.exec(String(r.result || ""));
  let via = "";
  if (opened) {
    const t = opened[1];
    const host = /^https?:\/\/([^/?#]+)/.exec(t);
    if (host) {
      const app = host[1].replace(/^(www|m|music)\./, "").split(".")[0];
      if (app) via = ` (this opened ${app} on the phone)`;
    } else if (/^intent:/.test(t)) {
      // An intent handed to the phone's own app — the clock, the launcher,
      // a settings page. Saying "opened SET_ALARM" would read as gibberish;
      // the verb above already says what it was.
      via = " (handed to the phone's own app)";
    } else if (t) {
      via = ` (this opened ${t.split("/")[0]} on the phone)`;
    }
  }
  const how = r.decision && r.decision !== "ran" ? ` [${r.decision}]` : "";
  return `${when}: ${r.ok ? "" : "FAILED — "}${verb}${what}${via}${how}`.trim();
}

module.exports = {
  migrate, record, recent, didRun, findRecent, invalidate, attachReply,
  attachResolvedTarget, ledger, failures, describe, targetOf, argsText,
  intentKindOf,
};
