/**
 * AUTOMATION RUNS — "do it for me" inside another app, one checked step at
 * a time.
 *
 * THE LOOP (the phone drives it, this file decides each step):
 *   start  → pick the app (the owner's own preference first), open a run
 *   step   → the phone sends the screen it sees and how the last action
 *            went; the planner picks ONE next action; guard.js vetoes
 *            anything that pays, moves money, types a secret or sends a
 *            message; the phone acts, waits for the screen to settle and
 *            comes back with the result
 *   finish → done, handed off (payment is the owner's), a question for
 *            the owner, or an honest failure — always with a report in
 *            plain words: what was done, what is left, what was chosen
 *
 * The run lives in the database, not in memory: "yes, the veg one" can
 * resume a run after the app has been closed and reopened.
 *
 * TWO PHONES IN THE FIELD. From app build 105 the phone numbers its steps
 * (`seq`), says what it could see (`screen.access`) and understands three
 * new answers: owner_step (sign in, then tap Continue), blocked (the app
 * keeps assistants out) and unconfirmed (it may have worked — please
 * check). A build-104 phone sends none of that and must never be handed a
 * status it has no case for, so its answers are mapped back (forPhone).
 */
const { query, one, run: exec } = require("../db");
const guard = require("./guard");
const prefs = require("./prefs");
const say = require("./say");
const limits = require("./limits");
const intent = require("./intent");
const { hintsFor } = require("./hints");
// Looked up at call time so tests can stub the model behind it.
const planner = require("./planner");
const recipes = require("./recipes");

const MAX_STEPS = 30;
// The assistant's own app: the owner coming back to it ends the run.
const OWN_PKG = "com.myassistant.myassistant";
const DAILY_RUNS = 40;
const TERMINAL = new Set(["done", "handoff", "failed", "stopped", "blocked", "unconfirmed"]);
// A run can still be ended (by the phone, or by its own step) only in these.
const LIVE = ["running", "waiting", "waiting_owner"];
const DAY = 24 * 3600 * 1000;
// A phone that stops posting (app killed, phone rebooted) left its run
// "running" for ever — counted against the day's limit and reported as
// in progress. No step takes two minutes, so silence that long is a dead
// phone. A run the phone never began (the owner is still switching on the
// one-time permission) is given longer.
const STALE_MS = 120_000;
const UNSTARTED_STALE_MS = 15 * 60_000;
// The phone waits 30 s for a step, so everything — both planner calls of
// a refused step included — fits in 24 s.
const STEP_BUDGET_MS = 24_000;
const MIN_REPLAN_MS = 5_000;
// A refused step is re-planned; the second refusal in a run ends it.
const MAX_VETOES = 2;
// Screens the owner deals with in a moment and then hands back: sign-in
// and OTP, a human check, a permission. Paying, money, sending, posting,
// consent and deleting stay final.
const OWNER_KINDS = new Set(["credential", "captcha", "permission"]);

async function migrate(execSql) {
  await execSql(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id           BIGSERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      goal         TEXT NOT NULL,
      category     TEXT NOT NULL DEFAULT '',
      app_name     TEXT NOT NULL DEFAULT '',
      app_label    TEXT NOT NULL DEFAULT '',
      app_pkg      TEXT NOT NULL DEFAULT '',
      app_reason   TEXT NOT NULL DEFAULT '',
      start_url    TEXT NOT NULL DEFAULT '',
      web          INTEGER NOT NULL DEFAULT 0,
      -- running | waiting (a question for the owner) | waiting_owner (sign
      -- in, then Continue) | done | handoff | failed | stopped (the owner
      -- pressed Stop) | blocked (the app keeps assistants out) |
      -- unconfirmed (claimed, not seen on screen)
      status       TEXT NOT NULL DEFAULT 'running',
      steps        TEXT NOT NULL DEFAULT '[]',   -- [{action, expect, result}]
      notes        TEXT NOT NULL DEFAULT '[]',   -- choices made, with reasons
      answers      TEXT NOT NULL DEFAULT '[]',   -- [{q, a}]
      question     TEXT NOT NULL DEFAULT '',
      handoff_kind TEXT NOT NULL DEFAULT '',
      report       TEXT NOT NULL DEFAULT '',
      llm_calls    INTEGER NOT NULL DEFAULT 0,
      created_at   BIGINT NOT NULL,
      updated_at   BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_automation_user
      ON automation_runs (user_id, id DESC);
    -- 1 once the phone numbers its steps (app build 105): it understands
    -- owner_step, blocked and unconfirmed.
    ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS proto INTEGER NOT NULL DEFAULT 0;
  `);
}

const parse = (v, fb) => { try { return JSON.parse(v); } catch (_) { return fb; } };

function hydrate(r) {
  if (!r) return null;
  return {
    ...r,
    id: Number(r.id),
    web: !!r.web,
    proto: Number(r.proto || 0),
    steps: parse(r.steps, []),
    notes: parse(r.notes, []),
    answers: parse(r.answers, []),
  };
}

async function get(userId, id) {
  return hydrate(await one(
    `SELECT * FROM automation_runs WHERE user_id=$1 AND id=$2`, [userId, Number(id)]));
}

/**
 * Runs whose phone went silent are closed, honestly, not left running.
 * With no user, EVERY user's: the proactive scheduler's ten-minute sweep.
 * Only the owner's next task used to close them — two runs sat 'running'
 * 37-46 h in production (audit, 2026-09-27). Returns how many it closed.
 */
async function sweep(userId = null) {
  const now = Date.now();
  const who = userId == null ? null : Number(userId);
  const n1 = await exec(
    `UPDATE automation_runs SET status='failed', report=$4, updated_at=$5
      WHERE ($1::int IS NULL OR user_id=$1) AND status='running'
        AND updated_at < $2 AND (steps <> '[]' OR updated_at < $3)`,
    [who, now - STALE_MS, now - UNSTARTED_STALE_MS, say.stale(), now]).catch(() => 0);
  // The owner's turn (sign in, then Continue) is given 15 minutes; a phone
  // that died meanwhile never says so, and the run must not wait for ever.
  const n2 = await exec(
    `UPDATE automation_runs SET status='failed', report=$3, updated_at=$4
      WHERE ($1::int IS NULL OR user_id=$1) AND status='waiting_owner' AND updated_at < $2`,
    [who, now - UNSTARTED_STALE_MS, say.stale(), now]).catch(() => 0);
  return (n1 || 0) + (n2 || 0);
}

/** Steps the phone was actually handed (a refused step never left here). */
const delivered = (steps) => (steps || []).filter((s) => !s.vetoed);

/**
 * A build-104 phone knows done/handoff/failed/stopped/waiting/continue
 * only; anything newer is mapped onto the nearest one it handles.
 */
function forPhone(out, proto) {
  if (proto || !out) return out;
  if (out.status === "blocked" || out.status === "unconfirmed") return { ...out, status: "failed" };
  if (out.status === "owner_step" || out.status === "waiting_owner") return { ...out, status: "handoff" };
  return out;
}

// ONE STEP AT A TIME PER RUN. The phone re-sends a step it got no answer
// for; two requests for the same run used to plan twice and write over
// each other's steps. A single replica serves the phone, so an in-process
// queue per run is enough.
const locks = new Map(); // runId -> Promise
function withRunLock(runId, fn) {
  const prev = locks.get(runId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  locks.set(runId, tail);
  tail.then(() => { if (locks.get(runId) === tail) locks.delete(runId); });
  return next;
}

async function recent(userId, limit = 10) {
  await sweep(userId);
  const rows = await query(
    `SELECT id, goal, app_label, status, handoff_kind, report, question, created_at, updated_at
       FROM automation_runs WHERE user_id=$1 ORDER BY id DESC LIMIT $2`,
    [userId, Math.min(Number(limit) || 10, 30)]);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/**
 * Writes fields onto the run. With onlyIf (a list of statuses) the write
 * happens only while the run is still in one of them — Stop pressed while
 * a step was thinking must win over that step. Returns false when it did
 * not write.
 */
async function save(userId, r, fields, { onlyIf = null } = {}) {
  const sets = [];
  const vals = [userId, r.id];
  let i = 3;
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k}=$${i++}`);
    vals.push(["steps", "notes", "answers"].includes(k) ? JSON.stringify(v) : v);
  }
  sets.push(`updated_at=$${i++}`);
  vals.push(Date.now());
  let where = "WHERE user_id=$1 AND id=$2";
  if (onlyIf) {
    where += ` AND status = ANY($${i}::text[])`;
    vals.push(onlyIf);
  }
  const n = await exec(`UPDATE automation_runs SET ${sets.join(", ")} ${where}`, vals);
  if (onlyIf && !n) return false;
  Object.assign(r, fields);
  return true;
}

