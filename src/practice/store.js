/**
 * PRACTICE STORE — the busy professional's recurring chores, per client.
 * ----------------------------------------------------------------------
 * Two small ledgers on top of the clients table:
 *
 *   • client_recalls — "recall Ramesh in six months", "Sharma hearing on
 *     Oct 3". The professional gets a normal reminder (reminders table →
 *     existing push/alarm pipeline). When notify_patient is set and
 *     telephony is configured, the assistant itself calls the patient in
 *     the 16 hours before it is due (see proactive/scheduler.js) — the
 *     call that wins dentists their recall revenue back.
 *
 *   • client_ledger — "Ramesh paid 500" / "Ramesh owes 2000". Balance per
 *     client = dues − payments; "who hasn't paid" reads the positive ones.
 *
 * Self-migrating like outcomes/store.js: no db.js changes needed.
 */
const { query, one, run } = require("../db");

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS client_recalls (
        id             BIGSERIAL PRIMARY KEY,
        user_id        INTEGER NOT NULL,
        client_id      BIGINT NOT NULL,
        note           TEXT NOT NULL DEFAULT '',
        due_at         BIGINT NOT NULL,
        notify_patient INTEGER NOT NULL DEFAULT 0,
        reminder_id    BIGINT,
        called_at      BIGINT NOT NULL DEFAULT 0,
        status         TEXT NOT NULL DEFAULT 'pending',
        created_at     BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recalls_user ON client_recalls(user_id, status, due_at);
      CREATE INDEX IF NOT EXISTS idx_recalls_due ON client_recalls(status, notify_patient, called_at, due_at);
      CREATE TABLE IF NOT EXISTS client_ledger (
        id         BIGSERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL,
        client_id  BIGINT NOT NULL,
        amount     NUMERIC NOT NULL,
        kind       TEXT NOT NULL,
        note       TEXT NOT NULL DEFAULT '',
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_user ON client_ledger(user_id, client_id, id DESC);
    `).catch((e) => {
      console.error("practice migration failed:", e.message);
      migrated = null;
    });
  }
  return migrated;
}

const clean = (s, n) => String(s ?? "").trim().slice(0, n);

/* ---------------- recalls ---------------- */

async function createRecall(userId, { clientId, note, dueAt, notifyPatient }) {
  await migrate();
  return one(
    `INSERT INTO client_recalls (user_id, client_id, note, due_at, notify_patient, created_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [userId, Number(clientId), clean(note, 300), Number(dueAt),
     notifyPatient ? 1 : 0, Date.now()]
  );
}

async function setReminderId(userId, recallId, reminderId) {
  await migrate();
  await run("UPDATE client_recalls SET reminder_id = $1 WHERE id = $2 AND user_id = $3",
    [Number(reminderId), Number(recallId), userId]);
}

/** Pending recalls, soonest first. `dueBefore` filters to a horizon. */
async function listRecalls(userId, { clientId, dueBefore, limit = 50 } = {}) {
  await migrate();
  const params = [userId];
  let where = "user_id = $1 AND status = 'pending'";
  if (clientId) { params.push(Number(clientId)); where += ` AND client_id = $${params.length}`; }
  if (dueBefore) { params.push(Number(dueBefore)); where += ` AND due_at <= $${params.length}`; }
  params.push(Math.min(Number(limit) || 50, 200));
  return query(
    `SELECT * FROM client_recalls WHERE ${where} ORDER BY due_at ASC LIMIT $${params.length}`,
    params
  );
}

/** The next pending recall for one client, or null. */
async function nextRecallFor(userId, clientId) {
  await migrate();
  return one(
    `SELECT * FROM client_recalls WHERE user_id = $1 AND client_id = $2 AND status = 'pending'
     ORDER BY due_at ASC LIMIT 1`,
    [userId, Number(clientId)]
  );
}

/** Marks a recall done/cancelled. Returns the row or null. */
async function closeRecall(userId, recallId, status = "done") {
  await migrate();
  const row = await one(
    "SELECT * FROM client_recalls WHERE id = $1 AND user_id = $2", [Number(recallId), userId]);
  if (!row || row.status !== "pending") return null;
  await run("UPDATE client_recalls SET status = $1 WHERE id = $2",
    [status === "cancelled" ? "cancelled" : "done", row.id]);
  return row;
}

/**
 * Recalls whose PATIENT should be called now: pending, notify on, never
 * called, due within the next 16 hours (evening-before for a morning
 * appointment, morning-of for an evening one) and not more than 12 hours
 * past due (a server that was down must not ring patients about last
 * week). Joined with the client so the caller has name + phone.
 */
async function recallsNeedingCall(now = Date.now()) {
  await migrate();
  return query(
    `SELECT r.*, c.name AS client_name, c.phone AS client_phone
       FROM client_recalls r JOIN clients c ON c.id = r.client_id AND c.user_id = r.user_id
      WHERE r.status = 'pending' AND r.notify_patient = 1 AND r.called_at = 0
        AND r.due_at <= $1 + 16 * 3600 * 1000
        AND r.due_at >= $1 - 12 * 3600 * 1000
        AND c.phone <> ''
      ORDER BY r.due_at ASC LIMIT 20`,
    [now]
  );
}

/** Stamped BEFORE the call is attempted — one attempt, never a retry loop. */
async function markCalled(recallId) {
  await migrate();
  await run("UPDATE client_recalls SET called_at = $1 WHERE id = $2", [Date.now(), Number(recallId)]);
}

async function removeForClient(userId, clientId) {
  await migrate();
  await run("DELETE FROM client_recalls WHERE user_id = $1 AND client_id = $2", [userId, Number(clientId)]);
  await run("DELETE FROM client_ledger WHERE user_id = $1 AND client_id = $2", [userId, Number(clientId)]);
}

/* ---------------- money ---------------- */

/** kind 'due' (they owe more) or 'paid' (they settled some). */
async function addLedger(userId, { clientId, amount, kind, note }) {
  await migrate();
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(amt) || amt <= 0) return null;
  return one(
    `INSERT INTO client_ledger (user_id, client_id, amount, kind, note, created_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [userId, Number(clientId), amt, kind === "paid" ? "paid" : "due", clean(note, 200), Date.now()]
  );
}

/** Outstanding balance for one client (dues − payments; can be negative). */
async function balanceOf(userId, clientId) {
  await migrate();
  const r = await one(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'due' THEN amount ELSE -amount END), 0) AS bal
       FROM client_ledger WHERE user_id = $1 AND client_id = $2`,
    [userId, Number(clientId)]
  );
  return Math.round(Number(r?.bal || 0) * 100) / 100;
}

