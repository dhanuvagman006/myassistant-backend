/**
 * TOOL CONTRACT REGRESSION TESTS — `npm run test:contract`.
 *
 * The contract exists because five hand-maintained name lists in
 * registry.js were the real safety machinery, and they had drifted. Each
 * case below is either one of those drifts, or an invariant that stops the
 * next one.
 *
 * The most important test in this file is the PHANTOM test: MEMORY_WRITES
 * named "add_instruction" — a tool that has never existed — so the one
 * tool that writes a permanent behaviour rule into every future prompt had
 * no grounding gate. Nothing in either file could reveal that; only
 * cross-checking the lists against the live registry can.
 *
 * Needs Postgres only for the ledger writes the executor makes; the
 * contract half is pure.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const assert = require("assert");
const contract = require("../src/tools/contract");
const registry = require("../src/tools/registry");

let passed = 0;
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
async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

/* ================================================================== */
console.log("\nTool contract — declaration validation");
/* ================================================================== */

const stub = (over = {}) => ({ name: "t_" + Math.random().toString(36).slice(2), execute: () => ({ ok: true }), ...over });

test("a legacy tool (no effects declared) passes through untouched", () => {
  const t = contract.normalize(stub({ risk: "low" }));
  assert.deepStrictEqual(t.effects, []);
  assert.strictEqual(t.declaredEffects, false);
  assert.strictEqual(t.dedupe, "never");
  assert.strictEqual(t.retry, null, "a legacy tool must get exactly one attempt");
  assert.strictEqual(t.timeoutMs, contract.DEFAULT_TIMEOUT_MS);
});

test("an unknown effect is rejected at declaration time", () => {
  assert.throws(() => contract.normalize(stub({ effects: ["teleport"] })), /unknown effect "teleport"/);
});

test("an empty effects array is rejected (silence is not a declaration)", () => {
  assert.throws(() => contract.normalize(stub({ effects: [] })), /non-empty/);
});

test("a consequential effect forces risk:high", () => {
  assert.throws(
    () => contract.normalize(stub({ effects: ["send:external"], confirmSummary: () => "x" })),
    /risk must be "high"/
  );
  assert.throws(
    () => contract.normalize(stub({ effects: ["money"], risk: "medium", confirmSummary: () => "x" })),
    /risk must be "high"/
  );
  assert.throws(
    () => contract.normalize(stub({ effects: ["irreversible"], risk: "low", confirmSummary: () => "x" })),
    /risk must be "high"/
  );
});

test("a consequential effect requires a confirmSummary", () => {
  assert.throws(
    () => contract.normalize(stub({ effects: ["send:external"], risk: "high" })),
    /confirmSummary\(args, ctx\) is required/
  );
});

test("a consequential effect may not opt out of dedupe", () => {
  assert.throws(
    () => contract.normalize(stub({
      effects: ["send:external"], risk: "high", confirmSummary: () => "x", dedupe: "never",
    })),
    /dedupe "never" is not allowed/
  );
});

test("a consequential tool cannot declare a retry without asserting idempotency", () => {
  assert.throws(
    () => contract.normalize(stub({
      effects: ["send:external"], risk: "high", confirmSummary: () => "x", retry: { attempts: 3 },
    })),
    /a retry would do it twice/
  );
  // ...but may when the handler genuinely is idempotent.
  const ok = contract.normalize(stub({
    effects: ["send:external"], risk: "high", confirmSummary: () => "x",
    retry: { attempts: 2, safe: true },
  }));
  assert.strictEqual(ok.retry.attempts, 2);
  assert.strictEqual(ok.retry.safe, true);
});

test("defaults follow from effects, so a tool cannot forget them", () => {
  const read = contract.normalize(stub({ effects: ["read"] }));
  assert.strictEqual(read.dedupe, "never");
  assert.strictEqual(read.unattended, true);

  const ext = contract.normalize(stub({
    effects: ["send:external"], risk: "high", confirmSummary: () => "x",
  }));
  assert.strictEqual(ext.dedupe, "durable", "anything leaving the system is durably deduped");
  assert.strictEqual(ext.unattended, false, "and may not fire with nobody there");

  const dev = contract.normalize(stub({ effects: ["device"] }));
  assert.strictEqual(dev.dedupe, "per-turn");
  assert.strictEqual(dev.unattended, false, "a phone action needs a phone in someone's hand");

  const mem = contract.normalize(stub({ effects: ["write:memory"] }));
  assert.strictEqual(mem.dedupe, "per-turn");
});

test("deviceAction:true implies the device effect even if unstated", () => {
  const t = contract.normalize(stub({ effects: ["read"], deviceAction: true }));
  assert.ok(t.effects.includes("device"));
});

