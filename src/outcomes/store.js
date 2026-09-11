/**
 * TASK OUTCOMES — the truth about what the assistant was asked to do.
 * ---------------------------------------------------------------------
 * Every device-side or relayed task the user triggers (a phone call, a
 * document filed under a patient, …) gets ONE row here, created when it is
 * dispatched and UPDATED when the real result is known. "ok" at dispatch
 * time never counts as success: a call is only `connected` when the phone
 * reported it, `failed` carries the reason, `unconfirmed` means the dialer
 * opened but nothing proved the call went through.
 *
 * Read by: the agent (check_task_outcomes tool + a [SYSTEM] line in the
 * conversation), the app's Activity screen, and the admin panel.
 */
const { query, one, run } = require("../db");

const KINDS = new Set(["call", "agent_call", "document", "message", "other"]);
const STATUSES = new Set([
  "requested",   // dispatched to the device / provider, nothing known yet
  "dialing",     // the phone/provider is dialing
  "connected",   // a call actually started (phone state or provider webhook)
  "unconfirmed", // dialer opened but the phone never saw a call start
  "completed",   // finished successfully
  "no_answer",
  "failed",
  "cancelled",
]);
const TERMINAL = new Set(["connected", "unconfirmed", "completed", "no_answer", "failed", "cancelled"]);

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS task_outcomes (
        id          BIGSERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        target      TEXT NOT NULL DEFAULT '',
        detail      TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL,
        reason      TEXT NOT NULL DEFAULT '',
        path        TEXT NOT NULL DEFAULT 'device',
        external_id TEXT NOT NULL DEFAULT '',
        session_id  TEXT NOT NULL DEFAULT '',
        created_at  BIGINT NOT NULL,
        updated_at  BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outcomes_user ON task_outcomes(user_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_outcomes_time ON task_outcomes(created_at DESC);
    `).catch((e) => {
      console.error("task_outcomes migration failed:", e.message);
      migrated = null;
    });
  }
  return migrated;
}

const clean = (s, n) => String(s ?? "").trim().slice(0, n);

async function create(userId, { kind, target, detail, status = "requested", path = "device", externalId, sessionId }) {
  await migrate();
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) return null;
  const now = Date.now();
  return one(
    `INSERT INTO task_outcomes (user_id, kind, target, detail, status, path, external_id, session_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
    [uid, KINDS.has(kind) ? kind : "other", clean(target, 160), clean(detail, 400),
     STATUSES.has(status) ? status : "requested", clean(path, 20), clean(externalId, 80), clean(sessionId, 80), now]
  );
}

/** Update status/reason/detail. A terminal row is never demoted back to a
 *  non-terminal one (a late "dialing" after "failed" must not hide the failure). */
async function update(userId, id, { status, reason, detail }) {
  await migrate();
  const row = await one("SELECT * FROM task_outcomes WHERE id = $1 AND user_id = $2", [Number(id), Number(userId)]);
  if (!row) return null;
  const next = STATUSES.has(status) ? status : row.status;
  if (TERMINAL.has(row.status) && !TERMINAL.has(next)) return row;
  await run(
    `UPDATE task_outcomes SET status=$1, reason=$2, detail=$3, updated_at=$4 WHERE id=$5`,
    [next, reason !== undefined ? clean(reason, 300) : row.reason,
     detail !== undefined ? clean(detail, 400) : row.detail, Date.now(), row.id]
  );
  return one("SELECT * FROM task_outcomes WHERE id = $1", [row.id]);
}

async function updateByExternalId(externalId, patch) {
  await migrate();
  const row = await one("SELECT * FROM task_outcomes WHERE external_id = $1 ORDER BY id DESC LIMIT 1", [clean(externalId, 80)]);
  if (!row) return null;
  return update(row.user_id, row.id, patch);
}

async function list(userId, { limit = 30, kind } = {}) {
  await migrate();
  const params = [Number(userId)];
  let where = "user_id = $1";
  if (kind && KINDS.has(kind)) { params.push(kind); where += ` AND kind = $${params.length}`; }
  params.push(Math.min(Math.max(Number(limit) || 30, 1), 200));
  return query(`SELECT * FROM task_outcomes WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`, params);
}

/** Admin: cross-user page with optional filters + a status histogram. */
async function adminList({ q, status, kind, userId, limit = 50, offset = 0, sinceMs } = {}) {
  await migrate();
  const where = [];
  const params = [];
  if (q) { params.push(`%${q}%`); where.push(`(t.target ILIKE $${params.length} OR t.detail ILIKE $${params.length} OR t.reason ILIKE $${params.length})`); }
  if (status && STATUSES.has(status)) { params.push(status); where.push(`t.status = $${params.length}`); }
  if (kind && KINDS.has(kind)) { params.push(kind); where.push(`t.kind = $${params.length}`); }
  if (Number.isFinite(userId)) { params.push(userId); where.push(`t.user_id = $${params.length}`); }
  if (sinceMs) { params.push(sinceMs); where.push(`t.created_at >= $${params.length}`); }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = await query(
    `SELECT t.*, u.name AS user_name FROM task_outcomes t LEFT JOIN users u ON u.id = t.user_id
     ${w} ORDER BY t.id DESC LIMIT ${Math.min(Number(limit) || 50, 200)} OFFSET ${Math.max(Number(offset) || 0, 0)}`,
    params
  );
  const hist = await query(
    `SELECT t.status, COUNT(*)::int AS n FROM task_outcomes t ${w} GROUP BY t.status`, params
  );
  return { rows, histogram: Object.fromEntries(hist.map((h) => [h.status, h.n])) };
}

/**
 * A task of this kind for this target that has NOT reached a terminal
 * state — a call still dialling, a request just dispatched. Dialling the
 * same person again while one is in flight is never what the user meant.
 */
// 90s, not minutes: a dial that is still "dialing" after that never got a
// result back from the device, and a stale record must not block a retry.
async function findInFlight(userId, kind, target, windowMs = 90_000) {
  await migrate();
  const uid = Number(userId);
  const t = clean(target, 160);
  // An unidentifiable target must never match — see actions/store.targetOf.
  if (!Number.isInteger(uid) || uid <= 0 || !t) return null;
  const kinds = (Array.isArray(kind) ? kind : [kind]).map((k) => clean(k, 20));
  if (!kinds.length) return null;
  return one(
    `SELECT * FROM task_outcomes
      WHERE user_id = $1 AND kind = ANY($2) AND lower(target) = lower($3)
        AND status IN ('requested','dialing')
        AND created_at >= $4
      ORDER BY id DESC LIMIT 1`,
    [uid, kinds, t, Date.now() - windowMs]
  );
}

function isSuccess(status) {
  return status === "connected" || status === "completed";
}
function isFailure(status) {
  return status === "failed" || status === "no_answer" || status === "cancelled";
}

function toClient(r) {
  return {
    id: Number(r.id),
    kind: r.kind,
    target: r.target,
    detail: r.detail,
    status: r.status,
    reason: r.reason,
    path: r.path,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    ok: isSuccess(r.status) ? true : isFailure(r.status) ? false : null,
  };
}

/** One human line per outcome — what the agent says when asked. */
function describe(r) {
  const who = r.target || "them";
  switch (r.kind) {
    case "call":
    case "agent_call":
      switch (r.status) {
        case "connected": return `the call to ${who} connected`;
        case "completed": return `the call to ${who} was completed${r.detail ? ` — ${r.detail}` : ""}`;
        case "unconfirmed": return `the dialer opened for ${who}, but the phone never confirmed the call started`;
        case "no_answer": return `${who} did not answer`;
        case "failed": return `the call to ${who} FAILED${r.reason ? ` — ${r.reason}` : ""}`;
        case "cancelled": return `the call to ${who} was cancelled`;
        case "dialing": return `the phone is dialing ${who}`;
        default: return `the call to ${who} was requested but no result has come back yet`;
      }
    case "document":
      if (r.status === "completed") return `document ${r.detail || "saved"}${who ? ` (${who})` : ""}`;
      if (r.status === "failed") return `document save FAILED${r.reason ? ` — ${r.reason}` : ""}`;
      return `document task ${r.status}`;
    default:
      return `${r.kind} ${who}: ${r.status}${r.reason ? ` — ${r.reason}` : ""}`;
  }
}

module.exports = { migrate, create, update, updateByExternalId, findInFlight, list, adminList, toClient, describe, isSuccess, isFailure, STATUSES, KINDS };
