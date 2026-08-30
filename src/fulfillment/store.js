/**
 * FULFILLMENT LEDGER — every errand Hari runs in the real world.
 *
 * One row per task, written BEFORE anything happens and updated with the
 * true outcome afterwards. That ordering is deliberate: if a call drops or
 * the process restarts mid-errand, the task still exists in a non-terminal
 * state rather than vanishing, so "what happened to my table booking?" has
 * an answer.
 *
 * Nothing here decides anything — it records. The honesty rules live in
 * service.js; this file only makes sure the record matches reality.
 */
const { query, one, run } = require("../db");

/** Terminal states — a task in one of these will never change again. */
const TERMINAL = new Set(["confirmed", "handed_off", "failed", "cancelled"]);

async function create(userId, task) {
  const now = Date.now();
  const row = await one(
    `INSERT INTO fulfillment_tasks
       (user_id, kind, provider, path, title, venue, phone, when_at,
        party_size, details, deep_link, call_id, outcome, status,
        created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
     RETURNING *`,
    [
      userId,
      task.kind || "other",
      task.provider || "",
      task.path || "handoff",
      String(task.title || "Task").slice(0, 200),
      task.venue || null,
      task.phone || null,
      task.when_at || null,
      task.party_size || null,
      JSON.stringify(task.details || {}),
      task.deep_link || null,
      task.call_id || null,
      task.outcome || null,
      task.status || "draft",
      now,
    ]
  );
  return hydrate(row);
}

async function update(id, patch) {
  const allowed = [
    "status", "outcome", "deep_link", "call_id", "phone",
    "venue", "when_at", "party_size", "provider", "path",
  ];
  const sets = [];
  const vals = [];
  let i = 1;
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    sets.push(`${k} = $${i++}`);
    vals.push(patch[k]);
  }
  if (patch.details !== undefined) {
    sets.push(`details = $${i++}`);
    vals.push(JSON.stringify(patch.details));
  }
  if (!sets.length) return get(id);
  sets.push(`updated_at = $${i++}`);
  vals.push(Date.now());
  vals.push(id);
  const row = await one(
    `UPDATE fulfillment_tasks SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );
  return hydrate(row);
}

async function get(id, userId = null) {
  const row = userId
    ? await one(`SELECT * FROM fulfillment_tasks WHERE id=$1 AND user_id=$2`, [id, userId])
    : await one(`SELECT * FROM fulfillment_tasks WHERE id=$1`, [id]);
  return hydrate(row);
}

/** Recent tasks for the user — what the app's "errands" list shows. */
async function list(userId, { limit = 20, activeOnly = false } = {}) {
  const rows = await query(
    `SELECT * FROM fulfillment_tasks
      WHERE user_id = $1
        ${activeOnly ? `AND status NOT IN ('confirmed','handed_off','failed','cancelled')` : ""}
      ORDER BY id DESC LIMIT $2`,
    [userId, Math.min(Number(limit) || 20, 50)]
  );
  return rows.map(hydrate);
}

/** Tasks still waiting on a phone call, so a poller can finish them. */
async function pendingCalls(userId = null) {
  const rows = userId
    ? await query(
        `SELECT * FROM fulfillment_tasks
          WHERE status='calling' AND call_id IS NOT NULL AND user_id=$1`,
        [userId]
      )
    : await query(
        `SELECT * FROM fulfillment_tasks
          WHERE status='calling' AND call_id IS NOT NULL`
      );
  return rows.map(hydrate);
}

function hydrate(row) {
  if (!row) return null;
  let details = {};
  try {
    details = JSON.parse(row.details || "{}");
  } catch (_) {}
  return {
    ...row,
    id: Number(row.id),
    when_at: row.when_at === null ? null : Number(row.when_at),
    details,
    terminal: TERMINAL.has(row.status),
  };
}

module.exports = { create, update, get, list, pendingCalls, TERMINAL };
