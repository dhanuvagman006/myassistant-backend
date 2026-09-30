/**
 * "EDIT MY PHOTO" — the photo they just shared, changed by one instruction
 * (2026-09-30): "remove the background", "change the colour of the shirt
 * to blue", "make this look professional", "put this person in a formal
 * setting".
 *
 * PROVIDERS, per kind of edit:
 *   remove the background → fal birefnet/v2 (FAL_KEY): a real cut-out, a
 *     transparent PNG. Generative editors cannot make transparency, so
 *     without fal the fallback is Gemini on a plain white background, and
 *     the result says it is not transparent.
 *   everything else → fal qwen-image-edit-2511 (FAL_KEY, ~$0.03), else
 *     Gemini image editing when GEMINI_IMAGE_BILLING allows it.
 *   none available → a friendly reason, never a crash and never a fake.
 *
 * NEVER A DIFFERENT PERSON. The photo cards' rule (posters/tools.js: "no
 * AI changes anyone's face") holds here too: every instruction carries
 * IDENTITY_RULE, and a request whose whole point is to change a face or a
 * body — a face swap, "make me fairer", "look younger", "slimmer" — is
 * declined before any model sees the photo.
 *
 * Style Studio (studio/, imageEdit.editImage) is a separate chain with its
 * own recipes and is untouched by this file.
 */

const fal = require("./fal");

const IDENTITY_RULE =
  "Keep every person exactly as they are: the same face, facial features, skin tone, " +
  "age, body shape, hair and expression. Do not beautify, reshape, age, lighten or " +
  "replace anyone's face or body. Change only what the instruction asks for.";

const EDIT_TIMEOUT_MS = 45_000;

class PhotoEditError extends Error {
  /** code: identity | no_provider | failed | not_image */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** A face or body changed IS the request: declined, whatever the model. */
const IDENTITY_CHANGE =
  /\b(face ?swap|swap (the |my |his |her )?faces?|(change|replace) (my|his|her|their|the|this) (face|person)|different (face|person)|(fairer|whiter|lighter) (skin|complexion|face)|(make|look) (me|him|her|them)? ?(fairer|whiter|younger|older|slimmer|thinner|fatter)|look (younger|older|slimmer|thinner)|(lose|reduce) weight|(bigger|smaller) (nose|eyes|lips|chest|breasts))\b/i;

const REMOVE_BG =
  /\b(remove|erase|delete|cut ?out|take (out|off|away)|get rid of|no|without|transparent|clear)\b[^.]{0,30}\b(background|backdrop|bg)\b|\b(background|bg)\b[^.]{0,20}\b(removed?|transparent|gone)\b|\bcut ?out\b/i;

/** 'remove_background' | 'edit' — "change the background to an office"
 *  is an edit, not a cut-out. */
function detectOp(instruction) {
  const t = String(instruction || "");
  if (/\b(change|replace|swap|put|place|make)\b[^.]{0,40}\b(background|backdrop|setting)\b[^.]{0,10}\b(to|into|with|in)\b/i.test(t) &&
      !/\btransparent\b/i.test(t)) {
    return "edit";
  }
  return REMOVE_BG.test(t) ? "remove_background" : "edit";
}

function wantsIdentityChange(instruction) {
  return IDENTITY_CHANGE.test(String(instruction || ""));
}

function geminiMode() {
  return require("./imagegen").geminiImageMode();
}

/** Which edits this deployment can do right now — for the tool's answer. */
function geminiOk() {
  return geminiMode() !== "off" && !!(process.env.GEMINI_IMAGE_API_KEY || process.env.GEMINI_API_KEY) &&
    Date.now() >= geminiBlockedUntil;
}

function available() {
  const gem = geminiOk();
  return {
    removeBackground: fal.falReady() || gem,
    transparent: fal.falReady(),
    edit: fal.falReady() || gem,
  };
}

/** The supported Gemini aspect nearest to the photo's own. */
function nearestRatio(width, height) {
  const opts = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9"];
  if (!width || !height) return "3:4";
  const r = width / height;
  let best = opts[0];
  let d = Infinity;
  for (const o of opts) {
    const [a, b] = o.split(":").map(Number);
    const dd = Math.abs(Math.log(r / (a / b)));
    if (dd < d) { d = dd; best = o; }
  }
  return best;
}

/* ------------------------------------------------------------------ */

async function falBirefnet(img) {
  const model = process.env.FAL_BG_MODEL || "fal-ai/birefnet/v2";
  const j = await fal.falRun(model, {
    image_url: fal.dataUri(img.buffer, img.mime),
    model: "General Use (Light)",
    operating_resolution: "1024x1024",
    output_format: "png",
    refine_foreground: true,
  }, { timeoutMs: EDIT_TIMEOUT_MS });
  const ref = fal.firstImage(j);
  if (!ref) throw new Error("birefnet: no image back");
  const out = await fal.download(ref, { timeoutMs: 20_000 });
  return { ...out, provider: `fal:${model}`, transparent: true };
}

async function falQwenEdit(img, instruction) {
  const model = process.env.FAL_EDIT_MODEL || "fal-ai/qwen-image-edit-2511";
  const j = await fal.falRun(model, {
    prompt: `${instruction}\n${IDENTITY_RULE}`.slice(0, 2000),
    image_urls: [fal.dataUri(img.buffer, img.mime)],
    num_images: 1,
    output_format: "jpeg",
    enable_safety_checker: true,
  }, { timeoutMs: EDIT_TIMEOUT_MS });
  if (j.has_nsfw_concepts && j.has_nsfw_concepts[0]) throw new Error("qwen-edit: flagged by the safety checker");
  const ref = fal.firstImage(j);
  if (!ref) throw new Error("qwen-edit: no image back");
  const out = await fal.download(ref, { timeoutMs: 20_000 });
  return { ...out, provider: `fal:${model}`, transparent: false };
}

let geminiBlockedUntil = 0;

async function geminiEdit(img, instruction, { width, height } = {}) {
  const imagegen = require("./imagegen");
  const { harvestImage } = require("./imageEdit");
  const key = process.env.GEMINI_IMAGE_API_KEY || process.env.GEMINI_API_KEY;
  const model = imagegen.geminiImageModel();
  const body = {
    contents: [{
      role: "user",
      parts: [
        { text: `${instruction}\n${IDENTITY_RULE}` },
        { inlineData: { mimeType: img.mime || "image/jpeg", data: img.buffer.toString("base64") } },
      ],
    }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: nearestRatio(width, height) },
    },
  };
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EDIT_TIMEOUT_MS),
    }
  );
  if (r.status === 429 || r.status === 403) {
    geminiBlockedUntil = Date.now() + (geminiMode() === "on" && r.status === 429 ? 10 * 60_000 : 6 * 3600_000);
    throw new PhotoEditError("no_provider", `gemini ${model}: ${r.status} (billing off or quota)`);
  }
  if (!r.ok) throw new Error(`gemini ${model}: HTTP ${r.status}`);
  const img2 = harvestImage(await r.json().catch(() => null));
  if (!img2) throw new Error(`gemini ${model}: no image back`);
  return { ...img2, provider: `gemini:${model}`, transparent: false };
}

