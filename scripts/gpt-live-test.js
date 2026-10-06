/**
 * GPT-LIVE SESSION CONFIG (ai/gptLive.js, 2026-10-06) — pure, no network.
 * Run: `npm run test:gptlive` or `node scripts/gpt-live-test.js`.
 *
 * Pins: the opening line by the user's gender; a natural voice, never an
 * unknown one; the delegated backend on a low-cost model with every tool
 * the phone sent (non-strict, deduplicated, capped, web search exactly
 * once); the voice instruction carrying the title and the delegation policy;
 * GET /ai/config's gpt-live block on natural voices and a short standby, prewarm on.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@127.0.0.1:56432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
const assert = require("assert");
const g = require("../src/ai/gptLive");

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

const profile = (gender, voice = "") => ({ user: { gender, name: "Hariraj" }, assistant: { name: "Hari", voice } });
const tool = (name, extra = {}) => ({
  name, description: `${name} tool`,
  parameters: { type: "OBJECT", properties: { q: { type: "STRING" } }, required: ["q", "gone"] }, ...extra,
});

test("opening is Hello Sir for male, unknown and other", () => {
  for (const gender of ["male", "", null, "other"]) {
    assert.strictEqual(g.sessionConfig({ profile: profile(gender) }).opening, "Hello Sir");
  }
});

test("opening is Hello Madam for female", () => {
  const out = g.sessionConfig({ profile: profile("Female") });
  assert.strictEqual(out.opening, "Hello Madam");
  assert.match(out.session.instructions, /"Madam"/);
  assert.match(g.openingInstruction(out.opening), /Say exactly "Hello Madam\."/);
});

test("the name is never used for addressing", () => {
  const { session } = g.sessionConfig({ profile: profile("male") });
  assert.match(session.instructions, /Never call them by their name/);
  assert.ok(!session.instructions.includes("Hariraj"));
});

test("voice: the phone's pick when valid, else the profile's, else gleam", () => {
  assert.strictEqual(g.sessionConfig({ profile: profile("male"), voice: "Meridian" }).voice, "meridian");
  assert.strictEqual(g.sessionConfig({ profile: profile("male", "marin"), voice: "Kore" }).voice, "marin");
  assert.strictEqual(g.sessionConfig({ profile: profile("male", "Charon") }).voice, "gleam");
  assert.strictEqual(g.sessionConfig({}).session.audio.output.voice, "gleam");
});

test("three voices offered; a retired pick becomes the offered one of its gender", () => {
  assert.deepStrictEqual(g.NATURAL_VOICES, ["gleam", "marin", "meridian"]);
  for (const male of ["tempo", "cedar", "stone", "vesper", "ripple"]) assert.strictEqual(g.voiceFor(male), "meridian", male);
  for (const female of ["willow", "bossa", "coral", "shimmer"]) assert.strictEqual(g.voiceFor(female), "gleam", female);
  assert.strictEqual(g.voiceFor("", "tempo"), "meridian");
  assert.strictEqual(g.voiceFor("nonsense"), "gleam");
});

test("the default and every natural voice are gpt-live-1 voices", () => {
  assert.ok(g.LIVE_VOICE_IDS.has(g.DEFAULT_VOICE));
  for (const v of g.NATURAL_VOICES) assert.ok(g.LIVE_VOICE_IDS.has(v), v);
  for (const generated of ["delta", "cinder", "beacon", "quartz"]) assert.ok(!g.NATURAL_VOICES.includes(generated));
});

test("delegation: Responses on gpt-6-luna, low reasoning, parallel tools", () => {
  const saved = { m: process.env.GPT_LIVE_DELEGATE_MODEL, r: process.env.GPT_LIVE_DELEGATE_REASONING };
  delete process.env.GPT_LIVE_DELEGATE_MODEL;
  delete process.env.GPT_LIVE_DELEGATE_REASONING;
  try {
    const d = g.sessionConfig({ tools: [tool("set_alarm")] }).session.delegation;
    assert.strictEqual(d.type, "responses");
    assert.strictEqual(d.responses.model, "gpt-6-luna");
    assert.deepStrictEqual(d.responses.reasoning, { effort: "low" });
    assert.strictEqual(d.responses.parallel_tool_calls, true);
    assert.strictEqual(d.responses.max_output_tokens, 1024);
    process.env.GPT_LIVE_DELEGATE_MODEL = "gpt-5.4-nano";
    process.env.GPT_LIVE_DELEGATE_REASONING = "bogus";
    const o = g.sessionConfig({}).session.delegation.responses;
    assert.strictEqual(o.model, "gpt-5.4-nano");
    assert.strictEqual(o.reasoning.effort, "low");
  } finally {
    if (saved.m === undefined) delete process.env.GPT_LIVE_DELEGATE_MODEL; else process.env.GPT_LIVE_DELEGATE_MODEL = saved.m;
    if (saved.r === undefined) delete process.env.GPT_LIVE_DELEGATE_REASONING; else process.env.GPT_LIVE_DELEGATE_REASONING = saved.r;
  }
});

test("tools: every phone tool, non-strict, lowercase schema, valid required", () => {
  const tools = g.toolsFor([tool("set_alarm"), tool("create_reminder")]);
  assert.deepStrictEqual(tools[0], { type: "web_search" });
  const fn = tools[1];
  assert.strictEqual(fn.type, "function");
  assert.strictEqual(fn.strict, false);
  assert.strictEqual(fn.parameters.type, "object");
  assert.strictEqual(fn.parameters.properties.q.type, "string");
  assert.deepStrictEqual(fn.parameters.required, ["q"]);
  assert.strictEqual(tools.length, 3);
});

test("tools: OpenAI's own web search first; the app's web_search and stay_silent left out", () => {
  const tools = g.toolsFor([tool("web_search"), tool("stay_silent"), tool("get_weather")]);
  assert.deepStrictEqual(tools[0], { type: "web_search" });
  assert.deepStrictEqual(tools.slice(1).map((t) => t.name), ["get_weather"]);
});

test("tools: bad names and duplicates dropped, capped in the phone's order", () => {
  const raw = [tool("ok_1"), tool("ok_1"), tool("bad name"), { name: "" }, null, ...Array.from({ length: g.MAX_TOOLS + 50 }, (_, i) => tool(`t_${i}`))];
  const fns = g.toolsFor(raw).filter((t) => t.type === "function");
  assert.strictEqual(fns.length, g.MAX_TOOLS);
  assert.strictEqual(fns[0].name, "ok_1");
  assert.strictEqual(new Set(fns.map((t) => t.name)).size, fns.length);
});

test("the voice prompt lists the backend's tools and stays under its limit", () => {
  const many = Array.from({ length: 128 }, (_, i) => tool(`some_long_tool_name_${i}`));
  const { session } = g.sessionConfig({ profile: profile("male"), tools: many, instructions: "x".repeat(200000) });
  assert.match(session.instructions, /Delegation policy/);
  assert.match(session.instructions, /some_long_tool_name_127/);
  // 16,384 tokens is the cap; ~4 chars a token keeps a wide margin.
  assert.ok(session.instructions.length < 16384 * 2, `${session.instructions.length} chars`);
  assert.ok(session.delegation.responses.instructions.length <= 62000);
});

(async () => {
  const saved = { GPT_LIVE: process.env.GPT_LIVE, GPT_LIVE_IDLE_SEC: process.env.GPT_LIVE_IDLE_SEC };
  try {
    process.env.GPT_LIVE = "on";
    delete process.env.GPT_LIVE_IDLE_SEC;
    const config = require("../src/ai/config");
    assert.strictEqual(config.gptLiveOn(), true);
    const out = await config.forUser(1, { build: 200 });
    if (!out.live || out.live.transport !== "gpt-live") {
      console.log("  --  GET /ai/config gpt-live block (provider is not openai here: skipped)");
    } else {
      assert.ok(g.NATURAL_VOICES.includes(out.live.voice), out.live.voice);
      assert.deepStrictEqual(out.live.voices, g.NATURAL_VOICES);
      assert.strictEqual(out.live.idleCloseSec, 60);
      assert.strictEqual(out.live.prewarm, true);
      passed++;
      console.log("  ok  GET /ai/config: gpt-live on natural voices, short standby, prewarm on");
    }
  } catch (e) {
    console.error(`  FAIL GET /ai/config gpt-live block\n       ${e.message}`);
    process.exitCode = 1;
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  console.log(`gpt-live: ${passed} passed`);
  process.exit(process.exitCode || 0);
})();