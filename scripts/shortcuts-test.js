/**
 * SHORTCUTS — `npm run test:shortcuts`.
 *
 * "Office mode": one word, several things (design: shortcuts.md, Phase 1).
 * These pin:
 *   (a) names: normalising, reserved words, matching a whole utterance
 *       only, and the answer guard ("which one?" → "office mode" never runs);
 *   (b) steps: the allowlist, the fixed order, the build gates, the caps,
 *       no company names in labels, time steps in the user's clock;
 *   (c) compiling plain steps: rules first, the model (stubbed) with the
 *       user's memory, people resolved to a contact, a bare place word
 *       always asked about;
 *   (d) the store: unique names across every name, versions, other users;
 *   (e) the runner: every step through registry.execute, ask ONCE before
 *       anything runs, a yes approves only the named steps, a weak yes,
 *       an edit voiding the yes, expiry, 30-day clean-up, daily limit;
 *   (f) the tools: build and kill-switch gates, taint, cross-user runs,
 *       claim families, the prompt block;
 *   (g) "save that as a shortcut": the hint, its masking, the refusals, and
 *       the hint note reaching the planner's notes;
 *   (h) the classic pre-model route, the /confirm emit, the live proxy
 *       wiring and the REST routes.
 *
 * Nothing leaves this machine: fetch is stubbed for every host but the
 * local test server and the model is a stub.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
delete process.env.SHORTCUTS;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (/^http:\/\/127\.0\.0\.1:\d+\//.test(u)) return realFetch(url, opts);
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const express = require("express");
const db = require("../src/db");
const ai = require("../src/services/ai/router");
ai.generateWithTools = async () => { throw new Error("the model must not be asked"); };

const registry = require("../src/tools/registry");
require("../src/tools/builtins").registerBuiltins();
const S = require("../src/shortcuts/steps");
const M = require("../src/shortcuts/match");
const C = require("../src/shortcuts/compile");
const store = require("../src/shortcuts/store");
const runner = require("../src/shortcuts/runner");

let passed = 0;
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
}

const CAPS = { platform: "android", build: 120, granted: ["location", "contacts"], denied: [] };
const ctxFor = (userId, extra = {}) => ({
  userId, appBuild: 120, deviceCaps: CAPS, source: "voice", tzOffsetMin: 330,
  session: require("../src/agents/sessionState").begin(userId, `t:${userId}:${Math.random()}`, { surface: "voice", appBuild: 120 }),
  ...extra,
});

/** Record every registry.execute call, then pass it through. */
const calls = [];
const realExecute = registry.execute;
registry.execute = async (name, args, ctx) => {
  calls.push({ name, args, ctx });
  return realExecute(name, args, ctx);
};
const stepCalls = (from) => calls.slice(from).filter((c) => S.STEP_TOOLS[c.name]);

