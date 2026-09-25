/**
 * RECIPES — a common task, played step by step with no model call.
 *
 * Owner, 2026-09-25: "we make multiple API calls and the task is not being
 * completed properly — we have glitches and sometimes we get stuck", and
 * "it should have full access to the phone to achieve the task assigned".
 * Both hold: the planner (automation/planner.js) stays the engine for ANY
 * task in ANY app; a recipe only takes the steps of a flow the owners
 * repeat, on screens it recognises exactly, before the planner is asked.
 *
 * How a recipe steps aside (the planner then decides as it always has):
 *   • it does not recognise the screen — a pop-up, a new layout, an A/B test;
 *   • its last step did not change the screen, or failed (and after two
 *     such steps it is off for the rest of the run: no ping-pong);
 *   • the guard refuses its action (service.js checks it like any other).
 * A recipe's "done" still needs its proof on the screen (service.proven).
 *
 * A recipe is { id, matches(run) -> params|null, next(screen, params) ->
 * decision|null }, where a decision has the planner's own shape:
 *   { status: "continue", action, expect } | { status: "done", evidence, report }.
 */

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
const textOf = (n) => String(n?.text || n?.label || "");
const descOf = (n) => String(n?.desc || "");

/** The recipe steps delivered so far, newest last. */
function recipeSteps(run, id) {
  return (run.steps || []).filter((s) => !s.vetoed && s.recipe === id);
}

/** A step that left the screen as it was, or did not happen. */
const stalled = (s) => s && s.result && (s.result.ok === false || s.result.changed === false);

/* ------------------------------ Instagram ------------------------------ */

const IG = "com.instagram.android";

/**
 * FOLLOW / UNFOLLOW A PERSON ON INSTAGRAM. The path taken by hand on the
 * owner's phone, 2026-09-25 (actor Yash, @thenameisyash): search → the
 * exact username (a search runs Instagram's assistant-style results page,
 * whose top card is a preview — the ACCOUNTS tab or the username opens the
 * real profile) → the profile → Follow, done only when it reads Following.
 *
 * Runs only with a username it can trust: one the web lookup found with
 * confidence (automation/people.js, noted on the run), or an @handle the
 * owner said. An unsure name goes to the planner, which checks the
 * profile's tick and followers itself (planner rule 4b).
 */
