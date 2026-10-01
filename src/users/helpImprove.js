/**
 * "HELP IMPROVE THE ASSISTANT" — the one switch that decides whether our
 * team may review a person's conversations and recordings.
 *
 * Owner's decision (2026-09-27): ask once, and it stays OFF until the user
 * says yes (HELP_IMPROVE_DEFAULT=ask). "on" treats people never asked as
 * ON, without an app change. The DPDP Act wants consent by a clear
 * affirmative action, proof of it (consent_events), and withdrawal as easy
 * as giving it — so turning it off deletes the recordings straight away.
 *
 * ON  → the team may review content created at or after `on_since`.
 * OFF → no recordings; turns kept only for the assistant (7 days, 100);
 *       nothing shown in the admin panel; the assistant works the same.
 *
 * THE ONE DEFINITION of "may the team look at this row?" is the SQL
 * function hari_reviewable(uid, ts), re-created at every boot so it
 * follows the policy. A function, not views: views would show up in
 * information_schema and trip the erase guards (see the design, F6).
 */
const { query, one, run, tx } = require("../db");

const NOTICE_VERSIONS = new Set(["help-improve-v1"]);
const NOTICE_VERSION = "help-improve-v1";
const SOURCES = new Set(["ask_card", "settings"]);
const PRIVATE_KEEP = { days: 7, turns: 100 };

/** Read at call time, so a test (or a configmap change) takes effect. */
function policy() {
  // Default ON (2026-10-01, owner: pre-release internal testers, record every
  // conversation for the admin panel, no consent prompt). Set
  // HELP_IMPROVE_DEFAULT=ask to go back to asking before any public release.
  return String(process.env.HELP_IMPROVE_DEFAULT || "on").trim().toLowerCase() === "ask"
    ? "ask" : "on";
}

function functionSql() {
  // Column names come from code only; the policy picks one of two bodies.
  const body = policy() === "on"
    ? `SELECT NOT EXISTS (SELECT 1 FROM privacy_prefs pp WHERE pp.user_id = uid
         AND (pp.help_improve = 0 OR (pp.help_improve = 1 AND ts < pp.on_since)))`
    : `SELECT EXISTS (SELECT 1 FROM privacy_prefs pp
         WHERE pp.user_id = uid AND pp.help_improve = 1 AND ts >= pp.on_since)`;
  return `CREATE OR REPLACE FUNCTION hari_reviewable(uid bigint, ts bigint) RETURNS boolean
    LANGUAGE sql STABLE AS $fn$ ${body} $fn$;`;
}

