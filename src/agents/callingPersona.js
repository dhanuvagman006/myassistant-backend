/**
 * THE USER'S OWN CALLING AGENT.
 * -----------------------------
 * Until now one Bolna agent served everybody: one voice, one character,
 * one set of languages for every user of the app. His ask, 2026-09-20:
 * "give a free hand for the user to select how their calling agent should
 * speak and how it should sound… and show how much it may cost per
 * minute so we can charge accordingly."
 *
 * ARCHITECTURE, because this is the part that decides whether it works at
 * scale: Bolna configuration lives ON AN AGENT, and a call names one
 * agent. There is no per-call override for voice or model. So a user who
 * customises gets THEIR OWN Bolna agent, created on first save and
 * updated in place afterwards; the id is stored against the user and
 * used for their calls. Anyone who never opens the screen keeps using the
 * shared default agent and costs nothing extra.
 *
 * WHAT IS DELIBERATELY NOT EXPOSED: the latency knobs, endpointing,
 * interruption thresholds and the webhook. Those are correctness
 * settings, not preferences — a user who sets endpointing to 3 seconds
 * has not customised their agent, they have broken it.
 */
const { query, one, run } = require("../db");

/* ------------------------------------------------------------------ */
/* THE CHOICES                                                         */
/* ------------------------------------------------------------------ */

/** How it behaves. The prompt fragment is appended to the base rules. */
const CHARACTERS = {
  polite: {
    label: "Warm and polite",
    hint: "Unhurried, respectful, apologises for interrupting",
    tone:
      "Warm, calm and genuinely respectful — an unhurried, well-mannered " +
      "person doing someone a favour, not a call centre reading a script. " +
      "Friendly but never familiar.",
  },
  professional: {
    label: "Brisk and professional",
    hint: "Courteous but straight to the point",
    tone:
      "Courteous and efficient. Still apologises for the interruption and " +
      "thanks them, but gets to the point in one sentence and does not " +
      "make small talk. The way a good office assistant calls.",
  },
  friendly: {
    label: "Friendly and casual",
    hint: "Relaxed, like a helpful friend",
    tone:
      "Relaxed and easy, like a helpful friend ringing — a little warmth " +
      "and humour are welcome. Still respectful, never over-familiar with " +
      "elders or strangers.",
  },
  firm: {
    label: "Firm and serious",
    hint: "For reminders that keep being ignored",
    tone:
      "Serious and firm. Polite, never rude, but does not soften the " +
      "message or let it be brushed aside — repeats the essential point " +
      "once if they try to move past it.",
  },
};

/**
 * VOICES — read off the platform, not guessed.
 *
 * The first version of this file offered six ElevenLabs voices with ids I
 * had looked up, and a warning that Bolna accepts any voice NAME without
 * checking it. That was working around the wrong provider. The platform
 * carries SEVEN voice providers, and Sarvam is the one built for Indian
 * languages: 16 voices, each published with a gender and a style, and —
 * unlike ElevenLabs — the id is VALIDATED on save ("does not exist in
 * voice_profiles"), so a typo can never reach a real call.
 *
 * That is why the whole list is exposed here and the ElevenLabs entry is
 * kept as one option rather than the default: Sarvam speaks Kannada,
 * Tamil, Telugu, Malayalam and the rest, which is the thing that could
 * not be done before.
 *
 * Verified on his account 2026-09-20: bulbul:v3 + voice_id (lowercase
 * name) + language kn-IN is accepted; a made-up id is refused.
 */
const SARVAM = (voice, gender, style) => ({
  id: voice.toLowerCase(),
  label: voice,
  gender,
  style,
  provider: "sarvam",
  model: "bulbul:v3",
  voice,
  voiceId: voice.toLowerCase(),
  indian: true,
});

const VOICES = [
  // male
  SARVAM("Sumit", "male", "Conversational"),
  SARVAM("Amit", "male", "Business"),
  SARVAM("Rahul", "male", "Warm, persuasive"),
  SARVAM("Ashutosh", "male", "Clear, news-reader"),
  SARVAM("Ratan", "male", "Measured"),
  SARVAM("Shubh", "male", "Calm, support"),
  SARVAM("Manan", "male", "Brisk"),
  // female
  SARVAM("Priya", "female", "Conversational"),
  SARVAM("Kavya", "female", "Conversational"),
  SARVAM("Simran", "female", "Friendly"),
  SARVAM("Pooja", "female", "Assistant"),
  SARVAM("Ishita", "female", "Business"),
  SARVAM("Shreya", "female", "Clear, news-reader"),
  SARVAM("Ritu", "female", "Warm"),
  SARVAM("Suhani", "female", "Gentle"),
  SARVAM("Shruti", "female", "Expressive"),
  // Kept for languages outside India, and as the rollback path if Sarvam
  // ever feels slower on the line.
  {
    id: "monika", label: "Monika", gender: "female", style: "Multilingual",
    provider: "elevenlabs", model: "eleven_turbo_v2_5",
    voice: "Monika", voiceId: "2zRM7PkgwBPiau2jvVXc", indian: false,
  },
];

