/**
 * READ-BACK AND CALL LANGUAGE — `npm run test:readback`.
 *
 * The client, 2026-09-26: a call he asked to leave a message in Malayalam
 * "speaks in a different Chinese language", and "the calls or messages if
 * my assistant conveys wrong then people will not like it". These pin:
 *   - a call that delivers words, or a message to another person, goes
 *     out only after the exact words were read back and the user said yes
 *     (in any of the product's languages);
 *   - changed words, a "no", or the model confirming in the same breath
 *     are a fresh read-back;
 *   - the call's language is worked out and sent to the calling service,
 *     with the message given as written.
 * The calling service is stubbed: no call is ever placed.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const assert = require("assert");

let passed = 0;
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
}

const rb = require("../src/agents/readBack");
const lang = require("../src/agents/callLanguage");

(async () => {
  console.log("\nsaying yes");
  await atest("a plain yes, in every language the product serves", () => {
    for (const w of ["yes", "Yes, go ahead", "ok", "haan", "haan ji, bhejo", "हाँ", "जी",
      "ശരി", "അതെ", "ഉവ്വ്", "ಹೌದು", "ಸರಿ", "சரி", "ஆமாம்", "సరే", "అవును", "call him"]) {
      assert.ok(rb.saysYes(w), `"${w}" is a yes`);
    }
  });
  await atest("a no, a wait or a correction is never a yes", () => {
    for (const w of ["no", "no wait", "yes but make it 6 pm", "don't", "illa", "ഇല്ല", "വേണ്ട",
      "नहीं", "ಬೇಡ", "change it", "call Ravi and tell him that I will be late today"]) {
      assert.ok(!rb.saysYes(w), `"${w}" is not a yes`);
    }
  });

  console.log("\nthe read-back");
  const U = 990061;
  const ask = (over = {}) => rb.mayGo({
    userId: U, kind: "call", parts: ["Ravi", "I will be late"],
    confirmed: false, userText: "call Ravi and tell him I will be late", ...over,
  });
  await atest("the first time, nothing goes: it is read back", () => {
    rb._forget();
    assert.strictEqual(ask(), false);
  });
  await atest("confirmed in the same breath, with nothing new said, is read back again", () => {
    rb._forget();
    ask();
    assert.strictEqual(ask({ confirmed: true }), false);
  });
  await atest("the same words, then a yes: it goes, once", () => {
    rb._forget();
    ask();
    assert.strictEqual(ask({ confirmed: true, userText: "yes" }), true);
    assert.strictEqual(ask({ confirmed: true, userText: "yes" }), false,
      "a second send needs its own read-back");
  });
  await atest("changed words are a new read-back", () => {
    rb._forget();
    ask();
    assert.strictEqual(ask({ confirmed: true, userText: "yes", parts: ["Ravi", "I will be late by an hour"] }), false);
  });
  await atest("a no keeps it from going", () => {
    rb._forget();
    ask();
    assert.strictEqual(ask({ confirmed: true, userText: "no, wait" }), false);
  });
  await atest("a Malayalam yes sends it", () => {
    rb._forget();
    ask({ parts: ["Amma", "ഞാൻ വൈകും"] });
    assert.strictEqual(ask({ parts: ["Amma", "ഞാൻ വൈകും"], confirmed: true, userText: "ശരി" }), true);
  });
  await atest("a scheduled run the user set up earlier is not asked again", () => {
    rb._forget();
    assert.strictEqual(ask({ unattended: true }), true);
  });

  console.log("\nthe call's language");
  await atest("named in the request, written in its script, or passed by the tool", () => {
    assert.deepStrictEqual(lang.resolve({ userText: "call amma and leave a message in Malayalam" }),
      { name: "Malayalam", code: "ml" });
    assert.deepStrictEqual(lang.resolve({ message: "ഞാൻ വൈകും" }), { name: "Malayalam", code: "ml" });
    assert.deepStrictEqual(lang.resolve({ message: "ನಾನು ತಡವಾಗಿ ಬರುತ್ತೇನೆ" }), { name: "Kannada", code: "kn" });
    assert.deepStrictEqual(lang.resolve({ requested: "Tamil" }), { name: "Tamil", code: "ta" });
    assert.deepStrictEqual(lang.resolve({ requested: "ml" }), { name: "Malayalam", code: "ml" });
    assert.strictEqual(lang.resolve({ message: "I will be late" }), null);
  });
  await atest("a call in another language is told so, and given the words as written", () => {
    const t = lang.taskFor("ഞാൻ വൈകും", { name: "Malayalam", code: "ml" });
    assert.match(t, /SPEAK ONLY MALAYALAM/);
    assert.match(t, /Never switch to English/);
    assert.ok(t.includes("«ഞാൻ വൈകും»"), "the words themselves, untouched");
    assert.strictEqual(lang.taskFor("I will be late", null), "I will be late");
  });

  console.log("\nthe tools");
  const db = require("../src/db");
  await db.init();
  process.env.BOLNA_API_KEY = process.env.BOLNA_API_KEY || "test-key";
  process.env.BOLNA_FROM_NUMBER = process.env.BOLNA_FROM_NUMBER || "+911234567890";
  process.env.BOLNA_AGENT_ID = process.env.BOLNA_AGENT_ID || "agent-test";
  process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://example.test";
  const registry = require("../src/tools/registry");
  require("../src/tools/builtins").registerBuiltins();
  const agentCall = require("../src/agents/agentCall");
  agentCall._resetTrouble && agentCall._resetTrouble();
  const call = registry.get("place_phone_call");

  await atest("a relayed call is read back first, then dials with its language", async () => {
    rb._forget();
    const args = { name: "Amma", message: "ഞാൻ ഇന്ന് വൈകും", language: "Malayalam" };
    const first = await call.execute(args, { userId: U, userText: "call amma and tell her in Malayalam I will be late" });
    assert.strictEqual(first.ok, false);
    assert.strictEqual(first.needs_confirmation, true);
    assert.strictEqual(first.deviceAction, undefined, "nothing dials before the yes");
    assert.strictEqual(first.data.read_back, "ഞാൻ ഇന്ന് വൈകും");
    assert.strictEqual(first.data.language, "Malayalam");
    assert.match(first.note, /question/);
    const second = await call.execute({ ...args, confirmed: true }, { userId: U, userText: "ശരി" });
    assert.strictEqual(second.deviceAction.type, "resolve_and_call");
    assert.strictEqual(second.deviceAction.language, "ml");
    assert.deepStrictEqual(lang.recall(U, "ഞാൻ ഇന്ന് വൈകും"), { name: "Malayalam", code: "ml" },
      "remembered for the app's /agent-call that follows");
  });
  await atest("a plain 'call Ravi' still just dials", async () => {
    const res = await call.execute({ name: "Ravi" }, { userId: U, userText: "call Ravi" });
    assert.strictEqual(res.deviceAction.type, "resolve_and_call");
  });

  await atest("the calling service is sent the language and the words to say", async () => {
    const realFetch = globalThis.fetch;
    let sent = null;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("bolna.ai/call")) {
        sent = JSON.parse(init.body);
        return new Response(JSON.stringify({ execution_id: "exec-rb-1" }), { status: 200 });
      }
      return realFetch(url, init);
    };
    try {
      lang.remember(U, "ഞാൻ ഇന്ന് വൈകും", { name: "Malayalam", code: "ml" });
      await agentCall.start({
        userId: U, userName: "Test", toNumber: "+919000000061", contactName: "Amma",
        task: "ഞാൻ ഇന്ന് വൈകും",
      });
      assert.ok(sent, "the call was sent to the stub");
      assert.strictEqual(sent.user_data.language, "Malayalam");
      assert.match(sent.user_data.task, /SPEAK ONLY MALAYALAM/);
      assert.ok(sent.user_data.task.includes("ഞാൻ ഇന്ന് വൈകും"));
    } finally {
      globalThis.fetch = realFetch;
      await db.run("DELETE FROM task_outcomes WHERE user_id=$1", [U]).catch(() => {});
    }
  });

  await atest("a number as the contact is addressed at once, never guessed at", async () => {
    // 2026-09-26: "call 6360139965 and tell him…" waited on a model to
    // guess a gender from the digits, the phone gave up after 20 s and
    // dialled the number itself.
    const vg = require("../src/users/voiceGender");
    const real = vg.nameGender;
    let asked = 0;
    vg.nameGender = () => { asked++; return new Promise(() => {}); }; // never answers
    try {
      const t0 = Date.now();
      const who = await agentCall._addressFor({ contactName: "6360139965", userName: "Dhanush" });
      assert.strictEqual(who.honorific, "sir");
      assert.strictEqual(asked, 0, "digits were sent to the name model");
      assert.ok(Date.now() - t0 < 500, "addressing a number took too long");
      const t1 = Date.now();
      await agentCall._addressFor({ contactName: "Ravi", userName: "Dhanush" });
      assert.ok(Date.now() - t1 < 3000, "a slow name guess held the call up");
    } finally {
      vg.nameGender = real;
    }
  });

  await atest("a message to another person is read back before it goes", async () => {
    rb._forget();
    const res = await registry.get("send_agent_message").execute(
      { contact_name: "Ravi", message: "I will be late" },
      { userId: U, userText: "tell Ravi I will be late" });
    assert.strictEqual(res.needs_confirmation, true);
    assert.strictEqual(res.data.read_back, "I will be late");
    assert.match(res.note, /NOTHING HAS BEEN SENT/);
  });

  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
