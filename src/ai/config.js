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
const { envModel, chatModel } = require("../services/ai/router");

// Gemini's prebuilt voices (the names SpeechConfig accepts). A stored
// voice outside this list is ignored rather than handed to the phone.
const VOICES = new Set([
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
  "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
  "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrimo", "Achird", "Zubenelgenubi",
  "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
]);

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

const cloudModel = () => envModel("AI_CLOUD_MODEL", chatModel());
const cloudFastModel = () => envModel("AI_CLOUD_FAST_MODEL", "gemini-flash-lite-latest");
const ttsModel = () =>
  envModel("AI_TTS_MODEL", envModel("GEMINI_TTS_MODEL", "gemini-2.5-flash-preview-tts"));
const liveModel = () =>
  envModel("AI_LIVE_MODEL", envModel("GEMINI_LIVE_MODEL", "gemini-live-2.5-flash-preview"));
const nanoEnabled = () => String(process.env.AI_NANO || "").trim().toLowerCase() !== "off";

/** The voice a user hears: theirs, their avatar's, or the deployment's. */
function voiceFor(profile) {
  const chosen = profile && profile.assistant && profile.assistant.voice;
  if (chosen && VOICES.has(chosen)) return chosen;
  try {
    const face = require("../avatar/heygen").voiceForFace(profile && profile.assistant && profile.assistant.avatar_id);
    if (face && VOICES.has(face)) return face;
  } catch (_) {}
  const env = envModel("AI_TTS_VOICE", "Kore");
  return VOICES.has(env) ? env : "Kore";
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

async function forUser(userId, { build } = {}) {
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
  const voice = voiceFor(profile);
  return {
    models: {
      cloud: cloudModel(),
      cloudFast: cloudFastModel(),
      tts: ttsModel(),
      ttsVoice: voice,
      ttsLanguage: speechLanguage(profile && profile.user && profile.user.preferred_language),
      live: liveModel(),
      liveVoice: (() => {
        const v = envModel("AI_LIVE_VOICE", "");
        return v && VOICES.has(v) ? v : voice;
      })(),
    },
    nano: { enabled: nanoEnabled(), maxPromptChars: 9000 },
    routing: { toolWords, freshWords: FRESH_WORDS.slice(), shortcutNames },
    limits: { maxToolRounds: 6 },
  };
}

module.exports = {
  forUser, voiceFor, speechLanguage, cloudModel, cloudFastModel, ttsModel, liveModel,
  nanoEnabled, VOICES, TOOL_VERBS, FRESH_WORDS,
};
