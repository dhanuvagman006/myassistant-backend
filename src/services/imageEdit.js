/**
 * IMAGE EDITING WITH REFERENCE IMAGES — the engine under Style Studio.
 * ----------------------------------------------------------------------
 * imagegen.js makes a picture from words. This makes a picture from words
 * AND one or more photographs the user supplied: their own face, a garment
 * they photographed in a shop. That is a different capability with a hard
 * constraint attached — the person in the output has to still be them —
 * and it cannot be served by the keyless text-to-image tier at all,
 * because none of those endpoints accept an input image. There is no free
 * path to this feature; the honest failure message below says so plainly
 * rather than inventing a stranger's face.
 *
 * PROVIDER CHAIN, best first. Every provider returns null on failure so
 * the chain continues, and records WHY in `notes` so one real attempt
 * explains itself in the pod log instead of needing three.
 *
 * POST-PROCESSING is deliberate, not decoration:
 *   • inputs are normalised (oriented, downscaled to a sane edge, JPEG)
 *     because a 12 MP phone photo is mostly latency, and because an
 *     EXIF-rotated portrait arrives sideways at the model;
 *   • outputs can be forced to an EXACT pixel size, which is the whole
 *     point of a passport photo — a model asked for 630x810 does not
 *     return 630x810, and an ID photo that is off-spec is worthless.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

/* ------------------------------------------------------------------ */
/* ffmpeg — already in the runtime image for video generation           */
/* ------------------------------------------------------------------ */

let ffmpegOk = null;
function haveFfmpeg() {
  if (ffmpegOk !== null) return Promise.resolve(ffmpegOk);
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-version"], { timeout: 8000 }, (err) => {
      ffmpegOk = !err;
      if (err) console.warn("imageEdit: ffmpeg unavailable —", err.message);
      resolve(ffmpegOk);
    });
  });
}

function ff(args, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, _o, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).split("\n").slice(-3).join(" ").slice(0, 300)));
      resolve();
    });
  });
}

