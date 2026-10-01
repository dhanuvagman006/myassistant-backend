/**
 * WHAT CAME OF A CALL THE ASSISTANT MADE, TURNED INTO SOMETHING THAT
 * HAPPENS NEXT.
 *
 * The owner, 2026-10-01: "structured call outcomes turned into reminders
 * automatically." When the other person promises something ("I'll pay by
 * Friday"), asks to be called back ("call me after 6"), or leaves
 * something the user must deal with, a reminder is set for the user on
 * that day — the follow-up the user would otherwise forget. Read from the
 * transcript with one model call; nothing is set when the words are
 * vague, and never for a self-call (the user talking to their own
 * assistant).
 */
const chrono = require("chrono-node");
const ai = require("../services/ai/router");

const PROMPT =
  "You read the transcript of a phone call an assistant made FOR its user to another person " +
  "('assistant:' is the caller, 'user:' is the person who was called). Pull out, as STRICT JSON " +
  "and nothing else:\n" +
  '{"promise":"<what the person committed to do, in plain words, or empty>",' +
  '"when":"<their own words for when they will do it, or empty>",' +
  '"callback":"<when they asked to be called back, in their words, or empty>",' +
  '"needs_user":<true when they asked something only the user can answer, else false>,' +
  '"line":"<one short line for the user about what the person said, or empty>"}\n' +
  "Only what the PERSON said counts; never invent a promise or a time. 'Maybe', 'I'll see' is not a promise.";

/** Parse the model's JSON into { promise, when, callback, needsUser, line } or null. */
function parse(reply) {
  try {
    const j = JSON.parse(String(reply || "").replace(/```json|```/g, "").trim());
    const s = (v) => String(v || "").replace(/\s+/g, " ").trim().slice(0, 200);
    return {
      promise: s(j.promise), when: s(j.when), callback: s(j.callback),
      needsUser: j.needs_user === true, line: s(j.line),
    };
  } catch (_) {
    return null;
  }
}

/** "Friday", "after 6", "next week" → a moment, in the user's zone; null when it is not a time. */
function whenToMs(words, { tzOffsetMin = 330, now = Date.now() } = {}) {
  if (!words) return null;
  try {
    const ref = new Date(now + tzOffsetMin * 60_000);
    const d = chrono.parseDate(String(words), ref, { forwardDate: true });
    if (!d) return null;
    const ms = d.getTime() - tzOffsetMin * 60_000;
    // Nothing in the past and nothing absurdly far: both mean the words were not a date.
    if (ms < now - 60_000 || ms > now + 400 * 864e5) return null;
    return ms;
  } catch (_) {
    return null;
  }
}

/**
 * Read the transcript and set the reminders. Returns
 * { line, reminders: [{ id, text, dueAt }] } — `line` is what the
 * assistant adds to its report ("I've set a reminder for Friday").
 */
async function record(rec, { tzOffsetMin = null, now = Date.now() } = {}) {
  const out = { line: "", reminders: [] };
  if (!rec || rec.selfCall || !rec.userId) return out;
  const transcript = String(rec.answer || "");
  if (!/^user\s*:/im.test(transcript)) return out;
  if (tzOffsetMin === null) {
    const u = await require("../db").findById(rec.userId).catch(() => null);
    const tz = Number(u?.tz_offset_min);
    tzOffsetMin = Number.isFinite(tz) && Math.abs(tz) <= 840 ? tz : 330;
  }

  let got;
  try {
    const { reply } = await ai.generateReply(
      [{ role: "user", content: `Called: ${rec.contactName || "them"}. Task: ${String(rec.task || "").slice(0, 300)}\n\n${transcript.slice(0, 3000)}` }],
      { system: PROMPT },
    );
    got = parse(reply);
  } catch (_) {
    return out;
  }
  if (!got) return out;
  rec.outcome = got;

  const reminders = require("../reminders/store");
  const who = rec.contactName || "them";
  const plans = [];
  const dueAt = whenToMs(got.when, { tzOffsetMin, now });
  if (got.promise && dueAt) plans.push({ text: `Follow up: ${who} promised to ${trimVerb(got.promise)}`, dueAt });
  const cbAt = whenToMs(got.callback, { tzOffsetMin, now });
  if (got.callback && cbAt) plans.push({ text: `Call ${who} back — they asked (${got.callback})`, dueAt: cbAt });

  for (const p of plans.slice(0, 2)) {
    try {
      const row = await reminders.create(rec.userId, p.text, p.dueAt, "gentle", { tzOffsetMin });
      if (row) out.reminders.push({ id: row.id, text: p.text, dueAt: p.dueAt });
    } catch (_) { /* a reminder that cannot be saved is reported as not set */ }
  }
  if (out.reminders.length) {
    out.line = out.reminders.length === 1
      ? `I've set a reminder for ${dayWord(out.reminders[0].dueAt, tzOffsetMin, now)} to follow up.`
      : "I've set reminders to follow up.";
  } else if (got.needsUser && got.line) {
    out.line = "They need an answer from you.";
  }
  return out;
}

function trimVerb(s) {
  return String(s || "").replace(/^(he|she|they|i)\s+(will|would|shall|can|is going to|are going to|am going to)\s+/i, "").replace(/^(will|to)\s+/i, "");
}

function dayWord(ms, tzOffsetMin, now) {
  const day = (t) => Math.floor((t + tzOffsetMin * 60_000) / 864e5);
  const diff = day(ms) - day(now);
  if (diff <= 0) return "today";
  if (diff === 1) return "tomorrow";
  const d = new Date(ms + tzOffsetMin * 60_000);
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()] + (diff > 6 ? ` the ${d.getUTCDate()}` : "");
}

module.exports = { record, parse, whenToMs, PROMPT };
