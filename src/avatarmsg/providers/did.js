/**
 * D-ID adapter — managed fallback for the FACE stage.
 *
 * Lip-syncs the sender's photo against audio WE synthesized (so the voice
 * identity stays consistent no matter which face engine ran). Used when
 * the self-hosted worker is down/unconfigured and DID_API_KEY is set.
 * ~$1.10/min rendered on the Build tier — the "keep the feature alive"
 * path, not the cheap path.
 *
 * Flow: upload image + audio (private hosting on D-ID's side), create a
 * /talks job, poll until done, download the MP4, then delete the remote
 * artifacts — their storage is a processing buffer, not a home for
 * biometric assets.
 */
const fs = require("fs");

const API = "https://api.d-id.com";
const configured = () => Boolean(process.env.DID_API_KEY);

// D-ID uses HTTP Basic with the api key as username (docs: "Basic <key>").
const headers = () => ({ authorization: `Basic ${process.env.DID_API_KEY}` });

const POLL_MS = 2000;
const TIMEOUT_MS = Number(process.env.DID_TIMEOUT_MS || 120_000);

async function upload(kind /* images|audios */, buf, mime, filename) {
  const form = new FormData();
  form.append(kind === "images" ? "image" : "audio", new Blob([buf], { type: mime }), filename);
  const res = await fetch(`${API}/${kind}`, {
    method: "POST",
    headers: headers(),
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`did ${kind} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const j = await res.json();
  if (!j?.url) throw new Error(`did ${kind}: no url returned`);
  return j.url;
}

async function animate({ facePath, faceMime, audioBuf, audioMime }) {
  const imageUrl = await upload(
    "images",
    fs.readFileSync(facePath),
    faceMime || "image/jpeg",
    "face.jpg"
  );
  const audioUrl = await upload("audios", audioBuf, audioMime || "audio/wav", "speech.wav");

  const create = await fetch(`${API}/talks`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({
      source_url: imageUrl,
      script: { type: "audio", audio_url: audioUrl },
      config: { stitch: true },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!create.ok) {
    throw new Error(`did talks → ${create.status}: ${(await create.text()).slice(0, 200)}`);
  }
  const { id } = await create.json();
  if (!id) throw new Error("did talks: no id returned");

  const deadline = Date.now() + TIMEOUT_MS;
  let resultUrl = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const res = await fetch(`${API}/talks/${id}`, {
      headers: headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) continue;
    const j = await res.json();
    if (j.status === "done" && j.result_url) { resultUrl = j.result_url; break; }
    if (j.status === "error" || j.status === "rejected") {
      throw new Error(`did talk failed: ${JSON.stringify(j.error || j.status).slice(0, 200)}`);
    }
  }
  if (!resultUrl) throw new Error("did talk: timed out");

  const dl = await fetch(resultUrl, { signal: AbortSignal.timeout(60_000) });
  if (!dl.ok) throw new Error(`did download → ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());

  // Best-effort cleanup of the remote copies of the identity assets.
  fetch(`${API}/talks/${id}`, { method: "DELETE", headers: headers() }).catch(() => {});

  return { buf, mime: "video/mp4" };
}

module.exports = { name: "did", configured, animate };
