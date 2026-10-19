/**
 * THE NETWORK OF EACH NUMBER THEY RECHARGE (2026-10-19, owner: "make it
 * ask which network when I haven't said it, and remember it for my number
 * after that").
 *
 * One row per (user, number): the operator they said, and for Vi the
 * circle. Read before asking; written whenever they name one. In
 * routes/privacy.js USER_TABLES, so the account eraser and export cover it.
 */
const { one, run } = require("../db");

async function migrate(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS recharge_numbers (
      user_id    INTEGER NOT NULL,
      number     TEXT    NOT NULL,
      operator   TEXT    NOT NULL,
      circle     TEXT,
      updated_at BIGINT  NOT NULL,
      PRIMARY KEY (user_id, number)
    );
  `);
}

/** { operator, circle } they told us for this number, or null. */
async function get(userId, number) {
  return one(`SELECT operator, circle FROM recharge_numbers WHERE user_id=$1 AND number=$2`, [userId, number]);
}

/** Keep what they said; a circle already known survives a call without one. */
async function set(userId, number, operator, circle = null) {
  await run(
    `INSERT INTO recharge_numbers (user_id, number, operator, circle, updated_at)
          VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, number) DO UPDATE
          SET operator = EXCLUDED.operator,
              circle = CASE WHEN EXCLUDED.operator = recharge_numbers.operator
                            THEN COALESCE(EXCLUDED.circle, recharge_numbers.circle)
                            ELSE EXCLUDED.circle END,
              updated_at = EXCLUDED.updated_at`,
    [userId, number, operator, circle, Date.now()]
  );
}

module.exports = { migrate, get, set };
