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
  /\b(?:order|book|buy|add|put|search|find|look for|look up|apply|register|fill|check|compare|reorder|track|get me|get)\b/i;
const ONLY_OPEN =
  /^\s*(?:please\s+)?(?:install|download|open|launch|start)\s+(?:the\s+)?[a-z0-9]+(?:\s+app)?\s*[.!]?\s*$/i;
const FORM = /\b(?:fill|apply|register|submit|sign me up)\b/i;

function categoryOf(app) {
  for (const [cat, apps] of Object.entries(prefs.CATEGORIES)) {
    if (apps.includes(app)) return cat;
  }
  return "other";
}

/** { goal, app?, url?, category } for a clear phone task, else null. */
function match(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 300) return null;
  // The app's own notes to the assistant ("[SYSTEM] The task … needs one
  // answer") quote the task's words — they are never a new request.
  if (/\[SYSTEM\]/i.test(t)) return null;
  const url = t.match(/https?:\/\/\S+/i);
  if (url && FORM.test(t)) return { goal: t, url: url[0].replace(/[).,]+$/, ""), category: "web" };
  const app = prefs.appNamedIn(t);
  if (!app || ONLY_OPEN.test(t)) return null;
  const openAnd = /\bopen\s+(?:the\s+)?\w+(?:\s+app)?\s+(?:and|then)\b/i.test(t);
  if (!DOING.test(t) && !openAnd) return null;
  return { goal: t, app, category: categoryOf(app) };
}

module.exports = { match };
