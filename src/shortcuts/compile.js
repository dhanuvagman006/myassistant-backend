/**
 * PLAIN STEPS → TOOL CALLS. "put my phone on silent", "directions to 4th
 * floor, MG Road", "WhatsApp my wife I'm leaving".
 *
 * Rules first (quick): the common English phrasings need no model call.
 * Everything else — other languages, and any step that names a person by
 * relation ("my wife", "amma") — goes to ONE model call that sees the
 * user's memory, so "my wife" can become the name memory holds.
 *
 * Then, ONCE, at save time: people are resolved to a contact (an unknown
 * or ambiguous person is asked about, never saved), and a bare place word
 * ("office", "home") is always asked about — an address is never guessed.
 */
const S = require("./steps");

const COMPILE_TIMEOUT_MS = 8_000;
const DAILY_COMPILES = 30;
const counter = new Map(); // uid -> {day, n}

function dayOf(now = Date.now()) {
  return Math.floor((now + 330 * 60_000) / 86_400_000);
}
/** One more model compile for this user today, or false at the limit. */
function takeCompile(userId, now = Date.now()) {
  const d = dayOf(now);
  const c = counter.get(Number(userId));
  const cur = c && c.day === d ? c : { day: d, n: 0 };
  if (cur.n >= DAILY_COMPILES) return false;
  cur.n++;
  counter.set(Number(userId), cur);
  return true;
}

const RELATION = /\b(my\s+)?(wife|husband|hubby|mom|mum|mother|dad|father|amma|appa|achan|acha|papa|mummy|son|daughter|brother|sister|boss|manager|friend|bhai|didi|anna|akka|chechi|chettan|wifey|in-?laws?|uncle|aunty|aunt|grandma|grandpa|family|team)\b/i;
const PLACE_WORD = /^(?:my\s+|the\s+)?(home|house|office|work|workplace|college|school|shop|store|clinic|gym|factory|site|the office)$/i;

function num(s) {
  const n = Number(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

/** "6", "6:30", "6.30 pm", "18:00" → {hour, minute} or null. */
function parseTime(s) {
  const m = String(s || "").trim().toLowerCase().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3] ? m[3][0] : "";
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { hour: h, minute: min };
}

const SCREENS = { momentum: "momentum", "focus timer": "focus", reminders: "reminders", "my reminders": "reminders", documents: "documents", "my documents": "documents" };

/**
 * The rules-first parser: {tool, args, said, when?} or null. English only;
 * a person named by relation is never handled here.
 */
function quick(text) {
  const said = String(text || "").trim();
  const t = said.toLowerCase().replace(/[.!]+$/, "").replace(/\s+/g, " ").trim();
  if (!t || /[^\x00-\x7F]/.test(t)) return null;
  const pc = (action, extra = {}) => ({ tool: "phone_control", args: { action, ...extra }, said });
  let m;

  if (/\b(do not disturb|dnd)\b/.test(t)) return pc(/\boff\b|\bturn off\b|\bdisable\b/.test(t) ? "dnd_off" : "dnd_on");
  if (/\bvibrat(e|ion)\b/.test(t)) return pc("ringer_vibrate");
  if (/\b(silent|silence)\b/.test(t) && !/\bmusic\b/.test(t)) return pc("ringer_silent");
  if (/\b(ringer|sound)\s+(back\s+)?on\b|\bnormal mode\b|\bring(ing)? mode\b/.test(t)) return pc("ringer_normal");
  if (/\b(torch|flash ?light)\b/.test(t)) return pc(/\boff\b/.test(t) ? "flashlight_off" : "flashlight_on");
  if ((m = t.match(/\bvolume\b.*?\b(\d{1,3})\s*%?/))) {
    const v = Math.max(0, Math.min(100, Number(m[1])));
    return pc("volume_set", { value: v });
  }
  if (/\b(pause|stop)\b.*\b(music|song|songs)\b/.test(t)) return pc("media_pause");

  if ((m = t.match(/^(?:give me |get |show me |start )?(?:directions|navigate|navigation|route|drive)(?: me)? to (.+)$/))) {
    return { tool: "start_navigation", args: { destination: said.slice(said.length - m[1].length).trim() }, said };
  }
  // "WhatsApp Ravi: I'm leaving", "WhatsApp Ravi that I'm leaving", "message Ravi on WhatsApp saying …"
  if ((m = said.match(/^(?:send (?:a )?)?whats ?app(?: message)?(?: to)? ([^:]+?)(?::|\s+that\s+|\s+saying\s+|\s*,\s*)(.+)$/i)) ||
      (m = said.match(/^(?:send (?:a )?)?message (?:to )?([^:]+?) on whats ?app(?::|\s+that\s+|\s+saying\s+|\s*,\s*)(.+)$/i))) {
    const who = m[1].trim();
    if (RELATION.test(who)) return null;
    return { tool: "send_whatsapp_message", args: { to: who, message: m[2].trim() }, said };
  }
  if ((m = t.match(/^(?:set (?:an |the )?)?alarm (?:at|for) (.+)$/)) || (m = t.match(/^wake me (?:up )?at (.+)$/))) {
    const at = parseTime(m[1]);
    return at ? { tool: "set_alarm", args: at, said } : null;
  }
  if ((m = t.match(/^(?:set |start )?(?:a )?(?:timer (?:for )?(\d{1,3}) ?(?:min|mins|minutes)|(\d{1,3}) ?(?:min|mins|minute|minutes) timer)$/))) {
    return { tool: "set_timer", args: { minutes: num(m[1] || m[2]) }, said };
  }
  if ((m = t.match(/^remind me in (\d{1,4}) ?(?:min|mins|minutes) (?:to |about )?(.+)$/))) {
    return { tool: "create_reminder", args: { text: m[2] }, when: { in_minutes: Number(m[1]) }, said };
  }
  if ((m = t.match(/^remind me at ([0-9:. apm]+?) (?:to |about )(.+)$/))) {
    const at = parseTime(m[1]);
    if (!at) return null;
    const hh = String(at.hour).padStart(2, "0");
    const mm = String(at.minute).padStart(2, "0");
    return { tool: "create_reminder", args: { text: m[2] }, when: { at: `${hh}:${mm}` }, said };
  }
  if (/^(?:tell me |what'?s |check )?(?:the )?weather(?: today)?$/.test(t)) return { tool: "get_weather", args: {}, said };
  if (/^(?:read |tell me |give me )?(?:the )?(?:headlines|news)(?: today)?$/.test(t)) return { tool: "get_news", args: {}, said };
  if (/^(?:read |give me |tell me )?(?:my )?(?:daily |morning )?brief(?:ing)?$/.test(t)) return { tool: "daily_brief", args: {}, said };
  if ((m = t.match(/^open (.+)$/))) {
    const what = m[1].replace(/\s+app$/, "").trim();
    if (SCREENS[what]) return { tool: "open_app_screen", args: { screen: SCREENS[what] }, said };
    return { tool: "open_named_app", args: { app: said.slice(5).replace(/\s+app$/i, "").trim() }, said };
  }
  if ((m = t.match(/^play (.+)$/))) {
    return { tool: "play_music", args: { query: said.slice(5).trim() }, said };
  }
  return null;
}

const SUBMIT_STEPS = {
  name: "submit_steps",
  description: "Submit one tool call for each numbered step, or refuse a step with a reason.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            n: { type: "integer", description: "The step number you were given." },
            tool: { type: "string", description: "Exact tool name from the list." },
            args_json: { type: "string", description: 'The arguments as a JSON object string, e.g. {"action":"ringer_silent"}.' },
            needs: { type: "string", description: "'person' when the step names someone by relation and memory does not say who." },
          },
        },
      },
      refuse: {
        type: "array",
        items: {
          type: "object",
          properties: { n: { type: "integer" }, why: { type: "string" } },
        },
      },
    },
  },
};

