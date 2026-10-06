// GPT-LIVE END TO END (2026-10-06) — run before every app release that touches voice:
//   npm run e2e:gptlive        (real OpenAI calls, a few cents; needs OPENAI_API_KEY)
// Exits 1 unless a tool result is accepted AND the answer is spoken.
// It caught the production bug of build 163: "one moment", then nothing.
//
// A real GPT-Live session built by
// ai/gptLive.js, asked a spoken question that needs a tool; the function
// call is answered exactly as the phone does (response.item.create +
// response.create). Every event is logged with its time.
const B = require("path").join(__dirname, "..", "src");
const openai = require(`${B}/services/ai/openai`);
const gptLive = require(`${B}/ai/gptLive`);
const WebSocket = require("ws");

const QUESTION = process.argv[2] || "What is the weather in Bengaluru right now?";
const tools = [
  { name: "get_weather", description: "Current weather for a place.", parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] } },
  { name: "recall_memory", description: "Look up what the user saved before.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];
const built = gptLive.sessionConfig({ profile: { user: { gender: "male" }, assistant: { name: "Zara" } }, tools, instructions: "The user lives in Bengaluru." });
const session = { ...built.session, audio: { ...built.session.audio, format: { type: "audio/pcm", rate: 24000 } } };

(async () => {
  const q = await openai.speak(QUESTION, { format: "pcm" });
  const pcm = Buffer.isBuffer(q) ? q : Buffer.from(q.buffer || q.audio || q);
  const ws = new WebSocket("wss://api.openai.com/v1/live/sessions", { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
  const t0 = Date.now();
  const log = (...a) => console.log(String(Date.now() - t0).padStart(6), ...a);
  let said = "", heard = "", ev = 0;
  const send = (o) => ws.send(JSON.stringify({ event_id: `e${++ev}`, ...o }));
  const quiet = Buffer.alloc(4800);
  let pump;
  let errors = 0, answered = false, toolSent = false;
  const end = (why) => { log("END", why, "| heard:", JSON.stringify(heard.trim()), "| said:", JSON.stringify(said.trim())); clearInterval(pump); try { send({ type: "session.close" }); } catch (_) {} const ok = toolSent && answered && errors === 0; console.log(ok ? "E2E PASSED: the tool result was accepted and the answer was spoken" : `E2E FAILED: toolSent=${toolSent} answered=${answered} errors=${errors}`); setTimeout(() => process.exit(ok ? 0 : 1), 800); };
  setTimeout(() => end("timeout 45s"), 45000);
  ws.onopen = () => send({ type: "session.start", session });
  ws.onmessage = async (m) => {
    const e = JSON.parse(m.data);
    switch (e.type) {
      case "session.started":
        log("session.started");
        for (let i = 0; i < pcm.length; i += 4800) { ws.send(JSON.stringify({ type: "session.input_audio.append", audio: pcm.subarray(i, i + 4800).toString("base64") })); await new Promise((r) => setTimeout(r, 100)); }
        pump = setInterval(() => ws.send(JSON.stringify({ type: "session.input_audio.append", audio: quiet.toString("base64") })), 100);
        log("question sent:", QUESTION);
        break;
      case "session.input_transcript.delta": heard += e.delta; break;
      case "session.output_transcript.delta": if (!said) log("first words"); said += e.delta; if (toolSent && /27/.test(said + e.delta) && !answered) { answered = true; setTimeout(() => end("answered"), 1500); } break;
      case "session.output_audio.delta": break;
      case "session.delegation.created": log("delegation.created", JSON.stringify(e.delegation)); break;
      case "response.event": {
        const r = e.event || {};
        if (r.type === "response.output_item.done" && r.item && r.item.type === "function_call") {
          log("FUNCTION CALL", r.item.name, r.item.arguments);
          const out = r.item.name === "get_weather" ? { ok: true, result: { location: "Bengaluru", tempC: 27, sky: "partly cloudy" } } : { ok: true, result: { facts: ["Dr Nimmy H Shetty, dentist, Nandi Durga Road"] } };
          send({ type: "response.item.create", item: { type: "function_call_output", call_id: r.item.call_id, output: JSON.stringify(out) } });
          send({ type: "response.create" });
          log("result + response.create sent"); toolSent = true;
        } else if (["response.created", "response.completed", "response.failed", "response.incomplete"].includes(r.type)) {
          const resp = r.response || {};
          log("backend", r.type, resp.status || "", resp.incomplete_details ? JSON.stringify(resp.incomplete_details) : "", resp.error ? JSON.stringify(resp.error) : "", resp.usage ? `out=${resp.usage.output_tokens} in=${resp.usage.input_tokens}` : "");
        } else if (r.type === "error" || r.type === "response.error") log("backend ERROR", JSON.stringify(r).slice(0, 300));
        break;
      }
      case "error": errors++; log("ERROR", JSON.stringify(e.error)); break;
      case "session.closed": log("closed", e.reason); break;
      default: if (!/usage|appended|delta/.test(e.type)) log(e.type);
    }
  };
})().catch((e) => { console.log("FAILED", e.message); process.exit(1); });



