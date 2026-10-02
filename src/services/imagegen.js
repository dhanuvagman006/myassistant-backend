/**
 * IMAGE GENERATION — "make me a picture of ...".
 *
 * PROVIDER CHAIN (rebuilt 2026-09-30). Every provider is inert until its
 * key exists, and the chain is ordered by QUALITY among the ones that are
 * actually available, per purpose:
 *
 *   photo / illustration: gemini → fal z-image → cloudflare klein → fal qwen
 *   words in the picture: gemini → fal qwen-image → cloudflare klein → fal z-image
 *   then (all purposes):  cloudflare schnell → HF / Together (opt-in only)
 *                         → Pollinations, the keyless last resort
 *
 *   • gemini — gemini-3.1-flash-image. No free tier for image OUTPUT on any
 *     model (Google pricing, 2026-09-24): GEMINI_IMAGE_BILLING=on says the
 *     key's project has billing; 'auto' (default) probes and cools down 6 h
 *     on a quota answer; 'off' never calls it. responseModalities ['IMAGE']
 *     and imageConfig.aspectRatio are sent, so the shape is honoured.
 *   • fal (FAL_KEY) — qwen-image-2512 ($0.02, the best open model at
 *     words) and z-image turbo (~$0.005/MP, photoreal). Results are
 *     downloaded; fal's CDN copy is temporary.
 *   • cloudflare (CF_ACCOUNT_ID + CF_API_TOKEN) — FLUX.2 klein 4B on the
 *     free 10k neurons a day (~95 images). Multipart form, width/height
 *     honoured. flux-1-schnell (JSON) stays behind it as a fallback.
 *   • HF / Together — the old FLUX.1-schnell defaults were dead (HF's
 *     hf-inference went mostly CPU in 2025; Together dropped the Free
 *     model), so they run only when HF_IMAGE_MODEL / TOGETHER_IMAGE_MODEL
 *     name a model on purpose.
 *   • pollinations — keyless, ≤1024 px, what served every image until now.
 *
 * NO MULTI-MINUTE WORST CASE. Each keyed provider gets at most
 * IMAGE_PROVIDER_TIMEOUT_MS (40 s) and the whole call IMAGE_TOTAL_BUDGET_MS
 * (75 s, prompt writing included), with time held back for the keyless
 * tier. It used to be 45+90+120+120+150 s plus a retry.
 *
 * AFTER THE PROVIDER (imagePost.finish): cropped and scaled to the exact
 * target shape (lanczos + mild unsharp; fal esrgan first when FAL_KEY and
 * the image is far too small), tags stripped, JPEG q≈90.
 *
 * Returns { buffer, mime, provider, width, height, prompt, enhanced }.
 * Throws only when EVERY provider failed — callers turn that into a
 * spoken apology.
 */

const imagePrompt = require("./imagePrompt");

/** Pixel sizes per shape — the size the image is FOR. poster and story
 *  are the photo cards' 4:5 and 9:16 (posters/spec.js FORMATS). */
const SHAPES = {
  square: { width: 1440, height: 1440, ratio: "1:1" },
  portrait: { width: 1152, height: 1536, ratio: "3:4" }, // cards, phone wallpaper
  landscape: { width: 1536, height: 1024, ratio: "3:2" }, // banners, scenes
  wide: { width: 1536, height: 864, ratio: "16:9" }, // video frames, headers
  poster: { width: 1080, height: 1350, ratio: "4:5" }, // feed post, poster card
  story: { width: 1080, height: 1920, ratio: "9:16" }, // WhatsApp status, reels
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

/** JPEG, PNG or WebP. */
function sizeOf(buf) {
  return jpegSize(buf) || require("./imageEdit").imageSize(buf);
}

function shapeName(aspect) {
  const a = String(aspect || "").toLowerCase();
  if (a === "poster" || a === "4:5") return "poster";
  if (a === "story" || a === "9:16" || a === "tall") return "story";
  if (a.startsWith("port") || a === "3:4" || a === "2:3") return "portrait";
  if (a === "wide" || a === "16:9") return "wide";
  if (a.startsWith("land") || a === "4:3" || a === "3:2") return "landscape";
  return "square";
}

function shapeOf(aspect) {
  return SHAPES[shapeName(aspect)];
}

/** A shape scaled so its long edge is at most `maxEdge`, in multiples of
 *  16 — rounded UP, so an unscaled size is never a few pixels short. */
function fitEdge(shape, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(shape.width, shape.height));
  const r16 = (n) => Math.max(256, Math.ceil(Math.round(n * scale) / 16) * 16);
  return { width: r16(shape.width), height: r16(shape.height) };
}