function compilePrompt(catalogue, memory) {
  return (
    "You turn the numbered steps of a user's saved shortcut into tool calls. " +
    "CALL submit_steps EXACTLY ONCE; never reply with text.\n\n" +
    "RULES\n" +
    "- One tool call per step, from the list below only, spelled exactly.\n" +
    "- Never translate, shorten or rewrite a message the user dictated: copy it byte for byte.\n" +
    "- People: a relation word (my wife, amma, my boss) becomes that person's NAME from what you " +
    "remember below. If memory does not say who it is, keep their words and set needs:\"person\".\n" +
    "- Places: keep exactly the place the user said. NEVER choose an address from memory.\n" +
    "- Money, payments, calls to businesses, deleting and changing settings about the user must be " +
    "refused (refuse: {n, why}).\n" +
    "- Silent phone = phone_control action ringer_silent; vibrate = ringer_vibrate; do not disturb = dnd_on.\n\n" +
    "TOOLS:\n" + catalogue + (memory || "")
  );
}

/** The model path for the steps quick() could not read. */
async function viaModel(userId, items, ctx = {}) {
  if (!items.length) return { ok: true, steps: [] };
  if (!takeCompile(userId)) return { ok: false, error: "compile_limit", data: { max: DAILY_COMPILES } };
  const registry = require("../tools/registry");
  const planner = require("../agents/planner");
  const decls = registry.declarations({ userId, deviceCaps: ctx.deviceCaps || null, only: S.STEP_TOOL_NAMES });
  const memory = await require("../agents/memory").memoryBlock(userId).catch(() => "");
  const router = require("../services/ai/router");
  let out;
  try {
    out = await Promise.race([
      router.generateWithTools({
        contents: [{ role: "user", parts: [{ text: items.map((it) => `${it.n}. ${it.text}`).join("\n") }] }],
        system: compilePrompt(planner.catalogueFor(decls), memory),
        declarations: [SUBMIT_STEPS],
        timeoutMs: COMPILE_TIMEOUT_MS,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("compile timed out")), COMPILE_TIMEOUT_MS)),
    ]);
  } catch (e) {
    return { ok: false, error: "compile_failed", data: { n: items[0].n, said: items[0].text } };
  }
  const call = ((out && out.functionCalls) || []).find((c) => c.name === "submit_steps");
  if (!call) return { ok: false, error: "compile_failed", data: { n: items[0].n, said: items[0].text } };
  const refused = Array.isArray(call.args.refuse) ? call.args.refuse : [];
  for (const r of refused) {
    const it = items.find((x) => x.n === Number(r.n));
    if (it) return { ok: false, error: "step_not_allowed", data: { n: it.n, said: it.text, why: String(r.why || "that can't be part of a shortcut").slice(0, 120) } };
  }
  const got = Array.isArray(call.args.steps) ? call.args.steps : [];
  const steps = [];
  for (const it of items) {
    const s = got.find((x) => Number(x.n) === it.n);
    if (!s) return { ok: false, error: "compile_failed", data: { n: it.n, said: it.text } };
    const args = planner.parseArgs(s.args_json);
    if (args === null) return { ok: false, error: "compile_failed", data: { n: it.n, said: it.text } };
    const tool = String(s.tool || "");
    if (!S.STEP_TOOLS[tool]) {
      return { ok: false, error: registry.get(tool) ? "step_not_allowed" : "compile_failed",
        data: { n: it.n, said: it.text, ...(registry.get(tool) ? { why: S.whyNot(tool) } : {}) } };
    }
    if (s.needs === "person") {
      return { ok: false, error: "needs_detail", data: { n: it.n, said: it.text, question: "Who should the message go to? Say their name as it is in your contacts." } };
    }
    steps.push({ n: it.n, tool, args, said: it.text });
  }
  return { ok: true, steps };
}

