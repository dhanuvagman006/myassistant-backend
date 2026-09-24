/**
 * A CLEAR PHONE TASK, RECOGNISED WITHOUT A MODEL.
 *
 * "Order veg biryani from a 4-star place on Swiggy" is not a question to
 * think about — it is a job for do_task_in_app. Left to the voice model,
 * the same typed words once got a location-permission excuse and an offer
 * about developer feedback (2026-09-24). So a typed request that names a
 * known app and asks for something to be DONE there goes straight to the
 * task engine, the same way every time.
 *
 * Deliberately narrow: it only fires when a KNOWN app is named (or a web
 * form link is given) together with a doing-word. Plain "open X" keeps its
 * own flow; "install X" / "download X" go to open_named_app with
 * install: true (the owner's words are the permission to install);
 * reminders, calls and messages never match. Anything else is left to the
 * model exactly as before.
 */
const prefs = require("./prefs");

const DOING =
  /\b(?:order|book|buy|add|put|search|find|look for|look up|apply|register|fill|check|compare|reorder|track|get me|get|follow|unfollow|like|subscribe|play|watch|save|open)\b/i;
// "open <any app> and <do something>" — the app need not be one we know;
// the phone finds it by name.
const OPEN_AND =
  /^\s*(?:(?:please|kindly|hey)\s+|(?:can|could|would) you\s+)*open\s+(?:the\s+|my\s+)?([a-z0-9][a-z0-9 .&'-]{1,30}?)(?:\s+app)?\s*,?\s+(?:and|then|&)\s+(\S.{2,})$/i;
// Kept on their own flows: WhatsApp messages (the draft flow), and money.
const NOT_HERE = /\b(?:whats ?app|g ?pay|google pay|phone ?pe|paytm|bhim|cred|bank|upi|wallet)\b/i;
const ONLY_OPEN =
  /^\s*(?:please\s+)?(?:install|download|open|launch|start)\s+(?:the\s+)?[a-z0-9]+(?:\s+app)?\s*[.!]?\s*$/i;
const FORM = /\b(?:fill|apply|register|submit|sign me up)\b/i;
// "uninstall Instagram", "delete the Candy Crush app", "get rid of
// Snapchat". "uninstall" always means an app; delete / remove / get rid of
// only when the thing is an app we know or is called an app — "delete my
// 5 pm meeting" and "remove that reminder" are not apps.
const UNINSTALL =
  /^\s*(?:(?:please|kindly|hey|now)\s+|(?:can|could|would) you\s+)*(uninstall|delete|remove|get rid of)\s+(?:the\s+|my\s+|this\s+)?([a-z0-9][a-z0-9 .&'+-]{0,30}?)(\s+app(?:lication)?)?(?:\s+(?:from|on|off) (?:my|the) phone)?\s*(?:please)?\s*[.!]?\s*$/i;
// "install Zomato", "download the Instagram app", "get swiggy": the
// owner's own words are the permission to install (open_named_app with
// install: true — the phone opens the app if it is already there). "get"
// is a common word, so it counts only for an app we know or one called
// an app; "download my bank statement" is not an app either.
const INSTALL =
  /^\s*(?:(?:please|kindly|hey|now)\s+|(?:can|could|would) you\s+)*(install|download|reinstall)\s+(?:the\s+|me\s+)?([a-z0-9][a-z0-9 .&'+-]{0,30}?)(\s+app(?:lication)?)?(?:\s+(?:for me|on my phone|from the (?:play ?store|app store)))?\s*(?:please)?\s*[.!]?\s*$/i;
// Inside a longer task ("install Instagram and follow Virat"): the app the
// owner's words ask to install. "get" is left out here — "get me a
// biryani" is no install — and so is anything that is not an app:
// "download my Swiggy invoice", "download the ticket PDF".
const INSTALL_IN =
  /\b(?:install|download|reinstall)\s+(?:the\s+|me\s+|an?\s+)?([a-z0-9][a-z0-9 .&'+-]{0,30}?)(\s+app(?:lication)?)?(?=\s*$|\s*[,.!?;&]|\s+(?:and|then|also|plus|to|for|on|from|so|in|with|now|please)\b)/i;
// Two jobs in one breath ("uninstall Instagram and install Snapchat") are
// left to the model, which splits them — read as one app name, the
// second half was silently dropped (2026-09-24).
const COMPOUND = /\b(?:and|then|also|plus)\b|&/i;
// "play arijit on spotify", "watch mrbeast on youtube": ONE jump with
// play_music (a /watch link that starts playing, or the music app's own
// play-from-search), about 1-2 s. The task engine took four or more
// looks for the same song — 12-40 s — and promised to "stop before any
// payment" for it (audit, 2026-09-24).
const PLAY =
  /^\s*(?:(?:please|kindly|hey)\s+|(?:can|could|would) you\s+)*(?:play|put on|watch)\s+(.+?)\s+(?:on|in)\s+(?:the\s+)?(youtube music|yt music|youtube|spotify)(?:\s+app)?\s*(?:please|for me)?\s*[.!]?\s*$/i;
// The owner's own library is inside the app, not a search: "play my liked
// songs on Spotify" stays with the engine, which opens it there.
const LIBRARY =
  /\b(?:my|liked|likes|playlists?|library|downloads?|downloaded|saved|favou?rites?|episodes?|watch later|subscriptions?|recently played|watch history)\b/i;
// The tools a SPOKEN request may be steered between (contract §3).
const ROUTABLE = new Set(["do_task_in_app", "open_named_app", "uninstall_app", "order_food", "open_app"]);
// Not an answer to the task's question: the owner calling it off. The
// WHOLE message must be the stop — "cancel my 5 pm meeting" and "stop the
// music", typed while a task waited, used to end the task and never reach
// the model (review, 2026-09-24).
const STOP =
  /^\s*(?:(?:no|ok|okay|please)[,\s]+)*(?:stop|cancel|never ?mind|forget (?:it|about it)|leave it|don'?t bother)(?:\s+(?:it|that|this|(?:the|that|this)\s+(?:task|order)))?(?:[,\s]+please)?\s*[.!]*\s*$/i;
// The phone's own notes to the live model that carry no [SYSTEM] tag: the
// greeting it asks for at every session start, and the camera's reading
// handed back ("I pointed the camera and the image shows: …"). They are
// the app talking, never the owner — not a request, and never the answer
// to a waiting task (a greeting was once stored as the owner's address).
const APP_NOTE = /^\s*(?:\[SYSTEM\]|say this(?: greeting)? to me now\b|i pointed the camera\b|i looked at it and saw\b)/i;

function categoryOf(app) {
  for (const [cat, apps] of Object.entries(prefs.CATEGORIES)) {
    if (apps.includes(app)) return cat;
  }
  return "other";
}

/**
 * For a clear phone task: { goal, app?, url?, category } for the task
 * engine (tool do_task_in_app), or { tool: "uninstall_app" |
 * "open_named_app" | "play_music", args } — else null.
 */
function match(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 300) return null;
  // The app's own notes to the assistant ("[SYSTEM] The task … needs one
  // answer", the camera's reading of a sign) quote other words — they are
  // never a new request.
  if (/\[SYSTEM\]/i.test(t) || APP_NOTE.test(t)) return null;
  const rm = t.match(UNINSTALL);
  if (rm) {
    const said = rm[2].trim();
    if (COMPOUND.test(said)) return null;
    // The WHOLE thing must be the app: "delete my WhatsApp messages" names
    // WhatsApp but deletes messages.
    const known = prefs.appNamedIn(said);
    const whole = known && known === said.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (/^uninstall$/i.test(rm[1]) || rm[3] || whole) {
      return { tool: "uninstall_app", args: { app: said }, goal: t };
    }
  }
  const inst = t.match(INSTALL);
  if (inst && !COMPOUND.test(inst[2])) {
    const said = inst[2].trim();
    const known = prefs.appNamedIn(said);
    const whole = known && known === said.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (whole || inst[3]) {
      return { tool: "open_named_app", args: { app: said, install: true }, goal: t };
    }
  }
  const url = t.match(/https?:\/\/\S+/i);
  if (url && FORM.test(t)) return { goal: t, url: url[0].replace(/[).,]+$/, ""), category: "web" };
  const play = t.match(PLAY);
  // A second job in the same breath ("… and like it") is the engine's.
  if (play && !LIBRARY.test(play[1]) &&
      !/\b(?:and|then)\s+(?:follow|like|subscribe|add|save|share|download|comment)\b/i.test(play[1])) {
    const where = play[2].toLowerCase();
    const provider = /music/.test(where) ? "youtube_music" : where;
    const app = provider === "spotify" ? "spotify" : "youtube";
    return {
      tool: "play_music", args: { query: play[1].trim(), provider }, goal: t, app,
      // Where there is no play_music on this server, the engine plays it
      // the long way, exactly as before.
      engine: { goal: t, app, category: categoryOf(app) },
    };
  }
  if (NOT_HERE.test(t)) return null;
  const open = t.match(OPEN_AND);
  if (open) {
    const said = open[1].trim().toLowerCase();
    const known = prefs.appNamedIn(said);
    return { goal: t, app: known || said, category: known ? categoryOf(known) : "other" };
  }
  const app = prefs.appNamedIn(t);
  if (!app || ONLY_OPEN.test(t)) return null;
  const openAnd = /\bopen\s+(?:the\s+)?\w+(?:\s+app)?\s+(?:and|then)\b/i.test(t);
  if (!DOING.test(t) && !openAnd) return null;
  return { goal: t, app, category: categoryOf(app) };
}

/**
 * The app a task's own words ask to install, or "" (then nothing is
 * installed in the run: Install / Update in the app store is refused).
 * The name must be the whole of what follows the verb and be an app we
 * know, one called an app ("the Duolingo app"), or the run's own app.
 * A task that also uninstalls is never read as permission to install.
 */
function installTarget(goal, runApp = "") {
  const g = String(goal || "").replace(/\s+/g, " ").trim();
  if (!g || /\buninstall\b/i.test(g)) return "";
  const m = g.match(INSTALL_IN);
  if (!m) return "";
  const said = m[1].trim();
  const flat = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const known = prefs.appNamedIn(said);
  const whole = known && known === flat(said);
  const own = runApp && flat(runApp) === flat(said);
  return whole || m[2] || own ? said : "";
}

/**
 * match(), but only for a tool this phone's app build can carry out — an
 * older app would drop the action after the fixed sentence promised it.
 */
function matchFor(text, build) {
  let m = match(text);
  if (!m) return null;
  const registry = require("../tools/registry");
  // play_music only when this server has it; otherwise the engine route.
  if (m.tool === "play_music" && !registry.get("play_music")) m = m.engine;
  const tool = registry.get(m.tool || "do_task_in_app");
  const need = Number(tool?.minAppBuild || 0);
  return Number(build) >= need ? m : null;
}

const flat = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The tool and arguments the fixed route runs for a match. */
function routeOf(m) {
  return {
    tool: m.tool || "do_task_in_app",
    args: m.args || { goal: m.goal, category: m.category, app: m.app, url: m.url },
  };
}

/**
 * SPOKEN WORDS TAKE THE SAME ROUTE AS TYPED ONES (contract §3, 17-lite).
 * The live model picks its own tool for what the owner SAID, and the same
 * words could become order_food (a hand-off that adds nothing to the
 * cart), do_task_in_app or open_named_app from one day to the next — while
 * typed, they always took the fixed route. When the owner's words match a
 * fixed route and the model called one of the ROUTABLE tools:
 *   → { tool, args, override: true }  a different tool or app: run the route
 *   → { tool, args, override: false } the model chose the route itself
 *   → null                            no route, or not a routable call
 * Either way the caller answers the model with the route's fixed sentence.
 */
function spokenRoute(call, userText, build) {
  if (!call || !ROUTABLE.has(call.name)) return null;
  const a = call.args || {};
  if (call.name === "do_task_in_app" && a.run_id) return null; // a resume
  const m = matchFor(userText, build);
  if (!m) return null;
  const want = routeOf(m);
  let same = call.name === want.tool;
  if (same && want.tool === "do_task_in_app") {
    same = want.args.app ? flat(a.app) === flat(want.args.app)
      : want.args.url ? String(a.url || "") === want.args.url : true;
  } else if (same && (want.tool === "open_named_app" || want.tool === "uninstall_app")) {
    same = flat(a.app) === flat(want.args.app) && !!a.install === !!want.args.install;
  }
  return same ? { tool: call.name, args: a, override: false } : { ...want, override: true };
}

/** The phone's own note to the model (never the owner's words). */
function isAppNote(text) {
  return APP_NOTE.test(String(text || ""));
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The owner calling off the WAITING task: a bare "stop" / "cancel it" /
 * "never mind", or one that names the task's own app ("cancel the Swiggy
 * order", "stop it on Swiggy"). "Cancel my 5 pm meeting", "stop the
 * music" or "cancel the Zomato order" (while a Swiggy task waits) are
 * requests for the model, not a stop.
 */
function stopsTask(text, waiting = null) {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t || isAppNote(t)) return false;
  for (const name of [waiting?.app_label, waiting?.app_name]) {
    const w = String(name || "").trim();
    if (!w) continue;
    t = t.replace(new RegExp(`\\s*\\b(?:(?:in|on|from)\\s+)?${escapeRe(w)}\\b`, "ig"), "").replace(/\s+/g, " ").trim();
  }
  return STOP.test(t);
}

/**
 * THE OWNER'S ANSWER TO A WAITING TASK. `waiting` is the run that asked
 * (service.waitingRun). Returns { tool: "do_task_in_app", args: { run_id,
 * answer } } to resume it, or null when the words are something else.
 *
 * Typed words (no `call`) resume the task on their own only when they are
 * a clear task for the waiting run's OWN app ("order from Meghana on
 * Swiggy" while the Swiggy task asked "Paradise or Meghana?"). Anything
 * else typed — "the veg one", "what is the weather", "open Swiggy", "call
 * mom" — goes to the model with the task's question beside it
 * (waitingNote), and the model decides whether it is the answer: taken
 * word for word, every typed request for ten minutes after a question was
 * swallowed as its answer (review, 2026-09-24).
 *
 * With `call` (the live model's tool call for what the owner SAID) only a
 * call that would START a new run for this task's app or kind is turned
 * into the answer — "open YouTube" is not an answer to "which
 * restaurant?", and neither is a cab when the task is food.
 *
 * Never an answer: the owner calling it off, a note from the app itself,
 * another fixed job (install, uninstall, play), or a DIFFERENT app.
 */
function resumeFor({ call = null, text = "", build = 0, waiting = null } = {}) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!waiting || !t || isAppNote(t) || /\[SYSTEM\]/i.test(t) || stopsTask(t, waiting)) return null;
  const m = matchFor(t, build);
  const sameApp = (app) => !!app && !!waiting.app_name &&
    (flat(app) === flat(waiting.app_name) || flat(app) === flat(waiting.app_label));
  if (m) {
    if (m.tool && m.tool !== "do_task_in_app") return null;
    if (!sameApp(m.app)) return null;
  }
  if (!call && !m) return null;
  if (call) {
    const a = call.args || {};
    const starts = (call.name === "do_task_in_app" && !a.run_id) || (!!m && ROUTABLE.has(call.name));
    if (!starts) return null;
    if (!m && a.app && !sameApp(a.app)) return null;
    // A new job of another kind ("book a cab to the airport" while a food
    // task waits) is its own run, not this one's answer.
    const kind = String(a.category || "").toLowerCase();
    const was = String(waiting.category || "").toLowerCase();
    if (!m && kind && was && kind !== was && kind !== "other" && was !== "other") return null;
  }
  return { tool: "do_task_in_app", args: { run_id: waiting.id, answer: t.slice(0, 400) } };
}

/**
 * The [SYSTEM] line sent to the live model in front of typed words while
 * a task waits: the task, its question and its run_id, so the MODEL
 * decides whether the words answer it (do_task_in_app with run_id) or ask
 * for something else. Never a guess made here from the words alone.
 */
function waitingNote(waiting) {
  const q = String(waiting?.question || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const goal = String(waiting?.goal || "").replace(/\s+/g, " ").trim().slice(0, 160);
  const id = Number(waiting?.id);
  return `[SYSTEM] The phone task "${goal}" (run_id ${id}) is waiting for the owner's answer` +
    `${q ? ` to: "${q}"` : ""}. If the owner's message below answers that, call do_task_in_app ` +
    `with run_id ${id} and their answer. If it asks for anything else, do that as usual and leave ` +
    "the task waiting — never treat it as the answer.";
}

module.exports = {
  match, matchFor, installTarget, spokenRoute, resumeFor, stopsTask, isAppNote, waitingNote, ROUTABLE, STOP,
};
