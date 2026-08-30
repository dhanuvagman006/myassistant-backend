/**
 * KNOWLEDGE TESTS — run with `npm run test:knowledge`.
 *
 * No database, no network: the index is built straight from the pack files.
 *
 * Two things are under test. Retrieval QUALITY — does a real question find
 * the right entry — and retrieval COST, which is the reason this engine was
 * rewritten. The cost assertions are the ones that stop a future change
 * quietly reintroducing a per-question API call.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

const assert = require("assert");
const engine = require("../src/knowledge/engine");
const rules = require("../src/knowledge/rules");

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

// Build the index from the packs, exactly as boot does from the database.
const entries = engine.allEntries();
engine._setIndex(engine.buildIndex(entries));

(async () => {
  console.log("\npacks");

  test("all five packs load and every entry is complete", () => {
    const byDomain = {};
    for (const e of entries) {
      byDomain[e.domain] = (byDomain[e.domain] || 0) + 1;
      assert.ok(e.slug && e.domain && e.source_title && e.source_short, `incomplete: ${e.slug}`);
      assert.ok(e.title && e.summary, `no content: ${e.slug}`);
      assert.ok(e.summary.length > 40, `summary too thin: ${e.slug}`);
      assert.ok(engine.DOMAINS.includes(e.domain), `unknown domain: ${e.domain}`);
    }
    for (const d of engine.DOMAINS) {
      assert.ok(byDomain[d] > 0, `pack ${d} contributed nothing`);
    }
    console.log(`      ${entries.length} entries:`,
      engine.DOMAINS.map((d) => `${d}=${byDomain[d]}`).join(" "));
  });

  test("slugs are globally unique across packs", () => {
    const slugs = entries.map((e) => e.slug);
    const dupes = slugs.filter((s, i) => slugs.indexOf(s) !== i);
    assert.deepStrictEqual(dupes, [], `duplicate slugs: ${dupes.join(", ")}`);
  });

  console.log("\nretrieval quality (lexical only — no embeddings in this test)");

  // Each case: question -> a slug that MUST appear in the top results.
  const CASES = [
    ["what is the punishment for cheating", "BNS:318(4)"],
    ["my cheque bounced what do I do", "NIA:138"],
    ["can the police arrest me without telling me why", "BNSS:47"],
    ["how do I file an RTI application", "RTI:6"],
    ["how long do I have to file a consumer complaint", "CPA2019:69"],
    ["how do I update my aadhaar mobile number", "GOVT:aadhaar.update"],
    ["how do I apply for a passport", "GOVT:passport.apply"],
    ["link pan with aadhaar", "GOVT:pan.aadhaar.link"],
    ["when is the last date to file ITR", "MONEY:tax.itr.deadline"],
    ["someone took money from my account through UPI", "MONEY:fraud.upi"],
    ["when can I withdraw my PF", "MONEY:epf.withdraw"],
    ["how do I check my credit score", "MONEY:credit.cibil"],
    ["someone is choking what do I do", "HEALTH:firstaid.choking"],
    ["snake bite first aid", "HEALTH:firstaid.snakebite"],
    ["what is the emergency ambulance number", "HEALTH:emergency.numbers"],
    ["tatkal booking time", "TRAVEL:rail.tatkal"],
    ["airline cancelled my flight", "TRAVEL:air.cancellation"],
    ["train ticket cancellation charges", "TRAVEL:rail.refund"],
    ["what documents to carry while driving", "TRAVEL:road.documents"],
  ];

  for (const [q, expected] of CASES) {
    await atest(`"${q}" -> ${expected}`, async () => {
      const r = await engine.retrieve(q, { limit: 5 });
      const slugs = r.entries.map((e) => e.slug);
      assert.ok(slugs.includes(expected),
        `got [${slugs.join(", ") || "nothing"}]`);
    });
  }

  console.log("\nretrieval cost — the reason this engine exists");

  await atest("a named lookup costs ZERO API calls (no embedding)", async () => {
    for (const q of ["BNS 318", "section 138 NI Act", "tatkal booking", "tele-manas"]) {
      const r = await engine.retrieve(q, { limit: 3 });
      assert.strictEqual(r.usedEmbedding, false,
        `"${q}" fell through to the embedding path`);
      assert.ok(r.entries.length, `"${q}" found nothing`);
    }
  });

  await atest("retrieval is sub-millisecond in process", async () => {
    const t0 = process.hrtime.bigint();
    const N = 200;
    for (let i = 0; i < N; i++) await engine.retrieve("BNS 318 cheating punishment");
    const perCall = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    console.log(`      ${perCall.toFixed(3)} ms per retrieval`);
    // Generous ceiling: the point is that it is in-process, not a network hop.
    assert.ok(perCall < 5, `${perCall.toFixed(3)} ms per call is too slow for a spoken turn`);
  });

  test("adding packs does not add tool declarations", () => {
    const registry = require("../src/tools/registry");
    require("../src/tools/builtins").registerBuiltins();
    const knowledgeTools = registry.list().filter((t) =>
      /knowledge|legal|law|health|tax|travel|govt/i.test(t.name));
    assert.strictEqual(knowledgeTools.length, 1,
      `five domains must cost ONE declaration, got: ${knowledgeTools.map((t) => t.name).join(", ")}`);
    assert.ok(registry.get("consult_knowledge"));
    // The superseded per-domain tools must be gone.
    assert.strictEqual(registry.get("explain_indian_law"), null);
    assert.strictEqual(registry.get("look_up_legal_section"), null);
  });

  await atest("the tool makes no nested model call", async () => {
    // A second LLM round-trip inside the tool was the original latency bug.
    // If one is reintroduced, this call would hang or throw on the missing
    // API key rather than returning promptly with facts.
    const registry = require("../src/tools/registry");
    const t0 = Date.now();
    const res = await registry.execute(
      "consult_knowledge",
      { question: "what is the punishment for cheating", domain: "legal" },
      { userId: 1 }
    );
    const ms = Date.now() - t0;
    assert.strictEqual(res.ok, true);
    assert.ok(res.data.facts && res.data.facts.length, "no facts returned");
    assert.ok(res.data.rules && res.data.rules.length, "no rules returned");
    assert.ok(!res.speak, "the tool must NOT compose the answer itself");
    assert.ok(ms < 250, `${ms} ms suggests a network call crept back in`);
    console.log(`      tool returned in ${ms} ms, ${res.data.facts.length} facts`);
  });

  console.log("\nrules vs live facts");

  await atest("live-fact questions are refused, never answered with law", async () => {
    // The bug this guards: asked for flight timings, the tool matched the
    // travel pack on the word "flight" and pushed the Motor Vehicles Act
    // and railway refund rules onto the user's screen.
    const registry = require("../src/tools/registry");
    for (const q of [
      "flight timings from mangalore to bangalore tomorrow",
      "cheapest flight to delhi",
      "what is the weather tomorrow",
      "is there a train at 6pm",
      "how much does a flight to goa cost",
    ]) {
      const res = await registry.execute("consult_knowledge", { question: q }, { userId: 1 });
      assert.strictEqual(res.ok, false, `should refuse: ${q}`);
      assert.ok(/live-facts/i.test(res.error), `${q} -> ${res.error}`);
      // And crucially NO citations, or the overlay appears anyway.
      assert.ok(!res.deviceAction, `must not push citations for: ${q}`);
    }
  });

  await atest("rules questions still answer, even when they mention travel", async () => {
    const registry = require("../src/tools/registry");
    for (const q of [
      "what are the train ticket cancellation charges",
      "my flight was cancelled what are my rights",
      "what documents to carry while driving",
      "tatkal booking time",
      "how do I apply for a passport",
    ]) {
      const res = await registry.execute("consult_knowledge", { question: q }, { userId: 1 });
      assert.ok(!(res.ok === false && /live-facts/i.test(res.error || "")),
        `wrongly refused: ${q}`);
    }
  });

  console.log("\ngrounding and boundaries");

  await atest("an unknown question returns nothing and forbids improvising", async () => {
    const registry = require("../src/tools/registry");
    const res = await registry.execute(
      "consult_knowledge",
      { question: "what is the capital gains treatment of a Liechtenstein trust" },
      { userId: 1 }
    );
    assert.strictEqual(res.data.found, 0);
    assert.ok(res.data.rules.some((r) => /do not answer from your own knowledge/i.test(r)),
      "must forbid answering from memory");
    assert.ok(!res.speak);
  });

  await atest("an old IPC citation is corrected in the tool result", async () => {
    const registry = require("../src/tools/registry");
    const res = await registry.execute(
      "consult_knowledge",
      { question: "can I file a 420 IPC case against him" },
      { userId: 1 }
    );
    assert.ok(res.data.corrections, "no correction produced");
    assert.ok(res.data.corrections.some((c) => /BNS 318\(4\)/.test(c)),
      res.data.corrections.join(" | "));
  });

  test("the health pack forbids diagnosis and dosing", () => {
    const r = rules.rulesFor("health");
    assert.ok(r.some((x) => /NEVER diagnose/i.test(x)));
    assert.ok(r.some((x) => /never give a medicine or a dose/i.test(x)));
  });

  test("no health entry states a dose", () => {
    // The boundary entry is exempt: it is the one that SAYS never to give a
    // dose, so the word appearing there is the rule, not a violation.
    const health = entries.filter(
      (e) => e.domain === "health" && e.slug !== "HEALTH:boundary");
    const DOSE = /\b\d+\s?(mg|ml|mcg|g)\b|\btablets?\b|\bdoses?\b/i;
    for (const e of health) {
      const text = `${e.summary} ${e.detail}`;
      assert.ok(!DOSE.test(text), `dose-like text in ${e.slug}: ${text.match(DOSE)}`);
    }
  });

  test("money entries that state a slab name their financial year", () => {
    // Only entries that actually state SLABS or RATES need a year — a late
    // fee or a penalty figure is not year-sensitive in the same way.
    const slabs = entries.filter(
      (e) => e.domain === "money" && /\bslabs?\b|\brates?\b/i.test(e.summary));
    for (const e of slabs) {
      const text = `${e.summary} ${e.detail}`;
      assert.ok(/FY \d{4}-\d{2}|FINANCIAL YEAR|financial year|each Budget|revised in the Union Budget/i.test(text),
        `undated figure in ${e.slug}`);
    }
  });

  test("every domain has a closing line and its own rules", () => {
    for (const d of engine.DOMAINS) {
      assert.ok(rules.CLOSERS[d], `no closer for ${d}`);
      assert.ok(rules.rulesFor(d).length > rules.COMMON.length, `no specific rules for ${d}`);
    }
  });

  console.log(`\n${passed} passed${process.exitCode ? " — with failures above" : ""}\n`);
})();
