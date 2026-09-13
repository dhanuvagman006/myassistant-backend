/**
 * START_TASK — the tool that lets the assistant COMMIT to a piece of work.
 * ----------------------------------------------------------------------
 * Until now a request was worth at most MAX_TOOL_ROUNDS (3) rounds of tool
 * calls inside a single breath. That is the right shape for "what's the
 * weather" and the wrong shape for "find a decent cafe near tomorrow's
 * meeting, book a table and put it in my calendar": three actions that
 * depend on each other, one of which will stop and ask permission, and
 * nothing anywhere that remembers the first two once it does.
 *
 * This tool hands such a request to the planner and the stepper. What
 * comes back is a persisted plan with a status the user can be shown, that
 * survives a confirmation, and that reports what ACTUALLY ran rather than
 * what was intended.
 *
 * IT IS DELIBERATELY LOW RISK ITSELF. Starting a plan is not dangerous;
 * the steps are, each according to its own tool, each gated individually
 * by the registry exactly as it would be in conversation. Marking this
 * tool high-risk would ask the user to approve "a plan" — a thing they
 * cannot evaluate — and then never ask about the call it was going to
 * place.
 */
const registry = require("../tools/registry");
const contract = require("../tools/contract");
const planner = require("./planner");
const tasks = require("./tasks");
const driver = require("./taskDriver");

let registered = false;

