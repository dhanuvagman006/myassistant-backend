/**
 * BILLS BY EMAIL — the two tables.
 *
 *   mail_addresses  the user's private address (one live row), old ones
 *                   kept as 'retired' so a code is never reissued, and the
 *                   sending addresses they marked "This was me".
 *   mail_inbound    one row per accepted email: where it is in the
 *                   pipeline and what it became. The raw .eml lives in
 *                   files/<uid>/mailin/ only until the row is finished.
 *
 * Both are in routes/privacy.js USER_TABLES, so the account eraser and the
 * export cover them. Every query is scoped by user_id apart from
 * claimNext, countAllSince, prune and blankCodes (the worker and sweep).
 */
const { query, one, run } = require("../db");

async function migrate(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS mail_addresses (
      id           BIGSERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      code         TEXT    NOT NULL UNIQUE,
      status       TEXT    NOT NULL DEFAULT 'active',
      trusted_from JSONB   NOT NULL DEFAULT '[]',
      created_at   BIGINT  NOT NULL,
      updated_at   BIGINT  NOT NULL,
      retired_at   BIGINT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS mail_addresses_one_live
      ON mail_addresses(user_id) WHERE status IN ('active','off');
    CREATE INDEX IF NOT EXISTS mail_addresses_user ON mail_addresses(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS mail_inbound (
      id              BIGSERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL,
      address_id      BIGINT  NOT NULL,
      dedupe_key      TEXT    NOT NULL,
      message_id      TEXT    NOT NULL DEFAULT '',
      from_addr       TEXT    NOT NULL DEFAULT '',
      from_domain     TEXT    NOT NULL DEFAULT '',
      auth            TEXT    NOT NULL DEFAULT 'unverified',
      subject         TEXT    NOT NULL DEFAULT '',
      size            INTEGER NOT NULL DEFAULT 0,
      raw_path        TEXT    NOT NULL DEFAULT '',
      state           TEXT    NOT NULL DEFAULT 'queued',
      attempts        INTEGER NOT NULL DEFAULT 0,
      run_after       BIGINT  NOT NULL DEFAULT 0,
      lease_until     BIGINT  NOT NULL DEFAULT 0,
      reason          TEXT    NOT NULL DEFAULT '',
      kind            TEXT    NOT NULL DEFAULT '',
      extract         JSONB   NOT NULL DEFAULT '{}',
      file_hashes     JSONB   NOT NULL DEFAULT '[]',
      document_ids    JSONB   NOT NULL DEFAULT '[]',
      reminder_ids    JSONB   NOT NULL DEFAULT '[]',
      reminders_done  INTEGER NOT NULL DEFAULT 0,
      skipped_parts   JSONB   NOT NULL DEFAULT '[]',
      pushed          INTEGER NOT NULL DEFAULT 0,
      push_kind       TEXT    NOT NULL DEFAULT '',
      received_at     BIGINT  NOT NULL,
      updated_at      BIGINT  NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS mail_inbound_dedupe ON mail_inbound(user_id, dedupe_key);
    CREATE INDEX IF NOT EXISTS mail_inbound_user ON mail_inbound(user_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS mail_inbound_work ON mail_inbound(state, run_after)
      WHERE state IN ('queued','processing');
  `);
}

const JSON_COLS = new Set(["extract", "file_hashes", "document_ids", "reminder_ids", "skipped_parts"]);
const PATCHABLE = new Set([
  "from_addr", "from_domain", "auth", "subject", "raw_path", "state", "attempts",
  "run_after", "lease_until", "reason", "kind", "extract", "file_hashes", "document_ids",
  "reminder_ids", "reminders_done", "skipped_parts", "pushed", "push_kind",
]);

/** @returns {{id:number, created:boolean}} — an existing id on a duplicate. */
async function insertInbound(r) {
  const now = r.received_at || Date.now();
  const made = await one(
    `INSERT INTO mail_inbound (user_id, address_id, dedupe_key, message_id, size, state,
        run_after, received_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$7)
     ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
    [r.user_id, r.address_id, r.dedupe_key, String(r.message_id || "").slice(0, 300),
     r.size || 0, r.run_after || now, now]
  );
  if (made) return { id: Number(made.id), created: true };
  const had = await one(`SELECT id FROM mail_inbound WHERE user_id=$1 AND dedupe_key=$2`,
    [r.user_id, r.dedupe_key]);
  return { id: had ? Number(had.id) : 0, created: false };
}

const get = (userId, id) =>
  one(`SELECT * FROM mail_inbound WHERE user_id=$1 AND id=$2`, [userId, id]);

const list = (userId, { limit = 20 } = {}) =>
  query(`SELECT * FROM mail_inbound WHERE user_id=$1 ORDER BY received_at DESC, id DESC LIMIT $2`,
    [userId, Math.max(1, Math.min(50, Number(limit) || 20))]);

async function countSince(userId, ms) {
  return (await one(`SELECT count(*)::int AS n FROM mail_inbound WHERE user_id=$1 AND received_at>=$2`,
    [userId, ms])).n;
}
async function countAllSince(ms) {
  return (await one(`SELECT count(*)::int AS n FROM mail_inbound WHERE received_at>=$1`, [ms])).n;
}
/** Mail pushes sent in the window; `kinds` narrows to those push kinds. */
async function countPushesSince(userId, ms, kinds = null) {
  return (await one(
    `SELECT count(*)::int AS n FROM mail_inbound
      WHERE user_id=$1 AND pushed=1 AND received_at>=$2
        AND ($3::text[] IS NULL OR push_kind = ANY($3::text[]))`,
    [userId, ms, kinds])).n;
}

/** @returns number of rows changed (0 = the row is gone). */
async function patch(id, fields, userId = null) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!PATCHABLE.has(k)) throw new Error(`mailin: cannot patch ${k}`);
    vals.push(JSON_COLS.has(k) ? JSON.stringify(v) : v);
    sets.push(`${k}=$${vals.length}`);
  }
  vals.push(Date.now());
  sets.push(`updated_at=$${vals.length}`);
  vals.push(id);
  let where = `id=$${vals.length}`;
  if (userId != null) { vals.push(userId); where += ` AND user_id=$${vals.length}`; }
  return run(`UPDATE mail_inbound SET ${sets.join(", ")} WHERE ${where}`, vals);
}

