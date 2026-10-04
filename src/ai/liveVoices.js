/**
 * THE VOICES THE APP OFFERS (the owner, 2026-10-03: "the voice option in
 * the app is not matching with the voice option provided by GPT Live …
 * remove the fake voice names … the user can test each and every voice").
 *
 * The 18 voices OpenAI accepts for gpt-live-1 on this account (checked
 * against the API 2026-10-03: juniper/breeze/vale/ember are refused), with
 * the playground's tags. A sample of each is recorded ONCE from GPT-Live
 * itself (it has no speech endpoint) and kept in /app/data/voice-samples,
 * so the picker plays the real voice.
 *
 * The spoken fallback (gpt-4o-mini-tts) knows only the older ten; a
 * GPT-Live-only voice falls back to the nearest of the same gender.
 */
const fs = require("fs");
const path = require("path");

const CATALOG = [
  // GPT-Live's own (playground tags).
  { id: "gleam", gender: "female", accent: "North American", tagline: "Warm and conversational" },
  { id: "willow", gender: "female", accent: "Irish", tagline: "Expressive and bright" },
  { id: "bossa", gender: "female", accent: "Brazilian Portuguese", tagline: "Clear and direct" },
  { id: "ripple", gender: "male", accent: "Australian", tagline: "Warm and conversational" },
  { id: "vesper", gender: "male", accent: "British", tagline: "Clear and direct" },
  { id: "stone", gender: "male", accent: "Irish", tagline: "Calm and precise" },
  { id: "meridian", gender: "male", accent: "North American", tagline: "Grounded and measured" },
  { id: "tempo", gender: "male", accent: "Brazilian Portuguese", tagline: "Grounded and measured" },
  { id: "cedar", gender: "male", accent: "North American", tagline: "Open and upbeat" },
  // OpenAI's earlier voices, also on GPT-Live.
  { id: "marin", gender: "female", accent: "North American", tagline: "Natural and clear" },
  { id: "shimmer", gender: "female", accent: "North American", tagline: "Bright and gentle" },
  { id: "coral", gender: "female", accent: "North American", tagline: "Warm and friendly" },
  { id: "sage", gender: "female", accent: "North American", tagline: "Calm and thoughtful" },
  { id: "alloy", gender: "female", accent: "North American", tagline: "Balanced and neutral" },
  { id: "ash", gender: "male", accent: "North American", tagline: "Clear and confident" },
  { id: "ballad", gender: "male", accent: "British", tagline: "Smooth and expressive" },
  { id: "echo", gender: "male", accent: "North American", tagline: "Steady and resonant" },
  { id: "verse", gender: "male", accent: "North American", tagline: "Lively and versatile" },
].map((v) => ({ ...v, name: v.id[0].toUpperCase() + v.id.slice(1) }));

const IDS = new Set(CATALOG.map((v) => v.id));
const DEFAULT_VOICE = "gleam";
// What gpt-4o-mini-tts can say (the classic, typed-reply voice).
const TTS_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);

const byId = (id) => CATALOG.find((v) => v.id === String(id || "").toLowerCase()) || null;
const has = (id) => IDS.has(String(id || "").toLowerCase());

/** The speech model's voice for a catalog voice: itself, or the nearest of its gender. */
function ttsVoiceFor(id) {
  const v = byId(id);
  if (!v) return null;
  if (TTS_VOICES.has(v.id)) return v.id;
  return v.gender === "male" ? "cedar" : "shimmer";
}

// ---------------------------------------------------------------- samples

const DIR = process.env.VOICE_SAMPLE_DIR || "/app/data/voice-samples";
const making = new Map();
const fileOf = (id) => path.join(DIR, `${id}.wav`);

function sampleLine(v) {
  return `Hi, I'm ${v.name}. This is how I'll sound when we talk.`;
}

/**
 * Records one voice from GPT-Live: a spoken "hello" goes in, its reply —
 * told to say exactly the sample line — is kept as 24 kHz PCM.
 */
async function record(v, { timeoutMs = 30_000, line = null } = {}) {
  const openai = require("../services/ai/openai");
  const hello = await openai.speak("Hello! Please introduce yourself.", { format: "pcm" });
  const helloPcm = Buffer.isBuffer(hello) ? hello : Buffer.from(hello.buffer || hello.audio || hello);
  const ws = new WebSocket("wss://api.openai.com/v1/live/sessions", {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });
  const parts = [];
  let lastAudioAt = 0;
  return new Promise((resolve, reject) => {
    const done = (err) => {
      clearTimeout(cap);
      clearInterval(watch);
      try { ws.send(JSON.stringify({ type: "session.close" })); } catch (_) {}
      setTimeout(() => { try { ws.close(); } catch (_) {} }, 500);
      if (err) return reject(err);
      const pcm = Buffer.concat(parts);
      return pcm.length > 24000 ? resolve(pcm) : reject(new Error("no sample audio"));
    };
    const cap = setTimeout(() => done(parts.length ? null : new Error("sample timed out")), timeoutMs);
    // Her line is over once audio has stopped for 1.5 s.
    const watch = setInterval(() => {
      if (lastAudioAt && Date.now() - lastAudioAt > 1500) done();
    }, 250);
    ws.onerror = (e) => done(new Error(`sample socket: ${e.message || "error"}`));
    ws.onopen = () => ws.send(JSON.stringify({
      type: "session.start",
      session: {
        model: "gpt-live-1",
        instructions:
          `When you are greeted, say exactly this and nothing else: "${line || sampleLine(v)}" ` +
          openai.ACCENT,
        audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: v.id } },
      },
    }));
    ws.onmessage = async (m) => {
      let e;
      try { e = JSON.parse(m.data); } catch (_) { return; }
      if (e.type === "session.output_audio.delta" && e.delta) {
        parts.push(Buffer.from(e.delta, "base64"));
        lastAudioAt = Date.now();
      } else if (e.type === "error") {
        done(new Error(String((e.error && e.error.message) || "GPT-Live error")));
      } else if (e.type === "session.started") {
        const send = (b) => ws.send(JSON.stringify({ type: "session.input_audio.append", audio: b.toString("base64") }));
        for (let i = 0; i < helloPcm.length; i += 4800) {
          send(helloPcm.subarray(i, i + 4800));
          await new Promise((r) => setTimeout(r, 100));
        }
        const quiet = Buffer.alloc(4800);
        for (let i = 0; i < 60 && !lastAudioAt; i++) {
          send(quiet);
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    };
  });
}

