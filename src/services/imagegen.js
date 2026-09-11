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
 *
 * QUALITY, without a paid key. Three things were costing visible quality
 * and none of them needed billing: everything came out 1024×1024 square,
 * so a poster, a card and a phone wallpaper were all cropped into a box;
 * the provider's own prompt enhancer was never switched on; and a
 * half-written response counted as success. The honest ceiling is still
 * the free flux model — the real jump is Gemini's image model, which this
 * file already tries first and which needs billing enabled on the key.
 */

/** Pixel sizes per shape. Larger than 1024 on the long edge is where the
 *  free model starts showing real detail; past ~1536 it mostly gets slow. */
const SHAPES = {
  square: { width: 1440, height: 1440 },
  portrait: { width: 1152, height: 1536 }, // posters, cards, phone wallpaper
  landscape: { width: 1536, height: 1024 }, // banners, scenes, wallpapers
  wide: { width: 1536, height: 864 }, // 16:9 — video frames, headers
};

/**
 * The real pixel size of a JPEG, read from its SOF marker. No dependency
 * for what is fifteen lines of header walking, and the alternative was
 * trusting the provider to honour the size it was asked for — which,
 * measured against the live tier, it does not.
 */
function jpegSize(buf) {
  try {
    if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      // SOF0..SOF15, minus the markers in that range that are not frames.
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  } catch (_) {}
  return null;
}

function shapeOf(aspect) {
  const a = String(aspect || "").toLowerCase();
  if (a.startsWith("port") || a === "9:16" || a === "3:4") return SHAPES.portrait;
  if (a === "wide" || a === "16:9") return SHAPES.wide;
  if (a.startsWith("land") || a === "4:3" || a === "3:2") return SHAPES.landscape;
  return SHAPES.square;
}

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

/**
 * The keyless tier's real ceiling, measured rather than documented:
 * asking for 1536x864 returns 1024x576 and asking for 1152x1536 returns
 * 665x886. Requesting more than this buys nothing and costs up to forty
 * extra seconds per image, so the request is capped to what will actually
 * come back. SHAPES stays at the ideal size for a provider that honours it.
 */
const KEYLESS_LONG_EDGE = 1024;

async function tryPollinations(prompt, { aspect, seed } = {}) {
  // Unkeyed GET; seed keeps "another one" from returning the same image.
  const s = Number.isFinite(seed) ? seed : Math.floor(Math.random() * 1e9);
  const ideal = shapeOf(aspect);
  const scale = Math.min(1, KEYLESS_LONG_EDGE / Math.max(ideal.width, ideal.height));
  const width = Math.round(ideal.width * scale);
  const height = Math.round(ideal.height * scale);
  const url =
    "https://image.pollinations.ai/prompt/" +
    encodeURIComponent(prompt.slice(0, 1400)) +
    `?width=${width}&height=${height}&nologo=true&model=flux` +
    // The provider's own prompt expander. Measurably better composition
    // and lighting on short prompts, and harmless on long ones.
    `&enhance=true&seed=${s}`;
  const r = await fetch(url, {
    // Bigger frames take longer; the old 90s was tuned for 1024².
    signal: AbortSignal.timeout(150_000),
    headers: { "User-Agent": "hari-assistant" },
  });
  const mime = r.headers.get("content-type") || "";
  if (!r.ok || !mime.startsWith("image/")) {
    throw new Error(`pollinations ${r.status} ${mime}`);
  }
  const buffer = Buffer.from(await r.arrayBuffer());
  // A truncated response is an image header and nothing behind it. At these
  // sizes anything under ~20 kB is a failure wearing an image mime type,
  // and it used to reach the user as a grey rectangle.
  if (buffer.length < 20 * 1024) {
    throw new Error(`pollinations returned ${buffer.length} bytes`);
  }
  // WHAT WE ASKED FOR IS NOT WHAT WE GOT. Measured against the live free
  // tier: 1536x864 comes back 1024x576 and 1152x1536 comes back 665x886.
  // Reporting the requested size made the logs and the ledger claim a
  // resolution the user never received.
  const real = jpegSize(buffer);
  return {
    buffer,
    mime,
    provider: "pollinations",
    width: real ? real.width : width,
    height: real ? real.height : height,
    requestedWidth: width,
    requestedHeight: height,
    downscaled: Boolean(real && real.width < width),
  };
}

