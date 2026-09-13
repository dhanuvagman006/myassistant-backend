/**
 * PLANNER + DRIVER + start_task TESTS — `npm run test:planner`.
 *
 * agents/tasks.js could already execute a plan; nothing could WRITE one,
 * and nothing turned the crank. These cover the three pieces that closed
 * that gap — planner.js, taskDriver.js and the start_task tool — and in
 * particular the places where getting it wrong is dangerous rather than
 * merely broken:
 *
 *   • a plan may only name tools this user can actually run, so a plan
 *     never dies on step one against a tool that was never available;
 *   • one approval authorises ONE step, so a plan holding two high-risk
 *     actions cannot clear both with a single tap;
 *   • a declined step ends its plan instead of leaving it blocked
 *     forever on a step the user has refused;
 *   • the summary says what RAN, never what was intended.
 *
 * The model is stubbed throughout: planning is one call to
 * router.generateWithTools, replaced here so the plan is fixed and the
 * logic under test is deterministic. Needs Postgres; writes under a
 * reserved test user id and cleans up.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const assert = require("assert");
const db = require("../src/db");
const registry = require("../src/tools/registry");
const tasks = require("../src/agents/tasks");
const planner = require("../src/agents/planner");
const driver = require("../src/agents/taskDriver");
const router = require("../src/services/ai/router");
const { registerTaskTools } = require("../src/agents/taskTools");

const USER = 99061;

let passed = 0;
async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

/* ---- fake tools, registered for this test only ---- */
const CALLS = [];
const FAKES = ["p_search", "p_write", "p_risky", "p_risky2", "p_device", "p_needs_args"];

function fakeTools() {
  registry.register({
    name: "p_search",
    description: "Look something up.",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    execute: (a) => {
      CALLS.push(["p_search", a]);
      return { ok: true, data: { title: "Dosa Corner", phone: "+911234567890" } };
    },
  });
  registry.register({
    name: "p_write",
    description: "Write something down.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    execute: (a) => {
      CALLS.push(["p_write", a]);
      return { ok: true, data: { saved: true, text: a.text } };
    },
  });
  registry.register({
    name: "p_risky",
    description: "Do something consequential.",
    risk: "high",
    inputSchema: { type: "object", properties: { what: { type: "string" } } },
    confirmSummary: (a) => `do ${a.what}`,
    execute: (a) => {
      CALLS.push(["p_risky", a]);
      return { ok: true, data: { did: a.what } };
    },
  });
  registry.register({
    name: "p_risky2",
    description: "Do a second consequential thing.",
    risk: "high",
    inputSchema: { type: "object", properties: { what: { type: "string" } } },
    confirmSummary: (a) => `also do ${a.what}`,
    execute: (a) => {
      CALLS.push(["p_risky2", a]);
      return { ok: true, data: { did: a.what } };
    },
  });
  registry.register({
    name: "p_needs_args",
    description: "Stops because something is missing.",
    inputSchema: { type: "object", properties: { x: { type: "string" } } },
    execute: () => {
      CALLS.push(["p_needs_args", {}]);
      return { ok: false, needsArgs: ["x"] };
    },
  });
  registry.register({
    name: "p_device",
    description: "Hand something to the phone.",
    deviceAction: true,
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
    execute: (a) => {
      CALLS.push(["p_device", a]);
      return { ok: true, deviceAction: { type: "show_text", title: a.title } };
    },
  });
}
function dropFakes() {
  for (const n of FAKES) registry.unregister(n);
}

/** Stub the one model call planning makes. */
function stubPlan(steps, decline) {
  router.generateWithTools = async () => ({
    functionCalls: [
      {
        name: "submit_plan",
        args: decline
          ? { decline }
          : {
              steps: steps.map((s) => ({
                tool: s.tool,
                args_json: JSON.stringify(s.args || {}),
                why: s.why || "because",
                dependsOn: s.dependsOn || [],
              })),
            },
      },
    ],
    text: "",
  });
}

