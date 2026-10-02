/**
 * OPENAI — THE ONE MODEL PROVIDER (2026-10-02, the owner: "completely
 * remove Gemini as the API provider and use OpenAI").
 *
 * Everything the server asks a model for goes through here: a reply
 * (with pictures or a PDF in the question), a reply with tool calls (the
 * assistant's own tool loop, in Gemini's content shape the callers still
 * speak), a transcript of a recording, spoken audio, a picture made or
 * edited, and a short-lived key for the phone's realtime voice. One key,
 * OPENAI_API_KEY; the models by env with sane defaults:
 *
 *   OPENAI_MODEL            gpt-4.1-mini     replies, tools, planning
 *   OPENAI_SMART_MODEL      gpt-4.1          documents, when asked for
 *   OPENAI_STT_MODEL        gpt-4o-transcribe
 *   OPENAI_TTS_MODEL        gpt-4o-mini-tts  (voice OPENAI_TTS_VOICE, default coral)
 *   OPENAI_IMAGE_MODEL      gpt-image-1      make AND edit pictures
 *   OPENAI_REALTIME_MODEL   gpt-realtime     the phone's fast voice
 *   OPENAI_EMBED_MODEL      text-embedding-3-small (memory/embeddings.js)
 *
 * The callers' contracts are unchanged (services/ai/router.js): what was
 * written against Gemini keeps working, only the provider behind it moved.
 */
const BASE = () => String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const TIMEOUT_MS = 30_000;

function key() {
  return String(process.env.OPENAI_API_KEY || "").trim();
}
function ready() {
  return Boolean(key());
}

function env(name, fallback) {
  const v = String(process.env[name] || "").trim();
  return v && /^[a-z0-9.:_-]+$/i.test(v) ? v : fallback;
}
const models = {
  chat: () => env("OPENAI_MODEL", "gpt-4.1-mini"),
  smart: () => env("OPENAI_SMART_MODEL", "gpt-4.1"),
  fallback: () => env("OPENAI_FALLBACK_MODEL", "gpt-4.1-mini"),
  stt: () => env("OPENAI_STT_MODEL", "gpt-4o-transcribe"),
  tts: () => env("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"),
  ttsVoice: () => env("OPENAI_TTS_VOICE", "coral"),
  image: () => env("OPENAI_IMAGE_MODEL", "gpt-image-1"),
  realtime: () => env("OPENAI_REALTIME_MODEL", "gpt-realtime"),
  embed: () => env("OPENAI_EMBED_MODEL", "text-embedding-3-small"),
};

/** The voices gpt-4o-mini-tts and gpt-realtime offer. */
const VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"];

class OpenAIError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "OpenAIError";
    this.status = status;
    this.body = String(body || "").slice(0, 600);
  }
}

// A 429 or a 5xx quiets the provider for a moment so twenty callers do
// not hammer it; isBusy lets the router decide on a fallback model.
let busyUntil = 0;
function isBusy(e) {
  return e && (e.status === 429 || e.status === 503 || e.status === 529);
}

