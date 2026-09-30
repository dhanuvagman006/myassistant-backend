/**
 * THE SPOKEN MORNING AND MEETING PREP, BY VOICE (2026-09-30).
 *
 *   play_daily_brief   "play my morning", "what's my day", "brief me" —
 *                      the phone fetches GET /brief/script (with its missed
 *                      calls) and reads it in the assistant's voice, with a
 *                      now-playing strip and captions:
 *                        deviceAction { type: 'play_brief', part }
 *                      The tool is only the trigger, so it answers at once;
 *                      the script is written on the phone's fetch.
 *   prepare_meeting    "prepare me for my next meeting", "brief me for the
 *                      3 pm", "what should I know before meeting Ravi" —
 *                      meetings/prep.js gathers what is known and the
 *                      phone opens the Meeting Prep sheet:
 *                        deviceAction { type: 'open_meeting_prep', prep }
 *
 * App builds before BRIEF_TOOLS_MIN_BUILD (default 135) have neither
 * screen: these tools are not offered to them, and daily_brief still
 * answers "what's my day" in words.
 */

function minBuild() {
  const n = Number(process.env.BRIEF_TOOLS_MIN_BUILD);
  return Number.isInteger(n) && n > 0 ? n : 135;
}

function uidOf(ctx) {
  const uid = Number(ctx && ctx.userId);
  return Number.isInteger(uid) && uid > 0 ? uid : null;
}

function tzOf(ctx) {
  const n = Number(ctx && ctx.tzOffsetMin);
  return Number.isFinite(n) && Math.abs(n) <= 14 * 60 ? n : 330;
}

async function runPlayDailyBrief(_args, ctx) {
  if (!uidOf(ctx)) return { ok: false, error: "not signed in" };
  const { partOf } = require("../services/briefScript");
  const part = partOf(Date.now(), tzOf(ctx));
  const word = part === "afternoon" ? "day" : part;
  return {
    ok: true,
    speak: `Here's your ${word}.`,
    data: { playing: true, part },
    note:
      "The phone is now reading the user's brief aloud in your voice, with captions. Reply with " +
      `at most a few words, like "Here's your ${word}." Do NOT read, list or summarise the brief ` +
      "yourself, and do not say you are playing anything.",
    deviceAction: { type: "play_brief", part },
  };
}

async function runPrepareMeeting(args, ctx) {
  const uid = uidOf(ctx);
  if (!uid) return { ok: false, error: "not signed in" };
  const prep = require("./prep");
  const meetingId = typeof args?.meetingId === "string" && args.meetingId.trim()
    ? args.meetingId.trim().slice(0, 200) : null;
  const p = await prep.prepare(uid, { meetingId, tzOffsetMin: tzOf(ctx) });
  if (!p.meeting) {
    return {
      ok: true,
      speak: meetingId
        ? "I couldn't find that meeting in the next 24 hours."
        : "You have no meetings in the next 24 hours.",
      data: { meeting: null },
    };
  }
  return {
    ok: true,
    speak: prep.speakOf(p),
    data: {
      meeting: { title: p.meeting.title, when: p.meeting.whenText, place: p.meeting.location },
      summary: p.summary,
      people: p.people.map((x) => x.name),
      talkingPoints: p.talkingPoints,
      asks: p.asks,
      known: p.known,
    },
    note:
      "The prep is on the user's screen. Say the meeting, the summary and at most two talking points " +
      "in two or three short sentences — do not read everything. Say plainly when little is known. " +
      "If they want a reminder before it, create_reminder can set one.",
    deviceAction: { type: "open_meeting_prep", prep: p },
    // Email snippets and an invite's agenda are other people's words.
    ...(p.untrusted ? { untrusted: true } : {}),
  };
}

function registerBriefMeetingTools(registry) {
  registry.register({
    name: "play_daily_brief",
    minAppBuild: minBuild(),
    deviceAction: true,
    risk: "low",
    timeoutMs: 10_000,
    description:
      "READ THE USER'S DAY ALOUD — 'play my morning', 'play my brief', 'what's my day', 'what's my " +
      "day look like', 'brief me', 'good morning, what do I have today', 'read me my day'. The " +
      "phone plays a one-minute spoken brief (meetings, reminders, missed calls, promises, " +
      "birthdays, bills, weather) with captions. PREFER THIS over daily_brief when they want to " +
      "hear their day; use daily_brief only for a specific question about it ('any meetings " +
      "after lunch?').",
    inputSchema: { type: "object", properties: {} },
    execute: runPlayDailyBrief,
  });

  registry.register({
    name: "prepare_meeting",
    minAppBuild: minBuild(),
    deviceAction: true,
    risk: "low",
    timeoutMs: 25_000,
    description:
      "PREPARE THE USER FOR A MEETING — 'prepare me for my next meeting', 'prep me for the 3 pm', " +
      "'what should I know before I meet Ravi', 'brief me for this meeting', 'who is in my next " +
      "meeting'. Gathers the event, who is in it (matched to their people records), notes and " +
      "summaries from earlier meetings with them, open promises either way and recent emails, and " +
      "shows a prep card with talking points. Without meetingId it takes the next meeting in the " +
      "coming 24 hours.",
    inputSchema: {
      type: "object",
      properties: {
        meetingId: {
          type: "string",
          description: "Only when a specific calendar event id is known; otherwise leave it out.",
        },
      },
    },
    execute: runPrepareMeeting,
  });
}

module.exports = { registerBriefMeetingTools, runPlayDailyBrief, runPrepareMeeting, minBuild };