(async () => {
  const realGenerate = router.generateWithTools;
  fakeTools();
  registerTaskTools();
  await cleanup();

  console.log("\nthe planner only plans what can actually run");

  await atest("a plan naming an unregistered tool is refused, with the step named", async () => {
    stubPlan([
      { tool: "p_search", args: { q: "x" } },
      { tool: "totally_made_up", args: {} },
    ]);
    const r = await planner.plan(USER, "do a thing", {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "unknown_tool");
    assert.match(r.reason, /step 2/, r.reason);
    assert.match(r.reason, /totally_made_up/, r.reason);
  });

  await atest("a forward dependency is refused rather than deadlocking the stepper", async () => {
    stubPlan([
      { tool: "p_search", args: {}, dependsOn: [1] },
      { tool: "p_write", args: {} },
    ]);
    const r = await planner.plan(USER, "do a thing", {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "bad_dependency");
  });

  await atest("a single-step goal is declined so the assistant just does it directly", async () => {
    stubPlan([{ tool: "p_search", args: { q: "weather" } }]);
    const r = await planner.plan(USER, "what's the weather", {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "too_short");
  });

  await atest("the planner's own refusal is passed through, not swallowed", async () => {
    stubPlan(null, "nothing here can send an email");
    const r = await planner.plan(USER, "email my landlord", {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "declined");
    assert.match(r.reason, /email/i);
  });

  await atest("malformed step arguments are refused, not silently emptied", async () => {
    router.generateWithTools = async () => ({
      functionCalls: [{
        name: "submit_plan",
        args: { steps: [
          { tool: "p_search", args_json: "{not json", why: "x" },
          { tool: "p_write", args_json: "{}", why: "y" },
        ] },
      }],
      text: "",
    });
    const r = await planner.plan(USER, "do a thing", {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "bad_args");
    assert.match(r.reason, /step 1/);
  });

  await atest("start_task can never appear inside a plan", async () => {
    assert.ok(planner.NEVER_PLANNABLE.has("start_task"),
      "a plan whose step starts another plan is unbounded");
  });

  await atest("a good plan validates and comes back as steps tasks.create accepts", async () => {
    stubPlan([
      { tool: "p_search", args: { q: "dosa" }, why: "find it" },
      { tool: "p_write", args: { text: { $from: 0, path: "title" } }, why: "write it down", dependsOn: [0] },
    ]);
    const r = await planner.plan(USER, "find a dosa place and write it down", {});
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.steps.length, 2);
    assert.deepStrictEqual(r.steps[1].dependsOn, [0]);
    // The reference must survive validation intact — this is what makes a
    // plan a plan rather than two unrelated calls.
    assert.deepStrictEqual(r.steps[1].args.text, { $from: 0, path: "title" });
    const t = await tasks.create(USER, "find and write", r.steps);
    assert.strictEqual(t.steps.length, 2);
  });

  console.log("\none approval authorises one step");

  await atest("a plan with two high-risk steps stops at the first", async () => {
    CALLS.length = 0;
    const t = await tasks.create(USER, "two risky things", [
      { tool: "p_risky", args: { what: "one" } },
      { tool: "p_risky2", args: { what: "two" }, dependsOn: [0] },
    ]);
    const { task } = await driver.runWithin(USER, t.id, {});
    assert.strictEqual(task.status, tasks.STATUS.BLOCKED);
    assert.strictEqual(task.steps[0].status, tasks.STEP.WAITING);
    assert.strictEqual(task.steps[1].status, tasks.STEP.PENDING);
    assert.strictEqual(CALLS.length, 0, "nothing consequential may run before approval");
  });

  await atest("approving the first does NOT also approve the second", async () => {
    CALLS.length = 0;
    const t = await tasks.create(USER, "two risky things", [
      { tool: "p_risky", args: { what: "one" } },
      { tool: "p_risky2", args: { what: "two" }, dependsOn: [0] },
    ]);
    await driver.runWithin(USER, t.id, {});
    const { task } = await driver.approveStep(USER, t.id, 0, {});

    assert.strictEqual(task.steps[0].status, tasks.STEP.DONE,
      "the approved step must actually run");
    assert.strictEqual(task.steps[1].status, tasks.STEP.WAITING,
      "the SECOND high-risk step must stop and ask on its own");
    assert.deepStrictEqual(CALLS.map((c) => c[0]), ["p_risky"],
      "exactly one consequential action may have run");
    assert.strictEqual(task.status, tasks.STATUS.BLOCKED);
  });

  await atest("approving the second then runs it, and the plan finishes", async () => {
    CALLS.length = 0;
    const t = await tasks.create(USER, "two risky things", [
      { tool: "p_risky", args: { what: "one" } },
      { tool: "p_risky2", args: { what: "two" }, dependsOn: [0] },
    ]);
    await driver.runWithin(USER, t.id, {});
    await driver.approveStep(USER, t.id, 0, {});
    const { task } = await driver.approveStep(USER, t.id, 1, {});
    assert.strictEqual(task.status, tasks.STATUS.DONE);
    assert.deepStrictEqual(CALLS.map((c) => c[0]), ["p_risky", "p_risky2"]);
  });

  await atest("a scheduled background run still carries blanket approval", async () => {
    CALLS.length = 0;
    const t = await tasks.create(USER, "background risky", [
      { tool: "p_risky", args: { what: "bg" } },
      { tool: "p_write", args: { text: "after" }, dependsOn: [0] },
    ]);
    // p_risky is not on the unattended-blocked seed list, so consent given
    // when the task was scheduled still covers it.
    const { task } = await driver.runWithin(USER, t.id, { approved: true, background: true });
    assert.strictEqual(task.status, tasks.STATUS.DONE, task.error);
    assert.deepStrictEqual(CALLS.map((c) => c[0]), ["p_risky", "p_write"]);
  });

  console.log("\na declined step ends its plan");

  await atest("declining cancels the task instead of leaving it blocked", async () => {
    const t = await tasks.create(USER, "risky then write", [
      { tool: "p_risky", args: { what: "one" } },
      { tool: "p_write", args: { text: "after" }, dependsOn: [0] },
    ]);
    await driver.runWithin(USER, t.id, {});
    const task = await driver.declineStep(USER, t.id, 0, "user said no");
    assert.strictEqual(task.status, tasks.STATUS.CANCELLED);
    const open = await tasks.listOpen(USER);
    assert.ok(!open.some((x) => x.id === t.id),
      "a declined plan must not still count as open work");
  });

  console.log("\nthe driver reports what ran, never what was intended");

  await atest("a finished plan says done; a part-finished one says how far it got", async () => {
    const t = await tasks.create(USER, "search then write", [
      { tool: "p_search", args: { q: "x" } },
      { tool: "p_write", args: { text: { $from: 0, path: "title" } }, dependsOn: [0] },
    ]);
    const { task } = await driver.runWithin(USER, t.id, {});
    assert.strictEqual(task.status, tasks.STATUS.DONE);
    assert.match(driver.summarise(task), /^Done/, driver.summarise(task));

    const t2 = await tasks.create(USER, "write then risky", [
      { tool: "p_write", args: { text: "a" } },
      { tool: "p_risky", args: { what: "b" }, dependsOn: [0] },
    ]);
    const out2 = await driver.runWithin(USER, t2.id, {});
    const said = driver.summarise(out2.task);
    assert.match(said, /1 of 2/, said);
    assert.match(said, /need you/i, said);
  });

  await atest("a step's output really does reach the next step's arguments", async () => {
    CALLS.length = 0;
    const t = await tasks.create(USER, "chain", [
      { tool: "p_search", args: { q: "x" } },
      { tool: "p_write", args: { text: { $from: 0, path: "phone" } }, dependsOn: [0] },
    ]);
    await driver.runWithin(USER, t.id, {});
    const write = CALLS.find((c) => c[0] === "p_write");
    assert.ok(write, "the second step must have run");
    assert.strictEqual(write[1].text, "+911234567890",
      "the value must come from step 1, not be invented");
  });

  await atest("a dispatched step blocks the plan until the phone answers", async () => {
    const t = await tasks.create(USER, "device then write", [
      { tool: "p_device", args: { title: "hello" } },
      { tool: "p_write", args: { text: "after" }, dependsOn: [0] },
    ]);
    const { task } = await driver.runWithin(USER, t.id, {});
    assert.strictEqual(task.steps[0].status, tasks.STEP.DISPATCHED);
    assert.strictEqual(task.status, tasks.STATUS.BLOCKED);
    assert.match(driver.summarise(task), /waiting for your phone/i);

    const out = await driver.acknowledge(USER, t.id, 0, { ok: true });
    assert.strictEqual(out.task.status, tasks.STATUS.DONE,
      "the receipt should release the rest of the plan");
  });

  await atest("a phone that reports failure skips what depended on it", async () => {
    const t = await tasks.create(USER, "device then write", [
      { tool: "p_device", args: { title: "hello" } },
      { tool: "p_write", args: { text: "after" }, dependsOn: [0] },
    ]);
    await driver.runWithin(USER, t.id, {});
    const out = await driver.acknowledge(USER, t.id, 0, { ok: false, detail: "no handler" });
    assert.strictEqual(out.task.steps[0].status, tasks.STEP.FAILED);
    assert.strictEqual(out.task.steps[1].status, tasks.STEP.SKIPPED,
      "a step behind a failed one can never apply and must not be left pending");
  });

  await atest("the time budget stops the driver without losing the work", async () => {
    const t = await tasks.create(USER, "three steps", [
      { tool: "p_search", args: { q: "a" } },
      { tool: "p_write", args: { text: "b" }, dependsOn: [0] },
      { tool: "p_write", args: { text: "c" }, dependsOn: [1] },
    ]);
    // A budget already spent: the first check fires before any step runs.
    const out = await driver.runWithin(USER, t.id, {}, { budgetMs: -1 });
    assert.strictEqual(out.exhausted, true);
    assert.strictEqual(out.ranSteps, 0);
    assert.strictEqual(out.task.status, tasks.STATUS.RUNNING,
      "an unfinished plan stays runnable rather than being marked failed");
    // And it picks up exactly where it stopped.
    const rest = await driver.runWithin(USER, t.id, {});
    assert.strictEqual(rest.task.status, tasks.STATUS.DONE);
  });

  console.log("\nthe live surface cannot ask, so it is not given anything that asks");

  await atest("a live plan is built without high-risk tools", async () => {
    let sawCatalogue = "";
    router.generateWithTools = async ({ system }) => {
      sawCatalogue = system;
      return { functionCalls: [{ name: "submit_plan", args: { steps: [
        { tool: "p_search", args_json: "{}", why: "a" },
        { tool: "p_write", args_json: "{}", why: "b" },
      ] } }], text: "" };
    };
    await planner.plan(USER, "do a thing", { excludeHighRisk: true });
    assert.ok(sawCatalogue.includes("p_search"), "safe tools must still be offered");
    assert.ok(!sawCatalogue.includes("p_risky"),
      "a tool that would stop to ask must not be offered where nothing can ask");
  });

  await atest("the same plan on a normal surface DOES get the high-risk tools", async () => {
    let sawCatalogue = "";
    router.generateWithTools = async ({ system }) => {
      sawCatalogue = system;
      return { functionCalls: [{ name: "submit_plan", args: { steps: [
        { tool: "p_search", args_json: "{}", why: "a" },
        { tool: "p_write", args_json: "{}", why: "b" },
      ] } }], text: "" };
    };
    await planner.plan(USER, "do a thing", {});
    assert.ok(sawCatalogue.includes("p_risky"),
      "the voice/chat surfaces have a confirmation card and must keep the full set");
  });

  await atest("a live plan naming a high-risk tool is refused outright", async () => {
    stubPlan([
      { tool: "p_search", args: { q: "x" }, why: "look" },
      { tool: "p_risky", args: { what: "thing" }, why: "do", dependsOn: [0] },
    ]);
    const res = await registry.execute(
      "start_task", { goal: "look then do" }, { userId: USER, source: "live" }
    );
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /p_risky/, res.error);
    assert.notStrictEqual(res.needsConfirmation, true,
      "nothing on live may raise a card that surface cannot route");
  });

  await atest("a live plan parked on a missing argument never invites a restart", async () => {
    // Not every park is a confirmation: a step can also stop because an
    // argument is missing, and that is low-risk, so it reaches live.
    stubPlan([
      { tool: "p_search", args: { q: "x" }, why: "look" },
      { tool: "p_needs_args", args: {}, why: "then this", dependsOn: [0] },
    ]);
    const res = await registry.execute(
      "start_task", { goal: "look then stall" }, { userId: USER, source: "live" }
    );
    assert.strictEqual(res.ok, false);
    assert.notStrictEqual(res.needsConfirmation, true);
    assert.match(res.error, /Do NOT call start_task again/i, res.error);
    assert.match(res.error, /repeated/i,
      "the model must be told WHY calling again is wrong, not just that it is");
    assert.strictEqual(res.data.steps[0].status, tasks.STEP.DONE,
      "the step that already ran must still be reported as done");
  });

  console.log("\nstart_task");

  await atest("start_task is registered, low risk, and NOT offered to the model", async () => {
    const t = registry.get("start_task");
    assert.ok(t, "the tool must exist");
    assert.strictEqual(t.risk, "low",
      "the STEPS carry the risk; asking a user to approve 'a plan' approves nothing they can judge");
    // DARK until a plan step's deviceAction can actually reach the phone.
    // It could not, so 26 tools did nothing inside a plan and then hung it
    // waiting for a receipt no one sends. This assertion is the guard: it
    // fails the moment someone re-offers the tool, which must not happen
    // until delivery works and has been checked on a real device.
    assert.strictEqual(t.available(), false,
      "start_task must stay dark while plan steps cannot drive the phone");
    const declared = registry.declarations({ userId: USER }).map((d) => d.name);
    assert.ok(!declared.includes("start_task"),
      "an unavailable tool must never be declared to the model");
  });

  await atest("a goal the planner declines is reported as 'do it directly', not as failure", async () => {
    stubPlan(null, "this is one action");
    const res = await registry.execute("start_task", { goal: "what's the weather" }, { userId: USER });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /directly/i, res.error);
  });

  await atest("start_task runs a real plan and reports what finished", async () => {
    CALLS.length = 0;
    stubPlan([
      { tool: "p_search", args: { q: "dosa" }, why: "find it" },
      { tool: "p_write", args: { text: { $from: 0, path: "title" } }, why: "save it", dependsOn: [0] },
    ]);
    const res = await registry.execute("start_task", { goal: "find a dosa place and save it" }, { userId: USER });
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.data.status, tasks.STATUS.DONE);
    assert.strictEqual(res.data.done, 2);
    assert.strictEqual(res.data.total, 2);
    assert.match(res.speak, /^Done/, res.speak);
    assert.deepStrictEqual(CALLS.map((c) => c[0]), ["p_search", "p_write"]);
  });

  await atest("a plan that stops for approval raises the ordinary confirmation card", async () => {
    stubPlan([
      { tool: "p_search", args: { q: "x" }, why: "look" },
      { tool: "p_risky", args: { what: "the thing" }, why: "do it", dependsOn: [0] },
    ]);
    const res = await registry.execute("start_task", { goal: "look then do" }, { userId: USER });
    assert.strictEqual(res.needsConfirmation, true, "the user must be asked");
    assert.strictEqual(res.tool, "p_risky");
    assert.ok(res.task && res.task.id, "the card must carry the plan it belongs to");
    assert.strictEqual(res.task.stepIndex, 1);
    // And the step it stopped on is reachable and resumable.
    const out = await driver.approveStep(USER, res.task.id, res.task.stepIndex, {});
    assert.strictEqual(out.task.status, tasks.STATUS.DONE);
  });

  await atest("the payload the model sees carries per-step truth, not just a count", async () => {
    stubPlan([
      { tool: "p_search", args: { q: "x" }, why: "look" },
      { tool: "p_write", args: { text: "y" }, why: "save", dependsOn: [0] },
    ]);
    const res = await registry.execute("start_task", { goal: "look then save" }, { userId: USER });
    assert.ok(Array.isArray(res.data.steps));
    assert.strictEqual(res.data.steps.length, 2);
    assert.strictEqual(res.data.steps[0].n, 1);
    assert.strictEqual(res.data.steps[0].status, tasks.STEP.DONE);
    assert.ok(res.data.steps[0].why, "a user must be able to read why a step is there");
  });

  await atest("a task is refused without a signed-in user", async () => {
    stubPlan([
      { tool: "p_search", args: {}, why: "a" },
      { tool: "p_write", args: {}, why: "b" },
    ]);
    const res = await registry.execute("start_task", { goal: "do a thing" }, {});
    assert.strictEqual(res.ok, false);
  });

  router.generateWithTools = realGenerate;
  dropFakes();
  await cleanup();
  // The action ledger is written fire-and-forget by registry.execute, so a
  // couple of writes are still in flight when the last check returns.
  // Closing the pool under them printed a teardown error that looked like
  // a failure and was not one.
  await new Promise((r) => setTimeout(r, 250));
  await db.close();
  console.log(`\n${passed} checks passed`);
})();

async function cleanup() {
  await db.run("DELETE FROM agent_tasks WHERE user_id = $1", [USER]).catch(() => {});
}