/* ------------------------------------------------------------------ */
/* KEYED PROVIDERS — all optional, all inert until a key exists.       */
/*                                                                     */
/* The keyless tier is Sana at ~1024px with someone else's watermark.  */
/* Every provider below is a real step up and none of them requires    */
/* billing: each issues an API key on a free account. They are tried   */
/* in order and skipped silently when their key is absent, so adding   */
/* one is a single environment variable and nothing else changes.      */
/*                                                                     */
/* UNVERIFIED UNTIL A KEY EXISTS. These request shapes come from each  */
/* provider's documentation, not from a call that was actually made —  */
/* there is no key here to make one with. The first real call may need */
/* a correction; the chain is built so that a provider which fails or  */
/* 4xxs simply falls through to the next one rather than breaking      */
/* image generation.                                                   */
/* ------------------------------------------------------------------ */

/**
 * Cloudflare Workers AI — flux-1-schnell on the free neuron allowance.
 *
 * 10,000 neurons a day at no charge and no card. At 8 steps an image
 * costs about 96 neurons, so roughly a hundred a day free — and it is
 * FLUX rather than Sana, at full resolution, with nobody's watermark.
 *
 * TWO THINGS THE DOCS ARE SPECIFIC ABOUT, both of which the first draft
 * of this function got wrong:
 *  • it accepts prompt, steps and seed, and NOTHING ELSE. Sending width
 *    and height is a validation error, not a hint — the output size is
 *    fixed and the shape is cropped afterwards instead.
 *  • steps maxes out at 8. That is the quality dial, so it is pinned to
 *    the top: the free allowance is far larger than this app will use.
 */
async function tryCloudflare(prompt, { aspect, seed } = {}) {
  const acct = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  if (!acct || !token) return null;
  const model = process.env.CF_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";
  const steps = Math.min(Math.max(Number(process.env.CF_IMAGE_STEPS) || 8, 1), 8);
  try {
    const body = { prompt: prompt.slice(0, 2000), steps };
    // The video path fixes a seed so every keyframe is the same subject.
    if (Number.isFinite(seed)) body.seed = Math.abs(Math.trunc(seed)) % 4294967295;
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${model}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      }
    );
    if (!r.ok) {
      console.warn(`imagegen cloudflare: ${r.status}`);
      return null;
    }
    const type = String(r.headers.get("content-type") || "");
    // flux-1-schnell answers with base64 in JSON; the SDXL models answer
    // with raw image bytes. Handle both rather than assuming one.
    let buffer;
    let mime = "image/jpeg";
    if (type.includes("application/json")) {
      const j = await r.json();
      const b64 = j?.result?.image;
      if (!b64) return null;
      buffer = Buffer.from(b64, "base64");
    } else if (type.startsWith("image/")) {
      buffer = Buffer.from(await r.arrayBuffer());
      mime = type.split(";")[0];
    } else {
      return null;
    }
    if (buffer.length < 20 * 1024) return null;
    // The model returns ONE fixed shape, so the aspect the caller asked
    // for is produced by cropping rather than by requesting it. A poster
    // that arrives square and gets used square was the original
    // complaint; cropping a FLUX frame still beats a native Sana one.
    const shaped = await cropToAspect(buffer, mime, aspect);
    const real = jpegSize(shaped.buffer) || jpegSize(buffer);
    return {
      buffer: shaped.buffer,
      mime: shaped.mime,
      provider: "cloudflare",
      width: real ? real.width : 0,
      height: real ? real.height : 0,
    };
  } catch (e) {
    console.warn("imagegen cloudflare:", e.message);
    return null;
  }
}

/**
 * Centre-crop an image to the requested shape with ffmpeg, which is in
 * the runtime image for video generation anyway. Never throws: an image
 * in the wrong shape is far better than no image, so any failure returns
 * the original untouched.
 */
