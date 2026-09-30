/**
 * GET /ai/config — what the app needs to run its own models (Firebase AI
 * Logic): which cloud, fast, speech and live models, which voice and
 * speech language, whether Gemini Nano may be used on the phone, and the
 * words its router uses to decide between Nano, the cloud with tools,
 * the cloud with Google Search, and a shortcut.
 *
 * Models come from env, defaulting to what the server itself already
 * runs; nothing here is secret (the app never sees an API key — Firebase
 * AI Logic holds it, behind App Check and the user's Firebase sign-in).
 */
const { envModel } = require("../services/ai/router");

// Gemini's prebuilt voices (the names SpeechConfig accepts). A stored
// voice outside this list is ignored rather than handed to the phone.
const VOICES = new Set([
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
  "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
  "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
  "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
]);

// Voices from Gemini TTS's extended voice library, which only the
// expressive speech model (3.8 Flash TTS) takes; the Live API does not.
// Fola is the assistant's own voice (the owner's choice, 2026-09-29).
const LIBRARY_VOICES = new Set(["Fola"]);

// From this build the phone speaks with the expressive model: it reads a
// WAV reply, acts on the tone note and vocal tags the model writes, and
// strips them from what is shown (context.js adds the guide when asked).
const EXPRESSIVE_BUILD = 126;

// The languages the assistant speaks (agents/language.js), as BCP-47 for
// the speech engine. Tulu is written in Kannada script; Konkani is left
// as its own tag and the phone may fall back if its voice has none.
const BCP47 = {
  English: "en-IN", Hindi: "hi-IN", Kannada: "kn-IN", Tamil: "ta-IN",
  Telugu: "te-IN", Malayalam: "ml-IN", Marathi: "mr-IN", Konkani: "kok-IN",
  Tulu: "tcy-IN", Bengali: "bn-IN", Gujarati: "gu-IN", Punjabi: "pa-IN",
  Odia: "or-IN",
};

// The actions and personal-data words that always need the cloud and its
// tools (docs/ai-logic design, "Routing" §3), on top of the tool names.
const TOOL_VERBS = [
  "remind", "reminder", "call", "message", "send", "email", "mail", "book",
  "order", "open", "play", "set", "alarm", "timer", "schedule", "calendar",
  "meeting", "note", "remember", "forget", "pay", "navigate", "directions",
  "weather", "news", "near me", "nearby", "my", "download", "install",
  "whatsapp", "text", "photo", "camera", "document", "search", "find",
  // The shopping list and the kitchen (2026-09-29).
  "shopping list", "shopping", "to my list", "need to buy", "buy", "cart",
  "pantry", "recipe", "cook", "grocery", "groceries", "kirana",
];

// Fresh public facts with no tool word: cloud with Google Search grounding.
const FRESH_WORDS = [
  "today", "tonight", "tomorrow", "yesterday", "latest", "now", "current",
  "currently", "live", "score", "scores", "price", "prices", "rate", "rates",
  "who won", "won", "result", "results", "news of", "headlines", "this week",
  "this year", "recent", "recently", "breaking", "update", "election",
  "stock", "share price", "gold rate", "petrol price",
];

// The phone's conversation model. Not the server's GEMINI_MODEL: measured
// through AI Logic on 2026-09-29 with the real voice prompt and tools, the
// Flash models took 10–110 s and threw 5xx (3.5 Flash never answered in
// 110 s; 3 Flash 9–63 s), the Flash-Lite ones 2–4 s. 3.5 Flash-Lite at low
// thinking calls tools reliably (at minimal it claimed a reminder it never
// set). The fallback answers when the first fails or stalls.
const cloudModel = () => envModel("AI_CLOUD_MODEL", "gemini-3.5-flash-lite");
// Google Search grounding through AI Logic (the app's "search" route). Off
// unless AI_GROUNDING=on since 2026-09-29: the project's grounding quota
// ran out (429 on every fresh question) while the server's own web_search
// and get_weather tools answer the same questions on the cloud route. The
// app reads an empty list as "use your own", so a word nobody says is
// what switches the route off.
const NO_GROUNDING = "__grounding_off__";
const groundingOn = () => /^(on|1|true|yes)$/i.test(String(process.env.AI_GROUNDING || "off").trim());
const cloudFastModel = () => envModel("AI_CLOUD_FAST_MODEL", "gemini-flash-lite-latest");
const cloudFallbackModel = () => envModel("AI_CLOUD_FALLBACK_MODEL", "gemini-flash-lite-latest");
// How hard the conversation model thinks before answering (minimal, low,
// medium, high). Gemini 3's own default is high, far too slow to talk to.
const THINKING = new Set(["minimal", "low", "medium", "high"]);
const thinkingLevel = () => {
  const v = envModel("AI_CLOUD_THINKING", "low").toLowerCase();
  return THINKING.has(v) ? v : "low";
};
const ttsModel = () =>
  envModel("AI_TTS_MODEL", envModel("GEMINI_TTS_MODEL", "gemini-2.5-flash-preview-tts"));
const expressiveTtsModel = () => envModel("AI_TTS_EXPRESSIVE_MODEL", "gemini-3.8-flash-tts");
// The delivery a spoken reply gets when its model gave no tone of its own.
const ttsStyle = () => envModel("AI_TTS_STYLE", "warm, friendly and natural");
// The old Live socket's model (models.live / liveVoice): no app reads them
// since 2026-09-29; still sent, unchanged, so nothing that parses them breaks.
const liveModel = () =>
  envModel("AI_LIVE_MODEL", envModel("GEMINI_LIVE_MODEL", "gemini-live-2.5-flash-preview"));

