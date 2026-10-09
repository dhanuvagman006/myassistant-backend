/**
 * SELF-CHECKS FROM THE PHONES (2026-10-09). Owner: "run a check … on users
 * phone … so that we can get exactly what went wrong instead of us
 * guessing".
 *
 * The app runs a fixed list of checks (server, sign-in, clock,
 * permissions, app and device) and posts them with its recent log. It
 * does so when the admin asks (GET /diagnostics/pending says run), after
 * a voice turn went wrong, or from its Diagnostics screen. The admin
 * panel shows them per user (admin_web.js); the log is shown only where
 * Help improve allows, like every other user text there.
 *
 *   POST /diagnostics          the report            (app)
 *   GET  /diagnostics/pending  { run }               (app)
 */

const express = require("express");
const db = require("../db");

const KEEP_PER_USER = 50;

async function migrate(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS diag_reports (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      created_at BIGINT  NOT NULL,
      ran_at     BIGINT  NOT NULL DEFAULT 0,
      trigger    TEXT    NOT NULL DEFAULT '',
      failed     INTEGER NOT NULL DEFAULT 0,
      checks     TEXT    NOT NULL DEFAULT '[]',
      log        TEXT    NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS diag_reports_user ON diag_reports (user_id, created_at);
    CREATE TABLE IF NOT EXISTS diag_requests (
      user_id      INTEGER PRIMARY KEY,
      requested_at BIGINT NOT NULL,
      done_at      BIGINT NOT NULL DEFAULT 0
    );
  `);
}

const clip = (s, n) => String(s == null ? "" : s).slice(0, n);

/** The checks as the app sent them, cleaned: name, ok (true/false/null), detail. */
function cleanChecks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 40).map((c) => ({
    name: clip(c && c.name, 60),
    ok: c && typeof c.ok === "boolean" ? c.ok : null,
    detail: clip(c && c.detail, 400),
  })).filter((c) => c.name);
}

async function save(userId, body = {}) {
  const checks = cleanChecks(body.checks);
  const failed = checks.filter((c) => c.ok === false).length;
  const now = Date.now();
  await db.query(
    `INSERT INTO diag_reports (user_id, created_at, ran_at, trigger, failed, checks, log)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [userId, now, Number(body.at) > 0 ? Number(body.at) : now,
      clip(body.trigger, 80) + (body.late ? " (sent late)" : ""), failed,
      JSON.stringify(checks), clip(body.log, 60000)]
  );
  await db.query(`UPDATE diag_requests SET done_at = $2 WHERE user_id = $1 AND done_at = 0`, [userId, now]);
  // A phone that reports every few minutes must not fill the table.
  await db.query(
    `DELETE FROM diag_reports WHERE user_id = $1 AND id NOT IN
       (SELECT id FROM diag_reports WHERE user_id = $1 ORDER BY id DESC LIMIT ${KEEP_PER_USER})`,
    [userId]
  );
  return { ok: true, failed };
}

async function pending(userId) {
  const r = await db.query(
    `SELECT requested_at FROM diag_requests WHERE user_id = $1 AND done_at = 0 AND requested_at > $2`,
    [userId, Date.now() - 3 * 86400000]
  );
  return r.length > 0;
}

async function request(userId) {
  await db.query(
    `INSERT INTO diag_requests (user_id, requested_at, done_at) VALUES ($1,$2,0)
     ON CONFLICT (user_id) DO UPDATE SET requested_at = $2, done_at = 0`,
    [userId, Date.now()]
  );
  return { ok: true };
}

const router = express.Router();
const uidOf = (req) => Number(req.user && req.user.sub);

router.post("/", express.json({ limit: "200kb" }), async (req, res) => {
  const uid = uidOf(req);
  if (!(uid > 0)) return res.status(401).json({ error: "sign in" });
  try {
    res.json(await save(uid, req.body || {}));
  } catch (e) {
    console.warn("diagnostics: save failed:", e.message);
    res.status(503).json({ error: "unavailable" });
  }
});

router.get("/pending", async (req, res) => {
  const uid = uidOf(req);
  if (!(uid > 0)) return res.status(401).json({ error: "sign in" });
  try {
    res.json({ run: await pending(uid) });
  } catch (e) {
    res.json({ run: false });
  }
});

module.exports = { migrate, save, pending, request, cleanChecks, router };
