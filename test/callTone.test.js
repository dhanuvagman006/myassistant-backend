/**
 * HOW A RELAYED CALL SOUNDS — `npm run test:calltone`.
 *
 * The owner, 2026-10-01: a dues call and a birthday call must not sound
 * the same. These pin the manner chosen from the task, the user's own
 * words winning, abuse refused, and self-calls never scolding the user.
 */
const assert = require("assert");
const T = require("../src/agents/callTone");
const { DEFAULT_TONE } = require("../src/agents/callAgentConfig");

const CASES = [
  // [task, expected manner]
  ["tell him his loan EMI of 12,000 is overdue since the 5th and must be paid by Friday", "firm"],
  ["remind Suresh that the rent is pending for two months", "firm"],
  ["ask him when he will return the money he borrowed", "firm"],
  ["usko bolo paisa wapas karna hai is hafte", "firm"],
  ["tell her the outstanding balance is still unpaid", "firm"],
  ["wish him a very happy birthday from me", "warm"],
  ["congratulate them on the wedding", "warm"],
  ["wish amma a happy Diwali", "warm"],
  ["tell him I am so sorry to hear his father passed away", "gentle"],
  ["ask how uncle is doing after the surgery", "gentle"],
  ["tell him it is urgent, he must call me right now", "urgent"],
  ["tell him the work is still not done and I am not happy", "displeased"],
  ["tell her this is the third time I am asking for the report", "displeased"],
  ["thank him for all his help last week", "sincere"],
  ["invite them for the housewarming on Sunday at 11", "welcoming"],
  ["tell him I'll be ten minutes late", "default"],
  ["ask what time the meeting is tomorrow", "default"],
  ["remind her to bring the documents", "default"],
];

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

for (const [task, want] of CASES) {
  check(`"${task.slice(0, 60)}" → ${want}`, () => {
    const r = T.resolve({ task });
    assert.strictEqual(r.id, want);
    assert.ok(r.tone.length > 40 && r.tone.length <= T.MAX, "tone paragraph size");
    if (want === "default") assert.strictEqual(r.tone, DEFAULT_TONE);
  });
}

check("the user's own words win over the task", () => {
  const r = T.resolve({ requested: "be warm, he is a friend", task: "tell him the EMI is overdue" });
  assert.strictEqual(r.id, "warm");
  assert.strictEqual(r.source, "requested");
  assert.ok(/own words/.test(r.tone));
});

check("'be firm' on a plain message is firm", () => {
  assert.strictEqual(T.resolve({ requested: "be firm", task: "tell him to come tomorrow" }).id, "firm");
});

check("an unknown manner is kept, inside the limits", () => {
  const r = T.resolve({ requested: "like a school principal", task: "tell him to submit the form" });
  assert.strictEqual(r.id, "custom");
  assert.ok(/school principal/.test(r.tone));
  assert.ok(/never insults/i.test(r.tone));
});

check("abuse is refused and the call goes out firm", () => {
  const r = T.resolve({ requested: "abuse him and shout", task: "he has not paid" });
  assert.strictEqual(r.id, "firm");
  assert.ok(/refused/.test(r.tone));
  assert.ok(!/shout at|insult him/.test(r.tone));
});

check("grief beats a celebration word in the same message", () => {
  assert.strictEqual(T.resolve({ task: "tell her the birthday party is cancelled, grandfather passed away" }).id, "gentle");
});

check("a self reminder to pay one's own EMI is not a collection call", () => {
  const r = T.resolve({ selfCall: true, task: "remind me to pay my EMI today" });
  assert.strictEqual(r.id, "default");
});

check("a wake-up call is bright", () => {
  assert.strictEqual(T.resolve({ selfCall: true, task: "wake me up, I have a flight" }).id, "wakeup");
});

check("audio tags only when switched on", () => {
  const before = process.env.BOLNA_AUDIO_TAGS;
  delete process.env.BOLNA_AUDIO_TAGS;
  assert.strictEqual(T.withAudioTags("plain"), "plain");
  process.env.BOLNA_AUDIO_TAGS = "on";
  assert.ok(/ElevenLabs v3/.test(T.withAudioTags("plain")));
  if (before === undefined) delete process.env.BOLNA_AUDIO_TAGS; else process.env.BOLNA_AUDIO_TAGS = before;
});

check("nothing tone-related exceeds the limit", () => {
  for (const t of Object.values(T.TONES)) assert.ok(t.length <= T.MAX, t.slice(0, 30));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
