#!/usr/bin/env node
/**
 * EVERY TOOL, AS GPT-LIVE'S BACKEND SEES IT (2026-10-06, after build 163's
 * silent tool turns: "make sure nothing breaks next time"). Run before every
 * release that touches voice or tools:
 *
 *   npm run check:gptlive-tools            (real OpenAI calls, a few cents)
 *   CHECK_UID=54 npm run check:gptlive-tools   (whose data the safe tools read)
 *
 * Three layers, each must pass:
 *   1. ACCEPTED — the exact tool list a session is given (ai/gptLive.toolsFor
 *      over the gated catalogue, priority order, capped) goes to the delegated
 *      model in one Responses call; a refused schema fails here.
 *   2. CHOSEN — the shared spoken requests (tool-cases.js) go to the
 *      delegated model with the session's backend prompt; it must call a
 *      right tool. Pass mark CHECK_MIN (default 85 %).
 *   3. RUN — every tool that only READS (low risk, no device action, not a
 *      world action, not a memory write, not a draft edit) is executed for
 *      real on the server with arguments the model wrote for it. Tools that
 *      call, message, buy, book or change anything are never executed here;
 *      layers 1-2 cover them.
 * Exit 1 when any layer fails.
 */
require("../src/agents/runtime");
const registry = require("../src/tools/registry");
registry.seal({ strict: false });
const openai = require("../src/services/ai/openai");
const gptLive = require("../src/ai/gptLive");
const live = require("../src/ai/liveTools");
const CASES = require("./tool-cases");

if (!openai.ready()) {
  console.error("OPENAI_API_KEY is required");
  process.exit(2);
}
const MODEL = gptLive.delegateModel();
const MIN = Number(process.env.CHECK_MIN || 85);
const UID = Number(process.env.CHECK_UID || 0) || null;
const CAPS = {
  platform: "android", build: 164,
  granted: ["contacts", "phone", "microphone", "camera", "location", "notifications", "call_log", "install_packages"],
  denied: [],
};
const BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

async function responses(body) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${BASE}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, ...body }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 429 && attempt < 4) { await new Promise((s) => setTimeout(s, 5000 * (attempt + 1))); continue; }
    if (!r.ok) throw Object.assign(new Error((j.error && j.error.message) || `HTTP ${r.status}`), { status: r.status });
    return j;
  }
}
// OpenAI's hosted search shows as a web_search_call item: it counts as web_search.
const callsOf = (j) => (j.output || []).filter((o) => o.type === "function_call" || o.type === "web_search_call")
  .map((o) => o.type === "web_search_call"
    ? { name: "web_search", args: {} }
    : { name: o.name, args: (() => { try { return JSON.parse(o.arguments || "{}"); } catch (_) { return {}; } })() });

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