async function call(path, { body, form, timeoutMs = TIMEOUT_MS, raw = false, headers = {} } = {}) {
  const k = key();
  if (!k) throw new OpenAIError("OPENAI_API_KEY is not set", 0, "");
  const h = { authorization: `Bearer ${k}`, ...headers };
  let payload = form;
  if (!form) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const r = await fetch(`${BASE()}${path}`, {
    method: "POST", headers: h, body: payload, signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    if (r.status === 429) busyUntil = Date.now() + 15_000;
    throw new OpenAIError(`openai ${path} ${r.status}: ${text.slice(0, 300) || "(empty body)"}`, r.status, text);
  }
  return raw ? r : r.json();
}

// ---------------------------------------------------------------- messages

function dataUrl(mime, data) {
  return `data:${mime || "image/jpeg"};base64,${Buffer.isBuffer(data) ? data.toString("base64") : String(data)}`;
}

/** A picture or a document as a message part. */
function mediaPart(mime, data, filename) {
  const m = String(mime || "image/jpeg").toLowerCase();
  if (m === "application/pdf") {
    return { type: "file", file: { filename: filename || "document.pdf", file_data: dataUrl(m, data) } };
  }
  if (m.startsWith("audio/")) {
    // Chat models hear wav and mp3; anything else is transcribed first (transcribe()).
    const format = /mp3|mpeg/.test(m) ? "mp3" : "wav";
    return { type: "input_audio", input_audio: { data: Buffer.isBuffer(data) ? data.toString("base64") : String(data), format } };
  }
  return { type: "image_url", image_url: { url: dataUrl(m, data) } };
}

/**
 * The simple shape the router's generateReply takes:
 * [{ role: "user"|"assistant"|"system", content, images?: [{mime,data,filename?}] }]
 */
function fromSimple(system, messages) {
  const out = [];
  if (system) out.push({ role: "system", content: String(system) });
  for (const m of messages || []) {
    const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
    const media = Array.isArray(m.images) ? m.images.filter((i) => i && i.data) : [];
    if (role === "user" && media.length) {
      out.push({
        role,
        content: [
          ...media.map((i) => mediaPart(i.mime, i.data, i.filename)),
          { type: "text", text: String(m.content ?? "") },
        ],
      });
    } else {
      out.push({ role, content: String(m.content ?? "") });
    }
  }
  return out;
}

/**
 * Gemini's content shape, which the tool loop speaks:
 *   { role: "user"|"model", parts: [{text} | {functionCall:{name,args}} |
 *     {functionResponse:{name,response}} | {inline_data|inlineData:{mime_type,data}}] }
 * → OpenAI messages. A model turn's calls get ids; the user turn that
 * follows answers them in the same order, so the ids line up.
 */
function fromContents(system, contents) {
  const out = [];
  if (system) out.push({ role: "system", content: String(system) });
  let pendingIds = [];
  let n = 0;
  for (const c of contents || []) {
    const parts = Array.isArray(c.parts) ? c.parts : [];
    if (c.role === "model") {
      const text = parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("\n").trim();
      const calls = parts.filter((p) => p.functionCall).map((p) => ({
        id: `call_${++n}`, type: "function",
        function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
      }));
      pendingIds = calls.map((c2) => c2.id);
      if (text || calls.length) {
        out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      }
      continue;
    }
    const responses = parts.filter((p) => p.functionResponse);
    if (responses.length) {
      responses.forEach((p, i) => {
        out.push({
          role: "tool",
          tool_call_id: pendingIds[i] || `call_${++n}`,
          content: JSON.stringify(p.functionResponse.response ?? {}),
        });
      });
      pendingIds = [];
    }
    const media = parts.filter((p) => p.inline_data || p.inlineData).map((p) => p.inline_data || p.inlineData);
    const text = parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("\n");
    if (text.trim() || media.length) {
      out.push({
        role: "user",
        content: media.length
          ? [...media.map((d) => mediaPart(d.mime_type || d.mimeType, d.data)), { type: "text", text }]
          : text,
      });
    }
  }
  return out;
}

/** Function declarations (the registry's JSON schema) → OpenAI tools. */
function toTools(declarations) {
  const clean = (s) => {
    if (!s || typeof s !== "object") return { type: "object", properties: {} };
    const o = { ...s };
    if (typeof o.type === "string") o.type = o.type.toLowerCase();
    if (o.properties) {
      o.properties = Object.fromEntries(Object.entries(o.properties).map(([k, v]) => [k, clean(v)]));
      if (!o.type) o.type = "object";
    }
    if (o.items) o.items = clean(o.items);
    delete o.nullable;
    return o;
  };
  return (declarations || []).map((d) => ({
    type: "function",
    function: {
      name: d.name,
      description: String(d.description || "").slice(0, 1024),
      parameters: clean(d.parameters || d.inputSchema),
    },
  }));
}

// ---------------------------------------------------------------- chat

/**
 * One reply. Takes EITHER `messages` (the simple shape) OR `contents`
 * (Gemini's). Returns { text, functionCalls:[{name,args}], usage, model, ms }.
 * `json` asks for a JSON object; `schema` (a JSON schema) pins its shape.
 * With `stream`, the text arrives through onDelta as it is generated.
 */
async function chat({
  messages, contents, system, model, json = false, schema = null, declarations = [],
  temperature, maxTokens, timeoutMs = TIMEOUT_MS, stream = false, onDelta = () => {},
} = {}) {
  const started = Date.now();
  const m = model || models.chat();
  const body = {
    model: m,
    messages: contents ? fromContents(system, contents) : fromSimple(system, messages),
    ...(declarations.length ? { tools: toTools(declarations) } : {}),
    ...(typeof temperature === "number" ? { temperature } : {}),
    ...(maxTokens ? { max_completion_tokens: maxTokens } : {}),
    ...(json
      ? schema
        ? { response_format: { type: "json_schema", json_schema: { name: "answer", schema: toTools([{ parameters: schema }])[0].function.parameters } } }
        : { response_format: { type: "json_object" } }
      : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
  if (!stream) {
    const data = await call("/chat/completions", { body, timeoutMs });
    return finish(data, m, started);
  }
  const r = await call("/chat/completions", { body, timeoutMs, raw: true });
  return readStream(r, m, started, onDelta);
}

function parseArgs(s) {
  try { return s ? JSON.parse(s) : {}; } catch (_) { return {}; }
}

function finish(data, model, started) {
  const choice = (data.choices || [])[0] || {};
  const msg = choice.message || {};
  const text = typeof msg.content === "string" ? msg.content.trim()
    : Array.isArray(msg.content) ? msg.content.map((p) => p.text || "").join("").trim() : "";
  const functionCalls = (msg.tool_calls || [])
    .filter((c) => c.type === "function" && c.function)
    .map((c) => ({ name: c.function.name, args: parseArgs(c.function.arguments), id: c.id }));
  return { text, functionCalls, usage: data.usage || null, model: data.model || model, ms: Date.now() - started, finish: choice.finish_reason || "" };
}

/** Server-sent chat chunks → the same answer as finish(), text streamed out. */
async function readStream(r, model, started, onDelta) {
  const decoder = new TextDecoder();
  const reader = r.body.getReader();
  let buf = "";
  let text = "";
  const calls = new Map(); // index -> { id, name, args }
  let usage = null;
  let finishReason = "";
  const take = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let j;
    try { j = JSON.parse(payload); } catch (_) { return; }
    if (j.usage) usage = j.usage;
    const choice = (j.choices || [])[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const d = choice.delta || {};
    if (typeof d.content === "string" && d.content) {
      text += d.content;
      try { onDelta(d.content); } catch (_) { /* a listener's problem */ }
    }
    for (const tc of d.tool_calls || []) {
      const slot = calls.get(tc.index) || { id: tc.id || "", name: "", args: "" };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
      calls.set(tc.index, slot);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      take(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
    }
  }
  if (buf.trim()) take(buf.trim());
  const functionCalls = [...calls.keys()].sort((a, b) => a - b).map((k) => calls.get(k))
    .filter((c) => c.name).map((c) => ({ name: c.name, args: parseArgs(c.args), id: c.id }));
  return { text: text.trim(), functionCalls, usage, model, ms: Date.now() - started, finish: finishReason };
}

// ---------------------------------------------------------------- hearing and speaking

/**
 * A recording → { text, language }. `language` is the ISO-639-1 code to
 * expect (or "" to detect); `hint` is a softer version of the same. The
 * audio can be wav, mp3, m4a, webm, ogg, flac or raw pcm16 (wrapped).
 */
async function transcribe(buffer, mime, { language = "", hint = "", prompt = "", timeoutMs = 60_000 } = {}) {
  const m = String(mime || "audio/wav").toLowerCase();
  let data = buffer;
  let name = "audio.wav";
  if (/mp3|mpeg/.test(m)) name = "audio.mp3";
  else if (/m4a|mp4|aac/.test(m)) name = "audio.m4a";
  else if (/webm/.test(m)) name = "audio.webm";
  else if (/ogg|opus/.test(m)) name = "audio.ogg";
  else if (/flac/.test(m)) name = "audio.flac";
  else if (/pcm|l16|raw/.test(m)) {
    const rate = Number((/rate=(\d+)/.exec(m) || [])[1]) || 16000;
    data = wavWrap(buffer, rate);
  }
  const form = new FormData();
  form.append("model", models.stt());
  form.append("file", new Blob([data], { type: m.startsWith("audio/") ? m : "audio/wav" }), name);
  form.append("response_format", "json");
  const lang = String(language || hint || "").trim().slice(0, 2).toLowerCase();
  if (lang && /^[a-z]{2}$/.test(lang) && lang !== "un") form.append("language", lang);
  if (prompt) form.append("prompt", String(prompt).slice(0, 800));
  const j = await call("/audio/transcriptions", { form, timeoutMs });
  const text = String(j.text || "").trim();
  return { text, language: lang || String(j.language || "") };
}

/** Raw 16-bit mono PCM → a WAV the transcriber accepts. */
function wavWrap(pcm, rate = 16000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Words → spoken audio. `format` "pcm" is 24 kHz 16-bit mono (what the
 * phone plays); "mp3" for a file. `instructions` is the manner: "warm and
 * unhurried", "firm" — the same tone words the rest of the app uses.
 */
async function speak(text, { voice, instructions = "", format = "pcm", timeoutMs = 30_000 } = {}) {
  const v = VOICES.includes(String(voice || "")) ? voice : models.ttsVoice();
  const r = await call("/audio/speech", {
    body: {
      model: models.tts(), voice: v, input: String(text || "").slice(0, 4000),
      response_format: format === "mp3" ? "mp3" : "pcm",
      ...(instructions ? { instructions: String(instructions).slice(0, 1000) } : {}),
    },
    timeoutMs, raw: true,
  });
  const buffer = Buffer.from(await r.arrayBuffer());
  return { buffer, mime: format === "mp3" ? "audio/mpeg" : "audio/pcm;rate=24000", rate: 24000 };
}

// ---------------------------------------------------------------- pictures

/** gpt-image-1's sizes; the nearest to the shape asked for. */
function imageSize(width, height) {
  if (!width || !height) return "1024x1024";
  const r = width / height;
  if (r > 1.2) return "1536x1024";
  if (r < 0.83) return "1024x1536";
  return "1024x1024";
}

/** A picture from words. Returns { buffer, mime: "image/png" }. */
async function imageGenerate(prompt, { width, height, quality = "medium", timeoutMs = 90_000 } = {}) {
  const j = await call("/images/generations", {
    body: { model: models.image(), prompt: String(prompt).slice(0, 4000), n: 1, size: imageSize(width, height), quality, output_format: "png" },
    timeoutMs,
  });
  return fromImageResponse(j);
}

/** A picture changed as instructed, keeping what the instruction keeps. images: [{buffer, mime}] */
async function imageEdit(prompt, images, { width, height, quality = "medium", timeoutMs = 120_000 } = {}) {
  const form = new FormData();
  form.append("model", models.image());
  form.append("prompt", String(prompt).slice(0, 4000));
  form.append("n", "1");
  form.append("size", imageSize(width, height));
  form.append("quality", quality);
  (images || []).slice(0, 4).forEach((im, i) => {
    const mime = /png/i.test(im.mime || "") ? "image/png" : /webp/i.test(im.mime || "") ? "image/webp" : "image/jpeg";
    form.append("image[]", new Blob([im.buffer], { type: mime }), `image-${i}.${mime.split("/")[1]}`);
  });
  const j = await call("/images/edits", { form, timeoutMs });
  return fromImageResponse(j);
}

function fromImageResponse(j) {
  const d = (j.data || [])[0];
  if (!d || !d.b64_json) throw new OpenAIError("openai image: no image in the answer", 0, JSON.stringify(j).slice(0, 200));
  const buffer = Buffer.from(d.b64_json, "base64");
  return { buffer, mime: "image/png" };
}

// ---------------------------------------------------------------- realtime

/**
 * A short-lived key the phone uses to open its own realtime voice session
 * (the app never sees OPENAI_API_KEY). Returns { value, expiresAt, model }.
 */
async function realtimeClientSecret({ voice, instructions = "", tools = [], model } = {}) {
  const m = model || models.realtime();
  const j = await call("/realtime/client_secrets", {
    body: {
      session: {
        type: "realtime", model: m,
        ...(instructions ? { instructions: String(instructions).slice(0, 60_000) } : {}),
        audio: {
          input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: { type: "semantic_vad", eagerness: "medium", create_response: true, interrupt_response: true } },
          output: { format: { type: "audio/pcm", rate: 24000 }, voice: VOICES.includes(String(voice || "")) ? voice : models.ttsVoice() },
        },
        ...(tools.length ? { tools: toTools(tools).map((t) => ({ type: "function", ...t.function })) } : {}),
      },
    },
    timeoutMs: 15_000,
  });
  const value = j.value || (j.client_secret && j.client_secret.value) || "";
  if (!value) throw new OpenAIError("openai realtime: no client secret in the answer", 0, JSON.stringify(j).slice(0, 200));
  return { value, expiresAt: Number(j.expires_at || (j.client_secret && j.client_secret.expires_at) || 0), model: m };
}

module.exports = {
  ready, key, models, VOICES, OpenAIError, isBusy, busy: () => Date.now() < busyUntil,
  chat, transcribe, speak, imageGenerate, imageEdit, realtimeClientSecret,
  // for tests
  fromSimple, fromContents, toTools, wavWrap, imageSize,
};
