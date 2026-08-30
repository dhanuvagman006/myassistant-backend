/**
 * SCREEN-TIME STORE (behind appAuth) — the server half of usage tracking.
 *
 * POST /usage { days: [{date: "YYYY-MM-DD", apps: [{package,name,minutes}]}] }
 *
 * The phone pushes today + yesterday whenever the app opens (Usage access
 * permitting); rows are upserted so an incomplete "today" is corrected by
 * tomorrow's sync. The agent's get_app_usage tool and the morning brief
 * read from here — the server never talks to the handset for this.
 */
const router = require("express").Router();
const { run, query } = require("../db");

let migrated = false;
async function ensureTable() {
  if (migrated) return;
  await run(`
    CREATE TABLE IF NOT EXISTS app_usage_daily (
      user_id  BIGINT NOT NULL,
      day      TEXT   NOT NULL,
      package  TEXT   NOT NULL,
      app_name TEXT   NOT NULL DEFAULT '',
      minutes  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day, package)
    )`);
  migrated = true;
}

router.post("/", async (req, res) => {
  const uid = Number(req.user?.sub);
  if (!Number.isInteger(uid) || uid <= 0) {
    return res.status(401).json({ error: "sign in" });
  }
  await ensureTable();
  const days = Array.isArray(req.body?.days) ? req.body.days.slice(0, 7) : [];
  let saved = 0;
  for (const d of days) {
    const day = String(d?.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const apps = Array.isArray(d.apps) ? d.apps.slice(0, 40) : [];
    for (const a of apps) {
      const pkg = String(a?.package || "").slice(0, 200);
      const minutes = Math.max(0, Math.min(1440, Number(a?.minutes) || 0));
      if (!pkg || minutes < 1) continue;
      await run(
        `INSERT INTO app_usage_daily (user_id, day, package, app_name, minutes)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, day, package)
         DO UPDATE SET minutes = EXCLUDED.minutes, app_name = EXCLUDED.app_name`,
        [uid, day, pkg, String(a?.name || pkg).slice(0, 120), minutes]
      ).catch(() => {});
      saved++;
    }
  }
  res.json({ ok: true, saved });
});

/** Read helper shared by the tool and the brief. */
async function usageOf(uid, { days = 7 } = {}) {
  await ensureTable();
  return query(
    `SELECT day, app_name, package, minutes FROM app_usage_daily
      WHERE user_id = $1 AND day >= to_char(now() - ($2 || ' days')::interval, 'YYYY-MM-DD')
      ORDER BY day DESC, minutes DESC`,
    [uid, String(days)]
  ).catch(() => []);
}

module.exports = { router, usageOf };