/** Three tiers rather than a model list — the user is choosing how sharp
 *  it should be, not shopping for model names. */
const BRAINS = {
  fast: {
    label: "Fast", hint: "Quickest replies, simple messages",
    provider: "openai", model: "gpt-4.1-mini", costPerMin: 0.006,
  },
  balanced: {
    label: "Balanced", hint: "The default — good judgement, quick enough",
    provider: "openai", model: "gpt-4.1", costPerMin: 0.019,
  },
  sharp: {
    label: "Sharp", hint: "Best at awkward conversations, slightly slower",
    provider: "openai", model: "gpt-4.1", costPerMin: 0.028, temperature: 0.4,
  },
};

/**
 * LANGUAGES, and the transcription that can actually hear them.
 *
 * The user picks a language; they should never have to know that a
 * speech-to-text provider exists, let alone which one does Kannada.
 * Deepgram has no Kannada at all — that is why "it struggles in Kannada"
 * was never fixable by changing the voice alone. Sarvam's saaras:v4 does,
 * and handles code-switching under "unknown".
 *
 * Verified accepted on his account 2026-09-20.
 */
const LANGUAGES = [
  { id: "multi", label: "Indian languages", hint: "Switches as they do — the safe default",
    asr: { provider: "sarvam", model: "saaras:v4", language: "unknown" }, tts: "hi-IN" },
  { id: "hi", label: "Hindi", hint: "With English mixed in",
    asr: { provider: "sarvam", model: "saaras:v4", language: "hi" }, tts: "hi-IN" },
  { id: "kn", label: "Kannada", hint: "",
    asr: { provider: "sarvam", model: "saaras:v4", language: "kn" }, tts: "kn-IN" },
  { id: "ta", label: "Tamil", hint: "",
    asr: { provider: "sarvam", model: "saaras:v4", language: "ta" }, tts: "ta-IN" },
  { id: "te", label: "Telugu", hint: "",
    asr: { provider: "sarvam", model: "saaras:v4", language: "te" }, tts: "te-IN" },
  { id: "ml", label: "Malayalam", hint: "",
    asr: { provider: "sarvam", model: "saaras:v4", language: "ml" }, tts: "ml-IN" },
  { id: "mr", label: "Marathi", hint: "",
    asr: { provider: "sarvam", model: "saaras:v4", language: "mr" }, tts: "mr-IN" },
  { id: "bn", label: "Bengali", hint: "",
    asr: { provider: "sarvam", model: "saaras:v4", language: "bn" }, tts: "bn-IN" },
  { id: "gu", label: "Gujarati", hint: "",
    asr: { provider: "sarvam", model: "saaras:v4", language: "gu" }, tts: "gu-IN" },
  { id: "pa", label: "Punjabi", hint: "",
    asr: { provider: "sarvam", model: "saaras:v4", language: "pa" }, tts: "pa-IN" },
  { id: "en", label: "English only", hint: "Clearest for English-only calls",
    asr: { provider: "deepgram", model: "nova-3", language: "en" }, tts: "en-IN" },
];

const DEFAULTS = {
  character: "polite",
  persona: "",
  // An Indian voice that can speak every Indian language, and a
  // transcriber that can hear them — the combination that makes Kannada
  // work at all. Monika (ElevenLabs) remains one tap away.
  voice: "sumit",
  brain: "balanced",
  language: "multi",
};

/* ------------------------------------------------------------------ */
/* WHAT IT COSTS                                                       */
/* ------------------------------------------------------------------ */

/**
 * Per-minute estimate, in US dollars.
 *
 * CALIBRATED, NOT INVENTED: Bolna's own dashboard shows ~$0.129/min for
 * the shipped configuration (ElevenLabs Turbo v2.5 + gpt-4.1 + Deepgram
 * nova-3 + hosted telephony), and these components add to that. The split
 * is theirs; the numbers move when a user picks a cheaper brain.
 *
 * It is shown to the user as an ESTIMATE and labelled as one — a real
 * call also depends on how long the other person talks.
 */
