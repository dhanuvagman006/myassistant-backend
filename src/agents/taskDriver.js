/**
 * THE TASK DRIVER — what actually turns the stepper's crank.
 * ----------------------------------------------------------------------
 * agents/tasks.js knows how to run ONE step and how to persist what
 * happened. It deliberately does not know when to run, for how long, or
 * what to do when a step comes back needing a person. That policy lives
 * here, because it differs by surface: a voice turn cannot block for two
 * minutes, a background worker happily can.
 *
 * WHY A TIME BUDGET AND NOT JUST A STEP COUNT. tasks.runToCompletion()
 * bounds itself by step count, which is the right guarantee for the
 * executor and the wrong one for a conversation: three steps of
 * deep_research is a minute and a half of silence with the user holding
 * their phone. runWithin() stops at whichever comes first and leaves the
 * task RUNNING, so nothing is lost — and hands it to the job queue
 * (handOff), which is the next crank.
 */
const tasks = require("./tasks");

/** A conversation can wait about this long before the silence is rude. */
const TURN_BUDGET_MS = 22_000;

/**
 * One background crank (task_continue in infra/handlers.js). Nobody is
 * waiting on it, but the queue runs one job at a time: a long plan hands
 * the worker back between cranks rather than holding every scheduled task
 * behind it.
 */
const BACKGROUND_BUDGET_MS = 2 * 60_000;

/**
 * Step a task until it finishes, blocks, or runs out of time.
 *
 * Returns { task, ranSteps, exhausted, handedOff } — `exhausted` true
 * means the budget ended it, not the plan; `handedOff` that the rest is
 * queued to run in the background. The caller says which, rather than
 * implying the work stopped — or that it goes on when it does not.
 *
 * opts.hop — how many background cranks came before this one.
 */
async function runWithin(userId, taskId, ctx = {}, opts = {}) {
  const budgetMs = Number(opts.budgetMs) || TURN_BUDGET_MS;
  const maxSteps = Number(opts.maxSteps) || tasks.MAX_STEPS;
  const deadline = Date.now() + budgetMs;

  let task = await tasks.get(userId, taskId);
  let ranSteps = 0;

  for (let i = 0; i < maxSteps; i++) {
    if (Date.now() >= deadline) {
      const handedOff = await handOff(userId, task, ctx, opts);
      return { task, ranSteps, exhausted: true, handedOff };
    }
    const out = await tasks.step(userId, taskId, ctx);
    task = out.task;
    if (!out.ran) break;
    ranSteps++;
    if (
      [tasks.STATUS.BLOCKED, tasks.STATUS.DONE, tasks.STATUS.FAILED, tasks.STATUS.CANCELLED]
        .includes(task.status)
    ) {
      break;
    }
  }
  return { task, ranSteps, exhausted: false };
}

/**
 * THE NEXT CRANK. Nothing used to turn it: runWithin is called by the
 * turn that started the plan, an approval and a phone's receipt, and no
 * job, sweep or screen ever resumed a RUNNING plan. So a plan the turn's
 * budget cut short was told "still working on the rest" and then sat,
 * half done, forever (audit, 2026-09-27). Now the rest is a durable job
 * that runs on and pushes the outcome.
 *
 * Every crank runs at least one step, so a plan of MAX_STEPS needs at
 * most that many; the ceiling only guards a budget that is never
 * positive. True when the work is queued — the one case in which the
 * caller may promise it continues.
 */
async function handOff(userId, task, ctx = {}, opts = {}) {
  const hop = Number(opts.hop) || 0;
  if (!task || task.status !== tasks.STATUS.RUNNING || hop >= tasks.MAX_STEPS) return false;
  try {
    await require("../infra/jobs").enqueue("task_continue", {
      taskId: task.id,
      hop: hop + 1,
      tzOffsetMin: Number.isFinite(ctx.tzOffsetMin) ? ctx.tzOffsetMin : 330,
      // A scheduled run's consent covered its whole task (tasks.step), so
      // the rest of that task keeps it. A turn's plan has none to keep:
      // a step that needs a yes parks the plan and the push says so.
      approved: ctx.approved === true && ctx.background === true,
    }, { userId });
    return true;
  } catch (e) {
    console.warn(`task ${task.id}: could not queue the rest:`, e.message);
    return false;
  }
}

