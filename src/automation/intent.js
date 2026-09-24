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
 * form link is given) together with a doing-word. Plain "open X" and
 * "install X" keep their own flow; reminders, calls and messages never
 * match. Anything else is left to the model exactly as before.
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

function categoryOf(app) {
  for (const [cat, apps] of Object.entries(prefs.CATEGORIES)) {
    if (apps.includes(app)) return cat;
  }
  return "other";
}

/**
 * For a clear phone task: { goal, app?, url?, category } for the task
 * engine (tool do_task_in_app), or { tool: "uninstall_app", args } — else
 * null.
 */
function match(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 300) return null;
  // The app's own notes to the assistant ("[SYSTEM] The task … needs one
  // answer") quote the task's words — they are never a new request.
  if (/\[SYSTEM\]/i.test(t)) return null;
  const rm = t.match(UNINSTALL);
  if (rm) {
    const said = rm[2].trim();
    // The WHOLE thing must be the app: "delete my WhatsApp messages" names
    // WhatsApp but deletes messages.
    const known = prefs.appNamedIn(said);
    const whole = known && known === said.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (/^uninstall$/i.test(rm[1]) || rm[3] || whole) {
      return { tool: "uninstall_app", args: { app: said }, goal: t };
    }
  }
  const url = t.match(/https?:\/\/\S+/i);
  if (url && FORM.test(t)) return { goal: t, url: url[0].replace(/[).,]+$/, ""), category: "web" };
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
 * match(), but only for a tool this phone's app build can carry out — an
 * older app would drop the action after the fixed sentence promised it.
 */
function matchFor(text, build) {
  const m = match(text);
  if (!m) return null;
  const tool = require("../tools/registry").get(m.tool || "do_task_in_app");
  const need = Number(tool?.minAppBuild || 0);
  return Number(build) >= need ? m : null;
}

module.exports = { match, matchFor };
