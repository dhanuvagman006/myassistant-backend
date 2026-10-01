#!/usr/bin/env node
/**
 * TOOL-CALL EVAL (2026-10-01). Forty-odd real spoken requests, taken from
 * Conversations, each with the tool the assistant must call (or none).
 * The exact Live session is rebuilt — the gated spoken rules and the
 * capped Live tool declarations for an Android phone on the current
 * build — and a text Gemini model with the same instruction and tools
 * says what it would call. Run before and after a prompt change:
 *
 *   GEMINI_API_KEY=… node scripts/tool-call-eval.js            # gated rules (what ships)
 *   GEMINI_API_KEY=… node scripts/tool-call-eval.js --ungated  # the old full prompt
 *   EVAL_MODEL=gemini-3.5-flash-lite … --only=12,17            # a subset
 *
 * It needs a key, so it is not in test:all. Exit 1 when below EVAL_MIN
 * (default 85 %).
 */
const vp = require("../src/ai/voicePrompt");
const registry = require("../src/tools/registry");
require("../src/agents/runtime");
const live = require("../src/ai/liveTools");

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error("GEMINI_API_KEY is required");
  process.exit(2);
}
const MODEL = process.env.EVAL_MODEL || "gemini-3.8-flash";
const UNGATED = process.argv.includes("--ungated");
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7)
  .split(",").filter(Boolean).map(Number);
const MIN = Number(process.env.EVAL_MIN || 85);

// [what they said, the tools that count as right; [] = no tool]
const CASES = [
  ["show me a picture of Virat Kohli", ["show_pictures"]],
  ["What is new thing emerging in technology?", ["web_search"]],
  ["Can you tell me about Dr. M. N. Rajendra Kumar's health condition?", ["web_search"]],
  ["call Neha and tell her that papa is coming tomorrow", ["place_phone_call"]],
  ["Remind me to take an umbrella half an hour before 2 pm today.", ["create_reminder"]],
  ["What is on my calendar today?", ["list_calendar_events", "list_reminders"]],
  ["Give me my brief for today.", ["daily_brief"]],
  ["I have a meeting tomorrow at 9 am", ["create_calendar_event"]],
  ["can you open swiggy", ["open_named_app"]],
  ["Is there an IKEA near this place?", ["find_places_nearby"]],
  ["Open the camera", ["open_named_app", "phone_control"]],
  ["I want the judgment to be downloaded. Search in Google and provide me.", ["web_search"]],
  ["Tell me Neha Shetty's present address in Mumbai.", ["show_address", "lookup_person", "web_search"]],
  ["Remember Neha's address: Therese Apartment, plot 179, Waterfield Road, Bandra West, Mumbai", ["remember_address"]],
  ["Can you tell me my present location address?", ["get_current_location"]],
  ["Uber app", ["open_named_app"]],
  ["What time is the flight from Mumbai to Bengaluru tomorrow?", ["web_search"]],
  ["Create a nice birthday card for Ravi Shankar Shetty", ["make_greeting_poster", "generate_image"]],
  ["What is the latest news about India?", ["web_search", "open_app_screen"]],
  // A reminder IS a call at that time, so either tool keeps the promise.
  ["Call me at 8 and remind me to go to college", ["schedule_task", "create_reminder"]],
  ["No, thank you. That's all.", ["end_conversation"]],
  ["What's the weather like today?", ["get_weather"]],
  ["Set an alarm for 5:30 tomorrow morning", ["set_alarm"]],
  ["Set a timer for 10 minutes", ["set_timer"]],
  ["Play some Ilaiyaraaja songs", ["play_music"]],
  ["Any missed calls today?", ["phone_calls"]],
  ["Send a message to Ravi that I'll be late", ["send_agent_message"]],
  ["WhatsApp amma that I reached safely", ["send_whatsapp_message"]],
  ["Add milk and eggs to my shopping list", ["shopping_list_add"]],
  ["What's on my shopping list?", ["shopping_list_show"]],
  ["Turn on the flashlight", ["phone_control"]],
  ["Remember that my car number is KA 01 AB 1234", ["remember_fact"]],
  ["What's my car number?", ["recall_memory"]],
  ["Did you call Ravi?", ["check_recent_actions"]],
  ["Open the news", ["open_app_screen"]],
  ["Prepare me for my meeting with Suresh tomorrow", ["prepare_meeting"]],
  ["Make a poster for our Diwali party on Friday at 7 pm", ["create_event_poster"]],
  ["Write a short speech for my sister's wedding", ["present_text"]],
  ["Make me a PPT on solar energy", ["create_document"]],
  ["Who is Devi Shetty?", ["web_search"]],
  ["Make my photo look better", ["edit_my_photo"]],
  ["Speak to me in Kannada.", []],
  // Half a sentence: nothing, or stay_silent, both keep quiet.
  ["Tell me the", ["stay_silent"]],
];

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

async function ask(system, decls, text) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text }] }],
    tools: [{ functionDeclarations: decls }],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    generationConfig: { temperature: 0.2, maxOutputTokens: 200 },
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": KEY }, body: JSON.stringify(body) });
    if (r.status === 429 || r.status >= 500) {
      await new Promise((res) => setTimeout(res, 15000 * (attempt + 1)));
      continue;
    }
    const j = await r.json();
    if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall.name);
    const said = parts.filter((p) => p.text).map((p) => p.text).join(" ").trim();
    return { calls, said };
  }
  throw new Error("gave up after retries");
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
  console.log(`model ${MODEL}; ${UNGATED ? "UNGATED" : "gated"} rules ${system.length} chars; ${declared.length} tools: ${declared.join(" ")}\n`);

  let pass = 0, n = 0;
  const fails = [];
  for (let i = 0; i < CASES.length; i++) {
    if (only.length && !only.includes(i + 1)) continue;
    const [text, want] = CASES[i];
    n++;
    // Free-tier pacing between calls (EVAL_PACE_MS, default 5 s).
    if (n > 1) await new Promise((res) => setTimeout(res, Number(process.env.EVAL_PACE_MS || 5000)));
    let got;
    try {
      got = await ask(system, fds, text);
    } catch (e) {
      got = { calls: [], said: `ERROR ${e.message}` };
    }
    const first = got.calls[0] || null;
    const ok = want.length
      ? want.includes(first) || (want.includes("stay_silent") && got.calls.length === 0)
      : got.calls.length === 0;
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