async function cropToAspect(buffer, mime, aspect) {
  const want = shapeOf(aspect);
  const ratio = want.width / want.height;
  const got = jpegSize(buffer);
  if (!got || Math.abs(got.width / got.height - ratio) < 0.02) {
    return { buffer, mime };
  }
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { execFile } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hari-crop-"));
  const inFile = path.join(dir, "in.jpg");
  const outFile = path.join(dir, "out.jpg");
  try {
    fs.writeFileSync(inFile, buffer);
    const w = got.width / got.height > ratio
      ? Math.round(got.height * ratio) : got.width;
    const h = got.width / got.height > ratio
      ? got.height : Math.round(got.width / ratio);
    await new Promise((resolve, reject) => {
      execFile(
        "ffmpeg",
        ["-y", "-v", "error", "-i", inFile,
         "-vf", `crop=${w}:${h}`, "-q:v", "2", outFile],
        { timeout: 20_000 },
        (err) => (err ? reject(err) : resolve())
      );
    });
    const out = fs.readFileSync(outFile);
    if (out.length < 10 * 1024) return { buffer, mime };
    return { buffer: out, mime: "image/jpeg" };
  } catch (e) {
    console.warn("imagegen crop failed, keeping the original:", e.message);
    return { buffer, mime };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

/** Hugging Face Inference — FLUX.1-schnell on a free account token. */
async function tryHuggingFace(prompt, { aspect } = {}) {
  const token = process.env.HF_TOKEN;
  if (!token) return null;
  const model = process.env.HF_IMAGE_MODEL || "black-forest-labs/FLUX.1-schnell";
  const { width, height } = shapeOf(aspect);
  try {
    const r = await fetch(`https://router.huggingface.co/hf-inference/models/${model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        inputs: prompt.slice(0, 1400),
        parameters: { width, height },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    // 503 means the model is warming up — worth one wait, not a chain exit.
    if (r.status === 503) {
      console.warn("imagegen huggingface: model loading");
      return null;
    }
    if (!r.ok) {
      console.warn(`imagegen huggingface: ${r.status}`);
      return null;
    }
    const mime = String(r.headers.get("content-type") || "image/jpeg").split(";")[0];
    if (!mime.startsWith("image/")) return null;
    const buffer = Buffer.from(await r.arrayBuffer());
    if (buffer.length < 20 * 1024) return null;
    const real = jpegSize(buffer);
    return {
      buffer, mime, provider: "huggingface",
      width: real ? real.width : width,
      height: real ? real.height : height,
    };
  } catch (e) {
    console.warn("imagegen huggingface:", e.message);
    return null;
  }
}

/** Together AI — FLUX.1-schnell-Free. */
async function tryTogether(prompt, { aspect } = {}) {
  const key = process.env.TOGETHER_API_KEY;
  if (!key) return null;
  const model = process.env.TOGETHER_IMAGE_MODEL || "black-forest-labs/FLUX.1-schnell-Free";
  const { width, height } = shapeOf(aspect);
  try {
    const r = await fetch("https://api.together.xyz/v1/images/generations", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: prompt.slice(0, 1400),
        width, height, steps: 4, n: 1,
        response_format: "b64_json",
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) {
      console.warn(`imagegen together: ${r.status}`);
      return null;
    }
    const j = await r.json();
    const b64 = j?.data?.[0]?.b64_json;
    if (!b64) return null;
    const buffer = Buffer.from(b64, "base64");
    if (buffer.length < 20 * 1024) return null;
    const real = jpegSize(buffer);
    return {
      buffer, mime: "image/jpeg", provider: "together",
      width: real ? real.width : width,
      height: real ? real.height : height,
    };
  } catch (e) {
    console.warn("imagegen together:", e.message);
    return null;
  }
}

/** Which keyed providers this deployment could use, for the health probe. */
function configuredProviders() {
  const out = [];
  if (process.env.GEMINI_API_KEY) out.push("gemini (needs billing)");
  if (process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN) out.push("cloudflare");
  if (process.env.HF_TOKEN) out.push("huggingface");
  if (process.env.TOGETHER_API_KEY) out.push("together");
  out.push("pollinations (keyless, Sana, watermarked)");
  return out;
}

/**
 * @param opts.aspect  square | portrait | landscape | wide
 * @param opts.seed    fixed seed — video frames share one so the subject
 *                     stays the same person/place from frame to frame.
 */
async function generateImage(prompt, opts = {}) {
  const p = String(prompt || "").trim();
  if (!p) throw new Error("empty prompt");
  // Best first, each skipped in a breath when its key is absent.
  for (const provider of [tryGemini, tryCloudflare, tryHuggingFace, tryTogether]) {
    const out = await provider(p, opts);
    if (out) return out;
  }
  try {
    return await tryPollinations(p, opts);
  } catch (e) {
    // ONE retry. A timeout or a truncated body at this size is usually the
    // provider being busy, and failing the whole request on the first
    // stumble is how "ask me to try again in a moment" became common.
    console.warn("imagegen retrying after:", e.message);
    return tryPollinations(p, { ...opts, seed: Math.floor(Math.random() * 1e9) });
  }
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

module.exports = {
  generateImage, tryVeoVideo, jpegSize, shapeOf, configuredProviders,
};
