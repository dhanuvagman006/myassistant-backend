/**
 * FREE SLOTS — when is the user actually available?
 *
 * The negotiator has to offer real times on a phone call. Offering a slot
 * the user is already booked into is worse than not offering one at all:
 * the other party accepts, and now there is a double booking that a human
 * has to untangle.
 *
 * So slots come from the user's real calendar, inside working hours, in
 * their local timezone, and always in the future with enough lead time that
 * they are not agreeing to something starting in four minutes.
 *
 * NO CALENDAR LINKED: returns null, not a guess. The tool then asks the
 * user which times to offer rather than inventing availability — the same
 * rule as everywhere else in this codebase.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Working hours in the user's local time. */
const WORK_START_H = Number(process.env.WORK_HOURS_START || 10);
const WORK_END_H = Number(process.env.WORK_HOURS_END || 18);

/** Never offer something starting sooner than this. */
const MIN_LEAD_MS = 2 * 60 * 60 * 1000;

/**
 * @param {number} userId
 * @param {{durationMin?:number, withinDays?:number, tzOffsetMin?:number, count?:number}} opts
 * @returns {Promise<Array<{startMs:number,endMs:number,label:string}>|null>}
 *   null means "no calendar linked" — the caller must ask instead.
 */
async function findSlots(userId, {
  durationMin = 30,
  withinDays = 7,
  tzOffsetMin = 330,
  count = 3,
} = {}) {
  const gapi = require("../google/api");
  let events;
  try {
    events = await gapi.upcomingEvents(userId, { days: withinDays, max: 50 });
  } catch (_) {
    return null;
  }
  if (events === null) return null; // not linked

  // Busy blocks, ignoring all-day entries — an all-day "Leave" should not
  // wipe the week, but a timed meeting genuinely blocks its hours.
  const busy = events
    .filter((e) => !e.allDay && e.start && e.end)
    .map((e) => ({ s: new Date(e.start).getTime(), e: new Date(e.end).getTime() }))
    .filter((b) => Number.isFinite(b.s) && Number.isFinite(b.e))
    .sort((a, b) => a.s - b.s);

  const durMs = Math.max(15, durationMin) * 60 * 1000;
  const now = Date.now();
  const earliest = now + MIN_LEAD_MS;
  const out = [];

  for (let day = 0; day <= withinDays && out.length < count; day++) {
    // Walk the day in the USER's local frame, then convert back to real
    // time. Doing this in UTC would put "10am" in the wrong place entirely.
    const localMidnight =
      Math.floor((now + tzOffsetMin * 60_000 + day * DAY_MS) / DAY_MS) * DAY_MS;
    const dayStartUtc = localMidnight - tzOffsetMin * 60_000;

    const localDow = new Date(localMidnight).getUTCDay();
    if (localDow === 0) continue; // skip Sunday

    let cursor = Math.max(dayStartUtc + WORK_START_H * 3600_000, earliest);
    const dayEnd = dayStartUtc + WORK_END_H * 3600_000;

    while (cursor + durMs <= dayEnd && out.length < count) {
      const slotEnd = cursor + durMs;
      const clash = busy.find((b) => b.s < slotEnd && b.e > cursor);
      if (clash) {
        cursor = clash.e; // jump past the meeting rather than crawling
        continue;
      }
      out.push({
        startMs: cursor,
        endMs: slotEnd,
        label: describe(cursor, tzOffsetMin),
      });
      // Spread the offers out: three slots in one morning is a worse
      // question to be asked on the phone than three across the week.
      cursor += 3 * 3600_000;
    }
  }

  return out;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Spoken form — this gets read aloud on a phone call, so never ISO. */
function describe(ms, tzOffsetMin = 330) {
  const d = new Date(ms + tzOffsetMin * 60_000);
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  const time = m ? `${h}:${String(m).padStart(2, "0")} ${ap}` : `${h} ${ap}`;

  const todayLocal = Math.floor((Date.now() + tzOffsetMin * 60_000) / DAY_MS);
  const slotLocal = Math.floor((ms + tzOffsetMin * 60_000) / DAY_MS);
  const diff = slotLocal - todayLocal;
  const day = diff === 0 ? "today" : diff === 1 ? "tomorrow" : DAYS[d.getUTCDay()];

  return `${day} at ${time}`;
}

module.exports = { findSlots, describe, WORK_START_H, WORK_END_H };