/** Everyone who still owes money, largest balance first. */
async function pendingDues(userId, limit = 20) {
  await migrate();
  return query(
    `SELECT l.client_id, c.name,
            COALESCE(SUM(CASE WHEN l.kind = 'due' THEN l.amount ELSE -l.amount END), 0) AS balance
       FROM client_ledger l JOIN clients c ON c.id = l.client_id AND c.user_id = l.user_id
      WHERE l.user_id = $1
      GROUP BY l.client_id, c.name
     HAVING COALESCE(SUM(CASE WHEN l.kind = 'due' THEN l.amount ELSE -l.amount END), 0) > 0
      ORDER BY balance DESC LIMIT $2`,
    [userId, Math.min(Number(limit) || 20, 100)]
  );
}

/* ---------------- shapes ---------------- */

function recallToClient(r) {
  return {
    id: Number(r.id),
    clientId: Number(r.client_id),
    note: r.note,
    dueAt: Number(r.due_at),
    notifyPatient: Number(r.notify_patient) === 1,
    status: r.status,
    createdAt: Number(r.created_at),
  };
}

module.exports = {
  migrate,
  createRecall, setReminderId, listRecalls, nextRecallFor, closeRecall,
  recallsNeedingCall, markCalled, removeForClient,
  addLedger, balanceOf, pendingDues,
  recallToClient,
};
