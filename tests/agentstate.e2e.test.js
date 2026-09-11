/**
 * AGENT STATE REGRESSION TESTS — `npm run test:state`.
 *
 * Every case here is a failure that reached real testers, taken from the
 * 11 September conversation export. They are written against the state
 * machinery rather than the model, because these were architecture bugs:
 * memory acting as a command, claims without execution, a fragment
 * inheriting the previous request, one user's context reaching another.
 *
 * Needs Postgres (the execution log and conversation turns are durable);
 * everything it writes is under reserved test user ids and removed at the
 * end.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@localhost:5432/myassistant";

const assert = require("assert");
const db = require("../src/db");
const sessionState = require("../src/agents/sessionState");
const inputQuality = require("../src/agents/inputQuality");
const claimCheck = require("../src/agents/claimCheck");
const actions = require("../src/actions/store");
const recent = require("../src/memory/recent");
const registry = require("../src/tools/registry");

const USER_A = 99001;
const USER_B = 99002;

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
const settle = () => new Promise((r) => setTimeout(r, 600));

/* ================================================================== */
/* 1. GARBLED SPEECH MUST NOT INHERIT THE PREVIOUS REQUEST            */
/*    Tester log: "con" → "Finding 'amma' and calling…"               */
/* ================================================================== */
console.log("\ninput quality");

test('"con" is garbled, not a command', () => {
  const a = inputQuality.assess("con");
  assert.strictEqual(a.quality, "garbled");
  assert.strictEqual(inputQuality.mayAct(a), false);
});

test("a bare phone number is not an instruction", () => {
  // Tester log: "16366895760" produced "Finding Loki sir and calling".
  const a = inputQuality.assess("16366895760");
  assert.notStrictEqual(a.quality, "clear");
  assert.strictEqual(a.digitsOnly, true);
});

test("a number IS an answer when one was asked for", () => {
  const a = inputQuality.assess("16366895760", { expectsNumber: true });
  assert.strictEqual(a.quality, "clear");
});

test("mis-detected foreign speech is garbled for an Indian-language user", () => {
  // Tester log: Tulu transcribed as Japanese and French, then answered in those.
  assert.strictEqual(
    inputQuality.assess("あれ みつぼう だ わ", { languages: ["English", "Kannada"] }).quality,
    "garbled"
  );
  assert.strictEqual(
    inputQuality.assess("Non, non, je dis que non", { languages: ["English", "Tulu"] }).quality,
    "garbled"
  );
});

test("ordinary requests stay clear", () => {
  for (const line of [
    "Call to Dikshit Pujari.",
    "Open her profile",
    "Show me the photo of Neha Shetty from Instagram.",
    "yes",
    "Hello.",
  ]) {
    assert.strictEqual(inputQuality.assess(line).quality, "clear", line);
  }
});

/* ================================================================== */
/* 2. A REPLY MAY NOT CLAIM WHAT DID NOT RUN                          */
/*    Tester log: "Opening Instagram… There you go!" with no tool call */
/* ================================================================== */
console.log("\nclaim check");

test("claiming an app opened with no tool call is corrected", () => {
  const v = claimCheck.check(
    "Sure thing! Opening Instagram and searching for Ashmita. There you go!",
    []
  );
  assert.strictEqual(v.ok, false);
  assert.ok(!/Opening Instagram/i.test(v.text), "false claim survived");
  assert.ok(!/There you go/i.test(v.text), "filler survived the correction");
});

test("the same sentence is left alone when the tool really ran", () => {
  const v = claimCheck.check("Opening Instagram for Yashmita right now!", [
    { tool: "open_app", ok: true },
  ]);
  assert.strictEqual(v.ok, true);
  assert.match(v.text, /Opening Instagram/);
});

test("a failed tool does not satisfy a claim", () => {
  const v = claimCheck.check("Calling Jeevan now.", [
    { tool: "place_phone_call", ok: false },
  ]);
  assert.strictEqual(v.ok, false);
});

test("offers and questions are not claims", () => {
  for (const line of [
    "Shall I call Jeevan for you?",
    "Do you want me to open Instagram?",
    "I can call him if you like.",
  ]) {
    assert.strictEqual(claimCheck.check(line, []).ok, true, line);
  }
});

test("questions about past actions are routed to the action record", () => {
  assert.ok(claimCheck.familiesAskedAbout("Why did you opened Google search now?"));
  assert.ok(claimCheck.familiesAskedAbout("When did I ask you to call Jeevan?"));
  assert.strictEqual(claimCheck.familiesAskedAbout("What is the weather today?"), null);
});

/* ================================================================== */
/* 3. SESSION STATE: NOTHING IS INHERITED                             */
/*    Tester log: "Hello." → "You asked to call Jeevan…"              */
/* ================================================================== */
console.log("\nsession state");

