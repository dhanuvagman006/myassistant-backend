/**
 * THE PHONE'S CONTEXT — calls, location, silence. `node scripts/context-test.js`
 *
 * Owner, 2026-09-24: "the calls should be connected — it should report when
 * we have any missed calls, or any info if user asks about calls", "my
 * assistant should be aware of user location when he makes any requests",
 * and "don't send silent packets to my agent, trim it".
 *
 * No network: the geocoder and the search are scripted, and the live model
 * is a fake socket whose every message is read back.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@127.0.0.1:55432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
// The live socket's own auth tier for a dev session, so no token is needed.
process.env.AUTH_DISABLED = "true";
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-key-never-sent";
process.env.LIVE_RECORD = "0";

const assert = require("assert");
const EventEmitter = require("events");
const fs = require("fs");

/* ---- a fake Gemini Live socket, installed before the proxy loads ---- */
const ups = [];
const apps = [];
class FakeUpstream extends EventEmitter {
  constructor(url) { super(); this.url = url; this.readyState = 1; this.sent = []; ups.push(this); }
  send(d) { this.sent.push(JSON.parse(String(d))); }
  close() { this.readyState = 3; }
}
FakeUpstream.OPEN = 1;
class FakeApp extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.out = []; }
  send(d) { this.out.push(Buffer.isBuffer(d) ? { audio: d.length } : JSON.parse(String(d))); }
  close() { this.readyState = 3; }
}
FakeUpstream.Server = class {
  handleUpgrade(_req, _socket, _head, cb) { const a = new FakeApp(); apps.push(a); cb(a); }
};
const wsPath = require.resolve("ws");
require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: FakeUpstream };

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
  const proxy = require("../src/live/proxy");

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

  await t("chat and live prompts carry the line with the owner's clock", async () => {
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
    assert.match(rt, /contextBlock\(ctx\.userId, \{ lat: ctx\.lat, lng: ctx\.lng, tz: ctx\.tzOffsetMin \}\)/);
    const px = fs.readFileSync(__dirname + "/../src/live/proxy.js", "utf8");
    assert.match(px, /lat: deviceCtx\.lat, lng: deviceCtx\.lng, tz: deviceCtx\.tz, at: deviceCtx\.locAt/);
  });

  /* ============================ THE LIVE SOCKET ============================ */

  async function openLive(query) {
    const server = new EventEmitter();
    proxy.attachWs(server);
    const nUp = ups.length;
    const socket = { destroyed: false, on() {}, write() {}, destroy() { this.destroyed = true; } };
    server.emit("upgrade", { url: `/live/ws?${query}` }, socket, Buffer.alloc(0));
    await waitFor(() => ups.length > nUp);
    const up = ups[ups.length - 1];
    const app = apps[apps.length - 1];
    up.emit("open");
    await waitFor(() => up.sent.some((m) => m.setup));
    const setup = up.sent.find((m) => m.setup).setup;
    return {
      up, app, setup,
      ready: async () => {
        up.emit("message", Buffer.from(JSON.stringify({ setupComplete: {} })));
        await waitFor(() => app.out.some((m) => m.type === "ready"));
      },
      say: (m) => app.emit("message", Buffer.from(JSON.stringify(m)), false),
      audio: () => app.emit("message", Buffer.alloc(640, 1), true),
      model: (msg) => up.emit("message", Buffer.from(JSON.stringify(msg))),
      notes: () => up.sent.filter((m) => m.clientContent &&
        /The owner is now in/.test(m.clientContent.turns[0].parts[0].text)),
    };
  }
  // Calls a tool the way Gemini would, and returns what went back to it.
  async function toolCall(s, name, args) {
    const id = `c${Math.random()}`;
    s.model({ toolCall: { functionCalls: [{ id, name, args }] } });
    await waitFor(() => s.up.sent.some((m) => m.toolResponse &&
      m.toolResponse.functionResponses.some((r) => r.id === id)));
    s.model({ serverContent: { turnComplete: true } }); // the turn ends
    return s.up.sent.find((m) => m.toolResponse && m.toolResponse.functionResponses.some((r) => r.id === id))
      .toolResponse.functionResponses.find((r) => r.id === id).response;
  }

  await t("live prompt: build 107 gets phone_calls and its rule, build 106 keeps today's", async () => {
    const s107 = await openLive("build=107&platform=android&tz=330");
    const p107 = s107.setup.systemInstruction.parts[0].text;
    assert.match(p107, /CALLS ON THIS PHONE: 'any missed calls\?'[^.]*→ phone_calls/);
    assert.ok(!/you cannot see the phone's missed or recent calls/.test(p107));
    assert.ok(s107.setup.tools[0].functionDeclarations.some((d) => d.name === "phone_calls"));
    const s106 = await openLive("build=106&platform=android&tz=330");
    const p106 = s106.setup.systemInstruction.parts[0].text;
    assert.match(p106, /CALL HISTORY: you cannot see the phone's missed or recent calls/);
    assert.ok(!/CALLS ON THIS PHONE/.test(p106));
    assert.ok(!s106.setup.tools[0].functionDeclarations.some((d) => d.name === "phone_calls"));
  });

  await t("live: the call-log request reaches the phone with its fixed sentence", async () => {
    const s = await openLive("build=107&platform=android&tz=330");
    await s.ready();
    const res = await toolCall(s, "phone_calls", { filter: "missed", person: "Ravi" });
    assert.strictEqual(res.result, "Checking your calls.");
    assert.match(res.note, /\[SYSTEM\] line/);
    const sent = s.app.out.find((m) => m.type === "call_log");
    assert.deepStrictEqual(sent, { type: "call_log", filter: "missed", person: "Ravi", since_hours: 24, limit: 10 });
  });

  await t("audio_pause ends the audio stream once; the next frame resumes it", async () => {
    const s = await openLive("build=107&platform=android");
    s.say({ type: "audio_pause" }); // before setup: nothing to end yet
    await tick();
    assert.ok(!s.up.sent.some((m) => m.realtimeInput && m.realtimeInput.audioStreamEnd));
    await s.ready();
    s.audio();
    s.say({ type: "audio_pause" });
    await tick();
    const ends = s.up.sent.filter((m) => m.realtimeInput && m.realtimeInput.audioStreamEnd === true);
    assert.strictEqual(ends.length, 1);
    const before = s.up.sent.length;
    s.audio();
    await tick();
    const next = s.up.sent.slice(before);
    assert.strictEqual(next.length, 1);
    assert.strictEqual(next[0].realtimeInput.audio.mimeType, "audio/pcm;rate=16000", "audio resumes as normal");
  });

  await t("a missing fix or timezone on the socket URL is absent, not 0", async () => {
    const s = await openLive("build=107&platform=android");
    // Number(null) is 0: no tz used to mean UTC, five and a half hours out.
    assert.match(s.setup.systemInstruction.parts[0].text, /\(UTC\+05:30\)/);
    await s.ready();
    asked.length = 0;
    // ...and no fix used to be 0,0, which "near me" then searched around.
    const res = await toolCall(s, "find_places_nearby", { query: "chemist", open_map: false });
    assert.strictEqual(res.ok, false, JSON.stringify(res));
    assert.strictEqual(res.error, "no_location");
    assert.strictEqual(asked.length, 0, "nothing searched around the Gulf of Guinea");
  });

  await t("live location: tools use the new fix at once; one quiet note when the area changes", async () => {
    const s = await openLive("build=107&platform=android&tz=330&lat=12.8700&lng=74.8600");
    await s.ready();
    // A few hundred metres inside Kadri: tools move, the model is not told.
    s.say({ type: "location", lat: 12.8712, lng: 74.8611, acc: 20 });
    await tick(); await tick();
    assert.strictEqual(s.notes().length, 0, "same area, no note");
    // Nonsense is ignored.
    s.say({ type: "location", lat: 0, lng: 0 });
    s.say({ type: "location", lat: 200, lng: 74 });
    s.say({ type: "location" });
    // Manipal: a new area.
    s.say({ type: "location", lat: 13.3525, lng: 74.7928, acc: 15 });
    await waitFor(() => s.notes().length === 1);
    const note = s.notes()[0].clientContent;
    assert.strictEqual(note.turnComplete, false, "no reply is asked for");
    assert.match(note.turns[0].parts[0].text, /^\[SYSTEM\] The owner is now in Manipal, Udupi\./);
    asked.length = 0;
    await toolCall(s, "web_search", { query: "hotel address" });
    assert.strictEqual(asked[0], "hotel address Udupi", "the search uses where they are NOW");
    // Back and forth inside Manipal: still one note.
    s.say({ type: "location", lat: 13.3530, lng: 74.7930, acc: 15 });
    await tick(); await tick();
    assert.strictEqual(s.notes().length, 1);
  });

  await t("live location: a note never lands over her voice — it waits for her turn to end", async () => {
    const s = await openLive("build=107&platform=android&tz=330&lat=12.8700&lng=74.8600");
    await s.ready();
    s.model({ serverContent: { outputTranscription: { text: "Sure, the nearest one is " } } });
    s.say({ type: "location", lat: 13.3525, lng: 74.7928, acc: 15 });
    await tick(); await tick(); await tick();
    assert.strictEqual(s.notes().length, 0, "held while she speaks");
    s.model({ serverContent: { turnComplete: true } });
    await waitFor(() => s.notes().length === 1);
    assert.strictEqual(s.notes()[0].clientContent.turnComplete, false);
  });

  await t("live location: a coarse fix moves the tools but tells the model nothing", async () => {
    const s = await openLive("build=107&platform=android&tz=330&lat=12.8700&lng=74.8600");
    await s.ready();
    s.say({ type: "location", lat: 13.3525, lng: 74.7928, acc: 5000 });
    await tick(); await tick(); await tick();
    assert.strictEqual(s.notes().length, 0);
    asked.length = 0;
    await toolCall(s, "web_search", { query: "hotel address" });
    assert.strictEqual(asked[0], "hotel address Udupi");
  });

  await t("live location: a session that started without a fix is told the first place", async () => {
    const s = await openLive("build=107&platform=android&tz=330");
    await s.ready();
    s.say({ type: "location", lat: 12.8700, lng: 74.8600, acc: 30 });
    await waitFor(() => s.notes().length === 1);
    assert.match(s.notes()[0].clientContent.turns[0].parts[0].text, /now in Kadri, Mangaluru/);
  });

  console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
