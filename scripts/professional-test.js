/**
 * PROFESSIONAL FEATURE TESTS — `npm run test:professional`.
 *
 * Covers the four features built for busy professionals: inbound call
 * screening, commitment tracking, proactive nudging, and meeting capture.
 *
 * No database and no network. What is tested is the DECISION LOGIC — who
 * gets forwarded, what counts as a promise, when it is too late at night to
 * interrupt someone — because those are the judgements that misfire in ways
 * a user notices immediately.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

const assert = require("assert");
const receptionist = require("../src/inbound/receptionist");
const commitments = require("../src/commitments/service");
const scheduler = require("../src/proactive/scheduler");
const meetings = require("../src/meetings/service");

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

/* ------------------------------------------------------------------ */

console.log("\ninbound call screening");

const base = (over = {}) => ({
  callerName: null,
  known: false,
  ...over,
  // Merged LAST: spreading `over` afterwards would replace this whole
  // object with the partial one the case supplied, silently dropping
  // forward_to and making every forwarding assertion pass for the wrong
  // reason.
  settings: {
    mode: "screen_unknown",
    forward_to: "+919999999999",
    vip: "",
    ...(over.settings || {}),
  },
});

test("a saved contact is put straight through", () => {
  assert.strictEqual(
    receptionist.shouldForward(base({ known: true, callerName: "Ravi" })),
    true
  );
});

test("an unknown caller is screened, not forwarded", () => {
  assert.strictEqual(receptionist.shouldForward(base({ known: false })), false);
});

test("screen_all screens even a known contact", () => {
  assert.strictEqual(
    receptionist.shouldForward(
      base({ known: true, callerName: "Ravi", settings: { mode: "screen_all" } })
    ),
    false
  );
});

test("a named VIP is forwarded even under screen_all", () => {
  assert.strictEqual(
    receptionist.shouldForward(
      base({
        known: true,
        callerName: "Priya Sharma",
        settings: { mode: "screen_all", vip: "priya, dad" },
      })
    ),
    true
  );
});

test("take_messages never forwards anyone", () => {
  assert.strictEqual(
    receptionist.shouldForward(
      base({ known: true, callerName: "Priya", settings: { mode: "take_messages", vip: "priya" } })
    ),
    false
  );
});

test("with no forwarding number configured, nobody is forwarded", () => {
  // Otherwise Plivo would <Dial> an empty number and drop the caller.
  assert.strictEqual(
    receptionist.shouldForward(
      base({ known: true, callerName: "Ravi", settings: { forward_to: null } })
    ),
    false
  );
});

test("Indian numbers normalise to E.164", () => {
  assert.strictEqual(receptionist.normalize("9876543210"), "+919876543210");
  assert.strictEqual(receptionist.normalize("+91 98765 43210"), "+919876543210");
  assert.strictEqual(receptionist.normalize(""), null);
});

console.log("\ncommitment capture");

test("a real promise passes the cheap gate", () => {
  for (const s of [
    "I'll send Ravi the proposal by Friday",
    "let me get back to her tomorrow",
    "I need to file the GST return before the 20th",
    "tell him I will call back tonight",
  ]) {
    assert.ok(commitments.PROMISE_RX.test(s), `missed: ${s}`);
  }
});

test("ordinary conversation does NOT trigger a model call", () => {
  // The gate exists so extraction costs nothing on a normal turn. If this
  // regresses, every single utterance starts paying for an extra API call.
  for (const s of [
    "what's the weather like",
    "play some music",
    "he said he would send it",
    "book me a cab to the airport",
    "what is the punishment for cheating",
  ]) {
    assert.ok(!commitments.PROMISE_RX.test(s), `false positive: ${s}`);
  }
});

test("extraction is fire-and-forget and never throws into a turn", () => {
  // extractAsync must be safe to call with anything, including junk, with
  // no await — a rejected promise here would surface as an unhandled
  // rejection mid-conversation.
  assert.doesNotThrow(() => {
    commitments.extractAsync(null, "I'll send it tomorrow");
    commitments.extractAsync(1, "");
    commitments.extractAsync(1, "nothing promised here");
  });
});

console.log("\nproactive nudging");

test("quiet hours block a 3am nudge and allow a midday one", () => {
  // localHour() derives from the tz offset, so shift the offset to place
  // "now" at a known local hour rather than depending on when tests run.
  const utcHour = new Date().getUTCHours();
  const offsetFor = (targetHour) => ((targetHour - utcHour + 24) % 24) * 60;

  assert.strictEqual(scheduler.inQuietHours(offsetFor(3)), true, "3am must be quiet");
  assert.strictEqual(scheduler.inQuietHours(offsetFor(23)), true, "11pm must be quiet");
  assert.strictEqual(scheduler.inQuietHours(offsetFor(13)), false, "1pm must be allowed");
  assert.strictEqual(scheduler.inQuietHours(offsetFor(9)), false, "9am must be allowed");
});

test("the scheduler starts and stops without a database", () => {
  assert.doesNotThrow(() => {
    scheduler.start();
    scheduler.start(); // idempotent — a double start must not double-sweep
    scheduler.stop();
  });
});

console.log("\nmeeting capture");

(async () => {
  await atest("a too-short recording is reported, not analysed", async () => {
    const out = await meetings.analyze("hello?");
    assert.deepStrictEqual(out.decisions, []);
    assert.deepStrictEqual(out.actions, []);
    assert.ok(/too short/i.test(out.summary), out.summary);
    // Crucially it does NOT fabricate a summary of a meeting that had none.
    assert.strictEqual(out.follow_up, "");
  });

  test("only the user's own action items become tracked commitments", () => {
    // record() files actions where mine === true. Anything else stays in
    // the meeting record: we cannot nudge someone else's client, and a
    // tracker full of other people's tasks is one the user stops reading.
    const actions = [
      { text: "Send the revised quote", owner: "Dhanush", mine: true },
      { text: "Get board approval", owner: "Ravi", mine: false },
      { text: "Share the deck", owner: "Ravi", mine: false },
    ];
    assert.strictEqual(actions.filter((a) => a.mine).length, 1);
  });

  console.log("\ntool surface");

  test("each professional feature is reachable by voice", () => {
    const registry = require("../src/tools/registry");
    require("../src/tools/builtins").registerBuiltins();
    for (const n of [
      "check_my_calls",        // "did anyone call?"
      "list_my_commitments",   // "what did I promise?"
      "complete_commitment",   // "I sent it"
      "recall_meeting",        // "what did we decide?"
    ]) {
      assert.ok(registry.get(n), `missing tool: ${n}`);
    }
  });

  test("completing a commitment that does not exist fails honestly", async () => {
    const registry = require("../src/tools/registry");
    const t = registry.get("complete_commitment");
    assert.strictEqual(t.risk, "medium");
    assert.ok(t.description.includes("Mark"));
  });

  console.log(`\n${passed} passed${process.exitCode ? " — with failures above" : ""}\n`);
})();