/**
 * The user approved the step the plan stopped on.
 *
 * THE APPROVAL COVERS ONE STEP. It is passed as `approvedStep`, not as a
 * blanket `approved: true`, because a plan may hold two high-risk steps
 * and one tap must not authorise the second. tasks.step() turns
 * approvedStep into `approved` for that step alone.
 */
async function approveStep(userId, taskId, stepIndex, ctx = {}, opts = {}) {
  const resumed = await tasks.resume(userId, taskId, Number(stepIndex));
  if (!resumed) return null;
  return runWithin(
    userId,
    taskId,
    { ...ctx, approvedStep: Number(stepIndex) },
    opts
  );
}

/** The user declined — the plan stops here rather than pretending. */
async function declineStep(userId, taskId, stepIndex, why = "") {
  return tasks.cancel(
    userId,
    taskId,
    why || "you said no to the step it stopped on"
  );
}

/**
 * The phone reported back on a dispatched step. A receipt is what turns
 * DISPATCHED into a real outcome; without one the step — and the whole
 * task — would sit blocked forever.
 */
async function acknowledge(userId, taskId, stepIndex, { ok, detail = "" } = {}, ctx = {}) {
  const task = await tasks.ack(userId, taskId, Number(stepIndex), { ok, detail });
  if (!task) return null;
  if (task.status !== tasks.STATUS.RUNNING) return { task, ranSteps: 0, exhausted: false };
  return runWithin(userId, taskId, ctx);
}

/**
 * A human sentence about where a task stands.
 *
 * It says what HAPPENED, never what is intended: a plan that did three of
 * four things has to report the three and name the fourth, which is the
 * whole reason a task exists rather than a tool loop.
 */
function summarise(task, { exhausted = false, handedOff = false } = {}) {
  if (!task) return "I couldn't find that task.";
  const steps = task.steps || [];
  const total = steps.length;
  const done = steps.filter((s) => s.status === tasks.STEP.DONE).length;
  const failed = steps.filter((s) => s.status === tasks.STEP.FAILED);
  const waiting = steps.find((s) => s.status === tasks.STEP.WAITING);
  const dispatched = steps.find((s) => s.status === tasks.STEP.DISPATCHED);

  if (task.status === tasks.STATUS.DONE) {
    return `Done — all ${total} step${total === 1 ? "" : "s"} finished.`;
  }
  if (task.status === tasks.STATUS.CANCELLED) {
    return `Stopped after ${done} of ${total}.`;
  }
  if (waiting) {
    return `${done} of ${total} done — I need you for the next one: ${waiting.error || waiting.tool}.`;
  }
  if (dispatched) {
    return `${done} of ${total} done — waiting for your phone to finish ${dispatched.tool}.`;
  }
  if (task.status === tasks.STATUS.FAILED) {
    const why = failed.length ? failed[0].error : task.error;
    return `I got ${done} of ${total} done, then it stopped: ${why || "a step did not work"}.`;
  }
  if (exhausted) {
    // Only a queued crank may be promised (handOff).
    return handedOff
      ? `${done} of ${total} done so far — still working on the rest, and I'll send you the outcome.`
      : `${done} of ${total} done — I ran out of time, and the rest has not run.`;
  }
  return `${done} of ${total} done.`;
}

module.exports = {
  runWithin,
  approveStep,
  declineStep,
  acknowledge,
  summarise,
  TURN_BUDGET_MS,
  BACKGROUND_BUDGET_MS,
};
