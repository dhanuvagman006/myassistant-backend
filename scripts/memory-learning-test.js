/**
 * MEMORY THAT LEARNS (2026-10-18) — the pure parts, no database, no model.
 *
 *   node scripts/memory-learning-test.js      (npm run test:memory)
 *
 * Pins: which facts a reply drew on; which words read as a correction; the
 * supersede verdict in both shapes; a consolidation plan checked against
 * the rows it was shown; habits kept only after enough separate days, and
 * never once turned down; strength ranking that leaves old rows as they were.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@127.0.0.1:56432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const assert = require("assert");
const memory = require("../src/agents/memory");
const learning = require("../src/memory/learning");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) {
    failed++; console.log(`  FAIL ${name}\n       ${e.stack.split("\n").slice(0, 4).join("\n       ")}`);
  }
}

const HOME = { id: 1, fact: "User lives at Apartment 901, Waterfield Road, Bandra West, Mumbai", importance: 3 };
const LANG = { id: 2, fact: "User prefers the assistant to speak in Kannada", importance: 2, kind: "preference" };
const DENT = { id: 3, fact: "Dr. Geeta Manohar is the user's dentist at Specialty Dental Clinic", importance: 2 };
const ROWS = [HOME, LANG, DENT];

test("used: a reply that leans on a fact counts it; an unrelated one counts nothing", () => {
  const got = learning.usedMemories(ROWS, "Booking a cab to your home on Waterfield Road, Bandra West.");
  assert.deepStrictEqual(got.map((r) => r.id), [1]);
  assert.deepStrictEqual(learning.usedMemories(ROWS, "It is sunny today, 31 degrees."), []);
  assert.deepStrictEqual(learning.usedMemories(ROWS, ""), []);
  // Words every preference shares ("prefer", "speak", "assistant") are not evidence.
  assert.deepStrictEqual(learning.usedMemories(ROWS, "I prefer to speak plainly as your assistant."), []);
  assert.deepStrictEqual(learning.usedMemories(ROWS, "Dr. Geeta has a slot at the dental clinic at 4.").map((r) => r.id), [3]);
});

test("correction: put-right words are caught; an ordinary no is not", () => {
  for (const s of ["no, I moved to Pune last month", "that's not my office any more",
    "actually I'm vegetarian now", "That is wrong", "no longer working there",
    "Nope, my sister lives in Delhi", "no use SMS for her"]) {
    assert.ok(memory.CORRECTION_RX.test(s), s);
    assert.ok(memory.looksSelfDescriptive(s), `extracted too: ${s}`);
  }
  for (const s of ["no thanks", "no", "what's the weather in Mumbai", "book a cab", "nothing else"]) {
    assert.ok(!memory.CORRECTION_RX.test(s), s);
  }
});

test("correction: candidates are what the words name or what was just used", () => {
  const got = learning.correctionCandidates(ROWS, "no, I moved out of Bandra", "Your home is on Waterfield Road.");
  assert.deepStrictEqual(got.map((r) => r.id), [1]);
});

test("supersede verdict: the old array and the new object both read", () => {
  assert.deepStrictEqual(memory.parseSupersede("[2]"), { replaces: [2], same: [] });
  assert.deepStrictEqual(memory.parseSupersede('```json\n{"replaces":[1],"same":[3]}\n```'), { replaces: [1], same: [3] });
  assert.deepStrictEqual(memory.parseSupersede('{"same":[4]}'), { replaces: [], same: [4] });
});

test("consolidation: a sound merge is kept; anything malformed is dropped", () => {
  const rows = [
    { id: 10, fact: "lives in Sneha's apartment, Mumbai", kind: "semantic", subject_type: "" },
    { id: 11, fact: "lives in Neha's apartment, Mumbai", kind: "semantic", subject_type: "" },
    { id: 12, fact: "User prefers pink", kind: "semantic", subject_type: "" },
    { id: 13, fact: "Riya's college is Christ", kind: "semantic", subject_type: "person", subject_id: 5 },
    { id: 14, fact: "User lives at Apt 901, Mumbai", kind: "semantic", subject_type: "" },
    { id: 15, fact: "Arjun's college is IIT", kind: "semantic", subject_type: "person", subject_id: 6 },
  ];
  const plan = learning.planConsolidation(rows, {
    merge: [
      { ids: [1, 2, 5], fact: "User lives at Apt 901, Mumbai", kind: "fact" },
      { ids: [4, 15], fact: "two different people", kind: "fact" },    // person 5 and person 6
      { ids: [3, 4], fact: "Riya prefers pink", kind: "fact" },          // unlinked + one person: allowed
      { ids: [1, 3], fact: "reuses a merged row", kind: "fact" },      // row 1 already merged
      { ids: [3, 99], fact: "out of range", kind: "fact" },
      { ids: [3], fact: "one row is not a merge", kind: "fact" },
      { ids: [3, 4], fact: "", kind: "fact" },
    ],
    kind: [{ id: 3, kind: "preference" }, { id: 1, kind: "preference" }, { id: 4, kind: "fact" }],
  });
  assert.strictEqual(plan.merges.length, 2);
  assert.deepStrictEqual(plan.merges[0].rows.map((r) => r.id), [10, 11, 14]);
  assert.strictEqual(plan.merges[0].kind, "semantic");
  assert.strictEqual(plan.merges[0].subjectType, "");
  // The unlinked row joins person 5's: the merged fact stays on that card.
  assert.deepStrictEqual(plan.merges[1].rows.map((r) => r.id), [12, 13]);
  assert.deepStrictEqual([plan.merges[1].subjectType, plan.merges[1].subjectId], ["person", 5]);
  // A merged row is not re-filed on its own; an unchanged kind is left.
  assert.deepStrictEqual(plan.kinds.map((k) => [k.row.id, k.kind]), []);
  assert.deepStrictEqual(learning.planConsolidation(rows, null), { merges: [], kinds: [] });
});

test("habits: kept only after enough separate days; never once turned down", () => {
  const validDays = new Set(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"]);
  const first = learning.mergeCandidates([], [
    { key: "whatsapp_for_family", fact: "User messages family on WhatsApp", kind: "preference", days: ["2026-10-12", "2026-10-13"] },
    { key: "Bad Key!", fact: "x", days: ["2026-10-12"] },
    { key: "made_up_day", fact: "User x", days: ["2026-09-01"] }, // not in the transcript
  ], { validDays, minDays: 3 });
  assert.deepStrictEqual(first.map((c) => [c.key, c.promote, c.isNew]), [["whatsapp_for_family", false, true]]);

  const existing = [
    { key: "whatsapp_for_family", fact: "User messages family on WhatsApp", status: "pending", days: '["2026-10-12","2026-10-13"]' },
    { key: "short_answers", fact: "User prefers short answers", status: "rejected", days: '["2026-10-12","2026-10-13"]' },
  ];
  const second = learning.mergeCandidates(existing, [
    { key: "whatsapp_for_family", fact: "User messages family on WhatsApp", kind: "preference", days: ["2026-10-13", "2026-10-15"] },
    { key: "short_answers", fact: "User prefers short answers", kind: "preference", days: ["2026-10-14", "2026-10-15"] },
  ], { validDays, minDays: 3 });
  assert.deepStrictEqual(second.map((c) => [c.key, c.days.length, c.promote]), [["whatsapp_for_family", 3, true]]);
});

test("strength: ranks a used fact above an unused equal; old rows rank as before", () => {
  const now = Date.now();
  const old = now - 90 * 86_400_000;
  const rows = [
    { id: 1, fact: "a", importance: 2, created_at: old },
    { id: 2, fact: "b", importance: 2, created_at: old, strength: 2 },
    { id: 3, fact: "c", importance: 2, created_at: old, strength: 0.4 },
  ];
  assert.deepStrictEqual(memory.pickMemories(rows, { words: "", limit: 3, now }).map((r) => r.id), [2, 1, 3]);
  assert.strictEqual(memory.strengthOf({}), 1);
  assert.strictEqual(memory.strengthOf({ strength: null }), 1);
  // Used recently counts as recent.
  const used = { id: 4, fact: "d", importance: 2, created_at: old, last_used_at: now - 86_400_000 };
  assert.strictEqual(memory.pickMemories([rows[0], used], { words: "", limit: 1, now })[0].id, 4);
});

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
