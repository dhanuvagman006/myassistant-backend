/**
 * THE LAST STEP FOR EVERY GENERATED IMAGE (2026-09-30).
 * ----------------------------------------------------------------------
 * Providers return what they like, not what was asked for: the keyless
 * tier sends 665x886 for a 1152x1536 portrait, Cloudflare caps the size
 * for the free allowance, and every provider leaves its own tags in the
 * file. finish() makes the picture the shape and size it is FOR:
 *
 *   1. when it is much smaller than the target and FAL_KEY exists, one
 *      real upscale (fal esrgan) first — detail, not just more pixels;
 *   2. one ffmpeg pass: cover-scale with lanczos, centre-crop to the exact
 *      target, a mild unsharp only when it was enlarged, every tag
 *      stripped (-map_metadata -1), JPEG at q≈90 (PNG kept for a cut-out,
 *      whose transparency is the point).
 *
 * Never throws and never makes things worse: any failure returns the
 * image as it came. Without ffmpeg (a Windows dev box) it is a no-op.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const fal = require("./fal");

/** Enlarging by less than this is left to lanczos alone. */
const AI_UPSCALE_MIN_FACTOR = 1.5;

function imageEdit() {
  return require("./imageEdit");
}

/**
 * The ffmpeg filter for one image. Pure, so the exact chain is testable
 * where ffmpeg is not installed.
 */
function finishFilter({ inWidth, inHeight, width, height }) {
  const cover = Math.max(width / inWidth, height / inHeight);
  const parts = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${width}:${height}`,
  ];
  // Mild, and only on enlargement: sharpening a downscale adds halos.
  if (cover > 1.05) parts.push("unsharp=5:5:0.6:5:5:0.0");
  parts.push("setsar=1");
  return parts.join(",");
}

function finishArgs({ inFile, outFile, vf, png }) {
  const args = ["-y", "-v", "error", "-i", inFile, "-vf", vf, "-map_metadata", "-1"];
  if (png) args.push("-pix_fmt", "rgba");
  else args.push("-q:v", "3"); // mjpeg q:v 3 ≈ JPEG quality 90
  args.push(outFile);
  return args;
}

function runFfmpeg(args, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, _o, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).split("\n").slice(-2).join(" ").slice(0, 200)));
      resolve();
    });
  });
}

/** fal esrgan, ×2 or ×4. Returns a buffer or null. */
async function aiUpscale(buffer, mime, factor, { timeoutMs = 30_000 } = {}) {
  if (!fal.falReady() || String(process.env.IMAGE_AI_UPSCALE || "on").toLowerCase() === "off") return null;
  const model = process.env.FAL_UPSCALE_MODEL || "fal-ai/esrgan";
  try {
    const j = await fal.falRun(model, {
      image_url: fal.dataUri(buffer, mime),
      scale: factor > 2.5 ? 4 : 2,
    }, { timeoutMs });
    const ref = fal.firstImage(j);
    if (!ref) return null;
    const out = await fal.download(ref, { timeoutMs: 20_000 });
    return out.buffer.length > 2048 ? out : null;
  } catch (e) {
    console.warn("imagePost upscale:", e.message);
    return null;
  }
}

/**
 * @param {{buffer:Buffer, mime:string}} img
 * @param {{width:number, height:number}} target  exact output size
 * @param {object} o
 * @param {boolean} o.aiUpscale  allow the paid upscale when it is worth it
 * @param {boolean} o.png        keep PNG (a transparent cut-out)
 * @returns {Promise<{buffer, mime, width, height, upscaled: false|'ai'|'lanczos'}>}
 */
async function finish(img, target, { aiUpscale: allowAi = false, png = false } = {}) {
  const ie = imageEdit();
  let { buffer, mime } = img;
  const size = ie.imageSize(buffer);
  const plain = { buffer, mime, width: size ? size.width : 0, height: size ? size.height : 0, upscaled: false };
  if (!size || !target || !target.width || !target.height) return plain;
  if (!ie.decodePlan(buffer, { minEdge: Math.max(target.width, target.height) })) return plain;

  let upscaled = false;
  let inW = size.width;
  let inH = size.height;
  const factor = Math.max(target.width / inW, target.height / inH);
  if (allowAi && factor >= AI_UPSCALE_MIN_FACTOR) {
    const up = await aiUpscale(buffer, mime, factor);
    const upSize = up && ie.imageSize(up.buffer);
    if (upSize) {
      buffer = up.buffer;
      mime = up.mime;
      inW = upSize.width;
      inH = upSize.height;
      upscaled = "ai";
    }
  }

  const alreadyExact = inW === target.width && inH === target.height;
  if (!(await ie.haveFfmpeg())) {
    return { buffer, mime, width: inW, height: inH, upscaled };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hari-finish-"));
  const kind = ie.imageKind(buffer);
  const inFile = path.join(dir, `in.${kind === "png" ? "png" : kind === "webp" ? "webp" : "jpg"}`);
  const outFile = path.join(dir, png ? "out.png" : "out.jpg");
  try {
    fs.writeFileSync(inFile, buffer);
    const vf = finishFilter({ inWidth: inW, inHeight: inH, width: target.width, height: target.height });
    await runFfmpeg(finishArgs({ inFile, outFile, vf, png }));
    const out = fs.readFileSync(outFile);
    if (out.length < 4096) return { buffer, mime, width: inW, height: inH, upscaled };
    return {
      buffer: out,
      mime: png ? "image/png" : "image/jpeg",
      width: target.width,
      height: target.height,
      upscaled: upscaled || (!alreadyExact && factor > 1.05 ? "lanczos" : false),
    };
  } catch (e) {
    console.warn("imagePost finish, keeping the image as it came:", e.message);
    return { buffer, mime, width: inW, height: inH, upscaled };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { finish, finishFilter, finishArgs, aiUpscale, AI_UPSCALE_MIN_FACTOR };
