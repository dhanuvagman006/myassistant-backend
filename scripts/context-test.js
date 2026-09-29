/**
 * THE PHONE'S CONTEXT — calls, location, silence. `node scripts/context-test.js`
 *
 * Owner, 2026-09-24: "the calls should be connected — it should report when
 * we have any missed calls, or any info if user asks about calls", "my
 * assistant should be aware of user location when he makes any requests",
 * and "don't send silent packets to my agent, trim it".
 *
 * No network: the geocoder and the search are scripted. The app's
 * conversation is driven through the real /ai routes (src/ai/): the Live
 * socket these once drove is gone (2026-09-29), and with it the checks on
 * its audio pauses and mid-call place notes — every turn now carries the
 * phone's place and clock itself.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@127.0.0.1:55432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-key-never-sent";
process.env.LIVE_RECORD = "0";

const assert = require("assert");
const fs = require("fs");


let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
}
const tick = () => new Promise((r) => setTimeout(r, 10));
async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await tick(); }
  throw new Error("timed out waiting");
}

(async () => {
  const db = require("../src/db");
  await db.init();
  const runtime = require("../src/agents/runtime"); // registers the builtins
  const registry = require("../src/tools/registry");
  registry.seal();
  const builtins = require("../src/tools/builtins");
  const geo = require("../src/users/whereNow");
  const claimCheck = require("../src/agents/claimCheck");

  // Scripted places, by latitude.
  builtins.reverseGeocode = async (lat) => {
    if (lat > 13.3 && lat < 13.4) return { address: "Manipal, Udupi, Karnataka", area: "Manipal", city: "Udupi" };
    if (lat > 12.86 && lat < 12.88) return { address: "Kadri, Mangaluru, Karnataka", area: "Kadri", city: "Mangaluru" };
    if (lat > 12.9 && lat < 13.0) return { address: "Koramangala, Bengaluru", area: "Koramangala", city: "Bengaluru" };
    return null;
  };
  const asked = [];
  require("../src/tools/webSearch").run = async (q) => {
    asked.push(q);
    return { ok: true, provider: "brave", data: [{ title: "A hotel", snippet: "", url: "https://example.test/" }] };
  };

  const CAPS = (build, platform = "android") => ({ platform, build, granted: [], denied: [] });

  /* ================================ CALLS ================================ */

  await t("phone_calls asks the phone and never states a result itself", async () => {
    const tool = registry.get("phone_calls");
    assert.ok(tool, "phone_calls is registered");
    assert.strictEqual(tool.minAppBuild, 107);
    assert.strictEqual(tool.deviceAction, true);
    assert.strictEqual(tool.risk, "low");
    const r = await registry.execute("phone_calls", { filter: "missed" },
      { platform: "android", deviceCaps: CAPS(107) });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.deviceAction,
      { type: "call_log", filter: "missed", person: "", since_hours: 24, limit: 10 });
    assert.strictEqual(r.speak, "Checking your calls.");
    assert.match(r.note, /never guess/);
    assert.ok(!/\b(no|missed \d|called you)\b/i.test(r.speak), "the sentence claims nothing");
  });

  await t("phone_calls arguments are tidied, never refused", async () => {
    const run = (a) => registry.get("phone_calls").execute(a, {}).then((r) => r.deviceAction);
    assert.strictEqual((await run({ filter: "yesterday" })).filter, "all", "an unknown filter is 'all'");
    assert.strictEqual((await run({})).filter, "all");
    assert.strictEqual((await run({ filter: "Incoming" })).filter, "incoming");
    assert.strictEqual((await run({ person: "  my  Mom " })).person, "Mom");
    assert.strictEqual((await run({ person: "anyone" })).person, "", "'anyone' is no filter");
    assert.strictEqual((await run({ person: "98450 12345" })).person, "98450 12345");
    assert.strictEqual((await run({ since_hours: 5000 })).since_hours, 720, "at most 30 days");
    assert.strictEqual((await run({ since_hours: -3 })).since_hours, 24);
    assert.strictEqual((await run({ since_hours: 0.2 })).since_hours, 1);
    assert.strictEqual((await run({ since_hours: 168 })).since_hours, 168);
    assert.strictEqual((await run({ limit: 0 })).limit, 10);
    assert.strictEqual((await run({ limit: 99 })).limit, 50);
    assert.strictEqual((await run({ limit: 3.7 })).limit, 3);
  });

  await t("build 105/106 phones are neither offered nor handed phone_calls", async () => {
    const r = await registry.execute("phone_calls", { filter: "missed" },
      { platform: "android", deviceCaps: CAPS(106) });
    assert.strictEqual(r.ok, false);
    assert.ok(!r.deviceAction, "an old app would drop it after 'checking'");
    const has = (caps) => registry.declarations({ deviceCaps: caps }).some((d) => d.name === "phone_calls");
    assert.strictEqual(has(CAPS(106)), false);
    assert.strictEqual(has(CAPS(105)), false);
    assert.strictEqual(has(CAPS(107)), true);
    assert.match(registry.limitsBlock(CAPS(106)), /too old for: [^\n]*phone_calls/);
  });

  await t("android only, and never from a scheduled task", async () => {
    const has = registry.declarations({ deviceCaps: CAPS(107, "ios") }).some((d) => d.name === "phone_calls");
    assert.strictEqual(has, false, "an iPhone cannot read its call log");
    const ios = await registry.execute("phone_calls", {}, { platform: "ios", deviceCaps: CAPS(107, "ios") });
    assert.strictEqual(ios.ok, false);
    const bg = await registry.execute("phone_calls", {}, {
      platform: "android", deviceCaps: CAPS(107), background: true,
    });
    assert.strictEqual(bg.ok, false, "nobody is holding the phone");
    assert.strictEqual(registry.describe("phone_calls").unattendedEffective, false);
  });

  await t("every turn is offered phone_calls", async () => {
    const rel = require("../src/tools/relevance");
    assert.ok(rel.CORE.has("phone_calls"));
    const picked = rel.selectForTurn(registry.list(), "did Ravi call me today?", { sessionId: "ctx-test" });
    assert.ok(!picked || picked.includes("phone_calls"));
  });

  await t("'Ravi was calling you' is call history, not a false claim to have dialled", async () => {
    for (const said of [
      "Ravi Kumar was calling you at 3:10 pm.",
      "Your mom tried calling you twice this morning.",
      "Amma has been calling since nine.",
    ]) {
      const v = claimCheck.check(said, []);
      assert.strictEqual(v.ok, true, `"${said}" was rewritten: ${v.violations.join("; ")}`);
    }
    for (const said of ["Calling Ravi now.", "I'm calling him for you.", "Dialling Amma."]) {
      assert.strictEqual(claimCheck.check(said, []).ok, false, `"${said}" must still be caught`);
    }
  });

  await t("'I tried calling Ravi' is still the assistant's own claim when nothing was dialled", async () => {
    // The first exemption keyed on the auxiliary alone, so these passed
    // with place_phone_call never having run.
    for (const said of [
      "I tried calling Ravi but he didn't pick up.",
      "I was calling Ravi just now.",
      "I have been calling him.",
      "I've been calling him all morning.",
      "I kept ringing him.",
      "We just tried ringing him twice.",
      "Tried calling him, no answer.",
      "Ravi was calling you, so I'm calling him back now.",
      // An adverb the list does not know must not turn "I" into a third party.
      "I only kept calling him.",
      "I have honestly been calling him.",
      // The assistant's own call described through the phone or the line.
      "It was ringing but he didn't answer.",
      "His phone kept ringing.",
      // No subject at all is the speaker's, even with "you" after it.
      "Ringing you through to Ravi now.",
      // "Okay Sir" is how she opens a sentence, not who is calling.
      "Okay Sir calling you back in a minute.",
      "Sure ma'am ringing you now.",
    ]) {
      const v = claimCheck.check(said, []);
      assert.strictEqual(v.ok, false, `"${said}" must be caught`);
      assert.match(v.text, /nothing was dialled/);
      assert.strictEqual(claimCheck.classify(said), "call", `stream gate must hold "${said}"`);
    }
    // The same words stand once the call really ran.
    assert.strictEqual(claimCheck.check("I tried calling Ravi but he didn't pick up.",
      [{ tool: "place_phone_call", ok: true }]).ok, true);
    // Third-party readings stay call history.
    for (const said of [
      "I see Amma has been calling since nine.",
      "Looks like Ravi kept ringing you.",
      "You were calling Ravi at 5:02 pm.",
      "Sir, Ravi’s been calling you all morning.",
      "I checked: Ravi was calling you at 3.",
    ]) {
      assert.strictEqual(claimCheck.check(said, []).ok, true, `"${said}" was rewritten`);
      assert.strictEqual(claimCheck.classify(said), null);
    }
  });

  await t("chat prompt: build 107 routes calls questions to phone_calls, older builds keep the old rule", async () => {
    const p107 = runtime.systemPrompt("", { appBuild: 107 });
    assert.match(p107, /CALLS ON THIS PHONE: 'any missed calls\?'[^\n]*→ phone_calls/);
    assert.match(p107, /Never guess call history/);
    assert.ok(!/you cannot see the phone's missed or recent calls/.test(p107), "the temporary line is replaced");
    for (const p of [runtime.systemPrompt("", { appBuild: 106 }), runtime.systemPrompt("")]) {
      assert.match(p, /CALL HISTORY: you cannot see the phone's missed or recent calls/);
      assert.ok(!/CALLS ON THIS PHONE/.test(p));
    }
    const src = fs.readFileSync(__dirname + "/../src/agents/runtime.js", "utf8");
    assert.ok((src.match(/systemPrompt\(ctx\.extraSystem \|\| "", \{ appBuild: ctx\.appBuild \}\)/g) || []).length >= 2,
      "both model calls pass the phone's build");
  });

  /* =============================== LOCATION =============================== */

  await t("WHERE THE OWNER IS NOW carries area, city, coordinates and the time of the fix", async () => {
    const at = Date.UTC(2026, 8, 24, 9, 40); // 15:10 in India
    const line = await geo.whereLine(12.9352, 77.6245, { tzOffsetMin: 330, at });
    assert.ok(line.startsWith(
      'WHERE THE OWNER IS NOW: Koramangala, Bengaluru (12.9352,77.6245, updated 15:10). ' +
      'Use it for anything "near me", weather, rides, local time/search — never ask which city ' +
      "when this is known."), line);
    assert.match(await geo.whereLine(12.9352, 77.6245, { at }), /updated 15:10/, "no timezone means India");
    assert.match(await geo.whereLine(12.9352, 77.6245, { tzOffsetMin: null, at }), /updated 15:10/,
      "a null timezone is not UTC");
    assert.strictEqual(await geo.whereLine(null, null), "", "unknown: nothing about location");
    assert.strictEqual(await geo.whereLine(0, 0), "");
  });

  await t("a failed place lookup is retried after two minutes, not half an hour", async () => {
    let fail = true;
    const look = async () => { if (fail) throw new Error("blip"); return { area: "Kadri", city: "Mangaluru" }; };
    assert.strictEqual(await geo.whereNow(12.8801, 74.8801, { geocode: look }), null);
    fail = false;
    assert.strictEqual(await geo.whereNow(12.8801, 74.8801, { geocode: look }), null, "a miss is cached briefly");
    const realNow = Date.now;
    Date.now = () => realNow() + 3 * 60_000;
    try {
      const w = await geo.whereNow(12.8801, 74.8801, { geocode: look });
      assert.strictEqual(w && w.label, "Kadri, Mangaluru");
    } finally { Date.now = realNow; }
  });

  await t("only a different area counts as a move", async () => {
    assert.strictEqual(geo.areaChanged("Kadri, Mangaluru", "Kadri, Mangaluru"), false);
    assert.strictEqual(geo.areaChanged("Kadri, Mangaluru", "kadri,  mangaluru"), false);
    assert.strictEqual(geo.areaChanged("Kadri, Mangaluru", "Hampankatta, Mangaluru"), true);
    assert.strictEqual(geo.areaChanged("", "Kadri, Mangaluru"), true, "the first known place is news");
    assert.strictEqual(geo.areaChanged("Kadri, Mangaluru", ""), false, "a failed lookup is not a move");
    assert.strictEqual(geo.areaChanged("ಕದ್ರಿ, ಮಂಗಳೂರು", "ಕದ್ರಿ, ಮಂಗಳೂರು"), false, "any script");
    assert.strictEqual(geo.areaChanged("Kadri, Mangaluru", "ಕದ್ರಿ, ಮಂಗಳೂರು"), true);
  });

  await t("chat and spoken prompts carry the line with the owner's clock", async () => {
    const u = await db.createUser({ email: `where-${Date.now()}@example.test`, name: "Test Owner", gender: "male" });
    try {
      const at = Date.UTC(2026, 8, 24, 9, 40);
      const block = await require("../src/users/context").contextBlock(u.id, { lat: 12.9352, lng: 77.6245, tz: 330, at });
      assert.match(block, /WHERE THE OWNER IS NOW: Koramangala, Bengaluru \(12\.9352,77\.6245, updated 15:10\)/);
      const none = await require("../src/users/context").contextBlock(u.id, {});
      assert.ok(!/WHERE THE OWNER IS NOW/.test(none), "no fix, no line");
    } finally {
      await db.run(`DELETE FROM users WHERE id=$1`, [u.id]);
    }
    const rt = fs.readFileSync(__dirname + "/../src/agents/runtime.js", "utf8");
    // (appBuild since shortcuts, 2026-09-27: the shortcut names are listed from build 120.)
    assert.match(rt, /contextBlock\(ctx\.userId, \{ lat: ctx\.lat, lng: ctx\.lng, tz: ctx\.tzOffsetMin(, appBuild: ctx\.appBuild)? \}\)/);
    const ai = fs.readFileSync(__dirname + "/../src/ai/context.js", "utf8");
    assert.match(ai, /lat: fix\.lat, lng: fix\.lng, tz, at: fix\.at, appBuild: build/);
  });

  /* ======================= THE APP'S CONVERSATION (/ai) ======================= */
  // Until 2026-09-29 these drove the Live socket. The app runs its own
  // models now and asks this server for each turn's context and tools
  // (src/ai/): the phone's build, clock and place ride on POST /ai/context.

  const express = require("express");
  const app = express();
  app.use(express.json());
  let AS = 0;
  app.use((req, _res, next) => { req.user = { sub: String(AS) }; next(); });
  app.use("/ai", require("../src/ai/routes"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const BASE = `http://127.0.0.1:${server.address().port}/ai`;
  const post = async (p, body) => {
    const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return r.json();
  };
  const owner = await db.createUser({ email: `ctx-ai-${Date.now()}@example.test`, name: "Test Owner", gender: "male" });
  AS = owner.id;
  const turnAt = (body) => post("/context", { text: "hello", mode: "voice", platform: "android", ...body });
  const toolIn = (c, name, args) => post("/tool", { sessionId: c.sessionId, turnId: c.turnId, name, args, userText: "please" });

  await t("spoken prompt: build 107 gets phone_calls and its rule, build 106 keeps today's", async () => {
    const s107 = await turnAt({ build: 107, tz: 330 });
    assert.match(s107.system, /CALLS ON THIS PHONE: 'any missed calls\?'[^.]*→ phone_calls/);
    assert.ok(!/you cannot see the phone's missed or recent calls/.test(s107.system));
    assert.ok(s107.tools.some((d) => d.name === "phone_calls"));
    const s106 = await turnAt({ build: 106, tz: 330 });
    assert.match(s106.system, /CALL HISTORY: you cannot see the phone's missed or recent calls/);
    assert.ok(!/CALLS ON THIS PHONE/.test(s106.system));
    assert.ok(!s106.tools.some((d) => d.name === "phone_calls"));
  });

  await t("the call-log request reaches the phone with its fixed sentence", async () => {
    const c = await turnAt({ text: "any missed calls from Ravi?", build: 107, tz: 330 });
    const res = await toolIn(c, "phone_calls", { filter: "missed", person: "Ravi" });
    assert.strictEqual(res.result.result, "Checking your calls.");
    assert.match(res.result.note, /\[SYSTEM\] line/);
    assert.deepStrictEqual(res.deviceAction, { type: "call_log", filter: "missed", person: "Ravi", since_hours: 24, limit: 10 });
  });

  await t("a missing fix or timezone is absent, not 0", async () => {
    const c = await turnAt({ text: "find a chemist near me", build: 107 });
    // Number(null) is 0: no tz used to mean UTC, five and a half hours out.
    assert.match(c.system, /\(UTC\+05:30\)/);
    assert.ok(!/WHERE THE OWNER IS NOW/.test(c.system), "no fix, no line");
    asked.length = 0;
    // ...and no fix used to be 0,0, which "near me" then searched around.
    const res = await toolIn(c, "find_places_nearby", { query: "chemist", open_map: false });
    assert.strictEqual(res.ok, false, JSON.stringify(res));
    assert.strictEqual(res.error, "no_location");
    assert.strictEqual(asked.length, 0, "nothing searched around the Gulf of Guinea");
  });

  await t("location: tools use the new fix at once, and the next turn says where they are now", async () => {
    const c1 = await turnAt({ build: 107, tz: 330, lat: 12.8700, lng: 74.8600, acc: 20 });
    assert.match(c1.system, /WHERE THE OWNER IS NOW: Kadri, Mangaluru/);
    // Nonsense is ignored: the session keeps the fix it had.
    const junk = await turnAt({ sessionId: c1.sessionId, build: 107, tz: 330, lat: 0, lng: 0 });
    assert.match(junk.system, /WHERE THE OWNER IS NOW: Kadri, Mangaluru/);
    const c2 = await turnAt({ sessionId: c1.sessionId, build: 107, tz: 330, lat: 13.3525, lng: 74.7928, acc: 15 });
    assert.strictEqual(c2.sessionId, c1.sessionId);
    assert.match(c2.system, /WHERE THE OWNER IS NOW: Manipal, Udupi/);
    asked.length = 0;
    await toolIn(c2, "web_search", { query: "hotel address" });
    assert.strictEqual(asked[0], "hotel address Udupi", "the search uses where they are NOW");
  });

  await t("location: a coarse fix moves the tools but not the model's picture of the area", async () => {
    const c1 = await turnAt({ build: 107, tz: 330, lat: 12.8700, lng: 74.8600, acc: 20 });
    const c2 = await turnAt({ sessionId: c1.sessionId, build: 107, tz: 330, lat: 13.3525, lng: 74.7928, acc: 5000 });
    assert.match(c2.system, /WHERE THE OWNER IS NOW: Kadri, Mangaluru/);
    assert.ok(!/Manipal/.test(c2.system));
    asked.length = 0;
    await toolIn(c2, "web_search", { query: "hotel address" });
    assert.strictEqual(asked[0], "hotel address Udupi");
  });

  await t("location: a session that started without a fix is told the first place", async () => {
    const c1 = await turnAt({ build: 107, tz: 330 });
    assert.ok(!/WHERE THE OWNER IS NOW/.test(c1.system));
    const c2 = await turnAt({ sessionId: c1.sessionId, build: 107, tz: 330, lat: 12.8700, lng: 74.8600, acc: 30 });
    assert.match(c2.system, /WHERE THE OWNER IS NOW: Kadri, Mangaluru/);
  });

  server.close();
  await require("../src/routes/privacy").deleteUserEverywhere(owner.id, { reason: "context-test cleanup" }).catch(() => {});

  console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
