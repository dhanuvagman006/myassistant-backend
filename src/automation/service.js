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
 */
const { query, one, run: exec } = require("../db");
const guard = require("./guard");
const prefs = require("./prefs");
const { hintsFor } = require("./hints");
// Looked up at call time so tests can stub the model behind it.
const planner = require("./planner");

const MAX_STEPS = 30;
// The assistant's own app: the owner coming back to it ends the run.
const OWN_PKG = "com.myassistant.myassistant";
const DAILY_RUNS = 40;
const TERMINAL = new Set(["done", "handoff", "failed", "stopped"]);
const DAY = 24 * 3600 * 1000;

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
      -- running | waiting (a question for the owner) | done | handoff |
      -- failed | stopped (the owner pressed Stop)
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
  `);
}

const parse = (v, fb) => { try { return JSON.parse(v); } catch (_) { return fb; } };

function hydrate(r) {
  if (!r) return null;
  return {
    ...r,
    id: Number(r.id),
    web: !!r.web,
    steps: parse(r.steps, []),
    notes: parse(r.notes, []),
    answers: parse(r.answers, []),
  };
}

async function get(userId, id) {
  return hydrate(await one(
    `SELECT * FROM automation_runs WHERE user_id=$1 AND id=$2`, [userId, Number(id)]));
}

async function recent(userId, limit = 10) {
  const rows = await query(
    `SELECT id, goal, app_label, status, handoff_kind, report, question, created_at, updated_at
       FROM automation_runs WHERE user_id=$1 ORDER BY id DESC LIMIT $2`,
    [userId, Math.min(Number(limit) || 10, 30)]);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

async function save(userId, r, fields) {
  const sets = [];
  const vals = [userId, r.id];
  let i = 3;
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k}=$${i++}`);
    vals.push(["steps", "notes", "answers"].includes(k) ? JSON.stringify(v) : v);
  }
  sets.push(`updated_at=$${i}`);
  vals.push(Date.now());
  await exec(`UPDATE automation_runs SET ${sets.join(", ")} WHERE user_id=$1 AND id=$2`, vals);
  Object.assign(r, fields);
}

/** What the phone needs to start (or resume) a run. */
function directive(r, { resume = false } = {}) {
  return {
    type: "automate",
    run_id: r.id,
    goal: r.goal,
    app: r.app_label || r.app_name,
    app_name: r.app_name,
    pkg: r.app_pkg,
    start_url: resume ? "" : r.start_url,
    web: r.web,
    // The whole phone: any app except money apps, the installer and
    // permission pop-ups (the phone enforces those itself).
    any: true,
    allowed: r.web ? guard.BROWSERS : (r.app_pkg ? [r.app_pkg] : []),
    max_steps: MAX_STEPS,
    resume,
  };
}

/* ------------------------------------------------------------------ *
 * START / RESUME
 * ------------------------------------------------------------------ */

