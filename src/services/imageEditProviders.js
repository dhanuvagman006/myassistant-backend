/**
 * OPTIONAL, KEYED IMAGE-EDIT PROVIDERS.
 * ----------------------------------------------------------------------
 * Two purpose-built virtual-try-on models, each a no-op without its key,
 * each registered AHEAD of the general Gemini editor for garment requests
 * only. The reason is architectural rather than a matter of taste: these
 * models composite the garment onto the existing photograph, so the face,
 * the pose and the skin tone are not regenerated at all and the garment's
 * print survives intact. A general instruction editor re-renders the whole
 * frame and can drift on both counts. For a hairstyle or a backdrop, where
 * there is no garment to composite, they do not apply and Gemini leads.
 *
 * Field names below are taken from each vendor's own API reference, not
 * from a summary. Where a vendor documents an option we deliberately do
 * not send, there is a comment saying why.
 *
 * DELIBERATELY NOT WIRED, and it is worth recording why:
 *   • Replicate IDM-VTON — CC BY-NC-SA 4.0. Non-commercial only.
 *   • fal cat-vton, Replicate CodeFormer (S-Lab) — research licences.
 *     Shipping any of them inside a paid product would be a licence
 *     breach, which is not a trade-off to make quietly.
 *   • fal.ai's try-on endpoints take image URLs. Ours live behind
 *     authentication, so wiring fal means either publishing a temporary
 *     unauthenticated URL for a photograph of the user's face or relying
 *     on data-URI support the docs do not state. Neither is worth doing
 *     blind; it can be added the day the upload path is confirmed.
 */

/* ------------------------------------------------------------------ */
/* GOOGLE VERTEX AI — virtual-try-on-001                               */
/*                                                                     */
/* Purpose-built, GA, $0.06 per output image, synchronous. Output       */
/* resolution follows the person image, which is why normalizeInput     */
/* keeps the long edge generous. Needs a real GCP service account —     */
/* there is no API-key mode for this model.                            */
/* ------------------------------------------------------------------ */

let vertexAuth = null;
function vertexCredentials() {
  const inline = process.env.VERTEX_SA_JSON || process.env.GOOGLE_VERTEX_SA_JSON;
  if (inline) {
    try { return JSON.parse(inline); } catch (e) {
      console.error("imageEdit vertex: VERTEX_SA_JSON is not valid JSON —", e.message);
      return null;
    }
  }
  return null; // else google-auth-library finds GOOGLE_APPLICATION_CREDENTIALS itself
}

function vertexReady() {
  return !!(
    (process.env.VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT) &&
    (process.env.VERTEX_SA_JSON || process.env.GOOGLE_VERTEX_SA_JSON ||
     process.env.GOOGLE_APPLICATION_CREDENTIALS)
  );
}

async function vertexToken() {
  const { GoogleAuth } = require("google-auth-library");
  if (!vertexAuth) {
    const credentials = vertexCredentials();
    vertexAuth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      ...(credentials ? { credentials } : {}),
    });
  }
  const client = await vertexAuth.getClient();
  const t = await client.getAccessToken();
  return typeof t === "string" ? t : t?.token || null;
}

