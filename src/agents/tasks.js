/**
 * MULTI-STEP TASKS — a plan that outlives the turn that created it.
 * ----------------------------------------------------------------------
 * WHAT WAS MISSING. The runtime was a bounded tool loop: one model call
 * chose tools, up to MAX_TOOL_ROUNDS of them ran, their results were
 * compacted into the prompt, and the turn ended. Nothing about that is
 * wrong for "what's the weather" — but it means the assistant can never
 * COMMIT to a piece of work. There is no artefact that says what it
 * intends to do, no record of which parts are done, and nothing to resume.
 * Ask it to find a restaurant near tomorrow's meeting, book a table, add
 * it to the calendar and tell someone, and the best it can manage is four
 * tool calls inside one breath, with no memory of the first three if the
 * fourth needs a confirmation.
 *
 * THIS FILE IS THE ARTEFACT. A Task is a persisted plan: an ordered list
 * of steps, each naming a tool, its arguments, why it is there, and what
 * it depends on. The STEPPER executes one runnable step at a time through
 * the ordinary registry — so every gate, every repeat guard, every
 * confirmation and every audit line that already exists applies unchanged.
 *
 * THREE RULES THAT MATTER MORE THAN THE REST:
 *
 *  1. A step that needs a person PARKS the task; it does not fail it.
 *     Confirmation, a missing argument, a permission — all of these mean
 *     "waiting", and a task that has done three of four things must say so
 *     rather than reporting failure and losing the three.
 *
 *  2. A DISPATCHED step is not a finished step. Handing an envelope to the
 *     phone is not the same as the phone having done it, so the task waits
 *     for the receipt instead of marching on. Treating dispatch as success
 *     is how "I opened YouTube" got said about an envelope that was
 *     dropped.
 *
 *  3. THE STEPPER NEVER RETRIES A WORLD ACTION. Per-tool retry policy is
 *     declared in the contract and enforced in the registry, which knows
 *     whether repeating is safe. A second opinion here would double a
 *     message send.
 */
const { query, one, run } = require("../db");
const contract = require("../tools/contract");

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id          BIGSERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        goal        TEXT    NOT NULL,
        status      TEXT    NOT NULL DEFAULT 'running',
        steps       TEXT    NOT NULL DEFAULT '[]',
        cursor      INTEGER NOT NULL DEFAULT 0,
        blocked_on  TEXT    NOT NULL DEFAULT '',
        session_id  TEXT    NOT NULL DEFAULT '',
        turn_id     TEXT    NOT NULL DEFAULT '',
        surface     TEXT    NOT NULL DEFAULT '',
        error       TEXT    NOT NULL DEFAULT '',
        created_at  BIGINT  NOT NULL,
        updated_at  BIGINT  NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_tasks_user ON agent_tasks (user_id, status, created_at DESC);
    `).catch((e) => { migrated = null; throw e; });
  }
  return migrated;
}

const STATUS = Object.freeze({
  RUNNING: "running",   // at least one step left to run
  BLOCKED: "blocked",   // waiting on a person or on the phone
  DONE: "done",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

const STEP = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  WAITING: "waiting",   // needs a person: confirmation, a missing argument
  DISPATCHED: "dispatched", // sent to the phone, awaiting its receipt
  SKIPPED: "skipped",   // a dependency failed, so this can no longer apply
});

/** Hard ceilings. A plan that cannot finish must stop, not spin. */
const MAX_STEPS = 12;
const MAX_TOTAL_ATTEMPTS = 24;

function parse(s, fallback) {
  try { return JSON.parse(s || ""); } catch (_) { return fallback; }
}

/* ------------------------------------------------------------------ */
/* CREATE                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {number} userId
 * @param {string} goal   the user's own words — what this task is FOR
 * @param {Array}  steps  [{tool, args, why?, dependsOn?:[index]}]
 */
async function create(userId, goal, steps, meta = {}) {
  await migrate();
  if (!Array.isArray(steps) || steps.length === 0) {
    throw Object.assign(new Error("a task needs at least one step"), { code: "empty_plan" });
  }
  if (steps.length > MAX_STEPS) {
    throw Object.assign(
      new Error(`a plan may have at most ${MAX_STEPS} steps, got ${steps.length}`),
      { code: "plan_too_long" }
    );
  }
  const registry = require("../tools/registry");
  const normalized = steps.map((s, i) => {
    const tool = registry.get(s.tool);
    if (!tool) {
      throw Object.assign(
        new Error(`step ${i + 1} names "${s.tool}", which is not a registered tool`),
        { code: "unknown_tool" }
      );
    }
    // A dependency must point BACKWARDS. A forward or self reference would
    // deadlock the stepper, and a model will produce one eventually.
    const deps = (Array.isArray(s.dependsOn) ? s.dependsOn : [])
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d));
    for (const d of deps) {
      if (d >= i || d < 0) {
        throw Object.assign(
          new Error(`step ${i + 1} depends on step ${d + 1}, which does not come before it`),
          { code: "bad_dependency" }
        );
      }
    }
    return {
      i,
      tool: s.tool,
      args: s.args && typeof s.args === "object" ? s.args : {},
      why: String(s.why || "").slice(0, 300),
      dependsOn: deps,
      status: STEP.PENDING,
      outcome: null,
      result: null,
      error: "",
      attempts: 0,
    };
  });

  const now = Date.now();
  const row = await one(
    `INSERT INTO agent_tasks (user_id, goal, status, steps, cursor, session_id, turn_id, surface, created_at, updated_at)
     VALUES ($1,$2,$3,$4,0,$5,$6,$7,$8,$8) RETURNING *`,
    [userId, String(goal || "").slice(0, 1000), STATUS.RUNNING, JSON.stringify(normalized),
     String(meta.sessionId || ""), String(meta.turnId || ""), String(meta.surface || ""), now]
  );
  return toClient(row);
}

/* ------------------------------------------------------------------ */
/* READ                                                               */
/* ------------------------------------------------------------------ */

async function get(userId, id) {
  await migrate();
  const row = await one("SELECT * FROM agent_tasks WHERE id = $1 AND user_id = $2", [id, userId]);
  return row ? toClient(row) : null;
}

async function listOpen(userId, limit = 20) {
  await migrate();
  const rows = await query(
    `SELECT * FROM agent_tasks WHERE user_id = $1 AND status IN ('running','blocked')
      ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows.map(toClient);
}

