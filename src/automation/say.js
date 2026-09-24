/**
 * WHAT THE OWNER HEARS — one fixed sentence for each way a run can end.
 *
 * Reports used to be whatever was lying around: the planner's own prose,
 * a note written FOR the planner ("… — no need to search again"), and raw
 * codes from the phone ("Something went wrong in Swiggy (network)"). The
 * owner heard a different sentence every run, some of them untrue (owner
 * reports, 2026-09-24). So the frame of every ending is decided here, in
 * code; the planner only fills in what it did, and even that is cleaned.
 *
 * No company names in the templates: {App} is the owner's own app, and
 * the store is "the app store".
 */
const guard = require("./guard");

/** "google maps" (the owner's lower-case words) reads as "Google Maps". */
function pretty(label) {
  const t = String(label || "").replace(/\s+/g, " ").trim();
  if (!t || /[A-Z]/.test(t)) return t;
  return t.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** The app's name as the owner knows it. */
function app(r) {
  if (r?.web) return "the browser";
  return r?.app_name ? pretty(r.app_label) || "the app" : "the app";
}
const App = (r) => { const a = app(r); return a.charAt(0).toUpperCase() + a.slice(1); };

/** "in Swiggy", or "on your phone" for a task across the phone itself. */
function at(r) {
  if (r?.web) return "in the browser";
  return r?.app_name ? `in ${app(r)}` : "on your phone";
}

/** A note is {text, owner}; older runs stored plain strings. */
const noteText = (n) => (typeof n === "string" ? n : String(n?.text || ""));
const ownerNote = (n) => typeof n === "string"
  ? !/no need to search again/i.test(n) : n?.owner !== false;

/** Where the run opened the app: 'on the results for "biryani"', or 'for you'. */
function where(r) {
  const jump = (r?.notes || []).find((n) => n && typeof n === "object" && n.query);
  return jump ? `on the results for "${jump.query}"` : "for you";
}

// Words from the phone and the planner that are codes, not English.
const CODES =
  /\s*\((?:network|timeout|[a-z]+_[a-z_]+|blocked:[a-z_]+|refused[^)]*|the app did not open|screen unreadable|too many steps|could not open)\)|\b(?:tap_failed|not_found|not_running|not_installed|left_app|no_root|no_picture|type_failed|blocked:[a-z_]+)\b/gi;

/**
 * Model or device text made fit for the owner: no codes, and nothing
 * that was written for the planner.
 */
function clean(text) {
  return String(text || "")
    .replace(/[,;—-]*\s*no need to search again\.?/gi, ".")
    .replace(CODES, "")
    .replace(/\s+([.,;!?])/g, "$1")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

/** What was chosen along the way, as the owner should hear it. */
function lead(r) {
  const own = (r?.notes || []).filter(ownerNote).map(noteText).filter(Boolean).slice(-2);
  const t = clean(own.join(" "));
  return t ? `${t} ` : "";
}

/* ---------------- the fixed sentences ---------------- */

function plannerDown(r) {
  const left = r?.app_name || r?.web ? `${App(r)} is open where I left it` : "everything is where I left it";
  return `I couldn't reach my planner just now, so I stopped — ${left}. Try again in a minute.`;
}

function unconfirmed(r) {
  return `I couldn't confirm that worked ${at(r)} — please check it.`;
}

/** Resumable: the owner does this one thing, taps Continue, the run goes on. */
function ownerStep(kind, r) {
  const a = App(r);
  switch (kind) {
    case "captcha":
      return `${a} is showing a human check. Solve it, then tap Continue on the bar and I'll carry on.`;
    case "permission":
      return `${a} is asking for a permission — that's your call. Answer it, then tap Continue on the bar and I'll carry on.`;
    default:
      return `${a} needs you to sign in or enter the OTP. Do that, then tap Continue on the bar and I'll carry on.`;
  }
}

/** The app itself keeps assistants out. */
function blocked(kind, r) {
  const a = App(r);
  const opened = `I've opened it ${where(r)} — please take it from here.`;
  switch (kind) {
    case "secure_screen":
      return `${a} hides its screen from assistants for security, so I can't tap inside it. ${opened}`;
    case "detects_assistant":
      return `${a} won't work while an assistant can see the screen — that's its own security rule, and I can't get around it. ${opened}`;
    case "no_access":
    default:
      return `${a} doesn't let assistants read its screen, so I stopped rather than tap blind. ${opened}`;
  }
}

function locked() {
  return "Your phone locked partway, so I stopped. Unlock it and ask me again.";
}

function stale() {
  return "The phone stopped reporting partway, so I closed this task.";
}

/** A step the guard refused twice: say exactly what was refused and why. */
function refused(r, action, kind) {
  const why = guard.HANDOFF_TEXT[kind] || REFUSAL[kind] || "that step is yours";
  const label = clean(action?.what || action?.label || "").slice(0, 60);
  const before = action?.type === "open_app"
    ? `before opening ${pretty(action.name || "that app")}`
    : action?.type === "type"
      ? `before typing${label ? ` into "${label}"` : " there"}`
      : label ? `before "${label}"` : "at the next step";
  return `${lead(r)}I stopped ${before} because ${why}.`.trim();
}
// Refusals that are not guard kinds.
const REFUSAL = {
  no_picture: "this app hides its picture from assistants, so I can only tap what it lists",
};

/**
 * The phone ended the run with an error: a fixed reason per detail,
 * never the raw code (it used to read "Something went wrong in Swiggy
 * (network)").
 */
function deviceFailure(detail, r) {
  const d = String(detail || "").toLowerCase();
  if (/network|connection|timeout/.test(d)) {
    return "I lost the connection partway, so I stopped. Everything done so far is still on screen.";
  }
  if (/did not open|could not open|not open/.test(d)) return `${App(r)} didn't open, so I stopped.`;
  if (/unreadable/.test(d)) return `I couldn't read ${app(r)}'s screen, so I stopped.`;
  if (/too many steps/.test(d)) return "This was taking too many steps, so I stopped — you can pick it up from here.";
  if (d === "install_running") {
    return "An app is still installing, so I didn't start this yet — ask me again once it's done.";
  }
  if (d === "owner_no_answer") {
    return "I waited a while for you to tap Continue, so I closed this task — ask me again when you're ready.";
  }
  if (d === "server") return "Something went wrong on my side, so I stopped.";
  return `Something went wrong ${at(r)}, so I stopped.`;
}

module.exports = {
  pretty, app, App, at, where, clean, lead, noteText, ownerNote,
  plannerDown, unconfirmed, ownerStep, blocked, locked, stale, refused, deviceFailure,
  REFUSAL,
};
