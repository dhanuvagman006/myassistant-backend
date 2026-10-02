/**
 * AI PROVIDER ROUTER — OPENAI ONLY (2026-10-02)
 * --------------------------------------------
 * The owner: "completely remove Gemini as the API provider and use
 * OpenAI". One provider, services/ai/openai.js; this file keeps the
 * contracts the rest of the server was written against:
 *
 *   generateReply(messages, opts)         → { reply, provider, usage, model, ms }
 *   generateReplyStream(messages, opts)   → async iterator of text deltas
 *   generateWithTools({contents, system, declarations}) → { functionCalls, text }
 *   generateWithToolsStream({…, onDelta}) → the same, text streamed
 *   transcribeAudio(buffer, mime, opts)   → { text, language } | null
 *
 * `messages` is [{ role, content, images? }]; `contents` is Gemini's
 * content shape (the tool loop's), converted inside openai.js. A busy
 * provider (429/503) is retried once on the fallback model; a transient
 * network error is retried once after a short pause.
 */

// The same instructions as every conversation (ai/voicePrompt.js, 2026-10-02);
// the old default still promised food ordering, a feature removed weeks ago.
const SYSTEM_PROMPT = require("../../ai/voicePrompt").assistantRules("the assistant", "");

const openai = require("./openai");

const TIMEOUT_MS = 30_000;

/** A model name from the environment, or the fallback — never an empty string. */
function envModel(name, fallback) {
  const v = process.env[name];
  if (typeof v !== "string") return fallback;
  const s = v.trim();
  if (!s || !/^[a-z0-9.:_-]+$/i.test(s)) return fallback;
  return s;
}

const chatModel = () => openai.models.chat();
const fallbackModel = () => openai.models.fallback();
/** Kept for callers that once branched on the model family; nothing is Gemini now. */
const isGemini3 = () => false;

function isTransient(e) {
  const msg = String((e && e.message) || "");
  return e?.name === "TimeoutError" || e?.name === "AbortError" || /timeout|ECONNRESET|EAI_AGAIN|fetch failed/i.test(msg) || /\b5\d\d\b/.test(msg);
}

/** The second try: once more on the same model after a pause, then the fallback model when busy. */
async function withRetry(run, { model, noRetry = false } = {}) {
  try {
    return await run(model);
  } catch (e) {
    if (noRetry) throw e;
    if (isTransient(e) && !openai.isBusy(e)) {
      await new Promise((res) => setTimeout(res, 800));
      return run(model);
    }
    if (openai.isBusy(e) && fallbackModel() !== (model || chatModel())) {
      console.warn(`openai: ${model || chatModel()} busy (${e.status}) — retrying on ${fallbackModel()}`);
      return run(fallbackModel());
    }
    throw e;
  }
}

/**
 * generateReply(messages, opts) — opts: system, extraSystem, model, json,
 * schema, timeoutMs, noRetry, temperature, maxTokens. (`thinking`,
 * `mediaResolution` and `modelEnv` were Gemini knobs and are ignored.)
 */
async function generateReply(messages, opts = {}) {
  const system = opts.system || SYSTEM_PROMPT + (opts.extraSystem || "");
  const out = await withRetry(
    (model) => openai.chat({
      messages, system, model, json: !!opts.json, schema: opts.schema || null,
      temperature: opts.temperature, maxTokens: opts.maxTokens,
      timeoutMs: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : TIMEOUT_MS,
    }),
    { model: opts.model || null, noRetry: !!opts.noRetry },
  );
  return { reply: out.text, provider: "openai", usage: out.usage, model: out.model, ms: out.ms };
}

/** The voice-latency path: text deltas as they are generated. */
async function* generateReplyStream(messages, opts = {}) {
  const system = opts.system || SYSTEM_PROMPT + (opts.extraSystem || "");
  const chunks = [];
  let done = false;
  let error = null;
  let wake = () => {};
  const run = openai.chat({
    messages, system, model: opts.model || null, json: !!opts.json,
    timeoutMs: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60_000,
    stream: true,
    onDelta: (d) => { chunks.push(d); wake(); },
  }).then(() => { done = true; wake(); }, (e) => { error = e; done = true; wake(); });
  for (;;) {
    if (chunks.length) { yield chunks.shift(); continue; }
    if (done) break;
    await new Promise((res) => { wake = res; });
  }
  await run;
  if (error) throw error;
}

/** The assistant's tool loop, in Gemini's content shape (see openai.fromContents). */
async function generateWithTools({ contents, system, declarations = [], _model = null, timeoutMs = 0 }) {
  const out = await withRetry(
    (model) => openai.chat({ contents, system, model, declarations, timeoutMs: timeoutMs || TIMEOUT_MS }),
    { model: _model || null },
  );
  return { functionCalls: out.functionCalls, text: out.text, textSignature: undefined };
}

async function generateWithToolsStream({ contents, system, declarations = [], onDelta = () => {}, _model = null, timeoutMs = 0 }) {
  const out = await withRetry(
    (model) => openai.chat({ contents, system, model, declarations, timeoutMs: timeoutMs || 60_000, stream: true, onDelta }),
    { model: _model || null },
  );
  return { functionCalls: out.functionCalls, text: out.text, textSignature: undefined };
}

/**
 * A recording → { text, language }, or null when nothing could be heard
 * or the provider is not set up. opts: language (expected ISO code), hint, timeoutMs.
 */
async function transcribeAudio(buffer, mimeType, opts = {}) {
  if (!openai.ready()) return null;
  if (!buffer || !buffer.length) return { text: "", language: "unknown" };
  try {
    const out = await withRetry(
      () => openai.transcribe(buffer, mimeType, {
        language: opts.language || "", hint: opts.hint || "",
        timeoutMs: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60_000,
      }),
      { noRetry: !!opts.noRetry },
    );
    return { text: out.text, language: out.language || "unknown" };
  } catch (e) {
    console.warn("openai stt failed:", e.message);
    return null;
  }
}

module.exports = {
  generateWithTools,
  generateWithToolsStream,
  envModel,
  isGemini3,
  chatModel,
  fallbackModel,
  generateReply,
  generateReplyStream,
  transcribeAudio,
  SYSTEM_PROMPT,
};
