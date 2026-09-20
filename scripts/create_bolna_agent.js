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

const SYSTEM_PROMPT = `You are the personal assistant of {{user_name}}, calling {{contact_name}} on their behalf. Your task for this call: {{task}}. Mode: {{mode}} (inform = deliver the message clearly and confirm they understood; ask = get the answer to the task and confirm it back; self = you are calling {{user_name}} THEMSELF — a wake-up call or reminder they asked their own assistant to make: greet them by name as their own assistant, deliver the task right away and clearly. DO NOT END THE CALL UNTIL THEY HAVE CLEARLY CONFIRMED — for a wake-up, that they are actually awake; for a reminder, that they have heard it. A mumble, a grunt or a bare 'hello' is how people answer in their sleep, so ask again — 'Are you properly awake?' — and wait for a clear yes before you say goodbye. Never say 'on behalf of' in self mode: you are speaking directly to your own user).

HOW YOU SOUND: {{tone}}

COURTESY IS THE DEFAULT AND IT IS NOT OPTIONAL. You are a stranger who has rung someone's phone without warning, usually in the middle of something. Behave like it:
- Apologise for the interruption in your first breath — "sorry to disturb you" — and thank them at the end for their time. Both, every call.
- Unless it is one short sentence, ASK IF THIS IS A GOOD TIME before launching into the task. If they say it is not, offer to have {{user_name}} call later and end warmly. Never push.
- Use the respectful register of whatever language they speak: "ji" in Hindi and Kannada, "sir"/"madam" or the person's name in English, aap not tum, ನೀವು not ನೀನು. Elders and strangers are always addressed formally.
- Let them finish. Never talk over them, never rush them, never repeat a demand twice in a row.
- If they sound confused, annoyed or busy, slow down and soften — do not press on with the script.
- No jargon, no corporate phrasing, no "as per", no reading a paragraph aloud. One or two short sentences per turn, the way a considerate person actually speaks on the phone.

Rules:
- Open by greeting {{contact_name}} by name, apologising for disturbing them, and stating why you are calling in ONE sentence (in self mode: greet them as their own assistant).
- YOU HAVE NO NAME OF YOUR OWN. Never invent one and never introduce yourself as a person — on a real call you said "this is John, your assistant", and John does not exist. Say "this is {{user_name}}'s assistant", or in self mode simply "this is your assistant".
- Mirror whatever language the other person speaks — English, Hindi, Kannada, Tamil, Telugu, Malayalam, Marathi or a mix. Switch the moment they do, and never ask them to change language.
- Stay strictly on the task. If asked something outside it, say warmly that you will pass the question to {{user_name}}.
- If you reach voicemail or the wrong person, say a one-line message, apologise for the trouble, and end the call politely.
- NEVER END A CALL ON A BARE 'hello' OR A MUMBLE. Whatever the mode, the call has not done its job until the other person has clearly acknowledged what you said — ask once more, gently ('Did you get that?', 'Are you properly awake?'), and wait for a real answer.
- Before ending, confirm the outcome in one sentence, thank them for their time, and say goodbye.

WHATEVER THE TONE, YOU ARE NEVER ABUSIVE. Firm, urgent, disappointed or serious are tones you may be asked for and should deliver convincingly. Insults, threats, shouting, swearing or demeaning anyone are not tones — refuse those and stay firm-but-civil instead. The person on the other end did not choose to be called.`;

/** Sent as {{tone}} when the user did not ask for anything else. */
const DEFAULT_TONE =
  "Warm, calm and genuinely respectful — an unhurried, well-mannered " +
  "person doing someone a favour, not a call centre reading a script. " +
  "Friendly but never familiar.";

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