test("a new session starts with no pending action and no entity", () => {
  const older = sessionState.begin(USER_A, "s-old", { surface: "live" });
  sessionState.setPending(older, { tool: "place_phone_call", args: { name: "Jeevan" }, summary: "Call Jeevan" });
  sessionState.setEntity(older, { name: "Jeevan", kind: "contact" });
  sessionState.end(USER_A, "s-old");

  const fresh = sessionState.begin(USER_A, "s-new", { surface: "live" });
  assert.strictEqual(fresh.pending, null, "pending action leaked into a new session");
  assert.strictEqual(sessionState.activeEntity(fresh), null, "entity leaked into a new session");
  assert.deepStrictEqual(fresh.executed, []);
});

test("a correction replaces the active entity outright", () => {
  const st = sessionState.begin(USER_A, "s-entity", {});
  sessionState.setEntity(st, { name: "Ashmita", kind: "person" });
  sessionState.setEntity(st, { name: "Yashmita", kind: "person" });
  assert.strictEqual(sessionState.activeEntity(st).name, "Yashmita");
  sessionState.end(USER_A, "s-entity");
});

test("an unanswered pending action expires instead of waiting forever", () => {
  const st = sessionState.begin(USER_A, "s-pending", {});
  sessionState.setPending(st, { tool: "place_phone_call", args: { name: "Jeevan" } });
  st.pending.askedAt = Date.now() - (sessionState.PENDING_TTL_MS + 1000);
  sessionState.beginTurn(st, { turnId: "t1", text: "Hello.", quality: "clear" });
  assert.strictEqual(st.pending, null, "a stale pending action survived a new turn");
  sessionState.end(USER_A, "s-pending");
});

test("a pending action is only taken on an explicit yes", () => {
  const st = sessionState.begin(USER_A, "s-confirm", {});
  sessionState.setPending(st, { tool: "place_phone_call", args: { name: "Jeevan" } });
  assert.strictEqual(sessionState.takePending(st, { confirmed: false }), null);
  assert.strictEqual(st.pending, null, "a refused action stayed pending");
  sessionState.end(USER_A, "s-confirm");
});

/* ================================================================== */
/* 4. THE EXECUTION LOG IS AUTHORITATIVE                              */
/*    Tester log: "I don't remember opening Google search recently"   */
/* ================================================================== */
console.log("\nexecution record");

