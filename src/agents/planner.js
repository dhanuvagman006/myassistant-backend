/**
 * THE PLANNER — turns a goal into a plan the stepper can actually run.
 * ----------------------------------------------------------------------
 * WHAT WAS MISSING. agents/tasks.js is a complete multi-step executor: it
 * persists an ordered plan, runs one step at a time through the ordinary
 * registry, parks on a confirmation instead of failing, waits for the
 * phone's receipt, and resumes. It shipped with one hole in the middle —
 * create() takes `steps` as an argument and NOTHING in the codebase ever
 * produced any. The executor had no author.
 *
 * This file is the author. Given a goal and the tools this particular user
 * can actually run, it asks the model for an ordered plan and returns
 * something tasks.create() will accept, or an honest refusal.
 *
 * THREE THINGS IT REFUSES TO DO:
 *
 *  1. IT PLANS ONLY WITH TOOLS THAT EXIST, FOR THIS USER, RIGHT NOW.
 *     The catalogue comes from registry.declarations({userId}), which has
 *     already dropped everything unavailable, unpermitted, unconfigured or
 *     belonging to another tenant. A planner that invents `send_email`
 *     produces a task that dies on step one, so the model is never shown a
 *     tool it cannot have.
 *
 *  2. IT DOES NOT PLAN ONE-STEP WORK. A plan is an artefact with a cost:
 *     a database row, a stepper, a status the user can be shown. "What's
 *     the weather" does not need one, and wrapping it in a task makes the
 *     assistant slower and stranger for no gain. Fewer than two steps is
 *     returned as a refusal, and the caller falls back to the ordinary
 *     tool loop.
 *
 *  3. IT VALIDATES BEFORE IT RETURNS. Every failure tasks.create() can
 *     throw — unknown tool, forward dependency, over-long plan — is
 *     checked here first, with a specific message, because "unknown_tool"
 *     surfacing from a database insert tells the user nothing.
 */
const registry = require("../tools/registry");
const tasks = require("./tasks");
// Required as a MODULE, not destructured, so a test can replace
// generateWithTools the same way the fulfillment tests replace
// service.resolveBusiness. Destructuring binds at load time and
// would make every planning path untestable without a live model.
const router = require("../services/ai/router");

/**
 * Gemini's function-declaration schema has no honest way to say "an
 * arbitrary object", so a step's arguments come back as a JSON STRING and
 * are parsed here. Declaring `args` as a bare `type: "object"` with no
 * properties gets it silently dropped from the call.
 */
const PLAN_DECLARATION = {
  name: "submit_plan",
  description:
    "Submit the ordered plan for the user's goal, or decline it with a reason.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description:
          "The steps, in the order they should run. Omit entirely when declining.",
        items: {
          type: "object",
          properties: {
            tool: {
              type: "string",
              description: "Exact name of one tool from the catalogue.",
            },
            args_json: {
              type: "string",
              description:
                'The arguments for that tool as a JSON object string, e.g. ' +
                '{"query":"best cafes in Indiranagar"}. Use {} when the tool ' +
                'needs none. To use an EARLIER step\'s output, put ' +
                '{"$from": <zero-based step index>, "path": "field.sub"} ' +
                'in place of the value.',
            },
            why: {
              type: "string",
              description:
                "One short line the user could read: why this step is in the plan.",
            },
            dependsOn: {
              type: "array",
              items: { type: "integer" },
              description:
                "Zero-based indexes of earlier steps that must finish first. " +
                "Must all be smaller than this step's own index.",
            },
          },
          required: ["tool", "args_json", "why"],
        },
      },
      decline: {
        type: "string",
        description:
          "Set ONLY when no worthwhile multi-step plan exists — because the " +
          "goal needs one tool, or none of the available tools can achieve " +
          "it. Say which in one sentence. Leave empty when submitting steps.",
      },
    },
    required: [],
  },
};

function planningSystemPrompt(catalogue) {
  return (
    "You are the planning stage of a personal assistant. You are given a " +
    "user's goal and the complete list of tools that user can run right " +
    "now. You produce an ordered plan and nothing else — you never speak " +
    "to the user and you never do the work yourself.\n\n" +
    "CALL submit_plan EXACTLY ONCE. Never reply with plain text.\n\n" +
    "WHAT MAKES A GOOD PLAN\n" +
    "- Between 2 and " + tasks.MAX_STEPS + " steps. If the goal genuinely " +
    "takes one tool, decline — the assistant will just do it directly.\n" +
    "- Every step names a tool from the catalogue, spelled exactly.\n" +
    "- Order matters. Research before writing. Write before sending.\n" +
    "- Chain steps by REFERENCE, not by guessing. When step 3 needs " +
    "something step 1 found, write {\"$from\":0,\"path\":\"...\"} rather " +
    "than inventing a value. You do not know what step 1 will return, and " +
    "a booking made with an invented phone number is worse than no " +
    "booking.\n" +
    "- Use dependsOn whenever a step needs an earlier one to have " +
    "succeeded, even if it does not read its output.\n\n" +
    "WHAT TO AVOID\n" +
    "- Do not plan steps that merely talk to the user. The assistant " +
    "speaks for itself; a plan is for actions.\n" +
    "- Do not invent tools, arguments or fields. Only what the catalogue " +
    "lists.\n" +
    "- Do not plan around a tool that is missing. If the goal needs " +
    "something you were not given, decline and say what was missing.\n" +
    "- Do not pad. Three good steps beat seven that restate each other.\n\n" +
    "HIGH-RISK STEPS ARE ALLOWED. Anything that spends money, calls a " +
    "person or deletes something will stop and ask the user before it " +
    "runs — you do not need to add a step for asking, and you must not " +
    "avoid such a tool just because it is risky.\n\n" +
    "THE TOOLS AVAILABLE TO THIS USER:\n" +
    catalogue
  );
}