async function listRecent(userId, limit = 20) {
  await migrate();
  const rows = await query(
    "SELECT * FROM agent_tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
    [userId, limit]
  );
  return rows.map(toClient);
}

/* ------------------------------------------------------------------ */
/* ARGUMENT WIRING — how step N uses step M's output                   */
/* ------------------------------------------------------------------ */

/**
 * Resolve `{$from: <stepIndex>, path: "a.b.0.c"}` placeholders in a step's
 * arguments against what earlier steps returned.
 *
 * This is what makes a plan a plan rather than four unrelated calls: the
 * planner does not have to know the restaurant's phone number in advance,
 * it only has to say "the number from step 2". Missing references are
 * reported rather than silently becoming undefined, because a booking made
 * with an undefined phone number is worse than one not made.
 */
function resolveArgs(args, steps) {
  const missing = [];

  const dig = (obj, path) => {
    if (!path) return obj;
    let cur = obj;
    for (const key of String(path).split(".")) {
      if (cur === null || cur === undefined) return undefined;
      cur = Array.isArray(cur) && /^\d+$/.test(key) ? cur[Number(key)] : cur[key];
    }
    return cur;
  };

  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      if (Object.prototype.hasOwnProperty.call(v, "$from")) {
        const src = steps[Number(v.$from)];
        if (!src || src.status !== STEP.DONE) {
          missing.push(`step ${Number(v.$from) + 1} has not produced a result yet`);
          return undefined;
        }
        // Look in the tool's own payload first, then the whole envelope.
        const from = src.result || {};
        let got = dig(from.data !== undefined ? from.data : from, v.path);
        if (got === undefined) got = dig(from, v.path);
        if (got === undefined) {
          missing.push(`step ${Number(v.$from) + 1} produced no "${v.path || "value"}"`);
        }
        return got;
      }
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, walk(val)]));
    }
    return v;
  };

  const resolved = walk(args);
  return { args: resolved, missing };
}

/* ------------------------------------------------------------------ */
/* THE STEPPER                                                         */
/* ------------------------------------------------------------------ */

/** The next step that can run: pending, with every dependency done. */
function nextRunnable(steps) {
  for (const s of steps) {
    if (s.status !== STEP.PENDING) continue;
    const deps = s.dependsOn || [];
    if (deps.some((d) => steps[d] && steps[d].status !== STEP.DONE)) continue;
    return s;
  }
  return null;
}

/** A step whose dependency failed can never run — mark it, don't leave it. */
function cascadeSkips(steps) {
  let changed = false;
  for (const s of steps) {
    if (s.status !== STEP.PENDING) continue;
    const dead = (s.dependsOn || []).some(
      (d) => steps[d] && [STEP.FAILED, STEP.SKIPPED].includes(steps[d].status)
    );
    if (dead) {
      s.status = STEP.SKIPPED;
      s.error = "an earlier step it depended on did not succeed";
      changed = true;
    }
  }
  return changed;
}

