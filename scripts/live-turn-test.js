/**
 * THE SPOKEN MANNER — `npm run test:live`.
 *
 * The owner, 2026-09-26: "there is no necessity of saying sir in each and
 * every sentence… initially we need hello sir", and "that voice sounds
 * robotic, we need more natural". These pin:
 *   - the title is said once, in the greeting, and past replies do not
 *     teach it back;
 *   - the spoken prompt asks for natural speech, not an announcer.
 *
 * (Until 2026-09-29 this suite also pinned the Live socket's turn-taking,
 * barge-in and model choice per build. That socket is gone — the app runs
 * its own models through Firebase AI Logic — and so are those settings.
 * The spoken prompt moved with the conversation to src/ai/voicePrompt.js.)
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
const { voiceSystemPrompt } = require("../src/ai/voicePrompt");
test("natural speech is asked for, the announcer register is not", () => {
  const p = voiceSystemPrompt("Hari", [], "", 330, "", "", 113);
  assert.match(p, /SOUND LIKE A PERSON, NOT A MACHINE/);
  assert.match(p, /contractions/);
  assert.match(p, /never formal or stiff/);
  assert.doesNotMatch(p, /calm, precise/, "the line that made her clipped and flat");
  assert.match(p, /polite register \(ನೀವು \/ आप\)/, "respect stays");
});
test("the spoken prompt does not claim to hear a voice it only reads", () => {
  const p = voiceSystemPrompt("Hari", [], "", 330, "", "", 120);
  assert.match(p, /HOW THEY SOUND IS HALF OF WHAT THEY SAID/);
  assert.doesNotMatch(p, /You can hear them/, "the app's recogniser hands the model words, not a voice");
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
process.exit(process.exitCode || 0);
