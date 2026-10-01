/**
 * DEVELOPER FEEDBACK — what the assistant tells the developer about the
 * app: bugs, missing features, complaints, ideas. Written by the
 * send_developer_feedback tool, read in the admin panel under Feedback.
 *
 * Two guards, because the writer is a model: the same summary from the
 * same user within a day is one row, not ten, and no user can file more
 * than DAILY_CAP a day — a loop must never bury the real reports.
 */
const db = require("../db");

const KINDS = new Set(["bug", "feature", "complaint", "improvement", "praise"]);
const STATUSES = new Set(["new", "seen", "done"]);
const DAILY_CAP = 30;
const DAY = 24 * 3600 * 1000;

const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

async function add(userId, fb = {}) {
  const summary = clip(fb.summary, 300);
  if (!summary) return { ok: false, error: "summary required" };
  const kind = KINDS.has(fb.kind) ? fb.kind : "improvement";
  const since = Date.now() - DAY;

  const dup = await db.one(
    `SELECT id FROM developer_feedback
      WHERE user_id=$1 AND created_at > $2 AND lower(summary) = lower($3)
      LIMIT 1`,
    [userId, since, summary]
  );
  if (dup) return { ok: true, id: dup.id, duplicate: true };

  const today = await db.one(
    `SELECT count(*)::int AS n FROM developer_feedback
      WHERE user_id=$1 AND created_at > $2`,
    [userId, since]
  );
  if ((today?.n || 0) >= DAILY_CAP) {
    return { ok: false, error: "daily feedback limit reached" };
  }

  const row = await db.one(
    `INSERT INTO developer_feedback
       (user_id, kind, summary, details, user_words, source, app_build, created_at, user_asked)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [userId, kind, summary, clip(fb.details, 2000), clip(fb.userWords, 500),
     clip(fb.source || "assistant", 20), Number(fb.appBuild) || 0, Date.now(),
     fb.userAsked ? 1 : 0]
  );
  return { ok: true, id: row.id, duplicate: false };
}

/**
 * OPS ALERTS — something the SERVER noticed, filed in the same list.
 *
 * On 2026-09-24 every call the assistant placed failed all day with the
 * calling service answering "from_number … doesn't exist for <provider>",
 * and nothing anywhere said so: the owner found out by trying. A broken
 * dashboard setting is the developer's to fix, so it belongs in front of
 * the developer — in the Feedback list they already read, not in a new
 * screen nobody opens.
 *
 * No user filed it, so user_id is 0 (the panel shows "—") and source is
 * "ops". The same summary is ONE row per hour, checked in the table so it
 * holds across pods and restarts: an outage that fails every call must
 * show up, and must not bury the real reports under hundreds of copies.
 * It is not counted against anyone's daily cap.
 */
const ALERT_WINDOW = 3600 * 1000;

async function alert(summary, { details = "", windowMs = ALERT_WINDOW } = {}) {
  const s = clip(summary, 300);
  if (!s) return { ok: false, error: "summary required" };
  const dup = await db.one(
    `SELECT id FROM developer_feedback
      WHERE user_id=0 AND source='ops' AND created_at > $1 AND lower(summary) = lower($2)
      LIMIT 1`,
    [Date.now() - windowMs, s]
  );
  if (dup) return { ok: true, id: dup.id, duplicate: true };
  const row = await db.one(
    `INSERT INTO developer_feedback
       (user_id, kind, summary, details, user_words, source, app_build, created_at)
     VALUES (0, 'alert', $1, $2, '', 'ops', 0, $3) RETURNING id`,
    [s, clip(details, 2000), Date.now()]
  );
  return { ok: true, id: row.id, duplicate: false };
}

async function list({ status = "", q = "", limit = 50, offset = 0 } = {}) {
  // A row is shown when the user asked for it to be passed on, when it is
  // an ops alert, or when they said yes to "Help improve" (it was filed
  // quietly after that).
  const where = [`(f.user_id = 0 OR f.user_asked = 1 OR ${
    require("../users/helpImprove").reviewableSql("f.user_id", "f.created_at")})`];
  const params = [];
  if (STATUSES.has(status)) {
    params.push(status);
    where.push(`f.status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(f.summary ILIKE $${params.length} OR f.details ILIKE $${params.length})`);
  }
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  params.push(Math.max(Number(offset) || 0, 0));
  return db.query(
    `SELECT f.id, f.user_id, f.kind, f.summary, f.details, f.user_words,
            f.source, f.app_build, f.status, f.created_at, f.resolved_build, f.resolved_note,
            u.name, u.email
       FROM developer_feedback f LEFT JOIN users u ON u.id = f.user_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY f.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
}

async function counts() {
  const rows = await db.query(
    `SELECT status, count(*)::int AS n FROM developer_feedback GROUP BY status`);
  const out = { new: 0, seen: 0, done: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

async function setStatus(id, status) {
  if (!STATUSES.has(status)) return false;
  return (await db.run(
    `UPDATE developer_feedback SET status=$1 WHERE id=$2`, [status, Number(id)])) > 0;
}

/** Handled: which update carried it and a line for the person who asked. */
async function resolve(id, { build = 0, note = "" } = {}) {
  const n = await db.run(
    `UPDATE developer_feedback SET status='done', resolved_build=$1, resolved_note=$2 WHERE id=$3`,
    [Number(build) || 0, clip(note, 300), Number(id)]);
  if (!n) return null;
  return db.one(`SELECT * FROM developer_feedback WHERE id=$1`, [Number(id)]);
}

/**
 * Tell the person who asked that their request shipped — once. The push
 * is the whole loop from their side: they said it to the assistant, and
 * the assistant's developer answered.
 */
async function notifyResolved(row) {
  // BIGINT comes back as a string: "0" is truthy, so compare as a number.
  if (!row || !row.user_id || Number(row.notified_at) > 0) return false;
  const user = await db.findById(row.user_id).catch(() => null);
  if (!user?.fcm_token) return false;
  // The inbox runs as its own process: make sure push is set up there too.
  try { require("../services/push").init(); } catch (_) { /* reported by send */ }
  const body = [
    row.resolved_build ? `It's in update ${row.resolved_build}.` : "It's done.",
    row.resolved_note,
  ].filter(Boolean).join(" ").slice(0, 180);
  const ok = await require("../services/push").sendNotification(
    user.fcm_token, `You asked: ${clip(row.summary, 60)}`, body,
    { kind: "feedback_done", id: String(row.id) }).catch(() => false);
  if (ok) await db.run(`UPDATE developer_feedback SET notified_at=$1 WHERE id=$2`, [Date.now(), row.id]);
  return Boolean(ok);
}

async function get(id) {
  return db.one(`SELECT * FROM developer_feedback WHERE id=$1`, [Number(id)]);
}

/** What one person asked for, newest first — for "what happened to my request?". */
async function forUser(userId, limit = 10) {
  return db.query(
    `SELECT id, kind, summary, status, resolved_build, resolved_note, created_at
       FROM developer_feedback WHERE user_id=$1 ORDER BY id DESC LIMIT $2`,
    [Number(userId), Math.min(Math.max(Number(limit) || 10, 1), 50)]);
}

module.exports = { add, alert, list, counts, setStatus, resolve, notifyResolved, forUser, get, KINDS, DAILY_CAP, ALERT_WINDOW };
