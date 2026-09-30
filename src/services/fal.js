/**
 * FAL.AI — the paid-per-image models behind FAL_KEY (2026-09-30).
 * ----------------------------------------------------------------------
 * One small client for every fal model this server uses:
 *   fal-ai/qwen-image-2512      text to image, the best open model at words
 *   fal-ai/z-image/turbo        text to image, photos and illustrations
 *   fal-ai/qwen-image-edit-2511 edit a photo from an instruction
 *   fal-ai/birefnet/v2          cut the background out (transparent PNG)
 *   fal-ai/esrgan               upscale
 *
 * The synchronous endpoint (POST https://fal.run/{model}) answers with the
 * finished result; every image comes back as a URL on fal's own CDN, and
 * that copy is temporary, so it is downloaded straight away and ours is
 * the one that gets stored. Input images go up as data URIs, so a user's
 * photo is never published at a public URL of ours.
 *
 * Without FAL_KEY every function here is inert: falReady() is false and
 * nothing is called. FAL_IMAGES=off switches it off with the key still set.
 */

const FAL_BASE = "https://fal.run";

/** Where fal serves results from. Anything else in a response is refused:
 *  this server fetches the URL, so a response must not be able to point
 *  it at somewhere of its choosing. */
const RESULT_HOSTS = [/(^|\.)fal\.media$/i, /(^|\.)fal\.run$/i, /(^|\.)fal\.ai$/i];
const GCS_PREFIX = "https://storage.googleapis.com/falserverless/";

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/** Wall-clock ms until which fal is not tried. Auth, billing and rate
 *  limits belong to the ACCOUNT, so one answer quiets every model. */
let blockedUntil = 0;

function falKey() {
  return String(process.env.FAL_KEY || "").trim();
}

function falReady() {
  return !!falKey() && String(process.env.FAL_IMAGES || "on").toLowerCase() !== "off";
}

function coolingDown() {
  return Date.now() < blockedUntil;
}

class FalError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

/**
 * Run one model synchronously. Returns the parsed JSON body, or throws a
 * FalError. An auth or billing answer (401/402/403) sets fal aside
 * for six hours and a rate limit (429) for five minutes, so a missing
 * top-up costs one wasted call, not one per image.
 */
async function falRun(model, input, { timeoutMs = 40_000 } = {}) {
  if (!falReady()) throw new FalError("fal: no key");
  if (coolingDown()) throw new FalError(`fal ${model}: cooling down`);
  let r;
  try {
    r = await fetch(`${FAL_BASE}/${model}`, {
      method: "POST",
      headers: { Authorization: `Key ${falKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    });
  } catch (e) {
    throw new FalError(`fal ${model}: ${e.name === "TimeoutError" ? "timed out" : e.message}`);
  }
  if (r.status === 401 || r.status === 402 || r.status === 403) {
    blockedUntil = Date.now() + 6 * 3600_000;
  } else if (r.status === 429) {
    blockedUntil = Date.now() + 5 * 60_000;
  }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new FalError(`fal ${model}: HTTP ${r.status} ${t.replace(/\s+/g, " ").slice(0, 200)}`, r.status);
  }
  const j = await r.json().catch(() => null);
  if (!j || typeof j !== "object") throw new FalError(`fal ${model}: not JSON`);
  return j;
}

/** The first image a result names: {images:[…]} for generators and edits,
 *  {image:{…}} for birefnet and esrgan. */
function firstImage(json) {
  if (!json || typeof json !== "object") return null;
  const im = Array.isArray(json.images) ? json.images[0] : json.image;
  if (!im) return null;
  if (typeof im === "string") return { url: im };
  return im.url ? im : null;
}

function allowedResultUrl(url) {
  const s = String(url || "");
  if (s.startsWith(GCS_PREFIX)) return true;
  let u;
  try { u = new URL(s); } catch (_) { return false; }
  return u.protocol === "https:" && RESULT_HOSTS.some((re) => re.test(u.hostname));
}

/**
 * Fetch a result image into memory: {buffer, mime}. A data URI (fal's
 * sync_mode) is decoded in place; an https URL must be on fal's own hosts.
 */
async function download(ref, { timeoutMs = 30_000 } = {}) {
  const url = String(ref && ref.url ? ref.url : ref || "");
  const data = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (data) {
    const buffer = data[2] ? Buffer.from(data[3], "base64") : Buffer.from(decodeURIComponent(data[3]));
    return { buffer, mime: data[1] || ref.content_type || "image/png" };
  }
  if (!allowedResultUrl(url)) throw new FalError(`fal: result URL on an unexpected host`);
  const r = await fetch(url, { signal: AbortSignal.timeout(Math.max(1000, timeoutMs)) });
  if (!r.ok) throw new FalError(`fal: download HTTP ${r.status}`, r.status);
  const len = Number(r.headers.get("content-length") || 0);
  if (len > MAX_DOWNLOAD_BYTES) throw new FalError("fal: result too large");
  const buffer = Buffer.from(await r.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_BYTES) throw new FalError("fal: result too large");
  const mime = String(r.headers.get("content-type") || ref.content_type || "image/jpeg").split(";")[0];
  return { buffer, mime };
}

function dataUri(buffer, mime = "image/jpeg") {
  return `data:${mime};base64,${Buffer.from(buffer).toString("base64")}`;
}

/** Tests only. */
function _reset() {
  blockedUntil = 0;
}

module.exports = {
  falReady, falRun, firstImage, download, dataUri, allowedResultUrl, FalError,
  coolingDown, _reset, FAL_BASE,
};