const instagramFollow = {
  id: "instagram.follow",

  matches(run) {
    if (run.web) return null;
    const app = norm([run.app_pkg, run.app_name, run.app_label].join(" "));
    if (!app.includes("instagram")) return null;
    const goal = norm(run.goal);
    const verb = /\bunfollow\b/.test(goal) ? "unfollow" : /\bfollow\b/.test(goal) ? "follow" : "";
    if (!verb) return null;
    const said = (String(run.goal || "").match(/@([a-z0-9._]{1,30})/i) || [])[1];
    const found = (run.notes || []).find((n) => n && n.handle && n.confident);
    const handle = norm(said || found?.handle || "");
    return handle ? { verb, handle } : null;
  },

  next(screen, { verb, handle }) {
    if (String(screen?.pkg || "") !== IG) return null;
    const nodes = screen?.nodes || [];
    const tap = (n, expect) => ({ status: "continue", action: { type: "tap", id: n.id }, expect });

    // 1. Unfollow's own sheet or dialog: its "Unfollow" button.
    if (verb === "unfollow") {
      const confirm = nodes.find((n) => norm(textOf(n)) === "unfollow");
      if (confirm) return tap(confirm, `the profile's button to read "Follow"`);
    }

    // 2. A PROFILE: both counters ("261 posts", "14.8M followers") and the
    //    username as title. A search row ends in "followers" too, never
    //    in "posts".
    const counter = (re) => nodes.some((n) => re.test(norm(textOf(n)).replace(/\s/g, "")));
    const isProfile = counter(/posts$/) && counter(/followers$/);
    if (isProfile) {
      // Someone else's profile: not ours to act on — the planner goes back.
      if (!nodes.some((n) => norm(textOf(n)) === handle)) return null;
      // The profile's own button comes before "Suggested for you", whose
      // cards have Follow buttons of their own. It names the person
      // ("Follow Yash"), or reads Follow/Following with a capital — the
      // "following" under the counters is a label, not the button.
      const cut = nodes.findIndex((n) => norm(textOf(n)) === "suggested for you");
      const head = cut >= 0 ? nodes.slice(0, cut) : nodes;
      const btn = head.find((n) => /^(follow|following|requested|follow back)\s+\S/i.test(descOf(n))) ||
        head.find((n) => /^(Follow|Following|Requested|Follow Back)$/.test(textOf(n).trim()));
      if (!btn) return null;
      // The state is the button's FIRST word: a display name like
      // "Requested Tunes" must not read as a pending request.
      const lead = norm(descOf(btn) || textOf(btn));
      const state = lead.startsWith("following") ? "following"
        : lead.startsWith("requested") ? "requested" : "follow";
      const at = `@${handle} on Instagram`;
      if (verb === "follow") {
        if (state === "following") return { status: "done", evidence: "Following", report: `Followed ${at}.` };
        if (state === "requested") {
          return { status: "done", evidence: "Requested", report: `Sent a follow request to ${at} — the account is private.` };
        }
        return tap(btn, `the button to read "Following"`);
      }
      if (state === "follow") return { status: "done", evidence: "Follow", report: `Unfollowed ${at}.` };
      return tap(btn, `a sheet with "Unfollow"`);
    }

    // 3. Search results or suggestions: the row whose username IS the one
    //    wanted — "thenameisyash • 14.8M followers", never
    //    "thenameisyashu" or "thenameisyash2029". The search box itself
    //    (which holds the typed name) is not a row.
    const row = nodes.find((n) => !Number(n.edit) && !/edittext/i.test(String(n.cls || "")) &&
      norm(textOf(n)).split(/[\s•·]+/)[0] === handle);
    if (row) return tap(row, "the account's profile");

    // 4. Assistant-style results ("For you" first): the ACCOUNTS tab.
    const tabs = nodes.find((n) => norm(textOf(n)) === "accounts");
    if (tabs) return tap(tabs, "a list of accounts");

    // 5. The search box: type the username. (Instagram is a messaging
    //    app to the guard, so Enter is not pressed; the suggestion row
    //    is tapped on the next look.)
    const box = nodes.find((n) => Number(n.edit));
    if (box) {
      // Already typed and nothing matched: the planner looks further.
      if (norm(textOf(box)) === handle) return null;
      return { status: "continue", action: { type: "type", id: box.id, text: handle, submit: true },
        expect: `accounts named like "${handle}"` };
    }

    // 6. Explore's search bar, then the Search tab itself.
    const bar = nodes.find((n) => Number(n.click) && /^search\b/.test(norm(descOf(n))) &&
      !/explore/.test(norm(descOf(n))));
    if (bar) return tap(bar, "the search box");
    const nav = nodes.find((n) => /^search and explore$/.test(norm(descOf(n))) || norm(textOf(n)) === "search");
    if (nav) return tap(nav, "Instagram's search");
    return null;
  },
};

const RECIPES = [instagramFollow];

/**
 * The next step from a recipe for this run on this screen, or null when
 * the planner should decide. The result carries `recipe` (its id).
 */
function next(run, screen) {
  for (const rec of RECIPES) {
    const params = rec.matches(run);
    if (!params) continue;
    const mine = recipeSteps(run, rec.id);
    // Two steps that went nowhere: this run is the planner's from now on.
    if (mine.filter(stalled).length >= 2) return null;
    // The last delivered step was this recipe's and it did not move the
    // screen: step aside once, so the planner looks with fresh eyes.
    const delivered = (run.steps || []).filter((s) => !s.vetoed);
    const last = delivered[delivered.length - 1];
    if (last && last.recipe === rec.id && stalled(last)) return null;
    let d = null;
    try { d = rec.next(screen, params); } catch (_) { d = null; }
    if (d) return { ...d, recipe: rec.id };
  }
  return null;
}

module.exports = { next, RECIPES, _instagramFollow: instagramFollow };
