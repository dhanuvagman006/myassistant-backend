/**
 * THE PHONE'S MODEL, ANSWERED BY OUR SERVER (2026-10-02).
 *
 * The app sends exactly what it used to send Gemini — Gemini's own
 * request shape, built by the SDK — to POST /ai/generate, and reads back
 * Gemini's response shape (one JSON, or server-sent chunks). Behind it
 * everything is OpenAI (services/ai/openai.js): a reply with tool calls,
 * a spoken sentence (responseModalities AUDIO → gpt-4o-mini-tts as 24 kHz
 * PCM), a recorded turn (an audio part in the question → gpt-4o-transcribe),
 * and a fresh-facts question (the googleSearch tool → our own web search
 * folded into the prompt, the pages returned as grounding chunks). The
 * app's brain, speech and listening code never learn the provider moved.
 */
const openai = require("../services/ai/openai");

const TTS_VOICES = {
  // The names the app's pickers still show → the nearest OpenAI voice.
  Fola: "shimmer", Kore: "sage", Aoede: "nova", Puck: "echo", Charon: "onyx", Fenrir: "ash",
  Sulafat: "shimmer", Callirrhoe: "shimmer", Achernar: "nova", Vindemiatrix: "sage", Achird: "verse",
  Zephyr: "alloy", Leda: "shimmer", Orus: "onyx", Autonoe: "nova", Enceladus: "ash",
};

/**
 * The voices the fast-voice picker offers on OpenAI: shimmer, the default
 * (the owner, 2026-10-02), then marin and cedar (a woman's, a man's).
 */
const REALTIME_VOICES = ["shimmer", "marin", "cedar", "coral", "sage", "verse", "ballad", "ash"];

/** The OpenAI voice for a name the app knows, or the served default. */
function voiceFor(name) {
  const n = String(name || "").trim();
  if (openai.VOICES.includes(n)) return n;
  return TTS_VOICES[n] || openai.models.ttsVoice();
}

const partsOf = (c) => (c && Array.isArray(c.parts) ? c.parts : []);
const textOf = (c) => partsOf(c).filter((p) => typeof p.text === "string").map((p) => p.text).join("\n");
const systemOf = (body) => textOf(body.systemInstruction || body.system_instruction) || "";

/**
 * NO TAGS ON THE SCREEN OR IN THE VOICE (2 Oct: "<sincere and apologetic>"
 * and "<stay_silent>" reached the owner). A leading delivery note written
 * without "tone:" becomes the tone note the app understands; any other
 * angle-bracket word goes. "x < 5" is left alone (a tag starts with a letter).
 */
