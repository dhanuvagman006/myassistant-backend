/**
 * OPENAI, THE ONE PROVIDER — `npm run test:openai`.
 *
 * The network is faked; these pin the shapes: the simple messages and
 * Gemini's content shape both become OpenAI messages (pictures, PDFs,
 * tool calls and their answers in the right order), declarations become
 * tools, a streamed answer is reassembled with its tool calls, a
 * recording is sent as a file with its language, speech comes back as
 * 24 kHz PCM, a picture comes back from base64, and a 429 is "busy".
 */
process.env.OPENAI_API_KEY = "sk-test";
const assert = require("assert");
const O = require("../src/services/ai/openai");

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); }
}

const realFetch = globalThis.fetch;
let last = null;
function fake(handler) {
  globalThis.fetch = async (url, init = {}) => {
    last = { url: String(url), init };
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    const r = await handler({ url: String(url), body, init });
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  };
}

(async () => {
  try {
    await check("simple messages: text, a picture and a PDF become parts", () => {
      const m = O.fromSimple("be brief", [
        { role: "user", content: "what is this?", images: [{ mime: "image/jpeg", data: Buffer.from("abc") }, { mime: "application/pdf", data: Buffer.from("pdf"), filename: "bill.pdf" }] },
        { role: "assistant", content: "A bill." },
      ]);
      assert.deepStrictEqual(m[0], { role: "system", content: "be brief" });
      assert.strictEqual(m[1].role, "user");
      assert.strictEqual(m[1].content[0].type, "image_url");
      assert.match(m[1].content[0].image_url.url, /^data:image\/jpeg;base64,YWJj$/);
      assert.strictEqual(m[1].content[1].type, "file");
      assert.strictEqual(m[1].content[1].file.filename, "bill.pdf");
      assert.deepStrictEqual(m[1].content[2], { type: "text", text: "what is this?" });
      assert.deepStrictEqual(m[2], { role: "assistant", content: "A bill." });
    });

    await check("Gemini's content shape: calls get ids, answers follow in order", () => {
      const m = O.fromContents("sys", [
        { role: "user", parts: [{ text: "call Ravi" }] },
        { role: "model", parts: [{ text: "On it." }, { functionCall: { name: "place_phone_call", args: { name: "Ravi" } } }, { functionCall: { name: "note", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { name: "place_phone_call", response: { ok: true } } }, { functionResponse: { name: "note", response: { ok: false } } }] },
        { role: "user", parts: [{ inline_data: { mime_type: "image/png", data: "QUJD" } }, { text: "and this?" }] },
      ]);
      assert.strictEqual(m[0].role, "system");
      assert.deepStrictEqual(m[1], { role: "user", content: "call Ravi" });
      assert.strictEqual(m[2].role, "assistant");
      assert.strictEqual(m[2].content, "On it.");
      assert.deepStrictEqual(m[2].tool_calls.map((c) => [c.id, c.function.name, c.function.arguments]),
        [["call_1", "place_phone_call", '{"name":"Ravi"}'], ["call_2", "note", "{}"]]);
      assert.deepStrictEqual(m[3], { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' });
      assert.deepStrictEqual(m[4], { role: "tool", tool_call_id: "call_2", content: '{"ok":false}' });
      assert.strictEqual(m[5].role, "user");
      assert.strictEqual(m[5].content[0].type, "image_url");
      assert.deepStrictEqual(m[5].content[1], { type: "text", text: "and this?" });
    });

    await check("declarations become tools with lower-case JSON schema types", () => {
      const t = O.toTools([{ name: "x", description: "d", parameters: { type: "OBJECT", properties: { n: { type: "STRING", nullable: true }, k: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["n"] } }]);
      assert.deepStrictEqual(t, [{ type: "function", function: { name: "x", description: "d", parameters: { type: "object", properties: { n: { type: "string" }, k: { type: "array", items: { type: "integer" } } }, required: ["n"] } } }]);
    });

    await check("a reply with a tool call, and json mode", async () => {
      fake(({ url, body }) => {
        assert.match(url, /\/chat\/completions$/);
        assert.strictEqual(body.model, "gpt-4.1");
        assert.strictEqual(body.response_format.type, "json_object");
        return { model: "gpt-4.1-mini", usage: { total_tokens: 9 }, choices: [{ finish_reason: "tool_calls", message: { content: '{"a":1}', tool_calls: [{ id: "c1", type: "function", function: { name: "note", arguments: '{"text":"hi"}' } }] } }] };
      });
      const out = await O.chat({ messages: [{ role: "user", content: "x" }], system: "s", json: true, declarations: [{ name: "note", parameters: { type: "object", properties: {} } }] });
      assert.strictEqual(out.text, '{"a":1}');
      assert.deepStrictEqual(out.functionCalls, [{ name: "note", args: { text: "hi" }, id: "c1" }]);
      assert.strictEqual(out.usage.total_tokens, 9);
      assert.strictEqual(last.init.headers.authorization, "Bearer sk-test");
    });

    await check("a streamed reply is reassembled, text delivered as it comes, tool calls joined", async () => {
      const lines = [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c9","function":{"name":"set_","arguments":"{\\"a\\":"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"timer","arguments":"1}"}}]},"finish_reason":"tool_calls"}]}',
        'data: {"usage":{"total_tokens":4},"choices":[]}',
        "data: [DONE]",
      ].join("\n") + "\n";
      fake(() => new Response(lines, { status: 200, headers: { "content-type": "text/event-stream" } }));
      const deltas = [];
      const out = await O.chat({ messages: [{ role: "user", content: "x" }], stream: true, onDelta: (d) => deltas.push(d) });
      assert.deepStrictEqual(deltas, ["Hel", "lo"]);
      assert.strictEqual(out.text, "Hello");
      assert.deepStrictEqual(out.functionCalls, [{ name: "set_timer", args: { a: 1 }, id: "c9" }]);
      assert.strictEqual(out.usage.total_tokens, 4);
    });

    await check("a recording goes up as a file with its language; raw pcm is wrapped", async () => {
      fake(({ url, init }) => {
        assert.match(url, /\/audio\/transcriptions$/);
        assert.ok(init.body instanceof FormData);
        assert.strictEqual(init.body.get("model"), "gpt-4o-transcribe");
        assert.strictEqual(init.body.get("language"), "kn");
        const f = init.body.get("file");
        assert.strictEqual(f.name, "audio.wav");
        return { text: " ನಮಸ್ಕಾರ " };
      });
      const out = await O.transcribe(Buffer.alloc(3200), "audio/pcm;rate=16000", { language: "kn" });
      assert.deepStrictEqual(out, { text: "ನಮಸ್ಕಾರ", language: "kn" });
      const wav = O.wavWrap(Buffer.alloc(100), 16000);
      assert.strictEqual(wav.length, 144);
      assert.strictEqual(wav.toString("ascii", 0, 4), "RIFF");
    });

    await check("speech comes back as 24 kHz pcm with the manner asked for", async () => {
      fake(({ url, body }) => {
        assert.match(url, /\/audio\/speech$/);
        assert.strictEqual(body.voice, "marin");
        assert.strictEqual(body.response_format, "pcm");
        assert.strictEqual(body.instructions, "warm and unhurried");
        return new Response(Buffer.alloc(4800), { status: 200, headers: { "content-type": "audio/pcm" } });
      });
      const out = await O.speak("Hello there", { voice: "not-a-voice", instructions: "warm and unhurried" });
      assert.strictEqual(out.rate, 24000);
      assert.strictEqual(out.mime, "audio/pcm;rate=24000");
      assert.strictEqual(out.buffer.length, 4800);
    });

    await check("a picture made and a picture edited come back from base64; sizes follow the shape", async () => {
      const png = Buffer.from("89504e470d0a1a0a0000", "hex");
      fake(({ url, body, init }) => {
        if (/generations$/.test(url)) {
          assert.strictEqual(body.model, "gpt-image-1");
          assert.strictEqual(body.size, "1024x1536");
          return { data: [{ b64_json: png.toString("base64") }] };
        }
        assert.match(url, /\/images\/edits$/);
        assert.ok(init.body instanceof FormData);
        assert.strictEqual(init.body.get("size"), "1536x1024");
        assert.ok(init.body.getAll("image[]").length === 2);
        return { data: [{ b64_json: png.toString("base64") }] };
      });
      const made = await O.imageGenerate("a cat", { width: 1080, height: 1920 });
      assert.strictEqual(made.mime, "image/png");
      assert.deepStrictEqual(made.buffer, png);
      const edited = await O.imageEdit("add a hat", [{ buffer: png, mime: "image/png" }, { buffer: png, mime: "image/jpeg" }], { width: 1536, height: 864 });
      assert.deepStrictEqual(edited.buffer, png);
      assert.strictEqual(O.imageSize(0, 0), "1024x1024");
    });

    await check("a 429 is 'busy' and carries the status; no key is a plain error", async () => {
      fake(() => new Response('{"error":{"message":"rate"}}', { status: 429 }));
      await assert.rejects(O.chat({ messages: [{ role: "user", content: "x" }] }), (e) => O.isBusy(e) && e.status === 429);
      assert.strictEqual(O.busy(), true);
      const saved = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      try {
        assert.strictEqual(O.ready(), false);
        await assert.rejects(O.chat({ messages: [] }), /OPENAI_API_KEY is not set/);
      } finally {
        process.env.OPENAI_API_KEY = saved;
      }
    });

    await check("web search: one Responses call; the answer loses its inline citation markers, the sources are unique", async () => {
      fake(({ url, body }) => {
        assert.match(url, /\/responses$/);
        assert.strictEqual(body.tools[0].type, "web_search");
        assert.deepStrictEqual(body.tools[0].user_location, { type: "approximate", country: "IN", city: "Mangalore" });
        assert.deepStrictEqual(body.tool_choice, { type: "web_search" });
        assert.strictEqual(body.input, "first flight to Bangalore?");
        return { model: "gpt-4.1-mini", usage: { total_tokens: 100 }, output: [
          { type: "web_search_call", status: "completed", action: { type: "search", queries: ["first flight mangalore bangalore"], sources: [{ type: "url", url: "https://a.in/x?utm_source=openai", title: "A" }] } },
          { type: "message", content: [{ type: "output_text", text: "The first flight is 6E 542 at 8:45 AM. ([a.in](https://a.in/x?utm_source=openai)) It lands at 9:50. ([b.in](https://b.in/y))", annotations: [
            { type: "url_citation", url: "https://a.in/x?utm_source=openai", title: "A" }, { type: "url_citation", url: "https://b.in/y", title: "B" }] }] },
        ] };
      });
      const r = await O.webSearch("first flight to Bangalore?", { location: { country: "in", city: "Mangalore" } });
      assert.strictEqual(r.text, "The first flight is 6E 542 at 8:45 AM. It lands at 9:50.");
      assert.deepStrictEqual(r.sources, [{ title: "A", url: "https://a.in/x" }, { title: "B", url: "https://b.in/y" }]);
      assert.deepStrictEqual(r.queries, ["first flight mangalore bangalore"]);
    });

    await check("streamed speech arrives in whole samples; noise heard as a foreign script is dropped", async () => {
      fake(() => new Response(new ReadableStream({
        start(c) { c.enqueue(new Uint8Array(5001)); c.enqueue(new Uint8Array(30000)); c.enqueue(new Uint8Array(7)); c.close(); },
      }), { status: 200 }));
      const sizes = [];
      const r = await O.speakStream("Hello there.", { voice: "marin", onChunk: (b) => sizes.push(b.length) });
      assert.ok(sizes.every((n) => n % 2 === 0), String(sizes));
      assert.strictEqual(r.bytes, sizes.reduce((a, b) => a + b, 0));
      assert.strictEqual(r.bytes, 35008);
      assert.strictEqual(sizes[0], 5000);
      assert.strictEqual(O.plausibleTranscript("بخاطر", "kn"), false);
      assert.strictEqual(O.plausibleTranscript("はい。", "kn"), false);
      assert.strictEqual(O.plausibleTranscript("ನಮಸ್ಕಾರ, how are you", "kn"), true);
      assert.strictEqual(O.plausibleTranscript("नमस्ते", "en"), true);
      assert.strictEqual(O.plausibleTranscript("بخاطر", "ur"), true);
    });

    await check("the realtime key: pcm 24 kHz, semantic vad, input transcription, the voice, the tools", async () => {
      fake(({ url, body }) => {
        assert.match(url, /\/realtime\/client_secrets$/);
        const s = body.session;
        assert.strictEqual(s.model, "gpt-realtime");
        assert.strictEqual(s.instructions, "be kind");
        assert.strictEqual(s.audio.input.format.rate, 24000);
        assert.strictEqual(s.audio.input.turn_detection.type, "server_vad");
        assert.strictEqual(s.audio.input.turn_detection.silence_duration_ms, 800);
        assert.strictEqual(s.audio.input.turn_detection.interrupt_response, false, "only the button interrupts");
        assert.strictEqual(s.audio.input.noise_reduction.type, "near_field");
        assert.strictEqual(s.audio.input.transcription.model, "gpt-4o-transcribe");
        assert.strictEqual(s.audio.input.transcription.language, "kn");
        assert.match(s.audio.input.transcription.prompt, /Kannada and English/);
        assert.strictEqual(s.audio.output.voice, "sage");
        assert.deepStrictEqual(s.tools[0], { type: "function", name: "set_timer", description: "d", parameters: { type: "object", properties: { minutes: { type: "integer" } } } });
        return { value: "ek_1", expires_at: 1234 };
      });
      const out = await O.realtimeClientSecret({ voice: "sage", instructions: "be kind", language: "kn", silenceMs: 800, tools: [{ name: "set_timer", description: "d", parameters: { type: "OBJECT", properties: { minutes: { type: "INTEGER" } } } }] });
      assert.deepStrictEqual(out, { value: "ek_1", expiresAt: 1234, model: "gpt-realtime" });
      // English keeps its hint too: never left to guess (it guessed Urdu).
      fake(({ body }) => {
        assert.strictEqual(body.session.audio.input.transcription.language, "en");
        assert.match(body.session.audio.input.transcription.prompt, /English \(sometimes Kannada\)/);
        return { value: "ek_2", expires_at: 1 };
      });
      await O.realtimeClientSecret({ language: "en" });
    });

    await check("the router keeps its contracts on top: reply, stream, tools, transcript", async () => {
      const R = require("../src/services/ai/router");
      fake(({ url, body }) => {
        if (/transcriptions$/.test(url)) return { text: "hello" };
        if (body && body.stream) {
          return new Response('data: {"choices":[{"delta":{"content":"a"}}]}\ndata: {"choices":[{"delta":{"content":"b"}}]}\ndata: [DONE]\n', { status: 200 });
        }
        return { model: body.model, choices: [{ message: { content: "ok", tool_calls: [{ id: "1", type: "function", function: { name: "t", arguments: "{}" } }] } }] };
      });
      const r = await R.generateReply([{ role: "user", content: "hi" }]);
      assert.strictEqual(r.reply, "ok");
      assert.strictEqual(r.provider, "openai");
      const parts = [];
      for await (const d of R.generateReplyStream([{ role: "user", content: "hi" }])) parts.push(d);
      assert.deepStrictEqual(parts, ["a", "b"]);
      const t = await R.generateWithTools({ contents: [{ role: "user", parts: [{ text: "x" }] }], system: "s", declarations: [{ name: "t", parameters: { type: "object", properties: {} } }] });
      assert.deepStrictEqual(t.functionCalls.map((c) => c.name), ["t"]);
      assert.strictEqual(t.text, "ok");
      assert.deepStrictEqual(await R.transcribeAudio(Buffer.alloc(10), "audio/wav"), { text: "hello", language: "unknown" });
      assert.strictEqual(R.isGemini3("anything"), false);
      assert.strictEqual(R.chatModel(), "gpt-4.1");
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
