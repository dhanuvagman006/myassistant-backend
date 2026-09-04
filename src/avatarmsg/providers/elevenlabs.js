/**
 * ElevenLabs adapter — managed voice-clone fallback for the VOICE stage.
 *
 * Used when no self-hosted worker is reachable but ELEVENLABS_API_KEY is
 * set. Instant Voice Clone is created once per user from their consented
 * sample and the voice_id is stored on the profile (voice_provider =
 * 'elevenlabs'); synthesis then costs ~$0.05/min on Flash v2.5.
 */
const fs = require("fs");

const API = "https://api.elevenlabs.io";
const configured = () => Boolean(process.env.ELEVENLABS_API_KEY);
const MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";

const headers = () => ({ "xi-api-key": process.env.ELEVENLABS_API_KEY });

/** One-time IVC from the user's sample. Returns the voice_id. */
async function cloneVoice({ samplePath, sampleMime, label }) {
  const form = new FormData();
  form.append("name", label || "myassistant-user");
  form.append(
    "files",
    new Blob([fs.readFileSync(samplePath)], { type: sampleMime || "audio/wav" }),
    "sample"
  );
  const res = await fetch(`${API}/v1/voices/add`, {
    method: "POST",
    headers: headers(),
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`elevenlabs clone → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const j = await res.json();
  if (!j?.voice_id) throw new Error("elevenlabs clone: no voice_id returned");
  return j.voice_id;
}

async function deleteVoice(voiceId) {
  if (!voiceId) return;
  await fetch(`${API}/v1/voices/${encodeURIComponent(voiceId)}`, {
    method: "DELETE",
    headers: headers(),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {});
}

/** Voice stage. Returns { buf, mime } (mp3 — D-ID and the app accept it). */
async function synthesize({ text, voiceRef }) {
  if (!voiceRef) throw new Error("elevenlabs: profile has no voice_ref");
  const res = await fetch(
    `${API}/v1/text-to-speech/${encodeURIComponent(voiceRef)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: MODEL }),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!res.ok) {
    throw new Error(`elevenlabs tts → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return { buf: Buffer.from(await res.arrayBuffer()), mime: "audio/mpeg" };
}

module.exports = { name: "elevenlabs", configured, cloneVoice, deleteVoice, synthesize };