(async () => {
  await atest("a world action is recorded and can be read back", async () => {
    const st = sessionState.begin(USER_A, "s-exec", { surface: "voice" });
    sessionState.beginTurn(st, { turnId: "t-exec", text: "open google", quality: "clear" });
    sessionState.recordExecution(st, {
      turnId: "t-exec",
      tool: "open_webpage",
      args: { url: "https://www.google.com/search?q=neha+shetty" },
      ok: true,
    });
    await settle();
    const hit = await actions.didRun(USER_A, ["open_webpage", "open_app"], {
      sinceMs: Date.now() - 60_000,
    });
    assert.ok(hit, "the executed action was not in the durable record");
    assert.match(actions.describe(hit), /opened/);
    sessionState.end(USER_A, "s-exec");
  });

  await atest("the record is per user — no leakage between testers", async () => {
    const stB = sessionState.begin(USER_B, "s-b", { surface: "voice" });
    sessionState.beginTurn(stB, { turnId: "t-b", text: "call amma", quality: "clear" });
    sessionState.recordExecution(stB, {
      turnId: "t-b",
      tool: "place_phone_call",
      args: { name: "Amma" },
      ok: true,
    });
    await settle();
    const aRows = await actions.recent(USER_A, { limit: 20 });
    assert.ok(
      !aRows.some((r) => String(r.target).toLowerCase() === "amma"),
      "user B's call appeared in user A's record"
    );
    const bRows = await actions.recent(USER_B, { limit: 20 });
    assert.ok(bRows.some((r) => r.tool === "place_phone_call"));
    sessionState.end(USER_B, "s-b");
  });

  await atest("executedThisTurn only reports the current turn", async () => {
    const st = sessionState.begin(USER_A, "s-turns", {});
    sessionState.beginTurn(st, { turnId: "t1", text: "open instagram", quality: "clear" });
    sessionState.recordExecution(st, { turnId: "t1", tool: "open_app", args: { app: "instagram" }, ok: true });
    sessionState.beginTurn(st, { turnId: "t2", text: "hello", quality: "clear" });
    assert.deepStrictEqual(sessionState.executedThisTurn(st), []);
    sessionState.end(USER_A, "s-turns");
  });

  /* ================================================================ */
  /* 5. THE REGISTRY GATES                                            */
  /* ================================================================ */
  console.log("\ntool gates");

  require("../src/tools/builtins").registerBuiltins();

  await atest("a world action is refused on garbled input", async () => {
    const st = sessionState.begin(USER_A, "s-gate", {});
    sessionState.beginTurn(st, { turnId: "g1", text: "con", quality: "garbled" });
    const res = await registry.execute(
      "place_phone_call",
      { name: "amma" },
      {
        userId: USER_A,
        session: st,
        turnId: "g1",
        inputQuality: { quality: "garbled", reason: "single short fragment", heard: "con" },
      }
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "unclear_request");
    sessionState.end(USER_A, "s-gate");
  });

  await atest("a harmless lookup still runs on poor input", async () => {
    const st = sessionState.begin(USER_A, "s-gate2", {});
    sessionState.beginTurn(st, { turnId: "g2", text: "con", quality: "garbled" });
    const res = await registry.execute(
      "list_reminders",
      {},
      { userId: USER_A, session: st, turnId: "g2", inputQuality: { quality: "garbled" } }
    );
    assert.notStrictEqual(res.error, "unclear_request");
    sessionState.end(USER_A, "s-gate2");
  });

  await atest("the same action twice in a breath is not repeated", async () => {
    const st = sessionState.begin(USER_A, "s-dup", {});
    sessionState.beginTurn(st, { turnId: "d1", text: "open instagram", quality: "clear" });
    const ctx = { userId: USER_A, session: st, turnId: "d1", inputQuality: { quality: "clear" } };
    const first = await registry.execute("open_app", { app: "instagram", query: "nehashetty" }, ctx);
    assert.strictEqual(first.ok, true);
    assert.ok(!first.repeated);
    const second = await registry.execute("open_app", { app: "instagram", query: "nehashetty" }, ctx);
    assert.ok(second.repeated, "the identical action ran twice");
    sessionState.end(USER_A, "s-dup");
  });

  await atest("check_recent_actions answers the Google-search question from the log", async () => {
    // Tester log: "Why did you opened Google search now?" was answered
    // "I don't remember opening Google search recently" — it had.
    const st = sessionState.begin(USER_A, "s-ask", {});
    sessionState.beginTurn(st, { turnId: "a1", text: "show me her images", quality: "clear" });
    sessionState.recordExecution(st, {
      turnId: "a1",
      tool: "open_webpage",
      args: { url: "https://www.google.com/search?tbm=isch&q=neha+shetty" },
      ok: true,
    });
    await settle();
    const res = await registry.execute(
      "check_recent_actions",
      { about: "google search" },
      { userId: USER_A, session: st, turnId: "a2", inputQuality: { quality: "clear" } }
    );
    assert.strictEqual(res.ok, true);
    assert.ok(Array.isArray(res.data) && res.data.length > 0, "the log had nothing to report");
    assert.match(res.speak, /opened/i);
    sessionState.end(USER_A, "s-ask");
  });

  /* ================================================================ */
  /* 6. MEMORY IS CONTEXT, NEVER A COMMAND                            */
  /* ================================================================ */
  console.log("\nconversation memory");

  await atest("a new session does not see its own turns as history", async () => {
    recent.append(USER_A, "user", "Call Jeevan", { sessionId: "sess-old", turnId: "m1" });
    recent.append(USER_A, "assistant", "Looking up Jeevan…", { sessionId: "sess-old", turnId: "m1" });
    recent.append(USER_A, "user", "Hello", { sessionId: "sess-new", turnId: "m2" });
    await settle();
    const block = await recent.recentBlock(USER_A, { excludeSessionId: "sess-new" });
    assert.ok(block.includes("Call Jeevan"), "earlier session missing from context");
    assert.ok(!block.includes("Hello"), "the current session was replayed as history");
  });

  await atest("the memory block forbids re-running what it contains", async () => {
    const block = await recent.recentBlock(USER_A, { excludeSessionId: "sess-new" });
    assert.match(block, /ALREADY (FINISHED|ACTED)/i);
    assert.match(block, /never repeat or re-run/i);
  });

  await atest("conversation memory is per user", async () => {
    recent.append(USER_B, "user", "Call Dikshit Pujari", { sessionId: "sess-b", turnId: "m3" });
    await settle();
    const blockA = await recent.recentBlock(USER_A, {});
    assert.ok(!blockA.includes("Dikshit"), "another user's conversation leaked in");
  });

  /* ---------------------------------------------------------------- */
  console.log("");
  for (const uid of [USER_A, USER_B]) {
    await db.run("DELETE FROM executed_actions WHERE user_id = $1", [uid]).catch(() => {});
    await db.run("DELETE FROM conversation_turns WHERE user_id = $1", [uid]).catch(() => {});
    await db.run("DELETE FROM reminders WHERE user_id = $1", [uid]).catch(() => {});
  }
  console.log(`${passed} checks passed`);
  process.exit(process.exitCode || 0);
})();
