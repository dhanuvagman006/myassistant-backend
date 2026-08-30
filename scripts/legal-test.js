/**
 * LEGAL TESTS — run with `npm run test:legal`.
 *
 * No database and no network. These cover the two things that decide
 * whether the legal capability is trustworthy:
 *
 *   • the repealed-statute detector, because the most likely wrong answer
 *     in Indian criminal law is a confident citation of an IPC section
 *     that stopped existing on 1 July 2024;
 *   • the grounding instructions, because they are the only thing stopping
 *     the model answering from its own recollection.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

const assert = require("assert");
const guard = require("../src/legal/guard");
const { PROVISIONS } = require("../src/legal/seed");

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

console.log("\nrepealed-statute detection");

test("catches the old citation in every phrasing people actually use", () => {
  const phrasings = [
    "file a 420 IPC case",
    "IPC 420",
    "section 420 IPC",
    "he was booked u/s 420 of the IPC",
    "Section 420 of the Indian Penal Code",
  ];
  for (const p of phrasings) {
    const hits = guard.findRepealedRefs(p);
    assert.ok(hits.length, `missed: ${p}`);
    assert.strictEqual(hits[0].act, "BNS", p);
    assert.strictEqual(hits[0].section, "318(4)", p);
  }
});

test("maps the most-named sections to the right new provisions", () => {
  const expect = {
    "302 IPC": ["BNS", "103(1)"],
    "498A IPC": ["BNS", "85"],
    "376 IPC": ["BNS", "64"],
    "304A IPC": ["BNS", "106(1)"],
    "CrPC 41A": ["BNSS", "35(3)"],
    "section 154 CrPC": ["BNSS", "173"],
    "65B of the Evidence Act": ["BSA", "63"],
  };
  for (const [cited, [act, section]] of Object.entries(expect)) {
    const hits = guard.findRepealedRefs(cited);
    assert.ok(hits.length, `no hit for ${cited}`);
    assert.strictEqual(hits[0].act, act, cited);
    assert.strictEqual(hits[0].section, section, cited);
  }
});

test("sedition is flagged as repealed, NOT renumbered to BNS 152", () => {
  const hit = guard.findRepealedRefs("124A IPC sedition")[0];
  assert.strictEqual(hit.section, "152");
  assert.ok(hit.note && /not.*renumber|narrower|do not treat/i.test(hit.note),
    "must warn that BNS 152 is not equivalent to sedition");
});

test("an unmapped old section reports null instead of inventing a number", () => {
  const hits = guard.findRepealedRefs("section 268 IPC");
  assert.ok(hits.length, "should still recognise it as an IPC reference");
  assert.strictEqual(hits[0].section, null, "must not guess a BNS number");
});

test("does not fire on current law or on bare numbers", () => {
  assert.strictEqual(guard.findRepealedRefs("BNS 318(4)").length, 0);
  assert.strictEqual(guard.findRepealedRefs("section 138 NI Act").length, 0);
  assert.strictEqual(guard.findRepealedRefs("I paid 420 rupees").length, 0);
});

console.log("\ngrounding instructions");

test("with no retrieved provisions, the model is told not to answer", () => {
  const block = guard.legalSystemBlock({ provisions: [], repealed: [] });
  assert.ok(/NO PROVISIONS WERE RETRIEVED/.test(block));
  assert.ok(/do not answer from memory/i.test(block));
});

test("retrieved provisions are the declared sole basis for the answer", () => {
  const block = guard.legalSystemBlock({
    provisions: [PROVISIONS.find((p) => p.slug === "NIA:138")],
    repealed: [],
  });
  assert.ok(/ONLY basis for your answer/i.test(block));
  assert.ok(block.includes("NI Act 138"));
  assert.ok(/30 DAYS/.test(block), "the cheque-bounce deadlines must reach the model");
});

test("the 2024 recodification is stated as a hard rule every time", () => {
  const block = guard.legalSystemBlock({ provisions: [], repealed: [] });
  assert.ok(/1 July 2024/.test(block));
  assert.ok(/Never cite IPC\/CrPC\/Evidence Act sections as current law/i.test(block));
});

test("a repealed reference becomes an explicit correction instruction", () => {
  const block = guard.legalSystemBlock({
    provisions: [],
    repealed: guard.findRepealedRefs("420 IPC"),
  });
  assert.ok(/REPEALED PROVISIONS/.test(block));
  assert.ok(/BNS 318\(4\)/.test(block));
});

console.log("\nadvice boundary");

test("custody, bail and deadlines route the user to a real advocate", () => {
  for (const q of [
    "my brother has been arrested what do I do",
    "I need anticipatory bail",
    "my hearing is next week",
  ]) {
    const r = guard.advocateReferral(q);
    assert.ok(r, `no referral for: ${q}`);
    // Never a dead end for someone who cannot pay.
    assert.ok(/15100|legal aid/i.test(r), r);
  }
});

test("a general question does not get an unnecessary referral", () => {
  assert.strictEqual(guard.advocateReferral("what is the punishment for theft"), null);
});

console.log("\ncorpus integrity");

test("every provision carries a citation and a verifiable source", () => {
  for (const p of PROVISIONS) {
    assert.ok(p.slug && p.act && p.act_short && p.section && p.title, `incomplete: ${p.slug}`);
    assert.ok(p.summary.length > 40, `summary too thin to be useful: ${p.slug}`);
    assert.ok(p.source_url, `no source to verify against: ${p.slug}`);
    assert.ok(["in_force", "repealed", "partially_in_force"].includes(p.status), p.slug);
  }
});

test("slugs are unique, so re-seeding updates instead of duplicating", () => {
  const slugs = PROVISIONS.map((p) => p.slug);
  assert.strictEqual(new Set(slugs).size, slugs.length);
});

test("the new criminal codes are dated to their commencement", () => {
  const bns = PROVISIONS.filter((p) => ["BNS", "BNSS", "BSA"].includes(p.act_short));
  assert.ok(bns.length > 20, "the new codes must be well covered");
  for (const p of bns) assert.strictEqual(p.effective, "2024-07-01", p.slug);
});

test("every IPC section named in the mapping resolves to a real target", () => {
  for (const [old, to] of Object.entries(guard.REPEALED_MAP)) {
    assert.ok(to.act && to.section && to.title, `incomplete mapping for ${old}`);
    assert.ok(["BNS", "BNSS", "BSA"].includes(to.act), `${old} -> unknown act ${to.act}`);
  }
});

console.log(`\n${passed} passed${process.exitCode ? " — with failures above" : ""}\n`);