/** The app this run's own words ask to install, or "" (intent.js). */
const installApp = (r) => intent.installTarget(r?.goal, r?.app_name || r?.app_label || "");

/** What the phone needs to start (or resume) a run. */
function directive(r, { resume = false } = {}) {
  return {
    type: "automate",
    run_id: r.id,
    goal: r.goal,
    app: r.app_label || r.app_name,
    app_name: r.app_name,
    // Build 117: when the app is not on the phone, the phone installs it
    // and carries on — if the owner NAMED it. The usual pick for the kind
    // of task is not installed when the phone has another app of that
    // kind (category): the task starts again in that one. A money app is
    // never installed for a task.
    category: r.category || "",
    named: /^you asked/.test(r.app_reason || ""),
    no_install: guard.PAYMENT_PKGS.has(r.app_pkg || "") ||
      guard.MONEY_APP_NAME.test(`${r.app_label || ""} ${r.app_name || ""}`),
    // A web run records the browser it is in (stepLocked), so a resumed
    // run reopens that browser on its own tab. One with no browser on
    // record keeps its link: an empty pkg AND url opens nothing. (Builds
    // 118/119 open no link on a resume at all, so there only pkg helps.)
    pkg: r.app_pkg,
    start_url: resume && !(r.web && !r.app_pkg) ? "" : r.start_url,
    web: r.web,
    // The whole phone: any app except money apps, the installer and
    // permission pop-ups (the phone enforces those itself).
    any: true,
    allowed: r.web ? guard.BROWSERS : (r.app_pkg ? [r.app_pkg] : []),
    max_steps: MAX_STEPS,
    resume,
    // The phone presses Install / Update in the app store only when the
    // owner's own words asked to install or download an app — and only
    // that app (install_app) — never for "download my invoice".
    may_install: !!installApp(r),
    install_app: installApp(r),
    // Where the phone's step count carries on from: a resumed run (after
    // the owner answered a question) continues the same numbering.
    seq: delivered(r.steps).length,
  };
}

/* ------------------------------------------------------------------ *
 * START / RESUME
 * ------------------------------------------------------------------ */