async function start(userId, { goal, category = "", app = "", url = "", query = "" } = {}) {
  const g = String(goal || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!g) return { ok: false, error: "what should I do? (goal required)" };

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
  }
  // A start link only ever opens INSIDE the chosen app (the phone pins the
  // package), so a link the app doesn't understand just opens the app.
  let startUrl = web ? link : (/^https?:\/\//i.test(link) ? link : "");
  // INTENT FIRST: the app's own search link lands on the results in one
  // jump; the hands take over from there (automation/intents.js).
  const notes = [];
  if (!web && !startUrl && pick?.name) {
    const jump = require("./intents").startLink(pick.name, String(category || "").toLowerCase(), g, query);
    if (jump) {
      startUrl = jump.url;
      notes.push(`Opened ${pick.label} straight on its search results for "${jump.query}" — no need to search again.`);
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

async function resume(userId, runId, answer) {
  const r = await get(userId, runId);
  if (!r) return { ok: false, error: "no such task" };
  if (r.status !== "waiting") {
    return { ok: false, error: `that task is already ${r.status}` };
  }
  const a = String(answer || "").trim().slice(0, 400);
  if (!a) return { ok: false, needsArgs: ["answer"] };
  const answers = [...r.answers, { q: r.question, a }];
  // Asked once, never again: the next form finds it in memory.
  await prefs.rememberAnswer(userId, r.question, a).catch(() => false);
  await save(userId, r, { answers, status: "running", question: "" });
  return { ok: true, run: r, directive: directive(r, { resume: true }) };
}

/* ------------------------------------------------------------------ *
 * STEP
 * ------------------------------------------------------------------ */

const sameAction = (a, b) => a && b && a.type === b.type && a.id === b.id &&
  (a.text || "") === (b.text || "") && (a.direction || "") === (b.direction || "") &&
  (a.name || "") === (b.name || "");

function labelOf(screen, id) {
  const n = (screen?.nodes || []).find((x) => Number(x.id) === Number(id));
  return n ? String(n.text || n.desc || n.label || n.hint || "").slice(0, 60) : "";
}

/** The owner's report: what was chosen, then what happened. */
function composeReport(r, { kind = "", model = "" } = {}) {
  const parts = [];
  if (model) parts.push(model);
  else if (r.notes.length) parts.push(r.notes.slice(-2).join(" "));
  if (kind && !model) parts.push(guard.handoffSentence(kind, r.app_label));
  return parts.join(" ").replace(/\s+/g, " ").trim() ||
    guard.handoffSentence(kind || "other", r.app_label);
}

async function end(userId, r, status, { kind = "", report = "" } = {}) {
  const text = String(report || "").slice(0, 600);
  await save(userId, r, { status, handoff_kind: kind, report: text });
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
  return { status, handoff_kind: kind, report: text, step: r.steps.length };
}

/**
 * One turn of the loop.
 * @param screen {pkg, nodes:[...], keyboard}
 * @param last   {ok, changed, error} — how the previous action went
 */
async function step(userId, runId, { screen, last } = {}) {
  const r = await get(userId, runId);
  if (!r) return { status: "failed", report: "That task no longer exists." };
  if (TERMINAL.has(r.status) || r.status === "waiting") {
    return { status: r.status, report: r.report, question: r.question, step: r.steps.length };
  }

  // The previous action's outcome belongs to the previous step.
  if (last && r.steps.length) {
    const prev = r.steps[r.steps.length - 1];
    if (!prev.result) {
      prev.result = {
        ok: last.ok !== false,
        changed: last.changed !== false,
        ...(last.error ? { error: String(last.error).slice(0, 120) } : {}),
      };
    }
  }

  const pkg = String(screen?.pkg || "");
  // A run may use any app the task needs. Only the owner coming back to
  // the assistant ends it here — they have taken the phone back.
  if (pkg === OWN_PKG) {
    await save(userId, r, { steps: r.steps });
    return end(userId, r, "stopped", {
      kind: "returned", report: composeReport(r, { kind: "returned" }),
    });
  }
  if (!r.web && !r.app_pkg && pkg && r.app_name) await save(userId, r, { app_pkg: pkg });

  if (r.steps.length >= MAX_STEPS) {
    await save(userId, r, { steps: r.steps });
    return end(userId, r, "failed", {
      report: composeReport(r) + " This was taking too many steps, so I stopped — you can pick it up from here.",
    });
  }

  // Stuck: the same action three times with nothing changing.
  const tail = r.steps.slice(-3);
  if (tail.length === 3 && tail.every((s) => sameAction(s.action, tail[0].action) &&
      s.result && s.result.changed === false)) {
    await save(userId, r, { steps: r.steps });
    return end(userId, r, "failed", {
      report: composeReport(r) + ` I got stuck on the same step in ${r.app_label}, so I stopped for you to take over.`,
    });
  }

  // NOTHING TO SEE: no elements and no screenshot. Waiting costs no
  // model call; three blank looks in a row is an honest failure, not a
  // reason to start re-opening the app.
  const blank = !(screen?.nodes || []).length && !screen?.shot;
  if (blank) {
    const tailBlank = r.steps.slice(-2).every((st) => st.action?.type === "wait" && st.blank);
    if (r.steps.length >= 2 && tailBlank) {
      await save(userId, r, { steps: r.steps });
      return end(userId, r, "failed", {
        report: composeReport(r) + ` I couldn't read ${r.app_label}'s screen, so I stopped rather than guess.`,
      });
    }
    const steps = [...r.steps, { action: { type: "wait" }, expect: "the screen to load", blank: true }];
    await save(userId, r, { steps });
    return { status: "continue", action: { type: "wait" }, expect: "the screen to load", step: steps.length };
  }

  // Opening the same app again and again is a loop, not progress.
  const reopens = r.steps.filter((st) => st.action?.type === "open_app").map((st) => String(st.action.name || "").toLowerCase());
  if (reopens.length >= 3 && new Set(reopens.slice(-3)).size === 1) {
    await save(userId, r, { steps: r.steps });
    return end(userId, r, "failed", {
      report: composeReport(r) + ` ${reopens[reopens.length - 1]} kept not responding, so I stopped instead of going round in circles.`,
    });
  }

  // The screen itself can be a line we never cross.
  const onScreen = guard.checkScreen(screen);
  if (onScreen) {
    await save(userId, r, { steps: r.steps });
    return end(userId, r, "handoff", {
      kind: onScreen.kind, report: composeReport(r, { kind: onScreen.kind }),
    });
  }

  const [owner] = await Promise.all([prefs.ownerInfo(userId).catch(() => ({}))]);
  const d = await planner.decide(r, screen, {
    hints: hintsFor(r.category, { web: r.web }),
    owner,
    maxSteps: MAX_STEPS,
  });
  const calls = (r.llm_calls || 0) + 1;
  const notes = d.note && !r.notes.includes(d.note) ? [...r.notes, d.note] : r.notes;

  if (d.status === "continue") {
    const veto = guard.checkAction(d.action, screen);
    if (veto) {
      await save(userId, r, { steps: r.steps, notes, llm_calls: calls });
      return end(userId, r, "handoff", { kind: veto.kind, report: composeReport(r, { kind: veto.kind }) });
    }
    const action = { ...d.action };
    if (action.id != null) action.what = labelOf(screen, action.id);
    const steps = [...r.steps, { action, expect: d.expect }];
    await save(userId, r, { steps, notes, llm_calls: calls });
    return { status: "continue", action, expect: d.expect, step: steps.length };
  }

  await save(userId, r, { steps: r.steps, notes, llm_calls: calls });
  if (d.status === "ask_user") {
    const q = d.question || "I need one more detail to carry on — what should I use?";
    await save(userId, r, { status: "waiting", question: q, report: q });
    return { status: "waiting", question: q, report: q, step: r.steps.length };
  }
  if (d.status === "done") return end(userId, r, "done", { report: composeReport(r, { model: d.report }) });
  if (d.status === "handoff") {
    return end(userId, r, "handoff", { kind: "ready", report: composeReport(r, { model: d.report, kind: "other" }) });
  }
  return end(userId, r, "failed", {
    report: composeReport(r, { model: d.report }) ||
      `I couldn't finish that in ${r.app_label}.`,
  });
}

/**
 * The phone stopped the run on its own: the owner pressed Stop, the
 * accessibility permission is off, the phone's guard refused a step, or
 * the app went away. Terminal runs are left as they are.
 */
const DEVICE_REASONS = {
  stopped: ["stopped", "", "Stopped, as you asked."],
  no_permission: ["failed", "", "I need the one-time \"use other apps\" permission to do that — it's in the setup screen I opened."],
  returned: ["stopped", "returned", ""],
  blocked: ["handoff", "payment", ""],
  left_app: ["handoff", "left_app", ""],
  not_installed: ["failed", "", ""],
  error: ["failed", "", ""],
};

async function finish(userId, runId, { reason = "error", kind = "", detail = "" } = {}) {
  const r = await get(userId, runId);
  if (!r) return { status: "failed", report: "That task no longer exists." };
  if (TERMINAL.has(r.status)) return { status: r.status, report: r.report };
  const [status, defKind, text] = DEVICE_REASONS[reason] || DEVICE_REASONS.error;
  const k = kind || defKind;
  let report = text;
  if (!report) {
    if (reason === "blocked" || reason === "returned") report = composeReport(r, { kind: k || "payment" });
    else if (reason === "left_app") report = composeReport(r) + ` Another screen took over from ${r.app_label}, so I stopped there.`;
    else if (reason === "not_installed") report = `${r.app_label || "That app"} isn't installed on your phone.`;
    else report = composeReport(r) + ` Something went wrong in ${r.app_label || "the app"}${detail ? ` (${String(detail).slice(0, 80)})` : ""}, so I stopped.`;
  }
  return end(userId, r, status, { kind: k, report: report.trim() });
}

module.exports = {
  migrate, start, resume, step, finish, get, recent, directive,
  composeReport, MAX_STEPS, DAILY_RUNS,
};
