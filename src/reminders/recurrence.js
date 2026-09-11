/**
 * RECURRENCE — one definition of "when does this happen next".
 *
 * Scheduled tasks have rolled themselves forward since they were built;
 * reminders could not repeat at all. Rather than write the month-end
 * arithmetic twice and let the two drift, both now call this.
 *
 * The awkward case is monthly. Naively adding a month to the 31st gives
 * 3 March, and every subsequent month is then wrong. The ANCHOR day is
 * carried separately and clamped per month, so the 31st becomes 28
 * February and then 31 March again.
 */
const REPEATS = new Set(["daily", "weekly", "monthly", "yearly"]);

function normalize(repeat) {
  const r = String(repeat || "").toLowerCase().trim();
  if (REPEATS.has(r)) return r;
  if (/^every ?day$|^daily$/.test(r)) return "daily";
  if (/^every ?week$|^weekly$/.test(r)) return "weekly";
  if (/^every ?month$|^monthly$/.test(r)) return "monthly";
  if (/^every ?year$|^yearly$|^annual/.test(r)) return "yearly";
  return "";
}

/** The occurrence after `fromMs`. Returns 0 when it does not repeat. */
function nextOccurrence(fromMs, repeat, { tzOffsetMin = 330, anchorDay = 0 } = {}) {
  const from = Number(fromMs);
  const r = normalize(repeat);
  if (!Number.isFinite(from) || !r) return 0;
  if (r === "daily") return from + 86_400_000;
  if (r === "weekly") return from + 7 * 86_400_000;

  // Month and year arithmetic happens in the USER'S local frame, or a
  // reminder set for 9 am drifts by the timezone offset every month.
  const tz = Number.isFinite(tzOffsetMin) ? tzOffsetMin : 330;
  const local = new Date(from + tz * 60_000);
  const anchor = Number(anchorDay) || local.getUTCDate();
  const target = new Date(local);
  target.setUTCDate(1); // never roll over while changing the month
  if (r === "yearly") target.setUTCFullYear(target.getUTCFullYear() + 1);
  else target.setUTCMonth(target.getUTCMonth() + 1);
  const daysInMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(anchor, daysInMonth));
  return target.getTime() - tz * 60_000;
}

/**
 * Advance past every occurrence already gone. A phone that was off for a
 * week must not come back to seven identical overdue reminders — it
 * should show the next one.
 */
function advanceTo(nowMs, fromMs, repeat, opts = {}) {
  let next = nextOccurrence(fromMs, repeat, opts);
  if (!next) return 0;
  let guard = 0;
  while (next <= nowMs && guard++ < 500) {
    const step = nextOccurrence(next, repeat, opts);
    if (!step || step <= next) break;
    next = step;
  }
  return next;
}

/** The day-of-month a monthly/yearly series is anchored to. */
function anchorDayOf(ms, tzOffsetMin = 330) {
  const tz = Number.isFinite(tzOffsetMin) ? tzOffsetMin : 330;
  return new Date(Number(ms) + tz * 60_000).getUTCDate();
}

module.exports = { nextOccurrence, advanceTo, normalize, anchorDayOf, REPEATS };
