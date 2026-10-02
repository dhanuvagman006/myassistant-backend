/**
 * THE PROMPT BEFORE THE PICTURE (2026-09-30).
 * ----------------------------------------------------------------------
 * "A poster for Diwali" sent straight to an image model gets the model's
 * average Diwali. Most of what separates a good generation from a flat one
 * is in the words: what is in frame and where, the lens or medium, the
 * light, the palette, the mood. One short call to the server's existing
 * Gemini TEXT path (free tier, a lite model by default) writes those words
 * from the user's own, and adds the constraints that matter for the use.
 *
 * It is an improvement, never a dependency: switched off, without a key,
 * past its short deadline or on any odd answer, the user's words go on
 * as they are (with the constraints still added) and nobody waits.
 *
 * Every poster BACKGROUND carries the no-text rule, whether or not the
 * model call happened: the words on a poster are set by the app in real
 * fonts, and a model that paints letters paints them misspelt.
 */

const BACKGROUND_RULES =
  "no text, no letters, no logos, no watermark; leave clean negative space " +
  "at top and bottom for typography";

/** For providers that take a negative prompt (fal qwen-image). */
const BACKGROUND_NEGATIVE =
  "text, letters, words, typography, caption, logo, watermark, signature, " +
  "blurry, low quality, distorted";

const SYSTEM =
  "You write prompts for a text-to-image model. Turn the user's request into ONE strong " +
  "image prompt, in English, of at most 110 words: the subject exactly as the user " +
  "described it (never change who or what it is, never add people they did not ask for), " +
  "then composition and framing, the lens or medium, the lighting, the colour palette, " +
  "and the mood. Keep every appearance note given under mustKeep, word for word in " +
  "meaning. Never add written words, captions, signs, brand names or logos unless the " +
  "purpose is 'text' and the user asked for those exact words. For purpose 'background', " +
  "describe a scene or texture with NO text and NO people unless asked, with calm open " +
  "space at the top and bottom. Reply as JSON: {\"prompt\": string}.";

function enabled() {
  return String(process.env.IMAGE_PROMPT_ENHANCE || "on").toLowerCase() !== "off";
}

function timeoutMs() {
  const n = Number(process.env.IMAGE_PROMPT_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.min(n, 20_000) : 6000;
}

/** Quoted words become painted words; a background must carry none. */
function stripQuoted(s) {
  return String(s || "")
    .replace(/(\b(with|saying|reading|showing|that says)\s+)?["“”«»][^"“”«»]{0,120}["“”«»]/gi, " ")
    .replace(/\b(written|printed|lettered|spelled out|embossed)\b(\s+in\s+[\w-]+(\s+(letters|lettering|font|text))?)?/gi, " ")
    .replace(/\b(that says|saying|with the words?|with the text|reading|titled|caption(ed)?)\b[^,.;]*/gi, " ")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Constraints appended after the prompt, by purpose. */
function withRules(prompt, purpose) {
  const p = String(prompt || "").trim().replace(/[.\s]+$/, "");
  if (purpose === "background") return `${stripQuoted(p)}. ${BACKGROUND_RULES}.`;
  if (purpose === "photo") return `${p}. No watermark, no stray text.`;
  return `${p}.`;
}

function parseReply(reply) {
  const txt = String(reply || "").replace(/```json|```/g, "").trim();
  try {
    const j = JSON.parse(txt);
    const p = typeof j === "string" ? j : j && typeof j.prompt === "string" ? j.prompt : "";
    return p.replace(/\s+/g, " ").trim();
  } catch (_) {
    return "";
  }
}

/**
 * @param {string} words   the user's request, or the prompt the assistant wrote
 * @param {object} o
 * @param {'photo'|'text'|'background'} o.purpose
 * @param {string} o.style   poster style words, for backgrounds
 * @param {string} o.shape   'portrait' | 'story' | … — the frame it is for
 * @param {string[]} o.mustKeep  appearance notes (deity hints) to keep
 * @returns {Promise<{prompt:string, enhanced:boolean, skipped?:string}>}
 */
async function enhancePrompt(words, { purpose = "photo", style = "", shape = "", mustKeep = [] } = {}) {
  const raw = String(words || "").replace(/\s+/g, " ").trim().slice(0, 1400);
  const plain = (skipped) => ({ prompt: withRules(raw, purpose).slice(0, 1600), enhanced: false, skipped });
  if (!raw) return plain("empty");
  if (!enabled()) return plain("off");
  if (!require("./ai/openai").ready()) return plain("no key");
  // A prompt the assistant already wrote at length is left alone: the
  // call would cost a request of the shared free quota and add little.
  if (purpose !== "background" && raw.split(" ").length >= 60) return plain("already detailed");

  const router = require("./ai/router");
  const model = router.envModel("IMAGE_PROMPT_MODEL", router.chatModel());
  try {
    const { reply } = await router.generateReply(
      [{
        role: "user",
        content: JSON.stringify({
          request: raw, purpose, style: style || undefined, frame: shape || undefined,
          mustKeep: mustKeep.length ? mustKeep : undefined,
        }),
      }],
      {
        system: SYSTEM, json: true, model, modelEnv: "IMAGE_PROMPT_MODEL",
        timeoutMs: timeoutMs(), noRetry: true, thinking: "MINIMAL",
      }
    );
    const p = parseReply(reply);
    if (p.length < 20 || p.length > 1400) return plain("unusable answer");
    let out = p;
    // The deity notes are the one thing that must survive a rewrite.
    for (const hint of mustKeep) {
      if (!out.toLowerCase().includes(String(hint).slice(0, 24).toLowerCase())) out += `. ${hint}`;
    }
    return { prompt: withRules(out, purpose).slice(0, 1600), enhanced: true };
  } catch (e) {
    console.warn("imagePrompt: kept the words as they were —", String(e.message).slice(0, 120));
    return plain("model unavailable");
  }
}

module.exports = {
  enhancePrompt, withRules, stripQuoted, parseReply, BACKGROUND_RULES, BACKGROUND_NEGATIVE,
};
