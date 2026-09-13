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

// The old harness called fn() and never awaited it. Six of the tests below
// are async, so their assertions resolved AFTER the try/catch had already
// counted them as passed — they printed "ok" without having been checked.
// When one finally did fail, the rejection had nowhere to go: it killed the
// process as an unhandled rejection and took the seven tests after it with
// it. Queue everything, then run it in order and wait for each one.
const queue = [];
function test(name, fn) {
  queue.push({ name, fn });
}
function section(title) {
  queue.push({ title });
}

async function run() {
  for (const item of queue) {
    if (item.title) {
      console.log(`\n${item.title}`);
      continue;
    }
    try {
      await item.fn();
      passed++;
      console.log(`  ok  ${item.name}`);
    } catch (e) {
      console.error(`  FAIL ${item.name}\n       ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(
    `\n${passed}/${queue.filter((q) => q.fn).length} passed` +
      `${process.exitCode ? " — with failures above" : ""}\n`
  );
}

section("deep links");

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

section("honesty invariants");

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

section("calling a business Hari looked up");

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

section("whatsapp");

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

/* ------------------------------------------------------------------ *
 * OPENING AN APP THE USER NAMED
 *
 * Shipped broken: "open the Swiggy app" was answered "Sure, opening
 * YouTube for you", and "open Uber" opened nothing while saying it had.
 * Neither open_app nor open_service_app lists Swiggy or Uber in its enum,
 * so the model emitted the nearest schema-valid value. These check the
 * launcher that fixes it — and, just as importantly, that an app it does
 * NOT know is refused instead of quietly becoming a different one.
 * ------------------------------------------------------------------ */

test("the apps people actually ask for resolve to their own package", () => {
  const d = require("../src/fulfillment/deeplinks");
  for (const [said, label, pkg] of [
    ["Swiggy", "Swiggy", "in.swiggy.android"],
    ["Uber", "Uber", "com.ubercab"],
    ["Zomato", "Zomato", "com.application.zomato"],
    ["Ola", "Ola", "com.olacabs.customer"],
    ["BookMyShow", "BookMyShow", "com.bt.bms"],
  ]) {
    const r = d.launch({ name: said, platform: "android" });
    assert.ok(r, `${said} must resolve`);
    assert.strictEqual(r.label, label);
    assert.ok(r.url.includes(`package=${pkg}`), r.url);
  }
});

test("the way people actually phrase it still resolves", () => {
  const d = require("../src/fulfillment/deeplinks");
  for (const said of [
    "open the swiggy app", "launch my uber app", "go to zomato",
    "the Zomato application", "open ola cabs", "swiggy instamart", "BMS",
  ]) {
    assert.ok(d.launch({ name: said, platform: "android" }),
      `"${said}" should resolve — a single-pass strip left "the swiggy" and did not`);
  }
});

test("an app we cannot open is refused, never silently swapped", () => {
  const d = require("../src/fulfillment/deeplinks");
  for (const said of ["netflix", "open", "the app", "", "hotstar"]) {
    assert.strictEqual(d.launch({ name: said, platform: "android" }), null,
      `"${said}" must return null rather than resolve to something else`);
  }
});

test("an app the server has no deep link for is handed to the PHONE, not refused", async () => {
  const registry = require("../src/tools/registry");
  // The server has no business deciding what is installed. It used to
  // refuse anything outside a list of ten, so "open BigBasket" was
  // answered "I can't open that" on a phone that had BigBasket on its
  // home screen.
  const res = await registry.get("open_named_app").execute(
    { app: "BigBasket" }, { platform: "android" }
  );
  assert.strictEqual(res.ok, true, "the server must not refuse on its own");
  assert.strictEqual(res.deviceAction.type, "open_any_app");
  assert.strictEqual(res.deviceAction.name, "BigBasket");
});

test("a known provider still gets its deep link rather than a bare launch", async () => {
  const registry = require("../src/tools/registry");
  // Swiggy by intent:// lands on its own host WITH a browser fallback, so
  // it still works on a phone that does not have the app.
  const res = await registry.get("open_named_app").execute(
    { app: "Swiggy" }, { platform: "android" }
  );
  assert.strictEqual(res.deviceAction.type, "open_url");
  assert.ok(res.deviceAction.url.includes("package=in.swiggy.android"));
});

test("the app resolves an unknown name against what is actually installed", () => {
  const fs = require("fs");
  const engine = fs.readFileSync(
    __dirname + "/../../myassistant-flutter/lib/features/assistant/state/assistant_engine.dart",
    "utf8"
  );
  assert.match(engine, /case 'open_any_app':/, "the engine must handle it");
  assert.match(engine, /invokeMethod<String>\('launchApp'/,
    "and ask the phone to resolve the name");
  // A miss must be reported, or the assistant claims an app opened that did not.
  assert.match(engine, /no app by that name is installed/,
    "a missing app must be reported honestly");

  const kt = fs.readFileSync(
    __dirname + "/../../myassistant-flutter/android/app/src/main/kotlin/com/myassistant/myassistant/MainActivity.kt",
    "utf8"
  );
  assert.match(kt, /"launchApp" ->/, "Android must implement launchApp");
  assert.match(kt, /getLaunchIntentForPackage/, "and launch by package");

  const manifest = fs.readFileSync(
    __dirname + "/../../myassistant-flutter/android/app/src/main/AndroidManifest.xml",
    "utf8"
  );
  // Without this, Android 11+ hides every package and matching finds nothing.
  assert.match(manifest, /android\.intent\.category\.LAUNCHER/,
    "the manifest must declare visibility of launchable apps");
});

test("open_named_app hands the phone a launchable intent for Swiggy", async () => {
  const registry = require("../src/tools/registry");
  const res = await registry.get("open_named_app").execute(
    { app: "Swiggy" }, { platform: "android" }
  );
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.deviceAction.type, "open_url");
  assert.ok(res.deviceAction.url.startsWith("intent://"), res.deviceAction.url);
  assert.ok(res.deviceAction.url.includes("package=in.swiggy.android"));
  // Without the browser fallback a phone that lacks the app dead-ends.
  assert.ok(res.deviceAction.url.includes("browser_fallback_url"));
  assert.match(res.speak, /Opening Swiggy/i);
});

test("a non-Android phone gets the plain https link, not an intent URL", async () => {
  const registry = require("../src/tools/registry");
  const res = await registry.get("open_named_app").execute(
    { app: "Swiggy" }, { platform: "ios" }
  );
  assert.strictEqual(res.ok, true);
  assert.ok(res.deviceAction.url.startsWith("https://"), res.deviceAction.url);
});

test("news does not read the same headlines twice in a row", () => {
  const news = require("../src/services/tools/news");
  news.forget(99071);
  const items = Array.from({ length: 12 }, (_, i) => ({ title: `Story ${i + 1}`, source: "S" }));
  const first = news.freshFor(99071, items, 6).map((h) => h.title);
  const second = news.freshFor(99071, items, 6).map((h) => h.title);
  assert.strictEqual(first.length, 6);
  assert.strictEqual(second.length, 6);
  // The BRICS summit was recited to a user over and over because the top
  // six came back from cache every time.
  assert.strictEqual(
    first.filter((t) => second.includes(t)).length, 0,
    `the second ask repeated: ${second.join(", ")}`
  );
  news.forget(99071);
});

test("news cycles rather than going silent once everything is heard", () => {
  const news = require("../src/services/tools/news");
  news.forget(99072);
  const items = Array.from({ length: 6 }, (_, i) => ({ title: `Only ${i + 1}`, source: "S" }));
  assert.strictEqual(news.freshFor(99072, items, 6).length, 6);
  const again = news.freshFor(99072, items, 6);
  assert.strictEqual(again.length, 6, "an empty news answer is worse than a repeat");
  news.forget(99072);
});

test("one user's news history does not affect another's", () => {
  const news = require("../src/services/tools/news");
  news.forget(99073); news.forget(99074);
  const items = Array.from({ length: 12 }, (_, i) => ({ title: `Item ${i + 1}`, source: "S" }));
  const a = news.freshFor(99073, items, 6).map((h) => h.title);
  const b = news.freshFor(99074, items, 6).map((h) => h.title);
  assert.deepStrictEqual(a, b, "a second user must still get the top headlines");
  news.forget(99073); news.forget(99074);
});

/* ------------------------------------------------------------------ *
 * THE CLAIM CHECK MUST KNOW ABOUT THE TOOLS THAT EXIST
 *
 * open_named_app was added and not added to the "open" family, so Swiggy
 * opened and the assistant apologised for it three seconds later — the
 * exact inverse of the bug claimCheck exists to prevent. A family that
 * does not list a tool silently calls the assistant a liar.
 * ------------------------------------------------------------------ */

test("every tool named in a claim family actually exists", () => {
  const registry = require("../src/tools/registry");
  const { FAMILIES } = require("../src/agents/claimCheck");
  const missing = [];
  for (const f of FAMILIES) {
    for (const t of f.tools) if (!registry.get(t)) missing.push(`${f.id} → ${t}`);
  }
  assert.deepStrictEqual(missing, [],
    `claim families name tools that do not exist: ${missing.join(", ")}`);
});

test("saying 'opening Swiggy' is backed by open_named_app", () => {
  const claimCheck = require("../src/agents/claimCheck");
  const v = claimCheck.check("Sure, opening Swiggy.", [{ tool: "open_named_app", ok: true }]);
  assert.strictEqual(v.ok, true,
    `the checker contradicted a tool that ran: ${v.violations.join("; ")}`);
  assert.match(v.text, /opening Swiggy/i);
});

test("saying 'opening Swiggy' with NOTHING run is still corrected", () => {
  const claimCheck = require("../src/agents/claimCheck");
  const v = claimCheck.check("Sure, opening Swiggy.", []);
  assert.strictEqual(v.ok, false, "an unbacked claim must still be caught");
});

test("every device action belongs to some claim family, or is listed as exempt", () => {
  const registry = require("../src/tools/registry");
  require("../src/agents/runtime");
  const { FAMILIES } = require("../src/agents/claimCheck");
  const covered = new Set(FAMILIES.flatMap((f) => f.tools));
  // Device actions the model does not narrate as a completed act, so no
  // family needs to vouch for them.
  // Kept deliberately SHORT. An over-broad exempt list makes this test
  // pass while the bug it guards against is still present, which is how
  // the first version of it let enable_usage_tracking through.
  const EXEMPT = new Set([
    // Mode switches — the model does not narrate these as "opening".
    "translator_mode", "start_interpreter_mode", "stop_interpreter_mode",
    // Reads the screen rather than opening anything.
    "look_at_screenshot",
  ]);
  const orphans = registry.list()
    .filter((t) => t.deviceAction && !covered.has(t.name) && !EXEMPT.has(t.name))
    .map((t) => t.name);
  assert.deepStrictEqual(orphans, [],
    `these device actions are narrated but no claim family backs them: ${orphans.join(", ")}`);
});

test("claims about screens and timers are backed by the tool that ran", () => {
  const claimCheck = require("../src/agents/claimCheck");
  // Each of these was observed being contradicted seconds after it worked.
  const cases = [
    ["OK, I'm opening those settings now.", "enable_usage_tracking"],
    ["Opening Swiggy for your biryani.", "order_food"],
    ["Sure, opening Uber for you.", "book_ride"],
    ["Opening BookMyShow now.", "book_movie_tickets"],
    ["I've set a timer for ten minutes.", "set_timer"],
  ];
  for (const [said, tool] of cases) {
    const v = claimCheck.check(said, [{ tool, ok: true }]);
    assert.strictEqual(v.ok, true,
      `"${said}" was contradicted despite ${tool} running: ${v.violations.join("; ")}`);
  }
});

/* ------------------------------------------------------------------ *
 * SETTINGS BY VOICE — theme, screens, and the assistant's own voice.
 * ------------------------------------------------------------------ */

test("setting the theme by voice produces an action the app can perform", async () => {
  const registry = require("../src/tools/registry");
  for (const [mode, expect] of [["dark", /dark/i], ["light", /light/i], ["adaptive", /automatic/i]]) {
    const res = await registry.get("set_app_theme").execute({ mode }, {});
    assert.strictEqual(res.ok, true, `${mode} should be settable`);
    assert.strictEqual(res.deviceAction.type, "set_theme");
    assert.strictEqual(res.deviceAction.mode, mode);
    assert.match(res.speak, expect, res.speak);
  }
});

test("a theme the app does not have is refused, not guessed at", async () => {
  const registry = require("../src/tools/registry");
  const res = await registry.get("set_app_theme").execute({ mode: "sepia" }, {});
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /sepia/);
});

test("every screen open_app_screen offers is one the app can actually build", async () => {
  const fs = require("fs");
  const registry = require("../src/tools/registry");
  const screens = registry.get("open_app_screen").inputSchema.properties.screen.enum;
  // The four tabs live in the shell; the rest must have a builder entry.
  const TABS = ["home", "hub", "chat", "settings"];
  const engine = fs.readFileSync(
    __dirname + "/../../myassistant-flutter/lib/features/assistant/state/assistant_engine.dart",
    "utf8"
  );
  const missing = screens
    .filter((s) => !TABS.includes(s))
    .filter((s) => !engine.includes(`'${s}' => (_)`));
  assert.deepStrictEqual(missing, [],
    `the tool offers screens the app cannot open: ${missing.join(", ")}`);
});

test("asking for a male voice actually changes the voice, not just the label", () => {
  // gender and voice are separate columns and the live path reads `voice`.
  // Setting only gender left it speaking with Kore while claiming otherwise.
  const src = require("fs").readFileSync(__dirname + "/../src/users/context.js", "utf8");
  assert.match(src, /VOICE_FOR_GENDER/, "gender must map to a voice");
  assert.match(src, /female:\s*"Kore"/, "female voice must be one the picker offers");
  assert.match(src, /male:\s*"Charon"/, "male voice must be one the picker offers");
  // An explicit voice must still win over the gender default.
  assert.match(src, /if \(!voice && VOICE_FOR_GENDER\[g\]\)/,
    "a voice the user chose explicitly must not be overwritten by a gender change");
});

/* ------------------------------------------------------------------ *
 * A VOICE CHANGE HAS TO BE HEARD
 *
 * Gemini Live fixes the voice in the setup frame, sent once per socket.
 * Changing the profile mid-call updated the database and nothing else:
 * the user asked for a male voice, was told it changed, and kept hearing
 * the female one. The app is now told to rebuild the session.
 * ------------------------------------------------------------------ */




test("the app actually handles the voice-change action it is sent", () => {
  const fs = require("fs");
  const engine = fs.readFileSync(
    __dirname + "/../../myassistant-flutter/lib/features/assistant/state/assistant_engine.dart",
    "utf8"
  );
  // The backend emitting an action nothing handles is the exact shape of
  // this morning's bug, so the two halves are checked together.
  assert.match(engine, /case 'live_voice_changed':/,
    "the engine must handle live_voice_changed");
  assert.match(engine, /_rebuildLiveForVoice/,
    "and must actually rebuild the session");
});

test("barge-in: the mic keeps streaming while she is speaking locally", () => {
  const fs = require("fs");
  const live = fs.readFileSync(
    __dirname + "/../../myassistant-flutter/lib/services/live_service.dart",
    "utf8"
  );
  // Google decides an interruption happened, and can only decide it about
  // audio it receives. This used to `return` without sending anything.
  assert.match(live, /if \(!remoteSpeaking && !_gateActive && l != null\)/,
    "mic frames must still go upstream during local playback, or barge-in cannot work");
  assert.match(live, /if \(l > bargeFloor\) _ch\?\.sink\.add/,
    "and only audio above the echo residue, or she interrupts herself");
  assert.match(live, /_bargeInFactor/, "the threshold must be a named, tunable constant");
});

test("neither surface may hand the task back to the user", () => {
  const fs = require("fs");
  // "or you can just open it yourself on your phone" — the user called it
  // disrespectful, and they were right: they are talking to an assistant
  // precisely so they do not have to do it.
  const runtime = require("../src/agents/runtime").systemPrompt("");
  assert.match(runtime, /YOU DO THE WORK, NOT THEM/,
    "the classic/voice prompt must forbid handing work back");
  assert.match(runtime, /say in ONE sentence WHY/i,
    "a refusal must still carry a reason");

  const proxy = fs.readFileSync(__dirname + "/../src/live/proxy.js", "utf8");
  assert.match(proxy, /YOU DO THE WORK, NOT THEM/,
    "live mode needs the same rule — it is where this was reported");
  assert.match(proxy, /doItRule/, "and it must actually be in the prompt");
});

/* ------------------------------------------------------------------ *
 * WHOSE PROFILE IS THIS?
 *
 * Asked for the actor Neha Shetty, a handle the model REMEMBERED opened a
 * different Neha Shetty — four times running while the user rephrased.
 * The handle is looked up now, and an uncertain match goes to a search
 * page rather than confidently opening a stranger.
 * ------------------------------------------------------------------ */

test("a handle is scored against the name, so a namesake does not win", () => {
  const sh = require("../src/tools/socialHandles");
  const shouldOpen = [
    ["nehashetty", "Neha Shetty"], ["neha_shetty", "Neha Shetty"],
    ["iamnehashetty", "Neha Shetty"], ["nehashettyofficial", "Neha Shetty"],
    // Handles are often the name trimmed: Dhanush Vagman -> dhanuvagman.
    ["dhanuvagman", "Dhanush Vagman"], ["dhanushvagman", "Dhanush Vagman"],
  ];
  const shouldNot = [
    ["nehasharma", "Neha Shetty"],     // a different person entirely
    ["neha", "Neha Shetty"],           // too little of the name
    ["shettyfanclub", "Neha Shetty"],  // a fan account, not her
    ["randomuser", "Neha Shetty"],
    ["vagmandhanu", "Dhanush Vagman"], // right parts, wrong order
  ];
  for (const [h, n] of shouldOpen) {
    assert.ok(sh.score(h, n) >= 60, `${h} should be accepted for "${n}" (got ${sh.score(h, n)})`);
  }
  for (const [h, n] of shouldNot) {
    assert.ok(sh.score(h, n) < 60, `${h} must NOT be opened for "${n}" (got ${sh.score(h, n)})`);
  }
});

test("platform pages are never mistaken for a person", () => {
  const sh = require("../src/tools/socialHandles");
  for (const p of ["explore", "accounts", "reels", "p", "login", "search"]) {
    assert.ok(sh.NOT_A_HANDLE.has(p), `instagram.com/${p} is not somebody's profile`);
  }
});

test("the handle is read from prose, not only from URLs", async () => {
  const sh = require("../src/tools/socialHandles");
  const ws = require("../src/tools/webSearch");
  const real = ws.run;
  // Gemini grounding — the provider actually in use — returns
  // vertexaisearch redirect URLs, so the handle only ever appears in the
  // answer text. Reading URLs alone resolved nobody at all.
  ws.run = async () => ({
    ok: true,
    data: [{
      title: "Web answer",
      snippet: "Virat Kohli's official Instagram profile is @virat.kohli.",
      url: "",
    }],
  });
  sh._clear();
  const h = await sh.resolve("Virat Kohli", "instagram", {});
  ws.run = real;
  assert.strictEqual(h, "virat.kohli");
});

test("an uncertain lookup opens a search page instead of a stranger", async () => {
  const sh = require("../src/tools/socialHandles");
  const ws = require("../src/tools/webSearch");
  const real = ws.run;
  ws.run = async () => ({
    ok: true,
    data: [{ title: "x", snippet: "Follow @someoneelse for updates", url: "" }],
  });
  sh._clear();
  const h = await sh.resolve("Neha Shetty", "instagram", {});
  ws.run = real;
  assert.strictEqual(h, null,
    "a weak match must not be opened — that is the bug being fixed");
});

test("open_app asks for the person's name, not a remembered username", () => {
  const registry = require("../src/tools/registry");
  const t = registry.get("open_app");
  assert.ok(t.inputSchema.properties.person, "there must be a person field");
  assert.match(t.description, /DO NOT GUESS A HANDLE/,
    "the model must be told not to supply a remembered handle");
  assert.match(t.inputSchema.properties.handle.description, /user gave the username/i,
    "handle is only for a username the USER said");
});

/* ------------------------------------------------------------------ *
 * ONE SEARCH ANSWERS EVERYONE
 *
 * The cache was in-process, so every deploy threw it away and each pod
 * rebuilt it alone — while the search quota was small enough to
 * rate-limit during ordinary use.
 * ------------------------------------------------------------------ */

test("a live question and a settled fact do not get the same lifetime", () => {
  const c = require("../src/tools/searchCache");
  // Nobody should be read yesterday's headlines; nobody should spend
  // quota re-confirming the capital of France.
  assert.strictEqual(c.ttlFor(true), c.LIVE_TTL_MS);
  assert.strictEqual(c.ttlFor(false), c.STABLE_TTL_MS);
  assert.ok(c.LIVE_TTL_MS <= 30 * 60_000, "live answers must not go stale");
  assert.ok(c.STABLE_TTL_MS >= 6 * 60 * 60_000, "settled facts should be kept");
  assert.ok(c.STABLE_TTL_MS > c.LIVE_TTL_MS * 10, "the two must differ meaningfully");
});

test("the search path consults the shared store before a provider", () => {
  const src = require("fs").readFileSync(__dirname + "/../src/tools/webSearch.js", "utf8");
  const sharedAt = src.indexOf("searchCache.get(");
  const providerAt = src.indexOf("await BACKENDS[p](q)");
  assert.ok(sharedAt > 0 && providerAt > 0, "both paths must exist");
  assert.ok(sharedAt < providerAt,
    "the shared cache must be read BEFORE spending a search");
  assert.match(src, /searchCache\.put\(/, "and successful answers written back");
});

test("a failed or fallback search is never cached", () => {
  const src = require("fs").readFileSync(__dirname + "/../src/tools/searchCache.js", "utf8");
  // Caching a failure would turn one provider hiccup into 20 minutes of
  // failure for every user.
  assert.match(src, /out\.ok !== true\) return/, "only successful answers");
  assert.match(src, /provider === "wikipedia"\) return/,
    "the last-resort encyclopedia must not be served as a cached answer");
});