test("timeoutMs is bounded — an unbounded tool hangs the turn", () => {
  assert.throws(() => contract.normalize(stub({ timeoutMs: 0 })), /between 500 and 600000/);
  assert.throws(() => contract.normalize(stub({ timeoutMs: 900_000 })), /between 500 and 600000/);
  assert.strictEqual(contract.normalize(stub({ timeoutMs: 120_000 })).timeoutMs, 120_000);
});

test("requires[] entries are validated, and the legacy fields fold into them", () => {
  assert.throws(() => contract.normalize(stub({ requires: [{ kind: "vibes" }] })), /unknown requires kind/);
  assert.throws(() => contract.normalize(stub({ requires: [{ kind: "integration" }] })), /needs an id/);
  // auth needs no id — it is the only kind that is a bare fact.
  const a = contract.normalize(stub({ requires: [{ kind: "auth" }] }));
  assert.strictEqual(a.requires[0].kind, "auth");
  // the two legacy fields become requires entries, so one resolver serves both
  const legacy = contract.normalize(stub({ requiresPermission: ["camera", "mic"], minAppBuild: 29 }));
  const kinds = legacy.requires.map((r) => `${r.kind}:${r.id}`);
  assert.deepStrictEqual(kinds, ["os_permission:camera", "os_permission:mic", "app_build:29"]);
});

/* ================================================================== */
console.log("\nTool contract — the outcome taxonomy");
/* ================================================================== */

test("the five outcomes are distinguishable from the existing envelope", () => {
  const O = contract.OUTCOME;
  assert.strictEqual(contract.outcomeOf({ ok: true, data: 1 }), O.OK);
  assert.strictEqual(contract.outcomeOf({ ok: false, error: "nope" }), O.FAILED);
  assert.strictEqual(contract.outcomeOf({ ok: false, needsArgs: ["name"] }), O.NEEDS_USER);
  assert.strictEqual(contract.outcomeOf({ ok: false, needsConfirmation: true }), O.NEEDS_USER);
  assert.strictEqual(contract.outcomeOf({ ok: true, repeated: true }), O.SUPPRESSED);
  assert.strictEqual(contract.outcomeOf({ ok: false, partial: true }), O.PARTIAL);
  assert.strictEqual(contract.outcomeOf(null), O.FAILED);
});

test("a device action is DISPATCHED, not ok — the phone has not answered yet", () => {
  assert.strictEqual(
    contract.outcomeOf({ ok: true, deviceAction: { type: "open_url" } }),
    contract.OUTCOME.DISPATCHED,
    "recording this as plain success is how 'I opened YouTube' got asserted about a dropped envelope"
  );
  // ...unless the server genuinely finished the work and is only using the
  // envelope to put it on screen.
  assert.strictEqual(
    contract.outcomeOf({ ok: true, deviceAction: { type: "show_image" }, data: { generated: true } }),
    contract.OUTCOME.OK
  );
});

test("only ok and partial count as having changed the world", () => {
  const O = contract.OUTCOME;
  assert.strictEqual(contract.isSettled(O.OK), true);
  assert.strictEqual(contract.isSettled(O.PARTIAL), true);
  assert.strictEqual(contract.isSettled(O.DISPATCHED), false);
  assert.strictEqual(contract.isSettled(O.FAILED), false);
  assert.strictEqual(contract.isSettled(O.SUPPRESSED), false);
});

/* ================================================================== */
console.log("\nTool contract — drift detection");
/* ================================================================== */

test("a phantom is detected: a safety list naming a tool that does not exist", () => {
  const d = contract.drift({
    registeredNames: new Set(["add_standing_instruction"]),
    seedLists: { MEMORY_WRITES: new Set(["add_standing_instruction", "add_instruction"]) },
    derived: contract.derive([]),
  });
  assert.strictEqual(d.phantoms.length, 1);
  assert.deepStrictEqual(d.phantoms[0], { list: "MEMORY_WRITES", name: "add_instruction" });
});

test("a clean set of lists reports no phantoms", () => {
  const d = contract.drift({
    registeredNames: new Set(["a", "b"]),
    seedLists: { WORLD_ACTIONS: new Set(["a"]), MEMORY_WRITES: new Set(["b"]) },
    derived: contract.derive([]),
  });
  assert.strictEqual(d.phantoms.length, 0);
});