/**
 * Resolve people and places once. A step is never saved with a person we
 * could not find, or a bare place word standing in for an address.
 */
async function resolvePeopleAndPlaces(userId, steps) {
  const { resolveContact } = require("../users/resolve");
  for (const st of steps) {
    const a = st.args || {};
    if (st.tool === "start_navigation" && PLACE_WORD.test(String(a.destination || "").trim())) {
      const place = String(a.destination).trim().replace(/^(my|the)\s+/i, "");
      return { ok: false, error: "needs_detail", data: { n: st.n, said: st.said, question: `What's the address for ${place}?` } };
    }
    const personKey = st.tool === "send_whatsapp_message" && !a.is_group ? "to"
      : st.tool === "send_agent_message" ? "contact_name" : null;
    if (!personKey) continue;
    const who = String(a[personKey] || "").trim();
    const ask = { ok: false, error: "needs_detail", data: { n: st.n, said: st.said, question: "Who should the message go to? Say their name as it is in your contacts." } };
    if (!who || RELATION.test(who)) return ask;
    const { match, candidates } = await resolveContact(userId, who).catch(() => ({ match: null, candidates: [] }));
    if (!match && candidates.length > 1) {
      return { ok: false, error: "needs_detail", data: { n: st.n, said: st.said, question: `Which ${who} — ${candidates.slice(0, 3).map((c) => c.name).join(" or ")}?` } };
    }
    if (!match) return ask;
    a[personKey] = match.name;
  }
  return { ok: true, steps };
}

/**
 * Plain step texts → validated, ordered steps.
 * Returns {ok, steps, reordered, warnings} | {ok:false, error, data}.
 */
async function compile(userId, texts, ctx = {}) {
  const list = (Array.isArray(texts) ? texts : []).map((x) => String(x || "").trim()).filter(Boolean);
  if (!list.length) return { ok: false, error: "no_steps", data: {} };
  if (list.length > S.MAX_STEPS) return { ok: false, error: "too_many_steps", data: { max: S.MAX_STEPS } };
  for (let i = 0; i < list.length; i++) {
    if (list[i].length > S.MAX_STEP_TEXT) return { ok: false, error: "step_too_long", data: { n: i + 1, max: S.MAX_STEP_TEXT } };
  }
  const done = [];
  const rest = [];
  list.forEach((text, i) => {
    const q = quick(text);
    if (q) done.push({ n: i + 1, ...q });
    else rest.push({ n: i + 1, text });
  });
  const m = await viaModel(userId, rest, ctx);
  if (!m.ok) return m;
  const steps = [...done, ...m.steps].sort((a, b) => a.n - b.n);
  const people = await resolvePeopleAndPlaces(userId, steps);
  if (!people.ok) return people;
  const v = S.validate(steps, { build: Number(ctx.appBuild) || 0 });
  return v;
}

module.exports = {
  quick, compile, viaModel, resolvePeopleAndPlaces, parseTime, takeCompile, SUBMIT_STEPS,
  RELATION, PLACE_WORD, DAILY_COMPILES, _resetCounter: () => counter.clear(),
};