/** Real pixel size of a JPEG or PNG, read from the header. */
function imageSize(buf) {
  try {
    if (!buf || buf.length < 24) return null;
    // PNG: 8-byte signature, then IHDR with width/height at 16/20.
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      return require("./imagegen").jpegSize(buf);
    }
    // WEBP (VP8X / VP8L / VP8 lossy) — phones do send these.
    if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") {
      const kind = buf.slice(12, 16).toString("latin1");
      if (kind === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (kind === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
  } catch (_) {}
  return null;
}

/** Run one ffmpeg filter over a buffer. Returns null rather than throwing —
 *  every caller has a usable "keep the original" path. */
async function transform(buffer, vf, { quality = 2, ext = "jpg", timeout = 30_000 } = {}) {
  if (!(await haveFfmpeg())) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hari-edit-"));
  const inFile = path.join(dir, `in.${ext === "png" ? "png" : "jpg"}`);
  const outFile = path.join(dir, `out.${ext}`);
  try {
    fs.writeFileSync(inFile, buffer);
    const args = ["-y", "-v", "error", "-i", inFile, "-vf", vf];
    if (ext !== "png") args.push("-q:v", String(quality));
    args.push(outFile);
    await ff(args, timeout);
    const out = fs.readFileSync(outFile);
    return out.length > 2048 ? out : null;
  } catch (e) {
    console.warn("imageEdit ffmpeg:", e.message);
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * Prepare a user photo for the model: strip the EXIF rotation into real
 * pixels, cap the long edge, re-encode as a high-quality JPEG.
 * A phone portrait with Orientation=6 is landscape bytes; every model
 * treats it as landscape, which is how "put a saree on her" came back as
 * a sideways person.
 */
async function normalizeInput(buffer, mime, { maxEdge = 1536 } = {}) {
  const size = imageSize(buffer);
  const long = size ? Math.max(size.width, size.height) : 0;
  const needsScale = long > maxEdge;
  // `-autorotate` is on by default for input; the transpose comes free
  // with a re-encode, so any re-encode fixes orientation.
  const vf = needsScale
    ? `scale='if(gt(iw,ih),${maxEdge},-2)':'if(gt(iw,ih),-2,${maxEdge})':flags=lanczos`
    : "null";
  const out = await transform(buffer, vf, { quality: 2 });
  if (out) return { buffer: out, mime: "image/jpeg" };
  return { buffer, mime: mime || "image/jpeg" };
}

/**
 * Force an image to EXACT pixel dimensions by scaling up to cover and
 * centre-cropping — never letterboxing, because an ID photo with white
 * bars down the sides fails the spec as surely as the wrong size does.
 */
async function fitExact(buffer, width, height) {
  const vf =
    `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${width}:${height},setsar=1`;
  const out = await transform(buffer, vf, { quality: 1 });
  return out || buffer;
}

/**
 * Enlarge with lanczos when the provider returned less than we want.
 * This is resampling, NOT detail recovery — it is called only to reach a
 * printable pixel count, and never described to the user as an upscale.
 */
async function resampleTo(buffer, longEdge) {
  const size = imageSize(buffer);
  if (!size) return buffer;
  const have = Math.max(size.width, size.height);
  if (have >= longEdge) return buffer;
  const vf = size.width >= size.height
    ? `scale=${longEdge}:-2:flags=lanczos`
    : `scale=-2:${longEdge}:flags=lanczos`;
  const out = await transform(buffer, vf, { quality: 1 });
  return out || buffer;
}

/* ------------------------------------------------------------------ */
/* PROVIDER 1 — Gemini image models (multi-image edit)                 */
/*                                                                     */
/* TWO WIRE FORMATS, ON PURPOSE. Google's current documentation for    */
/* the image models describes a new endpoint —                          */
/*   POST /v1beta/interactions  { model, input:[...], response_format } */
/* — while the rest of this codebase (and every working Gemini call in  */
/* it) uses the classic                                                 */
/*   POST /v1beta/models/{id}:generateContent { contents:[{parts}] }.   */
/* Which of the two serves image OUTPUT today could not be established  */
/* from the documentation, and getting it wrong means the feature never  */
/* works at all. So both are implemented, the first success is          */
/* remembered for the life of the process, and the log says which one   */
/* answered. This costs one wasted round-trip once, ever.               */
/*                                                                     */
/* The MODEL IDS matter just as much: gemini-3-pro-image-preview and    */
/* gemini-3.1-flash-image-preview were retired in June 2026, and        */
/* gemini-2.5-flash-image shuts down on 2 October 2026, so none of the  */
/* three is a safe default. The list below is the current non-preview   */
/* line, overridable by env so a rename never needs a redeploy.         */
/* ------------------------------------------------------------------ */

const GEMINI_COOLDOWN_MS = 30 * 60_000;
let geminiBlockedUntil = 0;
let geminiImageConfigOk = true; // off permanently if the API rejects the field
let preferredShape = null;      // 'interactions' | 'generateContent'

function geminiModels() {
  const raw = process.env.GEMINI_EDIT_MODELS || "gemini-3-pro-image,gemini-3.1-flash-image";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function geminiAspect(aspect) {
  const a = String(aspect || "").toLowerCase();
  if (a.startsWith("port") || a === "3:4") return "3:4";
  if (a === "9:16" || a === "tall") return "9:16";
  if (a === "wide" || a === "16:9") return "16:9";
  if (a.startsWith("land") || a === "4:3") return "4:3";
  if (a === "square" || a === "1:1") return "1:1";
  return "3:4"; // people are taller than they are wide
}

/**
 * Pull an image out of a response whose exact nesting is not documented.
 * A deep walk for "an object carrying base64 image bytes" survives both
 * `candidates[].content.parts[].inlineData` and `output_image`, and any
 * third spelling, without this file having to guess the path.
 */
function harvestImage(json) {
  const seen = new Set();
  const stack = [json];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object" || seen.has(n)) continue;
    seen.add(n);
    if (Array.isArray(n)) { for (const v of n) stack.push(v); continue; }

    const data = n.data ?? n.bytesBase64Encoded ?? n.b64_json ?? n.imageBytes;
    const mime = n.mimeType || n.mime_type || n.contentType || n.content_type;
    // A base64 image is long; short `data` fields are ids and flags.
    if (typeof data === "string" && data.length > 2000 && (!mime || /^image\//.test(mime))) {
      try {
        const buffer = Buffer.from(data, "base64");
        if (buffer.length > 2048) return { buffer, mime: mime || "image/png" };
      } catch (_) {}
    }
    for (const k of Object.keys(n)) stack.push(n[k]);
  }
  return null;
}

/** Any text the model returned instead of an image — usually a refusal. */
function harvestText(json) {
  const out = [];
  const seen = new Set();
  const stack = [json];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object" || seen.has(n)) continue;
    seen.add(n);
    if (Array.isArray(n)) { for (const v of n) stack.push(v); continue; }
    if (typeof n.text === "string" && n.text.trim()) out.push(n.text.trim());
    for (const k of Object.keys(n)) stack.push(n[k]);
  }
  return out.join(" ").slice(0, 220);
}

function interactionsBody(model, instruction, images, aspect, hiQuality) {
  return {
    model,
    input: [
      { type: "text", text: instruction },
      ...images.map((im) => ({
        type: "image",
        mime_type: im.mime || "image/jpeg",
        data: im.buffer.toString("base64"),
      })),
    ],
    response_format: {
      type: "image",
      aspect_ratio: geminiAspect(aspect),
      image_size: hiQuality ? "2K" : "1K",
    },
  };
}

function generateContentBody(instruction, images, aspect, hiQuality, withConfig) {
  const body = {
    contents: [{
      parts: [
        { text: instruction },
        ...images.map((im) => ({
          inlineData: {
            mimeType: im.mime || "image/jpeg",
            data: im.buffer.toString("base64"),
          },
        })),
      ],
    }],
  };
  if (withConfig) {
    body.generationConfig = {
      responseModalities: ["IMAGE"],
      imageConfig: {
        aspectRatio: geminiAspect(aspect),
        ...(hiQuality ? { imageSize: "2K" } : {}),
      },
    };
  }
  return body;
}

async function callGemini(url, headers, body, notes, label) {
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150_000),
    });
  } catch (e) {
    notes.push(`${label}: ${e.name === "TimeoutError" ? "timed out" : e.message}`);
    return { fatal: true };
  }
  if (r.status === 429) {
    geminiBlockedUntil = Date.now() + GEMINI_COOLDOWN_MS;
    notes.push(`${label}: quota exhausted (429) — billing not enabled on the key, or the limit is hit`);
    return { quota: true };
  }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    notes.push(`${label}: HTTP ${r.status} ${t.replace(/\s+/g, " ").slice(0, 200)}`);
    return { status: r.status, text: t };
  }
  const json = await r.json().catch(() => null);
  const img = harvestImage(json);
  if (img) return { image: img };
  const said = harvestText(json);
  notes.push(`${label}: 200 but no image back${said ? ` — said "${said}"` : ""}`);
  return { empty: true };
}

