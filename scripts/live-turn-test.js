/**
 * LIVE TURN-TAKING, MODEL AND MANNER — `npm run test:live`.
 *
 * The owner, 2026-09-26: "there is no necessity of saying sir in each and
 * every sentence… initially we need hello sir", "it's taking so much time
 * to respond… it should respond fast, but interrupt should be there… a
 * strong valid one", and "that voice sounds robotic, we need more
 * natural". These pin:
 *   - build 113+ may be interrupted and answers after a shorter pause, on
 *     Gemini 3.8 Live with its tools still waiting for their answers;
 *   - older builds keep the patient, uninterruptible settings;
 *   - a newer model that refuses a session is set aside, not retried;
 *   - the title is said once, in the greeting, and past replies do not
 *     teach it back;
 *   - the live prompt asks for natural speech, not an announcer.
 * Nothing here talks to Google.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const assert = require("assert");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
}

const ENV_KEYS = [
  "GEMINI_LIVE_MODEL", "GEMINI_LIVE_MODEL_NEXT", "LIVE_BARGE_IN", "LIVE_SILENCE_MS",
  "LIVE_SILENCE_MS_DUPLEX", "LIVE_ACTIVITY_HANDLING", "LIVE_END_SENSITIVITY",
];
function withEnv(vars, fn) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  try { return fn(); }
  finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

const tt = require("../src/live/turnTaking");

console.log("\nturn-taking by build");
test("build 112 keeps the patient, uninterruptible session it has today", () => withEnv({}, () => {
  tt._forgetRefusals();
  const s = tt.forSession({ build: 112 });
  assert.strictEqual(s.model, "gemini-2.5-flash-native-audio-preview");
  assert.strictEqual(s.next, false);
  assert.strictEqual(s.bargeIn, false);
  assert.strictEqual(s.realtimeInputConfig.activityHandling, "NO_INTERRUPTION");
  assert.strictEqual(s.realtimeInputConfig.automaticActivityDetection.silenceDurationMs, 1100);
  assert.strictEqual(s.blockingTools, false);
}));
test("build 113 can be interrupted and answers sooner, on the model everyone has", () => withEnv({}, () => {
  tt._forgetRefusals();
  const s = tt.forSession({ build: 113 });
  // The newer model is opt-in since its first test (voice and goals).
  assert.strictEqual(s.model, "gemini-2.5-flash-native-audio-preview");
  assert.strictEqual(s.next, false);
  assert.strictEqual(s.bargeIn, true);
  assert.ok(!("activityHandling" in s.realtimeInputConfig),
    "interrupting is Google's default, so nothing is sent for it");
  const d = s.realtimeInputConfig.automaticActivityDetection;
  assert.strictEqual(d.silenceDurationMs, 600);
  assert.strictEqual(d.startOfSpeechSensitivity, "START_SENSITIVITY_HIGH",
    "LOW never heard a clean hello");
  assert.strictEqual(d.endOfSpeechSensitivity, "END_SENSITIVITY_LOW");
  assert.strictEqual(d.prefixPaddingMs, 300);
  assert.ok(d.silenceDurationMs < 1200, "must stay under the app's 1.2 s quiet tail");
  assert.strictEqual(s.blockingTools, false);
}));
test("GEMINI_LIVE_MODEL_NEXT puts build 113 on the newer model, tools kept waiting", () =>
  withEnv({ GEMINI_LIVE_MODEL_NEXT: "gemini-3.8-live" }, () => {
    tt._forgetRefusals();
    const s = tt.forSession({ build: 113 });
    assert.strictEqual(s.model, "gemini-3.8-live");
    assert.strictEqual(s.next, true);
    assert.strictEqual(s.blockingTools, true);
    assert.strictEqual(tt.forSession({ build: 112 }).model, "gemini-2.5-flash-native-audio-preview",
      "older builds never move");
  }));
test("LIVE_BARGE_IN=off puts build 113 back to half-duplex", () => withEnv({ LIVE_BARGE_IN: "off" }, () => {
  tt._forgetRefusals();
  const s = tt.forSession({ build: 113 });
  assert.strictEqual(s.bargeIn, false);
  assert.strictEqual(s.realtimeInputConfig.activityHandling, "NO_INTERRUPTION");
  assert.strictEqual(s.realtimeInputConfig.automaticActivityDetection.silenceDurationMs, 1100);
}));
test("GEMINI_LIVE_MODEL_NEXT=off keeps build 113 on the current model", () =>
  withEnv({ GEMINI_LIVE_MODEL_NEXT: "off" }, () => {
    tt._forgetRefusals();
    const s = tt.forSession({ build: 113 });
    assert.strictEqual(s.model, "gemini-2.5-flash-native-audio-preview");
    assert.strictEqual(s.next, false);
    assert.strictEqual(s.bargeIn, true, "barge-in does not depend on the model");
    assert.strictEqual(s.blockingTools, false);
  }));
test("the windows are tunable, and a typo falls back instead of breaking", () =>
  withEnv({ LIVE_SILENCE_MS_DUPLEX: "800", LIVE_SILENCE_MS: "abc" }, () => {
    assert.strictEqual(tt.forSession({ build: 113 }).silenceMs, 800);
    assert.strictEqual(tt.forSession({ build: 112 }).silenceMs, 1100);
  }));

console.log("\na model that refuses a session");
test("is set aside for half an hour, then tried again", () => withEnv({ GEMINI_LIVE_MODEL_NEXT: "gemini-3.8-live" }, () => {
  tt._forgetRefusals();
  const t0 = 1_800_000_000_000;
  tt.markRefused("gemini-3.8-live", t0);
  const during = tt.forSession({ build: 113, now: t0 + 60_000 });
  assert.strictEqual(during.model, "gemini-2.5-flash-native-audio-preview");
  assert.strictEqual(during.next, false);
  assert.strictEqual(during.bargeIn, true);
  assert.strictEqual(tt.forSession({ build: 113, now: t0 + 31 * 60_000 }).model, "gemini-3.8-live");
}));

console.log("\ntools on the newer models");
test("wait for their answers (BLOCKING), and only there", () => {
  for (const m of ["gemini-3.8-live", "gemini-3.8-live-extended-thinking", "gemini-3.10-live", "gemini-4-live"]) {
    assert.ok(tt.toolsMustBlock(m), m);
  }
  for (const m of ["gemini-2.5-flash-native-audio-preview", "gemini-3.1-flash-live-preview", "", null]) {
    assert.ok(!tt.toolsMustBlock(m), String(m));
  }
  const decls = [{ name: "a", description: "", parameters: {} }];
  assert.deepStrictEqual(tt.declarationsFor(decls, { blockingTools: false }), decls);
  assert.strictEqual(tt.declarationsFor(decls, { blockingTools: true })[0].behavior, "BLOCKING");
  assert.strictEqual(decls[0].behavior, undefined, "the registry's own objects are not changed");
});

console.log("\nthe live session uses all of that");
test("the proxy takes model, turn-taking and tools from the session", () => {
  const src = require("fs").readFileSync(__dirname + "/../src/live/proxy.js", "utf8");
  assert.match(src, /forSession\(\{ build: deviceCtx\.build \}\)/);
  assert.match(src, /currentKey\(turns\.model\)/, "the key is chosen for the model in use");
  assert.match(src, /model: `models\/\$\{turns\.model\}`/);
  assert.match(src, /realtimeInputConfig: turns\.realtimeInputConfig/);
  assert.match(src, /declarationsFor\(/);
  assert.match(src, /type: "ready", model: turns\.model, bargeIn: turns\.bargeIn/);
  assert.match(src, /markRefused\(turns\.model\)/);
  assert.doesNotMatch(src, /silenceDurationMs: Number\(process\.env\.LIVE_SILENCE_MS/,
    "one place decides the window, not two");
});

console.log("\nthe title, once");
const { addressRule } = require("../src/agents/owner");
test("the rule says once, in the greeting, and its examples carry no title", () => {
  const rule = addressRule({ name: "Dhanush K", gender: "male" });
  assert.match(rule, /ONCE/);
  assert.match(rule, /"Hello Sir!"/);
  assert.match(rule, /"Done\.", "Sure, calling him now\."/);
  assert.doesNotMatch(rule, /Done, Sir|Sorry Sir/, "an example with the title teaches the title");
  assert.match(addressRule({ name: "Asha", gender: "female" }), /"Hello Ma'am!"/);
});
const { withoutTitle } = require("../src/memory/recent");
test("past replies lose the title and keep what was said", () => {
  const cases = [
    ["Done, Sir.", "Done."],
    ["Hello Sir! How can I help?", "Hello! How can I help?"],
    ["Good morning, Sir! How can I help you today?", "Good morning! How can I help you today?"],
    ["Sure Sir, shall I call 6360139965 and say: 'I will be late'?", "Sure, shall I call 6360139965 and say: 'I will be late'?"],
    ["Sir, you missed 2 calls — Ravi at 3:10 pm.", "You missed 2 calls — Ravi at 3:10 pm."],
    ["Okay Sir calling you back", "Okay calling you back"],
    ["Sorry Ma'am, that didn't go through.", "Sorry, that didn't go through."],
    ["It's done. Sir, anything else?", "It's done. Anything else?"],
    ["Your meeting with Allen is at 4 pm.", "Your meeting with Allen is at 4 pm."],
  ];
  for (const [said, kept] of cases) assert.strictEqual(withoutTitle(said), kept, said);
});

console.log("\nthe way she talks");
const { _liveSystemPrompt } = require("../src/live/proxy");
test("natural speech is asked for, the announcer register is not", () => {
  const p = _liveSystemPrompt("Hari", [], "", 330, "", "", 113);
  assert.match(p, /SOUND LIKE A PERSON, NOT A MACHINE/);
  assert.match(p, /contractions/);
  assert.match(p, /never formal or stiff/);
  assert.doesNotMatch(p, /calm, precise/, "the line that made her clipped and flat");
  assert.match(p, /polite register \(ನೀವು \/ आप\)/, "respect stays");
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
process.exit(process.exitCode || 0);