/** One row to work on, SKIP LOCKED so two pods in a rollout never share one. */
function claimNext(now = Date.now()) {
  return one(
    `UPDATE mail_inbound SET state='processing', attempts=attempts+1,
            lease_until=$1+300000, updated_at=$1
      WHERE id = (SELECT id FROM mail_inbound
                   WHERE (state='queued' AND run_after <= $1)
                      OR (state='processing' AND lease_until < $1)
                   ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`, [now]);
}

async function findByFileHash(userId, hash, sinceMs, exceptId = 0) {
  return one(
    `SELECT id FROM mail_inbound WHERE user_id=$1 AND received_at>=$2
        AND file_hashes @> $3::jsonb AND id <> $4 LIMIT 1`,
    [userId, sinceMs, JSON.stringify([hash]), exceptId]);
}

/** Old log rows go; their documents and reminders stay. */
async function prune(olderThanMs) {
  const rows = await query(
    `DELETE FROM mail_inbound WHERE received_at < $1 AND state NOT IN ('queued','processing')
     RETURNING raw_path`, [olderThanMs]);
  return rows;
}

/** A forwarding confirmation code is shown for 24 hours, then blanked. */
function blankCodes(olderThanMs) {
  return run(
    `UPDATE mail_inbound SET extract = extract - 'confirmCode'
      WHERE kind='forward_confirm' AND received_at < $1 AND extract ? 'confirmCode'`,
    [olderThanMs]);
}

module.exports = {
  migrate, insertInbound, get, list, countSince, countAllSince, countPushesSince,
  patch, claimNext, findByFileHash, prune, blankCodes,
};