(async () => {
  // The session's tool list, built exactly as POST /ai/context (transport
  // gpt-live) and POST /ai/live/session build it.
  const all = registry.list().map((t) => t.name);
  const names = [...new Set([...live.liveNames(registry.list(), { must: [] }), ...all])];
  const decls = live.capDeclarations(registry.declarations({ userId: UID, deviceCaps: CAPS, only: names }), names, gptLive.MAX_TOOLS);
  const tools = gptLive.toolsFor(decls.map((d) => ({ name: d.name, description: d.description, parameters: d.parameters })));
  const backend = gptLive.backendInstructions("The user lives in Bengaluru, India. Today is " + new Date().toDateString() + ".");
  const offered = tools.filter((t) => t.type === "function").map((t) => t.name);
  const dropped = all.filter((n) => !offered.includes(n));
  console.log(`model ${MODEL}: ${offered.length} tools offered (${all.length} registered${dropped.length ? `; not offered: ${dropped.join(", ")}` : ""})\n`);
  let failed = false;

  // 1. ACCEPTED
  try {
    await responses({ tools, tool_choice: "none", input: "Reply with OK.", max_output_tokens: 16, reasoning: { effort: "low" } });
    console.log(`1. ACCEPTED  ok — all ${tools.length} tool definitions accepted`);
  } catch (e) {
    failed = true;
    console.log(`1. ACCEPTED  FAIL — ${e.message}`);
  }

  // 2. CHOSEN
  const results = await pool(CASES, 4, async ([text, want]) => {
    try {
      // Up to three rounds, as the real backend runs: a first step that
      // reads (where am I, what is on the calendar) gets a plain result and
      // the model goes on. Passing means a right tool was reached.
      const calls = [];
      let j = await responses({ instructions: backend, tools, input: text, tool_choice: "auto", parallel_tool_calls: true, reasoning: { effort: gptLive.delegateReasoning() }, max_output_tokens: 1024 });
      for (let round = 0; round < 3; round++) {
        const step = callsOf(j);
        calls.push(...step);
        if (!step.length || step.some((c) => want.includes(c.name))) break;
        const outputs = (j.output || []).filter((o) => o.type === "function_call").map((o) => ({
          type: "function_call_output", call_id: o.call_id,
          output: JSON.stringify(o.name === "get_current_location"
            ? { ok: true, result: { lat: 12.97, lng: 77.59, address: "MG Road, Bengaluru" } }
            : { ok: true, result: "nothing found" }),
        }));
        j = await responses({ previous_response_id: j.id, instructions: backend, tools, input: outputs, tool_choice: "auto", parallel_tool_calls: true, reasoning: { effort: gptLive.delegateReasoning() }, max_output_tokens: 1024 });
      }
      const got = calls.map((c) => c.name);
      // stay_silent is the voice's, not the backend's: silence is right there.
      const quiet = want.length === 0 || want.every((w) => w === "stay_silent");
      const ok = quiet
        ? got.length === 0 || got.every((n) => n === "stay_silent" || n === "end_conversation")
        : got.some((n) => want.includes(n));
      return { text, want, got, calls, ok };
    } catch (e) {
      return { text, want, got: [], calls: [], ok: false, error: e.message };
    }
  });
  const right = results.filter((r) => r.ok).length;
  const pct = Math.round((100 * right) / results.length);
  console.log(`2. CHOSEN    ${pct >= MIN ? "ok" : "FAIL"} — ${right}/${results.length} (${pct} %, pass mark ${MIN} %)`);
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`     miss: "${r.text}" → ${r.got.join(", ") || "(no tool)"}${r.error ? ` [${r.error.slice(0, 80)}]` : ""}; wanted ${r.want.join(" | ") || "(no tool)"}`);
  }
  if (pct < MIN) failed = true;

  // 3. RUN — read-only tools only.
  const E = registry.EFFECTIVE || {};
  const has = (set, n) => !!(set && typeof set.has === "function" && set.has(n));
  const safe = offered.filter((n) => {
    const t = registry.get(n);
    if (!t || t.deviceAction || (t.risk && t.risk !== "low") || registry.isWorldAction(n)) return false;
    if (has(E.memoryWrites, n) || has(E.MEMORY_WRITES, n) || has(E.durable, n) || has(E.repeat, n)) return false;
    if (registry.isDraftEdit(t, {}) || t.draftEdit) return false;
    // Names that do something are never run, whatever their flags say:
    // complete_patient_recall and start_task slipped past the flags once.
    return !/^(remember|forget|save|delete|create|update|set|send|share|add|remove|edit|cancel|book|order|pay|make|schedule|place|uninstall|install|open|play|stop|end|complete|start|record|collect|watch|arrange|amend|mark|reply|forward|draft|file|move|rename|approve|confirm|call|text|email_send|email_reply|check_habit|run|continue|pantry|shop|shopping_list_(add|remove|check|clear))/.test(n);
  });
  const seen = new Map(results.flatMap((r) => r.calls).filter((c) => safe.includes(c.name)).map((c) => [c.name, c.args]));
  const runs = await pool(safe, 3, async (name) => {
    let args = seen.get(name);
    try {
      if (!args) {
        const j = await responses({
          instructions: backend, tools: tools.filter((t) => t.name === name),
          tool_choice: { type: "function", name },
          input: `Call ${name} once with realistic example arguments for a user in Bengaluru.`,
          reasoning: { effort: "low" }, max_output_tokens: 512,
        });
        args = (callsOf(j)[0] || {}).args || {};
      }
      const started = Date.now();
      const r = await Promise.race([
        registry.execute(name, args, { userId: UID, appBuild: 164, deviceCaps: CAPS, mode: "live" }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timed out after 30 s")), 30_000)),
      ]);
      return { name, args, ms: Date.now() - started, ok: !!(r && r.ok !== false), error: r && r.ok === false ? String(r.error || "").slice(0, 120) : "" };
    } catch (e) {
      return { name, args, ok: false, threw: true, error: String(e.message || e).slice(0, 120) };
    }
  });
  const ran = runs.filter((r) => r.ok).length;
  console.log(`3. RUN       ${runs.some((r) => r.threw) ? "FAIL" : "ok"} — ${ran}/${runs.length} read-only tools ran (${offered.length - safe.length} that act on the world were not executed)`);
  for (const r of runs.filter((x) => !x.ok)) {
    console.log(`     ${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(28)} ${r.ok ? `${r.ms} ms` : r.error}  ${JSON.stringify(r.args).slice(0, 70)}`);
  }
  // A tool is BROKEN when it throws or hangs. A handled answer — nothing
  // found, not connected, location off — is the tool working.
  const broken = runs.filter((r) => r.threw);
  console.log(`     ${broken.length ? broken.length + " BROKEN: " + broken.map((r) => r.name).join(", ") : "none broken (every failure above is a handled answer)"}`);
  if (broken.length) failed = true;

  console.log(`\n${failed ? "TOOLS CHECK FAILED" : "TOOLS CHECK PASSED"}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("check crashed:", e); process.exit(1); });