function statusFor(steps) {
  if (steps.some((s) => [STEP.WAITING, STEP.DISPATCHED].includes(s.status))) return STATUS.BLOCKED;
  if (steps.some((s) => s.status === STEP.PENDING || s.status === STEP.RUNNING)) return STATUS.RUNNING;
  if (steps.some((s) => s.status === STEP.FAILED)) return STATUS.FAILED;
  return STATUS.DONE;
}

/**
 * Run ONE step of a task and persist the result.
 *
 * Returns {task, step, ran}. `ran` is false when there was nothing
 * runnable — the caller uses that to stop looping.
 *
 * @param {object} ctx  the turn context, passed through to registry.execute
 *   untouched so every gate behaves exactly as it does in a normal turn.
 */
async function step(userId, taskId, ctx = {}) {
  await migrate();
  const task = await get(userId, taskId);
  if (!task) throw Object.assign(new Error("no such task"), { code: "no_task" });
  if ([STATUS.DONE, STATUS.FAILED, STATUS.CANCELLED].includes(task.status)) {
    return { task, step: null, ran: false };
  }

  const steps = task.steps;
  const totalAttempts = steps.reduce((n, s) => n + (s.attempts || 0), 0);
  if (totalAttempts >= MAX_TOTAL_ATTEMPTS) {
    return save(userId, taskId, steps, STATUS.FAILED,
      `gave up after ${totalAttempts} attempts across the plan`);
  }

  const s = nextRunnable(steps);
  if (!s) {
    if (cascadeSkips(steps)) {
      const t = await save(userId, taskId, steps, statusFor(steps), task.error);
      return { task: t.task, step: null, ran: false };
    }
    const t = await save(userId, taskId, steps, statusFor(steps), task.error);
    return { task: t.task, step: null, ran: false };
  }

  // Wire in whatever earlier steps produced.
  const { args, missing } = resolveArgs(s.args, steps);
  if (missing.length) {
    s.status = STEP.FAILED;
    s.error = missing.join("; ").slice(0, 300);
    cascadeSkips(steps);
    const t = await save(userId, taskId, steps, statusFor(steps), s.error);
    return { task: t.task, step: s, ran: false };
  }

  s.attempts = (s.attempts || 0) + 1;
  s.status = STEP.RUNNING;
  await save(userId, taskId, steps, STATUS.RUNNING, task.error);

  const registry = require("../tools/registry");
  // Execute through the ORDINARY path: every gate, guard, confirmation and
  // audit line that applies in a conversation applies here too. A task must
  // not be a way around the safety machinery.
  const res = await registry.execute(s.tool, args, {
    ...ctx,
    userId,
    taskId,
    stepIndex: s.i,
    intent: ctx.intent || task.goal,
  });

  const outcome = res.status || contract.outcomeOf(res);
  s.outcome = outcome;
  s.result = compactResult(res);

  switch (outcome) {
    case contract.OUTCOME.OK:
    case contract.OUTCOME.SUPPRESSED:
      // A suppressed step already happened — that is a done step, not a
      // failed one. This is exactly the case where the repeat guard fires
      // because an earlier turn already did it.
      s.status = STEP.DONE;
      s.error = "";
      break;
    case contract.OUTCOME.PARTIAL:
      // Unknown, so the plan stops here rather than building on a guess.
      s.status = STEP.WAITING;
      s.error = res.error || "it is not clear whether this completed";
      break;
    case contract.OUTCOME.DISPATCHED:
      s.status = STEP.DISPATCHED;
      break;
    case contract.OUTCOME.NEEDS_USER:
      s.status = STEP.WAITING;
      s.error = res.needsConfirmation
        ? `waiting for approval: ${res.summary || s.tool}`
        : `needs ${(res.needsArgs || []).join(", ")}`;
      break;
    default:
      s.status = STEP.FAILED;
      s.error = String(res.error || "it did not work").slice(0, 300);
      cascadeSkips(steps);
  }

  const blockedOn = s.status === STEP.WAITING || s.status === STEP.DISPATCHED ? s.error || s.tool : "";
  const t = await save(userId, taskId, steps, statusFor(steps), task.error, blockedOn);
  return { task: t.task, step: s, ran: true, result: res };
}

/**
 * Run steps until the task finishes, blocks, or the budget runs out.
 * Bounded by construction: every iteration either advances a step or stops.
 */
async function runToCompletion(userId, taskId, ctx = {}, { maxSteps = MAX_STEPS } = {}) {
  let last = null;
  for (let i = 0; i < maxSteps; i++) {
    last = await step(userId, taskId, ctx);
    if (!last.ran) break;
    if ([STATUS.BLOCKED, STATUS.DONE, STATUS.FAILED, STATUS.CANCELLED].includes(last.task.status)) break;
  }
  return last ? last.task : await get(userId, taskId);
}

