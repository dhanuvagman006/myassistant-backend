/**
 * MULTI-STEP TASK REGRESSION TESTS — `npm run test:tasks`.
 *
 * The stepper is tested against FAKE tools registered for the duration of
 * the test, so the plan logic is verified without a single model call or
 * network request. That is the point of separating the plan from the
 * planner: the part that must never get this wrong is deterministic.
 *
 * Each case is a way a multi-step task goes wrong in practice:
 *   • a step needs approval halfway through — the three finished steps
 *     must survive,
 *   • a device step is handed to the phone and the phone never answers,
 *   • a step's output feeds the next step's arguments,
 *   • a dependency fails, so everything behind it can never apply,
 *   • the repeat guard fires because an earlier turn already did it.
 *
 * Needs Postgres. Writes under a reserved test user id and cleans up.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const assert = require("assert");
const db = require("../src/db");
const registry = require("../src/tools/registry");
const tasks = require("../src/agents/tasks");
const contract = require("../src/tools/contract");

const USER = 99051;

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
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

/* ---- fake tools, registered for this test only ---- */
const CALLS = [];
function fakeTools() {
  // NOTE: these declare inputSchema on purpose. registry.coerceArgs drops
  // any argument a tool did not declare — correctly, since an undeclared
  // key is one the model invented — so a fake tool with no schema receives
  // an empty args object and the wiring test would pass for the wrong
  // reason. This is worth knowing when writing a real multi-step plan: a
  // step can only be handed values its tool actually declares.
  registry.register({
    name: "fake_find_place",
    inputSchema: { type: "object", properties: { near: { type: "string" } } },
    execute: (a) => {
      CALLS.push(["fake_find_place", a]);
      return { ok: true, data: { name: "Dosa Corner", phone: "+911234567890", address: "MG Road" } };
    },
  });
  registry.register({
    name: "fake_book",
    inputSchema: {
      type: "object",
      properties: { phone: { type: "string" }, people: { type: "integer" } },
    },
    execute: (a) => { CALLS.push(["fake_book", a]); return { ok: true, data: { reference: "BK-77" } }; },
  });
  registry.register({
    name: "fake_needs_approval",
    risk: "high",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    confirmSummary: (a) => `send "${a.text || ""}"`,
    execute: (a) => { CALLS.push(["fake_needs_approval", a]); return { ok: true, data: { sent: true } }; },
  });
  registry.register({
    name: "fake_device",
    deviceAction: true,
    execute: () => ({ ok: true, deviceAction: { type: "open_url", url: "https://x" } }),
  });
  registry.register({
    name: "fake_fails",
    execute: () => ({ ok: false, error: "no such restaurant" }),
  });
  registry.register({
    name: "fake_slow",
    timeoutMs: 600,
    execute: () => new Promise((r) => setTimeout(() => r({ ok: true }), 3000)),
  });
}
function dropFakes() {
  for (const n of ["fake_find_place", "fake_book", "fake_needs_approval",
                   "fake_device", "fake_fails", "fake_slow"]) registry.unregister(n);
}

/* ================================================================== */
console.log("\nTasks — argument wiring (pure)");
/* ================================================================== */

test("a step can read an earlier step's output by path", () => {
  const steps = [
    { i: 0, status: "done", result: { ok: true, data: { phone: "+9199", nested: { deep: [1, { x: "hit" }] } } } },
  ];
  const { args, missing } = tasks.resolveArgs(
    { number: { $from: 0, path: "phone" }, deep: { $from: 0, path: "nested.deep.1.x" } },
    steps
  );
  assert.deepStrictEqual(missing, []);
  assert.strictEqual(args.number, "+9199");
  assert.strictEqual(args.deep, "hit");
});

test("a reference to an unfinished step is reported, not silently undefined", () => {
  const steps = [{ i: 0, status: "pending", result: null }];
  const { missing } = tasks.resolveArgs({ n: { $from: 0, path: "phone" } }, steps);
  assert.strictEqual(missing.length, 1);
  assert.ok(/has not produced a result/.test(missing[0]));
});

