/**
 * IMAGE GENERATION — "make me a picture of ...".
 *
 * Provider chain, best first:
 *   1. Gemini image models (nano-banana family) — top quality, but Google
 *      removed image generation from the FREE tier entirely (Aug 2026:
 *      every *-image model 429s with "limit: 0"). The call is attempted
 *      so the feature upgrades itself the day billing is enabled, and a
 *      quota answer puts Gemini on a cooldown so day-to-day requests
 *      don't pay a wasted round-trip.
 *   2. Pollinations (image.pollinations.ai) — free, keyless, flux-based,
 *      measured ~3-8s for 1024². This is what actually serves today.
 *
 * Returns { buffer, mime, provider }. Throws only when EVERY provider
 * failed — callers turn that into a spoken apology.
 */

const GEMINI_COOLDOWN_MS = 6 * 3600_000;
let geminiBlockedUntil = 0; // module-level: one quota hit quiets it for hours

async function tryGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || Date.now() < geminiBlockedUntil) return null;
  const model = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: AbortSignal.timeout(45_000),
      }
    );
    if (r.status === 429 || r.status === 403) {
      geminiBlockedUntil = Date.now() + GEMINI_COOLDOWN_MS;
      console.warn(`imagegen: ${model} quota-blocked (${r.status}), cooling down`);
      return null;
    }
    if (!r.ok) return null;
    const d = await r.json();
    const parts = d?.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
      if (p.inlineData?.data) {
        return {
          buffer: Buffer.from(p.inlineData.data, "base64"),
          mime: p.inlineData.mimeType || "image/png",
          provider: "gemini",
        };
      }
    }
    return null;
  } catch (e) {
    console.warn("imagegen gemini:", e.message);
    return null;
  }
}

async function tryPollinations(prompt) {
  // Unkeyed GET; seed keeps "another one" from returning the same image.
  const seed = Math.floor(Math.random() * 1e9);
  const url =
    "https://image.pollinations.ai/prompt/" +
    encodeURIComponent(prompt.slice(0, 1400)) +
    `?width=1024&height=1024&nologo=true&model=flux&seed=${seed}`;
  const r = await fetch(url, {
    signal: AbortSignal.timeout(90_000),
    headers: { "User-Agent": "hari-assistant" },
  });
  const mime = r.headers.get("content-type") || "";
  if (!r.ok || !mime.startsWith("image/")) {
    throw new Error(`pollinations ${r.status} ${mime}`);
  }
  const buffer = Buffer.from(await r.arrayBuffer());
  if (buffer.length < 1024) throw new Error("pollinations returned junk");
  return { buffer, mime, provider: "pollinations" };
}

async function generateImage(prompt) {
  const p = String(prompt || "").trim();
  if (!p) throw new Error("empty prompt");
  return (await tryGemini(p)) || tryPollinations(p);
}

/** True once a Veo/quota probe said video needs the paid tier. */
let videoBlockedUntil = 0;

/**
 * Veo video generation — paid-tier only on this key today. One cheap probe
 * per cooldown window keeps the answer honest without burning time; the
 * moment billing is enabled the same code path starts returning real MP4s.
 * Returns { buffer, mime } or null when the plan doesn't allow it.
 */
async function tryVeoVideo(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || Date.now() < videoBlockedUntil) return null;
  const model = process.env.VEO_MODEL || "veo-3.1-fast-generate-preview";
  const base = "https://generativelanguage.googleapis.com/v1beta";
  try {
    const start = await fetch(`${base}/models/${model}:predictLongRunning?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [{ prompt }] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (start.status === 429 || start.status === 403) {
      videoBlockedUntil = Date.now() + GEMINI_COOLDOWN_MS;
      return null;
    }
    if (!start.ok) return null;
    const op = await start.json();
    // Poll up to ~3 minutes — Veo fast typically lands in 30-90s.
    for (let i = 0; i < 36; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const s = await fetch(`${base}/${op.name}?key=${key}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!s.ok) continue;
      const d = await s.json();
      if (!d.done) continue;
      const uri =
        d.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
        d.response?.generatedVideos?.[0]?.video?.uri;
      if (!uri) return null;
      const v = await fetch(uri.includes("key=") ? uri : `${uri}&key=${key}`, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!v.ok) return null;
      return { buffer: Buffer.from(await v.arrayBuffer()), mime: "video/mp4" };
    }
    return null;
  } catch (e) {
    console.warn("imagegen veo:", e.message);
    return null;
  }
}

module.exports = { generateImage, tryVeoVideo };