/**
 * The phone's receipt for a dispatched step. This is what turns
 * DISPATCHED into a real outcome — without it, a device step would block
 * its task forever.
 */
async function ack(userId, taskId, stepIndex, { ok, detail = "" } = {}) {
  await migrate();
  const task = await get(userId, taskId);
  if (!task) return null;
  const s = task.steps[Number(stepIndex)];
  if (!s || s.status !== STEP.DISPATCHED) return task;
  s.status = ok ? STEP.DONE : STEP.FAILED;
  s.error = ok ? "" : String(detail || "the phone could not do it").slice(0, 300);
  s.outcome = ok ? contract.OUTCOME.OK : contract.OUTCOME.FAILED;
  if (!ok) cascadeSkips(task.steps);
  const t = await save(userId, taskId, task.steps, statusFor(task.steps), task.error);
  return t.task;
}

/** Approval arrived for a waiting step — put it back in the queue. */
async function resume(userId, taskId, stepIndex) {
  await migrate();
  const task = await get(userId, taskId);
  if (!task) return null;
  const s = task.steps[Number(stepIndex)];
  if (!s || s.status !== STEP.WAITING) return task;
  s.status = STEP.PENDING;
  s.error = "";
  const t = await save(userId, taskId, task.steps, STATUS.RUNNING, "", "");
  return t.task;
}

async function cancel(userId, taskId, why = "") {
  await migrate();
  const task = await get(userId, taskId);
  if (!task) return null;
  for (const s of task.steps) {
    if ([STEP.PENDING, STEP.WAITING, STEP.RUNNING].includes(s.status)) {
      s.status = STEP.SKIPPED;
      s.error = "the task was cancelled";
    }
  }
  const t = await save(userId, taskId, task.steps, STATUS.CANCELLED, String(why || "").slice(0, 300), "");
  return t.task;
}

/* ------------------------------------------------------------------ */

async function save(userId, taskId, steps, status, error = "", blockedOn = "") {
  await run(
    `UPDATE agent_tasks SET steps = $1, status = $2, error = $3, blocked_on = $4,
       cursor = $5, updated_at = $6 WHERE id = $7 AND user_id = $8`,
    [JSON.stringify(steps), status, String(error || "").slice(0, 500),
     String(blockedOn || "").slice(0, 300),
     steps.filter((s) => s.status === STEP.DONE).length, Date.now(), taskId, userId]
  );
  return { task: await get(userId, taskId) };
}

/**
 * Keep only what a later step or a human might need. A whole tool envelope
 * can be a document row or a page of search results, and storing all of it
 * on every step would bloat the row past usefulness.
 */
function compactResult(res) {
  if (!res || typeof res !== "object") return null;
  const out = { ok: res.ok !== false };
  if (res.data !== undefined) {
    const json = JSON.stringify(res.data);
    out.data = json && json.length > 4000 ? { truncated: true, preview: json.slice(0, 1200) } : res.data;
  }
  if (res.speak) out.speak = String(res.speak).slice(0, 400);
  if (res.error) out.error = String(res.error).slice(0, 300);
  if (res.deviceAction) out.deviceAction = { type: res.deviceAction.type };
  if (res.summary) out.summary = String(res.summary).slice(0, 300);
  return out;
}

function toClient(r) {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    goal: r.goal,
    status: r.status,
    steps: parse(r.steps, []),
    cursor: Number(r.cursor) || 0,
    blockedOn: r.blocked_on || "",
    sessionId: r.session_id || "",
    turnId: r.turn_id || "",
    surface: r.surface || "",
    error: r.error || "",
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/**
 * One line per step, for the model and for the user. A task the assistant
 * cannot describe is a task the user cannot trust.
 */
function describe(task) {
  const mark = {
    [STEP.DONE]: "done",
    [STEP.FAILED]: "failed",
    [STEP.WAITING]: "waiting",
    [STEP.DISPATCHED]: "sent to the phone",
    [STEP.SKIPPED]: "skipped",
    [STEP.PENDING]: "still to do",
    [STEP.RUNNING]: "running",
  };
  const lines = task.steps.map(
    (s) => `${s.i + 1}. ${s.tool} — ${mark[s.status] || s.status}` +
           (s.error ? ` (${s.error})` : "")
  );
  return `Task "${task.goal}" is ${task.status}.\n${lines.join("\n")}`;
}

module.exports = {
  migrate, STATUS, STEP, MAX_STEPS, MAX_TOTAL_ATTEMPTS,
  create, get, listOpen, listRecent,
  step, runToCompletion, ack, resume, cancel,
  resolveArgs, nextRunnable, statusFor, describe, toClient,
};