/** The voice's sample as a WAV, recorded the first time it is asked for. */
async function sample(id) {
  const v = byId(id);
  if (!v) return null;
  const file = fileOf(v.id);
  try {
    return await fs.promises.readFile(file);
  } catch (_) {}
  if (!making.has(v.id)) {
    making.set(v.id, (async () => {
      const pcm = await record(v);
      const wav = require("../services/ai/openai").wavWrap(pcm, 24000);
      await fs.promises.mkdir(DIR, { recursive: true });
      await fs.promises.writeFile(file, wav);
      return wav;
    })().finally(() => making.delete(v.id)));
  }
  return making.get(v.id);
}

/**
 * THE ORB'S HELLO, IN HER LIVE VOICE (owner, 2026-10-04: "hello sir every
 * time I tap, in the exact same voice"). GPT-Live ignores a "greet now"
 * instruction too often, so the line is recorded once per voice and
 * wording from GPT-Live itself, kept on disk, and the phone plays it the
 * instant the orb is tapped.
 */
/**
 * Her speech in a 16-bit mono PCM take, as runs of sound split by pauses of
 * 300 ms or more: [[startSample, endSample], ...].
 */
function voicedRuns(pcm, rate = 24000) {
  const win = rate / 50; // 20 ms
  const n = Math.floor(pcm.length / 2);
  const runs = [];
  let start = -1;
  let last = -1;
  for (let i = 0; i + win <= n; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) {
      const x = pcm.readInt16LE(j * 2);
      sum += x * x;
    }
    if (Math.sqrt(sum / win) > 400) {
      if (start < 0) start = i;
      else if (i - last > rate * 0.3) {
        runs.push([start, last + win]);
        start = i;
      }
      last = i;
    }
  }
  if (start >= 0) runs.push([start, last + win]);
  return runs;
}

/** The take from the first run to the end of run [k] (80 ms kept around). */
function upTo(pcm, runs, k, rate = 24000) {
  const pad = Math.round(rate * 0.08);
  const n = Math.floor(pcm.length / 2);
  return pcm.subarray(Math.max(0, runs[0][0] - pad) * 2, Math.min(n, runs[k][1] + pad) * 2);
}

const GREETING_LINE = /^[\p{L} .,!?'’-]{2,60}$/u;
async function greeting(id, line) {
  const v = byId(id);
  const text = String(line || "").trim();
  if (!v || !GREETING_LINE.test(text)) return null;
  const key = require("crypto").createHash("sha1").update(`${v.id}|${text}`).digest("hex").slice(0, 16);
  const file = path.join(DIR, `greet-${key}.wav`);
  try {
    return await fs.promises.readFile(file);
  } catch (_) {}
  if (!making.has(key)) {
    making.set(key, (async () => {
      // CHECKED BY EAR (2026-10-04): she sometimes cuts the line short or
      // adds to it ("…today? I'm your assistant"). The take is split at its
      // pauses and the SHORTEST opening that, transcribed, is exactly the
      // line is kept; otherwise it is recorded again.
      const openai = require("../services/ai/openai");
      const norm = (t) => String(t || "").toLowerCase().replace(/[^\p{L} ]/gu, "").replace(/\s+/g, " ").trim();
      let pcm = null;
      for (let i = 0; i < 4 && !pcm; i++) {
        const take = await record(v, { line: text });
        const runs = voicedRuns(take);
        for (let k = 0; k < Math.min(runs.length, 4) && !pcm; k++) {
          const part = upTo(take, runs, k);
          const heard = await openai.transcribe(openai.wavWrap(part, 24000), "audio/wav").catch(() => null);
          if (heard && norm(heard.text) === norm(text)) pcm = part;
        }
        if (!pcm) console.warn(`greeting ${v.id}: take ${i + 1} did not say the line, again`);
      }
      if (!pcm) throw new Error("no clean greeting take");
      const wav = openai.wavWrap(pcm, 24000);
      await fs.promises.mkdir(DIR, { recursive: true });
      await fs.promises.writeFile(file, wav);
      return wav;
    })().finally(() => making.delete(key)));
  }
  return making.get(key);
}

module.exports = { CATALOG, DEFAULT_VOICE, has, byId, ttsVoiceFor, sample, greeting, record, sampleLine };
