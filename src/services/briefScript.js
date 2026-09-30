/**
 * "PLAY MY MORNING" (2026-09-30) — the Today brief as 45–75 seconds of
 * speech the phone reads aloud in the assistant's own voice.
 *
 *   factsOf()     the brief (services/brief.js) cut down to what is worth
 *                 saying, in the user's local time, plus the missed calls
 *                 the phone sends (the server never sees the call log).
 *   offerOf()     the ONE helpful offer the script ends with, chosen by
 *                 plain rules so the app can put the same offer on a
 *                 button ("Prepare me", "Draft wishes").
 *   template()    the script written by code — always correct, a little
 *                 plain. Used whenever the model is off, slow or wrong.
 *   scriptFor()   one short Gemini text call turns the facts into warm
 *                 speech. The answer is checked before it is used: no
 *                 number that is not in the facts, never the user's name,
 *                 the title (Sir / Ma'am) once, the offer at the end. Any
 *                 doubt and the template is used instead — a brief that
 *                 invents a meeting is worse than no brief.
 *
 * Kill switches: BRIEF_SCRIPT_AI=off (template only), BRIEF_SCRIPT_MODEL,
 * BRIEF_SCRIPT_TIMEOUT_MS (6000), BRIEF_SCRIPT_CACHE_MIN (30; 0 = off).
 */
const crypto = require("crypto");

const WORDS_PER_SEC = 2.5; // an unhurried reading voice

function aiOn() {
  return String(process.env.BRIEF_SCRIPT_AI || "on").toLowerCase() !== "off";
}

function timeoutMs() {
  const n = Number(process.env.BRIEF_SCRIPT_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.min(n, 20_000) : 6000;
}

function cacheMs() {
  const raw = process.env.BRIEF_SCRIPT_CACHE_MIN;
  const n = raw === undefined || raw === "" ? 30 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 240) * 60_000 : 30 * 60_000;
}

/* ------------------------------------------------------------------ *
 * WORDS
 * ------------------------------------------------------------------ */

/** "10:30 am" / "4 pm" in the user's local time. */
function clock(ms, tz) {
  const d = new Date(ms + tz * 60_000);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}

function partOf(now, tz) {
  const h = new Date(now + tz * 60_000).getUTCHours();
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}

