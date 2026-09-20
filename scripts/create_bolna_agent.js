#!/usr/bin/env node
/**
 * CREATE THE BOLNA CALLING AGENT — run ONCE when the Bolna account exists:
 *
 *   BOLNA_API_KEY=bn-... node scripts/create_bolna_agent.js
 *
 * Prints the agent id to store as BOLNA_AGENT_ID in myassistant-secrets
 * (with BOLNA_API_KEY and BOLNA_FROM_NUMBER, the +91 number bought in the
 * dashboard). The webhook URL embeds sha256(api key)[:32], which is what
 * src/routes/agentCall.js expects — no separate secret to store.
 *
 * The prompt mirrors the Retell agent 1:1 (same {{task}}/{{contact_name}}/
 * {{user_name}}/{{mode}} variables the backend already sends, including
 * mode "self" for wake-up calls to the user themself). Voice/LLM blocks
 * follow Bolna's documented v2 shape; if their API rejects a field name,
 * the error body is printed verbatim — adjust and re-run, then fine-tune
 * the voice in the dashboard where the catalogue is browsable.
 */

const crypto = require("crypto");

const KEY = process.env.BOLNA_API_KEY || "";
const BASE = (process.env.PUBLIC_BASE_URL || "https://api.hariassistant.tech").replace(/\/$/, "");

if (!KEY) {
  console.error("Set BOLNA_API_KEY (Bolna dashboard → Developers tab).");
  process.exit(1);
}

const secret = crypto.createHash("sha256").update(KEY).digest("hex").slice(0, 32);
const webhookUrl = `${BASE}/agent-call/bolna/webhook/${secret}`;

const SYSTEM_PROMPT = `You are a polite, professional personal assistant calling on behalf of {{user_name}}. The person you are speaking with is {{contact_name}}. Your task for this call: {{task}}. Mode: {{mode}} (inform = deliver the message clearly and confirm they understood; ask = get the answer to the task and confirm it back; self = you are calling {{user_name}} THEMSELF — a wake-up call or reminder they asked their own assistant to make: greet them by name as their own assistant, deliver the task right away and clearly. DO NOT END A WAKE-UP CALL UNTIL THEY HAVE CLEARLY CONFIRMED THEY ARE AWAKE: a mumble, a grunt or a bare 'hello' is how people answer in their sleep, so ask again — 'Are you properly awake?' — and wait for a clear yes before you say goodbye. Never say 'on behalf of' in self mode: you are speaking directly to your own user).

Rules:
- Open by greeting {{contact_name}} by name and stating why you are calling in one sentence (in self mode: greet them as their own assistant).
- Speak naturally and briefly - one or two short sentences per turn. Never lecture.
- Mirror whatever language the other person speaks — English, Hindi, Kannada, Tamil, Telugu, Malayalam, Marathi or a mix. Switch the moment they do, and never ask them to change language. Use the polite, respectful register always.
- Stay strictly on the task. If asked something outside it, say you will pass the question to {{user_name}}.
- If you reach voicemail or the wrong person, say a one-line message and end the call politely.
- Before ending, confirm the outcome in one sentence, thank them, and say goodbye.`;

const payload = {
  agent_config: {
    agent_name: "Hari agent calls",
    agent_welcome_message: "Hello, {{contact_name}}?",
    webhook_url: webhookUrl,
    agent_type: "other",
    tasks: [
      {
        task_type: "conversation",
        toolchain: { execution: "parallel", pipelines: [["transcriber", "llm", "synthesizer"]] },
        tools_config: {
          llm_agent: {
            // Required by the API (it 400s by name without it); streaming
            // is what makes the reply start before the sentence is finished.
            agent_flow_type: "streaming",
            agent_type: "simple_llm_agent",
            llm_config: {
              provider: "openai",
              model: "gpt-4.1",
              max_tokens: 150,
              temperature: 0.3,
            },
          },
          transcriber: {
            provider: "deepgram",
            // MEASURED against the real account, 2026-09-20: "multi" is
            // refused on both nova-3 and nova-2 ("Provided language: multi
            // is not available for the model"), so nova-3 + hi is what
            // actually exists here. That covers Hindi and English
            // including code-switching, which is what the calls are.
            // Override per account if the catalogue differs.
            model: process.env.BOLNA_STT_MODEL || "nova-3",
            language: process.env.BOLNA_STT_LANG || "hi",
            stream: true,
          },
          synthesizer: {
            provider: "elevenlabs",
            provider_config: {
              // Multilingual female voice; swap in the dashboard if the
              // account's catalogue names differ.
              voice: "Monika",
              voice_id: "2zRM7PkgwBPiau2jvVXc",
              model: "eleven_turbo_v2_5",
            },
            stream: true,
            buffer_size: 100,
          },
        },
        task_config: {
          call_summary_enabled: true, // webhook `summary` stays null without this
          hangup_after_silence: 12,
          call_cancellation_prompt: null,
        },
      },
    ],
  },
  agent_prompts: {
    task_1: { system_prompt: SYSTEM_PROMPT },
  },
};

(async () => {
  const r = await fetch("https://api.bolna.ai/v2/agent", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error(`Bolna refused (${r.status}) — fix the named field and re-run:\n${text}`);
    process.exit(1);
  }
  const j = JSON.parse(text);
  console.log("Agent created.");
  console.log("  BOLNA_AGENT_ID =", j.agent_id || j.id || "(see full response below)");
  console.log("  webhook_url    =", webhookUrl);
  console.log(JSON.stringify(j, null, 2));
})().catch((e) => {
  console.error("create_bolna_agent failed:", e.message || e);
  process.exit(1);
});