/* ------------------------------------------------------------------ */
/* TIME                                                                */
/* ------------------------------------------------------------------ */

function envMs(name, fallback, { min = 1000, max = 600_000 } = {}) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
}

/** Time held back for the keyless tier, so a slow keyed provider can
 *  never leave the last resort with nothing. */
const KEYLESS_RESERVE_MS = 25_000;

function budget() {
  const started = Date.now();
  const total = envMs("IMAGE_TOTAL_BUDGET_MS", 75_000);
  const per = envMs("IMAGE_PROVIDER_TIMEOUT_MS", 40_000);
  return {
    left: () => total - (Date.now() - started),
    /** The timeout for one keyed provider: never past the reserve. */
    keyed() { return Math.min(per, this.left() - KEYLESS_RESERVE_MS); },
    keyless() { return Math.min(60_000, this.left()); },
  };
}

/* ------------------------------------------------------------------ */
/* GEMINI                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* OpenAI gpt-image-1 (2026-10-02): the one picture model — it makes a   */
/* picture from words and edits one it is given (imageEdit.js).         */
/* ------------------------------------------------------------------ */
function openaiAvailable() {
  const openai = require("./ai/openai");
  return openai.ready() && !openai.busy();
}

async function tryOpenAI(prompt, { shape, timeoutMs = 90_000 } = {}) {
  const openai = require("./ai/openai");
  if (!openai.ready()) return null;
  const s = shape || SHAPES.square;
  try {
    const img = await openai.imageGenerate(prompt, { width: s.width, height: s.height, timeoutMs });
    return { ...img, provider: `openai:${openai.models.image()}` };
  } catch (e) {
    console.warn("imagegen openai:", e.message);
    if (e.status === 429) require("../ops/alerts").imageQuota(`gpt-image-1: 429`).catch(() => {});
    return null;
  }
}

const fal = require("./fal");

function falModelFor(kind) {
  return kind === "text"
    ? process.env.FAL_TEXT_IMAGE_MODEL || "fal-ai/qwen-image-2512"
    : process.env.FAL_IMAGE_MODEL || "fal-ai/z-image/turbo";
}