// GEMINI LIVE ON THE PHONE (2026-09-30): from build 135 (or an app that
// says it can, ?live=1) the conversation may run through the Live API —
// the phone streams the mic and plays Live's own voice. The `live` block
// is how it is set up: model, prebuilt voice, the voice-activity settings
// (how long a pause ends their turn, how much audio before speech is kept,
// how readily speech starts and ends a turn) and how long an idle session
// stays open. AI_LIVE=off turns it off (the app keeps the cascade);
// AI_LIVE_MODEL, AI_LIVE_VOICE and AI_LIVE_SILENCE_MS override.
const LIVE_BUILD = 135;
const LIVE_VOICES = ["Callirrhoe", "Achernar", "Aoede", "Vindemiatrix", "Sulafat", "Kore", "Charon", "Achird"];
const liveOn = () => !/^(off|0|false|no)$/i.test(String(process.env.AI_LIVE || "on").trim());
function liveSilenceMs() {
  const n = Math.round(Number(process.env.AI_LIVE_SILENCE_MS));
  return Number.isFinite(n) && n >= 200 && n <= 3000 ? n : 500;
}
function liveBlock() {
  const v = envModel("AI_LIVE_VOICE", "");
  return {
    on: liveOn(),
    model: envModel("AI_LIVE_MODEL", "gemini-3.8-live"),
    // Live takes prebuilt voices only (never the library's Fola).
    voice: VOICES.has(v) ? v : "Callirrhoe",
    silenceMs: liveSilenceMs(),
    prefixMs: 100,
    startSensitivity: "high",
    endSensitivity: "high",
    idleCloseSec: 60,
    voices: LIVE_VOICES.slice(),
  };
}
/** Does this app get the live block: build 135+, or it says it can. */
function liveCapable(build, flag) {
  const b = Number(build);
  return (Number.isFinite(b) && b >= LIVE_BUILD) || flag === true || /^(1|true|yes|on)$/i.test(String(flag || ""));
}

/**
 * The voice a user hears: theirs, their avatar's, or the deployment's. A
 * library voice (Fola) only reaches a phone that speaks with the
 * expressive model; an older one keeps a prebuilt voice.
 */
function voiceFor(profile, { expressive = false } = {}) {
  const ok = (v) => Boolean(v) && (VOICES.has(v) || (expressive && LIBRARY_VOICES.has(v)));
  const chosen = profile && profile.assistant && profile.assistant.voice;
  if (ok(chosen)) return chosen;
  try {
    const face = require("../avatar/heygen").voiceForFace(profile && profile.assistant && profile.assistant.avatar_id);
    if (ok(face)) return face;
  } catch (_) {}
  const env = envModel("AI_TTS_VOICE", expressive ? "Fola" : "Kore");
  if (ok(env)) return env;
  return expressive ? "Fola" : "Kore";
}

/** BCP-47 for a stored preferred language ("Kannada", "ಕನ್ನಡ", "kn"…). */
function speechLanguage(preferred) {
  const raw = String(preferred || "").trim();
  if (!raw) return "en-IN";
  if (/^[a-z]{2,3}(-[A-Za-z]{2})?$/.test(raw)) {
    const two = raw.slice(0, raw.indexOf("-") > 0 ? raw.indexOf("-") : raw.length).toLowerCase();
    const hit = Object.values(BCP47).find((t) => t.startsWith(two + "-"));
    if (hit) return hit;
  }
  const name = require("../agents/language").canonical(raw);
  return BCP47[name] || "en-IN";
}

async function forUser(userId, { build, live } = {}) {
  const uid = Number(userId);
  const profile = await require("../users/context").getProfile(uid).catch(() => null);
  const registry = require("../tools/registry");
  const offered = registry.declarations({ userId: uid });
  const toolWords = require("../tools/relevance").triggerWords(offered, TOOL_VERBS);
  // Names as match.js keys them (the app normalises what was said the
  // same way). A build that predates shortcuts is not given them.
  let shortcutNames = [];
  const b = Number(build);
  if (process.env.SHORTCUTS !== "off" && !(Number.isFinite(b) && b > 0 && b < 120)) {
    shortcutNames = [...new Set(await require("../shortcuts/match").keysFor(uid).catch(() => []))];
  }
  const expressive = Number.isFinite(b) && b >= EXPRESSIVE_BUILD;
  const voice = voiceFor(profile, { expressive });
  const out = {
    models: {
      cloud: cloudModel(),
      cloudFast: cloudFastModel(),
      cloudFallback: cloudFallbackModel(),
      thinking: thinkingLevel(),
      tts: expressive ? expressiveTtsModel() : ttsModel(),
      ttsVoice: voice,
      ttsStyle: ttsStyle(),
      ttsLanguage: speechLanguage(profile && profile.user && profile.user.preferred_language),
      live: liveModel(),
      // The Live API takes prebuilt voices only.
      liveVoice: (() => {
        const v = envModel("AI_LIVE_VOICE", "");
        if (v && VOICES.has(v)) return v;
        return VOICES.has(voice) ? voice : "Kore";
      })(),
    },
    routing: { toolWords, freshWords: groundingOn() ? FRESH_WORDS.slice() : [NO_GROUNDING], shortcutNames },
    limits: { maxToolRounds: 6 },
  };
  if (liveCapable(build, live)) out.live = liveBlock();
  return out;
}

module.exports = {
  forUser, voiceFor, speechLanguage, cloudModel, cloudFastModel, cloudFallbackModel,
  thinkingLevel, ttsModel, expressiveTtsModel, ttsStyle, liveModel,
  liveBlock, liveCapable, liveOn, LIVE_BUILD, LIVE_VOICES,
  VOICES, LIBRARY_VOICES, EXPRESSIVE_BUILD, TOOL_VERBS, FRESH_WORDS, NO_GROUNDING, groundingOn,
};