/**
 * A compact catalogue. The full Gemini declarations are far too verbose to
 * paste for 90-odd tools, and the planner only needs to know what each one
 * is for and what it takes.
 */
function catalogueFor(declarations) {
  return declarations
    .map((d) => {
      const props = (d.parameters && d.parameters.properties) || {};
      const required = new Set((d.parameters && d.parameters.required) || []);
      const argList = Object.keys(props)
        .map((k) => (required.has(k) ? `${k}*` : k))
        .join(", ");
      const desc = String(d.description || "")
        .replace(/\s+/g, " ")
        .slice(0, 240);
      return `- ${d.name}(${argList || "—"}): ${desc}`;
    })
    .join("\n");
}

function parseArgs(raw) {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw === "object") return raw;
  try {
    const v = JSON.parse(String(raw));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch (_) {
    return null; // signalled as invalid rather than silently emptied
  }
}

/**
 * Build a plan for [goal].
 *
 * Returns { ok:true, steps } or { ok:false, reason, code }. It never
 * throws for an ordinary planning failure — a goal that cannot be planned
 * is a normal outcome, not an error.
 */
async function plan(userId, goal, ctx = {}) {
  const text = String(goal || "").trim();
  if (!text) return { ok: false, code: "empty_goal", reason: "no goal was given" };

  const declarations = registry.declarations({
    userId,
    deviceCaps: ctx.deviceCaps || null,
    // A device action inside a plan parks the step until the phone sends a
    // receipt. That works, but only on a surface that actually returns
    // one, so the caller decides.
    includeDeviceActions: ctx.includeDeviceActions !== false,
  }).filter((d) => !NEVER_PLANNABLE.has(d.name));

  if (!declarations.length) {
    return { ok: false, code: "no_tools", reason: "no tools are available to this user" };
  }

  let out;
  try {
    out = await router.generateWithTools({
      contents: [{ role: "user", parts: [{ text: `GOAL: ${text}` }] }],
      system: planningSystemPrompt(catalogueFor(declarations)),
      declarations: [PLAN_DECLARATION],
    });
  } catch (e) {
    return {
      ok: false,
      code: "planner_unavailable",
      reason: String((e && e.message) || e).slice(0, 200),
    };
  }

  const call = (out.functionCalls || []).find((c) => c.name === "submit_plan");
  if (!call) {
    return {
      ok: false,
      code: "no_plan",
      reason: "the planner did not produce a plan",
    };
  }

  const declined = String(call.args.decline || "").trim();
  const rawSteps = Array.isArray(call.args.steps) ? call.args.steps : [];
  if (declined && !rawSteps.length) {
    return { ok: false, code: "declined", reason: declined.slice(0, 300) };
  }
  if (rawSteps.length < 2) {
    return {
      ok: false,
      code: "too_short",
      reason: "this is a single action, not a plan",
    };
  }
  if (rawSteps.length > tasks.MAX_STEPS) {
    return {
      ok: false,
      code: "plan_too_long",
      reason: `the plan had ${rawSteps.length} steps; the limit is ${tasks.MAX_STEPS}`,
    };
  }

  // ── VALIDATE EVERYTHING tasks.create() WOULD THROW ON ──────────────
  // Same rules, checked here so the failure names the step and the reason
  // instead of surfacing as a database-layer exception.
  const allowed = new Set(declarations.map((d) => d.name));
  const steps = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const s = rawSteps[i] || {};
    const name = String(s.tool || "").trim();
    if (!registry.get(name)) {
      return {
        ok: false,
        code: "unknown_tool",
        reason: `step ${i + 1} names "${name || "(nothing)"}", which is not a tool`,
      };
    }
    if (!allowed.has(name)) {
      // Registered, but not offered to this user — an unconnected Google
      // account, a denied permission, another tenant's MCP server.
      return {
        ok: false,
        code: "tool_unavailable",
        reason: `step ${i + 1} needs "${name}", which is not available to you`,
      };
    }
    const args = parseArgs(s.args_json);
    if (args === null) {
      return {
        ok: false,
        code: "bad_args",
        reason: `step ${i + 1} had arguments that were not valid JSON`,
      };
    }
    const deps = (Array.isArray(s.dependsOn) ? s.dependsOn : [])
      .map(Number)
      .filter(Number.isInteger);
    for (const d of deps) {
      if (d >= i || d < 0) {
        return {
          ok: false,
          code: "bad_dependency",
          reason: `step ${i + 1} depends on step ${d + 1}, which does not come before it`,
        };
      }
    }
    steps.push({ tool: name, args, why: String(s.why || "").slice(0, 300), dependsOn: deps });
  }

  return { ok: true, steps };
}

/**
 * Tools a plan may never contain.
 *
 * start_task is the obvious one: a plan whose step starts another plan
 * recurses, and MAX_STEPS would not bound it. The interpreter pair are
 * modes rather than actions — they change what the microphone is doing
 * and have no meaning inside a batch that runs without the user present.
 */
const NEVER_PLANNABLE = new Set([
  "start_task",
  "start_interpreter_mode",
  "stop_interpreter_mode",
  "translator_mode",
]);

module.exports = { plan, NEVER_PLANNABLE, PLAN_DECLARATION, catalogueFor };