test("the cache fails open — it can never break search", () => {
  const src = require("fs").readFileSync(__dirname + "/../src/tools/searchCache.js", "utf8");
  // get/put/sweep each swallow their own errors: a missing table or an
  // unreachable database must degrade to "just search", not to an outage.
  const bodies = src.split("async function").slice(1);
  for (const b of bodies.slice(0, 3)) {
    assert.match(b, /catch \(_\)/, "every database path must be guarded");
  }
});

test("every tool a claim family names is visible to the claim checker", () => {
  const registry = require("../src/tools/registry");
  require("../src/agents/runtime");
  registry.seal();
  const { FAMILIES } = require("../src/agents/claimCheck");
  const src = require("fs").readFileSync(__dirname + "/../src/tools/registry.js", "utf8");

  // THE INVARIANT THAT WAS MISSING. recordExecution files only certain
  // tools into the session, and the claim check reads that list. A family
  // naming a tool that is never filed there is a list that can never be
  // satisfied — so the assistant is made to apologise for work it did.
  // open_named_app opened BigBasket and was contradicted ten seconds
  // later; enable_usage_tracking and remember_fact had the same gap.
  assert.match(src, /FAMILY_TOOLS\.has\(name\)/,
    "the registry must file family tools into the session, not only world actions");

  const unseeable = [];
  for (const f of FAMILIES) {
    for (const t of f.tools) {
      if (!registry.get(t)) continue; // a separate test covers missing tools
      if (!registry.isWorldAction(t) && !require("../src/agents/claimCheck").FAMILY_TOOLS.has(t)) {
        unseeable.push(`${f.id} → ${t}`);
      }
    }
  }
  assert.deepStrictEqual(unseeable, [],
    `these can never back their own claim: ${unseeable.join(", ")}`);
});