async function start(userId, { goal, category = "", app = "", url = "", query = "" } = {}) {
  const g = String(goal || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!g) return { ok: false, error: "what should I do? (goal required)" };

  await sweep(userId);
  const today = await one(
    `SELECT count(*)::int AS n FROM automation_runs WHERE user_id=$1 AND created_at > $2`,
    [userId, Date.now() - DAY]);
  if ((today?.n || 0) >= DAILY_RUNS) {
    return { ok: false, error: "that's the limit of hands-on tasks for today — try again tomorrow" };
  }

  const link = String(url || "").trim();
  const web = /^https?:\/\//i.test(link) && !app;
  let pick = null;
  if (!web) {
    pick = await prefs.pickApp(userId, String(category || "").toLowerCase(), app || "");
    // No app to start in (settings, "take a screenshot", a task across
    // several apps): start from the home screen and open what it needs.
    if (!pick) pick = { name: "", label: "your phone", pkg: "", reason: "" };
    // The owner's words can be lower case ("open google maps and …").
    else pick = { ...pick, label: say.pretty(pick.label) };
    // A MONEY APP IS NEVER OPENED FOR A TASK (guard.MONEY_APP_NAME). "Check
    // my PhonePe balance" used to open PhonePe, find its first screen
    // barred and tell the owner "It's ready for payment" — nothing was.
    if (guard.PAYMENT_PKGS.has(pick.pkg || "") || guard.MONEY_APP_NAME.test(`${pick.label || ""} ${pick.name || ""}`)) {
      return {
        ok: false,
        error: `I don't open money apps like ${pick.label} for a task — that one is yours to do, and nothing was opened`,
      };
    }
  }
  // A start link only ever opens INSIDE the chosen app (the phone pins the
  // package), so a link the app doesn't understand just opens the app.
  let startUrl = web ? link : (/^https?:\/\//i.test(link) ? link : "");
  // INTENT FIRST: the app's own search link lands on the results in one
  // jump; the hands take over from there (automation/intents.js).
  // The note is for the PLANNER (owner: false) and says both outcomes: an
  // app that does not understand the link opens on its home page, and a
  // flat "no need to search again" then left the planner hunting — and was
  // read out to the owner at the end of the run (2026-09-24).
  const notes = [];
  // WHO THEY MEANT (automation/people.js): "follow Neha Shetty actor" once
  // followed a look-alike found by searching the owner's exact words. For a
  // person on a social app the official account is looked up first; the
  // planner opens (or searches) that exact username and checks the profile.
  if (!web && !startUrl && pick?.name) {
    const who = await require("./people").resolveAccount(pick.name, g).catch(() => null);
    if (who) {
      if (who.openUrl) startUrl = who.openUrl;
      notes.push({
        text: (who.confident
          ? `${who.name}'s official ${who.label} account (from a web search) is @${who.handle}. `
          : `${who.name}'s ${who.label} account is probably @${who.handle}` +
            (who.alternatives.length ? ` (also seen: ${who.alternatives.map((h) => "@" + h).join(", ")})` : "") + ". ") +
          (who.openUrl
            ? "The run opened that profile. "
            : `Search the exact username "${who.handle}" in ${who.label} and open that result — not a similar name. `) +
          "Before following or subscribing, check the profile shows this username and, if the person is well known, " +
          "the verified tick; if it does not, or two accounts look alike, ask the owner which one.",
        owner: false,
        handle: who.handle,
        // Only a confident lookup may drive a recipe (automation/recipes.js);
        // an unsure one leaves the choice to the planner, which checks.
        confident: !!who.confident,
      });
      notes.push({ text: `Found ${who.name}'s account: @${who.handle}.`, owner: true });
    }
  }
  if (!web && !startUrl && pick?.name && !notes.length) {
    const jump = require("./intents").startLink(pick.name, String(category || "").toLowerCase(), g, query);
    if (jump) {
      startUrl = jump.url;
      notes.push({
        text: `Opened ${pick.label} with its search link for "${jump.query}". If the screen shows ` +
          `those results, work from them — no need to search again; if it shows the app's home page, search once.`,
        owner: false,
        query: jump.query,
      });
    }
  }

  const now = Date.now();
  const row = await one(
    `INSERT INTO automation_runs
       (user_id, goal, category, app_name, app_label, app_pkg, app_reason,
        start_url, web, notes, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
    [userId, g, String(category || ""), pick?.name || "", pick?.label || (web ? "the browser" : ""),
     pick?.pkg || "", pick?.reason || "", startUrl, web ? 1 : 0, JSON.stringify(notes), now]);
  const r = hydrate(row);
  return { ok: true, run: r, directive: directive(r) };
}

async function resume(userId, runId, answer, { remember = true } = {}) {
  const r = await get(userId, runId);
  if (!r) return { ok: false, error: "no such task" };
  if (r.status !== "waiting") {
    return { ok: false, error: `that task is already ${r.status}` };
  }
  const a = String(answer || "").trim().slice(0, 400);
  if (!a) return { ok: false, needsArgs: ["answer"] };
  const answers = [...r.answers, { q: r.question, a }];
  // Asked once, never again: the next form finds it in memory. Only an
  // answer the model picked out of the owner's words is kept for good —
  // words the server passed on whole ("order from Meghana on Swiggy")
  // are this run's answer, not a fact to fill forms with (remember:false).
  if (remember) await prefs.rememberAnswer(userId, r.question, a).catch(() => false);
  await save(userId, r, { answers, status: "running", question: "" });
  return { ok: true, run: r, directive: directive(r, { resume: true }) };
}

/**
 * The owner did their part (signed in, entered the OTP, answered a
 * permission) and tapped Continue on the bar. The run carries on in
 * place: same steps, same app, no relaunch. It used to END at a sign-in
 * screen with "tell me to continue" — a promise nothing could keep.
 */
async function ownerDone(userId, runId) {
  const r = await get(userId, runId);
  if (!r) return { ok: false, error: "no such task" };
  if (r.status === "running") return { ok: true };
  if (r.status !== "waiting_owner") return { ok: false, status: r.status, report: r.report };
  const ok = await save(userId, r, { status: "running", handoff_kind: "", report: "" },
    { onlyIf: ["waiting_owner"] });
  return ok ? { ok: true } : { ok: false, status: (await get(userId, runId))?.status || "failed" };
}

/* ------------------------------------------------------------------ *
 * STEP
 * ------------------------------------------------------------------ */

// Two taps at clearly different points are different steps — three
// tap_xy at three places used to count as "the same step" and end a run
// in a picture-only app as stuck.
const near = (a, b) => Math.abs((a ?? -1) - (b ?? -1)) <= 30;
const sameAction = (a, b) => a && b && a.type === b.type && a.id === b.id &&
  (a.text || "") === (b.text || "") && (a.direction || "") === (b.direction || "") &&
  (a.name || "") === (b.name || "") && near(a.x, b.x) && near(a.y, b.y);

function labelOf(screen, id) {
  const n = (screen?.nodes || []).find((x) => Number(x.id) === Number(id));
  if (!n) return "";
  // A text field is named by what it is for ("Search for dishes"), not by
  // what was typed in it — the history read `type "veg biryani" into
  // "veg biryani"` once ids left it.
  const words = n.edit ? (n.hint || n.desc || n.label || n.text) : (n.text || n.desc || n.label || n.hint);
  return String(words || "").slice(0, 60);
}

/** A step as it is stored: what the screen said when it was chosen (for
 *  NEW / GONE on the next look) and, for one of many identical buttons,
 *  the row it sits in. */
function stepRecord(action, expect, screen, extra = {}) {
  const near = action && action.id != null && (action.type === "tap" || action.type === "long_press")
    ? planner.nearFor(screen, action.id) : "";
  return {
    action, expect, ...extra,
    ...(near ? { near } : {}),
    ...((screen?.nodes || []).length ? { seen: planner.screenWords(screen) } : {}),
  };
}

/** The owner's report: what was chosen, then what happened. */
function composeReport(r, { kind = "", model = "" } = {}) {
  const parts = [];
  const said = say.clean(model);
  if (said) parts.push(said);
  else if (say.lead(r)) parts.push(say.lead(r).trim());
  if (kind && !said) parts.push(guard.handoffSentence(kind, say.app(r)));
  return parts.join(" ").replace(/\s+/g, " ").trim() ||
    guard.handoffSentence(kind || "other", say.app(r));
}

async function end(userId, r, status, { kind = "", report = "" } = {}) {
  const text = String(report || "").slice(0, 600);
  // The words of the screen the last step was chosen on were kept only for
  // the next look's NEW / GONE; a finished run does not keep them.
  const bare = (r.steps || []).some((s) => s.seen)
    ? { steps: r.steps.map(({ seen: _drop, ...s }) => s) } : {};
  // Whoever ends the run first wins: Stop pressed while a step was still
  // thinking stays Stop.
  const wrote = await save(userId, r, { status, handoff_kind: kind, report: text, ...bare }, { onlyIf: LIVE });
  if (!wrote) {
    const now = await get(userId, r.id);
    return { status: now?.status || status, handoff_kind: now?.handoff_kind || "", report: now?.report || text,
      step: delivered(now?.steps).length };
  }
  if (["done", "handoff"].includes(status) && r.app_name && r.category) {
    // Feeds "which app did they use last time" for the next pick.
    const kindFor = { food: "food", ride: "ride", movies: "movie", shopping: "shop", grocery: "shop" };
    if (kindFor[r.category]) {
      await require("../fulfillment/store").create(userId, {
        kind: kindFor[r.category], provider: r.app_name, path: "automation",
        title: r.goal.slice(0, 200), status: status === "done" ? "confirmed" : "handed_off",
        details: { run_id: r.id }, outcome: text,
      }).catch(() => {});
    }
  }
  return { status, handoff_kind: kind, report: text, step: delivered(r.steps).length };
}

// What we know about the owner is read once per run, not on every step
// (three queries each time) — it does not change in the middle of a task.
const OWNER_TTL = 5 * 60_000;
const ownerCache = new Map(); // runId -> { at, info }
async function ownerFor(userId, runId) {
  const hit = ownerCache.get(runId);
  if (hit && Date.now() - hit.at < OWNER_TTL) return hit.info;
  const info = await prefs.ownerInfo(userId).catch(() => ({}));
  ownerCache.set(runId, { at: Date.now(), info });
  if (ownerCache.size > 200) ownerCache.delete(ownerCache.keys().next().value);
  return info;
}

/** How the phone says the last action went, kept small. */
function resultOf(last) {
  const blocked = last.blocked ? String(last.blocked).slice(0, 30) : "";
  const out = {
    ok: blocked ? false : last.ok !== false,
    changed: blocked ? false : last.changed !== false,
  };
  if (last.error) out.error = String(last.error).slice(0, 120);
  if (blocked) out.blocked = blocked;
  if (last.how) out.how = String(last.how).slice(0, 20);
  if (last.submit_refused) out.submit_refused = true;
  return out;
}

// Proof is compared as words: "View Cart · 1 item" is on a screen that
// reads "1 item | ₹249 View Cart".
const words = (s) => String(s || "").toLowerCase().normalize("NFKC")
  .replace(/[^\p{L}\p{N}₹$€£%]+/gu, " ").trim();

/**
 * Does the screen show what the planner claims? Its `evidence` must be on
 * the screen; in an app that gives (almost) no element list, the picture
 * must have changed after the last step.
 */
function proven(evidence, screen, r) {
  const nodes = screen?.nodes || [];
  const ev = words(evidence);
  if (ev.replace(/\s/g, "").length >= 3) {
    const toks = ev.split(" ");
    const each = nodes.map((n) => words([n.text, n.desc, n.label, n.hint].join(" ")));
    if (each.join(" \n ").includes(ev)) return true;
    if (each.some((t) => toks.every((w) => ` ${t} `.includes(` ${w} `)))) return true;
  }
  const texty = nodes.filter((n) => n.text || n.desc || n.label).length;
  if (screen?.shot && texty < 5) {
    const d = delivered(r.steps);
    const last = d[d.length - 1];
    return !!(last?.result && last.result.ok !== false && last.result.changed !== false);
  }
  return false;
}

/* A REFUSED BUTTON STAYS REFUSED. The planner is shown what was refused
 * and picks again — and in a picture-only app a second tap_xy at the
 * same point with a harmless name ("the orange bar at the bottom") used
 * to pass both guards, since nothing under the point could be read. So
 * every tap keeps WHERE it pointed (the element a tap really presses, its
 * box, the point), and a later tap at the same place is refused the same
 * way until the screen has moved on. */

const box = (n) => (Array.isArray(n?.b) && n.b.length === 4 ? n.b.map(Number) : null);
const inBox = (b, x, y) => !!b && x != null && y != null && x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
// A container covering much of the screen says nothing about one button.
const small = (b) => !!b && (b[2] - b[0]) * (b[3] - b[1]) < 400_000;

/** Where a tap points: { pkg, id (what it presses), b, x, y } or null. */
function targetOf(action, screen) {
  const nodes = screen?.nodes || [];
  const byId = (id) => nodes.find((n) => Number(n.id) === Number(id));
  const pressedBy = (n) => {
    const up = Number.isInteger(n.up) && n.up >= 0 ? byId(n.up) : null;
    const p = !n.click && up ? up : n;
    const b = box(p) || box(n);
    return { id: Number(p.id), b: small(b) ? b : null, nb: box(n) };
  };
  const pkg = String(screen?.pkg || "");
  if (action?.type === "tap_xy") {
    const x = Number(action.x), y = Number(action.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const under = nodes.filter((n) => inBox(box(n), x, y))
      .sort((a, b) => (a.b[2] - a.b[0]) * (a.b[3] - a.b[1]) - (b.b[2] - b.b[0]) * (b.b[3] - b.b[1]))[0];
    const p = under ? pressedBy(under) : null;
    return { pkg, id: p ? p.id : null, b: p ? p.b : null, x, y };
  }
  if (action?.type === "tap" || action?.type === "long_press") {
    const n = byId(action.id);
    if (!n) return null;
    const p = pressedBy(n);
    const c = p.nb ? [(p.nb[0] + p.nb[2]) / 2, (p.nb[1] + p.nb[3]) / 2] : [null, null];
    return { pkg, id: p.id, b: p.b, x: c[0], y: c[1] };
  }
  return null;
}

/**
 * The places refused in this run (by the server or by the phone) that
 * still stand: a delivered step that moved the screen on (a tap that
 * changed it, a scroll, another app) clears them. A tap_xy refused only
 * for want of a picture is not a refused PLACE — tapping the same thing
 * from the element list is exactly what the planner should do next.
 */
function refusedPlaces(steps) {
  let out = [];
  for (const s of steps || []) {
    const kind = s.vetoed || s.result?.blocked || "";
    if (!kind && s.action?.type !== "wait" && s.result && s.result.changed !== false) out = [];
    if (kind && kind !== "no_picture" && s.target) out.push({ ...s.target, kind });
  }
  return out;
}

/** The refused place this action aims at again, or null. */
function aimsAtRefused(action, screen, steps) {
  const places = refusedPlaces(steps);
  if (!places.length) return null;
  const t = targetOf(action, screen);
  if (!t) return null;
  return places.find((p) => p.pkg === t.pkg && (
    (p.id != null && p.id === t.id) ||
    (near(p.x, t.x) && near(p.y, t.y) && p.x != null && t.x != null) ||
    inBox(p.b, t.x, t.y) || inBox(t.b, p.x, p.y))) || null;
}

/** Would this step be refused? The guard's lines, no blind taps, and no
 *  second try at a place already refused. */
function refusal(action, screen, opts, steps = []) {
  const v = guard.checkAction(action, screen, opts);
  if (v) return v;
  // No picture on this look (the app hides it, or none came): a point on
  // the screen would be a guess.
  if (action?.type === "tap_xy" && !screen?.shot) {
    return { kind: "no_picture", reason: say.REFUSAL.no_picture };
  }
  const again = aimsAtRefused(action, screen, steps);
  if (again) {
    const why = guard.HANDOFF_TEXT[again.kind] || say.REFUSAL[again.kind] || "that step is yours";
    return { kind: again.kind, reason: `${why} (that is the place refused a moment ago)` };
  }
  return null;
}

/**
 * One turn of the loop.
 * @param body.screen {pkg, nodes:[...], keyboard, shot?, access?}
 * @param body.last   {ok, changed, error, blocked?, how?, submit_refused?}
 *                    — how action number `seq` went
 * @param body.seq    actions the phone has received and attempted (build
 *                    105+); absent on older phones
 * @param meta        filled with what the step cost (counts and times
 *                    only) for the route's log line
 */
function step(userId, runId, body = {}, meta = {}) {
  return withRunLock(Number(runId), () => stepLocked(userId, Number(runId), body || {}, meta));
}

async function stepLocked(userId, runId, { screen, last, seq = null } = {}, meta = {}) {
  const deadline = Date.now() + STEP_BUDGET_MS;
  const r = await get(userId, runId);
  if (!r) return { status: "failed", report: "That task no longer exists." };
  const proto = Number.isInteger(seq) && seq >= 0;
  const reply = (out) => forPhone(out, proto);
  if (r.status === "waiting_owner") {
    return reply({ status: "owner_step", kind: r.handoff_kind, report: r.report, step: delivered(r.steps).length });
  }
  if (TERMINAL.has(r.status) || r.status === "waiting") {
    return reply({ status: r.status, report: r.report, question: r.question, step: delivered(r.steps).length });
  }
  if (proto && !r.proto) await save(userId, r, { proto: 1 });

  if (proto) {
    const idx = r.steps.map((s, i) => (s.vetoed ? -1 : i)).filter((i) => i >= 0);
    const newest = idx.length ? r.steps[idx[idx.length - 1]] : null;
    // THE SAME REQUEST AGAIN. The phone got no answer for this step (it
    // timed out) and re-sent it: the action already chosen is sent again —
    // no second planner call, and nothing recorded as done that the phone
    // never did.
    if (seq === idx.length - 1 && newest && !newest.result) {
      return { status: "continue", action: newest.action, expect: newest.expect, step: idx.length };
    }
    // Steps the phone says it never performed are dropped: they used to
    // sit in the history as "done, screen changed".
    if (seq < idx.length) {
      r.steps = r.steps.slice(0, seq ? idx[seq - 1] + 1 : idx[0]);
    }
  }

  // The previous action's outcome belongs to the previous step — and so
  // does what it did to the screen: the words that appeared and went away
  // (the model used to see only "done, screen changed", which reads as
  // success even when Enter was ignored and only the typed text appeared).
  if (last && typeof last === "object") {
    const d = delivered(r.steps);
    const prev = d[d.length - 1];
    if (prev && !prev.result) {
      prev.result = resultOf(last);
      if (prev.seen) prev.diff = planner.wordDiff(prev.seen, screen);
    }
  }
  // Only the newest step needs the words it was chosen on.
  for (const s of r.steps) if (s.result && s.seen) delete s.seen;

  const pkg = String(screen?.pkg || "");
  // A run may use any app the task needs. Only the owner coming back to
  // the assistant ends it here — they have taken the phone back.
  if (pkg === OWN_PKG) {
    await save(userId, r, { steps: r.steps });
    return reply(await end(userId, r, "stopped", {
      kind: "returned", report: composeReport(r, { kind: "returned" }),
    }));
  }

  // A screen that is the owner's to deal with. YOUR TURN, THEN MINE: a
  // phone that can wait for the owner hands over for sign-in, a human
  // check or a permission, and carries on after Continue. Everything else,
  // and every older phone, ends here.
  const handOver = async (found, extra = {}) => {
    await save(userId, r, { steps: r.steps, ...extra });
    if (proto && OWNER_KINDS.has(found.kind)) {
      const report = say.ownerStep(found.kind, r);
      if (!await save(userId, r, { status: "waiting_owner", handoff_kind: found.kind, report },
        { onlyIf: ["running"] })) return reply(await current(userId, r.id));
      return { status: "owner_step", kind: found.kind, report, step: delivered(r.steps).length };
    }
    return reply(await end(userId, r, "handoff", {
      kind: found.kind, report: composeReport(r, { kind: found.kind }),
    }));
  };
  // A payment app, a permission pop-up or the installer is known by its
  // package alone — before the checks below, which would read a payment
  // app's hidden screen as the run's own app blocking assistants.
  const byPkg = guard.checkPackage(pkg);
  if (byPkg) return handOver(byPkg);

  // THE APP ITSELF KEEPS ASSISTANTS OUT (or the phone locked): said
  // plainly, before any waiting and before any model call.
  const lim = limits.classify(r, screen);
  if (lim) {
    await save(userId, r, { steps: r.steps });
    return reply(await end(userId, r, lim.status, {
      kind: lim.kind, report: lim.kind === "locked" ? say.locked() : say.blocked(lim.kind, r),
    }));
  }
  if (!r.web && !r.app_pkg && pkg && r.app_name) await save(userId, r, { app_pkg: pkg });
  // A web run keeps the browser it is in: after a question to the owner
  // the run resumes there (directive pkg). Without it the phone was handed
  // no app and no link, and "What is your father's name?" ended the form
  // (audit, 2026-09-27). The phone makers' own browsers (com.vivo.browser,
  // com.heytap.browser, com.mi.globalbrowser) are not in the list: they
  // are known by the name, or their web runs could not resume either.
  if (r.web && !r.app_pkg && (guard.BROWSERS.includes(pkg) || /browser/i.test(pkg))) {
    await save(userId, r, { app_pkg: pkg });
  }

  if (r.steps.length >= MAX_STEPS) {
    await save(userId, r, { steps: r.steps });
    return reply(await end(userId, r, "failed", {
      report: `${say.lead(r)}This was taking too many steps, so I stopped — you can pick it up from here.`,
    }));
  }

  // Stuck: the same action three times with nothing changing.
  const tail = delivered(r.steps).slice(-3);
  if (tail.length === 3 && tail.every((s) => sameAction(s.action, tail[0].action) &&
      s.result && s.result.changed === false)) {
    await save(userId, r, { steps: r.steps });
    return reply(await end(userId, r, "failed", {
      report: `${say.lead(r)}I got stuck on the same step ${say.at(r)}, so I stopped for you to take over.`,
    }));
  }

  // NOTHING TO SEE: no elements and no screenshot. Waiting costs no
  // model call; three blank looks in a row is an honest failure, not a
  // reason to start re-opening the app.
  const blank = !(screen?.nodes || []).length && !screen?.shot;
  if (blank) {
    const tailBlank = delivered(r.steps).slice(-2).every((st) => st.action?.type === "wait" && st.blank);
    if (delivered(r.steps).length >= 2 && tailBlank) {
      await save(userId, r, { steps: r.steps });
      return reply(await end(userId, r, "failed", {
        report: `${say.lead(r)}I couldn't read ${say.app(r)}'s screen, so I stopped rather than guess.`,
      }));
    }
    // What the phone could see on this look, so the next look can tell
    // "an app that gives assistants nothing" from a slow first draw.
    const look = screen?.access ? { tree: screen.access.tree, shot: screen.access.shot } : null;
    const steps = [...r.steps, { action: { type: "wait" }, expect: "the screen to load", blank: true, ...(look ? { look } : {}) }];
    if (!await save(userId, r, { steps }, { onlyIf: ["running"] })) return reply(await current(userId, r.id));
    return { status: "continue", action: { type: "wait" }, expect: "the screen to load", step: delivered(steps).length };
  }

  // STILL LOADING (guard.stillLoading, 2026-09-26): waited out with no
  // model call, for up to four looks; after that the planner decides.
  if (guard.stillLoading(screen)) {
    const recent = delivered(r.steps).slice(-4);
    if (!(recent.length === 4 && recent.every((st) => st.action?.type === "wait" && st.loading))) {
      const steps = [...r.steps, { action: { type: "wait" }, expect: "the page to finish loading", loading: true }];
      if (!await save(userId, r, { steps }, { onlyIf: ["running"] })) return reply(await current(userId, r.id));
      return { status: "continue", action: { type: "wait" }, expect: "the page to finish loading", step: delivered(steps).length };
    }
  }

  // Opening the same app again and again is a loop, not progress.
  const reopens = delivered(r.steps).filter((st) => st.action?.type === "open_app").map((st) => String(st.action.name || "").toLowerCase());
  if (reopens.length >= 3 && new Set(reopens.slice(-3)).size === 1) {
    await save(userId, r, { steps: r.steps });
    return reply(await end(userId, r, "failed", {
      report: `${say.lead(r)}${say.pretty(reopens[reopens.length - 1])} kept not responding, so I stopped instead of going round in circles.`,
    }));
  }

  // The screen itself can be a line we never cross.
  const onScreen = guard.checkScreen(screen);
  if (onScreen) return handOver(onScreen);

  const owner = await ownerFor(userId, r.id);
  const opts = { installApp: installApp(r) };
  let calls = r.llm_calls || 0;
  let notes = r.notes;
  let d = null;
  // RECIPES FIRST (automation/recipes.js). A flow the owners repeat, on a
  // screen the recipe recognises exactly, takes its next step from the
  // recipe — no model call. A screen it does not know, a recipe step that
  // did not move the screen, or one the guard refuses: the planner below
  // decides, exactly as before. Owner, 2026-09-25: "multiple API calls …
  // glitches … sometimes we get stuck".
  const fromRecipe = recipes.next(r, screen);
  if (fromRecipe && !(fromRecipe.status === "continue" && refusal(fromRecipe.action, screen, opts, r.steps))) {
    d = fromRecipe;
    meta.recipe = fromRecipe.recipe;
  }
  // A REFUSED STEP IS A FAILED STEP, NOT THE END. A veto used to end the
  // run on the spot with the payment sentence — "It's ready for payment"
  // after the planner tapped a "Buy 2 at ₹99" card with nothing in the
  // cart (2026-09-24). Now the refusal is written into the history, the
  // planner picks another way at once, and only a second refusal in the
  // run hands over, naming exactly what was refused.
  if (!d) for (;;) {
    d = await planner.decide(r, screen, {
      hints: hintsFor(r.category, { web: r.web }),
      owner,
      maxSteps: MAX_STEPS,
      deadline,
    });
    calls++;
    const u = d.usage || {};
    meta.llm_ms = (meta.llm_ms || 0) + (u.llm_ms || 0);
    meta.in_tok = (meta.in_tok || 0) + (u.in_tok || 0);
    meta.calls = (meta.calls || 0) + (u.calls || 0);
    if (u.estimated) meta.estimated = true;
    // How the call was made, for the step's log line: the thinking level
    // (a re-plan after a refusal thinks one level higher), the picture's
    // resolution and the model — so each change can be measured.
    if (u.thinking) meta.think = meta.think ? `${meta.think}+${u.thinking}` : u.thinking;
    if (u.media) meta.res = u.media;
    if (u.model) meta.model = u.model;
    // The first model could not answer, so the fast one was asked (planner.js).
    if (u.fallback) meta.fallback = u.fallback;
    if (d.note && !notes.some((n) => say.noteText(n) === d.note)) notes = [...notes, { text: d.note, owner: true }];
    if (d.error || d.status !== "continue") break;

    const veto = refusal(d.action, screen, opts, r.steps);
    if (!veto) break;
    // Signing in ("Continue with Google", the number on a sign-in sheet)
    // is not a refusal to route around: it is the owner's turn, and a
    // phone that can wait carries on after Continue.
    if (OWNER_KINDS.has(veto.kind)) return handOver(veto, { notes, llm_calls: calls });
    const action = { ...d.action };
    const label = action.type === "tap_xy" ? action.label
      : action.type === "open_app" ? action.name : labelOf(screen, action.id);
    if (action.id != null) action.what = labelOf(screen, action.id);
    const { seen: _never, ...refusedStep } = stepRecord(action, d.expect, screen, {
      vetoed: veto.kind, target: targetOf(action, screen),
      result: { ok: false, changed: false, error: `refused: "${String(label || action.type).slice(0, 60)}" — ${veto.reason}` },
    });
    const steps = [...r.steps, refusedStep];
    if (!await save(userId, r, { steps, notes, llm_calls: calls }, { onlyIf: ["running"] })) {
      return reply(await current(userId, r.id));
    }
    if (steps.filter((s) => s.vetoed).length >= MAX_VETOES) {
      return reply(await end(userId, r, "handoff", { kind: veto.kind, report: say.refused(r, action, veto.kind) }));
    }
    if (deadline - Date.now() < MIN_REPLAN_MS) {
      // No time to think again inside this request: a short wait, and the
      // next look plans with the refusal in view.
      const next = [...r.steps, stepRecord({ type: "wait" }, "the same screen", screen, { replan: true })];
      if (!await save(userId, r, { steps: next }, { onlyIf: ["running"] })) return reply(await current(userId, r.id));
      return { status: "continue", action: { type: "wait" }, expect: "the same screen", step: delivered(next).length };
    }
  }

  // THE PLANNER COULD NOT BE REACHED (quota, timeout, an unusable answer):
  // one true sentence, and the reason in the log — it used to be read out
  // as a planner note or "I've stopped here for you to take over".
  if (d.error) {
    console.warn(`automation planner error run=${r.id}: ${d.error}`);
    // ONE SLOW ANSWER IS NOT THE END (2026-09-26, run 32: both models timed
    // out once, on a page that was still loading). The next look plans
    // again; only a second failure in a row ends the run.
    const last = delivered(r.steps).slice(-1)[0];
    if (!(last && last.action?.type === "wait" && last.plannerRetry)) {
      const steps = [...r.steps, { action: { type: "wait" }, expect: "the same screen", plannerRetry: true }];
      if (!await save(userId, r, { steps, notes, llm_calls: calls }, { onlyIf: ["running"] })) {
        return reply(await current(userId, r.id));
      }
      return { status: "continue", action: { type: "wait" }, expect: "the same screen", step: delivered(steps).length };
    }
    await save(userId, r, { steps: r.steps, notes, llm_calls: calls });
    return reply(await end(userId, r, "failed", { kind: "planner_down", report: say.plannerDown(r) }));
  }

  if (d.status === "continue") {
    const action = { ...d.action };
    if (action.id != null) action.what = labelOf(screen, action.id);
    // Enter is Send in a chat box: only a search-like field is submitted
    // with the keyboard (guard.maySubmit); elsewhere the planner taps the
    // field's own button, which the guard can judge.
    if (action.type === "type" && action.submit && !guard.maySubmit(action, screen)) action.submit = false;
    const target = targetOf(action, screen);
    // A recipe's step is marked, so it can step aside when it stalls and
    // so the model calls it saved can be counted.
    const extra = { ...(target ? { target } : {}), ...(d.recipe ? { recipe: d.recipe } : {}) };
    const steps = [...r.steps, stepRecord(action, d.expect, screen, extra)];
    if (!await save(userId, r, { steps, notes, llm_calls: calls }, { onlyIf: ["running"] })) {
      return reply(await current(userId, r.id));
    }
    return { status: "continue", action, expect: d.expect, step: delivered(steps).length };
  }

  await save(userId, r, { steps: r.steps, notes, llm_calls: calls });
  if (d.status === "ask_user") {
    const q = d.question || "I need one more detail to carry on — what should I use?";
    // Stop pressed while the planner was thinking wins here too: a
    // stopped run must never come back as "waiting for your answer".
    if (!await save(userId, r, { status: "waiting", question: q, report: q }, { onlyIf: ["running"] })) {
      return reply(await current(userId, r.id));
    }
    return { status: "waiting", question: q, report: q, step: delivered(r.steps).length };
  }
  if (d.status === "done" || d.status === "handoff") {
    // NO CLAIM WITHOUT PROOF ON THE SCREEN. A run once reported "added to
    // the cart" while nothing had been added (2026-09-24): now the planner
    // must point at the words on the screen that show it, and a claim
    // after taps that changed nothing is not believed either.
    const recentSteps = delivered(r.steps).slice(-3).filter((st) => st.result);
    const nothingChanged = recentSteps.length >= 2 &&
      recentSteps.every((st) => st.result.ok === false || st.result.changed === false);
    if (nothingChanged || !proven(d.evidence, screen, r)) {
      return reply(await end(userId, r, "unconfirmed", { report: say.unconfirmed(r) }));
    }
  }
  if (d.status === "done") {
    return reply(await end(userId, r, "done", {
      report: say.clean(d.report) || `${say.lead(r)}Done ${say.at(r)}.`,
    }));
  }
  if (d.status === "handoff") {
    return reply(await end(userId, r, "handoff", { kind: "ready", report: composeReport(r, { model: d.report, kind: "other" }) }));
  }
  return reply(await end(userId, r, "failed", {
    report: say.clean(d.report) || `${say.lead(r)}I couldn't finish that ${say.at(r)}.`,
  }));
}

/**
 * THE RUN WAITING FOR THE OWNER'S ANSWER, if one asked in the last ten
 * minutes. "Paradise or Meghana?" answered "order from Meghana on Swiggy"
 * used to start a SECOND run while the first waited for ever; a short
 * answer ("the veg one") depended on the model remembering the run_id.
 * The owner's next words resume this run instead (intent.resumeFor).
 */
const WAITING_FRESH_MS = 10 * 60_000;
async function waitingRun(userId) {
  if (!(Number(userId) > 0)) return null;
  return hydrate(await one(
    `SELECT * FROM automation_runs
      WHERE user_id=$1 AND status='waiting' AND updated_at > $2
      ORDER BY id DESC LIMIT 1`,
    [Number(userId), Date.now() - WAITING_FRESH_MS]));
}

/** The run as it stands, when a step lost the race to Stop. */
async function current(userId, runId) {
  const now = await get(userId, runId);
  return { status: now?.status || "failed", report: now?.report || "", handoff_kind: now?.handoff_kind || "",
    step: delivered(now?.steps).length };
}

/**
 * The phone stopped the run on its own: the owner pressed Stop, the
 * accessibility permission is off, the phone's guard refused a step, the
 * app itself keeps assistants out, or the app went away. Terminal runs
 * are left as they are.
 */
const DEVICE_REASONS = {
  stopped: ["stopped", "", "Stopped, as you asked."],
  no_permission: ["failed", "", "I need the one-time \"use other apps\" permission to do that — it's in the setup screen I opened."],
  returned: ["stopped", "returned", ""],
  blocked: ["handoff", "payment", ""],
  blocked_by_app: ["blocked", "", ""],
  left_app: ["handoff", "left_app", ""],
  not_installed: ["failed", "", ""],
  error: ["failed", "", ""],
};

async function finish(userId, runId, { reason = "error", kind = "", detail = "" } = {}) {
  const r = await get(userId, runId);
  if (!r) return { status: "failed", report: "That task no longer exists." };
  const proto = !!r.proto || reason === "blocked_by_app";
  if (TERMINAL.has(r.status)) return forPhone({ status: r.status, report: r.report }, proto);
  const [status, defKind, text] = DEVICE_REASONS[reason] || DEVICE_REASONS.error;
  let k = kind || defKind;
  let report = text;
  if (!report) {
    if (reason === "blocked_by_app") {
      k = limits.KINDS.has(k) ? k : "no_access";
      report = say.blocked(k, r);
    } else if (reason === "blocked") {
      // Two different things. A build-105 phone whose own guard refused
      // the step it was handed (its second refusal) says so — detail
      // "refused" — and that step is named. Otherwise a never-act app
      // (payment, permission, installer) came to the front after a step
      // that WAS done, and that is what the owner hears; a build-104 phone
      // cannot tell the two apart, so it keeps today's sentence.
      const d = delivered(r.steps);
      const pending = d[d.length - 1];
      if (r.proto && detail === "refused" && pending && !pending.result) {
        const kk = k || "payment";
        pending.result = { ok: false, changed: false, error: `blocked:${kk}`, blocked: kk };
        await save(userId, r, { steps: r.steps }, { onlyIf: LIVE });
        report = say.refused(r, pending.action, kk);
      } else {
        report = composeReport(r, { kind: k || "payment" });
      }
    } else if (reason === "returned") report = composeReport(r, { kind: k || "payment" });
    else if (reason === "left_app") report = `${say.lead(r)}Another screen took over from ${say.app(r)}, so I stopped there.`;
    // The owner, 2026-09-26: "it's saying Zomato is not present, but it
    // should ask should I install it". Build 115 asks inside the
    // conversation before the task starts; an older phone only has this
    // report, so it says how to get either outcome.
    else if (reason === "not_installed") {
      const name = say.pretty(r.app_label);
      report = name
        ? `${name} isn't installed on your phone. Say "install ${name}" and I'll get it, ` +
          `or tell me another app to use.`
        : "That app isn't installed on your phone. Tell me another app to use.";
    }
    else report = `${say.lead(r)}${say.deviceFailure(detail, r)}`;
  }
  return forPhone(await end(userId, r, status, { kind: k, report: report.trim() }), proto);
}

module.exports = {
  migrate, start, resume, step, finish, ownerDone, get, recent, directive, waitingRun, sweep,
  composeReport, forPhone, MAX_STEPS, DAILY_RUNS, STEP_BUDGET_MS,
};
