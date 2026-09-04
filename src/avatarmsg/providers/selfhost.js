/**
 * Self-hosted GPU worker adapter — the primary (cheapest) engine.
 *
 * The worker (worker-avatar/, FastAPI) runs on any CUDA box — RunPod /
 * Vast.ai spot 4090 in production — and exposes two stage endpoints that
 * mirror this pipeline's two stages:
 *
 *   POST /tts     text + the user's voice SAMPLE  → wav   (Chatterbox,
 *                 zero-shot cloning: no per-user training, the sample is
 *                 the identity)
 *   POST /render  face photo + wav                → mp4   (MuseTalk)
 *   GET  /health  → { ok, engines: { tts, face } }
 *
 * Everything is per-request multipart: the worker holds no user state, so
 * it can be a stateless spot instance that comes and goes. Identity assets
 * never leave our infrastructure except to this worker, which we operate.
 */
const fs = require("fs");
const path = require("path");

const base = () => String(process.env.AVATAR_WORKER_URL || "").replace(/\/$/, "");
const configured = () => Boolean(base());

const TIMEOUT_TTS = Number(process.env.AVATAR_WORKER_TTS_TIMEOUT_MS || 30_000);
const TIMEOUT_RENDER = Number(process.env.AVATAR_WORKER_RENDER_TIMEOUT_MS || 120_000);

function headers() {
  const h = {};
  if (process.env.AVATAR_WORKER_KEY) {
    h.authorization = `Bearer ${process.env.AVATAR_WORKER_KEY}`;
  }
  return h;
}

async function post(pathname, form, timeoutMs) {
  const res = await fetch(base() + pathname, {
    method: "POST",
    headers: headers(),
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`worker ${pathname} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function filePart(form, field, filePath, fallbackMime) {
  const buf = fs.readFileSync(filePath);
  form.append(
    field,
    new Blob([buf], { type: fallbackMime }),
    path.basename(filePath)
  );
}

/** { ok, engines } or { ok:false }. Never throws. */
async function health() {
  if (!configured()) return { ok: false, reason: "not configured" };
  try {
    const res = await fetch(base() + "/health", {
      headers: headers(),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { ok: false, reason: `status ${res.status}` };
    return await res.json();
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** Voice stage: clone-and-speak in one shot. Returns { buf, mime }. */
async function synthesize({ text, voicePath, voiceMime, language }) {
  const form = new FormData();
  form.append("text", text);
  if (language) form.append("language", language);
  filePart(form, "voice", voicePath, voiceMime || "audio/wav");
  const buf = await post("/tts", form, TIMEOUT_TTS);
  return { buf, mime: "audio/wav" };
}

/** Face stage: photo + speech → lip-synced video. Returns { buf, mime }. */
async function animate({ facePath, faceMime, audioBuf, audioMime, quality }) {
  const form = new FormData();
  form.append("quality", quality || "standard");
  filePart(form, "face", facePath, faceMime || "image/jpeg");
  form.append("audio", new Blob([audioBuf], { type: audioMime || "audio/wav" }), "speech.wav");
  const buf = await post("/render", form, TIMEOUT_RENDER);
  return { buf, mime: "video/mp4" };
}

module.exports = { name: "selfhost", configured, health, synthesize, animate };