test("a role word in the name does not break the lookup", () => {
  const sh = require("../src/tools/socialHandles");
  // The user says "open actor Neha Shetty's Instagram", so the model sends
  // person="actor Neha Shetty". Demanding the handle contain "actor" too
  // put @iamnehashetty below the threshold and opened the home feed.
  assert.strictEqual(sh.cleanName("actor Neha Shetty"), "Neha Shetty");
  assert.strictEqual(sh.cleanName("the famous actress Neha Shetty"), "Neha Shetty");
  assert.ok(sh.score("iamnehashetty", "actor Neha Shetty") >= 60,
    "her real account must still be accepted when a role word is present");
  assert.ok(sh.score("nehasharma", "actor Neha Shetty") < 60,
    "and a different person must still be rejected");
  // Stripping must never empty the name out.
  assert.strictEqual(sh.cleanName("Actor"), "Actor");
});

test("the encyclopedia fallback can never supply a handle", () => {
  const src = require("fs").readFileSync(__dirname + "/../src/tools/socialHandles.js", "utf8");
  // Rate-limited search falls back to Wikipedia, which answered "Neha
  // Shetty official instagram profile" with articles about Neha Kakkar.
  assert.match(src, /provider === "wikipedia"\) return null/,
    "wikipedia results must not be mined for a username");
});