const STRAY_TAG = /<\s*(?!tone\s*:)[A-Za-z][A-Za-z _,'&-]{0,58}>/gi;
function cleanText(text, atStart = true) {
  let out = String(text || "");
  if (atStart) {
    out = out.replace(/^(\s*)<\s*(?!tone\s*:)([A-Za-z][A-Za-z ,'&-]{2,58}?)\s*>/i,
      (m, sp, inner) => (/\s/.test(inner) || /^(warm|calm|bright|gentle|sincere|cheerful|firm|playful|serious)/i.test(inner) ? `${sp}<tone: ${inner.trim()}>` : sp));
  }
  return out.replace(STRAY_TAG, "").replace(/[ \t]{2,}/g, " ");
}
/** The same for a reply that streams: a tag split across pieces is held until it closes. */
function tagFilter() {
  let pending = "";
  let started = false;
  const run = (text) => {
    const out = cleanText(text, !started);
    if (text.trim()) started = true;
    return out;
  };
  return {
    push(delta) {
      pending += String(delta || "");
      const lt = pending.lastIndexOf("<");
      let cut = pending.length;
      if (lt >= 0 && pending.indexOf(">", lt) < 0 && pending.length - lt <= 64) cut = lt;
      const ready = pending.slice(0, cut);
      pending = pending.slice(cut);
      return ready ? run(ready) : "";
    },
    flush() {
      const rest = pending;
      pending = "";
      return rest ? run(rest) : "";
    },
  };
}

/** A `<tone: warm, unhurried>` note at the head of a sentence → the manner, and the words. */
function splitTone(text) {
  const m = /^\s*<tone:\s*([^>]{1,120})>\s*/i.exec(String(text || ""));
  return m ? { instructions: m[1].trim(), text: String(text).slice(m[0].length) } : { instructions: "", text: String(text || "") };
}

function chunk(parts, { finishReason, grounding } = {}) {
  const candidate = { content: { role: "model", parts }, index: 0 };
  if (finishReason) candidate.finishReason = finishReason;
  if (grounding) candidate.groundingMetadata = grounding;
  return { candidates: [candidate] };
}

/**
 * Answer one Gemini-shaped request. `emit(json)` is called for each
 * response chunk (several when streaming, one otherwise); returns when
 * done. Throws on a provider failure; the route turns that into an error.
 */
async function generate(body, { stream = false, emit, userId } = {}) {
  const contents = Array.isArray(body.contents) ? body.contents : [];
  const gen = body.generationConfig || body.generation_config || {};
  const system = systemOf(body);
  const last = contents[contents.length - 1] || {};
  const modalities = (gen.responseModalities || gen.response_modalities || []).map((m) => String(m).toUpperCase());

  // Spoken audio: the sentence (with its tone note) → speech.
  if (modalities.includes("AUDIO")) {
    const split = splitTone(cleanText(textOf(last)));
    const instructions = split.instructions;
    const text = split.text.replace(/<[^<>\n]{1,60}>/g, " ").replace(/\s{2,}/g, " ").trim();
    const speech = gen.speechConfig || gen.speech_config || {};
    const voiceName = speech.voiceConfig?.prebuiltVoiceConfig?.voiceName || speech.voice_config?.prebuilt_voice_config?.voice_name || speech.voiceName || "";
    const audioPart = (b) => ({ inlineData: { mimeType: "audio/pcm;rate=24000", data: b.toString("base64") } });
    if (!stream) {
      const out = await openai.speak(text, { voice: voiceFor(voiceName), instructions, format: "pcm" });
      emit(chunk([audioPart(out.buffer)], { finishReason: "STOP" }));
      return;
    }
    // Streamed: each piece goes out as it is made; the last carries STOP.
    let held = null;
    await openai.speakStream(text, {
      voice: voiceFor(voiceName), instructions,
      onChunk: (b) => { if (held) emit(chunk([audioPart(held)])); held = b; },
    });
    emit(chunk(held ? [audioPart(held)] : [], { finishReason: "STOP" }));
    return;
  }

  // A recording in the question: transcribe it, answer with the words.
  const audio = partsOf(last).map((p) => p.inlineData || p.inline_data).find((d) => d && /^audio\//i.test(d.mimeType || d.mime_type || ""));
  if (audio) {
    const lang = /language is ([a-z]{2})/i.exec(textOf(last) + " " + system);
    const out = await openai.transcribe(Buffer.from(audio.data, "base64"), audio.mimeType || audio.mime_type, { hint: lang ? lang[1] : "" });
    emit(chunk([{ text: out.text }], { finishReason: "STOP" }));
    return;
  }

  // Tools: function declarations as they are; googleSearch → our search.
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const declarations = tools.flatMap((t) => t.functionDeclarations || t.function_declarations || []);
  const wantsSearch = tools.some((t) => t.googleSearch || t.google_search);
  const mode = String(body.toolConfig?.functionCallingConfig?.mode || body.tool_config?.function_calling_config?.mode || "AUTO").toUpperCase();
  let sys = system;
  let grounding = null;
  if (wantsSearch) {
    const q = textOf(last).slice(0, 300);
    try {
      const found = await require("../tools/webSearch").run(q, { userId });
      const results = found && found.ok ? (Array.isArray(found.data) ? found.data : found.data?.results || []) : [];
      const pages = found && found.ok && found.data && found.data.pages ? found.data.pages : [];
      if (results.length) {
        const answer = results[0] && results[0].answer ? results[0] : null;
        sys += "\n\nFRESH FACTS FROM THE WEB (use these, cite nothing else as current):\n" +
          (answer
            ? `${answer.snippet}\nSources: ${results.slice(1, 6).map((r) => r.title).join("; ")}`
            : results.slice(0, 6).map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`).join("\n")) +
          (pages.length ? "\n" + pages.map((p) => `From ${p.site}: ${p.lines.join(" | ")}`).join("\n") : "");
        grounding = {
          groundingChunks: results.filter((r) => r.url && !r.answer).slice(0, 6).map((r) => ({ web: { uri: r.url, title: r.title } })),
          groundingSupports: [], webSearchQueries: [q],
        };
      }
    } catch (e) {
      console.warn("proxy search skipped:", e.message);
    }
  }

  const json = /json/i.test(String(gen.responseMimeType || gen.response_mime_type || ""));
  const schema = gen.responseSchema || gen.response_schema || null;
  const tooling = mode === "NONE" ? [] : declarations;
  const common = { contents, system: sys, json, schema, declarations: tooling, temperature: typeof gen.temperature === "number" ? gen.temperature : undefined, maxTokens: gen.maxOutputTokens || gen.max_output_tokens || undefined, timeoutMs: 60_000 };

  if (!stream) {
    const out = await openai.chat(common);
    emit(chunk(responseParts(out), { finishReason: "STOP", grounding }));
    return;
  }
  const tags = tagFilter();
  const out = await openai.chat({ ...common, stream: true, onDelta: (d) => { const t = tags.push(d); if (t) emit(chunk([{ text: t }])); } });
  const tail = tags.flush();
  if (tail) emit(chunk([{ text: tail }]));
  const calls = out.functionCalls.map((c) => ({ functionCall: { name: c.name, args: c.args, id: c.id } }));
  // The text already went out as it came; the calls and the end go last.
  emit(chunk(calls, { finishReason: "STOP", grounding }));
}

function responseParts(out) {
  const parts = [];
  const text = cleanText(out.text || "");
  if (text.trim()) parts.push({ text });
  for (const c of out.functionCalls) parts.push({ functionCall: { name: c.name, args: c.args, id: c.id } });
  return parts;
}

/** What the app shows and sends while OpenAI is the provider. */
function servedModels() {
  return {
    cloud: openai.models.chat(),
    cloudFast: openai.models.fast(),
    cloudFallback: openai.models.fallback(),
    tts: openai.models.tts(),
    live: openai.models.realtime(),
  };
}

module.exports = { generate, voiceFor, splitTone, servedModels, TTS_VOICES, REALTIME_VOICES, chunk, cleanText, tagFilter };