const RATES = {
  transcriber: 0.0043,
  voice: { elevenlabs: 0.075, sarvam: 0.048 },
  telephony: 0.009,
  platform: 0.018,
};

function costPerMinute(prefs) {
  const brain = BRAINS[prefs.brain] || BRAINS.balanced;
  const voice = VOICES.find((v) => v.id === prefs.voice) || VOICES[0];
  const voiceRate = RATES.voice[voice.provider] ?? RATES.voice.elevenlabs;
  const total =
    RATES.transcriber + voiceRate + RATES.telephony + RATES.platform +
    brain.costPerMin;
  return {
    total: Number(total.toFixed(3)),
    breakdown: {
      voice: voiceRate,
      brain: brain.costPerMin,
      transcription: RATES.transcriber,
      telephony: RATES.telephony,
      platform: RATES.platform,
    },
  };
}

/* ------------------------------------------------------------------ */
/* STORAGE                                                             */
/* ------------------------------------------------------------------ */

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS calling_agent_prefs (
        user_id        INTEGER PRIMARY KEY,
        character      TEXT NOT NULL DEFAULT 'polite',
        persona        TEXT NOT NULL DEFAULT '',
        voice          TEXT NOT NULL DEFAULT 'monika',
        brain          TEXT NOT NULL DEFAULT 'balanced',
        language       TEXT NOT NULL DEFAULT 'hi',
        bolna_agent_id TEXT NOT NULL DEFAULT '',
        updated_at     BIGINT NOT NULL DEFAULT 0
      );
    `).catch((e) => {
      console.error("calling_agent_prefs migration failed:", e.message);
      migrated = null;
    });
  }
  return migrated;
}

async function getPrefs(userId) {
  await migrate();
  const row = await one("SELECT * FROM calling_agent_prefs WHERE user_id=$1", [userId]).catch(() => null);
  return {
    ...DEFAULTS,
    ...(row || {}),
    bolna_agent_id: row?.bolna_agent_id || "",
  };
}

/** The agent id to place THIS user's calls with — theirs, else the shared one. */
async function agentIdFor(userId) {
  if (!userId) return process.env.BOLNA_AGENT_ID || "";
  try {
    const p = await getPrefs(userId);
    return p.bolna_agent_id || process.env.BOLNA_AGENT_ID || "";
  } catch (_) {
    return process.env.BOLNA_AGENT_ID || "";
  }
}

/* ------------------------------------------------------------------ */
/* THE AGENT ITSELF                                                    */
/* ------------------------------------------------------------------ */

const BOLNA = "https://api.bolna.ai";
const headers = () => ({
  Authorization: `Bearer ${process.env.BOLNA_API_KEY || ""}`,
  "Content-Type": "application/json",
});

/** The shared agent, used as the template so every per-user agent starts
 *  from the same verified telephony, webhook and rule set. */
async function template() {
  const id = process.env.BOLNA_AGENT_ID;
  if (!id) throw new Error("calling is not configured on this server");
  const r = await fetch(`${BOLNA}/agent/${id}`, { headers: headers() });
  if (!r.ok) throw new Error(`could not read the base agent (${r.status})`);
  return r.json();
}

function promptFor(base, prefs) {
  const c = CHARACTERS[prefs.character] || CHARACTERS.polite;
  const extra = String(prefs.persona || "").trim();
  // The base prompt already carries the courtesy rules and the {{tone}}
  // slot; the character replaces the default tone, and anything the user
  // typed is appended as their own standing instruction.
  let p = base;
  if (extra) {
    p += `\n\nWHAT ${"{{user_name}}"} WANTS YOU TO KNOW: ${extra.slice(0, 600)}`;
  }
  return p;
}

/**
 * Create or update this user's Bolna agent from their preferences.
 * @returns {Promise<string>} their agent id
 */
async function syncAgent(userId, prefs) {
  const base = await template();
  const voice = VOICES.find((v) => v.id === prefs.voice) || VOICES[0];
  const brain = BRAINS[prefs.brain] || BRAINS.balanced;
  const lang = LANGUAGES.find((l) => l.id === prefs.language) || LANGUAGES[0];

  const tasks = JSON.parse(JSON.stringify(base.tasks));
  const tc = tasks[0].tools_config;

  // VOICE. The whole synthesizer block is replaced rather than merged:
  // provider_config fields are provider-specific, and leaving an
  // ElevenLabs model behind while switching to Sarvam is exactly the kind
  // of half-applied config that fails only when a real call is placed.
  tc.synthesizer = {
    ...tc.synthesizer,
    provider: voice.provider,
    provider_config: {
      model: voice.model,
      voice: voice.voice,
      voice_id: voice.voiceId,
      // Sarvam wants the language on the voice too; ElevenLabs does not
      // take one at all.
      ...(voice.provider === "sarvam" ? { language: lang.tts } : {}),
    },
  };

  tc.llm_agent.llm_config = {
    ...tc.llm_agent.llm_config,
    provider: brain.provider,
    model: brain.model,
    ...(brain.temperature !== undefined ? { temperature: brain.temperature } : {}),
  };

  // HEARING follows the language automatically. The user picked a
  // language, not a speech-to-text vendor, and Deepgram simply has no
  // Kannada — which is why changing the voice alone never fixed it.
  tc.transcriber = {
    ...tc.transcriber,
    provider: lang.asr.provider,
    model: lang.asr.model,
    language: lang.asr.language,
  };

  const basePrompt =
    base.agent_prompts?.task_1?.system_prompt ||
    Object.values(base.agent_prompts || {})[0]?.system_prompt ||
    "";
  const body = {
    agent_config: {
      agent_name: `user-${userId} calling agent`,
      agent_welcome_message: base.agent_welcome_message,
      webhook_url: base.webhook_url,
      agent_type: base.agent_type || "other",
      tasks,
    },
    agent_prompts: { task_1: { system_prompt: promptFor(basePrompt, prefs) } },
  };

  const existing = prefs.bolna_agent_id;
  const url = existing ? `${BOLNA}/v2/agent/${existing}` : `${BOLNA}/v2/agent`;
  const r = await fetch(url, {
    method: existing ? "PUT" : "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    // A stale id (agent deleted in the dashboard) must not lock the user
    // out of their own settings — fall back to creating a fresh one.
    if (existing && r.status === 404) {
      return syncAgent(userId, { ...prefs, bolna_agent_id: "" });
    }
    throw new Error(`the calling agent could not be saved: ${text.slice(0, 160)}`);
  }
  const j = JSON.parse(text);
  return j.agent_id || existing;
}

async function setPrefs(userId, patch = {}) {
  await migrate();
  const current = await getPrefs(userId);
  const next = {
    character: CHARACTERS[patch.character] ? patch.character : current.character,
    persona: patch.persona !== undefined
      ? String(patch.persona).slice(0, 600) : current.persona,
    voice: VOICES.some((v) => v.id === patch.voice) ? patch.voice : current.voice,
    brain: BRAINS[patch.brain] ? patch.brain : current.brain,
    language: LANGUAGES.some((l) => l.id === patch.language) ? patch.language : current.language,
    bolna_agent_id: current.bolna_agent_id,
  };

  const agentId = await syncAgent(userId, next);
  next.bolna_agent_id = agentId;

  await run(
    `INSERT INTO calling_agent_prefs
       (user_id, character, persona, voice, brain, language, bolna_agent_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_id) DO UPDATE SET
       character=$2, persona=$3, voice=$4, brain=$5, language=$6,
       bolna_agent_id=$7, updated_at=$8`,
    [userId, next.character, next.persona, next.voice, next.brain,
     next.language, agentId, Date.now()]
  );
  return next;
}

/** Everything the settings screen needs in one call. */
async function optionsFor(userId) {
  const prefs = await getPrefs(userId);
  return {
    current: {
      character: prefs.character,
      persona: prefs.persona,
      voice: prefs.voice,
      brain: prefs.brain,
      language: prefs.language,
      personalised: Boolean(prefs.bolna_agent_id),
    },
    characters: Object.entries(CHARACTERS).map(([id, c]) => ({
      id, label: c.label, hint: c.hint,
    })),
    voices: VOICES.map((v) => ({
      id: v.id, label: v.label, gender: v.gender, style: v.style,
      indian: v.indian !== false,
    })),
    brains: Object.entries(BRAINS).map(([id, b]) => ({
      id, label: b.label, hint: b.hint,
      costPerMin: Number((b.costPerMin).toFixed(3)),
    })),
    languages: LANGUAGES.map((l) => ({ id: l.id, label: l.label, hint: l.hint || "" })),
    cost: costPerMinute(prefs),
    currency: "USD",
  };
}

module.exports = {
  getPrefs, setPrefs, optionsFor, agentIdFor, costPerMinute,
  CHARACTERS, VOICES, BRAINS, LANGUAGES, DEFAULTS,
};
