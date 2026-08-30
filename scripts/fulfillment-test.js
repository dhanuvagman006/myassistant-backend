/**
 * FULFILLMENT TESTS — run with `npm run test:fulfillment`.
 *
 * No database and no network: these cover the link builders and, more
 * importantly, the HONESTY INVARIANTS. The bug this feature replaced was a
 * tool that claimed to have phoned a business and confirmed an appointment
 * without dialling anything, so the tests that matter most here are the
 * ones asserting we never say a thing is done when it isn't.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

const assert = require("assert");
const deeplinks = require("../src/fulfillment/deeplinks");
const youtube = require("../src/fulfillment/youtube");

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

console.log("\ndeep links");

test("android food link targets the Swiggy package with a browser fallback", () => {
  const l = deeplinks.food({ provider: "swiggy", dish: "biryani", platform: "android" });
  assert.ok(l.url.startsWith("intent://www.swiggy.com/search"));
  assert.ok(l.url.includes("package=in.swiggy.android"));
  assert.ok(l.url.includes("S.browser_fallback_url=https%3A%2F%2Fwww.swiggy.com"));
  assert.strictEqual(l.precision, "search");
});

test("non-android gets the plain https link, no intent wrapper", () => {
  const l = deeplinks.food({ provider: "zomato", dish: "pizza", platform: "ios" });
  assert.ok(l.url.startsWith("https://www.zomato.com/search"));
  assert.ok(!l.url.includes("intent://"));
});

test("a named restaurant beats the dish in the search query", () => {
  const l = deeplinks.food({ dish: "pizza", restaurant: "Domino's" });
  assert.ok(l.url.includes(encodeURIComponent("Domino's")));
  assert.ok(!l.url.includes("pizza"));
});

test("ride with coordinates is 'target' precision and carries both points", () => {
  const l = deeplinks.ride({
    provider: "uber", destination: "Airport",
    lat: 13.1986, lng: 77.7066, pickupLat: 12.97, pickupLng: 77.59,
  });
  assert.strictEqual(l.precision, "target");
  assert.ok(l.url.includes("dropoff[latitude]=13.1986"));
  assert.ok(l.url.includes("pickup[latitude]=12.97"));
});

test("ride without coordinates degrades to 'search', not a false 'target'", () => {
  const l = deeplinks.ride({ provider: "uber", destination: "Airport" });
  assert.strictEqual(l.precision, "search");
  assert.ok(l.url.includes("pickup=my_location"));
});

test("movie title search, and city listings when no title", () => {
  assert.ok(deeplinks.movie({ title: "Kantara" }).url.includes("explore/search?q=Kantara"));
  assert.ok(deeplinks.movie({ city: "Bengaluru" }).url.includes("movies-bengaluru"));
  assert.strictEqual(deeplinks.movie({}).precision, "app");
});

test("unknown shop provider returns null rather than a broken link", () => {
  assert.strictEqual(deeplinks.shop({ provider: "nosuchapp", query: "x" }), null);
});

console.log("\nhonesty invariants");

test("every handoff sentence tells the user THEY finish the payment", () => {
  const search = deeplinks.speakFor({ precision: "search", providerLabel: "Swiggy", what: "biryani" });
  assert.ok(/payment to you|pick the one/i.test(search), search);
  const app = deeplinks.speakFor({ precision: "app", providerLabel: "Swiggy" });
  assert.ok(/search from there/i.test(app), app);
});

test("no handoff sentence ever claims the order was placed", () => {
  for (const precision of ["target", "search", "app"]) {
    const s = deeplinks.speakFor({ precision, providerLabel: "Swiggy", what: "biryani" });
    assert.ok(
      !/\b(ordered|booked|purchased|confirmed your|placed your)\b/i.test(s),
      `claimed completion at precision=${precision}: ${s}`
    );
  }
});

test("the mocked book_appointment_via_call tool is gone", () => {
  const registry = require("../src/tools/registry");
  require("../src/tools/builtins").registerBuiltins();
  assert.strictEqual(registry.get("book_appointment_via_call"), null,
    "the tool that faked phone calls must not be registered");
  assert.ok(registry.get("book_by_calling_business"), "its real replacement must exist");
});

test("booking by phone is high risk, so it cannot run without approval", () => {
  const registry = require("../src/tools/registry");
  const t = registry.get("book_by_calling_business");
  assert.strictEqual(t.risk, "high");
  assert.ok(typeof t.confirmSummary === "function");
  const summary = t.confirmSummary({ business_name: "Dr Rao", kind: "appointment", when: "Friday 4pm", purpose: "a check-up" });
  assert.ok(summary.includes("Dr Rao") && summary.includes("Friday"), summary);
});

test("booking by phone refuses honestly when telephony is unconfigured", async () => {
  const registry = require("../src/tools/registry");
  const saved = process.env.PLIVO_AUTH_ID;
  delete process.env.PLIVO_AUTH_ID;
  const res = await registry.execute(
    "book_by_calling_business",
    { business_name: "Some Clinic", kind: "appointment" },
    { userId: 1, approved: true }
  );
  if (saved) process.env.PLIVO_AUTH_ID = saved;
  assert.strictEqual(res.ok, false, "must not report success without telephony");
  assert.ok(/not configured|isn't configured/i.test(res.error), res.error);
});

console.log("\ncalling a business Hari looked up");

test("a result must actually match the name before we dial it", () => {
  const { nameMatches } = require("../src/fulfillment/service");
  assert.ok(nameMatches("Apollo Clinic", "Apollo Clinic Indiranagar"));
  assert.ok(nameMatches("Dr Rao", "Dr Rao Dental Care"));
  // The failure that matters: never ring a different business because it
  // happened to be the nearest one with a listed number.
  assert.ok(!nameMatches("Apollo Clinic", "Manipal Hospital"));
  assert.ok(!nameMatches("Toothsome Dental", "Bright Smile Dental"));
  // Nothing distinctive to verify → no match, so Hari asks instead.
  assert.ok(!nameMatches("the clinic", "Some Clinic"));
});

test("the number is resolved BEFORE the confirmation, and pinned into args", async () => {
  const registry = require("../src/tools/registry");
  const service = require("../src/fulfillment/service");
  const agentCall = require("../src/agents/agentCall");

  const realResolve = service.resolveBusiness;
  const realEnabled = agentCall.enabled;
  service.resolveBusiness = async () => ({
    name: "Apollo Clinic Indiranagar",
    phone: "+918012345678",
    address: "100ft Road, Indiranagar",
  });
  agentCall.enabled = () => true;
  try {
    const res = await registry.execute(
      "book_by_calling_business",
      { business_name: "Apollo Clinic", kind: "appointment", when: "Friday 4pm" },
      { userId: 1, lat: 12.97, lng: 77.59 }
    );
    assert.strictEqual(res.needsConfirmation, true, "must ask before dialling");
    // The user has to be able to see WHO is about to be called.
    assert.ok(res.summary.includes("+918012345678"), res.summary);
    assert.ok(res.summary.includes("100ft Road"), res.summary);
    // Pinned, so the approved business and the called business are the same.
    assert.strictEqual(res.args.phone, "+918012345678");
    assert.strictEqual(res.args.business_name, "Apollo Clinic Indiranagar");
  } finally {
    service.resolveBusiness = realResolve;
    agentCall.enabled = realEnabled;
  }
});

test("no listed number means no confirmation card, just the truth", async () => {
  const registry = require("../src/tools/registry");
  const service = require("../src/fulfillment/service");
  const agentCall = require("../src/agents/agentCall");

  const realResolve = service.resolveBusiness;
  const realEnabled = agentCall.enabled;
  service.resolveBusiness = async () => null;
  agentCall.enabled = () => true;
  try {
    const res = await registry.execute(
      "book_by_calling_business",
      { business_name: "Nowhere Clinic", kind: "appointment" },
      { userId: 1, lat: 12.97, lng: 77.59 }
    );
    assert.strictEqual(res.ok, false);
    assert.ok(!res.needsConfirmation, "must not ask to approve a call it cannot place");
    assert.ok(/couldn't find a listed phone number/i.test(res.error), res.error);
  } finally {
    service.resolveBusiness = realResolve;
    agentCall.enabled = realEnabled;
  }
});

console.log("\nwhatsapp");

test("a group opens the chooser with the message already written", async () => {
  const registry = require("../src/tools/registry");
  const res = await registry.execute(
    "send_whatsapp_message",
    { to: "project team", message: "Running 10 minutes late", is_group: true },
    { userId: 1 }
  );
  assert.strictEqual(res.ok, true);
  // No group deep link exists anywhere, so the chooser is the correct target.
  assert.ok(res.deviceAction.url.startsWith("whatsapp://send?text="), res.deviceAction.url);
  assert.ok(!res.deviceAction.url.includes("phone="), "groups have no phone target");
  assert.ok(res.deviceAction.url.includes(encodeURIComponent("Running 10 minutes late")));
});

test("the tool never claims the message was sent", async () => {
  const registry = require("../src/tools/registry");
  for (const args of [
    { to: "team", message: "hi", is_group: true },
    { message: "hi" },
    { phone: "+919876543210", message: "hi" },
  ]) {
    const res = await registry.execute("send_whatsapp_message", args, { userId: 1 });
    assert.ok(
      !/\b(I sent|I've sent|sent it|message sent|delivered)\b/i.test(res.speak || ""),
      `claimed delivery: ${res.speak}`
    );
  }
});

test("a dictated number is used directly, no lookup needed", async () => {
  const registry = require("../src/tools/registry");
  const res = await registry.execute(
    "send_whatsapp_message",
    { phone: "+91 98765 43210", message: "on my way" },
    { userId: 1 }
  );
  assert.ok(res.deviceAction.url.includes("phone=%2B919876543210") ||
            res.deviceAction.url.includes("phone=+919876543210"), res.deviceAction.url);
});

test("message is the only required argument — a number is never demanded", () => {
  const registry = require("../src/tools/registry");
  assert.deepStrictEqual(registry.get("send_whatsapp_message").inputSchema.required, ["message"]);
});

test("youtube falls back to search when no API key is set", () => {
  const saved = process.env.YOUTUBE_API_KEY;
  delete process.env.YOUTUBE_API_KEY;
  assert.strictEqual(youtube.enabled(), false);
  const u = youtube.searchUrl("tum hi ho", "android");
  assert.ok(u.includes("package=com.google.android.youtube"));
  if (saved) process.env.YOUTUBE_API_KEY = saved;
});

test("youtube watch link points at the video, which is what makes it play", () => {
  assert.ok(youtube.watchUrl("abc123").includes("watch?v=abc123"));
});

// The async test above resolves after this line; give it a tick, then report.
setTimeout(() => {
  console.log(`\n${passed} passed${process.exitCode ? " — with failures above" : ""}\n`);
}, 250);