/* ------------------------------------------------------------------ */

/**
 * @param {object} o
 * @param {Buffer} o.buffer   the photo
 * @param {string} o.mime
 * @param {string} o.instruction  what to change, in the user's words
 * @returns {Promise<{buffer, mime, provider, width, height, transparent, op}>}
 * @throws PhotoEditError {code: identity | no_provider | failed | not_image}
 */
async function editPhoto({ buffer, mime, instruction }) {
  const imageEdit = require("./imageEdit");
  const text = String(instruction || "").replace(/\s+/g, " ").trim().slice(0, 600);
  if (!text) throw new PhotoEditError("failed", "Tell me what to change in the photo.");
  if (wantsIdentityChange(text)) {
    throw new PhotoEditError("identity",
      "I don't change anyone's face or body in a photo. I can remove or change the " +
      "background, fix the colours and light, or make it look cleaner and more professional.");
  }
  if (!imageEdit.imageKind(buffer)) throw new PhotoEditError("not_image", "That file isn't a photo I can open.");

  const op = detectOp(text);
  const can = available();
  if (op === "remove_background" ? !can.removeBackground : !can.edit) {
    throw new PhotoEditError("no_provider",
      "Photo editing isn't switched on for this app yet, so I couldn't change the photo. " +
      "Your original is safe in your documents.");
  }

  const img = await imageEdit.normalizeInput(buffer, mime, { maxEdge: 1536 });
  const inSize = imageEdit.imageSize(img.buffer) || imageEdit.imageSize(buffer) || {};
  // Each step is tried only while its provider is available (key,
  // billing switch, cooldown) — checked again after the one before failed.
  const steps = op === "remove_background"
    ? [
      { ok: fal.falReady, run: () => falBirefnet(img) },
      { ok: geminiOk, run: () => geminiEdit(img,
        "Remove the background completely and place the main subject on a plain, pure white " +
        "background, with soft even light and clean edges.", inSize) },
    ]
    : [
      { ok: fal.falReady, run: () => falQwenEdit(img, text) },
      { ok: geminiOk, run: () => geminiEdit(img, text, inSize) },
    ];

  const notes = [];
  let out = null;
  for (const step of steps) {
    if (!step.ok()) continue;
    try {
      out = await step.run();
      if (out && out.buffer && out.buffer.length > 2048) break;
      out = null;
    } catch (e) {
      notes.push(e.message);
      out = null;
    }
  }
  if (!out) {
    console.warn("photoEdit: nothing came back —", notes.join(" | ").slice(0, 400));
    const onlyBilling = notes.length && notes.every((n) => /billing off|quota/.test(n));
    throw onlyBilling
      ? new PhotoEditError("no_provider",
        "Photo editing isn't switched on for this app yet, so I couldn't change the photo. " +
        "Your original is safe in your documents.")
      : new PhotoEditError("failed", "That edit didn't come back this time — ask me to try again in a moment.");
  }

  // Tags stripped, and never smaller than the photo they sent (≤1536).
  const outSize = imageEdit.imageSize(out.buffer) || {};
  let final = { buffer: out.buffer, mime: out.mime, width: outSize.width || 0, height: outSize.height || 0 };
  if (outSize.width && outSize.height) {
    const want = Math.max(Math.max(outSize.width, outSize.height), Math.min(1536, Math.max(inSize.width || 0, inSize.height || 0)));
    const k = want / Math.max(outSize.width, outSize.height);
    const target = { width: Math.round((outSize.width * k) / 2) * 2, height: Math.round((outSize.height * k) / 2) * 2 };
    final = await require("./imagePost").finish(out, target, { png: !!out.transparent });
  }
  return { ...final, provider: out.provider, transparent: !!out.transparent, op };
}

function _reset() {
  geminiBlockedUntil = 0;
}

module.exports = {
  editPhoto, detectOp, wantsIdentityChange, available, nearestRatio, PhotoEditError,
  IDENTITY_RULE, _reset,
};
