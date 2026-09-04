/**
 * Gemini TTS adapter — the ALWAYS-AVAILABLE voice floor.
 *
 * Not the user's cloned voice: this is the same neural TTS the assistant
 * already speaks with (services/ai/router.synthesizeSpeech). It exists so
 * that when no cloning engine is reachable the recipient still gets a
 * spoken message with the sender's face (Level 2/3 fallback) instead of
 * nothing. Costs nothing extra — same GEMINI_API_KEY as everything else.
 */
const configured = () => Boolean(process.env.GEMINI_API_KEY);

async function synthesize({ text, language, voice }) {
  const { synthesizeSpeech } = require("../../services/ai/router");
  const { wav } = await synthesizeSpeech(text, { language, voice });
  return { buf: wav, mime: "audio/wav" };
}

module.exports = { name: "gemini", configured, synthesize };
