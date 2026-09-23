/**
 * The user's UTC offset, in minutes east of UTC (IST = +330).
 *
 * The app sends it as X-TZ-Offset. It was read everywhere as
 * `Number(x) || 330`, which turns a real offset of 0 — anyone on UTC, e.g.
 * in London in winter — into IST, so their "8 am" reminders fired at
 * 2:30. IST stays the default, but only when nothing was sent.
 */
const IST = 330;

function offsetOr(value, fallback = IST) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= 14 * 60 ? n : fallback;
}

const tzFromReq = (req) => offsetOr(req.get?.("X-TZ-Offset"));

module.exports = { IST, offsetOr, tzFromReq };