const GREETING = { morning: "Good morning", afternoon: "Good afternoon", evening: "Good evening" };
const TITLE = { morning: "Your morning", afternoon: "Your day", evening: "Your evening" };
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clean(s, max = 120) {
  return String(s || "")
    .replace(/[\u0000-\u001f<>{}\[\]`*_#|~]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** "A, B and C". */
function list(xs) {
  const a = xs.filter(Boolean);
  if (a.length <= 1) return a[0] || "";
  return `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
}

/** "Send the quote" → "send the quote"; "UPS invoice" stays. */
const lower = (s) => (/^\p{Lu}\p{Ll}/u.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

const times = (n) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/** A caller the phone could not name is not read out digit by digit. */
function callerName(name) {
  const n = clean(name, 40);
  return /\p{L}/u.test(n) ? n : "";
}

/* ------------------------------------------------------------------ *
 * FACTS
 * ------------------------------------------------------------------ */

/**
 * What the script may say, and nothing else.
 * @param {object} b      buildBrief() output
 * @param {object} opts   { now, tzOffsetMin, address ("Sir"|"Ma'am"), missedCalls }
 */
function factsOf(b, { now = Date.now(), tzOffsetMin = 330, address = "Sir", missedCalls = [] } = {}) {
  const tz = tzOffsetMin;
  const part = partOf(now, tz);
  const agenda = Array.isArray(b?.agenda) ? b.agenda : [];
  const soon = now - 15 * 60_000;

  const meetings = agenda
    .filter((a) => a.kind === "meeting" && Number.isFinite(a.at) && a.at >= soon)
    .slice(0, 4)
    .map((a) => ({
      title: clean(a.name || String(a.title || "").split(" · ")[0], 80) || "a meeting",
      place: clean(a.place || "", 40),
      time: clock(a.at, tz),
      eventId: a.event_id || null,
    }));
  const reminders = agenda
    .filter((a) => a.kind === "reminder" && (!Number.isFinite(a.at) || a.at >= soon))
    .slice(0, 4)
    .map((a) => ({ title: clean(a.title, 90), time: Number.isFinite(a.at) ? clock(a.at, tz) : null }));
  const earlier = agenda
    .filter((a) => a.kind === "reminder" && Number.isFinite(a.at) && a.at < soon)
    .slice(0, 2)
    .map((a) => ({ title: clean(a.title, 90) }));

  const calls = new Map();
  for (const c of Array.isArray(missedCalls) ? missedCalls.slice(0, 8) : []) {
    const name = callerName(c && c.name);
    const key = name || "an unsaved number";
    calls.set(key, (calls.get(key) || 0) + Math.max(1, Math.min(9, Number(c && c.count) || 1)));
  }

  const promises = (Array.isArray(b?.promises) ? b.promises : [])
    .filter((p) => p.due_label === "overdue" || p.due_label === "due today" || !p.due_at)
    .slice(0, 3)
    .map((p) => {
      const to = clean(p.owed_to || "", 40);
      let text = String(p.text || "");
      if (to && text.startsWith(`To ${to}: `)) text = text.slice(`To ${to}: `.length);
      return { text: clean(text, 110), to, due: p.due_label || null };
    });

  const dates = Array.isArray(b?.dates) ? b.dates : [];
  const birthdays = dates
    .filter((d) => d.kind === "birthday")
    .slice(0, 3)
    .map((d) => ({ person: clean(d.person, 40), title: clean(d.title, 80), when: d.when === "tomorrow" ? "tomorrow" : "today" }));
  const bills = dates
    .filter((d) => d.kind === "payment")
    .slice(0, 3)
    .map((d) => {
      const [name, amount] = String(d.title || "").split(" · ");
      return { name: clean(name, 60) || "A payment", amount: amount ? clean(amount, 20) : null,
        when: d.when === "tomorrow" ? "tomorrow" : "today" };
    });

  const tomorrow = (Array.isArray(b?.tomorrow) ? b.tomorrow : [])
    .filter((a) => Number.isFinite(a.at))
    .slice(0, 3)
    .map((a) => ({
      title: clean(a.kind === "meeting" ? a.name || String(a.title || "").split(" · ")[0] : a.title, 80),
      time: clock(a.at, tz),
      kind: a.kind === "meeting" ? "meeting" : "reminder",
    }));

  const messages = Array.isArray(b?.messages) ? b.messages : [];
  const local = new Date(now + tz * 60_000);

  const facts = {
    part,
    greeting: GREETING[part],
    address: address === "Ma'am" ? "Ma'am" : "Sir",
    day: WEEKDAY[local.getUTCDay()],
    meetings,
    reminders,
    earlier,
    missedCalls: [...calls].slice(0, 3).map(([name, count]) => ({ name, count })),
    promises,
    birthdays,
    bills,
    weatherNow: weatherNow(b?.weather_line),
    weatherNote: b?.weather_note?.text ? clean(b.weather_note.text, 80) : null,
    weatherKind: b?.weather_note?.kind || null,
    messages: messages.length ? { count: messages.length, from: clean(messages[0].from || "", 40) } : null,
    tomorrow,
  };
  facts.offer = offerOf(facts);
  return facts;
}

/** "Cloudy · 24°C" → "cloudy and 24 degrees". */
function weatherNow(line) {
  const m = String(line || "").match(/^(.*?)\s*·\s*(-?\d+)°C$/);
  if (!m) return null;
  return `${m[1].trim().toLowerCase()} and ${m[2]} degrees`;
}

/**
 * THE ONE OFFER, by rules — the app shows the same one on a button.
 *   kind 'meeting_prep'  → opens Meeting Prep (meetingId when known)
 *   kind 'ask'           → the request goes to the assistant as a turn
 *   kind 'talk'          → opens the mic
 */
function offerOf(f) {
  const next = f.meetings[0];
  if (next && f.part !== "evening") {
    return {
      kind: "meeting_prep",
      say: `Would you like me to prepare you for your ${next.time} meeting?`,
      label: "Prepare me",
      request: `Prepare me for my ${next.time} meeting, "${next.title}".`,
      meetingId: next.eventId || null,
    };
  }
  const bday = f.birthdays.find((d) => d.when === "today" && d.person);
  if (bday) {
    return {
      kind: "ask",
      say: `Shall I draft a wish for ${bday.person}?`,
      label: "Draft wishes",
      request: `Help me wish ${bday.person}: it is ${bday.title} today. Draft a warm message and ask me before sending it.`,
    };
  }
  const owed = f.promises.find((p) => p.to && (p.due === "overdue" || p.due === "due today"));
  if (owed) {
    return {
      kind: "ask",
      say: `Shall I help you with what you promised ${owed.to}?`,
      label: "Help me",
      request: `Help me with something I promised ${owed.to}: "${owed.text}". Draft what I need, and ask me before sending anything.`,
    };
  }
  const caller = f.missedCalls.find((c) => c.name !== "an unsaved number");
  if (caller) {
    return {
      kind: "ask",
      say: `Shall I call ${caller.name} back?`,
      label: "Call back",
      request: `Call ${caller.name} back.`,
    };
  }
  if (f.part === "evening") {
    return {
      kind: "talk",
      say: "Is there anything you would like me to set up for tomorrow?",
      label: "Talk to me",
      request: "",
    };
  }
  return {
    kind: "talk",
    say: "Is there anything you would like me to remind you about today?",
    label: "Talk to me",
    request: "",
  };
}

/* ------------------------------------------------------------------ *
 * THE TEMPLATE — code, never wrong
 * ------------------------------------------------------------------ */

function template(f) {
  const out = [];
  out.push(`${f.greeting}, ${f.address}. Here is your ${f.day}${f.part === "evening" ? " evening" : ""}.`);

  const evening = f.part === "evening";
  if (f.meetings.length === 1) {
    const m = f.meetings[0];
    out.push(`You have one meeting: ${m.title} at ${m.time}${m.place ? `, at ${m.place}` : ""}.`);
  } else if (f.meetings.length > 1) {
    const [first, ...rest] = f.meetings;
    out.push(
      `You have ${f.meetings.length} meetings. The first is ${first.title} at ${first.time}, ` +
        `then ${list(rest.map((m) => `${m.title} at ${m.time}`))}.`
    );
  }
  const timed = f.reminders.filter((r) => r.time);
  const anytime = f.reminders.filter((r) => !r.time);
  if (timed.length || anytime.length) {
    const bits = [...timed.map((r) => `${r.title} at ${r.time}`), ...anytime.map((r) => r.title)].slice(0, 3);
    out.push(`On your list: ${list(bits)}.`);
  }
  if (f.earlier.length) out.push(`Still open from earlier: ${list(f.earlier.map((r) => r.title))}.`);
  if (!f.meetings.length && !f.reminders.length) {
    out.push(evening ? "Nothing more is planned for today." : "Your calendar is clear today.");
  }

  if (f.missedCalls.length) {
    out.push(`You missed calls from ${list(f.missedCalls.map((c) => (c.count > 1 ? `${c.name}, ${times(c.count)}` : c.name)))}.`);
  }
  for (const p of f.promises.slice(0, 2)) {
    const due = p.due === "overdue" ? " It is overdue." : p.due === "due today" ? " It is due today." : "";
    const what = lower(p.text.replace(/^to\s+/i, "").replace(/[.\s]+$/, ""));
    out.push(p.to ? `You promised ${p.to}: ${what}.${due}` : `You promised to ${what}.${due}`);
  }
  for (const d of f.birthdays) out.push(d.when === "today" ? `It is ${d.title} today.` : `Tomorrow is ${d.title}.`);
  for (const bill of f.bills) {
    out.push(bill.amount ? `${bill.name}, ${bill.amount}, is due ${bill.when}.` : `${bill.name} is due ${bill.when}.`);
  }

  if (f.weatherNote) {
    const tail = f.weatherKind === "rain" ? ", so keep an umbrella handy" : f.weatherKind === "heat" ? ", so drink plenty of water" : "";
    out.push(`${f.weatherNote}${tail}.`);
  } else if (f.weatherNow) {
    out.push(`Right now it is ${f.weatherNow}.`);
  }
  if (f.messages) {
    out.push(
      f.messages.count === 1
        ? `You have one unread message, from ${f.messages.from || "someone"}.`
        : `You have ${f.messages.count} unread messages; the latest is from ${f.messages.from || "someone"}.`
    );
  }
  if (evening && f.tomorrow.length) {
    out.push(`Tomorrow starts with ${list(f.tomorrow.map((t) => `${t.title} at ${t.time}`))}.`);
  }
  out.push(f.offer.say);
  return out.join(" ").replace(/\.\./g, ".").replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ *
 * THE MODEL, CHECKED
 * ------------------------------------------------------------------ */

const SYSTEM = [
  "You write a short spoken daily brief that a personal assistant reads aloud to its owner",
  "through text-to-speech. Use ONLY the facts in the JSON. Never add a meeting, person, time,",
  "amount, place, reason or detail that is not there, and never guess what a meeting is about.",
  "",
  "LENGTH: 110 to 180 words when there is enough to say; shorter when the day is light — never pad.",
  'OPEN with exactly one greeting: "<greeting>, <address>." (for example "Good morning, Sir.").',
  "Never use the address again and never use the owner's name.",
  "ORDER: today's meetings and reminders in time order; anything still open from earlier; missed",
  "calls; promises owed; birthdays and bills; the weather; unread messages (count and who only).",
  "In the evening say briefly what is left today, then tomorrow's first things.",
  "STYLE: warm, calm, plain sentences like a trusted secretary. No lists, headings, markdown,",
  "emojis or stage directions. Times as written in the facts.",
  "END with the offer in `offer`, word for word, as the last sentence.",
  'Reply as JSON: {"script": string}',
].join("\n");

/** Digit groups in [s] ("10:30" → 10, 30; "₹12,000" → 12000). */
function numbersIn(s) {
  return (String(s || "").replace(/(\d),(?=\d{3}\b)/g, "$1").match(/\d+/g) || []).map((n) => String(Number(n)));
}

function words(s) {
  return String(s || "").trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Why the model's script cannot be used, or null when it can.
 * @param {string} script
 * @param {object} f        the facts it was written from
 * @param {string} [name]   the owner's first name (must never be said)
 */
function problemWith(script, f, name) {
  const s = String(script || "").trim();
  if (!s) return "empty";
  const n = words(s);
  if (n < 12 || n > 230) return `length ${n} words`;
  const allowed = new Set(numbersIn(JSON.stringify(f)));
  const stray = numbersIn(s).filter((x) => !allowed.has(x));
  if (stray.length) return `numbers not in the facts: ${stray.join(", ")}`;
  if (name && name.length >= 2 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(s)) {
    return "said the owner's name";
  }
  const titles = (s.match(/\b(sir|ma'am|madam)\b/gi) || []).length;
  if (titles > 2) return "the title on every line";
  if (/[*#_`<>{}\[\]]/.test(s)) return "markup";
  return null;
}

/** The offer is the last sentence, whatever the model did with it. */
function withOffer(script, offer) {
  const s = String(script || "").trim();
  if (!offer || !offer.say) return s;
  if (s.toLowerCase().includes(offer.say.toLowerCase())) return s;
  return `${s.replace(/[\s.]*$/, ".")} ${offer.say}`;
}

function parseScript(reply) {
  const txt = String(reply || "").replace(/```json|```/g, "").trim();
  try {
    const j = JSON.parse(txt);
    return typeof j.script === "string" ? j.script : "";
  } catch (_) {
    return "";
  }
}

/** Sentences for the captions ("Dr." and "10.30" do not end one). */
function sentencesOf(script) {
  return String(script || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“'‘₹])/)
    .map((x) => x.trim())
    .filter(Boolean);
}

async function modelScript(f) {
  const router = require("./ai/router");
  const model = router.envModel("BRIEF_SCRIPT_MODEL", "gemini-flash-lite-latest");
  const { reply } = await router.generateReply(
    [{ role: "user", content: JSON.stringify(f) }],
    { system: SYSTEM, json: true, model, modelEnv: "BRIEF_SCRIPT_MODEL",
      timeoutMs: timeoutMs(), noRetry: true, thinking: "MINIMAL" }
  );
  return parseScript(reply);
}

/* ------------------------------------------------------------------ *
 * THE ENTRY POINT
 * ------------------------------------------------------------------ */

const cache = new Map(); // uid -> { key, at, out }

function keyOf(f) {
  return crypto.createHash("sha1").update(JSON.stringify(f)).digest("hex");
}

/**
 * The spoken brief for this user now.
 * @param {number} uid
 * @param {object} brief   buildBrief() output (with .name and .address)
 * @param {object} opts    { now, tzOffsetMin, missedCalls }
 * @returns {Promise<{part,title,greeting,script,sentences,seconds,offer,source,empty}>}
 */
async function scriptFor(uid, brief, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const f = factsOf(brief, {
    now,
    tzOffsetMin: Number.isFinite(opts.tzOffsetMin) ? opts.tzOffsetMin : 330,
    address: brief?.address,
    missedCalls: opts.missedCalls,
  });
  const key = keyOf(f);
  const ttl = cacheMs();
  const hit = ttl > 0 && cache.get(uid);
  if (hit && hit.key === key && now - hit.at < ttl) return hit.out;

  let script = "";
  let source = "template";
  if (aiOn()) {
    try {
      const raw = await modelScript(f);
      const said = withOffer(raw, f.offer);
      const why = !raw.trim()
        ? "no script"
        : !said.slice(0, 80).toLowerCase().includes(f.greeting.toLowerCase())
          ? "no greeting"
          : problemWith(said, f, brief?.name);
      if (!why) {
        script = said;
        source = "ai";
      } else {
        console.warn(`briefScript: the template instead — ${why}`);
      }
    } catch (e) {
      console.warn("briefScript: the template instead —", String(e.message || e).slice(0, 120));
    }
  }
  if (!script) script = template(f);

  const empty =
    !f.meetings.length && !f.reminders.length && !f.earlier.length && !f.missedCalls.length &&
    !f.promises.length && !f.birthdays.length && !f.bills.length && !f.messages;
  const out = {
    part: f.part,
    title: TITLE[f.part],
    greeting: `${f.greeting}, ${f.address}.`,
    script,
    sentences: sentencesOf(script),
    seconds: Math.max(5, Math.round(words(script) / WORDS_PER_SEC)),
    offer: f.offer,
    source,
    empty,
  };
  if (ttl > 0) {
    cache.set(uid, { key, at: now, out });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
  }
  return out;
}

/** Missed calls as the app sends them: [{name, count}], at most eight. */
function missedFromBody(body) {
  const raw = body && Array.isArray(body.missedCalls) ? body.missedCalls : [];
  return raw
    .slice(0, 8)
    .filter((c) => c && typeof c === "object")
    .map((c) => ({ name: String(c.name || "").slice(0, 60), count: Number(c.count) || 1 }));
}

module.exports = {
  scriptFor, factsOf, offerOf, template, problemWith, withOffer, sentencesOf, parseScript,
  missedFromBody, partOf, clock, SYSTEM,
  _cache: cache,
};
