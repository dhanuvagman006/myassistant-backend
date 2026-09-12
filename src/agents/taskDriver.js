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
 * task RUNNING, so nothing is lost — the work resumes on the next crank.
 */
const tasks = require("./tasks");

/** A conversation can wait about this long before the silence is rude. */
const TURN_BUDGET_MS = 22_000;

/**
 * Step a task until it finishes, blocks, or runs out of time.
 *
 * Returns { task, ranSteps, exhausted } — `exhausted` true means the
 * budget ended it, not the plan, so the caller should say so rather than
 * implying the work stopped.
 */
async function runWithin(userId, taskId, ctx = {}, opts = {}) {
  const budgetMs = Number(opts.budgetMs) || TURN_BUDGET_MS;
  const maxSteps = Number(opts.maxSteps) || tasks.MAX_STEPS;
  const deadline = Date.now() + budgetMs;

  let task = await tasks.get(userId, taskId);
  let ranSteps = 0;

  for (let i = 0; i < maxSteps; i++) {
    if (Date.now() >= deadline) {
      return { task, ranSteps, exhausted: true };
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
function summarise(task, { exhausted = false } = {}) {
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
    return `${done} of ${total} done so far — still working on the rest.`;
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
};
