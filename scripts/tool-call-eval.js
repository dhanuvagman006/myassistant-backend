#!/usr/bin/env node
/**
 * TOOL-CALL EVAL (2026-10-01). Forty-odd real spoken requests, taken from
 * Conversations, each with the tool the assistant must call (or none).
 * The exact Live session is rebuilt — the gated spoken rules and the
 * capped Live tool declarations for an Android phone on the current
 * build — and a text Gemini model with the same instruction and tools
 * says what it would call. Run before and after a prompt change:
 *
 *   OPENAI_API_KEY=… node scripts/tool-call-eval.js            # gated rules (what ships)
 *   OPENAI_API_KEY=… node scripts/tool-call-eval.js --ungated  # the old full prompt
 *   EVAL_MODEL=gpt-4.1-mini … --only=12,17                    # a subset
 *
 * It needs a key, so it is not in test:all. Exit 1 when below EVAL_MIN
 * (default 85 %).
 */
const vp = require("../src/ai/voicePrompt");
const registry = require("../src/tools/registry");
require("../src/agents/runtime");
const live = require("../src/ai/liveTools");

// OpenAI since 2026-10-02 (the provider switch): the same instruction and
// tools go to the text model the brain uses, so the eval measures what ships.
const openai = require("../src/services/ai/openai");
if (!openai.ready()) {
  console.error("OPENAI_API_KEY is required");
  process.exit(2);
}
const MODEL = process.env.EVAL_MODEL || openai.models.chat();
const UNGATED = process.argv.includes("--ungated");
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7)
  .split(",").filter(Boolean).map(Number);
const MIN = Number(process.env.EVAL_MIN || 85);

const CASES = require("./tool-cases");

// The client's kind of phone: Android, current build, the usual grants.
const CAPS = {
  platform: "android", build: 142,
  granted: ["contacts", "phone", "microphone", "camera", "location", "notifications", "call_log", "install_packages"],
  denied: ["sms"],
};

function schema(s) {
  if (!s || typeof s !== "object") return undefined;
  const out = {};
  if (s.type) out.type = String(s.type).toUpperCase();
  if (s.description) out.description = String(s.description).slice(0, 1000);
  if (s.enum) out.enum = s.enum.map(String);
  if (s.nullable) out.nullable = true;
  if (s.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = schema(v);
  }
  if (Array.isArray(s.required) && s.required.length) out.required = s.required;
  if (s.items) out.items = schema(s.items);
  return out;
}

// EVAL_ENGINE=realtime: the voice model itself (gpt-realtime), one fresh
// session per case with text output — what the phone's fast voice runs on.
const ENGINE = process.env.EVAL_ENGINE || "chat";
async function askRealtime(system, decls, text) {
  const secret = await openai.realtimeClientSecret({ instructions: system, tools: decls, voice: "marin" });
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(secret.model)}`,
      { headers: { Authorization: `Bearer ${secret.value}` } });
    const calls = [], args = [];
    let said = "";
    const done = (v, err) => { clearTimeout(timer); try { ws.close(); } catch (_) {} err ? reject(err) : resolve(v); };
    const timer = setTimeout(() => done(null, new Error("realtime timeout")), 40_000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } }));
      ws.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["text"] } }));
    };
    ws.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "response.function_call_arguments.done") {
        calls.push(e.name);
        try { args.push(JSON.parse(e.arguments || "{}")); } catch (_) { args.push({}); }
      } else if (e.type === "response.output_text.delta" || e.type === "response.output_audio_transcript.delta") {
        said += e.delta || "";
      } else if (e.type === "error") {
        done(null, new Error(JSON.stringify(e.error).slice(0, 200)));
      } else if (e.type === "response.done") {
        const st = e.response && e.response.status;
        if (st && st !== "completed") {
          const why = JSON.stringify((e.response && e.response.status_details) || {});
          return done(null, Object.assign(new Error(`response ${st} ${why.slice(0, 160)}`), { rateLimited: /rate|limit|quota/i.test(why) }));
        }
        done({ calls, args, said: said.trim() });
      }
    };
    ws.onerror = (e) => done(null, new Error(`socket: ${e.message || e.type}`));
  });
}

async function ask(system, decls, text) {
  if (ENGINE === "realtime") {
    for (let attempt = 0; ; attempt++) {
      try {
        return await askRealtime(system, decls, text);
      } catch (e) {
        // ~18k tokens a session against the account's tokens-per-minute.
        if (!e.rateLimited || attempt >= 3) throw e;
        await new Promise((res) => setTimeout(res, 30_000));
      }
    }
  }
  const out = await openai.chat({
    model: MODEL, system, messages: [{ role: "user", content: text }],
    declarations: decls, temperature: 0.2, maxTokens: 200, timeoutMs: 60_000,
  });
  return {
    calls: out.functionCalls.map((c) => c.name),
    args: out.functionCalls.map((c) => c.args || {}),
    said: String(out.text || "").trim(),
  };
}

(async () => {
  const names = live.liveNames(registry.list());
  const decls = live.capDeclarations(
    registry.declarations({ deviceCaps: CAPS, only: names }), names);
  const declared = decls.map((d) => d.name);
  const system =
    vp.liveRules("Assistant", "Kannada", CAPS.build, UNGATED ? {} : { declared }) +
    "\n\n" + vp.RESOLVE_REFERENCES + "\n\n" + vp.nowLine(330);
  const fds = decls.map((d) => ({
    name: d.name, description: String(d.description || "").slice(0, 2000),
    parameters: schema(d.parameters || d.inputSchema),
  }));
  console.log(`${ENGINE === "realtime" ? `engine realtime (${openai.models.realtime()})` : `model ${MODEL}`}; ${UNGATED ? "UNGATED" : "gated"} rules ${system.length} chars; ${declared.length} tools: ${declared.join(" ")}\n`);

  let pass = 0, n = 0;
  const fails = [];
  for (let i = 0; i < CASES.length; i++) {
    if (only.length && !only.includes(i + 1)) continue;
    const [text, want, expectArgs] = CASES[i];
    n++;
    // A breath between calls (EVAL_PACE_MS, default 300 ms).
    if (n > 1) await new Promise((res) => setTimeout(res, Number(process.env.EVAL_PACE_MS || 300)));
    let got;
    try {
      got = await ask(system, fds, text);
    } catch (e) {
      got = { calls: [], said: `ERROR ${e.message}` };
    }
    const first = got.calls[0] || null;
    let ok = want.length
      ? want.includes(first) || (want.includes("stay_silent") && got.calls.length === 0)
      : got.calls.length === 0;
    // Named arguments must match too (e.g. the call's tone).
    if (ok && expectArgs) {
      const a = (got.args || [])[0] || {};
      for (const [k, rx] of Object.entries(expectArgs)) {
        if (!rx.test(String(a[k] || ""))) { ok = false; got.said = `${k}=${JSON.stringify(a[k] || "")} ${got.said}`; }
      }
    }
    if (ok) pass++;
    else fails.push(i + 1);
    console.log(`${ok ? " ok " : "FAIL"} ${String(i + 1).padStart(2)} ${text.slice(0, 58).padEnd(58)} -> ${(first || "(no tool)").padEnd(22)} want ${want.join("|") || "(none)"}${ok ? "" : `  said: ${got.said.slice(0, 90)}`}`);
  }
  const pct = Math.round((100 * pass) / n);
  console.log(`\n${pass}/${n} = ${pct}%${fails.length ? `  failed: ${fails.join(",")}` : ""}`);
  process.exit(pct >= MIN ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