async function tryGemini({ instruction, images, aspect, notes, hiQuality }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { notes.push("gemini: no key"); return null; }
  if (Date.now() < geminiBlockedUntil) { notes.push("gemini: cooling down after a quota error"); return null; }

  // The shape that worked last time goes first; on a cold process both
  // are tried, newest-documented first.
  const shapes = preferredShape === "generateContent"
    ? ["generateContent", "interactions"]
    : ["interactions", "generateContent"];

  for (const model of geminiModels()) {
    for (const shape of shapes) {
      if (shape === "interactions") {
        const res = await callGemini(
          "https://generativelanguage.googleapis.com/v1beta/interactions",
          { "x-goog-api-key": key },
          interactionsBody(model, instruction, images, aspect, hiQuality),
          notes, `gemini ${model} (interactions)`
        );
        if (res.quota) return null;
        if (res.image) {
          preferredShape = "interactions";
          return { ...res.image, provider: `gemini:${model}` };
        }
        continue;
      }

      // generateContent, with one retry without imageConfig if the API
      // rejects that field by name.
      for (const withConfig of geminiImageConfigOk ? [true, false] : [false]) {
        const res = await callGemini(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {},
          generateContentBody(instruction, images, aspect, hiQuality, withConfig),
          notes, `gemini ${model} (generateContent${withConfig ? "+imageConfig" : ""})`
        );
        if (res.quota) return null;
        if (res.image) {
          preferredShape = "generateContent";
          return { ...res.image, provider: `gemini:${model}` };
        }
        if (res.status === 400 && withConfig &&
            /imageConfig|imageSize|aspectRatio|responseModalities|Unknown name/i.test(res.text || "")) {
          geminiImageConfigOk = false;
          continue; // same model, same shape, no config
        }
        break;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* THE CHAIN                                                           */
/* ------------------------------------------------------------------ */

/** A provider entry is {name, when, run}. `when` keeps a garment-specific
 *  virtual-try-on model out of a hairstyle request. */
const CHAIN = [
  { name: "gemini", when: () => true, run: tryGemini },
];

/** Registered at load time by the optional-provider modules below, so a
 *  deployment with no extra keys carries no extra code paths. */
function register(provider) {
  // Ordered: a purpose-built try-on model beats a general editor at
  // try-on, so anything declaring a priority under 0 goes in front.
  if ((provider.priority || 0) < 0) CHAIN.unshift(provider);
  else CHAIN.push(provider);
}

class NoProviderError extends Error {
  constructor(notes) {
    super(
      // Name only the providers this file actually registers. An earlier
      // version of this message offered FAL_KEY and REPLICATE_API_TOKEN,
      // neither of which is wired — it sent the operator chasing a key
      // that would have changed nothing.
      "Image editing is not configured on this server. " +
      "Style Studio needs an image model that accepts a photo as input — " +
      "set GEMINI_API_KEY on a billing-enabled Google Cloud project, or " +
      "FASHN_API_KEY, or the Vertex virtual try-on credentials " +
      "(VERTEX_PROJECT_ID + VERTEX_SA_JSON)."
    );
    this.code = "no_provider";
    this.notes = notes;
  }
}

/**
 * Edit `images` according to `instruction`.
 *
 * @param {object}   o
 * @param {string}   o.instruction  what to do (a recipe's build() output)
 * @param {Array}    o.images       [{buffer, mime}] — person first, then refs
 * @param {string}   o.aspect       'portrait' | 'landscape' | 'square' | 'auto'
 * @param {object}   o.exact        {width, height} to force afterwards
 * @param {boolean}  o.vto          garment try-on: prefer a dedicated model
 * @param {boolean}  o.hiQuality    ask for the larger/costlier output
 * @param {number}   o.minLongEdge  resample up to this if the result is small
 * @returns {Promise<{buffer, mime, provider, ms, width, height, notes}>}
 */
async function editImage({
  instruction, images, aspect = "portrait", exact = null,
  vto = false, hiQuality = true, minLongEdge = 0,
}) {
  if (!instruction || !images?.length) throw new Error("instruction and at least one image are required");
  const started = Date.now();
  const notes = [];

  // Normalise every input once, in parallel.
  const prepared = await Promise.all(
    images.map((im) => normalizeInput(im.buffer, im.mime, { maxEdge: 1536 }))
  );

  let result = null;
  for (const p of CHAIN) {
    if (p.when && !p.when({ vto, images: prepared })) continue;
    try {
      result = await p.run({ instruction, images: prepared, aspect, notes, vto, hiQuality, exact });
    } catch (e) {
      notes.push(`${p.name}: threw ${e.message}`);
      result = null;
    }
    if (result?.buffer?.length) break;
  }

  if (!result?.buffer?.length) {
    console.warn("imageEdit: every provider failed —", notes.join(" | "));
    const err = new NoProviderError(notes);
    // Distinguish "nothing is configured" from "it was tried and refused":
    // the first is the operator's problem, the second is the user's photo.
    if (notes.some((n) => /no image back|quota|HTTP|timed out|400/.test(n))) {
      err.code = "edit_failed";
      err.message =
        "That edit didn't come back. It usually means the photo was unclear, " +
        "or the model declined it — try a well-lit photo where the face and " +
        "shoulders are fully visible.";
    }
    throw err;
  }

  // ---- post-processing: exact spec first, then a printable pixel count ----
  if (exact?.width && exact?.height) {
    result.buffer = await fitExact(result.buffer, exact.width, exact.height);
    result.mime = "image/jpeg";
  } else if (minLongEdge > 0) {
    const before = result.buffer;
    result.buffer = await resampleTo(result.buffer, minLongEdge);
    if (result.buffer !== before) notes.push(`resampled up to ${minLongEdge}px long edge`);
  }

  const size = imageSize(result.buffer) || { width: 0, height: 0 };
  return {
    ...result,
    ms: Date.now() - started,
    width: size.width,
    height: size.height,
    notes,
  };
}

/** Which providers this deployment could actually use — for the admin panel. */
function configured() {
  const out = [];
  for (const p of CHAIN) {
    const ready = p.ready ? p.ready() : p.name === "gemini" ? !!process.env.GEMINI_API_KEY : false;
    out.push({ name: p.name, ready, vtoOnly: !!p.vtoOnly });
  }
  return out;
}

module.exports = {
  editImage, configured, register,
  normalizeInput, fitExact, resampleTo, transform, imageSize, haveFfmpeg,
  NoProviderError,
  // Exported for the regression tests: the response shape these two walk
  // is the one fact about this integration the documentation would not
  // pin down, so it is the one that must be tested rather than trusted.
  harvestImage, harvestText, geminiAspect,
};

// Optional keyed providers register themselves. Each module is a no-op
// without its key, so this is safe on a deployment that has none.
require("./imageEditProviders").install(register);