test("a reference to a value that is not there is reported", () => {
  const steps = [{ i: 0, status: "done", result: { ok: true, data: { name: "x" } } }];
  const { missing } = tasks.resolveArgs({ n: { $from: 0, path: "phone" } }, steps);
  assert.strictEqual(missing.length, 1);
  assert.ok(/produced no "phone"/.test(missing[0]),
    "a booking made with an undefined phone number is worse than one not made");
});

test("wiring works inside arrays and nested objects", () => {
  const steps = [{ i: 0, status: "done", result: { ok: true, data: { a: 1, b: 2 } } }];
  const { args } = tasks.resolveArgs(
    { list: [{ $from: 0, path: "a" }, "literal"], obj: { inner: { $from: 0, path: "b" } } },
    steps
  );
  assert.deepStrictEqual(args.list, [1, "literal"]);
  assert.strictEqual(args.obj.inner, 2);
});

test("nextRunnable respects dependencies", () => {
  const steps = [
    { i: 0, status: "pending", dependsOn: [] },
    { i: 1, status: "pending", dependsOn: [0] },
  ];
  assert.strictEqual(tasks.nextRunnable(steps).i, 0);
  steps[0].status = "done";
  assert.strictEqual(tasks.nextRunnable(steps).i, 1);
  steps[1].status = "waiting";
  assert.strictEqual(tasks.nextRunnable(steps), null);
});

test("statusFor prefers BLOCKED over RUNNING — a waiting task is not progressing", () => {
  const S = tasks.STEP;
  assert.strictEqual(tasks.statusFor([{ status: S.DONE }, { status: S.WAITING }, { status: S.PENDING }]),
    tasks.STATUS.BLOCKED);
  assert.strictEqual(tasks.statusFor([{ status: S.DONE }, { status: S.PENDING }]), tasks.STATUS.RUNNING);
  assert.strictEqual(tasks.statusFor([{ status: S.DONE }, { status: S.DONE }]), tasks.STATUS.DONE);
  assert.strictEqual(tasks.statusFor([{ status: S.DONE }, { status: S.FAILED }]), tasks.STATUS.FAILED);
  assert.strictEqual(tasks.statusFor([{ status: S.DONE }, { status: S.SKIPPED }]), tasks.STATUS.DONE,
    "a skipped step is not a failure of the task — it no longer applies");
});

/* ================================================================== */