function registerTaskTools() {
  if (registered) return;
  registered = true;

  registry.register({
    name: "start_task",

    // ── DARK, 2026-09-13, after breaking the phone's actions in production.
    //
    // A plan step's deviceAction NEVER REACHES THE PHONE. tasks.js keeps
    // only `{type}` of the envelope (compactResult) and there is no path
    // from a step's result to the client — the runtime only forwards
    // deviceActions from the tool THE MODEL called, and that tool is
    // start_task, whose own result carries none.
    //
    // So 26 of 97 tools — order_food, open_service_app, play_music,
    // start_navigation, present_text, generate_image among them — did
    // nothing at all inside a plan, and then blocked it forever waiting
    // for a receipt: the step goes DISPATCHED, and nothing in the app
    // calls POST /tasks/:id/ack. Reported as "not opening swiggy",
    // "repeated the same errors" and "said it out loud five times", which
    // is exactly what a hung plan plus a retrying model produces.
    //
    // The stepper, planner, driver, routes and 27 checks all stay. What is
    // missing is delivery, and it is not a small piece: a step's envelope
    // has to reach whichever surface started the plan, the phone has to
    // ack it against the task, and the ack has to turn the crank. Until
    // that exists end to end and is verified ON THE DEVICE, this tool is
    // not offered — `available` is what registry.declarations() filters
    // on, so the model cannot see or select it.
    available: () => false,

    description:
      "Take on a piece of work that needs SEVERAL actions in order, and " +
      "carry it out. Use this when one request needs three or more tools, " +
      "when a later action needs something an earlier one finds out, or " +
      "when the work will have to pause for the user's approval partway " +
      "through — 'research X and write it up and save it', 'find a " +
      "restaurant near my 7pm meeting and book it', 'look up these three " +
      "things and give me a summary I can send'.\n" +
      "Give the goal in the USER'S OWN WORDS. A plan is made for you, run " +
      "step by step, and you are told what finished and what did not. " +
      "DO NOT use it for a single action — call that tool directly, it is " +
      "faster. DO NOT use it to answer a question you can simply answer.",
    risk: "low",
    // Planning is one model call; the steps are whole tools. The driver
    // stops itself well before this, so hitting the tool timeout means
    // something genuinely hung rather than a plan being long.
    timeoutMs: 120_000,
    inputSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "What the user wants done, in their words. One sentence. This " +
            "is shown back to them as the name of the task.",
        },
      },
      required: ["goal"],
    },

    async execute(args, ctx = {}) {
      const goal = String(args.goal || "").trim();
      if (!goal) return { ok: false, error: "no goal was given" };
      if (!ctx.userId) {
        return { ok: false, error: "a task needs a signed-in user" };
      }

      // ── PLAN ────────────────────────────────────────────────────────
      // The live surface cannot carry a confirmation for one step of a
      // plan (see planner.js) — so a plan made there contains no step
      // that would stop to ask.
      const onLive = ctx.source === "live";
      const planned = await planner.plan(ctx.userId, goal, {
        ...ctx,
        excludeHighRisk: onLive,
      });
      if (!planned.ok) {
        // A refusal to plan is NOT a failure of the request. The model
        // should go and do the thing directly, so the error says so
        // rather than reading as "this cannot be done".
        return {
          ok: false,
          error:
            planned.code === "too_short" || planned.code === "declined"
              ? `this does not need a multi-step plan (${planned.reason}) — just do it directly with the individual tools`
              : `could not plan this: ${planned.reason}`,
          data: { planFailed: planned.code },
        };
      }

      // ── CREATE ──────────────────────────────────────────────────────
      let task;
      try {
        task = await tasks.create(ctx.userId, goal, planned.steps, {
          sessionId: ctx.sessionId || "",
          turnId: ctx.turnId || "",
          surface: ctx.source || (ctx.background ? "background" : "voice"),
        });
      } catch (e) {
        return {
          ok: false,
          error: `the plan was rejected: ${String((e && e.message) || e).slice(0, 200)}`,
        };
      }

      // ── RUN ─────────────────────────────────────────────────────────
      // ctx is passed through untouched so every gate behaves exactly as
      // it does in conversation. Note it does NOT carry approvedStep:
      // the first high-risk step will stop the plan and ask, which is the
      // entire point.
      const { task: finished, exhausted } = await driver.runWithin(
        ctx.userId,
        task.id,
        ctx,
        { budgetMs: Number(ctx.taskBudgetMs) || driver.TURN_BUDGET_MS }
      );

      const steps = (finished && finished.steps) || [];
      const waiting = steps.find((s) => s.status === tasks.STEP.WAITING);
      const speak = driver.summarise(finished, { exhausted });

      // ── A STEP WANTS THE USER ───────────────────────────────────────
      // Raise the ordinary confirmation card. `task` rides along so the
      // approval can be applied to THIS STEP of THIS PLAN and the rest of
      // the work can carry on — re-running the tool on its own would
      // leave the task blocked forever.
      // On live, a parked step must NOT come back as a confirmation
      // request: the model's only way to act on one is to call start_task
      // again, which would re-plan and redo the finished steps. It is told
      // plainly that the plan is waiting and that the remaining step is
      // its own to do, once, in the ordinary way.
      if (waiting && onLive) {
        return {
          ok: false,
          speak,
          error:
            `${speak} That step (${waiting.tool}) needs the user's permission, ` +
            `which this plan cannot ask for. Do NOT call start_task again — ` +
            `the finished steps would be repeated. Ask the user out loud and ` +
            `then do that one step yourself.`,
          data: taskPayload(finished),
        };
      }
      if (waiting && waiting.outcome === contract.OUTCOME.NEEDS_USER && waiting.result) {
        const pendingSummary =
          (waiting.result.data && waiting.result.data.summary) ||
          waiting.result.summary ||
          waiting.error ||
          waiting.tool;
        return {
          ok: false,
          needsConfirmation: true,
          tool: waiting.tool,
          args: waiting.args || {},
          summary: pendingSummary,
          task: { id: finished.id, stepIndex: waiting.i },
          speak,
          data: taskPayload(finished),
        };
      }

      return {
        ok: true,
        speak,
        data: taskPayload(finished, { exhausted }),
      };
    },
  });
}

/**
 * What the model and the app are told about a task. Step-level detail
 * matters: a reply that says "done" about a plan with a failed step is
 * exactly the kind of claim the whole architecture exists to prevent, and
 * the claim checker can only catch it if the truth is in the payload.
 */
function taskPayload(task, { exhausted = false } = {}) {
  if (!task) return null;
  const steps = task.steps || [];
  return {
    task_id: task.id,
    goal: task.goal,
    status: task.status,
    still_working: exhausted || undefined,
    done: steps.filter((s) => s.status === tasks.STEP.DONE).length,
    total: steps.length,
    steps: steps.map((s) => ({
      n: s.i + 1,
      tool: s.tool,
      why: s.why,
      status: s.status,
      error: s.error || undefined,
    })),
  };
}

module.exports = { registerTaskTools, taskPayload };