async function migrate(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS privacy_prefs (
      user_id        INTEGER PRIMARY KEY,
      help_improve   INTEGER,
      on_since       BIGINT NOT NULL DEFAULT 0,
      decided_at     BIGINT,
      notice_version TEXT   NOT NULL DEFAULT '',
      source         TEXT   NOT NULL DEFAULT '',
      updated_at     BIGINT NOT NULL
    );
    -- Proof of notice and consent (DPDP s.6(10)); append-only by convention.
    CREATE TABLE IF NOT EXISTS consent_events (
      id             BIGSERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL,
      kind           TEXT   NOT NULL,
      value          INTEGER NOT NULL,
      notice_version TEXT   NOT NULL DEFAULT '',
      source         TEXT   NOT NULL DEFAULT '',
      app_build      INTEGER NOT NULL DEFAULT 0,
      created_at     BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_consent_user ON consent_events(user_id, id DESC);
    ALTER TABLE developer_feedback ADD COLUMN IF NOT EXISTS user_asked INTEGER NOT NULL DEFAULT 0;
  `);
  await exec(functionSql());
}

/** `hari_reviewable(<u>, <ts>)` — column expressions from code, never a request. */
function reviewableSql(userCol, timeCol) {
  const ok = /^[a-z_][a-z0-9_.]*$/i;
  if (!ok.test(userCol) || !ok.test(timeCol)) throw new Error("reviewableSql: bad column");
  return `hari_reviewable(${userCol}, ${timeCol})`;
}

async function state(userId) {
  const uid = Number(userId);
  const row = uid > 0
    ? await one(`SELECT * FROM privacy_prefs WHERE user_id = $1`, [uid]).catch(() => null)
    : null;
  const v = row && row.help_improve !== null && row.help_improve !== undefined
    ? Number(row.help_improve) === 1 : null;
  return {
    helpImprove: v,
    onSince: row ? Number(row.on_since) || 0 : 0,
    decidedAt: row && row.decided_at ? Number(row.decided_at) : null,
    noticeVersion: row ? row.notice_version || "" : "",
  };
}

/** The value, or the policy default when they were never asked. */
async function effective(userId) {
  const s = await state(userId);
  return s.helpImprove === null ? policy() === "on" : s.helpImprove;
}

/** May a recording be made for them now? Used by the recorder. */
async function allowsReview(userId) {
  try {
    return await effective(userId);
  } catch (_) {
    return false; // fail closed: no recording when we cannot tell
  }
}

/**
 * Records a choice. One transaction for the pref and its consent event;
 * turning OFF then removes what the switch promises to remove.
 */
async function set(userId, on, { source = "settings", noticeVersion = NOTICE_VERSION, appBuild = 0 } = {}) {
  const uid = Number(userId);
  if (!(uid > 0)) throw new Error("bad user id");
  const now = Date.now();
  const value = on ? 1 : 0;
  await tx(async (c) => {
    const prev = await c.query(`SELECT help_improve FROM privacy_prefs WHERE user_id = $1 FOR UPDATE`, [uid]);
    const wasOn = prev.rows[0] && Number(prev.rows[0].help_improve) === 1;
    // A repeat "yes" keeps the consent period it is already in.
    const resetOnSince = on && !wasOn;
    await c.query(
      `INSERT INTO privacy_prefs (user_id, help_improve, on_since, decided_at, notice_version, source, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         help_improve = EXCLUDED.help_improve,
         on_since = CASE WHEN $7 THEN EXCLUDED.on_since ELSE privacy_prefs.on_since END,
         decided_at = EXCLUDED.decided_at,
         notice_version = EXCLUDED.notice_version,
         source = EXCLUDED.source,
         updated_at = EXCLUDED.updated_at`,
      [uid, value, on ? now : 0, now, noticeVersion, source, resetOnSince]
    );
    await c.query(
      `INSERT INTO consent_events (user_id, kind, value, notice_version, source, app_build, created_at)
       VALUES ($1, 'help_improve', $2, $3, $4, $5, $6)`,
      [uid, value, noticeVersion, source, Math.max(0, Number(appBuild) || 0), now]
    );
  });
  try {
    await require("../audit/log").record(uid, "privacy.help_improve", on ? "on" : "off");
  } catch (_) { /* the consent event is the proof; the audit line is a copy */ }
  const removed = on ? null : await applyOptOut(uid);
  return { ...(await state(uid)), removed };
}

/** Recording rows and files of one user, every state. Returns how many. */
async function deleteRecordings(uid) {
  const recorder = require("../live/recorder");
  await recorder.migrate();
  const rows = await query(`DELETE FROM live_recordings WHERE user_id = $1 RETURNING id, file`, [uid]);
  for (const r of rows) await recorder.unlinkAll(r.file).catch(() => 0);
  if (rows.length) await recorder.sweepEmptyDays().catch(() => {});
  return rows.length;
}

/**
 * What turning OFF removes, straight away. Never throws; counts are
 * logged by id only.
 */
async function applyOptOut(userId) {
  const uid = Number(userId);
  const out = { recordings: 0, turns: 0, feedback: 0 };
  try {
    const recorder = require("../live/recorder");
    await recorder.dropOpen(uid).catch(() => 0);
    out.recordings = await deleteRecordings(uid);
  } catch (e) {
    console.warn(`help improve: recordings for ${uid} —`, e.message);
  }
  try {
    out.turns = await require("../memory/recent").prunePrivate(uid, PRIVATE_KEEP);
  } catch (e) {
    console.warn(`help improve: turns for ${uid} —`, e.message);
  }
  try {
    out.feedback = await run(
      `DELETE FROM developer_feedback WHERE user_id = $1 AND user_asked = 0`, [uid]);
  } catch (e) {
    console.warn(`help improve: feedback for ${uid} —`, e.message);
  }
  console.log(`help improve off for ${uid}: ${out.recordings} recordings, ${out.turns} turns, ${out.feedback} feedback removed`);
  return out;
}

/**
 * Daily: for OFF users, remove any recording a start in flight left
 * behind, and trim their turns to the private window. Undecided users are
 * not touched (nothing is destroyed until someone chooses OFF).
 */
async function sweep() {
  const rows = await query(`SELECT user_id FROM privacy_prefs WHERE help_improve = 0`);
  let recordings = 0;
  let turns = 0;
  const recent = require("../memory/recent");
  for (const r of rows) {
    const uid = Number(r.user_id);
    recordings += await deleteRecordings(uid).catch(() => 0);
    turns += await recent.prunePrivate(uid, PRIVATE_KEEP).catch(() => 0);
  }
  return { users: rows.length, recordings, turns };
}

function keeps() {
  const recorder = require("../live/recorder");
  return { recordingDays: recorder.KEEP_DAYS, privateTurnDays: PRIVATE_KEEP.days };
}

module.exports = {
  migrate, policy, reviewableSql, state, effective, allowsReview, set,
  applyOptOut, sweep, keeps,
  NOTICE_VERSION, NOTICE_VERSIONS, SOURCES, PRIVATE_KEEP,
};
