/**
 * FARE WATCH — "tell me when the Delhi flight drops below twelve thousand."
 *
 * The user names a route, a date and a price they'd be happy with. The
 * proactive sweep re-prices it periodically and pushes the moment it is
 * met, or when the fare falls meaningfully below what it was when they
 * asked.
 *
 * WHY A THRESHOLD *AND* A DROP
 * ---------------------------
 * A target price alone is useless if the user guessed too low — the watch
 * never fires and they conclude the feature is broken. A drop alone is
 * noisy: fares wobble by a few rupees constantly. So a watch fires on
 * either the stated target being met, or a drop of at least MIN_DROP_PCT
 * from the best price seen so far, and then it goes quiet — one alert per
 * improvement, never a stream.
 *
 * COST: each check is one flight search per watch. Watches are capped per
 * user and expire on their travel date, so this cannot quietly grow into a
 * large recurring API bill.
 */
const { query, one, run } = require("../db");
const flights = require("../tools/flights");

const MAX_WATCHES_PER_USER = 5;
const MIN_DROP_PCT = 7; // below this, it's noise, not news

async function migrate(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS fare_watches (
      id           BIGSERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      origin       TEXT NOT NULL,          -- IATA
      destination  TEXT NOT NULL,          -- IATA
      depart_date  TEXT NOT NULL,          -- YYYY-MM-DD
      adults       INTEGER NOT NULL DEFAULT 1,
      -- What they'd be happy to pay, in rupees. NULL = just tell me if it drops.
      target_price NUMERIC,
      -- Best price seen so far, so we alert on improvement rather than on
      -- every wobble.
      best_price   NUMERIC,
      last_price   NUMERIC,
      last_checked BIGINT,
      last_alerted BIGINT,
      status       TEXT NOT NULL DEFAULT 'active',  -- active | hit | expired | cancelled
      created_at   BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fare_watches_active
      ON fare_watches(status, last_checked);
    CREATE INDEX IF NOT EXISTS idx_fare_watches_user
      ON fare_watches(user_id, status);
  `);
}

/* ------------------------------------------------------------------ */

async function create(userId, { origin, destination, departDate, adults = 1, targetPrice = null }) {
  const active = await one(
    `SELECT COUNT(*)::int AS n FROM fare_watches WHERE user_id=$1 AND status='active'`,
    [userId]
  ).catch(() => ({ n: 0 }));
  if ((active?.n || 0) >= MAX_WATCHES_PER_USER) {
    return { ok: false, error: `you already have ${MAX_WATCHES_PER_USER} fare watches running — cancel one first` };
  }

  const row = await one(
    `INSERT INTO fare_watches
       (user_id, origin, destination, depart_date, adults, target_price, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [userId, origin, destination, departDate, adults, targetPrice, Date.now()]
  );
  return { ok: true, id: Number(row.id) };
}

async function list(userId) {
  return query(
    `SELECT * FROM fare_watches WHERE user_id=$1 AND status='active' ORDER BY id DESC`,
    [userId]
  );
}

async function cancel(userId, id) {
  return run(
    `UPDATE fare_watches SET status='cancelled' WHERE user_id=$1 AND id=$2`,
    [userId, Number(id)]
  );
}

/** Cheapest fare from a search result, in rupees. */
function cheapest(list) {
  let best = null;
  for (const f of list || []) {
    // "INR 8452.00" — take the number, ignore the currency label. A
    // non-INR result is skipped rather than compared against a rupee
    // target, which would be nonsense.
    const m = String(f.price || "").match(/^([A-Z]{3})\s*([\d.]+)$/);
    if (!m || m[1] !== "INR") continue;
    const v = Number(m[2]);
    if (Number.isFinite(v) && (best === null || v < best.price)) {
      best = { price: v, flight: f };
    }
  }
  return best;
}

/**
 * One sweep. Re-prices watches that are due a check and alerts on a real
 * improvement.
 *
 * @returns {Promise<{checked:number, alerts:number}>}
 */
async function sweep({ staleMs = 6 * 60 * 60 * 1000, limit = 20 } = {}) {
  if (!flights.provider()) return { checked: 0, alerts: 0 };

  const today = new Date().toISOString().slice(0, 10);
  // Retire watches whose travel date has passed — otherwise they are
  // re-priced forever for a flight that has already left.
  await run(
    `UPDATE fare_watches SET status='expired'
      WHERE status='active' AND depart_date < $1`,
    [today]
  ).catch(() => {});

  const due = await query(
    `SELECT w.*, u.fcm_token
       FROM fare_watches w JOIN users u ON u.id = w.user_id
      WHERE w.status='active'
        AND (w.last_checked IS NULL OR w.last_checked < $1)
      ORDER BY w.last_checked NULLS FIRST LIMIT $2`,
    [Date.now() - staleMs, limit]
  ).catch(() => []);

  let checked = 0, alerts = 0;
  for (const w of due) {
    const res = await flights.search({
      from: w.origin, to: w.destination, date: w.depart_date, adults: w.adults,
    });
    checked++;
    await run(`UPDATE fare_watches SET last_checked=$2 WHERE id=$1`, [w.id, Date.now()]);
    if (!res.ok) continue;

    const best = cheapest(res.data);
    if (!best) continue;

    const prevBest = w.best_price === null ? null : Number(w.best_price);
    const target = w.target_price === null ? null : Number(w.target_price);

    const hitTarget = target !== null && best.price <= target;
    const bigDrop =
      prevBest !== null && best.price < prevBest * (1 - MIN_DROP_PCT / 100);

    await run(
      `UPDATE fare_watches
          SET last_price=$2,
              best_price = CASE WHEN best_price IS NULL OR $2 < best_price THEN $2 ELSE best_price END
        WHERE id=$1`,
      [w.id, best.price]
    );

    if (!hitTarget && !bigDrop) continue;
    if (!w.fcm_token) continue;

    try {
      const amt = best.price.toLocaleString("en-IN");
      await require("../services/push").sendNotification(
        w.fcm_token,
        hitTarget
          ? `₹${amt} — your ${w.origin}→${w.destination} target is met`
          : `${w.origin}→${w.destination} dropped to ₹${amt}`,
        `${best.flight.flight} on ${w.depart_date}, ${best.flight.stops === 0 ? "non-stop" : best.flight.stops + " stop"}.`
      );
      alerts++;
      await run(
        `UPDATE fare_watches SET last_alerted=$2, status=$3 WHERE id=$1`,
        [w.id, Date.now(), hitTarget ? "hit" : "active"]
      );
    } catch (_) {}
  }

  return { checked, alerts };
}

module.exports = { migrate, create, list, cancel, sweep, cheapest, MAX_WATCHES_PER_USER, MIN_DROP_PCT };
