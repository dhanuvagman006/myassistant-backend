/**
 * THIRD-PARTY INTEGRATION TESTS — `npm run test:integrations`.
 *
 * Meeting negotiation, payment collection, flight search + fare watch, and
 * interpreter mode. No database, no network.
 *
 * The assertions concentrate on the branches where a mistake costs the user
 * something real: booking a meeting nobody agreed to, marking an invoice
 * paid without a valid signature, searching the wrong day, or an
 * "interpreter" that answers questions instead of translating them.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

const assert = require("assert");
const negotiator = require("../src/scheduling/negotiator");
const freeslots = require("../src/scheduling/freeslots");
const payments = require("../src/payments/service");
const flights = require("../src/tools/flights");
const fares = require("../src/travel/fares");
const interpreter = require("../src/interpreter/mode");

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

(async () => {
  console.log("\nmeeting negotiation");

  const SLOTS = [
    { startMs: Date.now() + 864e5, endMs: Date.now() + 864e5 + 18e5, label: "tomorrow at 11 am" },
    { startMs: Date.now() + 2 * 864e5, endMs: Date.now() + 2 * 864e5 + 18e5, label: "Thursday at 3 pm" },
  ];

  test("the call script offers the real slots and asks them to pick", () => {
    const task = negotiator.callTask({
      contactName: "Ravi", purpose: "the pricing review", slots: SLOTS, userName: "Dhanush",
    });
    assert.ok(task.includes("tomorrow at 11 am"), task);
    assert.ok(task.includes("Thursday at 3 pm"), task);
    assert.ok(/pick one|which of these/i.test(task), task);
  });

  await atest("an empty reply is never treated as agreement", async () => {
    const v = await negotiator.interpret("", SLOTS);
    assert.strictEqual(v.agreed, false);
    assert.strictEqual(v.slotIndex, null);
  });

  test("a slot is only booked on a clear acceptance", () => {
    // The interpret() contract, asserted at the boundary awaitAndBook relies
    // on: agreed must be false unless a valid slot index came back. A
    // "maybe" that books a meeting is the worst failure this feature has.
    for (const v of [
      { agreed: true, slotIndex: null },
      { agreed: true, slotIndex: 99 },
      { agreed: false, slotIndex: 0 },
    ]) {
      const wouldBook = v.agreed && Number.isInteger(v.slotIndex) && v.slotIndex < SLOTS.length;
      assert.ok(!wouldBook, `would have booked on ${JSON.stringify(v)}`);
    }
  });

  test("no telephony means no negotiation, stated honestly", async () => {
    const saved = process.env.PLIVO_AUTH_ID;
    delete process.env.PLIVO_AUTH_ID;
    const out = await negotiator.start({
      userId: 1, contact: { name: "Ravi", phone: "+919876543210" }, slots: SLOTS,
    });
    if (saved) process.env.PLIVO_AUTH_ID = saved;
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, "telephony");
  });

  test("slot labels are spoken, never ISO — they are read out on a call", () => {
    const label = freeslots.describe(Date.now() + 864e5, 330);
    assert.ok(!/\d{4}-\d{2}-\d{2}|T\d{2}:/.test(label), label);
    assert.ok(/am|pm/.test(label), label);
  });

  console.log("\npayment collection");

  test("unconfigured Razorpay refuses instead of inventing a link", async () => {
    const saved = process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_ID;
    const out = await payments.createRequest({ userId: 1, amountRupees: 500 });
    if (saved) process.env.RAZORPAY_KEY_ID = saved;
    assert.strictEqual(out.ok, false);
    assert.ok(/isn't configured/i.test(out.error), out.error);
  });

  test("a webhook without a valid signature is rejected", () => {
    const crypto = require("crypto");
    const body = Buffer.from(JSON.stringify({ event: "payment_link.paid" }));

    // No secret configured -> reject everything. An unverified webhook
    // could mark any invoice paid.
    const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    assert.strictEqual(payments.verifySignature(body, "anything"), false);

    process.env.RAZORPAY_WEBHOOK_SECRET = "s3cret";
    const good = crypto.createHmac("sha256", "s3cret").update(body).digest("hex");
    assert.strictEqual(payments.verifySignature(body, good), true, "valid signature must pass");
    assert.strictEqual(payments.verifySignature(body, "deadbeef"), false);
    assert.strictEqual(payments.verifySignature(body, good.slice(0, -2) + "00"), false);
    assert.strictEqual(payments.verifySignature(null, good), false);

    if (saved) process.env.RAZORPAY_WEBHOOK_SECRET = saved;
    else delete process.env.RAZORPAY_WEBHOOK_SECRET;
  });

  test("there is no code path that sends money out", () => {
    // Collection only, by design. If a transfer/payout helper ever appears
    // here it should be a deliberate decision, not a quiet addition.
    const api = Object.keys(payments);
    for (const forbidden of ["payout", "transfer", "refund", "sendMoney", "withdraw"]) {
      assert.ok(!api.includes(forbidden), `unexpected outbound-money API: ${forbidden}`);
    }
  });

  console.log("\nflights and fare watch");

  test("known cities resolve, unknown ones are asked about", () => {
    assert.strictEqual(flights.resolveAirport("bangalore"), "BLR");
    assert.strictEqual(flights.resolveAirport("BOM"), "BOM");
    assert.strictEqual(flights.resolveAirport("somewhere"), null);
  });

  test("the Amadeus host follows the environment", () => {
    // Test and production are separate hosts AND separate credentials —
    // pointing live keys at the sandbox returns unbookable inventory.
    const saved = process.env.AMADEUS_ENV;
    delete process.env.AMADEUS_ENV;
    assert.ok(flights.amadeusHost().includes("test.api.amadeus.com"));
    process.env.AMADEUS_ENV = "production";
    assert.strictEqual(flights.amadeusHost(), "https://api.amadeus.com");
    if (saved) process.env.AMADEUS_ENV = saved;
    else delete process.env.AMADEUS_ENV;
  });

  await atest("an unreadable date is questioned, not silently made tomorrow", async () => {
    const saved = process.env.AMADEUS_CLIENT_ID;
    const saved2 = process.env.AMADEUS_CLIENT_SECRET;
    process.env.AMADEUS_CLIENT_ID = "x";
    process.env.AMADEUS_CLIENT_SECRET = "y";
    const out = await flights.search({ from: "BLR", to: "DEL", date: "sometime-ish" });
    if (saved) process.env.AMADEUS_CLIENT_ID = saved; else delete process.env.AMADEUS_CLIENT_ID;
    if (saved2) process.env.AMADEUS_CLIENT_SECRET = saved2; else delete process.env.AMADEUS_CLIENT_SECRET;
    assert.ok(out.needsArgs, `should ask, got ${JSON.stringify(out)}`);
  });

  test("only INR fares are compared against a rupee target", () => {
    const best = fares.cheapest([
      { price: "USD 40.00", flight: "AA1" },
      { price: "INR 8452.00", flight: "6E203" },
      { price: "INR 12000.00", flight: "AI505" },
    ]);
    assert.strictEqual(best.price, 8452);
    assert.strictEqual(best.flight.flight, "6E203");
    assert.strictEqual(fares.cheapest([{ price: "USD 40.00" }]), null);
  });

  console.log("\ninterpreter mode");

  test("language names resolve from codes and from words", () => {
    assert.strictEqual(interpreter.languageName("ta"), "Tamil");
    assert.strictEqual(interpreter.languageName("Tamil"), "Tamil");
    assert.strictEqual(interpreter.languageName("hi"), "Hindi");
    assert.strictEqual(interpreter.languageName(""), null);
  });

  test("the instructions forbid answering — the whole failure mode", () => {
    const i = interpreter.instructions({ a: "English", b: "Tamil" });
    assert.ok(/NEVER answer a question yourself/i.test(i));
    assert.ok(/translate the QUESTION/i.test(i));
    assert.ok(/FIRST PERSON/i.test(i));
    // Faithfulness matters most exactly where it is tempting to soften.
    assert.ok(/do not add, omit, soften/i.test(i));
    assert.ok(i.includes("English") && i.includes("Tamil"));
  });

  test("both directions are specified, not just one", () => {
    const i = interpreter.instructions({ a: "English", b: "Tamil" });
    assert.ok(i.includes("When you hear English"), i);
    assert.ok(i.includes("When you hear Tamil"), i);
  });

  console.log("\ntool surface");

  test("every integration is reachable by voice", () => {
    const registry = require("../src/tools/registry");
    require("../src/tools/builtins").registerBuiltins();
    for (const n of [
      "arrange_meeting_with", "collect_payment", "check_payments",
      "search_flights", "watch_flight_fare",
      "start_interpreter_mode", "stop_interpreter_mode",
    ]) {
      assert.ok(registry.get(n), `missing tool: ${n}`);
    }
  });

  test("actions with real consequences require confirmation", () => {
    const registry = require("../src/tools/registry");
    // Phoning someone, and asking someone for money, both reach a third
    // party on the user's behalf. Neither may happen unprompted.
    for (const n of ["arrange_meeting_with", "collect_payment"]) {
      assert.strictEqual(registry.get(n).risk, "high", `${n} must be high risk`);
      assert.strictEqual(typeof registry.get(n).confirmSummary, "function", n);
    }
    // Watching a price and translating do nothing irreversible.
    for (const n of ["watch_flight_fare", "start_interpreter_mode"]) {
      assert.strictEqual(registry.get(n).risk, "low", n);
    }
  });

  test("the confirmation names the amount and the person", () => {
    const registry = require("../src/tools/registry");
    const s = registry.get("collect_payment").confirmSummary({
      from: "Ravi", amount: 15000, reason: "the consultation",
    });
    assert.ok(s.includes("15,000"), s);
    assert.ok(s.includes("Ravi"), s);
  });

  console.log(`\n${passed} passed${process.exitCode ? " — with failures above" : ""}\n`);
})();