test("a failed lookup searches for the person, never the bare home feed", async () => {
  const registry = require("../src/tools/registry");
  const sh = require("../src/tools/socialHandles");
  const ws = require("../src/tools/webSearch");
  const real = ws.run;
  ws.run = async () => ({ ok: true, provider: "brave", data: [{ title: "x", snippet: "nothing", url: "" }] });
  sh._clear();
  // A name nobody holds, so verification finds no profile either — the
  // real-network path is deliberately exercised here rather than stubbed.
  const who = "Qwertzuiop Notarealpersonxyz";
  const res = await registry.get("open_app").execute({ app: "instagram", person: who }, {});
  ws.run = real;
  // "It just opens Instagram, but I'm not able to find her profile" was
  // the fallback throwing away the name and opening the feed.
  assert.ok(!/^https:\/\/www\.instagram\.com\/$/.test(res.deviceAction.url),
    "the bare home feed is not an answer");
  assert.match(res.deviceAction.url, /Qwertzuiop/, res.deviceAction.url);
  assert.doesNotMatch(res.speak, /here are 's/, "the spoken line must not lose the name");
});

test("follower counts parse the way Instagram writes them", () => {
  const sh = require("../src/tools/socialHandles");
  assert.strictEqual(sh.followerCount("1M Followers, 1,275 Following"), 1000000);
  assert.strictEqual(sh.followerCount("205 Followers"), 205);
  assert.strictEqual(sh.followerCount("12.3K Followers"), 12300);
  assert.strictEqual(sh.followerCount("1,275 Followers"), 1275);
  assert.strictEqual(sh.followerCount("no numbers here"), 0);
});

test("the handles people actually use are all tried", () => {
  const sh = require("../src/tools/socialHandles");
  const c = sh.candidatesFrom("actor Neha Shetty");
  // The role word must be gone, and @iamnehashetty — her real account —
  // has to be among the shapes tried, or verification never sees it.
  for (const want of ["nehashetty", "neha.shetty", "neha_shetty", "iamnehashetty"]) {
    assert.ok(c.includes(want), `${want} should be tried (got ${c.join(", ")})`);
  }
  assert.ok(!c.some((h) => h.includes("actor")), "the role word is not part of a username");
});

test("the biggest account matching the name wins", () => {
  const src = require("fs").readFileSync(__dirname + "/../src/tools/socialHandles.js", "utf8");
  // Three real accounts answer to "Neha Shetty": @nehashetty (67
  // followers, no display name — what the model originally guessed),
  // @neha.shetty (205), and @iamnehashetty (1M, the actress). Name
  // matching alone cannot separate them; asked for a public figure, the
  // public figure is who is meant.
  assert.match(src, /sort\(\(a, b\) => b\.followers - a\.followers\)/,
    "candidates must be ranked by reach");
  assert.match(src, /s >= 60 \? \{ handle: h, followers/,
    "and only after the page's own name matches");
});

test("open_app verifies against the live profile, never a remembered name", () => {
  const src = require("fs").readFileSync(__dirname + "/../src/tools/builtins.js", "utf8");
  assert.match(src, /resolveVerified\(person, args\.app, ctx\)/,
    "the tool must use the verifying resolver");
  const sh = require("fs").readFileSync(__dirname + "/../src/tools/socialHandles.js", "utf8");
  // og:title states who a profile belongs to — that is what turns this
  // from a question about memory into one with a checkable answer.
  assert.match(sh, /og:title/, "verification reads the page's own claim about itself");
});

// Everything above only REGISTERED a test. This is what runs them, in
// order, each one awaited — replacing a 250 ms setTimeout that reported a
// total before the async tests had finished producing it.
run();