(async () => {
  await db.init();
  await store.migrate();
  await require("../src/routes/contacts").migrate();
  const sealed = registry.seal({ strict: true });
  const stamp = String(Date.now()).slice(-8);
  const mkUser = async (tag) =>
    (await db.createUser({ email: `shortcuts-${tag}-${stamp}@example.test`, name: `Test ${tag}` })).id;
  const A = await mkUser("a");
  const B = await mkUser("b");
  const addContact = (uid, name, phone) => db.run(
    "INSERT INTO contacts (user_id, name, phone, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [uid, name, phone, Date.now()]);
  await addContact(A, "Priya Shetty", "+919800000001");
  await addContact(A, "Ravi Kumar", "+919800000002");
  await addContact(A, "Anil Rao", "+919800000003");
  await addContact(A, "Anil Menon", "+919800000004");

  /* ================================================================ */
  console.log("\nnames");

  await atest("keys fold case, spaces, width, joiners and 'my … shortcut'", () => {
    assert.strictEqual(M.nameKey("  Office   MODE "), "office mode");
    assert.strictEqual(M.nameKey("my office mode shortcut"), "office mode");
    assert.strictEqual(M.nameKey("ഓഫീസ് മോഡ്"), M.nameKey("ഓഫീസ്‍ മോഡ്"), "ZWJ is not a difference");
    assert.strictEqual(M.nameKey("ഓഫീസ് മോഡ്"), M.nameKey("ഓഫീസ്‌ മോഡ്"), "ZWNJ is not a difference");
    assert.strictEqual(M.nameKey("पूजा मोड"), "पूजा मोड", "matras are kept");
    assert.strictEqual(M.nameKey("ＯＦＦＩＣＥ mode"), "office mode", "NFKC folds full width");
  });

  await atest("fillers around a name are stripped, in several languages", () => {
    for (const t of ["office mode", "hari office mode please", "start office mode", "office mode chalu karo",
      "Hey Hari, run office mode now", "office mode on"]) {
      assert.strictEqual(M.stripFillers(t), "office mode", t);
    }
    assert.strictEqual(M.stripFillers("ഓഫീസ് മോഡ് ഓൺ ആക്കൂ"), M.nameKey("ഓഫീസ് മോഡ്"));
  });

  await atest("reserved names are refused: commands, the assistant, an app, too short", () => {
    for (const n of ["stop", "yes", "news", "hari", "shortcut", "ok", "cancel it"]) {
      assert.strictEqual(M.checkName(n).ok, false, n);
    }
    assert.strictEqual(M.checkName("Jarvis", { assistantName: "Jarvis" }).ok, false);
    assert.strictEqual(M.checkName("swiggy").error, "reserved_name", "wholly an app's name");
    assert.strictEqual(M.checkName("x").error, "bad_name");
    assert.strictEqual(M.checkName("a".repeat(41)).error, "bad_name");
    assert.strictEqual(M.checkName("one two three four five six seven").error, "bad_name");
    assert.ok(M.checkName("office mode").ok);
    assert.ok(M.checkName("ഓഫീസ് മോഡ്").ok);
  });

  await atest("the answer guard: a question just asked, or a yes/no pending", () => {
    assert.ok(M.answerGuard("Which shortcut should I delete?"));
    assert.ok(M.answerGuard("What should I call it?"));
    assert.ok(M.answerGuard("Anything else?"));
    assert.ok(M.answerGuard("", true), "a pending confirmation");
    assert.ok(!M.answerGuard("Office mode — phone on silent."));
    assert.ok(!M.answerGuard(""));
  });

  /* ================================================================ */
  console.log("\nsteps");

  const step = (tool, args, extra = {}) => ({ tool, args, said: `${tool}`, ...extra });

  await atest("a tool outside the allowlist is never a step, with a reason", () => {
    for (const t of ["pay_by_upi", "collect_payment", "save_upi_id", "record_patient_payment", "book_by_calling_business",
      "arrange_meeting_with", "order_food", "book_ride", "book_movie_tickets", "place_phone_call", "uninstall_app",
      "forget_memory", "delete_calendar_event", "add_standing_instruction", "configure_assistant", "update_my_profile",
      "remember_fact", "send_video_note", "send_document", "email_reply", "schedule_task", "start_task",
      "run_shortcut", "create_shortcut", "end_conversation", "stay_silent", "mcp__someone__tool"]) {
      const v = S.validate([step(t, {})], { build: 120 });
      assert.strictEqual(v.ok, false, t);
      assert.strictEqual(v.error, "step_not_allowed", t);
      assert.ok(v.data.why, t);
    }
    assert.match(S.validate([step("pay_by_upi", {})]).data.why, /money/);
  });

  await atest("the order is fixed: in-app → chat → apps that stay → a phone task; stable and reported", () => {
    const v = S.validate([
      step("start_navigation", { destination: "MG Road" }),
      step("send_whatsapp_message", { to: "Priya Shetty", message: "leaving" }),
      step("phone_control", { action: "ringer_silent" }),
      step("create_reminder", { text: "call mom" }),
    ], { build: 120 });
    assert.ok(v.ok, JSON.stringify(v));
    assert.deepStrictEqual(v.steps.map((s) => s.tool), ["phone_control", "create_reminder", "send_whatsapp_message", "start_navigation"]);
    assert.strictEqual(v.reordered, true);
    assert.strictEqual(S.validate([step("phone_control", { action: "ringer_silent" })]).reordered, false);
  });

  await atest("duplicate targets, go_home, http links, two spoken steps and long text are refused", () => {
    const silent = step("phone_control", { action: "ringer_silent" });
    assert.strictEqual(S.validate([silent, silent]).error, "duplicate_step");
    assert.strictEqual(S.validate([step("phone_control", { action: "go_home" })]).error, "step_not_allowed");
    assert.strictEqual(S.validate([step("phone_control", { action: "battery" })]).error, "step_not_allowed");
    assert.strictEqual(S.validate([step("open_webpage", { url: "http://example.com" })]).error, "step_not_allowed");
    assert.strictEqual(S.validate([step("open_webpage", { url: "javascript:alert(1)" })]).error, "step_not_allowed");
    assert.ok(S.validate([step("open_webpage", { url: "https://example.com" })]).ok);
    assert.strictEqual(S.validate([step("get_weather", {}), step("daily_brief", {})]).error, "too_many_spoken");
    assert.strictEqual(S.validate([step("send_whatsapp_message", { to: "Ravi", message: "x".repeat(501) })]).error, "step_too_long");
    assert.strictEqual(S.validate([{ ...silent, said: "y".repeat(301) }]).error, "step_too_long");
    assert.strictEqual(S.validate(Array(11).fill(silent)).error, "too_many_steps");
  });

  await atest("the ringer and Do Not Disturb need build 120", () => {
    assert.strictEqual(S.validate([step("phone_control", { action: "ringer_silent" })], { build: 119 }).error, "step_needs_update");
    assert.strictEqual(S.validate([step("phone_control", { action: "dnd_on" })], { build: 118 }).error, "step_needs_update");
    assert.ok(S.validate([step("phone_control", { action: "flashlight_on" })], { build: 119 }).ok);
  });

  await atest("labels are the user's words: no company names, and 'mute' is the media", () => {
    const BRANDS = /whats\s?app|google|maps|swiggy|zomato|spotify|youtube|gpay|phonepe|paytm|uber|ola\b|instagram|amazon|flipkart/i;
    const all = [
      step("phone_control", { action: "ringer_silent" }), step("phone_control", { action: "mute" }),
      step("phone_control", { action: "volume_set", value: 40 }), step("set_alarm", { hour: 6, minute: 0 }),
      step("set_timer", { minutes: 10 }), step("send_whatsapp_message", { to: "Priya", message: "I'm leaving" }),
      step("start_navigation", { destination: "MG Road" }), step("play_music", { query: "morning bhajans" }),
      step("create_reminder", { text: "call amma" }, { when: { at: "18:00" } }), step("get_weather", {}),
      step("send_agent_message", { contact_name: "Priya", message: "leaving now" }),
      step("open_webpage", { url: "https://example.com/a" }), step("daily_brief", {}), step("get_news", {}),
    ];
    for (const s of all) assert.ok(!BRANDS.test(S.labelFor(s)), S.labelFor(s));
    assert.strictEqual(S.labelFor(all[0]), "Phone on silent");
    assert.strictEqual(S.labelFor(all[1]), "Mute media");
    assert.strictEqual(S.labelFor(all[2]), "Volume 40%");
    assert.strictEqual(S.labelFor(all[3]), "Alarm 6:00 am");
    assert.strictEqual(S.labelFor(all[5]), "Chat message to Priya: “I'm leaving” (you tap Send)");
    assert.strictEqual(S.labelFor(all[8]), "Reminder at 6:00 pm: call amma");
  });

  await atest("time steps land in the user's clock; a time already past is tomorrow", () => {
    const now = Date.parse("2026-09-27T14:00:00Z"); // 19:30 IST
    const at = S.materialise({ tool: "create_reminder", args: { text: "x" }, when: { at: "18:00" } }, { tzOffsetMin: 330, now });
    assert.strictEqual(at.args.due_at, "2026-09-28T18:00:00+05:30");
    const later = S.materialise({ tool: "create_reminder", args: { text: "x" }, when: { at: "21:15" } }, { tzOffsetMin: 330, now });
    assert.strictEqual(later.args.due_at, "2026-09-27T21:15:00+05:30");
    const inMin = S.materialise({ tool: "create_reminder", args: { text: "x" }, when: { in_minutes: 30 } }, { tzOffsetMin: 330, now });
    assert.strictEqual(inMin.args.due_at, "2026-09-27T20:00:00+05:30");
  });

  /* ================================================================ */
  console.log("\ncompiling plain steps");

  await atest("the rules read the common phrasings with no model call", () => {
    const table = [
      ["put my phone on silent", "phone_control", { action: "ringer_silent" }],
      ["silent mode", "phone_control", { action: "ringer_silent" }],
      ["vibrate only", "phone_control", { action: "ringer_vibrate" }],
      ["turn on do not disturb", "phone_control", { action: "dnd_on" }],
      ["do not disturb off", "phone_control", { action: "dnd_off" }],
      ["torch on", "phone_control", { action: "flashlight_on" }],
      ["turn off the flashlight", "phone_control", { action: "flashlight_off" }],
      ["volume 40", "phone_control", { action: "volume_set", value: 40 }],
      ["set volume to 70%", "phone_control", { action: "volume_set", value: 70 }],
      ["pause the music", "phone_control", { action: "media_pause" }],
      ["directions to MG Road", "start_navigation", { destination: "MG Road" }],
      ["navigate to 4th floor, Mangalore One", "start_navigation", { destination: "4th floor, Mangalore One" }],
      ["WhatsApp Ravi: I'm leaving", "send_whatsapp_message", { to: "Ravi", message: "I'm leaving" }],
      ["whatsapp Priya that I'll be late", "send_whatsapp_message", { to: "Priya", message: "I'll be late" }],
      ["message Ravi on WhatsApp saying on my way", "send_whatsapp_message", { to: "Ravi", message: "on my way" }],
      ["open momentum", "open_app_screen", { screen: "momentum" }],
      ["open Maps", "open_named_app", { app: "Maps" }],
      ["play morning bhajans", "play_music", { query: "morning bhajans" }],
      ["alarm at 6:30 am", "set_alarm", { hour: 6, minute: 30 }],
      ["wake me at 5", "set_alarm", { hour: 5, minute: 0 }],
      ["timer 10 min", "set_timer", { minutes: 10 }],
      ["weather", "get_weather", {}],
      ["headlines", "get_news", {}],
      ["my brief", "daily_brief", {}],
      ["remind me in 30 minutes to call amma", "create_reminder", { text: "call amma" }],
    ];
    for (const [text, tool, args] of table) {
      const q = C.quick(text);
      assert.ok(q, text);
      assert.strictEqual(q.tool, tool, text);
      assert.deepStrictEqual(q.args, args, text);
    }
    assert.deepStrictEqual(C.quick("remind me at 6 pm to call amma").when, { at: "18:00" });
    assert.deepStrictEqual(C.quick("remind me in 30 minutes to call amma").when, { in_minutes: 30 });
  });

  await atest("a person named by relation, or another language, is never read by the rules", () => {
    assert.strictEqual(C.quick("WhatsApp my wife I'm leaving"), null);
    assert.strictEqual(C.quick("whatsapp amma: reached office"), null);
    assert.strictEqual(C.quick("ഫോൺ സൈലന്റ് ആക്കൂ"), null);
    assert.strictEqual(C.quick("tell my boss I'm late"), null);
  });

  const stubModel = (steps, refuse = []) => {
    const seen = [];
    ai.generateWithTools = async (req) => {
      seen.push(req);
      return { text: "", functionCalls: [{ name: "submit_steps", args: { steps, refuse } }] };
    };
    return seen;
  };

  await atest("the model reads the rest, with the user's memory; a relation becomes the contact", async () => {
    C._resetCounter();
    await require("../src/agents/memory").saveMemory(A, "User's wife is Priya", 3).catch(() => {});
    const seen = stubModel([
      { n: 2, tool: "send_whatsapp_message", args_json: JSON.stringify({ to: "Priya", message: "ഞാൻ ഇറങ്ങി" }) },
    ]);
    const out = await C.compile(A, ["put my phone on silent", "WhatsApp my wife ഞാൻ ഇറങ്ങി"], { appBuild: 120 });
    assert.ok(out.ok, JSON.stringify(out));
    assert.strictEqual(seen.length, 1, "one model call");
    assert.match(seen[0].contents[0].parts[0].text, /^2\. WhatsApp my wife/, "only the step the rules could not read");
    assert.ok(!/1\. put my phone/.test(seen[0].contents[0].parts[0].text));
    assert.match(seen[0].system, /wife is Priya/, "the memory block is in the prompt");
    assert.match(seen[0].system, /NEVER choose an address from memory/);
    const chat = out.steps.find((s) => s.tool === "send_whatsapp_message");
    assert.strictEqual(chat.args.to, "Priya Shetty", "resolved to the contact");
    assert.strictEqual(chat.args.message, "ഞാൻ ഇറങ്ങി", "the dictated words, byte for byte");
  });

  await atest("an invented tool, bad args, money and an unknown person each say so", async () => {
    stubModel([{ n: 1, tool: "hack_the_planet", args_json: "{}" }]);
    assert.strictEqual((await C.compile(A, ["ഫോൺ സൈലന്റ് ആക്കൂ"])).error, "compile_failed");
    stubModel([{ n: 1, tool: "phone_control", args_json: "{not json" }]);
    assert.strictEqual((await C.compile(A, ["ഫോൺ സൈലന്റ് ആക്കൂ"])).error, "compile_failed");
    stubModel([{ n: 1, tool: "pay_by_upi", args_json: "{}" }]);
    const money = await C.compile(A, ["pay the electricity bill"]);
    assert.strictEqual(money.error, "step_not_allowed");
    assert.match(money.data.why, /money/);
    stubModel([], [{ n: 1, why: "money is always your own step" }]);
    assert.strictEqual((await C.compile(A, ["pay the electricity bill"])).error, "step_not_allowed");
    stubModel([{ n: 1, tool: "send_whatsapp_message", args_json: JSON.stringify({ to: "my boss", message: "late" }), needs: "person" }]);
    const who = await C.compile(A, ["tell my boss I'm late on WhatsApp"]);
    assert.strictEqual(who.error, "needs_detail");
    assert.match(who.data.question, /Who should the message go to/);
  });

  await atest("people: ambiguous or unknown is asked, never saved", async () => {
    const amb = await C.compile(A, ["WhatsApp Anil: hi"]);
    assert.strictEqual(amb.error, "needs_detail");
    assert.match(amb.data.question, /Which Anil — Anil (Rao|Menon) or Anil (Rao|Menon)\?/);
    const none = await C.compile(A, ["WhatsApp Zubin: hi"]);
    assert.strictEqual(none.error, "needs_detail");
  });

  await atest("places: 'directions to office' ALWAYS asks for the address; the answer is stored as said", async () => {
    for (const t of ["directions to office", "navigate to home", "directions to my shop", "directions to work"]) {
      const out = await C.compile(A, [t]);
      assert.strictEqual(out.error, "needs_detail", t);
      assert.match(out.data.question, /What's the address for/);
    }
    const ok = await C.compile(A, ["directions to 4th floor, Mangalore One, MG Road"]);
    assert.strictEqual(ok.steps[0].args.destination, "4th floor, Mangalore One, MG Road");
    assert.strictEqual(ok.steps[0].label, "Directions to 4th floor, Mangalore One, MG Road");
  });

  await atest("the 31st model compile of the day is refused", async () => {
    C._resetCounter();
    stubModel([{ n: 1, tool: "phone_control", args_json: JSON.stringify({ action: "ringer_silent" }) }]);
    for (let i = 0; i < C.DAILY_COMPILES; i++) assert.ok((await C.compile(A, ["ഫോൺ സൈലന്റ്"])).ok);
    assert.strictEqual((await C.compile(A, ["ഫോൺ സൈലന്റ്"])).error, "compile_limit");
    C._resetCounter();
    ai.generateWithTools = async () => { throw new Error("the model must not be asked"); };
  });

  /* ================================================================ */
  console.log("\nthe store and the voice tools");

  const ctxA = () => ctxFor(A);
  let office;

  await atest("create_shortcut saves, reorders and reads back in full; nothing runs", async () => {
    const from = calls.length;
    const res = await registry.execute("create_shortcut", {
      name: "office mode", other_names: ["ഓഫീസ് മോഡ്"],
      steps: ["directions to 4th floor, MG Road", "put my phone on silent", "WhatsApp Priya: I'm leaving"],
    }, ctxA());
    assert.ok(res.ok, JSON.stringify(res));
    assert.strictEqual(res.data.reordered, true);
    assert.deepStrictEqual(res.data.steps.map((s) => s.label), [
      "Phone on silent", "Chat message to Priya Shetty: “I'm leaving” (you tap Send)", "Directions to 4th floor, MG Road",
    ]);
    assert.match(res.speak, /^Saved “Office mode”: phone on silent, a chat message to Priya Shetty saying “I'm leaving” \(you tap Send\), then directions to 4th floor, MG Road\./);
    assert.match(res.note, /SAVED, not run/);
    assert.strictEqual(stepCalls(from).length, 0, "no step ran");
    office = await store.get(A, res.data.shortcut_id);
    assert.deepStrictEqual(office.other_names, ["ഓഫീസ് മോഡ്"]);
  });

  await atest("names are unique across every name, in any case or joiner", async () => {
    const dup = await registry.execute("create_shortcut", { name: "Office Mode", steps: ["torch on"] }, ctxA());
    assert.strictEqual(dup.error, "name_taken");
    const dup2 = await registry.execute("create_shortcut", { name: "pooja mode", other_names: ["ഓഫീസ്‍ മോഡ്"], steps: ["torch on"] }, ctxA());
    assert.strictEqual(dup2.error, "name_taken");
    assert.strictEqual((await store.list(A)).length, 1, "nothing half-saved");
    const res = await registry.execute("create_shortcut", { name: "stop", steps: ["torch on"] }, ctxA());
    assert.strictEqual(res.error, "reserved_name");
    const other = await registry.execute("create_shortcut", { name: "office mode", steps: ["torch on"] }, ctxFor(B));
    assert.ok(other.ok, "another user may use the same name");
  });

  await atest("more than 4 names, and a 51st shortcut, are refused", async () => {
    await assert.rejects(store.create(A, { name: "a1 mode", otherNames: ["b1", "c1", "d1", "e1"], steps: [] }),
      (e) => e.code === "too_many_names");
    const n = (await store.list(B)).length;
    for (let i = n; i < S.MAX_SHORTCUTS; i++) await store.create(B, { name: `bulk ${i}`, steps: [] });
    await assert.rejects(store.create(B, { name: "one more", steps: [] }), (e) => e.code === "too_many_shortcuts");
  });

  await atest("another user's shortcut and run are 'not found'", async () => {
    assert.strictEqual(await store.get(B, office.id), null);
    assert.strictEqual(await store.remove(B, office.id), false);
    assert.ok(await store.get(A, office.id));
  });

  await atest("a stale version is refused, not applied", async () => {
    const cur = await store.get(A, office.id);
    await assert.rejects(store.update(A, office.id, { name: "office mode" }, { version: cur.version + 5 }), (e) => e.code === "stale");
  });

  await atest("list_shortcuts says the names", async () => {
    const res = await registry.execute("list_shortcuts", {}, ctxA());
    assert.strictEqual(res.speak, "You have 1 shortcut: office mode.");
    assert.deepStrictEqual(res.data.shortcuts[0].other_names, ["ഓഫീസ് മോഡ്"]);
  });

  await atest("matching: exactFor the whole utterance only; resolve fuzzy, which_one, none", async () => {
    for (const t of ["office mode", "hari office mode please", "start office mode", "office mode chalu karo", "ഓഫീസ് മോഡ് ഓൺ ആക്കൂ"]) {
      const hit = await M.exactFor(A, t);
      assert.ok(hit && hit.id === office.id, t);
    }
    for (const t of ["what is office mode", "delete office mode", "office mode and call mom"]) {
      assert.strictEqual(await M.exactFor(A, t), null, t);
    }
    assert.strictEqual((await M.resolve(A, "ofice mode")).id, office.id, "one slip");
    assert.strictEqual((await M.resolve(A, "mode office")).id, office.id, "same words");
    await store.create(A, { name: "office trip", steps: [] });
    await store.create(A, { name: "office trap", steps: [] });
    const which = await M.resolve(A, "office trop");
    assert.strictEqual(which.error, "which_one");
    const none = await M.resolve(A, "pooja");
    assert.strictEqual(none.error, "no_such_shortcut");
    assert.ok(none.data.names.includes("Office mode"));
  });

  await atest("the name cache is dropped on every write", async () => {
    const before = await M.keysFor(A);
    const sc = await store.create(A, { name: "night mode", steps: [] });
    assert.ok((await M.keysFor(A)).includes("night mode"));
    await store.remove(A, sc.id);
    assert.ok(!(await M.keysFor(A)).includes("night mode"));
    assert.ok(before.length >= 1);
  });

  await atest("update_shortcut renames, adds and removes; delete cascades the names", async () => {
    const sc = await store.create(A, { name: "pooja mode", otherNames: ["പൂജ മോഡ്"], steps: S.validate([
      { tool: "phone_control", args: { action: "ringer_silent" }, said: "silent" }]).steps });
    let res = await registry.execute("update_shortcut", { name: "pooja mode", add_steps: ["torch on"] }, ctxA());
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepStrictEqual(res.data.steps.map((s) => s.label), ["Phone on silent", "Torch on"]);
    res = await registry.execute("update_shortcut", { name: "pooja mode", remove_steps: ["1"] }, ctxA());
    assert.deepStrictEqual(res.data.steps.map((s) => s.label), ["Torch on"]);
    res = await registry.execute("update_shortcut", { name: "pooja mode", new_name: "prayer mode" }, ctxA());
    assert.strictEqual(res.data.name, "Prayer mode");
    assert.strictEqual((await store.get(A, sc.id)).version, 4);
    assert.ok(registry.requiresConfirmation("delete_shortcut", {}));
    const asked = await realExecute("delete_shortcut", { name: "prayer mode" }, ctxA());
    assert.strictEqual(asked.needsConfirmation, true, "delete always asks first");
    assert.match(asked.summary, /Delete your shortcut “prayer mode”/);
    const gone = await realExecute("delete_shortcut", { name: "prayer mode" }, { ...ctxA(), approved: true });
    assert.ok(gone.ok);
    const left = await db.query("SELECT * FROM shortcut_names WHERE shortcut_id = $1", [sc.id]);
    assert.strictEqual(left.length, 0, "names cascade");
  });

  /* ================================================================ */
  console.log("\nrunning");

  await atest("every step goes through registry.execute and one directive goes to the phone", async () => {
    const from = calls.length;
    const res = await registry.execute("run_shortcut", { name: "office mode" }, ctxA());
    assert.ok(res.ok, JSON.stringify(res));
    const steps = stepCalls(from);
    assert.deepStrictEqual(steps.map((c) => c.name), ["phone_control", "send_whatsapp_message", "start_navigation"]);
    const d = res.deviceAction;
    assert.strictEqual(d.type, "shortcut_run");
    assert.strictEqual(d.leaves_app, true);
    assert.deepStrictEqual(d.steps.map((s) => [s.i, s.class, s.wait_return]),
      [[0, "in_app", false], [1, "hand_back", true], [2, "stays", false]]);
    assert.strictEqual(d.steps[0].action.type, "phone_control");
    assert.match(d.steps[1].action.url, /^whatsapp:\/\/send\?phone=/);
    assert.match(d.steps[2].action.url, /^google\.navigation:q=/);
    assert.ok(!/\bsent\b/i.test(res.speak), res.speak);
    assert.match(res.speak, /ready to send/);
    const run = await store.getRun(A, res.data.run_id);
    assert.strictEqual(run.status, "dispatched");
    assert.strictEqual((await store.get(A, office.id)).run_count, 1);
  });

  await atest("the same shortcut twice in one breath is swallowed", async () => {
    const ctx = ctxA();
    const one = await registry.execute("run_shortcut", { name: "office mode" }, ctx);
    const two = await registry.execute("run_shortcut", { name: "office mode" }, ctx);
    assert.ok(one.ok && one.deviceAction);
    assert.strictEqual(two.repeated, true);
  });

  await atest("an in-app-only shortcut does not leave the app; a failed step does not stop the rest", async () => {
    const sc = await store.create(A, { name: "torch mode", steps: S.validate([
      { tool: "phone_control", args: { action: "flashlight_on" }, said: "torch" },
      { tool: "check_habit", args: { habit: "no such habit here" }, said: "tick it" },
    ]).steps });
    const out = await runner.start(A, sc, ctxA());
    assert.ok(out.ok);
    assert.strictEqual(out.directive.leaves_app, false);
    assert.strictEqual(out.run.status, "dispatched");
    await store.remove(A, sc.id);
  });

  let shopRun;
  await atest("a step that needs a yes: ONE question before ANY step runs", async () => {
    await store.create(A, { name: "shop mode", steps: S.validate([
      { tool: "phone_control", args: { action: "ringer_vibrate" }, said: "vibrate" },
      { tool: "send_agent_message", args: { contact_name: "Priya Shetty", message: "leaving now" }, said: "tell Priya leaving now" },
      { tool: "create_reminder", args: { text: "lock the shop" }, said: "remind me", when: { in_minutes: 30 } },
    ]).steps });
    const from = calls.length;
    const res = await registry.execute("run_shortcut", { name: "shop mode" }, ctxA());
    assert.strictEqual(res.needsConfirmation, true);
    assert.strictEqual(res.tool, "continue_shortcut");
    assert.match(res.summary, /Shop mode will also send Priya Shetty's assistant “leaving now”/);
    assert.strictEqual(stepCalls(from).length, 0, "nothing ran before the answer");
    shopRun = res.args.run_id;
    const run = await store.getRun(A, shopRun);
    assert.strictEqual(run.status, "waiting");
    assert.deepStrictEqual(run.pending.steps, [1]);
  });

  await atest("continue_shortcut: another user's run gives an error and NO summary; its sync line reads no data", async () => {
    const t = registry.get("continue_shortcut");
    const other = await t.prepare({ run_id: shopRun }, { userId: B });
    assert.ok(other.error);
    assert.strictEqual(other.summary, undefined);
    const mine = await t.prepare({ run_id: shopRun }, { userId: A });
    assert.match(mine.summary, /leaving now/);
    assert.ok(!/leaving|Priya/.test(t.confirmSummary({ run_id: shopRun }, { userId: A })));
    const asked = await realExecute("continue_shortcut", { run_id: shopRun }, ctxFor(B));
    assert.ok(!asked.ok && !/leaving/.test(JSON.stringify(asked)), "the model cannot approve itself, nor read another's run");
    assert.ok(registry.requiresConfirmation("continue_shortcut", {}));
    const bResume = await realExecute("continue_shortcut", { run_id: shopRun }, { ...ctxFor(B), approved: true });
    assert.strictEqual(bResume.ok, false);
  });

  await atest("the /confirm replay (approved:true in ctx) approves ONLY the named step; a weak yes still runs the rest", async () => {
    const from = calls.length;
    const ctx = { ...ctxA(), approved: true, inputQuality: { quality: "weak", reason: "one word", heard: "ചെയ്തോളൂ" } };
    const res = await registry.execute("continue_shortcut", { run_id: shopRun }, ctx);
    assert.ok(res.ok, JSON.stringify(res));
    const steps = stepCalls(from);
    assert.deepStrictEqual(steps.map((c) => [c.name, c.ctx.approved]),
      [["phone_control", false], ["send_agent_message", true], ["create_reminder", false]]);
    assert.ok(steps.every((c) => c.ctx.inputQuality.quality === "clear"), "judged on the turn that started it");
    assert.strictEqual(steps[1].args.confirmed, true, "the message read out in the question");
    assert.match(steps[2].args.due_at, /\+05:30$/, "the reminder in the user's clock");
    assert.deepStrictEqual(res.data.failed, [], JSON.stringify(res.data));
    const again = await registry.execute("continue_shortcut", { run_id: shopRun }, { ...ctxA(), approved: true });
    assert.strictEqual(again.ok, false, "a yes is used once");
  });

  await atest("a second run asks again; no runs nothing; an edit voids the yes", async () => {
    const res = await registry.execute("run_shortcut", { name: "shop mode" }, ctxFor(A));
    assert.strictEqual(res.needsConfirmation, true, "asked every run");
    const from = calls.length;
    const no = await runner.decline(A, res.args.run_id);
    assert.strictEqual(no.run.status, "cancelled");
    assert.strictEqual(stepCalls(from).length, 0);
    const res2 = await registry.execute("run_shortcut", { name: "shop mode" }, ctxFor(A));
    const sc = await store.byNameKey(A, "shop mode");
    await store.update(A, sc.id, { name: "Shop mode" });
    const after = await runner.resume(A, res2.args.run_id, ctxFor(A));
    assert.strictEqual(after.parked, true, "asked again after the edit");
    assert.strictEqual((await store.getRun(A, res2.args.run_id)).status, "cancelled");
  });

  await atest("a waiting run older than 10 minutes expires on the yes; nothing runs", async () => {
    const res = await registry.execute("run_shortcut", { name: "shop mode" }, ctxFor(A));
    const from = calls.length;
    const out = await runner.resume(A, res.args.run_id, ctxFor(A), { now: Date.now() + 11 * 60_000 });
    assert.strictEqual(out.error, "expired");
    assert.strictEqual((await store.getRun(A, res.args.run_id)).status, "expired");
    assert.strictEqual(stepCalls(from).length, 0);
  });

  await atest("after reading an email, a send step is asked about, and a scheduled run is refused", async () => {
    const ctx = ctxA();
    registry.markTurnUntrusted(ctx);
    const res = await realExecute("run_shortcut", { name: "office mode" }, ctx);
    assert.strictEqual(res.needsConfirmation, true, "run_shortcut itself is taint-sensitive");
    const out = await runner.start(A, office, ctx);
    assert.strictEqual(out.parked, true);
    assert.match(out.summary, /chat message to priya shetty/);
    assert.match(out.summary, /after reading an email or web page/);
    const bg = await realExecute("run_shortcut", { name: "office mode" }, { ...ctxA(), background: true });
    assert.strictEqual(bg.ok, false);
  });

  await atest("a garbled turn runs nothing; a single-word name is clear only when it is theirs", async () => {
    const iq = require("../src/agents/inputQuality");
    const res = await realExecute("run_shortcut", { name: "office mode" },
      { ...ctxA(), inputQuality: { quality: "garbled", reason: "noise", heard: "of" } });
    assert.strictEqual(res.error, "unclear_request");
    await store.create(A, { name: "പൂജ", steps: [] });
    const keys = await M.keysFor(A);
    assert.strictEqual(iq.assess("പൂജ").quality, "weak");
    assert.strictEqual(iq.assess("പൂജ", { known: keys }).quality, "clear");
    assert.strictEqual(iq.assess("start office mode please", { known: keys }).quality, "clear");
  });

  await atest("createRun expires this user's stale waiting runs and deletes only their month-old runs", async () => {
    const old = Date.now() - 31 * 24 * 3600_000;
    const mine = await store.createRun(A, office, { now: old });
    const theirs = await store.createRun(B, { id: 1, version: 1, name: "x", steps: [] }, { now: old });
    await store.createRun(A, office, {});
    assert.strictEqual(await store.getRun(A, mine.id), null);
    assert.ok(await store.getRun(B, theirs.id), "another user's history is untouched");
  });

  await atest("the daily run limit", async () => {
    const now = Date.now();
    const n = await store.countToday(A);
    for (let i = n; i < runner.DAILY_RUNS; i++) {
      await db.run(`INSERT INTO shortcut_runs (user_id, shortcut_id, version, name, steps, status, created_at, updated_at)
        VALUES ($1,$2,1,'x','[]'::jsonb,'done',$3,$3)`, [A, office.id, now]);
    }
    const res = await registry.execute("run_shortcut", { name: "office mode" }, ctxA());
    assert.strictEqual(res.error, "daily_limit");
    await db.run("DELETE FROM shortcut_runs WHERE user_id = $1 AND name = 'x'", [A]);
  });

  /* ================================================================ */
  console.log("\ntool contract, gates and prompt");

  await atest("hidden for builds before 120 and with SHORTCUTS=off; the contract seals with no phantoms", async () => {
    const names = (caps) => registry.declarations({ userId: A, deviceCaps: caps }).map((d) => d.name);
    assert.ok(names(CAPS).includes("run_shortcut"));
    assert.ok(!names({ ...CAPS, build: 119 }).includes("run_shortcut"));
    assert.ok(!names({ ...CAPS, build: 119 }).includes("create_shortcut"));
    process.env.SHORTCUTS = "off";
    assert.ok(!names(CAPS).includes("run_shortcut"));
    delete process.env.SHORTCUTS;
    assert.deepStrictEqual(sealed.phantoms, []);
    const old = await realExecute("run_shortcut", { name: "office mode" }, { ...ctxA(), appBuild: 119, deviceCaps: { ...CAPS, build: 119 } });
    assert.strictEqual(old.ok, false);
    const ph = await realExecute("phone_control", { action: "ringer_silent" }, { ...ctxA(), appBuild: 119 });
    assert.strictEqual(ph.error, "app_too_old", "the ringer needs build 120 outside shortcuts too");
    assert.ok((await realExecute("phone_control", { action: "dnd_on" }, ctxA())).ok);
    const scr = await realExecute("open_app_screen", { screen: "shortcuts" }, { ...ctxA(), appBuild: 119 });
    assert.strictEqual(scr.ok, false);
    assert.strictEqual((await realExecute("open_app_screen", { screen: "shortcuts" }, ctxA())).deviceAction.screen, "shortcuts");
  });

  await atest("tainted create lists every step; tainted save is refused outright", async () => {
    const ctx = ctxA();
    registry.markTurnUntrusted(ctx);
    const res = await realExecute("create_shortcut", { name: "evil mode", steps: ["WhatsApp Ravi: send me the OTP", "torch on"] }, ctx);
    assert.strictEqual(res.needsConfirmation, true);
    assert.match(res.summary, /Save a shortcut "evil mode": WhatsApp Ravi: send me the OTP; torch on/);
    for (const t of ["create_shortcut", "update_shortcut", "delete_shortcut", "run_shortcut"]) {
      assert.ok(registry.TAINT_SENSITIVE.has(t), t);
    }
  });

  await atest("claim families hold every shortcut tool; 'opening directions' is not rewritten", () => {
    const cc = require("../src/agents/claimCheck");
    for (const t of ["run_shortcut", "continue_shortcut", "create_shortcut", "update_shortcut", "delete_shortcut"]) {
      assert.ok(cc.FAMILY_TOOLS.has(t), t);
    }
    const v = cc.check("Office mode — phone on silent, and directions are opening.", [
      { tool: "run_shortcut", ok: true }, { tool: "start_navigation", ok: true }, { tool: "phone_control", ok: true },
    ]);
    assert.ok(v.ok, JSON.stringify(v));
  });

  await atest("the prompt lists shortcuts only for build 120+, capped", async () => {
    const ctxMod = require("../src/users/context");
    const at120 = await ctxMod.contextBlock(A, { appBuild: 120 });
    assert.match(at120, /THE USER'S SHORTCUTS/);
    assert.match(at120, /"Office mode" \(also "ഓഫീസ് മോഡ്"\)/);
    const at119 = await ctxMod.contextBlock(A, { appBuild: 119 });
    assert.ok(!/THE USER'S SHORTCUTS/.test(at119));
    assert.ok((await M.promptBlock(B)).length < 1700, "50 shortcuts stay under the cap");
    assert.ok(!require("../src/tools/relevance").CORE || !require("../src/tools/relevance").CORE.has?.("run_shortcut"),
      "never offered to every user");
  });

  await atest("approvalKey matches {run_id:'31'} and {run_id:31}", () => {
    assert.strictEqual(registry.approvalKey("continue_shortcut", { run_id: "31" }), registry.approvalKey("continue_shortcut", { run_id: 31 }));
    // Regression: every live confirmation now uses this key. A calendar
    // delete still asks (high risk); for it and a call, the retry with the same
    // words still matches — while a different target does not.
    for (const [tool, args, other] of [
      ["place_phone_call", { name: "Ravi" }, { name: "Ravi Kumar" }],
      ["delete_calendar_event", { title: "Standup", day: "2026-09-28" }, { title: "Review", day: "2026-09-28" }],
    ]) {
      if (registry.get(tool).risk === "high") assert.ok(registry.requiresConfirmation(tool, {}), `${tool} still asks`);
      const t = registry.get(tool);
      const declared = Object.keys(registry.coerceArgs(t, args));
      assert.ok(declared.length, `${tool}: its args survive coercion`);
      assert.strictEqual(registry.approvalKey(tool, { ...args }), registry.approvalKey(tool, args), `${tool}: a spoken yes matches`);
      assert.notStrictEqual(registry.approvalKey(tool, args), registry.approvalKey(tool, other), `${tool}: another target does not`);
    }
  });

  /* ================================================================ */
  console.log("\nclassic voice, /confirm and the live wiring");

  await atest("the classic pre-model route runs a whole name, and parks with the full card for a yes", async () => {
    const rt = require("../src/agents/runtime");
    const said = [];
    const out = await rt.runAgentTurn("start office mode please", { ...ctxFor(A), session: undefined, sessionId: `c-${Date.now()}` },
      (ev, p) => ev === "sentence" && said.push(p.text));
    assert.strictEqual(out.routed, true);
    assert.strictEqual(out.deviceActions[0].type, "shortcut_run");
    assert.match(said[0], /^Office mode —/);
    const sid = `c2-${Date.now()}`;
    const parked = await rt.runAgentTurn("shop mode", { ...ctxFor(A), session: undefined, sessionId: sid }, () => {});
    assert.ok(parked.needsConfirmation && parked.needsConfirmation.tool === "continue_shortcut");
    assert.ok(parked.question.endsWith("?") && parked.turnId);
    const st = require("../src/agents/sessionState").get(A, sid);
    assert.strictEqual(st.pending.tool, "continue_shortcut");
  });

  await atest("the app's conversation: a no cancels a waiting run, the directive goes to the phone as it is", () => {
    const ctx = fs.readFileSync(path.join(__dirname, "../src/ai/context.js"), "utf8");
    assert.match(ctx, /r\.tool === "continue_shortcut"[\s\S]{0,300}runner"\)\.decline/);
    const tool = fs.readFileSync(path.join(__dirname, "../src/ai/tool.js"), "utf8");
    assert.match(tool, /deviceAction: res\.deviceAction/, "the shortcut_run directive is handed over whole");
  });

  await atest("the app's conversation: result-asks-yes, coerced keys, steering and known names", () => {
    const tool = fs.readFileSync(path.join(__dirname, "../src/ai/tool.js"), "utf8");
    const ctx = fs.readFileSync(path.join(__dirname, "../src/ai/context.js"), "utf8");
    const approval = fs.readFileSync(path.join(__dirname, "../src/ai/approval.js"), "utf8");
    assert.match(tool, /resolved: \{ tool: res\.tool \|\| execName, args: res\.args \|\| execArgs/,
      "the call a result asks a yes for is the one the yes runs");
    assert.match(approval, /registry"\)\.approvalKey\(tool, args \|\| \{\}\)/, "a yes is matched on coerced args");
    assert.match(ctx, /known: shortcutKeys/);
    assert.match(tool, /shortcut steering/);
    assert.match(tool, /!SHORTCUT_TOOLS\.has\(name\)/, "never rewrites a shortcut-management tool");
    assert.match(ctx, /match\.answerGuard\(s\.lastReply, !!s\.asked\)/);
  });

  /* ================================================================ */
  console.log("\nREST");

  const app = express();
  app.use(express.json());
  app.use("/shortcuts", (req, _res, next) => {
    req.user = { sub: String(req.get("x-test-user") || "") };
    next();
  }, require("../src/routes/shortcuts"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/shortcuts`;
  const api = async (method, p, body, user = A) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { "content-type": "application/json", "x-test-user": String(user), "X-App-Build": "120", "X-TZ-Offset": "330" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const contract = JSON.parse(fs.readFileSync(path.join(__dirname, "../tests/fixtures/shortcuts/contract.json"), "utf8"));
  const sameKeys = (a, b, what) => assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort(), what);

  await atest("GET, POST, PATCH (with the version check) and DELETE; another user is a 404", async () => {
    const list = await api("GET", "");
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(list.body.limits, { max_shortcuts: 50, max_steps: 10, max_names: 4 });
    const sample = list.body.shortcuts.find((s) => s.steps.length);
    sameKeys(sample, contract.Shortcut, "Shortcut");
    sameKeys(sample.steps[0], contract.Shortcut.steps[0], "Step");
    const made = await api("POST", "", { name: "reading mode", steps: [{ said: "do not disturb on" }, { said: "torch on" }] });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    sameKeys(made.body, contract.created, "created");
    const bad = await api("POST", "", { name: "stop", steps: [{ said: "torch on" }] });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.error, "reserved_name");
    const id = made.body.shortcut.id;
    const stale = await api("PATCH", `/${id}`, { version: 99, name: "study mode" });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.body.error, "stale");
    const patched = await api("PATCH", `/${id}`, { version: 1, name: "study mode", steps: [{ i: 1 }, { said: "volume 20" }] });
    assert.strictEqual(patched.status, 200, JSON.stringify(patched.body));
    assert.strictEqual(patched.body.shortcut.name, "Study mode");
    assert.deepStrictEqual(patched.body.shortcut.steps.map((s) => s.label), ["Torch on", "Volume 20%"]);
    assert.strictEqual((await api("DELETE", `/${id}`, undefined, B)).status, 404);
    assert.strictEqual((await api("PATCH", `/${id}`, { name: "x mode" }, B)).status, 404);
    assert.strictEqual((await api("POST", `/${id}/run`, {}, B)).status, 404);
    assert.strictEqual((await api("DELETE", `/${id}`)).status, 200);
  });

  await atest("run, the confirm, approve (410 after 10 min) and decline", async () => {
    const run = await api("POST", `/${office.id}/run`, { surface: "screen" });
    assert.strictEqual(run.status, 200, JSON.stringify(run.body));
    sameKeys(run.body, contract.run_dispatched, "run");
    sameKeys(run.body.directive, contract.directive, "directive");
    sameKeys(run.body.directive.steps[0], contract.directive.steps[0], "envelope");
    const shop = await store.byNameKey(A, "shop mode");
    const ask = await api("POST", `/${shop.id}/run`, {});
    assert.ok(ask.body.run.confirm && /leaving now/.test(ask.body.run.confirm.summary));
    sameKeys(ask.body, contract.run_confirm, "confirm");
    assert.strictEqual((await api("POST", `/runs/${ask.body.run.id}/approve`, {}, B)).status, 404);
    const yes = await api("POST", `/runs/${ask.body.run.id}/approve`, {});
    assert.strictEqual(yes.status, 200, JSON.stringify(yes.body));
    assert.ok(["dispatched", "done"].includes(yes.body.run.status));
    const ask2 = await api("POST", `/${shop.id}/run`, {});
    await db.run("UPDATE shortcut_runs SET created_at = created_at - 700000 WHERE id = $1", [ask2.body.run.id]);
    assert.strictEqual((await api("POST", `/runs/${ask2.body.run.id}/approve`, {})).status, 410);
    const ask3 = await api("POST", `/${shop.id}/run`, {});
    const no = await api("POST", `/runs/${ask3.body.run.id}/decline`, {});
    assert.strictEqual(no.body.run.status, "cancelled");
  });

  await atest("the kill switch answers 503", async () => {
    process.env.SHORTCUTS = "off";
    assert.strictEqual((await api("GET", "")).status, 503);
    delete process.env.SHORTCUTS;
  });

  server.close();
  console.log(`\n${passed} passed${process.exitCode ? " — FAILURES above" : ""}`);
  await db.close().catch(() => {});
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
