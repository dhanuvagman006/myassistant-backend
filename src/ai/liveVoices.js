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
const DEFAULT_VOICE = "coral";
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

/**
 * Runs 0..k of the take, joined with a natural 200 ms pause (a long gap
 * after "Hello Sir," sounded broken), 80 ms of air kept at each end.
 */
function upTo(pcm, runs, k, rate = 24000) {
  const pad = Math.round(rate * 0.08);
  const n = Math.floor(pcm.length / 2);
  const gap = Buffer.alloc(Math.round(rate * 0.2) * 2);
  const parts = [];
  for (let i = 0; i <= k; i++) {
    const from = i === 0 ? Math.max(0, runs[i][0] - pad) : runs[i][0];
    const to = i === k ? Math.min(n, runs[i][1] + pad) : runs[i][1];
    if (i > 0) parts.push(gap);
    parts.push(pcm.subarray(from * 2, to * 2));
  }
  return Buffer.concat(parts);
}

/**
 * As loud as it can be without clipping (peak at -1 dBFS): her recorded
 * hello came out far quieter than her live voice (2026-10-04).
 */
function louder(pcm) {
  const n = Math.floor(pcm.length / 2);
  let peak = 1;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i * 2)));
  const gain = Math.min(8, (32767 * 0.89) / peak);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(pcm.readInt16LE(i * 2) * gain), i * 2);
  return out;
}

/**
 * The line alone: the speech that starts within 1.6 s of her first sound
 * (a "Hello Sir." is one or two runs), joined naturally; anything the model
 * added after it is dropped.
 */
function openingOnly(pcm, rate = 24000) {
  const runs = voicedRuns(pcm, rate);
  if (!runs.length) return pcm;
  let k = 0;
  while (k + 1 < runs.length && runs[k + 1][0] - runs[0][0] < rate * 1.6) k++;
  return upTo(pcm, runs, k, rate);
}

const GREETING_LINE = /^[\p{L} .,!?'’-]{2,60}$/u;
async function greeting(id, line) {
  const v = byId(id);
  const text = String(line || "").trim();
  if (!v || !GREETING_LINE.test(text)) return null;
  // v5 (2026-10-06): RECORDED FROM GPT-LIVE ITSELF, not text-to-speech. The
  // TTS model has no gleam/willow/meridian…, so those came out in another
  // voice. Now the take is the live model saying the line in this voice, so
  // the opening and the conversation after it are the same voice. Kept at
  // its natural level (no boost): the phone plays it on the call stream,
  // like the live audio, so the two sound equally loud.
  const key = require("crypto").createHash("sha1").update(`gptlive-v5|${v.id}|${text}`).digest("hex").slice(0, 16);
  const file = path.join(DIR, `greet5-${key}.wav`);
  try {
    return await fs.promises.readFile(file);
  } catch (_) {}
  if (!making.has(key)) {
    making.set(key, (async () => {
      const openai = require("../services/ai/openai");
      // CHECKED BY EAR (2026-10-06): a take is transcribed and kept only
      // when it says the line; measured, 2 of 20 did not ("What?", "Hello
      // ma'am"). Up to three takes, then the best effort is refused.
      const words = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
      let wav = null;
      for (let attempt = 1; attempt <= 3 && !wav; attempt++) {
        const take = openai.wavWrap(openingOnly(await record(v, { line: text })), 24000);
        const heard = await openai.transcribe(take, "audio/wav", { language: "en" }).catch(() => null);
        const said = heard && (heard.text != null ? heard.text : heard);
        if (words(said) === words(text)) wav = take;
        else console.warn(`voices: ${v.id} take ${attempt} of "${text}" said "${String(said).slice(0, 40)}"`);
      }
      if (!wav) throw new Error(`no clean take of "${text}" in ${v.id}`);
      await fs.promises.mkdir(DIR, { recursive: true });
      await fs.promises.writeFile(file, wav);
      return wav;
    })().finally(() => making.delete(key)));
  }
  return making.get(key);
}

/**
 * EVERY OPENING RECORDED AHEAD (2026-10-06, the owner: "save that in our
 * backend … instantly pull from there"). Each natural GPT-Live voice says
 * "Hello Sir." and "Hello Madam." once, on the server, at boot, so no user
 * ever waits for a take: a voice switch on any phone is a ~35 KB download.
 * One at a time (each take is a short GPT-Live session, about $0.01);
 * what is already on disk is skipped. Never blocks the server.
 */
const OPENING_LINES = ["Hello Sir.", "Hello Madam."];
async function warmOpenings(voiceIds) {
  const ids = voiceIds || require("./gptLive").NATURAL_VOICES;
  let made = 0, kept = 0, failed = 0;
  for (const id of ids) {
    for (const line of OPENING_LINES) {
      const v = byId(id);
      if (!v) continue;
      const key = require("crypto").createHash("sha1").update(`gptlive-v5|${v.id}|${line}`).digest("hex").slice(0, 16);
      const had = fs.existsSync(path.join(DIR, `greet5-${key}.wav`));
      try {
        await greeting(id, line);
        if (had) kept++; else made++;
      } catch (e) {
        failed++;
        console.warn(`voices: opening "${line}" in ${id} failed: ${String(e.message || e).slice(0, 120)}`);
      }
    }
  }
  console.log(`voices: openings ready (${made} recorded, ${kept} already kept, ${failed} failed)`);
  return { made, kept, failed };
}

module.exports = { OPENING_LINES, warmOpenings, CATALOG, DEFAULT_VOICE, has, byId, ttsVoiceFor, sample, greeting, record, sampleLine, openingOnly, voicedRuns };
