/**
 * THE PHONE'S MODEL, ANSWERED BY THE SERVER — `npm run test:proxy`.
 *
 * Gemini's request shape in, Gemini's response shape out, OpenAI faked
 * underneath. Pins: text and tool calls come back as parts (streamed:
 * text as it comes, calls last); a spoken sentence becomes an audio part
 * with its tone as the manner; a recording becomes its transcript; a
 * fresh-facts question is grounded on our own search; the app's voice
 * names map to OpenAI voices; what the phone is told reflects the switch.
 */
process.env.OPENAI_API_KEY = "sk-test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://x@localhost:5432/x";
const assert = require("assert");
const P = require("../src/ai/proxy");

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); }
}
const realFetch = globalThis.fetch;
let calls = [];
function fake(handler) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ url: String(url), body, init });
    const r = await handler({ url: String(url), body, init });
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  };
}
const collect = () => { const out = []; return { out, emit: (j) => out.push(j) }; };

(async () => {
  try {
    await check("a reply with a tool call comes back as Gemini parts (not streamed)", async () => {
      fake(({ body }) => {
        assert.strictEqual(body.messages[0].role, "system");
        assert.match(body.messages[0].content, /be brief/);
        assert.strictEqual(body.tools[0].function.name, "set_timer");
        return { choices: [{ message: { content: "Done.", tool_calls: [{ id: "c1", type: "function", function: { name: "set_timer", arguments: '{"minutes":5}' } }] } }] };
      });
      const { out, emit } = collect();
      await P.generate({
        systemInstruction: { parts: [{ text: "be brief" }] },
        contents: [{ role: "user", parts: [{ text: "timer 5 minutes" }] }],
        tools: [{ functionDeclarations: [{ name: "set_timer", description: "d", parameters: { type: "OBJECT", properties: { minutes: { type: "INTEGER" } } } }] }],
      }, { stream: false, emit });
      assert.strictEqual(out.length, 1);
      const parts = out[0].candidates[0].content.parts;
      assert.deepStrictEqual(parts, [{ text: "Done." }, { functionCall: { name: "set_timer", args: { minutes: 5 }, id: "c1" } }]);
      assert.strictEqual(out[0].candidates[0].finishReason, "STOP");
    });

    await check("streamed: the text as it comes, the calls in the last chunk", async () => {
      fake(() => new Response([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c7","function":{"name":"note","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
        "data: [DONE]", "",
      ].join("\n"), { status: 200 }));
      const { out, emit } = collect();
      await P.generate({ contents: [{ role: "user", parts: [{ text: "hi" }] }], tools: [{ functionDeclarations: [{ name: "note", parameters: { type: "object", properties: {} } }] }] }, { stream: true, emit });
      assert.deepStrictEqual(out.map((c) => c.candidates[0].content.parts), [[{ text: "Hel" }], [{ text: "lo" }], [{ functionCall: { name: "note", args: {}, id: "c7" } }]]);
      assert.strictEqual(out[2].candidates[0].finishReason, "STOP");
    });

    await check("a spoken sentence: the tone note becomes the manner, the audio comes back as a part", async () => {
      fake(({ url, body }) => {
        assert.match(url, /\/audio\/speech$/);
        assert.strictEqual(body.voice, "marin");
        assert.strictEqual(body.instructions, "warm, unhurried");
        assert.strictEqual(body.input, "Good morning, Sir.");
        return new Response(Buffer.alloc(2400), { status: 200 });
      });
      const { out, emit } = collect();
      await P.generate({
        contents: [{ role: "user", parts: [{ text: "<tone: warm, unhurried> Good morning, Sir." }] }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Fola" } } } },
      }, { stream: true, emit });
      const part = out[0].candidates[0].content.parts[0];
      assert.strictEqual(part.inlineData.mimeType, "audio/pcm;rate=24000");
      assert.strictEqual(Buffer.from(part.inlineData.data, "base64").length, 2400);
    });

    await check("a recording in the question becomes its transcript", async () => {
      fake(({ url, init }) => {
        assert.match(url, /\/audio\/transcriptions$/);
        assert.strictEqual(init.body.get("language"), "kn");
        return { text: "ನಮಸ್ಕಾರ" };
      });
      const { out, emit } = collect();
      await P.generate({
        contents: [{ role: "user", parts: [{ text: "Transcribe the speech. The speaker's usual language is kn-IN." }, { inlineData: { mimeType: "audio/wav", data: Buffer.alloc(100).toString("base64") } }] }],
      }, { stream: false, emit });
      assert.deepStrictEqual(out[0].candidates[0].content.parts, [{ text: "ನಮಸ್ಕಾರ" }]);
    });

    await check("a fresh-facts question is grounded on our search, with the pages as grounding chunks", async () => {
      const ws = require("../src/tools/webSearch");
      const realRun = ws.run;
      ws.run = async (q) => ({ ok: true, data: [
        { title: "Answer from a live web search (just now)", snippet: "The first flight is 6E 542 at 06:45.", url: "https://x.in/t", answer: true },
        { title: "IndiGo timetable", snippet: "", url: "https://x.in/t" },
      ] });
      fake(({ body }) => {
        assert.match(body.messages[0].content, /FRESH FACTS FROM THE WEB[\s\S]*6E 542 at 06:45[\s\S]*Sources: IndiGo timetable/);
        assert.ok(!body.tools, "no function tools on a search turn");
        return { choices: [{ message: { content: "The first flight is at 6:45." } }] };
      });
      try {
        const { out, emit } = collect();
        await P.generate({ contents: [{ role: "user", parts: [{ text: "first flight to Bangalore?" }] }], tools: [{ googleSearch: {} }] }, { stream: false, emit });
        const c = out[0].candidates[0];
        assert.deepStrictEqual(c.content.parts, [{ text: "The first flight is at 6:45." }]);
        assert.deepStrictEqual(c.groundingMetadata.groundingChunks, [{ web: { uri: "https://x.in/t", title: "IndiGo timetable" } }]);
      } finally {
        ws.run = realRun;
      }
    });

    await check("the app's voice names map to OpenAI voices; unknown names take the default", () => {
      assert.strictEqual(P.voiceFor("Fola"), "marin");
      assert.strictEqual(P.voiceFor("Charon"), "onyx");
      assert.strictEqual(P.voiceFor("verse"), "verse");
      assert.strictEqual(P.voiceFor("Nobody"), "marin");
      assert.deepStrictEqual(P.splitTone("<tone: firm> Pay by Friday."), { instructions: "firm", text: "Pay by Friday." });
      assert.deepStrictEqual(P.splitTone("Plain."), { instructions: "", text: "Plain." });
    });

    await check("the served config says openai and carries OpenAI names", async () => {
      const cfg = require("../src/ai/config");
      const out = await cfg.forUser(0, { build: 146 });
      assert.strictEqual(out.provider, "openai");
      assert.strictEqual(out.models.cloud, "gpt-4.1");
      assert.strictEqual(out.models.cloudFast, "gpt-4.1-mini");
      assert.strictEqual(out.models.tts, "gpt-4o-mini-tts");
      assert.ok(require("../src/services/ai/openai").VOICES.includes(out.models.ttsVoice), out.models.ttsVoice);
      assert.strictEqual(out.live.model, "gpt-realtime", "the fast voice runs on realtime");
      assert.ok(require("../src/services/ai/openai").VOICES.includes(out.live.voice), out.live.voice);
      // An app that predates the server port keeps Gemini's names.
      const old = await cfg.forUser(0, { build: 145 });
      assert.strictEqual(old.provider, "gemini");
      assert.match(old.models.cloud, /gemini/);
      assert.match(old.live.model, /gemini/);
      const saved = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      try {
        assert.strictEqual((await cfg.forUser(0, { build: 146 })).provider, "gemini");
      } finally {
        process.env.OPENAI_API_KEY = saved;
      }
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
