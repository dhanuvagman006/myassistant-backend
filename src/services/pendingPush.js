/**
 * PENDING PUSHES — notifications that could not be delivered YET.
 * ----------------------------------------------------------------
 * A phone's FCM token dies whenever the app is reinstalled — which our
 * own self-update does on every release. For a few minutes after an
 * update the stored token is dead, and anything sent in that window used
 * to vanish: the admin panel simply reported a failure and the message
 * was gone.
 *
 * Now a failed send is parked here and flushed the moment that user's
 * device registers a token again (see users/context.js). "Failed"
 * becomes "delivered a little later".
 */
const { query, one, run } = require("../db");

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS pending_pushes (
        id         BIGSERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT NOT NULL,
        data       TEXT NOT NULL DEFAULT '{}',
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_push_user ON pending_pushes(user_id, id);
    `).catch((e) => {
      console.error("pending_pushes migration failed:", e.message);
      migrated = null;
    });
  }
  return migrated;
}

const MAX_PER_USER = 10;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** Park a notification for a user whose device is unreachable right now. */
async function queue(userId, title, body, data = {}) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) return null;
  await migrate();
  const row = await one(
    `INSERT INTO pending_pushes (user_id, title, body, data, created_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [uid, String(title || "").slice(0, 200), String(body || "").slice(0, 500),
     JSON.stringify(data || {}), Date.now()]
  );
  // Keep the queue short: a person coming back after a week should not be
  // buried under every announcement they missed.
  await run(
    `DELETE FROM pending_pushes WHERE user_id = $1 AND id NOT IN
       (SELECT id FROM pending_pushes WHERE user_id = $1 ORDER BY id DESC LIMIT $2)`,
    [uid, MAX_PER_USER]
  );
  return row;
}

/**
 * Deliver everything parked for this user, newest last so they read in
 * order. Anything that fails again stays queued; anything older than a
 * week is dropped rather than delivered as stale news.
 */
async function flush(userId) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) return 0;
  await migrate();
  const rows = await query(
    "SELECT * FROM pending_pushes WHERE user_id = $1 ORDER BY id ASC", [uid]
  );
  if (!rows.length) return 0;
  const push = require("./push");
  const db = require("../db");
  const u = await db.one("SELECT fcm_token FROM users WHERE id = $1", [uid]);
  if (!u?.fcm_token) return 0;
  let delivered = 0;
  for (const r of rows) {
    if (Date.now() - Number(r.created_at) > MAX_AGE_MS) {
      await run("DELETE FROM pending_pushes WHERE id = $1", [r.id]);
      continue;
    }
    let data = {};
    try { data = JSON.parse(r.data || "{}"); } catch (_) {}
    const out = await push.send(u.fcm_token, r.title, r.body, data);
    if (out.ok) {
      delivered++;
      await run("DELETE FROM pending_pushes WHERE id = $1", [r.id]);
    } else {
      // Still unreachable (a token that is minutes old is not active at
      // Google yet). Leave it queued for the next registration.
      break;
    }
  }
  if (delivered) console.log(`pending push: delivered ${delivered} to user ${uid}`);
  return delivered;
}

/** How many are waiting — the admin panel shows this per user. */
async function countFor(userId) {
  await migrate();
  const r = await one(
    "SELECT COUNT(*)::int AS n FROM pending_pushes WHERE user_id = $1",
    [Number(userId)]
  );
  return r?.n || 0;
}

module.exports = { queue, flush, countFor };