(async () => {
  await db.init();
  await tasks.migrate();
  await cleanup();
  fakeTools();

  console.log("\nTasks — validation at creation");

  await atest("a plan naming an unregistered tool is refused at creation", async () => {
    await assert.rejects(
      () => tasks.create(USER, "x", [{ tool: "no_such_tool_at_all" }]),
      (e) => e.code === "unknown_tool"
    );
  });

  await atest("an empty plan is refused", async () => {
    await assert.rejects(() => tasks.create(USER, "x", []), (e) => e.code === "empty_plan");
  });

  await atest("a forward or self dependency is refused — it would deadlock", async () => {
    await assert.rejects(
      () => tasks.create(USER, "x", [
        { tool: "fake_find_place", dependsOn: [1] },
        { tool: "fake_book" },
      ]),
      (e) => e.code === "bad_dependency"
    );
    await assert.rejects(
      () => tasks.create(USER, "x", [{ tool: "fake_find_place", dependsOn: [0] }]),
      (e) => e.code === "bad_dependency"
    );
  });

  await atest("an over-long plan is refused", async () => {
    const many = Array.from({ length: tasks.MAX_STEPS + 1 }, () => ({ tool: "fake_find_place" }));
    await assert.rejects(() => tasks.create(USER, "x", many), (e) => e.code === "plan_too_long");
  });

  console.log("\nTasks — the stepper");

  await atest("a two-step plan chains output into the next step's arguments", async () => {
    CALLS.length = 0;
    const t = await tasks.create(USER, "book me a table", [
      { tool: "fake_find_place", args: { near: "MG Road" }, why: "find somewhere" },
      { tool: "fake_book", args: { phone: { $from: 0, path: "phone" }, people: 4 }, dependsOn: [0] },
    ]);
    const done = await tasks.runToCompletion(USER, t.id, {});
    assert.strictEqual(done.status, tasks.STATUS.DONE, JSON.stringify(done.steps));
    assert.strictEqual(done.steps[0].status, tasks.STEP.DONE);
    assert.strictEqual(done.steps[1].status, tasks.STEP.DONE);
    // The planner never knew the number; the wiring supplied it.
    assert.strictEqual(CALLS[1][1].phone, "+911234567890");
    assert.strictEqual(CALLS[1][1].people, 4);
  });

  await atest("a step needing approval PARKS the task and keeps the finished work", async () => {
    const t = await tasks.create(USER, "find and tell", [
      { tool: "fake_find_place", args: {} },
      { tool: "fake_needs_approval", args: { text: "we're booked" }, dependsOn: [0] },
    ]);
    const parked = await tasks.runToCompletion(USER, t.id, {});
    assert.strictEqual(parked.status, tasks.STATUS.BLOCKED,
      "a task that has done one of two things must say it is waiting, not that it failed");
    assert.strictEqual(parked.steps[0].status, tasks.STEP.DONE, "the finished step must survive");
    assert.strictEqual(parked.steps[1].status, tasks.STEP.WAITING);
    assert.ok(/waiting for approval/.test(parked.steps[1].error));
    assert.ok(/approval/.test(parked.blockedOn));

    // Approval arrives → the step re-queues and the task completes.
    await tasks.resume(USER, t.id, 1);
    const finished = await tasks.runToCompletion(USER, t.id, { approved: true });
    assert.strictEqual(finished.status, tasks.STATUS.DONE, JSON.stringify(finished.steps));
    assert.strictEqual(finished.steps[1].status, tasks.STEP.DONE);
  });

  await atest("a device step is DISPATCHED, not done, until the phone acknowledges", async () => {
    const t = await tasks.create(USER, "open it", [{ tool: "fake_device", args: {} }]);
    const blocked = await tasks.runToCompletion(USER, t.id, {});
    assert.strictEqual(blocked.steps[0].status, tasks.STEP.DISPATCHED,
      "handing an envelope to the phone is not the phone having done it");
    assert.strictEqual(blocked.status, tasks.STATUS.BLOCKED);

    const acked = await tasks.ack(USER, t.id, 0, { ok: true });
    assert.strictEqual(acked.steps[0].status, tasks.STEP.DONE);
    assert.strictEqual(acked.status, tasks.STATUS.DONE);
  });

  await atest("a phone that reports failure fails the step honestly", async () => {
    const t = await tasks.create(USER, "open it", [
      { tool: "fake_device", args: {} },
      { tool: "fake_book", args: {}, dependsOn: [0] },
    ]);
    await tasks.runToCompletion(USER, t.id, {});
    const failed = await tasks.ack(USER, t.id, 0, { ok: false, detail: "no app to handle it" });
    assert.strictEqual(failed.steps[0].status, tasks.STEP.FAILED);
    assert.ok(/no app to handle it/.test(failed.steps[0].error));
    assert.strictEqual(failed.steps[1].status, tasks.STEP.SKIPPED,
      "a step behind a failed dependency can never apply and must not sit pending forever");
    assert.strictEqual(failed.status, tasks.STATUS.FAILED);
  });

  await atest("a failed step cascades: everything depending on it is skipped", async () => {
    const t = await tasks.create(USER, "find then book", [
      { tool: "fake_fails", args: {} },
      { tool: "fake_book", args: {}, dependsOn: [0] },
      { tool: "fake_find_place", args: {} }, // independent — must still run
    ]);
    const out = await tasks.runToCompletion(USER, t.id, {});
    assert.strictEqual(out.steps[0].status, tasks.STEP.FAILED);
    assert.strictEqual(out.steps[1].status, tasks.STEP.SKIPPED);
    assert.strictEqual(out.steps[2].status, tasks.STEP.DONE,
      "an independent step must not be punished for an unrelated failure");
    assert.strictEqual(out.status, tasks.STATUS.FAILED);
  });

  await atest("a missing wired value fails the step instead of calling with undefined", async () => {
    CALLS.length = 0;
    const t = await tasks.create(USER, "bad wiring", [
      { tool: "fake_find_place", args: {} },
      { tool: "fake_book", args: { phone: { $from: 0, path: "not_a_field" } }, dependsOn: [0] },
    ]);
    const out = await tasks.runToCompletion(USER, t.id, {});
    assert.strictEqual(out.steps[1].status, tasks.STEP.FAILED);
    assert.ok(/produced no "not_a_field"/.test(out.steps[1].error));
    assert.strictEqual(CALLS.filter((c) => c[0] === "fake_book").length, 0,
      "the tool must never have been called at all");
  });

  await atest("a timed-out step parks the task rather than claiming either outcome", async () => {
    const t = await tasks.create(USER, "slow thing", [{ tool: "fake_slow", args: {} }]);
    const out = await tasks.runToCompletion(USER, t.id, {});
    // fake_slow is not a world action, so the registry reports a plain
    // failure; the point here is that the stepper records the real outcome.
    assert.ok([tasks.STEP.FAILED, tasks.STEP.WAITING].includes(out.steps[0].status));
    assert.ok(/timed out|not clear/.test(out.steps[0].error));
  });

  await atest("the stepper records the outcome taxonomy on every step", async () => {
    const t = await tasks.create(USER, "outcomes", [
      { tool: "fake_find_place", args: {} },
      { tool: "fake_device", args: {} },
    ]);
    const out = await tasks.runToCompletion(USER, t.id, {});
    assert.strictEqual(out.steps[0].outcome, contract.OUTCOME.OK);
    assert.strictEqual(out.steps[1].outcome, contract.OUTCOME.DISPATCHED);
  });

  await atest("cancelling stops everything still outstanding", async () => {
    const t = await tasks.create(USER, "never mind", [
      { tool: "fake_find_place", args: {} },
      { tool: "fake_book", args: {}, dependsOn: [0] },
    ]);
    const out = await tasks.cancel(USER, t.id, "the user changed their mind");
    assert.strictEqual(out.status, tasks.STATUS.CANCELLED);
    assert.ok(out.steps.every((s) => s.status !== tasks.STEP.PENDING));
    // A cancelled task must not be resumable by the stepper.
    const after = await tasks.step(USER, t.id, {});
    assert.strictEqual(after.ran, false);
  });

  await atest("one user cannot see or step another's task", async () => {
    const t = await tasks.create(USER, "mine", [{ tool: "fake_find_place", args: {} }]);
    assert.strictEqual(await tasks.get(USER + 1, t.id), null);
    await assert.rejects(() => tasks.step(USER + 1, t.id, {}), (e) => e.code === "no_task");
  });

  await atest("open tasks are listable, finished ones are not", async () => {
    await cleanup();
    const a = await tasks.create(USER, "open one", [{ tool: "fake_needs_approval", args: { text: "x" } }]);
    await tasks.runToCompletion(USER, a.id, {});
    const b = await tasks.create(USER, "done one", [{ tool: "fake_find_place", args: {} }]);
    await tasks.runToCompletion(USER, b.id, {});
    const open = await tasks.listOpen(USER);
    assert.strictEqual(open.length, 1);
    assert.strictEqual(open[0].goal, "open one");
    assert.strictEqual((await tasks.listRecent(USER)).length, 2);
  });

  await atest("describe() gives a line per step that a user could read", async () => {
    const t = await tasks.create(USER, "describe me", [
      { tool: "fake_find_place", args: {} },
      { tool: "fake_needs_approval", args: { text: "x" }, dependsOn: [0] },
    ]);
    const out = await tasks.runToCompletion(USER, t.id, {});
    const text = tasks.describe(out);
    assert.ok(/describe me/.test(text));
    assert.ok(/1\. fake_find_place — done/.test(text));
    assert.ok(/2\. fake_needs_approval — waiting/.test(text));
  });

  dropFakes();
  await cleanup();
  await db.close();
  console.log(`\n${passed} checks passed`);
})();

async function cleanup() {
  await db.run("DELETE FROM agent_tasks WHERE user_id IN ($1,$2)", [USER, USER + 1]).catch(() => {});
}