async function tryVertexVto({ images, notes, vtoCategory }) {
  if (!vertexReady()) { notes.push("vertex-vto: not configured"); return null; }
  const project = process.env.VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  const region = process.env.VERTEX_LOCATION || "us-central1";
  const model = process.env.VERTEX_VTO_MODEL || "virtual-try-on-001";
  const [person, ...products] = images;
  if (!products.length) { notes.push("vertex-vto: needs a garment image"); return null; }

  let token;
  try {
    token = await vertexToken();
  } catch (e) {
    notes.push(`vertex-vto: could not get an access token (${e.message})`);
    return null;
  }
  if (!token) { notes.push("vertex-vto: no access token"); return null; }

  const body = {
    instances: [{
      personImage: { image: { bytesBase64Encoded: person.buffer.toString("base64") } },
      productImages: products.slice(0, 1).map((p) => ({
        image: { bytesBase64Encoded: p.buffer.toString("base64") },
        // productDescription steers which garment region is replaced when
        // the flat-lay is ambiguous. The model infers the region itself —
        // there is no category enum on this API, unlike FASHN's.
        ...(vtoCategory ? { productImageConfig: { productDescription: String(vtoCategory).slice(0, 200) } } : {}),
      })),
    }],
    parameters: {
      sampleCount: 1,
      // addWatermark stays at its default (true) on purpose: it is
      // Google's invisible SynthID provenance mark, which is exactly the
      // labelling India's IT Amendment Rules 2026 ask for on synthetic
      // media, and it is invisible so it costs the user nothing. Note
      // that setting `seed` would force it off — so we never set a seed.
      safetySetting: "block-only-high",
      personGeneration: "allow-adult",
    },
  };

  try {
    const r = await fetch(
      `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}` +
      `/publishers/google/models/${model}:predict`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      }
    );
    if (!r.ok) {
      notes.push(`vertex-vto: HTTP ${r.status} ${(await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200)}`);
      return null;
    }
    const d = await r.json().catch(() => null);
    const pred = d?.predictions?.[0];
    if (pred?.raiFilteredReason) {
      notes.push(`vertex-vto: safety-filtered (${String(pred.raiFilteredReason).slice(0, 120)})`);
      return null;
    }
    if (!pred?.bytesBase64Encoded) {
      notes.push("vertex-vto: no image in the response");
      return null;
    }
    return {
      buffer: Buffer.from(pred.bytesBase64Encoded, "base64"),
      mime: pred.mimeType || "image/png",
      provider: `vertex:${model}`,
    };
  } catch (e) {
    notes.push(`vertex-vto: ${e.name === "TimeoutError" ? "timed out" : e.message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* FASHN AI — tryon-v1.6 / tryon-max                                   */
/*                                                                     */
/* Submit-then-poll. Strongest reported garment print and pattern       */
/* fidelity, and the only one of the three with an explicit garment     */
/* REGION control, so "try these trousers" does not repaint the shirt.  */
/* ------------------------------------------------------------------ */

const FASHN_CATEGORIES = new Set(["auto", "tops", "bottoms", "one-pieces"]);

function dataUri(im) {
  return `data:${im.mime || "image/jpeg"};base64,${im.buffer.toString("base64")}`;
}

async function tryFashn({ images, notes, vtoCategory, hiQuality }) {
  const key = process.env.FASHN_API_KEY;
  if (!key) { notes.push("fashn: no key"); return null; }
  const [person, garment] = images;
  if (!garment) { notes.push("fashn: needs a garment image"); return null; }

  const model = process.env.FASHN_MODEL || "tryon-v1.6";
  const isMax = /max/i.test(model);
  const category = FASHN_CATEGORIES.has(String(vtoCategory)) ? String(vtoCategory) : "auto";
  const inputs = isMax
    ? {
        model_image: dataUri(person),
        product_image: dataUri(garment),
        resolution: process.env.FASHN_RESOLUTION || (hiQuality ? "2k" : "1k"),
        generation_mode: process.env.FASHN_MODE || "quality",
        num_images: 1,
        output_format: "png",
        return_base64: true,
      }
    : {
        model_image: dataUri(person),
        garment_image: dataUri(garment),
        category,
        garment_photo_type: "auto",
        mode: process.env.FASHN_MODE || "quality",
        segmentation_free: true,
        num_samples: 1,
        output_format: "png",
        return_base64: true,
      };

  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  let id;
  try {
    const r = await fetch("https://api.fashn.ai/v1/run", {
      method: "POST",
      headers,
      body: JSON.stringify({ model_name: model, inputs }),
      signal: AbortSignal.timeout(60_000),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d?.id) {
      notes.push(`fashn: submit HTTP ${r.status} ${JSON.stringify(d?.error || d || {}).slice(0, 200)}`);
      return null;
    }
    id = d.id;
  } catch (e) {
    notes.push(`fashn: submit ${e.name === "TimeoutError" ? "timed out" : e.message}`);
    return null;
  }

  // Documented latency is 5-17 s for v1.6 and up to ~55 s for max/4k, so
  // the ceiling is 90 s with a short first poll and a widening interval.
  const deadline = Date.now() + 90_000;
  let wait = 1500;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, wait));
    wait = Math.min(wait + 750, 5000);
    let d;
    try {
      const r = await fetch(`https://api.fashn.ai/v1/status/${id}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20_000),
      });
      d = await r.json().catch(() => null);
      if (!r.ok) { notes.push(`fashn: status HTTP ${r.status}`); return null; }
    } catch (e) {
      continue; // one flaky poll must not lose a job that is already paid for
    }
    if (d?.status === "failed") {
      notes.push(`fashn: failed ${JSON.stringify(d.error || {}).slice(0, 200)}`);
      return null;
    }
    if (d?.status !== "completed") continue;

    const first = Array.isArray(d.output) ? d.output[0] : null;
    if (!first) { notes.push("fashn: completed with no output"); return null; }
    // return_base64 gives bytes; a CDN URL is still handled, because the
    // flag is documented but a provider is free to ignore it.
    if (/^https?:\/\//.test(first)) {
      try {
        const img = await fetch(first, { signal: AbortSignal.timeout(45_000) });
        if (!img.ok) { notes.push(`fashn: output fetch HTTP ${img.status}`); return null; }
        return {
          buffer: Buffer.from(await img.arrayBuffer()),
          mime: img.headers.get("content-type") || "image/png",
          provider: `fashn:${model}`,
        };
      } catch (e) {
        notes.push(`fashn: output fetch ${e.message}`);
        return null;
      }
    }
    const b64 = first.replace(/^data:[^;]+;base64,/, "");
    return { buffer: Buffer.from(b64, "base64"), mime: "image/png", provider: `fashn:${model}` };
  }
  notes.push("fashn: still running after 90 s, gave up");
  return null;
}

/* ------------------------------------------------------------------ */

function install(register) {
  register({
    name: "fashn",
    priority: -1,
    vtoOnly: true,
    ready: () => !!process.env.FASHN_API_KEY,
    when: ({ vto, images }) => vto && images.length >= 2 && !!process.env.FASHN_API_KEY,
    run: tryFashn,
  });
  register({
    name: "vertex-vto",
    priority: -1,
    vtoOnly: true,
    ready: vertexReady,
    when: ({ vto, images }) => vto && images.length >= 2 && vertexReady(),
    run: tryVertexVto,
  });
}

module.exports = { install, vertexReady, tryVertexVto, tryFashn };