test("derive() builds the sets from declarations alone", () => {
  const tools = [
    contract.normalize(stub({ name: "t_read", effects: ["read"] })),
    contract.normalize(stub({ name: "t_mem", effects: ["write:memory"] })),
    contract.normalize(stub({
      name: "t_send", effects: ["send:external"], risk: "high", confirmSummary: () => "x",
    })),
    contract.normalize(stub({ name: "t_legacy" })), // declares nothing
  ];
  const d = contract.derive(tools);
  assert.ok(!d.world.has("t_read"), "a pure read is not a world action");
  assert.ok(d.world.has("t_mem") && d.world.has("t_send"));
  assert.ok(d.memoryWrites.has("t_mem"));
  assert.ok(!d.memoryWrites.has("t_send"));
  assert.ok(d.durableGuarded.has("t_send"));
  assert.ok(d.repeatGuarded.has("t_mem"));
  assert.ok(d.unattendedBlocked.has("t_send"));
  assert.ok(!d.world.has("t_legacy"), "a tool that declared nothing contributes nothing");
});

/* ================================================================== */
console.log("\nRegistry — the real registry, sealed");
/* ================================================================== */

require("../src/tools/builtins").registerBuiltins(registry);
const sealed = registry.seal();

test("the live registry seals with no phantoms", () => {
  assert.deepStrictEqual(
    sealed.phantoms, [],
    "a seed list names a tool that is not registered — that protection applies to nothing:\n" +
    sealed.phantoms.map((p) => `  ${p.list} → ${p.name}`).join("\n")
  );
});

test("every registered tool carries a normalised contract", () => {
  for (const t of registry.list()) {
    assert.ok(Array.isArray(t.effects), `${t.name} has no effects array`);
    assert.ok(Number.isFinite(t.timeoutMs), `${t.name} has no timeout`);
    assert.ok(Array.isArray(t.requires), `${t.name} has no requires array`);
    assert.ok(["never", "per-turn", "durable", "by-outcome"].includes(t.dedupe), `${t.name} dedupe=${t.dedupe}`);
  }
});

// ---- the four drifts this work fixed, pinned so they cannot return ----

test("REGRESSION: add_standing_instruction is gated as a memory write", () => {
  assert.ok(
    registry.EFFECTIVE.memoryWrites.has("add_standing_instruction"),
    "the tool that writes a PERMANENT rule into every future prompt must be grounded in the turn"
  );
  assert.ok(registry.get("add_standing_instruction"), "and it must actually exist");
});

test("REGRESSION: the add_instruction phantom is gone", () => {
  assert.ok(!registry.EFFECTIVE.memoryWrites.has("add_instruction"));
  assert.strictEqual(registry.get("add_instruction"), null);
});

test("REGRESSION: the other durable memory writes are gated too", () => {
  for (const n of ["remember_case", "remember_event", "remember_person_date",
                   "remember_fact", "update_my_profile", "remember_person", "add_person_note"]) {
    assert.ok(registry.get(n), `${n} should exist`);
    assert.ok(registry.EFFECTIVE.memoryWrites.has(n), `${n} writes durable memory but is not gated`);
  }
});

test("REGRESSION: calendar mutations are world actions", () => {
  for (const n of ["create_calendar_event", "update_calendar_event", "delete_calendar_event"]) {
    assert.ok(registry.get(n), `${n} should exist`);
    assert.ok(
      registry.isWorldAction(n),
      `${n} changes a third party's calendar — without this it is never claim-checked, ` +
      "never repeat-guarded, and filed in the ledger as a lookup"
    );
  }
});

test("REGRESSION: set_morning_brief is reachable as claimCheck evidence", () => {
  // claimCheck's "remind" family names it; before this it was not a world
  // action, so it could never appear in the session's executed list.
  assert.ok(registry.isWorldAction("set_morning_brief"));
});

test("REGRESSION: the remaining record mutations are world actions", () => {
  for (const n of ["set_timer", "complete_commitment", "configure_assistant",
                   "remove_finance_item", "remove_standing_instruction"]) {
    assert.ok(registry.get(n), `${n} should exist`);
    assert.ok(registry.isWorldAction(n), `${n} changes the user's records`);
  }
});

test("describe() reports the EFFECTIVE policy, not the contract default", () => {
  // place_phone_call declares no effects, so its contract default is
  // "never" — but the seed lists really do guard it by outcome. Reporting
  // the default here would be a lie to whatever reads it next.
  const d = registry.describe("place_phone_call");
  assert.strictEqual(d.dedupe, "by-outcome");
  assert.strictEqual(d.declaredDedupe, "never");
  assert.strictEqual(d.world, true);
  assert.strictEqual(registry.describe("send_whatsapp_message").dedupe, "durable");
  assert.strictEqual(registry.describe("web_search").dedupe, "never");
  assert.strictEqual(registry.describe("nonexistent_tool"), null);
});

