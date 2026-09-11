/**
 * RECORD BOOK — the user's own running accounts and tallies.
 * ---------------------------------------------------------
 * "Manage my horse race accounts", "log race 1 minus 4.5", "what's my
 * total this week". A professional dictates numbers against a topic and
 * expects a ledger with a running total — nothing existed for that, so
 * the assistant misrouted dictated figures into messages and notes.
 *
 * Deliberately generic: a topic (free text), an optional label, an
 * optional signed amount and an optional note. Works for race accounts,
 * scores, petty cash, anything a person tallies.
 *
 * Self-migrating, like outcomes and practice.
 */
const { query, one, run } = require("../db");

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS records (
        id         BIGSERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL,
        topic      TEXT NOT NULL,
        label      TEXT NOT NULL DEFAULT '',
        amount     NUMERIC,
        note       TEXT NOT NULL DEFAULT '',
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_records_user ON records(user_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_records_topic ON records(user_id, lower(topic), id DESC);
    `).catch((e) => {
      console.error("records migration failed:", e.message);
      migrated = null;
    });
  }
  return migrated;
}

const clean = (s, n) => String(s ?? "").trim().slice(0, n);

/** Normalised topic key so "Horse race" and "horse races" meet. */
function topicKey(topic) {
  return clean(topic, 80).toLowerCase().replace(/s\b/g, "").replace(/\s+/g, " ").trim();
}

async function add(userId, { topic, label, amount, note }) {
  await migrate();
  const t = clean(topic, 80);
  if (!t) throw new Error("topic required");
  const amt = amount === undefined || amount === null || amount === ""
    ? null
    : Math.round(Number(amount) * 100) / 100;
  if (amt !== null && !Number.isFinite(amt)) throw new Error("amount must be a number");
  return one(
    `INSERT INTO records (user_id, topic, label, amount, note, created_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [userId, t, clean(label, 80), amt, clean(note, 300), Date.now()]
  );
}

/** Entries for a topic (or all), newest first, with the running total. */
async function list(userId, { topic, sinceMs, limit = 50 } = {}) {
  await migrate();
  const params = [userId];
  let where = "user_id = $1";
  if (topic) {
    params.push(`%${topicKey(topic).split(" ")[0]}%`);
    where += ` AND lower(topic) LIKE $${params.length}`;
  }
  if (sinceMs) { params.push(sinceMs); where += ` AND created_at >= $${params.length}`; }
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const rows = await query(
    `SELECT * FROM records WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  const total = rows.reduce((sum, r) => sum + (r.amount === null ? 0 : Number(r.amount)), 0);
  return { rows, total: Math.round(total * 100) / 100 };
}

/** The topics a user keeps, most recently used first. */
async function topics(userId) {
  await migrate();
  return query(
    `SELECT topic, COUNT(*)::int AS entries,
            COALESCE(SUM(amount), 0) AS total, MAX(created_at) AS last_at
       FROM records WHERE user_id = $1 GROUP BY topic ORDER BY last_at DESC LIMIT 20`,
    [userId]
  );
}

/** Removes the newest entry matching a label (or simply the newest). */
async function removeLatest(userId, { topic, label } = {}) {
  await migrate();
  const params = [userId];
  let where = "user_id = $1";
  if (topic) { params.push(`%${topicKey(topic).split(" ")[0]}%`); where += ` AND lower(topic) LIKE $${params.length}`; }
  if (label) { params.push(`%${clean(label, 80).toLowerCase()}%`); where += ` AND lower(label) LIKE $${params.length}`; }
  const row = await one(`SELECT * FROM records WHERE ${where} ORDER BY id DESC LIMIT 1`, params);
  if (!row) return null;
  await run("DELETE FROM records WHERE id = $1", [row.id]);
  return row;
}

/** Correct the newest entry in a topic — "no, that should be minus 4.5". */
async function amendLatest(userId, { topic, amount, label, note }) {
  await migrate();
  const params = [userId];
  let where = "user_id = $1";
  if (topic) { params.push(`%${topicKey(topic).split(" ")[0]}%`); where += ` AND lower(topic) LIKE $${params.length}`; }
  const row = await one(`SELECT * FROM records WHERE ${where} ORDER BY id DESC LIMIT 1`, params);
  if (!row) return null;
  const amt = amount === undefined || amount === null || amount === ""
    ? row.amount
    : Math.round(Number(amount) * 100) / 100;
  await run(
    `UPDATE records SET amount=$2, label=$3, note=$4 WHERE id=$1`,
    [row.id, amt, label !== undefined ? clean(label, 80) : row.label,
     note !== undefined ? clean(note, 300) : row.note]
  );
  return one("SELECT * FROM records WHERE id = $1", [row.id]);
}

function toClient(r) {
  return {
    id: Number(r.id),
    topic: r.topic,
    label: r.label,
    amount: r.amount === null ? null : Number(r.amount),
    note: r.note,
    createdAt: Number(r.created_at),
  };
}

module.exports = { migrate, add, list, topics, removeLatest, amendLatest, toClient };
