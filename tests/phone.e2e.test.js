/**
 * PHONE BRIDGE TESTS — `npm run test:phone`.
 *
 * The call itself cannot be tested without a funded Plivo account, so
 * these cover everything that does NOT need a carrier: the XML Plivo is
 * handed, the brief the agent carries, and the audio formats that have to
 * line up with Gemini Live on both legs.
 *
 * The formats are worth pinning. Plivo lets contentType be chosen per
 * stream; Gemini Live consumes 16 kHz PCM and emits 24 kHz. Getting either
 * wrong produces a call that connects, bills, and sounds like static —
 * which is exactly the kind of failure nobody notices until a client is on
 * the line.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const assert = require("assert");
const db = require("../src/db");
const stream = require("../src/phone/plivoStream");
const brief = require("../src/phone/callBrief");

let passed = 0;
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
}

(async () => {
  console.log("\nthe XML Plivo is handed");

  await atest("the stream is bidirectional — anything else is listen-only", () => {
    const xml = stream.streamXml("wss://x/phone/plivo/1/t", "https://x/status");
    // Without this attribute Plivo streams the caller to us and plays
    // nothing back. The call would connect, bill, and be one-way.
    assert.match(xml, /bidirectional="true"/);
    // Plivo rejects audioTrack outbound/both when bidirectional is on.
    assert.match(xml, /audioTrack="inbound"/);
    // The conversation IS the call: without this the call ends when the
    // XML document does.
    assert.match(xml, /keepCallAlive="true"/);
    assert.match(xml, /<Stream [^>]*>wss:\/\/x\/phone\/plivo\/1\/t<\/Stream>/);
  });

  await atest("the audio formats match Gemini Live on both legs", () => {
    assert.strictEqual(stream.IN_RATE, 16000, "Gemini Live consumes 16 kHz PCM");
    assert.strictEqual(stream.OUT_RATE, 24000, "Gemini Live emits 24 kHz PCM");
    const xml = stream.streamXml("wss://x/a/b", "");
    // L16, not mu-law: asking for the rate Gemini already speaks means no
    // transcode and no resampling on either leg.
    assert.match(xml, /contentType="audio\/x-l16;rate=16000"/);
    assert.doesNotMatch(xml, /mulaw/i, "mu-law would cost a decode and two resamples per frame");
  });

  await atest("a missing status callback does not emit an empty attribute", () => {
    const xml = stream.streamXml("wss://x/a/b", "");
    assert.doesNotMatch(xml, /statusCallbackUrl=""/);
  });

  console.log("\nwhat the agent carries onto the call");

  await atest("the brief names the task and who is being called", async () => {
    const p = await brief.build(43, {
      task: "Ask the dealer for the price of an X5 and negotiate",
      contactName: "Rajesh",
    });
    assert.match(p, /price of an X5/);
    assert.match(p, /Rajesh/);
  });

  await atest("it must never pretend to be the person it calls for", async () => {
    const p = await brief.build(43, { task: "ask about a price", contactName: "X" });
    assert.match(p, /on behalf of/i);
    assert.match(p, /Never pretend to be them/i);
  });

  await atest("it is forbidden from closing the deal", async () => {
    const p = await brief.build(43, { task: "negotiate a price", contactName: "X" });
    // An agent that can agree a price on a real call can do real damage.
    assert.match(p, /Do NOT agree a price/i);
    assert.match(p, /place an order|commit to/i);
    assert.match(p, /confirm with/i, "it must defer the decision back to the user");
  });

  await atest("it is forbidden from inventing preferences", async () => {
    const p = await brief.build(43, { task: "buy a car", contactName: "X" });
    // The whole point is that it speaks from memory; making things up
    // when memory is silent is worse than admitting it does not know.
    assert.match(p, /Do NOT invent/i);
    assert.match(p, /not sure/i);
  });

  await atest("it carries the user's own memory, not a separate store", async () => {
    const fs = require("fs");
    const src = fs.readFileSync(__dirname + "/../src/phone/callBrief.js", "utf8");
    // memoryBlock is what already gives the in-app conversation its
    // personal context. A second store would drift out of step.
    assert.match(src, /memory\.memoryBlock\(userId\)/);
  });

  await atest("a call still goes out when memory is unavailable", async () => {
    const memory = require("../src/agents/memory");
    const real = memory.memoryBlock;
    memory.memoryBlock = async () => { throw new Error("db down"); };
    const p = await brief.build(43, { task: "ask a question", contactName: "X" });
    memory.memoryBlock = real;
    assert.ok(p.length > 100, "the brief must survive a memory failure");
    assert.match(p, /ask a question/, "the task is the one thing it cannot lose");
  });

  console.log("\nbarge-in");

  await atest("the bridge clears queued audio when talked over", () => {
    const fs = require("fs");
    const src = fs.readFileSync(__dirname + "/../src/phone/plivoStream.js", "utf8");
    // Gemini reports `interrupted`; Plivo's clearAudio discards what is
    // queued. Without it the agent talks over someone answering it.
    assert.match(src, /sc\.interrupted/);
    assert.match(src, /event: "clearAudio"/);
    assert.match(src, /streamId/);
  });

  await atest("the app's own voice path was not touched", () => {
    const fs = require("fs");
    const proxy = fs.readFileSync(__dirname + "/../src/live/proxy.js", "utf8");
    // The phone bridge is deliberately separate: live/proxy.js is the
    // microphone path and is coupled to the app's event protocol.
    assert.doesNotMatch(proxy, /plivoStream|callBrief/,
      "the phone feature must not reach into the app's live path");
  });

  await new Promise((r) => setTimeout(r, 200));
  await db.close();
  console.log(`\n${passed} checks passed`);
})();