async function tryFal(prompt, { kind = "photo", shape, seed, negative, timeoutMs = 40_000 } = {}) {
  if (!fal.falReady()) return null;
  const model = falModelFor(kind);
  const size = fitEdge(shape || SHAPES.square, Number(process.env.FAL_MAX_EDGE) || 1536);
  const input = {
    prompt: prompt.slice(0, 2000),
    image_size: size,
    num_images: 1,
    output_format: "jpeg",
    enable_safety_checker: true,
  };
  if (Number.isFinite(seed)) input.seed = Math.abs(Math.trunc(seed)) % 2147483647;
  // qwen-image documents a negative prompt; z-image turbo does not.
  if (negative && /qwen/i.test(model)) input.negative_prompt = negative;
  try {
    const j = await fal.falRun(model, input, { timeoutMs });
    if (j.has_nsfw_concepts && j.has_nsfw_concepts[0]) {
      console.warn(`imagegen fal ${model}: flagged by the safety checker`);
      return null;
    }
    const ref = fal.firstImage(j);
    if (!ref) return null;
    const out = await fal.download(ref, { timeoutMs: 20_000 });
    if (out.buffer.length < 10 * 1024) return null;
    const real = sizeOf(out.buffer);
    return {
      buffer: out.buffer, mime: out.mime, provider: `fal:${model}`,
      width: real ? real.width : size.width,
      height: real ? real.height : size.height,
    };
  } catch (e) {
    console.warn("imagegen fal:", e.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* CLOUDFLARE WORKERS AI                                               */
/* ------------------------------------------------------------------ */

/**
 * FLUX.2 klein 4B (default) or flux-1-schnell on the free neuron allowance.
 *
 * The two take DIFFERENT request shapes, per Cloudflare's model pages:
 *  • klein: multipart/form-data — prompt, width, height, seed (steps is
 *    fixed at 4). Size is honoured, capped by CF_IMAGE_MAX_EDGE (1280)
 *    because every 512² tile costs neurons.
 *  • schnell: JSON {prompt, steps ≤ 8, seed} — NOTHING else; width and
 *    height are a validation error. One fixed size, shaped afterwards.
 * Either can answer {"result":{"image":"<base64>"},"success":true} or the
 * raw bytes, so both are read; the envelope was checked against the docs,
 * not a live call, hence the defensive parse.
 */
let cfBlockedUntil = 0;

function cfAvailable() {
  return !!(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN) && Date.now() >= cfBlockedUntil;
}

function cfIsMultipart(model) {
  return /flux-2|klein/i.test(model);
}

function cfDecode(j) {
  if (!j || typeof j !== "object") return null;
  const cands = [j.result && j.result.image, j.image, j.result && j.result.images && j.result.images[0],
    typeof j.result === "string" ? j.result : null];
  for (const c of cands) {
    if (typeof c === "string" && c.length > 100) {
      return Buffer.from(c.replace(/^data:[^;]+;base64,/, ""), "base64");
    }
  }
  return null;
}

async function tryCloudflare(prompt, { shape, seed, timeoutMs = 40_000 } = {}, model = null) {
  const acct = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  if (!acct || !token || Date.now() < cfBlockedUntil) return null;
  const m = model || process.env.CF_IMAGE_MODEL || "@cf/black-forest-labs/flux-2-klein-4b";
  const multipart = cfIsMultipart(m);
  const s = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) % 4294967295 : null;
  let body;
  let headers = { authorization: `Bearer ${token}` };
  let asked = null;
  if (multipart) {
    asked = fitEdge(shape || SHAPES.square, Number(process.env.CF_IMAGE_MAX_EDGE) || 1280);
    body = new FormData();
    body.append("prompt", prompt.slice(0, 2000));
    body.append("width", String(asked.width));
    body.append("height", String(asked.height));
    if (s !== null) body.append("seed", String(s));
    // No content-type header: fetch writes the multipart boundary itself.
  } else {
    const steps = Math.min(Math.max(Number(process.env.CF_IMAGE_STEPS) || 8, 1), 8);
    const b = { prompt: prompt.slice(0, 2000), steps };
    if (s !== null) b.seed = s;
    body = JSON.stringify(b);
    headers["content-type"] = "application/json";
  }
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${m}`, {
      method: "POST", headers, body, signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      // A token without Workers AI rights (401/403) is not fixed by the
      // next request; the day's allowance spent (429) is back tomorrow.
      if (r.status === 401 || r.status === 403) cfBlockedUntil = Date.now() + 6 * 3600_000;
      else if (r.status === 429) cfBlockedUntil = Date.now() + 30 * 60_000;
      console.warn(`imagegen cloudflare ${m}: ${r.status} ${t.replace(/\s+/g, " ").slice(0, 160)}`);
      return null;
    }
    const type = String(r.headers.get("content-type") || "");
    let buffer;
    let mime = "image/jpeg";
    if (type.startsWith("image/")) {
      buffer = Buffer.from(await r.arrayBuffer());
      mime = type.split(";")[0];
    } else {
      const j = await r.json().catch(() => null);
      if (j && j.success === false) {
        console.warn(`imagegen cloudflare ${m}: ${JSON.stringify(j.errors || []).slice(0, 160)}`);
        return null;
      }
      buffer = cfDecode(j);
      if (!buffer) return null;
      if (buffer[0] === 0x89 && buffer[1] === 0x50) mime = "image/png";
    }
    if (buffer.length < 20 * 1024) return null;
    const real = sizeOf(buffer);
    return {
      buffer, mime, provider: `cloudflare:${m.split("/").pop()}`,
      width: real ? real.width : asked ? asked.width : 0,
      height: real ? real.height : asked ? asked.height : 0,
    };
  } catch (e) {
    console.warn(`imagegen cloudflare ${m}:`, e.message);
    return null;
  }
}

/** schnell behind klein: klein's multipart shape is the newer one, and a
 *  validation answer from it should not cost the free tier. */
function cfFallbackModel() {
  const m = String(process.env.CF_FALLBACK_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell").trim();
  return m.toLowerCase() === "off" ? null : m;
}

async function tryCloudflareFallback(prompt, opts) {
  const m = cfFallbackModel();
  const primary = process.env.CF_IMAGE_MODEL || "@cf/black-forest-labs/flux-2-klein-4b";
  if (!m || m === primary) return null;
  return tryCloudflare(prompt, opts, m);
}

/* ------------------------------------------------------------------ */
/* HUGGING FACE / TOGETHER — STRICTLY OPT-IN                           */
/* ------------------------------------------------------------------ */

/** Hugging Face Inference — only with HF_TOKEN AND HF_IMAGE_MODEL. */
async function tryHuggingFace(prompt, { shape, timeoutMs = 40_000 } = {}) {
  const token = process.env.HF_TOKEN;
  const model = process.env.HF_IMAGE_MODEL;
  if (!token || !model) return null;
  const { width, height } = fitEdge(shape || SHAPES.square, 1536);
  try {
    const r = await fetch(`https://router.huggingface.co/hf-inference/models/${model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ inputs: prompt.slice(0, 1400), parameters: { width, height } }),
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    });
    if (!r.ok) {
      console.warn(`imagegen huggingface: ${r.status}`);
      return null;
    }
    const mime = String(r.headers.get("content-type") || "image/jpeg").split(";")[0];
    if (!mime.startsWith("image/")) return null;
    const buffer = Buffer.from(await r.arrayBuffer());
    if (buffer.length < 20 * 1024) return null;
    const real = sizeOf(buffer);
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

/** Together AI — only with TOGETHER_API_KEY AND TOGETHER_IMAGE_MODEL. */
async function tryTogether(prompt, { shape, timeoutMs = 40_000 } = {}) {
  const key = process.env.TOGETHER_API_KEY;
  const model = process.env.TOGETHER_IMAGE_MODEL;
  if (!key || !model) return null;
  const { width, height } = fitEdge(shape || SHAPES.square, 1536);
  try {
    const r = await fetch("https://api.together.xyz/v1/images/generations", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model, prompt: prompt.slice(0, 1400), width, height, steps: 4, n: 1,
        response_format: "b64_json",
      }),
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
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
    const real = sizeOf(buffer);
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

/* ------------------------------------------------------------------ */
/* POLLINATIONS — keyless, the last resort                             */
/* ------------------------------------------------------------------ */

/**
 * The keyless tier's real ceiling, measured rather than documented:
 * asking for 1536x864 returns 1024x576 and asking for 1152x1536 returns
 * 665x886. Requesting more than this buys nothing and costs up to forty
 * extra seconds per image, so the request is capped to what will actually
 * come back. finish() takes it to the real size afterwards.
 */
const KEYLESS_LONG_EDGE = 1024;

async function tryPollinations(prompt, { aspect, shape, seed, ownPrompt = false, timeoutMs = 60_000 } = {}) {
  // Unkeyed GET; seed keeps "another one" from returning the same image.
  const s = Number.isFinite(seed) ? seed : Math.floor(Math.random() * 1e9);
  const ideal = shape || shapeOf(aspect);
  const scale = Math.min(1, KEYLESS_LONG_EDGE / Math.max(ideal.width, ideal.height));
  const width = Math.round(ideal.width * scale);
  const height = Math.round(ideal.height * scale);
  // The provider's own prompt expander: measurably better on a short
  // prompt — and switched off when ours already wrote the prompt, because
  // its rewrite drops the no-text rule a poster background depends on.
  const expander = ownPrompt ? "enhance=false" : "enhance=true";
  const url =
    "https://image.pollinations.ai/prompt/" +
    encodeURIComponent(prompt.slice(0, 1400)) +
    `?width=${width}&height=${height}&nologo=true&model=flux` +
    `&${expander}&seed=${s}`;
  const r = await fetch(url, {
    signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
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
  // WHAT WE ASKED FOR IS NOT WHAT WE GOT: report the size that came back.
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
/* THE CHAIN                                                           */
/* ------------------------------------------------------------------ */

/** name → {available(), run(prompt, opts)}. */
const PROVIDERS = {
  openai: { available: openaiAvailable, run: tryOpenAI },
  "fal-zimage": {
    available: () => fal.falReady() && !fal.coolingDown(),
    run: (p, o) => tryFal(p, { ...o, kind: "photo" }),
  },
  "fal-qwen": {
    available: () => fal.falReady() && !fal.coolingDown(),
    run: (p, o) => tryFal(p, { ...o, kind: "text" }),
  },
  "cf-klein": {
    available: cfAvailable,
    run: (p, o) => tryCloudflare(p, o),
  },
  "cf-schnell": {
    available: () => cfAvailable() && !!cfFallbackModel(),
    run: tryCloudflareFallback,
  },
  huggingface: { available: () => !!(process.env.HF_TOKEN && process.env.HF_IMAGE_MODEL), run: tryHuggingFace },
  together: { available: () => !!(process.env.TOGETHER_API_KEY && process.env.TOGETHER_IMAGE_MODEL), run: tryTogether },
};

/** Best first, per purpose. Background is a photo-like scene with no words. */
const QUALITY_ORDER = {
  photo: ["openai", "fal-zimage", "cf-klein", "fal-qwen", "cf-schnell", "huggingface", "together"],
  text: ["openai", "fal-qwen", "cf-klein", "fal-zimage", "cf-schnell", "huggingface", "together"],
};
QUALITY_ORDER.background = QUALITY_ORDER.photo;

/**
 * The keyed providers to try, in order, that are available right now.
 * IMAGE_PROVIDER_ORDER (comma list of the names above) overrides the
 * quality order, e.g. "cf-klein,fal-zimage" to put the free tier first.
 */
function providerOrder(purpose = "photo") {
  const custom = String(process.env.IMAGE_PROVIDER_ORDER || "")
    .split(",").map((s) => s.trim()).filter((s) => PROVIDERS[s]);
  const order = custom.length ? custom : QUALITY_ORDER[purpose] || QUALITY_ORDER.photo;
  return order.filter((n) => PROVIDERS[n].available());
}

function keylessOn() {
  return String(process.env.IMAGE_KEYLESS || "on").toLowerCase() !== "off";
}

/** Which providers this deployment would try, in order, for the health probe. */
function configuredProviders(purpose = "photo") {
  const out = providerOrder(purpose).slice();
  if (keylessOn()) out.push("pollinations (keyless, ≤1024 px)");
  return out;
}

/** Words that must be IN the picture: a logo, a sign, "that says …". */
function wantsText(prompt) {
  const p = String(prompt || "");
  return /["“][^"”]{2,60}["”]/.test(p) ||
    /\b(logo|wordmark|typography|lettering|signboard|that says|saying|with the (words?|text)|written|title text|caption)\b/i.test(p);
}

/* ------------------------------------------------------------------ */
/* CANONICAL SUBJECTS                                                  */
/*                                                                     */
/* FLUX renders beautifully and knows almost nothing about Indian      */
/* religious iconography. Asked for Lord Krishna it produced a temple  */
/* idol with RED skin and the flute pushed through his cheek — good    */
/* light, good jewellery, wrong deity. The model is not going to learn */
/* this from "divine aura, cinematic lighting"; the attributes have to */
/* be in the prompt, because most of these models take no negative    */
/* prompt and no reference image.                                      */
/*                                                                     */
/* Only the figures this app is actually asked for, and only the       */
/* attributes that are canonical rather than stylistic. Getting these  */
/* wrong in a product used daily across India is not a small miss.     */
/* ------------------------------------------------------------------ */
// NOTE ON THE PATTERNS: \b is an ASCII word boundary, so /\bगणेश\b/ can
// never match — there is no ASCII word character beside Devanagari. Each
// pattern therefore has a BOUNDED Latin half and an UNBOUNDED Indic half.
const SUBJECT_HINTS = [
  {
    match: /\b(krishna|krsna|kanha|gopal|govinda)\b|ಕೃಷ್ಣ|कृष्ण/i,
    hint:
      "Lord Krishna with luminous BLUE skin, a peacock feather in his crown, " +
      "a yellow silk dhoti, a vaijayanti flower garland, holding a bamboo " +
      "flute with BOTH HANDS raised to his lips, gentle smile, serene youthful face",
  },
  {
    match: /\b(shiva|siva|mahadev|nataraj|shankar)\b|ಶಿವ|शिव/i,
    hint:
      "Lord Shiva with pale ash-grey skin, matted jata hair holding a crescent " +
      "moon and the Ganga, a third eye on his forehead, rudraksha beads, a " +
      "serpent around his neck, a tiger skin, holding a trishula trident",
  },
  {
    match: /\b(ganesh|ganesha|ganapati|vinayaka)\b|ಗಣೇಶ|गणेश/i,
    hint:
      "Lord Ganesha with an elephant head and one broken tusk, a rounded " +
      "belly, four arms, holding a modak sweet and a lotus, a small mouse at " +
      "his feet, red and gold silks",
  },
  {
    match: /\b(hanuman|anjaneya|maruti)\b|ಹನುಮಂತ|हनुमान/i,
    hint:
      "Lord Hanuman as a powerful vanara with a monkey face, orange-red fur, " +
      "a golden mace (gada) in hand, a long tail, devoted expression",
  },
  {
    match: /\b(lakshmi|laxmi)\b|ಲಕ್ಷ್ಮಿ|लक्ष्मी/i,
    hint:
      "Goddess Lakshmi seated on a pink lotus, four arms, gold coins flowing " +
      "from one palm, red and gold silk sari, heavy temple gold jewellery",
  },
  {
    match: /\b(saraswati|sarasvati)\b|ಸರಸ್ವತಿ|सरस्वती/i,
    hint:
      "Goddess Saraswati in a white sari, seated on a white lotus, holding a " +
      "veena, a white swan beside her, serene scholarly expression",
  },
  {
    match: /\b(durga|amba|chamundeshwari)\b|ದುರ್ಗಾ|दुर्गा/i,
    hint:
      "Goddess Durga with many arms each holding a weapon, riding a lion, " +
      "red and gold silks, fierce protective expression, ornate crown",
  },
  {
    match: /\b(rama|ram lalla|shri ram)\b|ಶ್ರೀರಾಮ|राम/i,
    hint:
      "Lord Rama with blue-toned skin, a golden crown, holding a longbow and " +
      "arrow, yellow silk dhoti, calm regal bearing",
  },
];

/** The canonical notes for every subject the prompt names. */
function subjectHints(prompt) {
  const p = String(prompt || "");
  return SUBJECT_HINTS.filter((h) => h.match.test(p)).map((h) => h.hint);
}

/**
 * Add canonical attributes when the prompt names a subject the image model
 * is known to get wrong. Appended rather than substituted: whatever the
 * user asked for — the style, the setting, the mood — is untouched. A note
 * already in the prompt (the enhancer kept it) is not added twice.
 */
function withSubjectHints(prompt) {
  const p = String(prompt || "");
  const hits = subjectHints(p).filter((h) => !p.includes(h));
  if (!hits.length) return p;
  return `${p}. ${hits.join(". ")}.`;
}

/**
 * @param opts.aspect    square | portrait | landscape | wide | poster (4:5) | story (9:16)
 * @param opts.seed      fixed seed — video frames share one so the subject
 *                       stays the same person/place from frame to frame.
 * @param opts.purpose   'photo' (default) | 'text' (words must be in the
 *                       picture) | 'background' (a poster background: no
 *                       text, space for the app's typography). Omitted,
 *                       it is read from the prompt.
 * @param opts.enhance   run the prompt enhancer first (imagePrompt.js)
 * @param opts.style     poster style words, for the enhancer
 * @param opts.target    {width, height} to finish at instead of the shape's
 *                       own size (a 1080x1080 poster, not the 1440 square)
 * @param opts.finish    crop/scale to the exact shape and strip tags (default true)
 * @param opts.aiUpscale allow fal esrgan when the result is far too small
 */
async function generateImage(prompt, opts = {}) {
  const raw = String(prompt || "").trim();
  if (!raw) throw new Error("empty prompt");
  const shape = shapeOf(opts.aspect);
  const purpose = opts.purpose || (wantsText(raw) ? "text" : "photo");
  const time = budget(); // the enhancer's seconds count too

  let p = raw;
  let enhanced = false;
  if (opts.enhance || purpose === "background") {
    const e = await imagePrompt.enhancePrompt(raw, {
      purpose, style: opts.style || "", shape: shapeName(opts.aspect), mustKeep: subjectHints(raw),
    });
    p = e.prompt;
    enhanced = e.enhanced;
  }
  p = withSubjectHints(p);
  const negative = purpose === "background" ? imagePrompt.BACKGROUND_NEGATIVE : undefined;

  const common = { aspect: opts.aspect, shape, seed: opts.seed, negative };
  let out = null;
  // Best first among the providers that are available right now.
  for (const name of providerOrder(purpose)) {
    const timeoutMs = time.keyed();
    if (timeoutMs < 5000) break;
    out = await PROVIDERS[name].run(p, { ...common, timeoutMs });
    if (out) break;
  }
  if (!out) {
    if (!keylessOn()) throw new Error("no image provider answered");
    try {
      out = await tryPollinations(p, { ...common, ownPrompt: enhanced, timeoutMs: time.keyless() });
    } catch (e) {
      // ONE retry, only when there is time for it. A timeout or a truncated
      // body is usually the provider being busy; a retry that cannot finish
      // inside the budget is just a longer wait for the same apology.
      if (time.left() < 20_000) throw e;
      console.warn("imagegen retrying after:", e.message);
      out = await tryPollinations(p, {
        ...common, ownPrompt: enhanced, seed: Math.floor(Math.random() * 1e9), timeoutMs: time.keyless(),
      });
    }
  }

  if (opts.finish !== false) {
    const target = opts.target && opts.target.width > 0 && opts.target.height > 0 ? opts.target : shape;
    const done = await require("./imagePost").finish(out, target, { aiUpscale: !!opts.aiUpscale });
    out = { ...out, buffer: done.buffer, mime: done.mime, width: done.width || out.width, height: done.height || out.height, upscaled: done.upscaled };
  }
  return { ...out, prompt: p, enhanced, purpose };
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
  // Video generation rode on Gemini's Veo; with Gemini gone (2026-10-02)
  // there is no video model wired yet. Null means "not available", which
  // the video job reports honestly. Sora through OpenAI is the candidate.
  void prompt;
  return null;
}

/** Tests only: forget cooldowns learnt from earlier stubbed answers. */
function _reset() {
  geminiBlockedUntil = 0;
  geminiImageConfigOk = true;
  cfBlockedUntil = 0;
  fal._reset();
}

module.exports = {
  generateImage, tryVeoVideo, jpegSize, shapeOf, shapeName, configuredProviders,
  withSubjectHints, subjectHints, providerOrder, wantsText, SHAPES,
  cfDecode, fitEdge,
  _test: { tryOpenAI, tryFal, tryCloudflare, tryPollinations, _reset },
};
