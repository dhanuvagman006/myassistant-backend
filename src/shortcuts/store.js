/**
 * SHORTCUTS — PERSISTENCE.
 *
 *   shortcuts        one row per shortcut: its checked, ordered steps
 *   shortcut_names   EVERY way to say it, normalised; the primary key makes
 *                    "names are unique per user" a database fact
 *   shortcut_runs    one row per run: a snapshot of the steps, and while it
 *                    waits for a yes, exactly which steps that yes approves
 *
 * Every query is scoped by user_id: another user's id is "not found".
 * Created lazily, like posters/store.js; db.js is not touched. Expiry is
 * lazy too (there is no timer): a waiting run is expired when it is
 * resumed, and a user's old runs go when they next start one.
 */
const { query, one, run, tx } = require("../db");
const { nameKey } = require("./match");
const S = require("./steps");

const RUN_TTL_MS = 10 * 60_000;
const KEEP_RUNS_MS = 30 * 24 * 3600_000;

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS shortcuts (
        id           BIGSERIAL PRIMARY KEY,
        user_id      INTEGER NOT NULL,
        name         TEXT    NOT NULL,
        steps        JSONB   NOT NULL DEFAULT '[]'::jsonb,
        source       TEXT    NOT NULL DEFAULT 'voice',
        version      INTEGER NOT NULL DEFAULT 1,
        run_count    INTEGER NOT NULL DEFAULT 0,
        last_run_at  BIGINT  NOT NULL DEFAULT 0,
        created_at   BIGINT  NOT NULL,
        updated_at   BIGINT  NOT NULL
      );
      CREATE INDEX IF NOT EXISTS shortcuts_user ON shortcuts (user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS shortcut_names (
        user_id      INTEGER NOT NULL,
        name_key     TEXT    NOT NULL,
        shortcut_id  BIGINT  NOT NULL REFERENCES shortcuts(id) ON DELETE CASCADE,
        said         TEXT    NOT NULL,
        is_primary   BOOLEAN NOT NULL DEFAULT false,
        PRIMARY KEY (user_id, name_key)
      );
      CREATE INDEX IF NOT EXISTS shortcut_names_sc ON shortcut_names (shortcut_id);

      CREATE TABLE IF NOT EXISTS shortcut_runs (
        id           BIGSERIAL PRIMARY KEY,
        user_id      INTEGER NOT NULL,
        shortcut_id  BIGINT  NOT NULL,
        version      INTEGER NOT NULL,
        name         TEXT    NOT NULL,
        steps        JSONB   NOT NULL,
        status       TEXT    NOT NULL DEFAULT 'running',
        pending      JSONB,
        surface      TEXT    NOT NULL DEFAULT '',
        report       TEXT    NOT NULL DEFAULT '',
        created_at   BIGINT  NOT NULL,
        updated_at   BIGINT  NOT NULL
      );
      CREATE INDEX IF NOT EXISTS shortcut_runs_user ON shortcut_runs (user_id, id DESC);

      -- The phone-task ("do it for me") feature was removed 2026-09-29: its
      -- columns go, its steps go, and a shortcut left with no steps goes
      -- (shortcut_names cascades).
      ALTER TABLE shortcuts DROP COLUMN IF EXISTS replay;
      ALTER TABLE shortcuts DROP COLUMN IF EXISTS from_run_id;
      UPDATE shortcuts SET steps = (SELECT COALESCE(jsonb_agg(s), '[]'::jsonb) FROM jsonb_array_elements(steps) s WHERE s->>'tool' <> 'do_task_in_app') WHERE steps::text LIKE '%do_task_in_app%';
      DELETE FROM shortcuts WHERE jsonb_array_length(steps) = 0;
    `).catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

class ShortcutError extends Error {
  constructor(code, data = {}) {
    super(code);
    this.code = code;
    this.data = data;
  }
}

function hydrate(row, names = []) {
  if (!row) return null;
  const mine = names.filter((n) => Number(n.shortcut_id) === Number(row.id));
  const steps = (row.steps || []).map((s, i) => ({ ...s, i, icon: S.stepIcon(s) }));
  return {
    id: Number(row.id),
    name: row.name,
    other_names: mine.filter((n) => !n.is_primary).map((n) => n.said),
    version: Number(row.version),
    steps,
    run_count: Number(row.run_count),
    last_run_at: Number(row.last_run_at),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

/** The public shape (steps trimmed to what the screen shows). */
function publicShortcut(s) {
  if (!s) return null;
  return {
    ...s,
    steps: s.steps.map((st) => ({ i: st.i, tool: st.tool, label: st.label, said: st.said, class: st.class, icon: st.icon })),
  };
}

async function namesOf(userId) {
  await migrate();
  return query(
    `SELECT n.name_key, n.said, n.shortcut_id, n.is_primary, s.name
       FROM shortcut_names n JOIN shortcuts s ON s.id = n.shortcut_id
      WHERE n.user_id = $1`, [userId]);
}

/** Replace a shortcut's names inside a transaction. A clash is name_taken. */
async function setNames(client, userId, id, name, others = []) {
  const all = [{ said: name, primary: true }, ...others.map((o) => ({ said: o, primary: false }))];
  const seen = new Set();
  const list = [];
  for (const n of all) {
    const k = nameKey(n.said);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    list.push({ ...n, key: k });
  }
  if (list.length > S.MAX_NAMES) throw new ShortcutError("too_many_names", { max: S.MAX_NAMES });
  await client.query("DELETE FROM shortcut_names WHERE user_id = $1 AND shortcut_id = $2", [userId, id]);
  for (const n of list) {
    const clash = await client.query(
      "SELECT shortcut_id FROM shortcut_names WHERE user_id = $1 AND name_key = $2", [userId, n.key]);
    if (clash.rows.length) throw new ShortcutError("name_taken", { name: n.said });
    await client.query(
      `INSERT INTO shortcut_names (user_id, name_key, shortcut_id, said, is_primary) VALUES ($1,$2,$3,$4,$5)`,
      [userId, n.key, id, String(n.said).trim().slice(0, 40), n.primary]);
  }
}

const pretty = (s) => {
  const t = String(s || "").trim().replace(/\s+/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

async function create(userId, { name, otherNames = [], steps }) {
  await migrate();
  const now = Date.now();
  const id = await tx(async (c) => {
    // One user's creates are serialised, so the count below is exact.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('shortcuts'), $1)", [userId]);
    const n = await c.query("SELECT count(*)::int AS n FROM shortcuts WHERE user_id = $1", [userId]);
    if (n.rows[0].n >= S.MAX_SHORTCUTS) throw new ShortcutError("too_many_shortcuts", { max: S.MAX_SHORTCUTS });
    const row = await c.query(
      `INSERT INTO shortcuts (user_id, name, steps, created_at, updated_at)
       VALUES ($1,$2,$3::jsonb,$4,$4) RETURNING id`,
      [userId, pretty(name).slice(0, 40), JSON.stringify(steps), now]);
    await setNames(c, userId, row.rows[0].id, name, otherNames);
    return row.rows[0].id;
  });
  require("./match").invalidate(userId);
  return get(userId, id);
}

async function get(userId, id) {
  await migrate();
  if (!Number.isInteger(Number(id))) return null;
  const row = await one("SELECT * FROM shortcuts WHERE user_id = $1 AND id = $2", [userId, Number(id)]);
  if (!row) return null;
  const names = await query("SELECT * FROM shortcut_names WHERE user_id = $1 AND shortcut_id = $2", [userId, row.id]);
  return hydrate(row, names);
}

async function list(userId) {
  await migrate();
  const [rows, names] = await Promise.all([
    query("SELECT * FROM shortcuts WHERE user_id = $1 ORDER BY updated_at DESC", [userId]),
    query("SELECT * FROM shortcut_names WHERE user_id = $1", [userId]),
  ]);
  return rows.map((r) => hydrate(r, names));
}

/**
 * Change a shortcut. `version` (when given) must match, or "stale": the
 * phone and the voice edit the same shortcut, and a stale edit must never
 * silently undo a newer one.
 */
async function update(userId, id, { name, otherNames, steps }, { version } = {}) {
  await migrate();
  const cur = await get(userId, id);
  if (!cur) throw new ShortcutError("not_found");
  if (version !== undefined && version !== null && Number(version) !== cur.version) {
    throw new ShortcutError("stale", { shortcut: cur });
  }
  const now = Date.now();
  await tx(async (c) => {
    const r = await c.query(
      `UPDATE shortcuts SET name = $3, steps = $4::jsonb, version = version + 1, updated_at = $5
        WHERE user_id = $1 AND id = $2 AND version = $6`,
      [userId, cur.id, pretty(name ?? cur.name).slice(0, 40),
       JSON.stringify(steps ?? cur.steps.map(({ i, icon, ...s }) => s)), now, cur.version]);
    if (!r.rowCount) throw new ShortcutError("stale", { shortcut: cur });
    if (name !== undefined || otherNames !== undefined) {
      await setNames(c, userId, cur.id, name ?? cur.name, otherNames ?? cur.other_names);
    }
  });
  require("./match").invalidate(userId);
  return get(userId, cur.id);
}

async function remove(userId, id) {
  await migrate();
  const n = await run("DELETE FROM shortcuts WHERE user_id = $1 AND id = $2", [userId, Number(id)]);
  require("./match").invalidate(userId);
  return n > 0;
}

async function byNameKey(userId, key) {
  await migrate();
  const r = await one("SELECT shortcut_id FROM shortcut_names WHERE user_id = $1 AND name_key = $2", [userId, key]);
  return r ? get(userId, r.shortcut_id) : null;
}

/* ---- runs ---- */

function hydrateRun(r) {
  if (!r) return null;
  return {
    ...r,
    id: Number(r.id),
    user_id: Number(r.user_id),
    shortcut_id: Number(r.shortcut_id),
    version: Number(r.version),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

/** Today's runs for the daily limit. */
async function countToday(userId, now = Date.now()) {
  await migrate();
  const r = await one("SELECT count(*)::int AS n FROM shortcut_runs WHERE user_id = $1 AND created_at > $2",
    [userId, now - 24 * 3600_000]);
  return r ? r.n : 0;
}

/**
 * A new run with a snapshot of the steps. For THIS user only: stale
 * waiting runs become expired and runs older than 30 days are deleted.
 */
async function createRun(userId, shortcut, { surface = "", steps, now = Date.now() } = {}) {
  await migrate();
  await run("UPDATE shortcut_runs SET status = 'expired', updated_at = $3 WHERE user_id = $1 AND status = 'waiting' AND created_at < $2",
    [userId, now - RUN_TTL_MS, now]);
  await run("DELETE FROM shortcut_runs WHERE user_id = $1 AND created_at < $2", [userId, now - KEEP_RUNS_MS]);
  return hydrateRun(await one(
    `INSERT INTO shortcut_runs (user_id, shortcut_id, version, name, steps, surface, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$7) RETURNING *`,
    [userId, shortcut.id, shortcut.version, shortcut.name, JSON.stringify(steps || shortcut.steps), surface, now]));
}

async function getRun(userId, id) {
  await migrate();
  if (!Number.isInteger(Number(id))) return null;
  return hydrateRun(await one("SELECT * FROM shortcut_runs WHERE user_id = $1 AND id = $2", [userId, Number(id)]));
}

/** Save a run's changed fields. `onlyIf` guards a status transition. */
async function saveRun(userId, id, fields, { onlyIf = null } = {}) {
  await migrate();
  const sets = [];
  const vals = [userId, Number(id)];
  for (const [k, v] of Object.entries(fields)) {
    vals.push(k === "steps" || k === "pending" ? (v === null ? null : JSON.stringify(v)) : v);
    sets.push(`${k} = $${vals.length}${k === "steps" || k === "pending" ? "::jsonb" : ""}`);
  }
  vals.push(Date.now());
  sets.push(`updated_at = $${vals.length}`);
  let where = "user_id = $1 AND id = $2";
  if (onlyIf) {
    vals.push(onlyIf);
    where += ` AND status = ANY($${vals.length}::text[])`;
  }
  return hydrateRun(await one(`UPDATE shortcut_runs SET ${sets.join(", ")} WHERE ${where} RETURNING *`, vals));
}

async function bumpRunCount(userId, id) {
  await run("UPDATE shortcuts SET run_count = run_count + 1, last_run_at = $3 WHERE user_id = $1 AND id = $2",
    [userId, Number(id), Date.now()]);
}

module.exports = {
  migrate, ShortcutError, publicShortcut, namesOf, setNames, create, get, list, update, remove,
  byNameKey, countToday, createRun, getRun, saveRun, bumpRunCount, RUN_TTL_MS, KEEP_RUNS_MS,
};
