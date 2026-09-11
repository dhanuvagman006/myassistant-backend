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
const fs = require("fs");
const db = require("../src/db");
const sessionState = require("../src/agents/sessionState");
const inputQuality = require("../src/agents/inputQuality");
const claimCheck = require("../src/agents/claimCheck");
const actions = require("../src/actions/store");
const recent = require("../src/memory/recent");
const registry = require("../src/tools/registry");
const outcomes = require("../src/outcomes/store");

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

  /* ================================================================ */
  /* 7. THE SPOKEN WORD IS GATED TOO                                  */
  /*    A false claim must never be SPOKEN, not merely corrected      */
  /*    afterwards in the final text.                                 */
  /* ================================================================ */
  console.log("\nspeech gate");

  test("a sentence asserting an action is recognised as a claim", () => {
    assert.strictEqual(claimCheck.classify("Opening Instagram for you now."), "open");
    assert.strictEqual(claimCheck.classify("Calling Jeevan now."), "call");
    assert.strictEqual(claimCheck.classify("What would you like to hear?"), null);
    assert.strictEqual(claimCheck.classify("Shall I call him?"), null);
  });

  test("a held claim is released unchanged once its tool has run", () => {
    assert.strictEqual(claimCheck.satisfied("open", [{ tool: "open_app", ok: true }]), true);
    assert.strictEqual(claimCheck.satisfied("open", [{ tool: "open_app", ok: false }]), false);
    assert.strictEqual(claimCheck.satisfied("open", []), false);
    assert.match(claimCheck.honestFor("open", "Opening Instagram."), /couldn't open/i);
  });

  /* ================================================================ */
  /* 8. THE CONVERSATION IS READABLE                                  */
  /*    Tester log: "What was my previous request before this?"       */
  /* ================================================================ */
  console.log("\nconversation recall");

  await atest("recall_conversation answers from the transcript", async () => {
    recent.append(USER_A, "user", "Call Jeevan B2", { sessionId: "s-recall", turnId: "r1" });
    recent.append(USER_A, "assistant", "Looking up Jeevan B2…", { sessionId: "s-recall", turnId: "r1" });
    await settle();
    const res = await registry.execute(
      "recall_conversation",
      { about: "Jeevan" },
      { userId: USER_A, sessionId: "s-recall", inputQuality: { quality: "clear" } }
    );
    assert.strictEqual(res.ok, true);
    assert.ok(res.data.length > 0, "the transcript query found nothing");
    assert.match(res.speak, /Jeevan/);
  });

  await atest("recall_conversation refuses to invent when there is nothing", async () => {
    const res = await registry.execute(
      "recall_conversation",
      { about: "zzzznothinglikethis" },
      { userId: USER_A, sessionId: "s-recall", inputQuality: { quality: "clear" } }
    );
    assert.strictEqual(res.data.length, 0);
    assert.match(res.speak, /do not invent/i);
  });

  /* ================================================================ */
  /* 9. LOCATION IS ANSWERED, NOT DEFLECTED INTO SETTINGS             */
  /*    Tester log: "What is the current location I am located?" →    */
  /*    the assistant opened the location settings screen.            */
  /* ================================================================ */
  console.log("\nlocation");

  await atest("a location question is answered from the phone's coordinates", async () => {
    const res = await registry.execute(
      "get_current_location",
      {},
      { userId: USER_A, lat: 12.8697, lng: 74.8431, inputQuality: { quality: "clear" } }
    );
    assert.strictEqual(res.ok, true);
    assert.ok(res.speak && res.speak.length > 0);
  });

  await atest("without coordinates it says so instead of opening settings", async () => {
    const res = await registry.execute(
      "get_current_location",
      {},
      { userId: USER_A, inputQuality: { quality: "clear" } }
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "no_location");
    assert.ok(!res.deviceAction, "it tried to open something on the phone");
    assert.match(res.data.hint, /OFFER/);
  });

  /* ================================================================ */
  /* 10. A REPEAT IS DECIDED BY THE ACTION RECORD, NOT BY A CLOCK      */
  /*     "Call Dikshit Pujari" was answered three different ways in    */
  /*     forty seconds because each repetition arrived on a different  */
  /*     surface and the only guard was a list held by one socket.     */
  /* ================================================================ */
  console.log("\nrepeat identity");

  await atest("the action record finds the same action from another session", async () => {
    actions.record(USER_A, {
      sessionId: "live-1", turnId: "t1", tool: "open_app",
      args: { app: "Instagram" }, ok: true, surface: "live",
    });
    await settle();
    const hit = await actions.findRecent(USER_A, "open_app", "Instagram", 60_000);
    assert.ok(hit, "a record written on the live surface was invisible to the voice surface");
    assert.strictEqual(hit.session_id, "live-1");
  });

  await atest("it does not reach across users or past the window", async () => {
    assert.strictEqual(await actions.findRecent(USER_B, "open_app", "Instagram", 60_000), null);
    assert.strictEqual(await actions.findRecent(USER_A, "open_app", "Instagram", 1), null);
    assert.strictEqual(await actions.findRecent(USER_A, "open_app", "Twitter", 60_000), null);
  });

  await atest("an app relaunch from a NEW session is allowed", async () => {
    // Reopening an app you just backed out of is ordinary. The durable
    // tier deliberately does not guard app launches — only the same-breath
    // double-fire is a bug, and that is the session tier's job.
    const res = await registry.execute(
      "open_app",
      { app: "Instagram" },
      { userId: USER_A, sessionId: "voice-2", inputQuality: { quality: "clear" } }
    );
    assert.notStrictEqual(res.repeated, true, "a legitimate relaunch was refused");
  });

  await atest("a repeated message DOES cross the session boundary", async () => {
    // Something that has left the device is a different matter.
    actions.record(USER_A, {
      sessionId: "live-1", turnId: "m1", tool: "send_whatsapp_message",
      args: { to: "Dikshit Pujari", message: "on my way" }, ok: true, surface: "live",
    });
    await settle();
    const res = await registry.execute(
      "send_whatsapp_message",
      { to: "Dikshit Pujari", message: "on my way" },
      { userId: USER_A, sessionId: "voice-2", inputQuality: { quality: "clear" } }
    );
    assert.strictEqual(res.repeated, true, "the repeat crossed a session boundary unchecked");
    assert.match(res.note, /already ran/i);
  });

  await atest("a suppressed action still satisfies the claim checker", async () => {
    // Suppression used to leave the turn with no executed tool, so the
    // reply was rewritten to "I couldn't send that" about a message that
    // had in fact gone out a moment earlier — the exact lie the claim
    // checker exists to prevent.
    const st = sessionState.begin(USER_A, "s-suppress", {});
    sessionState.beginTurn(st, { turnId: "sp1", text: "message Dikshit", quality: "clear" });
    const res = await registry.execute(
      "send_whatsapp_message",
      { to: "Dikshit Pujari", message: "on my way" },
      { userId: USER_A, session: st, sessionId: "s-suppress", turnId: "sp1",
        inputQuality: { quality: "clear" } }
    );
    assert.strictEqual(res.repeated, true, "precondition: it should have been suppressed");
    const executed = sessionState.executedThisTurn(st);
    assert.ok(executed.some((e) => e.tool === "send_whatsapp_message" && e.suppressed),
      "the suppressed action was not recorded for this turn");
    assert.strictEqual(claimCheck.satisfied("message", executed), true,
      "the reply would have been rewritten into a denial");
    sessionState.end(USER_A, "s-suppress");
  });

  await atest("a call still dialing blocks a second dial — even an approved one", async () => {
    const row = await outcomes.create(USER_A, {
      kind: "call", target: "Dikshit Pujari", status: "dialing", path: "device",
      sessionId: "voice-2",
    });
    assert.ok(row, "outcome row was not created");
    const res = await registry.execute(
      "place_phone_call",
      { name: "Dikshit Pujari" },
      { userId: USER_A, sessionId: "voice-3", approved: true, inputQuality: { quality: "clear" } }
    );
    // Confirming the same call twice, on two surfaces, is exactly the
    // failure — so the in-flight tier must hold on the approved path too.
    assert.strictEqual(res.repeated, true, "an approved replay dialled over a live call");
    assert.strictEqual(res.data.inFlight, true);
    const res2 = await registry.execute(
      "place_phone_call",
      { name: "Dikshit Pujari" },
      { userId: USER_A, sessionId: "voice-3", inputQuality: { quality: "clear" } }
    );
    assert.strictEqual(res2.repeated, true, "it dialled a second time mid-call");
    await outcomes.update(USER_A, row.id, { status: "no_answer" });
    assert.strictEqual(
      await outcomes.findInFlight(USER_A, ["call", "agent_call"], "Dikshit Pujari"), null,
      "a finished call still counted as in flight"
    );
  });

  await atest("a cancelled call can be asked for again immediately", async () => {
    // The row is written when the call is DISPATCHED — before the user
    // approves the card. Declining left an ok=1 row that refused the retry.
    actions.record(USER_A, {
      sessionId: "voice-9", turnId: "c1", tool: "place_phone_call",
      args: { name: "Sunil" }, ok: true, surface: "voice",
    });
    await settle();
    assert.ok(await actions.findRecent(USER_A, "place_phone_call", "Sunil", 60_000),
      "precondition: the dispatch row exists");
    await actions.invalidate(USER_A, "place_phone_call", "Sunil", { detail: "cancelled" });
    const row = await actions.findRecent(USER_A, "place_phone_call", "Sunil", 60_000);
    assert.ok(row && Number(row.ok) === 0, "the cancelled dispatch was not retracted");
    const res = await registry.execute(
      "place_phone_call",
      { name: "Sunil" },
      { userId: USER_A, sessionId: "voice-9", inputQuality: { quality: "clear" } }
    );
    assert.notStrictEqual(res.repeated, true, "a cancelled call could not be retried");
  });

  test("two different orders are not the same request", () => {
    // targetOf stringified undefined into the two-character string '""',
    // so every order_food matched every other one inside the window.
    assert.strictEqual(actions.targetOf("order_food", { dish: "biryani" }), "biryani");
    assert.notStrictEqual(
      actions.targetOf("order_food", { dish: "biryani" }),
      actions.targetOf("order_food", { dish: "pizza" })
    );
    assert.strictEqual(actions.targetOf("book_ride", { destination: "airport" }), "airport");
    assert.strictEqual(actions.targetOf("order_food", {}), "",
      "an unidentifiable target must be empty, never a matchable constant");
  });

  await atest("an unidentifiable target is never treated as a repeat", async () => {
    const ctx = { userId: USER_A, sessionId: "voice-blank", inputQuality: { quality: "clear" } };
    const a = await registry.execute("order_food", { dish: "biryani" }, ctx);
    const b = await registry.execute("order_food", { dish: "masala dosa" }, ctx);
    assert.notStrictEqual(b.repeated, true, "two different orders collided");
    void a;
  });

  /* ================================================================ */
  /* 11. A TURN THAT ASKS FOR CONFIRMATION IS STILL A TURN            */
  /*     It used to return an empty string and write nothing, so the  */
  /*     request and the question asked back were both missing from   */
  /*     the transcript and "what did I just ask you?" found a hole.  */
  /* ================================================================ */
  console.log("\nconfirmation turns");

  test("the confirmation branch is no longer a silent return", () => {
    // The branch cannot be exercised without the model, so this guards its
    // shape: it must write to durable memory and carry the question out.
    const src = String(require("../src/agents/runtime").runAgentTurn);
    const i = src.indexOf("res.needsConfirmation");
    assert.ok(i > 0, "the confirmation branch has moved — update this guard");
    const branch = src.slice(i, i + 1600);
    assert.match(branch, /recentMem\.append/, "the confirmation turn is not written to memory");
    assert.match(branch, /setPending/, "the pending action is not held in session state");
    assert.ok(branch.includes("question"), "the question asked back is not returned");
  });

  await atest("the question and the request both reach the transcript", async () => {
    const meta = { sessionId: "confirm-1", turnId: "c1", source: "voice" };
    recent.append(USER_A, "user", "Call Dikshit Pujari", { ...meta, latencyMs: 0 });
    recent.append(USER_A, "assistant", "Call Dikshit Pujari?", meta);
    await settle();
    const rows = await recent.turns(USER_A, { limit: 10, sessionId: "confirm-1" });
    const texts = rows.map((r) => r.text);
    assert.ok(texts.includes("Call Dikshit Pujari"), "the request is missing");
    assert.ok(texts.includes("Call Dikshit Pujari?"), "the question asked back is missing");
  });

  test("a pending action is held in state and taken exactly once", () => {
    const st = sessionState.begin(USER_A, "confirm-2");
    assert.strictEqual(sessionState.takePending(st), null, "a new session began with a pending action");
    sessionState.setPending(st, {
      tool: "place_phone_call", args: { name: "Dikshit Pujari" }, summary: "Call Dikshit Pujari",
    });
    const taken = sessionState.takePending(st);
    assert.ok(taken && taken.tool === "place_phone_call");
    assert.strictEqual(sessionState.takePending(st), null, "the same pending action could be taken twice");
    sessionState.end(USER_A, "confirm-2");
  });

  /* ================================================================ */
  /* 12. THE LEDGER: requested -> tool -> arguments -> result -> reply */
  /*     The record showed WHICH tool ran and whether it worked. The   */
  /*     middle — what the user asked, what arguments the model chose, */
  /*     what came back — was the span every failure lived in.        */
  /* ================================================================ */
  console.log("\nledger");

  await atest("a turn is recorded end to end", async () => {
    const st = sessionState.begin(USER_A, "s-ledger", { surface: "voice" });
    sessionState.beginTurn(st, {
      turnId: "L1", text: "open instagram and find neha shetty", quality: "clear",
    });
    await registry.execute(
      "open_app",
      { app: "instagram", query: "nehashetty" },
      { userId: USER_A, session: st, sessionId: "s-ledger", turnId: "L1",
        inputQuality: { quality: "clear" } }
    );
    actions.attachReply(USER_A, "L1", "Opening Instagram for you.");
    await settle();

    const turns = await actions.ledger(USER_A, { sessionId: "s-ledger" });
    assert.strictEqual(turns.length, 1, "the turn was not grouped into one entry");
    const t = turns[0];
    assert.match(t.intent, /instagram/i, "the request was not recorded");
    assert.strictEqual(t.surface, "voice");
    assert.ok(t.steps.length >= 1, "no tool step recorded");
    const step = t.steps.find((x) => x.tool === "open_app");
    assert.ok(step, "the tool that ran is missing from the ledger");
    assert.match(step.args, /nehashetty/, "the arguments the model chose were not kept");
    assert.strictEqual(step.ok, true);
    assert.ok(step.result.length > 0, "nothing recorded about what came back");
    assert.match(t.reply, /Opening Instagram/, "the final response was not attached");
    sessionState.end(USER_A, "s-ledger");
  });

  await atest("a failure is recorded as a failure, with its reason", async () => {
    const st = sessionState.begin(USER_A, "s-ledger-fail", { surface: "voice" });
    sessionState.beginTurn(st, { turnId: "L2", text: "where am I", quality: "clear" });
    const res = await registry.execute(
      "get_current_location",
      {},
      { userId: USER_A, session: st, sessionId: "s-ledger-fail", turnId: "L2",
        inputQuality: { quality: "clear" } }
    );
    assert.strictEqual(res.ok, false, "precondition: no coordinates were given");
    await settle();
    const turns = await actions.ledger(USER_A, { sessionId: "s-ledger-fail" });
    const step = turns[0] && turns[0].steps[0];
    assert.ok(step, "the failed call left no ledger row");
    assert.strictEqual(step.ok, false, "a failure was recorded as a success");
    assert.match(step.result, /no_location|error/i, "the reason was not kept");
    sessionState.end(USER_A, "s-ledger-fail");
  });

  test("arguments are redacted before they are stored", () => {
    // The ledger is rendered in the admin panel; a token pasted into a
    // tool argument must not be what lands there.
    const text = actions.argsText({ query: "weather", api_key: "sk-secret-value" });
    assert.match(text, /weather/);
    assert.ok(!text.includes("sk-secret-value"), "a secret reached the ledger");
  });

  /* ================================================================ */
  /* 13. THE INVARIANTS ARE WIRED, NOT JUST WRITTEN DOWN              */
  /*     The audit found the state machine was largely write-only:    */
  /*     takePending, activeEntity, setEntity and clarificationFor    */
  /*     had zero callers. A passing test over an API production      */
  /*     never reaches proves nothing, so these assert the wiring.    */
  /* ================================================================ */
  console.log("\nwired invariants");

  test("E — a claim is caught in every language the product speaks", () => {
    // Tester sessions run in English, Hindi, Kannada and Tulu. An
    // English-only pattern let a false claim through in the other three.
    const cases = [
      ["Calling Ravi now.", "call"],
      ["ರವಿಗೆ ಕರೆ ಮಾಡುತ್ತಿದ್ದೇನೆ.", "call"],
      ["मैं रवि को कॉल कर रहा हूँ।", "call"],
      ["ഞാൻ വിളിക്കുന്നു.", "call"],
      ["ಇನ್‌ಸ್ಟಾಗ್ರಾಮ್ ತೆರೆಯುತ್ತಿದ್ದೇನೆ.", "open"],
      ["இன்ஸ்டாகிராம் திறக்கிறேன்.", "open"],
      ["मैसेज भेज दिया।", "message"],
      ["ಅಲಾರಂ ಇಟ್ಟಿದ್ದೇನೆ.", "remind"],
      ["సంగీతం ప్లే చేస్తున్నాను.", "play"],
      ["Shall I call him?", null],
      ["I called her yesterday.", null],
    ];
    for (const [text, want] of cases) {
      assert.strictEqual(claimCheck.classify(text), want,
        `classify(${JSON.stringify(text)}) should be ${want}`);
    }
  });

  test("E — an unsupported claim in Kannada is corrected, not spoken", () => {
    const v = claimCheck.check("ರವಿಗೆ ಕರೆ ಮಾಡುತ್ತಿದ್ದೇನೆ.", []);
    assert.strictEqual(v.ok, false, "a Kannada false claim passed unchecked");
    assert.match(v.text, /couldn't start that call/i);
  });

  test("G — a resolved contact becomes the entity pronouns refer to", () => {
    const st = sessionState.begin(USER_A, "s-entity", {});
    assert.strictEqual(sessionState.activeEntity(st), null, "a new session had an entity");
    sessionState.setEntity(st, {
      kind: "contact", name: "Ashmita", phone: "+919000000001", source: "device_contacts",
    });
    assert.strictEqual(sessionState.activeEntity(st).name, "Ashmita");
    // The correction must REPLACE, not merge — the tester case was
    // "no, it's Yashmita" leaving Ashmita still active.
    sessionState.setEntity(st, {
      kind: "contact", name: "Yashmita", phone: "+919000000002", source: "device_contacts",
    });
    const who = sessionState.activeEntity(st);
    assert.strictEqual(who.name, "Yashmita");
    assert.strictEqual(who.phone, "+919000000002", "the old number survived the correction");
    sessionState.end(USER_A, "s-entity");
  });

  test("H — a background run gets its own session, never a shared one", () => {
    // Every scheduled run used to fall back to one key per user, so jobs
    // inherited each other's executed list, entity and pending action.
    const src = String(require("../src/agents/runtime").runAgentTurn);
    assert.ok(!/runtime:\$\{ctx\.userId/.test(src),
      "the runtime still falls back to a per-user constant session key");
    const handlers = fs.readFileSync(
      require.resolve("../src/infra/handlers.js"), "utf8");
    assert.match(handlers, /jobSessionId = `job:\$\{job\./,
      "scheduled tasks do not mint a session id of their own");
    assert.match(handlers, /sessionId: jobSessionId/,
      "the job session id is not passed into the turn");
  });

  test("J — the live path no longer pre-approves every tool", () => {
    // approved:true meant both "not high risk" and "the user said yes",
    // so the input-quality gate never fired in live mode.
    const proxy = fs.readFileSync(require.resolve("../src/live/proxy.js"), "utf8");
    assert.match(proxy, /approved: userConfirmed/,
      "live tool calls no longer carry a real approval flag");
    assert.ok(!/^\s*let approved = true;/m.test(proxy),
      "the blanket approval flag is still there");
  });

  await atest("J — a garbled turn is answered with a question, not an action", async () => {
    // "con" used to reach the model and come back as a confident reply
    // about the previous conversation's contact.
    const a = inputQuality.assess("con");
    assert.strictEqual(a.quality, "garbled", "precondition: this is garbled");
    const ask = inputQuality.clarificationFor(a, { language: "Kannada" });
    assert.ok(ask && ask.length > 0);
    const runtime = fs.readFileSync(require.resolve("../src/agents/runtime.js"), "utf8");
    assert.match(runtime, /quality\.quality === "garbled"/,
      "the runtime does not short-circuit a garbled turn before the model");
    assert.match(runtime, /clarificationFor/,
      "clarificationFor still has no caller in the runtime");
  });

  test("A/C — a confirmation card expires and a new utterance retires it", () => {
    const routes = fs.readFileSync(require.resolve("../src/assistant/routes.js"), "utf8");
    assert.match(routes, /askedAt: Date\.now\(\)/,
      "confirmation cards carry no timestamp, so none can expire");
    assert.match(routes, /pending\.askedAt && Date\.now\(\) - pending\.askedAt > PENDING_TTL_MS/,
      "an old card is still executable by one POST /confirm");
    assert.match(routes, /s\.pending = null;\n    s\.ambiguous = null;/,
      "a new utterance no longer retires the previous card");
  });

  await atest("F — a failed call is retracted under either name", async () => {
    // "call mom" resolves to a contact stored as "Amma Lobo"; the handset
    // reports the RESOLVED name, and the row was written under the spoken
    // one — so the failure never retracted and the log said it succeeded.
    actions.record(USER_A, {
      sessionId: "s-resolve", turnId: "R1", tool: "place_phone_call",
      args: { name: "mom" }, ok: true, surface: "voice",
    });
    await settle();
    await actions.attachResolvedTarget(USER_A, "place_phone_call", "mom", "Amma Lobo");
    await actions.invalidate(USER_A, "place_phone_call", "Amma Lobo",
      { detail: "call failed" });
    const row = await actions.findRecent(USER_A, "place_phone_call", "mom", 60_000);
    assert.ok(row, "the row disappeared");
    assert.strictEqual(Number(row.ok), 0,
      "a failed call under a nickname is still recorded as a success");
  });

  /* ================================================================ */
  /* 14. A REFUSAL IS A DECISION, AND DECISIONS ARE OBSERVABLE        */
  /*     Declining to act left no trace at all — no row, no audit     */
  /*     line, not even a log entry. "It ignored me", "it asked me    */
  /*     to repeat myself" and "it said it was already doing that"    */
  /*     were indistinguishable afterwards.                           */
  /* ================================================================ */
  console.log("\nobservable decisions");

  await atest("a refused action is recorded as refused", async () => {
    const st = sessionState.begin(USER_A, "s-refuse", { surface: "voice" });
    sessionState.beginTurn(st, { turnId: "RF1", text: "con", quality: "garbled" });
    const res = await registry.execute(
      "place_phone_call",
      { name: "amma" },
      { userId: USER_A, session: st, sessionId: "s-refuse", turnId: "RF1",
        inputQuality: { quality: "garbled", reason: "too short", heard: "con" } }
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "unclear_request");
    await settle();
    const turns = await actions.ledger(USER_A, { sessionId: "s-refuse" });
    const step = turns[0] && turns[0].steps[0];
    assert.ok(step, "the refusal left no trace");
    assert.strictEqual(step.decision, "refused");
    assert.strictEqual(step.ok, false);
    assert.match(step.result, /too short|con/i, "the reason was not kept");
    sessionState.end(USER_A, "s-refuse");
  });

  await atest("a suppressed repeat is recorded as suppressed, not as a run", async () => {
    const st = sessionState.begin(USER_A, "s-supp2", { surface: "voice" });
    sessionState.beginTurn(st, { turnId: "SP2", text: "message Dikshit", quality: "clear" });
    const ctx = { userId: USER_A, session: st, sessionId: "s-supp2", turnId: "SP2",
      inputQuality: { quality: "clear" } };
    await registry.execute("send_whatsapp_message",
      { to: "Rohan", message: "on my way" }, ctx);
    await settle();
    const again = await registry.execute("send_whatsapp_message",
      { to: "Rohan", message: "on my way" }, ctx);
    assert.strictEqual(again.repeated, true, "precondition: the repeat is suppressed");
    await settle();
    const turns = await actions.ledger(USER_A, { sessionId: "s-supp2" });
    const decisions = turns.flatMap((t) => t.steps.map((x) => x.decision));
    assert.ok(decisions.includes("suppressed"),
      "the suppression is invisible in the ledger");
    assert.ok(decisions.includes("ran"), "the real send is missing");
    sessionState.end(USER_A, "s-supp2");
  });

  await atest("how long each step took is kept", async () => {
    const st = sessionState.begin(USER_A, "s-ms", { surface: "voice" });
    sessionState.beginTurn(st, { turnId: "MS1", text: "what reminders do I have", quality: "clear" });
    await registry.execute("list_reminders", {},
      { userId: USER_A, session: st, sessionId: "s-ms", turnId: "MS1",
        inputQuality: { quality: "clear" } });
    await settle();
    const turns = await actions.ledger(USER_A, { sessionId: "s-ms" });
    const step = turns[0] && turns[0].steps[0];
    assert.ok(step, "no row");
    assert.ok(typeof step.ms === "number", "latency is not retained per step");
    sessionState.end(USER_A, "s-ms");
  });

  await atest("failures are findable across users, not one at a time", async () => {
    const before = await actions.failures({ sinceMs: Date.now() - 60_000, limit: 200 });
    assert.ok(Array.isArray(before.rows), "no failure listing");
    assert.ok(Array.isArray(before.groups), "no grouping by tool");
    // The refusal recorded above belongs in this window.
    assert.ok(before.rows.some((r) => r.tool === "place_phone_call" && r.decision === "refused"),
      "a refusal did not show up in the cross-user failure view");
    const g = before.groups.find((x) => x.tool === "place_phone_call" && x.decision === "refused");
    assert.ok(g && g.n >= 1 && g.users >= 1, "the grouping does not count users");
  });

  await atest("a device action keeps what the phone was asked to do", async () => {
    // "device action: open_url" with the URL discarded cannot answer
    // "why did Google Search open?" — the question that started all this.
    const st = sessionState.begin(USER_A, "s-dev", { surface: "voice" });
    sessionState.beginTurn(st, { turnId: "DV1", text: "open instagram", quality: "clear" });
    await registry.execute("open_app", { app: "instagram", query: "nehashetty" },
      { userId: USER_A, session: st, sessionId: "s-dev", turnId: "DV1",
        inputQuality: { quality: "clear" } });
    await settle();
    const turns = await actions.ledger(USER_A, { sessionId: "s-dev" });
    const step = turns[0] && turns[0].steps[0];
    assert.ok(step, "no row");
    assert.match(step.result, /instagram/i,
      "the record does not say what the phone was actually asked to do");
    sessionState.end(USER_A, "s-dev");
  });

  test("a request is labelled with a kind that can be counted", () => {
    assert.strictEqual(actions.intentKindOf("place_phone_call"), "call");
    assert.strictEqual(actions.intentKindOf("open_app"), "open");
    assert.strictEqual(actions.intentKindOf("send_whatsapp_message"), "message");
    assert.strictEqual(actions.intentKindOf("web_search"), "lookup");
    assert.strictEqual(actions.intentKindOf("recall_memory"), "recall");
  });

  /* ================================================================ */
  /* 15. CAPABILITIES THAT DID NOT EXIST                              */
  /*     Reading a page, changing the calendar, real research.        */
  /* ================================================================ */
  console.log("\nnew capabilities");

  await atest("read_webpage returns the page's real text", async () => {
    const res = await registry.execute(
      "read_webpage",
      { url: "https://example.com" },
      { userId: USER_A, inputQuality: { quality: "clear" } }
    );
    assert.strictEqual(res.ok, true, res.error || "");
    assert.match(res.data.title, /Example/i);
    assert.match(res.data.text, /domain/i, "the body text was not extracted");
    assert.ok(!/<[a-z]/i.test(res.data.text), "markup leaked into the text");
  });

  await atest("read_webpage refuses a URL it cannot read, without inventing", async () => {
    const bad = await registry.execute(
      "read_webpage",
      { url: "not-a-url" },
      { userId: USER_A, inputQuality: { quality: "clear" } }
    );
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /http/i);
  });

  test("the calendar can be changed, not only read", () => {
    for (const name of ["list_calendar_events", "create_calendar_event",
                        "update_calendar_event", "delete_calendar_event"]) {
      assert.ok(registry.get(name), `${name} is not registered`);
    }
    // Cancelling the wrong meeting cannot be undone from here.
    assert.strictEqual(registry.get("delete_calendar_event").risk, "high",
      "deleting an event does not ask first");
    assert.strictEqual(typeof registry.get("delete_calendar_event").confirmSummary,
      "function", "the confirmation card has nothing to say");
  });

  await atest("the calendar says it is not connected rather than guessing", async () => {
    // USER_A has no Google link. The failure has to be legible, not a
    // silent empty list that reads as "your day is free".
    const res = await registry.execute(
      "list_calendar_events", {},
      { userId: USER_A, inputQuality: { quality: "clear" } }
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "google_not_linked");
    assert.match(res.data.hint, /do NOT invent/i);
  });

  await atest("deep_research starts a job and claims nothing yet", async () => {
    const tool = registry.get("deep_research");
    if (!tool || (tool.available && tool.available() === false)) {
      console.log("      (skipped — no search provider configured)");
      return;
    }
    const res = await registry.execute(
      "deep_research",
      { question: "compare the cost of running k3s versus managed kubernetes" },
      { userId: USER_A, inputQuality: { quality: "clear" } }
    );
    assert.strictEqual(res.ok, true, res.error || "");
    assert.strictEqual(res.data.status, "started");
    assert.strictEqual(res.speak, "", "it spoke findings it does not have");
    assert.match(res.note, /Do NOT state any findings/i);
  });

  test("research keeps a search answer that carries no URL", () => {
    // The configured provider is Gemini grounding, whose reply arrives as
    // {title:"Web answer", snippet:<the answer>, url:""} followed by
    // citation chunks. Requiring a URL threw away the most substantial
    // thing the search returned — and when grounding produced no chunks it
    // threw away everything and the job reported finding nothing.
    const src = fs.readFileSync(require.resolve("../src/infra/handlers.js"), "utf8");
    const i = src.indexOf("async function deepResearch");
    assert.ok(i > 0);
    const body = src.slice(i, src.indexOf("function install()", i));
    assert.ok(!/const url = it && \(it\.url \|\| it\.link\);\s*\n\s*if \(!url\) continue;/.test(body),
      "a URL-less search answer is still discarded");
    assert.match(body, /unattributed/,
      "there is no separate bucket for an answer that cannot be cited");
    // The instruction is a concatenated literal, so match a fragment that
    // cannot span the join.
    assert.match(body, /may NOT give them a citation/,
      "an uncitable summary could still be passed off as a numbered source");
  });

  test("deep_research runs out of the turn, on the job queue", () => {
    const jobs = require("../src/infra/jobs");
    require("../src/infra/handlers").install();
    const names = jobs.HANDLERS instanceof Map
      ? [...jobs.HANDLERS.keys()]
      : Object.keys(jobs.HANDLERS);
    assert.ok(names.includes("deep_research"),
      "nothing would ever run the research job");
  });

  console.log("\ntimers, repeats, honest limits");

  await atest("a timer counts down; an alarm rings at a time", async () => {
    const t = await registry.execute("set_timer", { minutes: 10, label: "pasta" },
      { userId: USER_A, inputQuality: { quality: "clear" } });
    assert.strictEqual(t.ok, true);
    assert.match(t.deviceAction.url, /action=android\.intent\.action\.SET_TIMER/);
    assert.match(t.deviceAction.url, /LENGTH=600\b/, "ten minutes is not 600 seconds");
    assert.match(t.speak, /10 minutes/);
    const bad = await registry.execute("set_timer", { minutes: 0 },
      { userId: USER_A, inputQuality: { quality: "clear" } });
    assert.strictEqual(bad.ok, false, "a zero-length timer was accepted");
  });

  await atest("closing an app offers the closest real thing, never a lie", async () => {
    // Android does not let one app close another. The old behaviour was
    // for the model to claim it had.
    const home = await registry.execute("phone_control", { action: "go_home" },
      { userId: USER_A, inputQuality: { quality: "clear" } });
    assert.strictEqual(home.ok, true);
    assert.match(home.deviceAction.url, /category=android\.intent\.category\.HOME/);
    assert.match(home.note, /does NOT close it/i);

    const info = await registry.execute("phone_control",
      { action: "app_info", app_package: "com.instagram.android" },
      { userId: USER_A, inputQuality: { quality: "clear" } });
    assert.match(info.deviceAction.url, /APPLICATION_DETAILS_SETTINGS/);
    assert.match(info.note, /app is NOT closed/i);

    const nopkg = await registry.execute("phone_control", { action: "app_info" },
      { userId: USER_A, inputQuality: { quality: "clear" } });
    assert.strictEqual(nopkg.ok, false, "it opened settings for nothing");
  });

  test("a monthly series keeps its day instead of drifting", () => {
    const rec = require("../src/reminders/recurrence");
    const tz = 330;
    let t = Date.parse("2026-01-31T09:00:00+05:30");
    const days = [];
    for (let i = 0; i < 4; i++) {
      t = rec.nextOccurrence(t, "monthly", { tzOffsetMin: tz, anchorDay: 31 });
      days.push(new Date(t + tz * 60_000).toISOString().slice(0, 10));
    }
    // Naive month addition turns the 31st into 3 March and never recovers.
    assert.deepStrictEqual(days,
      ["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
    assert.strictEqual(rec.nextOccurrence(t, "", {}), 0, "a one-off repeated");
  });

  await atest("a repeating reminder rolls forward and survives being ticked off", async () => {
    const reminders = require("../src/reminders/store");
    await db.run("DELETE FROM reminders WHERE user_id = $1", [USER_B]).catch(() => {});
    const past = Date.now() - 3 * 86_400_000;
    const row = await reminders.create(USER_B, "take the tablets", past, "gentle",
      { repeat: "daily", tzOffsetMin: 330 });
    assert.strictEqual(row.repeat, "daily");

    // Three days of missed occurrences must not become three overdue rows.
    const list = await reminders.list(USER_B, { tzOffsetMin: 330 });
    assert.strictEqual(list.length, 1, "missed occurrences piled up");
    assert.ok(Number(list[0].due_at) > Date.now(), "it stayed overdue");

    // Ticking off today's occurrence moves the series on; it does not end it.
    const before = Number(list[0].due_at);
    await reminders.setDone(USER_B, row.id, true, { tzOffsetMin: 330 });
    const after = await db.one("SELECT due_at, done FROM reminders WHERE id = $1", [row.id]);
    assert.strictEqual(Number(after.done), 0, "the series was closed by one occurrence");
    assert.ok(Number(after.due_at) > before, "it did not move on");
    await db.run("DELETE FROM reminders WHERE user_id = $1", [USER_B]).catch(() => {});
  });

  await atest("a repeating reminder with no time is refused, not silently one-off", async () => {
    const res = await registry.execute("create_reminder",
      { text: "water the plants", repeat: "weekly" },
      { userId: USER_A, tzOffsetMin: 330, inputQuality: { quality: "clear" } });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /needs a time/i);
  });

  /* ================================================================ */
  /* 16. L — A CAPABILITY IS CHECKED BEFORE IT IS OFFERED             */
  /*     Feasibility was discovered by failing: the assistant said it  */
  /*     was calling, and the denied permission surfaced afterwards.   */
  /* ================================================================ */
  console.log("\ndeclared feasibility");

  test("a tool whose permission is denied is not offered at all", () => {
    const all = registry.declarations({ userId: USER_A }).map((d) => d.name);
    const caps = {
      platform: "android", build: 26,
      granted: ["microphone", "camera"],
      denied: ["contacts", "phone", "sms", "location"],
    };
    const offered = registry.declarations({ userId: USER_A, deviceCaps: caps })
      .map((d) => d.name);
    assert.ok(all.includes("place_phone_call"), "precondition: normally offered");
    assert.ok(!offered.includes("place_phone_call"),
      "a call tool was offered to a phone that cannot call");
    assert.ok(!offered.includes("get_current_location"));
    // A permission that IS granted must not hide anything.
    assert.ok(offered.includes("analyze_camera"),
      "camera was granted and the tool went missing anyway");
  });

  test("a phone that reports nothing keeps every capability", () => {
    // An older build posts no permission map. Silently removing half the
    // assistant's abilities would be a worse bug than the one being fixed.
    const all = registry.declarations({ userId: USER_A }).length;
    const blind = registry.declarations({
      userId: USER_A,
      deviceCaps: { build: 26, granted: [], denied: [] },
    }).length;
    assert.strictEqual(blind, all, "an unreported device lost capabilities");
  });

  test("an app too old for a tool is told to update, not left to fail", () => {
    const caps = { platform: "android", build: 20, granted: ["camera"], denied: [] };
    const offered = registry.declarations({ userId: USER_A, deviceCaps: caps })
      .map((d) => d.name);
    assert.ok(!offered.includes("look_at_screenshot"),
      "a tool needing a newer build was offered to an old install");
    assert.match(registry.limitsBlock(caps), /too old/i);
  });

  test("the limits are stated in the prompt, not discovered by failing", () => {
    const block = registry.limitsBlock({
      platform: "android", build: 26, granted: [], denied: ["phone"],
    });
    assert.match(block, /PHONE permission is NOT granted/);
    assert.match(block, /do NOT attempt it and do NOT say it is done/);
    assert.strictEqual(registry.limitsBlock(null), "",
      "a phone that reported nothing got a limits lecture anyway");
  });

  /* ================================================================ */
  /* 17. THE 11 SEPTEMBER LIVE-MODE SESSION                           */
  /*     Build 26, all on the live surface: an alarm request opened    */
  /*     Brave, "laugh" opened YouTube, and the assistant then denied  */
  /*     opening it.                                                  */
  /* ================================================================ */
  console.log("\nlive session failures");

  await atest("an alarm is handed to the clock app, never to a browser", async () => {
    const res = await registry.execute("set_alarm", { hour: 5, minute: 50 },
      { userId: USER_A, inputQuality: { quality: "clear" } });
    assert.strictEqual(res.ok, true);
    const url = res.deviceAction.url;
    assert.match(url, /^intent:\/\/#Intent;/, "the alarm is not an intent URI");
    // The app used to synthesise https:// from this URI's empty host and
    // hand THAT to a browser. Asking for an alarm opened Brave, and the
    // tool had already said the alarm was set.
    const host = url.substring(9).split('#')[0];
    assert.strictEqual(host, "", "precondition: the URI has no host");
    const engine = fs.readFileSync(
      require.resolve("../../myassistant-flutter/lib/features/assistant/state/assistant_engine.dart"),
      "utf8");
    assert.match(engine, /MethodChannel\('hari\/intent'\)/,
      "the app still has no native way to launch an intent URI");
    assert.ok(!/'https:\/\/\$\{url\.substring\(9\)/.test(engine),
      "the app still synthesises an https URL out of an intent URI");
  });

  test("play_music is documented as music only, not as a way to perform", () => {
    const t = registry.get("play_music");
    assert.match(t.description, /laugh/i,
      "nothing warns the model off using play_music to laugh");
    assert.match(t.description, /OPENS YOUTUBE/,
      "the description does not say it takes over the screen");
  });

  test("the record names the app that opened, so it cannot be denied", () => {
    // "No, I didn't open YouTube. I played a laughing sound for you."
    // Both halves were true of the TOOL; the second was false of the PHONE.
    const line = actions.describe({
      tool: "play_music", target: "laughing sound", ok: 1,
      created_at: Date.now(),
      result: "device action: open_url → https://www.youtube.com/watch?v=abc",
    });
    assert.match(line, /youtube/i,
      "the record still does not say YouTube opened");
    // An intent handed to the clock must not read as "opened SET_ALARM".
    const alarm = actions.describe({
      tool: "set_alarm", target: "", ok: 1, created_at: Date.now(),
      result: "device action: open_url → intent://#Intent;action=android.intent.action.SET_ALARM;end",
    });
    assert.ok(!/SET_ALARM/.test(alarm), "the alarm line reads as gibberish");
    assert.match(alarm, /phone's own app/);
  });

  test("live mode refuses to answer a garbled transcript", () => {
    // "o a", "clove" and "Love illah" all came back as confident answers,
    // because the tool gate only fires when the model reaches for a tool
    // and these reached for nothing.
    const proxy = fs.readFileSync(require.resolve("../src/live/proxy.js"), "utf8");
    assert.match(proxy, /turnQuality\.quality === "garbled"/,
      "live mode still generates from a garbled transcript");
    assert.match(proxy, /clarificationFor/,
      "live mode has no clarification path");
    for (const fragment of ["o a", "clove"]) {
      assert.notStrictEqual(inputQuality.assess(fragment).quality, "clear",
        `"${fragment}" was judged clear`);
    }
  });

  await atest("a text is not promised when SMS permission is off", async () => {
    // "Alan isn't on the app, so I'm sending it to them as a text message
    // instead" — and the next turn admitted the permission was never given.
    //
    // The SMS rung is only reached once the contact resolves and turns out
    // NOT to be an app user, so the test has to get that far: checking the
    // permission earlier would wrongly refuse a message to someone who IS
    // on the app, where SMS is irrelevant.
    await require("../src/routes/contacts").migrate();
    await db.run(
      `INSERT INTO contacts (user_id, name, phone, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, phone) DO UPDATE SET name = $2`,
      [USER_A, "Alan Test", "+919000000099", Date.now()]
    );
    const res = await registry.execute(
      "send_agent_message",
      { contact_name: "Alan Test", message: "I will be late today" },
      {
        userId: USER_A, appBuild: 26, inputQuality: { quality: "clear" },
        deviceCaps: { build: 26, granted: [], denied: ["sms"] },
      }
    );
    assert.strictEqual(res.ok, false, "it still promised a text it cannot send");
    assert.strictEqual(res.error, "sms_permission_denied");
    assert.match(res.data.hint, /must not say it was/i);
  });

  /* ================================================================ */
  /* 18. ONE STORY ABOUT A SEND, AND MEDIA YOU CAN ACTUALLY SEE       */
  /* ================================================================ */
  console.log("\nmessages and media");

  test("a delivered agent message leaves an outcome row to read", () => {
    // The tester got three contradictory answers about one message in four
    // turns, because check_recent_actions saw the tool run and
    // check_task_outcomes saw nothing: the successful rung wrote no outcome.
    const src = fs.readFileSync(require.resolve("../src/tools/builtins.js"), "utf8");
    const i = src.indexOf('name: "send_agent_message"');
    assert.ok(i > 0);
    const body = src.slice(i, src.indexOf('name: "send_document"', i));
    assert.match(body, /outcomes\/store[\s\S]{0,200}kind: "message"/,
      "the app-user delivery path still records no outcome");
  });

  test("a message outcome reads as a sentence, not a status code", () => {
    const outcomes = require("../src/outcomes/store");
    const line = outcomes.describe({
      kind: "message", target: "Allen Lobo", status: "completed",
      detail: "through their assistant, with a notification",
    });
    assert.strictEqual(line,
      "the message to Allen Lobo was delivered through their assistant, with a notification");
    assert.match(
      outcomes.describe({ kind: "message", target: "Alan", status: "failed",
        reason: "SMS permission not granted" }),
      /FAILED — SMS permission/);
  });

  test("the two record tools are told how to disagree without reversing", () => {
    const t = registry.get("check_task_outcomes");
    assert.match(t.description, /IF THERE IS NO ROW/,
      "nothing stops it concluding a send worked from an absent row");
    assert.match(t.description, /say both plainly/);
    assert.ok(t.inputSchema.properties.kind.enum.includes("message"),
      "messages cannot be asked about by kind");
  });

  test("an image can be asked for in the shape it is for", () => {
    const g = registry.get("generate_image");
    assert.deepStrictEqual(g.inputSchema.properties.aspect.enum,
      ["square", "portrait", "landscape", "wide"]);
    // Everything used to come back 1024 square, so a poster was cropped.
    const imagegen = fs.readFileSync(
      require.resolve("../src/services/imagegen.js"), "utf8");
    assert.ok(!/width=1024&height=1024/.test(imagegen),
      "images are still hard-coded to 1024 square");
    assert.match(imagegen, /enhance=true/,
      "the provider's prompt enhancer is still off");
    assert.match(imagegen, /buffer\.length < 20 \* 1024/,
      "a truncated image still counts as a success");
  });

  await atest("a celebrity profile opens the profile, not a search", async () => {
    // "open Neha Shetty's Instagram" opened image results, because a name
    // with a space never looked like a handle and Instagram has no
    // external search deep link at all.
    const ctx = { userId: USER_A, inputQuality: { quality: "clear" } };
    const byHandle = await registry.execute("open_app",
      { app: "instagram", handle: "nehashetty" }, ctx);
    assert.strictEqual(byHandle.data.mode, "profile");
    assert.strictEqual(byHandle.data.url, "https://www.instagram.com/nehashetty/");
    assert.match(byHandle.speak, /profile/i);

    // A bare one-word query IS a handle — that shape must still work.
    const bare = await registry.execute("open_app",
      { app: "instagram", query: "nehashetty" }, ctx);
    assert.strictEqual(bare.data.mode, "profile");

    // Other platforms get real profile URLs too, not just Instagram.
    const x = await registry.execute("open_app", { app: "x", handle: "imVkohli" }, ctx);
    assert.strictEqual(x.data.url, "https://x.com/imVkohli");
    const yt = await registry.execute("open_app", { app: "youtube", handle: "MrBeast" }, ctx);
    assert.strictEqual(yt.data.url, "https://www.youtube.com/@MrBeast");

    // A NAME with no handle still falls back to search — but says so, and
    // tells the model how to do better rather than silently pretending.
    const byName = await registry.execute("open_app",
      { app: "instagram", query: "Neha Shetty" }, ctx);
    assert.strictEqual(byName.data.mode, "search");
    assert.match(byName.note, /call this again with handle set/i);
    assert.match(byName.speak, /can't be searched/i);
  });

  test("the image provider chain is inert without keys, and ordered", () => {
    const imagegen = require("../src/services/imagegen");
    const now = imagegen.configuredProviders();
    assert.ok(now[now.length - 1].startsWith("pollinations"),
      "the keyless provider is not the last resort");
    // Adding a free key must be one environment variable and nothing else.
    const src = fs.readFileSync(require.resolve("../src/services/imagegen.js"), "utf8");
    for (const fn of ["tryCloudflare", "tryHuggingFace", "tryTogether"]) {
      assert.match(src, new RegExp(`async function ${fn}\\(`), `${fn} is missing`);
    }
    assert.match(src,
      /for \(const provider of \[tryGemini, tryCloudflare, tryHuggingFace, tryTogether\]\)/,
      "the chain does not try the keyed providers in order");
  });

  test("the image size reported is the one that came back", () => {
    // The free tier downscales: 1536x864 returns 1024x576. Reporting the
    // REQUESTED size made the ledger claim a resolution nobody received.
    const { jpegSize } = require("../src/services/imagegen");
    const src = fs.readFileSync(require.resolve("../src/services/imagegen.js"), "utf8");
    assert.match(src, /width: real \? real\.width : width/,
      "the requested width is still reported as the result");
    assert.strictEqual(jpegSize(Buffer.from([0, 1, 2])), null,
      "a non-JPEG should measure as null, not throw");
    assert.strictEqual(jpegSize(null), null);
  });

  test("video generation exists rather than being declined", () => {
    const v = registry.get("generate_video");
    assert.ok(v, "generate_video is not registered");
    assert.ok(!/not enabled on the current plan/i.test(v.description),
      "the tool still only explains why it cannot work");
    assert.ok(v.inputSchema.properties.aspect, "no aspect for a Reel or a post");
    // The two kinds must stay distinguishable: calling a crossfaded
    // sequence of stills "synthesised video" is the same class of lie as
    // claiming an alarm was set.
    assert.match(v.description, /keyframes/,
      "the model is not told the result says which kind it got");
    const videogen = fs.readFileSync(
      require.resolve("../src/services/videogen.js"), "utf8");
    assert.match(videogen, /tryVeoVideo/, "Veo is not tried first");
    assert.match(videogen, /haveFfmpeg/, "nothing checks the encoder exists");
  });

  await atest("a video is started as a job and nothing is described yet", async () => {
    // Measured in production: three keyframes plus the encode is about a
    // hundred seconds. A voice turn cannot be held open that long, so the
    // turn starts it and a push says when it lands.
    const res = await registry.execute("generate_video",
      { prompt: "waves at sunset over Panambur beach", aspect: "wide" },
      { userId: USER_A, inputQuality: { quality: "clear" } });
    assert.strictEqual(res.ok, true, res.error || "");
    assert.strictEqual(res.data.status, "started");
    assert.ok(!res.deviceAction, "it announced a video that does not exist yet");
    assert.strictEqual(res.speak, "", "it spoke about a video it has not seen");
    assert.match(res.note, /Do NOT describe the video/i);
  });

  test("the video job is registered, so something will actually run it", () => {
    const jobs = require("../src/infra/jobs");
    require("../src/infra/handlers").install();
    const names = jobs.HANDLERS instanceof Map
      ? [...jobs.HANDLERS.keys()] : Object.keys(jobs.HANDLERS);
    assert.ok(names.includes("generate_video"),
      "a video request would be enqueued and never picked up");
  });

  test("a finished image is not described to the model as pending", () => {
    // The ledger showed generate_image ok=1 in 4.4s with the file saved,
    // while the assistant said "it'll pop up when it's ready" and then, a
    // turn later, that generation had failed. The live path was
    // summarising every device action with no `data` as "Device action
    // REQUESTED: show_image" and throwing away the tool's own words.
    const proxy = fs.readFileSync(require.resolve("../src/live/proxy.js"), "utf8");
    assert.ok(!/result: "Device action requested: " \+ res\.deviceAction\.type/.test(proxy),
      "the live path still tells the model the action was merely requested");
    assert.match(proxy, /result:\s*\n?\s*res\.speak \|\|/,
      "the tool's own speak is still discarded");

    const src = fs.readFileSync(require.resolve("../src/tools/builtins.js"), "utf8");
    const i = src.indexOf('name: "generate_image"');
    const body = src.slice(i, src.indexOf('name: "generate_video"', i));
    assert.match(body, /generated: true/,
      "generate_image still returns no data, so it reads as a bare device action");
    // The instruction is a concatenated literal — match a fragment that
    // cannot span the join.
    assert.match(body, /The image EXISTS and is saved/,
      "nothing tells the model the image exists");
  });

  test("one result is presented once, not twice", () => {
    // A recalled document opened the full-screen gallery AND pushed the
    // conversation view over Home behind it.
    const engine = fs.readFileSync(
      require.resolve("../../myassistant-flutter/lib/features/assistant/state/assistant_engine.dart"),
      "utf8");
    assert.match(engine, /_shownFullScreen = onShowDocuments/,
      "the gallery result is not remembered");
    assert.match(engine, /!_shownFullScreen &&/,
      "something already on screen can still force a second presentation");
    assert.match(engine, /_resetTurn\(\) \{\s*\n\s*_shownFullScreen = false;/,
      "the flag is never cleared, so later turns would stop escalating");
    // A generated image goes straight to full screen, with no prompt caption.
    const imgCase = engine.slice(
      engine.indexOf("case 'show_image':"),
      engine.indexOf("case 'translator':"));
    assert.match(imgCase, /onShowDocuments\?\.call\(\[doc\]\)/,
      "a generated image does not open full screen");
    assert.ok(!/generatedImagePrompt = e\['prompt'\] as String\? \?\? '';\s*\n\s*\}\s*\n\s*break;/.test(imgCase),
      "the prompt caption is still the default presentation");
  });

  test("something to look at gets a screen to appear on", () => {
    // "Your image is on the screen" while the user was on Home with the
    // orb, where no card is rendered.
    const engine = fs.readFileSync(
      require.resolve("../../myassistant-flutter/lib/features/assistant/state/assistant_engine.dart"),
      "utf8");
    assert.match(engine, /bool get hasVisualResult/,
      "the app cannot tell whether a turn produced anything visible");
    // A spoken web answer must NOT throw a screen over Home — only the
    // things the assistant says are "on your screen" do.
    const g = /bool get hasVisualResult =>([\s\S]{0,240}?);/.exec(engine);
    assert.ok(g, "could not read the getter");
    assert.ok(!/searchResults/.test(g[1]),
      "a spoken search answer still forces the conversation screen open");
    const shell = fs.readFileSync(
      require.resolve("../../myassistant-flutter/lib/shell/home_shell.dart"), "utf8");
    assert.match(shell, /engine\.hasVisualResult/,
      "Home still only escalates for a tappable confirmation");
    assert.match(shell, /engine\.inlineVoice \|\| engine\.liveActive/,
      "live mode — where every complaint came from — is still excluded");
    const cards = fs.readFileSync(
      require.resolve("../../myassistant-flutter/lib/features/assistant/widgets/action_cards.dart"),
      "utf8");
    assert.match(cards, /VideoPlayer\(_video!\)/,
      "a generated video still renders as a static icon");
  });

  /* ---------------------------------------------------------------- */
  console.log("");
  for (const uid of [USER_A, USER_B]) {
    await db.run("DELETE FROM executed_actions WHERE user_id = $1", [uid]).catch(() => {});
    await db.run("DELETE FROM conversation_turns WHERE user_id = $1", [uid]).catch(() => {});
    await db.run("DELETE FROM task_outcomes WHERE user_id = $1", [uid]).catch(() => {});
    await db.run("DELETE FROM reminders WHERE user_id = $1", [uid]).catch(() => {});
    await db.run("DELETE FROM contacts WHERE user_id = $1", [uid]).catch(() => {});
  }
  console.log(`${passed} checks passed`);
  process.exit(process.exitCode || 0);
})();