test("catalogue() is JSON-serialisable and complete", () => {
  const c = registry.catalogue();
  assert.strictEqual(c.length, registry.list().length);
  const round = JSON.parse(JSON.stringify(c));
  assert.strictEqual(round.length, c.length, "a function leaked into the catalogue");
  assert.ok(c.every((t) => typeof t.name === "string" && t.name));
});

/* ================================================================== */
/* EXECUTION POLICY — against the real execute()                       */
/* ================================================================== */

(async () => {
  console.log("\nRegistry — execution policy");

  const ctx = {}; // no userId → no ledger writes, keeps this test pure

  await atest("a timeout is enforced, and a slow read reports as failed", async () => {
    registry.register({
      name: "test_slow_read",
      execute: () => new Promise((r) => setTimeout(() => r({ ok: true }), 3000)),
      timeoutMs: 600,
    });
    const res = await registry.execute("test_slow_read", {}, ctx);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.timedOut, true);
    assert.strictEqual(res.status, contract.OUTCOME.FAILED);
    assert.ok(res.ms < 2500, `should have given up early, took ${res.ms}ms`);
    registry.unregister("test_slow_read");
  });

  await atest("a timed-out WORLD action is PARTIAL, never failed", async () => {
    registry.register({
      name: "send_whatsapp_message_test_twin",
      execute: () => new Promise((r) => setTimeout(() => r({ ok: true }), 3000)),
      timeoutMs: 600,
    });
    // Force it into the world set the way a real send tool is in it.
    registry.EFFECTIVE.world.add("send_whatsapp_message_test_twin");
    const res = await registry.execute("send_whatsapp_message_test_twin", {}, ctx);
    assert.strictEqual(res.partial, true);
    assert.strictEqual(res.status, contract.OUTCOME.PARTIAL,
      "reporting a timed-out send as FAILED is how a user is told nothing was sent and sends it twice");
    assert.ok(/may still be happening/.test(res.error));
    assert.ok(/do NOT repeat the action/i.test(res.note));
    registry.EFFECTIVE.world.delete("send_whatsapp_message_test_twin");
    registry.unregister("send_whatsapp_message_test_twin");
  });

  await atest("a transient failure is retried; a permanent one is not", async () => {
    let calls = 0;
    registry.register({
      name: "test_flaky",
      effects: ["read"],
      retry: { attempts: 3, backoffMs: 10 },
      execute: () => {
        calls++;
        return calls < 3 ? { ok: false, error: "HTTP 503 unavailable" } : { ok: true, data: "third time" };
      },
    });
    const res = await registry.execute("test_flaky", {}, ctx);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(calls, 3);
    assert.strictEqual(res.attempts, 3);
    registry.unregister("test_flaky");

    let bad = 0;
    registry.register({
      name: "test_permanent",
      effects: ["read"],
      retry: { attempts: 3, backoffMs: 10 },
      execute: () => { bad++; return { ok: false, error: "city not found" }; },
    });
    const res2 = await registry.execute("test_permanent", {}, ctx);
    assert.strictEqual(res2.ok, false);
    assert.strictEqual(bad, 1, "a permanent error must not be retried — it wastes time and paid calls");
    registry.unregister("test_permanent");
  });

  await atest("a tool with no declared retry gets exactly one attempt", async () => {
    let calls = 0;
    registry.register({
      name: "test_legacy_no_retry",
      execute: () => { calls++; return { ok: false, error: "HTTP 503 unavailable" }; },
    });
    await registry.execute("test_legacy_no_retry", {}, ctx);
    assert.strictEqual(calls, 1, "nothing must change for the tools that existed before this policy");
    registry.unregister("test_legacy_no_retry");
  });

  await atest("a thrown error becomes an honest envelope, not a crash", async () => {
    registry.register({
      name: "test_throws",
      execute: () => { throw new Error("kaboom"); },
    });
    const res = await registry.execute("test_throws", {}, ctx);
    assert.strictEqual(res.ok, false);
    assert.ok(/kaboom/.test(res.error));
    assert.strictEqual(res.status, contract.OUTCOME.FAILED);
    registry.unregister("test_throws");
  });

  await atest("every execution carries a status", async () => {
    registry.register({ name: "test_status", execute: () => ({ ok: true, data: 1 }) });
    const res = await registry.execute("test_status", {}, ctx);
    assert.strictEqual(res.status, contract.OUTCOME.OK);
    assert.ok(Number.isFinite(res.ms));
    registry.unregister("test_status");
  });

  await atest("an unknown tool fails cleanly", async () => {
    const res = await registry.execute("no_such_tool", {}, ctx);
    assert.strictEqual(res.ok, false);
    assert.ok(/unknown tool/.test(res.error));
  });

  console.log(`\n${passed} checks passed`);
})();
