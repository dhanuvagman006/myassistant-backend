/**
 * WHEN THE APP ITSELF KEEPS ASSISTANTS OUT — named, not guessed at.
 *
 * Owner, 2026-09-24: if an app does not allow this, say so plainly. Some
 * apps hide their screen from anything but the owner's eyes (banking and
 * payment screens set FLAG_SECURE: the phone's screenshot comes back
 * black), some give an assistant no screen to read at all, and some
 * refuse to run while an accessibility service is on. Before this file
 * each of those cost several planner calls and ended in a wrong sentence
 * — "I got stuck on the same step", "Another screen took over".
 *
 * classify() runs on every look BEFORE the blank-screen wait and before
 * the planner, so a blocked app costs no model call at all. It reads only
 * what the phone reports about its own access (screen.access, sent from
 * app build 105) and the words on the screen.
 */
const guard = require("./guard");

// An app telling the owner to switch the assistant off. Settings screens
// talk about accessibility too, so they never count; and only an
// element's OWN text is read — a merged row label can put a "Close"
// button beside a website's "Screen Reader Access" link.
const DETECTS_ASSISTANT =
  /(?:turn off|disable|switch off|uninstall)\b.{0,50}\b(?:accessibility|screen ?readers?|overlays?|remote access|screen sharing)|(?:accessibility (?:service|permission|app)|overlay|screen ?reader|remote access app)s?\b.{0,60}\b(?:detected|found|enabled|is on|are on|risk|harm|not allowed)/i;

const NO_TREE = new Set(["no_root", "empty"]);
const NO_SHOT = new Set(["failed", "none"]);

/** The newest step the phone actually received (refused ones never went). */
function lastDelivered(steps) {
  for (let i = (steps || []).length - 1; i >= 0; i--) if (!steps[i].vetoed) return steps[i];
  return null;
}

/**
 * null, or { status: "blocked"|"failed", kind } for this look.
 * @param r      the run (its steps carry the previous look's access)
 * @param screen the cleaned screen, with access when the phone sent it
 */
function classify(r, screen) {
  const nodes = screen?.nodes || [];
  const a = screen?.access || null;
  const pkg = String(screen?.pkg || "");
  if (a) {
    // The lock screen came up: nothing on it is ours to touch.
    if (a.locked) return { status: "failed", kind: "locked" };
    // No elements and a black picture, twice running: the app hides its
    // screen. One black look is not enough — a dark splash screen with no
    // elements yet looks the same, and below Android 14 the phone cannot
    // double-check the picture — so the first is waited out like any
    // blank look.
    if (!nodes.length && a.shot === "black") {
      const prev = lastDelivered(r?.steps);
      if (prev?.blank && prev.look?.shot === "black") return { status: "blocked", kind: "secure_screen" };
    }
    // No elements and no picture, twice running: nothing to read at all.
    if (!nodes.length && NO_TREE.has(a.tree) && NO_SHOT.has(a.shot)) {
      const prev = lastDelivered(r?.steps);
      if (prev?.blank && prev.look && NO_TREE.has(prev.look.tree) && NO_SHOT.has(prev.look.shot)) {
        return { status: "blocked", kind: "no_access" };
      }
    }
  }
  const own = nodes.map((n) => String(n.text || n.desc || "").replace(/\s+/g, " ").trim());
  if (nodes.length && !guard.SETTINGS_PKGS.has(pkg) && pkg !== "com.myassistant.myassistant" &&
      own.some((t) => t.length <= 300 && DETECTS_ASSISTANT.test(t))) {
    return { status: "blocked", kind: "detects_assistant" };
  }
  return null;
}

/** Kinds the phone may name when it ends a run as blocked_by_app. */
const KINDS = new Set(["secure_screen", "no_access", "detects_assistant"]);

module.exports = { classify, lastDelivered, DETECTS_ASSISTANT, KINDS };
