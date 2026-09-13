/**
 * A SEARCH ANSWERED ONCE IS ANSWERED FOR EVERYONE.
 * ----------------------------------------------------------------------
 * webSearch already collapses repeats, but only in the process's own
 * memory: every deploy threw the whole cache away (eight times in one
 * morning), and each pod would have had to rebuild it alone. Meanwhile the
 * Gemini search quota is small enough that it rate-limited during ordinary
 * testing.
 *
 * So the cache lives in Postgres, shared by every user and surviving
 * restarts. One person asking for today's headlines answers it for the
 * next person who asks, which is exactly what a shared backend is for.
 *
 * TWO LIFETIMES, because "what is the news" and "who is the president of
 * India" are not the same kind of question:
 *
 *   LIVE      news, prices, weather, scores, timings — 20 minutes.
 *             Long enough to absorb a conversation's repeats and a second
 *             user asking the same thing, short enough that nobody is read
 *             yesterday's headlines.
 *   STABLE    everything else — 24 hours. A fact that was true this
 *             morning is true this evening, and spending quota to
 *             re-confirm it is the waste worth removing.
 *
 * IT FAILS OPEN. Every path here is wrapped: if the table is missing or
 * the database is unreachable, the caller searches as it always did. A
 * cache that can break search is worse than no cache.
 */
const { one, run } = require("../db");

const LIVE_TTL_MS = 20 * 60_000;
const STABLE_TTL_MS = 24 * 60 * 60_000;

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS search_cache (
        shape       TEXT PRIMARY KEY,
        query       TEXT NOT NULL,
        provider    TEXT NOT NULL DEFAULT '',
        payload     TEXT NOT NULL,
        live        INTEGER NOT NULL DEFAULT 0,
        created_at  BIGINT NOT NULL,
        expires_at  BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS search_cache_expiry ON search_cache (expires_at);
    `)
      // One sweep per process, after the table exists. Expiry is already
      // enforced on read, so this is only about not letting the table grow
      // without bound — no cron needed for something this cheap.
      .then(() => {
        run("DELETE FROM search_cache WHERE expires_at <= $1", [Date.now()])
          .catch(() => {});
      })
      .catch((e) => { migrated = null; throw e; });
  }
  return migrated;
}

function ttlFor(isLive) {
  return isLive ? LIVE_TTL_MS : STABLE_TTL_MS;
}

/**
 * A cached answer for this question shape, or null.
 * Never throws — a lookup failure just means "search it".
 */
async function get(shape) {
  if (!shape) return null;
  try {
    await migrate();
    const row = await one(
      "SELECT payload, expires_at FROM search_cache WHERE shape = $1",
      [String(shape)]
    );
    if (!row) return null;
    if (Number(row.expires_at) <= Date.now()) return null; // stale; swept below
    const out = JSON.parse(row.payload);
    // Mark it so the caller can log a hit without guessing.
    return out && typeof out === "object" ? { ...out, cached: true } : null;
  } catch (_) {
    return null;
  }
}

/**
 * Remember an answer. Only successful, non-fallback results are stored:
 * caching "search failed" would turn one provider hiccup into twenty
 * minutes of failure for every user.
 */
async function put(shape, query, out, isLive) {
  if (!shape || !out || out.ok !== true) return;
  if (out.provider === "wikipedia") return; // the last-resort fallback
  try {
    await migrate();
    const now = Date.now();
    const payload = JSON.stringify(out);
    // A single answer should not be able to bloat the table.
    if (payload.length > 200_000) return;
    await run(
      `INSERT INTO search_cache (shape, query, provider, payload, live, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (shape) DO UPDATE SET
         query=$2, provider=$3, payload=$4, live=$5, created_at=$6, expires_at=$7`,
      [String(shape), String(query || "").slice(0, 300), String(out.provider || ""),
       payload, isLive ? 1 : 0, now, now + ttlFor(isLive)]
    );
  } catch (_) {
    /* a cache that cannot write must not break the search */
  }
}

/** Drop what has expired. Cheap, and keeps the table from growing forever. */
async function sweep() {
  try {
    await migrate();
    await run("DELETE FROM search_cache WHERE expires_at <= $1", [Date.now()]);
  } catch (_) {}
}

module.exports = { get, put, sweep, LIVE_TTL_MS, STABLE_TTL_MS, ttlFor };
