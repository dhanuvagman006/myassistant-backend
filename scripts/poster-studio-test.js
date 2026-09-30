/**
 * IMAGE GENERATION + AI POSTER STUDIO — `node scripts/poster-studio-test.js`.
 *
 * Pins the 2026-09-30 rebuild:
 *   - the provider chain is ordered by quality among the AVAILABLE
 *     providers, per purpose, and ends at the keyless tier;
 *   - Cloudflare FLUX.2 klein goes up as multipart (prompt/width/height/
 *     seed, no JSON), both response envelopes are read, schnell (JSON)
 *     stands behind it;
 *   - fal results are downloaded from fal's own hosts only;
 *   - Gemini sends responseModalities ['IMAGE'] + imageConfig.aspectRatio,
 *     honours GEMINI_IMAGE_BILLING, never uses the retired 2.5 model;
 *   - the prompt enhancer is skipped cleanly on failure or timeout, and a
 *     poster background always carries the no-text rule;
 *   - the poster design keeps ONLY what the user said (invented venue,
 *     time, price, phone removed and listed in `missing`), resolves
 *     "tomorrow" in the user's timezone;
 *   - /posters/ai/* need a signed-in user and keep their daily caps and
 *     one-at-a-time guard; the background is stored as a document;
 *   - create_event_poster's open_poster_studio directive, generate_image's
 *     hand-off of a poster with words, edit_my_photo's friendly failures.
 *
 * Nothing leaves this machine: every provider is a stub below.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = "poster-studio-" + Math.random().toString(36).slice(2) + Date.now();
for (const k of [
  "GEMINI_API_KEY", "GEMINI_FALLBACK_KEYS", "GEMINI_IMAGE_API_KEY", "GEMINI_IMAGE_BILLING",
  "GEMINI_IMAGE_MODEL", "CF_ACCOUNT_ID", "CF_API_TOKEN", "CF_IMAGE_MODEL", "CF_FALLBACK_IMAGE_MODEL",
  "FAL_KEY", "FAL_IMAGES", "HF_TOKEN", "HF_IMAGE_MODEL", "TOGETHER_API_KEY", "TOGETHER_IMAGE_MODEL",
  "IMAGE_PROVIDER_ORDER", "IMAGE_KEYLESS", "IMAGE_PROMPT_ENHANCE", "POSTER_AI",
  "POSTER_AI_BACKGROUNDS_PER_DAY", "POSTER_AI_DESIGNS_PER_DAY", "POSTER_STUDIO_MIN_BUILD",
  "AUTH_DISABLED", "ALLOW_APP_KEY",
]) delete process.env[k];
process.env.POSTER_TOOL_WAIT_MS = "3000";

const os = require("os");
const fs = require("fs");
const path = require("path");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "poster-studio-test-"));
process.env.DATA_DIR = path.join(TMP, "data");

/* ------------------------------------------------------------------ */
/* THE NETWORK — every host answered here                              */
/* ------------------------------------------------------------------ */
const realFetch = globalThis.fetch;
const calls = [];
const blocked = [];
const H = {
  geminiImage: null, geminiText: null, cf: null, fal: null, falCdn: null, poll: null,
};
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return realFetch(input, init);
  const u = new URL(url);
  const headers = new Headers(init.headers || {});
  let body = init.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) {} }
  const call = { url, host: u.hostname, path: u.pathname, headers, body, init };
  calls.push(call);
  const miss = (what) => json(500, { error: { message: `stub: no ${what}` } });
  if (u.hostname === "generativelanguage.googleapis.com") {
    const model = (u.pathname.match(/models\/([^:]+):/) || [])[1] || "";
    call.model = model;
    if (/image/i.test(model)) return H.geminiImage ? H.geminiImage(call) : miss("gemini image");
    return H.geminiText ? H.geminiText(call) : miss("gemini text");
  }
  if (u.hostname === "api.cloudflare.com") return H.cf ? H.cf(call) : miss("cloudflare");
  if (u.hostname === "fal.run") return H.fal ? H.fal(call) : miss("fal");
  if (/fal\.media$/.test(u.hostname)) return H.falCdn ? H.falCdn(call) : miss("fal cdn");
  if (u.hostname === "image.pollinations.ai") return H.poll ? H.poll(call) : new Response("down", { status: 502 });
  blocked.push(u.hostname);
  throw new Error(`poster-studio-test: network call to ${u.hostname} blocked`);
};
const since = (n) => calls.slice(n);

/** A JPEG the header readers measure; ffmpeg cannot decode it, so every
 *  post-processing step keeps it byte-for-byte (with or without ffmpeg). */
function fakeJpeg(w, h, size = 40 * 1024, fill = 0x11) {
  const b = Buffer.alloc(size, fill);
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]).copy(b, 0);
  b[size - 2] = 0xff; b[size - 1] = 0xd9;
  return b;
}
function fakePng(w, h, size = 30 * 1024) {
  const b = Buffer.alloc(size, 0x22);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
const geminiText = (text) => json(200, { candidates: [{ content: { parts: [{ text }] } }] });
const imageResponse = (buf, type = "image/jpeg") => new Response(buf, { status: 200, headers: { "content-type": type } });

/* ------------------------------------------------------------------ */
const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../src/db");

let passed = 0;
let skipped = 0;
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${(e.stack || e.message).split("\n").slice(0, 6).join("\n       ")}`); process.exitCode = 1; }
}
function skip(name, why) { skipped++; console.log(`  --  ${name} (skipped: ${why})`); }
function resetHandlers() { for (const k of Object.keys(H)) H[k] = null; }
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === null) delete process.env[k]; else process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === "function") return out.finally(restore);
  restore();
  return out;
}

(async () => {
  await db.init();
  const imagegen = require("../src/services/imagegen");
  const imagePrompt = require("../src/services/imagePrompt");
  const imagePost = require("../src/services/imagePost");
  const imageEdit = require("../src/services/imageEdit");
  const fal = require("../src/services/fal");
  const photoEdit = require("../src/services/photoEdit");
  const studio = require("../src/posters/studio");
  const studioTools = require("../src/posters/studioTools");
  const registry = require("../src/tools/registry");
  require("../src/tools/builtins").registerBuiltins();
  const docs = require("../src/docs/store");
  const HAVE_FFMPEG = await imageEdit.haveFfmpeg();
  const fresh = () => { imagegen._test._reset(); photoEdit._reset(); studio._test._reset(); resetHandlers(); };

  const stamp = String(Date.now()).slice(-7);
  const U = (await db.createUser({ email: `studio-u-${stamp}@example.test`, name: "Studio U" })).id;
  const V = (await db.createUser({ email: `studio-v-${stamp}@example.test`, name: "Studio V" })).id;

  /* ================================================================ */
  console.log("\nthe provider chain");
  /* ================================================================ */

  await atest("without keys only the keyless tier is left, and it is last", () => {
    fresh();
    assert.deepStrictEqual(imagegen.providerOrder("photo"), []);
    const now = imagegen.configuredProviders();
    assert.strictEqual(now.length, 1);
    assert.ok(now[0].startsWith("pollinations"));
  });

  await atest("ordered by quality among the AVAILABLE providers, per purpose", () => withEnv({
    CF_ACCOUNT_ID: "acct", CF_API_TOKEN: "tok", FAL_KEY: "fk",
    GEMINI_API_KEY: "gk", GEMINI_IMAGE_BILLING: "on",
  }, () => {
    fresh();
    assert.deepStrictEqual(imagegen.providerOrder("photo"), ["gemini", "fal-zimage", "cf-klein", "fal-qwen", "cf-schnell"]);
    assert.deepStrictEqual(imagegen.providerOrder("text"), ["gemini", "fal-qwen", "cf-klein", "fal-zimage", "cf-schnell"]);
    assert.deepStrictEqual(imagegen.providerOrder("background"), imagegen.providerOrder("photo"));
    process.env.GEMINI_IMAGE_BILLING = "off";
    delete process.env.FAL_KEY;
    assert.deepStrictEqual(imagegen.providerOrder("photo"), ["cf-klein", "cf-schnell"]);
    process.env.IMAGE_PROVIDER_ORDER = "cf-schnell,nonsense,cf-klein";
    assert.deepStrictEqual(imagegen.providerOrder("photo"), ["cf-schnell", "cf-klein"]);
    delete process.env.IMAGE_PROVIDER_ORDER;
  }));

  await atest("HF and Together are opt-in: a token alone does nothing", () => withEnv({
    HF_TOKEN: "hf", TOGETHER_API_KEY: "tg",
  }, () => {
    fresh();
    assert.deepStrictEqual(imagegen.providerOrder("photo"), []);
    process.env.HF_IMAGE_MODEL = "some/model";
    assert.deepStrictEqual(imagegen.providerOrder("photo"), ["huggingface"]);
    delete process.env.HF_IMAGE_MODEL;
  }));

  await atest("4:5 and 9:16 are real shapes; words in the picture are recognised", () => {
    assert.deepStrictEqual(imagegen.shapeOf("4:5"), { width: 1080, height: 1350, ratio: "4:5" });
    assert.deepStrictEqual(imagegen.shapeOf("story"), { width: 1080, height: 1920, ratio: "9:16" });
    assert.strictEqual(imagegen.shapeOf("portrait").ratio, "3:4");
    assert.ok(imagegen.wantsText('a logo for my café'));
    assert.ok(imagegen.wantsText('a sign that says "Open"'));
    assert.ok(!imagegen.wantsText("a beach house at sunset"));
  });

  await atest("a quota answer from the first provider falls through to the next, then to the keyless tier", () => withEnv({
    FAL_KEY: "fk", CF_ACCOUNT_ID: "acct", CF_API_TOKEN: "tok", CF_FALLBACK_IMAGE_MODEL: "off",
  }, async () => {
    fresh();
    const n = calls.length;
    H.fal = () => json(429, { detail: "rate limited" });
    H.cf = () => json(400, { success: false, errors: [{ message: "bad" }] });
    const jpg = fakeJpeg(768, 1024);
    H.poll = () => imageResponse(jpg);
    const img = await imagegen.generateImage("a tiger in the forest", { aspect: "portrait" });
    assert.strictEqual(img.provider, "pollinations");
    assert.ok(img.buffer.equals(jpg));
    assert.deepStrictEqual(since(n).map((c) => c.host), ["fal.run", "api.cloudflare.com", "image.pollinations.ai"]);
    // fal's 429 is remembered: the next image does not knock again.
    assert.ok(!imagegen.providerOrder("photo").includes("fal-zimage"));
  }));

  /* ================================================================ */
  console.log("\nCloudflare Workers AI");
  /* ================================================================ */

  await atest("FLUX.2 klein goes up as multipart: prompt, width, height, seed — and the envelope is read", () => withEnv({
    CF_ACCOUNT_ID: "acct-1", CF_API_TOKEN: "cf-token",
  }, async () => {
    fresh();
    const jpg = fakeJpeg(1024, 1280);
    let seen = null;
    H.cf = (call) => { seen = call; return json(200, { result: { image: jpg.toString("base64") }, success: true, errors: [] }); };
    const img = await imagegen.generateImage("a lighthouse in a storm", { aspect: "poster", seed: 42 });
    assert.match(seen.url, /\/accounts\/acct-1\/ai\/run\/@cf\/black-forest-labs\/flux-2-klein-4b$/);
    assert.strictEqual(seen.headers.get("authorization"), "Bearer cf-token");
    assert.ok(seen.init.body instanceof FormData, "klein takes multipart/form-data, not JSON");
    assert.strictEqual(seen.headers.get("content-type"), null, "fetch must write the multipart boundary itself");
    const f = seen.init.body;
    assert.match(f.get("prompt"), /lighthouse/);
    assert.strictEqual(f.get("width"), "1024");
    assert.strictEqual(f.get("height"), "1280");
    assert.strictEqual(f.get("seed"), "42");
    assert.strictEqual(Number(f.get("width")) % 16, 0);
    assert.strictEqual(img.provider, "cloudflare:flux-2-klein-4b");
    assert.ok(img.buffer.equals(jpg));
  }));

  await atest("raw image bytes from Cloudflare are read too", () => withEnv({
    CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t",
  }, async () => {
    fresh();
    const jpg = fakeJpeg(1280, 1280);
    H.cf = () => imageResponse(jpg);
    const img = await imagegen.generateImage("a red kite", { aspect: "square" });
    assert.ok(img.buffer.equals(jpg));
    assert.strictEqual(img.provider, "cloudflare:flux-2-klein-4b");
  }));

  await atest("klein refused → schnell as JSON {prompt, steps, seed} with no width/height", () => withEnv({
    CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t",
  }, async () => {
    fresh();
    const bodies = [];
    const jpg = fakeJpeg(1024, 1024);
    H.cf = (call) => {
      bodies.push(call);
      if (/klein/.test(call.url)) return json(400, { success: false, errors: [{ message: "validation" }] });
      return json(200, { result: { image: jpg.toString("base64") }, success: true });
    };
    const img = await imagegen.generateImage("a quiet lake", { aspect: "square", seed: 7 });
    assert.strictEqual(bodies.length, 2);
    assert.match(bodies[1].url, /flux-1-schnell$/);
    assert.strictEqual(bodies[1].headers.get("content-type"), "application/json");
    assert.deepStrictEqual(Object.keys(bodies[1].body).sort(), ["prompt", "seed", "steps"]);
    assert.strictEqual(img.provider, "cloudflare:flux-1-schnell");
  }));

  await atest("a token without Workers AI rights (403) is set aside, not retried per image", () => withEnv({
    CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t",
  }, async () => {
    fresh();
    H.cf = () => json(403, { success: false });
    H.poll = () => imageResponse(fakeJpeg(1024, 1024));
    await imagegen.generateImage("a quiet lake", { aspect: "square" });
    assert.deepStrictEqual(imagegen.providerOrder("photo"), []);
  }));

  /* ================================================================ */
  console.log("\nfal.ai");
  /* ================================================================ */

  await atest("fal: Key auth, image_size in the body, the result downloaded from fal's CDN", () => withEnv({
    FAL_KEY: "fal-secret",
  }, async () => {
    fresh();
    const jpg = fakeJpeg(1024, 1280, 60 * 1024, 0x33);
    let asked = null;
    H.fal = (call) => {
      asked = call;
      return json(200, { images: [{ url: "https://v3.fal.media/files/abc/out.jpg", width: 1024, height: 1280, content_type: "image/jpeg" }], seed: 1, has_nsfw_concepts: [false] });
    };
    H.falCdn = () => imageResponse(jpg);
    const img = await imagegen.generateImage("a portrait of a lighthouse keeper", { aspect: "poster" });
    assert.strictEqual(asked.url, "https://fal.run/fal-ai/z-image/turbo");
    assert.strictEqual(asked.headers.get("authorization"), "Key fal-secret");
    assert.deepStrictEqual(asked.body.image_size, { width: 1088, height: 1360 }, "at least the target, in 16s");
    assert.strictEqual(asked.body.num_images, 1);
    assert.ok(img.buffer.equals(jpg), "our own copy of the downloaded bytes");
    assert.strictEqual(img.provider, "fal:fal-ai/z-image/turbo");
  }));

  await atest("fal: pictures with words go to qwen-image-2512", () => withEnv({ FAL_KEY: "k" }, async () => {
    fresh();
    let model = null;
    H.fal = (call) => { model = call.path.slice(1); return json(200, { images: [{ url: "https://v3.fal.media/files/x.jpg" }] }); };
    H.falCdn = () => imageResponse(fakeJpeg(1536, 1536));
    await imagegen.generateImage('a café logo that says "Chai Point"', { aspect: "square" });
    assert.strictEqual(model, "fal-ai/qwen-image-2512");
  }));

  await atest("fal: a result URL on any other host is never fetched", () => withEnv({ FAL_KEY: "k" }, async () => {
    fresh();
    const n = calls.length;
    H.fal = () => json(200, { images: [{ url: "https://evil.example/steal.jpg" }] });
    H.poll = () => imageResponse(fakeJpeg(1024, 1024));
    const img = await imagegen.generateImage("a quiet lake", { aspect: "square" });
    assert.strictEqual(img.provider, "pollinations");
    assert.ok(!since(n).some((c) => c.host === "evil.example"));
    assert.ok(!fal.allowedResultUrl("http://v3.fal.media/x.jpg"), "plain http refused");
    assert.ok(fal.allowedResultUrl("https://storage.googleapis.com/falserverless/x.png"));
  }));

  await atest("a result far too small is upscaled once with fal esrgan", () => withEnv({ FAL_KEY: "k" }, async () => {
    fresh();
    const small = fakeJpeg(512, 640);
    const big = fakeJpeg(1024, 1280, 50 * 1024, 0x44);
    const models = [];
    H.fal = (call) => {
      models.push(call.path.slice(1));
      if (/esrgan/.test(call.path)) {
        assert.strictEqual(call.body.scale, 2);
        assert.match(call.body.image_url, /^data:image\/jpeg;base64,/);
        return json(200, { image: { url: "https://v3.fal.media/files/up.jpg" } });
      }
      return json(200, { images: [{ url: "https://v3.fal.media/files/small.jpg" }] });
    };
    H.falCdn = (call) => imageResponse(/up\.jpg/.test(call.url) ? big : small);
    const img = await imagegen.generateImage("a lighthouse", { aspect: "poster", aiUpscale: true });
    assert.deepStrictEqual(models, ["fal-ai/z-image/turbo", "fal-ai/esrgan"]);
    assert.ok(img.buffer.equals(big));
    assert.strictEqual(img.upscaled, "ai");
  }));

  /* ================================================================ */
  console.log("\nGemini image");
  /* ================================================================ */

  await atest("billing on: responseModalities IMAGE + imageConfig.aspectRatio, key in a header", () => withEnv({
    GEMINI_API_KEY: "gem-key", GEMINI_IMAGE_BILLING: "on", GEMINI_IMAGE_MODEL: "gemini-2.5-flash-image",
  }, async () => {
    fresh();
    const png = fakePng(1080, 1350);
    let seen = null;
    H.geminiImage = (call) => {
      seen = call;
      return json(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }] } }] });
    };
    const img = await imagegen.generateImage("a festival of lights", { aspect: "poster" });
    assert.strictEqual(seen.model, "gemini-3.1-flash-image", "the retired 2.5 model is never called");
    assert.deepStrictEqual(seen.body.generationConfig, { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "4:5" } });
    assert.strictEqual(seen.headers.get("x-goog-api-key"), "gem-key");
    assert.ok(!/key=/.test(seen.url), "no key in the URL");
    assert.strictEqual(img.provider, "gemini:gemini-3.1-flash-image");
    assert.ok(img.buffer.equals(png));
    assert.strictEqual(imagegen.geminiImageModel(), "gemini-3.1-flash-image");
  }));

  await atest("9:16 asks Gemini for 9:16; a field it rejects is dropped once, the image still comes", () => withEnv({
    GEMINI_API_KEY: "g", GEMINI_IMAGE_BILLING: "on",
  }, async () => {
    fresh();
    const png = fakePng(1080, 1920);
    const bodies = [];
    H.geminiImage = (call) => {
      bodies.push(call.body);
      if (call.body.generationConfig.imageConfig) return json(400, { error: { message: "Unknown name \"imageConfig\"" } });
      return json(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }] } }] });
    };
    const img = await imagegen.generateImage("a tall waterfall", { aspect: "story" });
    assert.strictEqual(bodies[0].generationConfig.imageConfig.aspectRatio, "9:16");
    assert.deepStrictEqual(bodies[1].generationConfig, { responseModalities: ["IMAGE"] });
    assert.ok(img.buffer.equals(png));
  }));

  await atest("billing off: Gemini image is never called", () => withEnv({
    GEMINI_API_KEY: "g", GEMINI_IMAGE_BILLING: "off",
  }, async () => {
    fresh();
    let hit = 0;
    H.geminiImage = () => { hit++; return json(429, {}); };
    H.poll = () => imageResponse(fakeJpeg(1024, 1024));
    await imagegen.generateImage("a quiet lake", { aspect: "square" });
    assert.strictEqual(hit, 0);
  }));

  /* ================================================================ */
  console.log("\nthe prompt enhancer");
  /* ================================================================ */

  await atest("a failed text call is skipped: the words go on, the no-text rule still added", () => withEnv({
    GEMINI_API_KEY: "g",
  }, async () => {
    fresh();
    H.geminiText = () => json(500, { error: { message: "stub: down" } });
    const e = await imagePrompt.enhancePrompt("Diwali sale", { purpose: "background" });
    assert.strictEqual(e.enhanced, false);
    assert.match(e.prompt, /^Diwali sale\./);
    assert.match(e.prompt, /no text, no letters, no logos, no watermark; leave clean negative space at top and bottom for typography/);
  }));

  await atest("a slow text call is cut at its deadline", () => withEnv({
    GEMINI_API_KEY: "g", IMAGE_PROMPT_TIMEOUT_MS: "1000",
  }, async () => {
    fresh();
    H.geminiText = (call) => new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(geminiText('{"prompt":"late"}')), 5000);
      call.init.signal?.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })); });
    });
    const t0 = Date.now();
    const e = await imagePrompt.enhancePrompt("a birthday party", { purpose: "photo" });
    assert.strictEqual(e.enhanced, false);
    assert.ok(Date.now() - t0 < 3500, `took ${Date.now() - t0} ms`);
  }));

  await atest("an answer is used, deity notes kept, quoted words stripped from a background", () => withEnv({
    GEMINI_API_KEY: "g",
  }, async () => {
    fresh();
    let sent = null;
    H.geminiText = (call) => {
      sent = call;
      return geminiText(JSON.stringify({ prompt: 'Lord Krishna under a kadamba tree at golden hour, 85mm, warm rim light, with the words "Happy Janmashtami" in gold' }));
    };
    const hints = imagegen.subjectHints("Krishna");
    const e = await imagePrompt.enhancePrompt("Krishna background", { purpose: "background", mustKeep: hints });
    assert.strictEqual(e.enhanced, true);
    assert.strictEqual(sent.model, "gemini-flash-lite-latest");
    assert.strictEqual(sent.body.generationConfig.responseMimeType, "application/json");
    assert.doesNotMatch(e.prompt, /Happy Janmashtami/);
    assert.match(e.prompt, /BLUE skin/);
    assert.match(e.prompt, /no text, no letters/);
  }));

  await atest("switched off, or no key: no text call at all", () => withEnv({ IMAGE_PROMPT_ENHANCE: "off", GEMINI_API_KEY: "g" }, async () => {
    fresh();
    const n = calls.length;
    const e = await imagePrompt.enhancePrompt("a cat", { purpose: "photo" });
    assert.strictEqual(e.skipped, "off");
    assert.strictEqual(since(n).length, 0);
  }));

  /* ================================================================ */
  console.log("\npost-processing");
  /* ================================================================ */

  await atest("one ffmpeg pass: cover-scale, exact crop, unsharp only when enlarged, tags stripped, q≈90", () => {
    const up = imagePost.finishFilter({ inWidth: 665, inHeight: 886, width: 1080, height: 1350 });
    assert.match(up, /^scale=1080:1350:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1350,unsharp=/);
    const down = imagePost.finishFilter({ inWidth: 2048, inHeight: 2560, width: 1080, height: 1350 });
    assert.doesNotMatch(down, /unsharp/);
    const args = imagePost.finishArgs({ inFile: "a", outFile: "b.jpg", vf: up, png: false });
    assert.ok(args.includes("-map_metadata") && args[args.indexOf("-map_metadata") + 1] === "-1");
    assert.strictEqual(args[args.indexOf("-q:v") + 1], "3");
    assert.ok(!imagePost.finishArgs({ inFile: "a", outFile: "b.png", vf: up, png: true }).includes("-q:v"));
  });

  if (HAVE_FFMPEG) {
    await atest("a real small JPEG comes out at the exact target size", async () => {
      const { execFileSync } = require("child_process");
      const src = path.join(TMP, "grad.jpg");
      execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "gradients=s=640x480", "-frames:v", "1", src]);
      const out = await imagePost.finish({ buffer: fs.readFileSync(src), mime: "image/jpeg" }, { width: 1080, height: 1350 });
      assert.deepStrictEqual(imageEdit.imageSize(out.buffer), { width: 1080, height: 1350 });
      assert.strictEqual(out.upscaled, "lanczos");
    });
  } else {
    skip("a real small JPEG comes out at the exact target size", "no ffmpeg on this machine — run in the Docker image");
  }

  /* ================================================================ */
  console.log("\nthe poster design — only what the user said");
  /* ================================================================ */

  const NOW = Date.parse("2026-09-30T20:00:00Z"); // 1:30 a.m. on 1 October in India
  const REQ = "Make a poster for our Annual Day celebration tomorrow at 6pm at Town Hall";

  await atest("'tomorrow' is tomorrow where the USER is", () => {
    const ist = studio.resolveWhen(REQ, { now: NOW, tzOffsetMin: 330 });
    assert.strictEqual(ist.iso, "2026-10-02");
    assert.strictEqual(ist.dateText, "Friday, 2 October 2026");
    assert.strictEqual(ist.timeText, "6:00 PM");
    const utc = studio.resolveWhen(REQ, { now: NOW, tzOffsetMin: 0 });
    assert.strictEqual(utc.iso, "2026-10-01");
    assert.strictEqual(studio.resolveWhen("on Oct 12 from 5 to 8 pm", { now: NOW, tzOffsetMin: 330 }).timeText, "5:00 – 8:00 PM");
  });

  await atest("invented venue, time, price, phone and guests are removed and listed as missing", () => {
    const when = studio.resolveWhen(REQ, { now: NOW, tzOffsetMin: 330 });
    const today = studio.localToday(NOW, 330);
    const d = studio.validateDesign({
      title: "Annual Day Celebration", subtitle: "Hosted by the Rotary Club", dateISO: "2026-10-05",
      timeText: "7 PM", location: "Town Hall, MG Road", cta: "Free entry! Call 9876543210",
      details: ["Dinner at 8 PM", "Chief guest: Mr Sharma", "Annual Day celebration"],
      style: "festive", palette: { primary: "#7a1022", ink: "#800000" },
      backgroundPrompt: 'warm stage lights with "Annual Day" written in gold', missing: ["contact", "nonsense"],
    }, { request: REQ, when, today });
    assert.strictEqual(d.title, "Annual Day Celebration");
    assert.strictEqual(d.dateText, "Friday, 2 October 2026", "the model's date loses to the resolved one");
    assert.strictEqual(d.timeText, "6:00 PM");
    assert.strictEqual(d.location, "", "one invented word in a venue sends people to the wrong place");
    assert.strictEqual(d.subtitle, "");
    assert.strictEqual(d.cta, "");
    assert.deepStrictEqual(d.details, [], "the one echo of the title is not a detail");
    assert.deepStrictEqual(d.missing, ["location", "contact"]);
    assert.strictEqual(d.style, "festive");
    assert.strictEqual(d.palette.ink, "#FFFFFF", "ink is made readable on the primary");
    assert.doesNotMatch(d.backgroundPrompt, /Annual Day|written/);
    const strict = new Set(["title", "subtitle", "dateText", "timeText", "location", "cta", "details",
      "style", "palette", "backgroundPrompt", "missing", "format", "date"]);
    assert.deepStrictEqual(Object.keys(d).filter((k) => !strict.has(k)), [], "no extra fields");
  });

  await atest("'our event tomorrow' has no name, time or place — all asked, none made up", () => {
    const req = "Make a poster for our event tomorrow";
    const d = studio.validateDesign(
      { title: "Tech Meetup 2026", location: "Bangalore International Centre", timeText: "10 AM", cta: "All are welcome" },
      { request: req, when: studio.resolveWhen(req, { now: NOW, tzOffsetMin: 330 }), today: studio.localToday(NOW, 330) });
    assert.strictEqual(d.title, "");
    assert.strictEqual(d.location, "");
    assert.strictEqual(d.timeText, "");
    assert.strictEqual(d.dateText, "Friday, 2 October 2026");
    assert.strictEqual(d.cta, "All are welcome", "an invitation with no facts is fine");
    assert.deepStrictEqual(d.missing, ["title", "timeText", "location"]);
  });

  await atest("a relative day in Malayalam: the model's date is taken only inside two weeks", () => {
    const req = "നാളെ വൈകുന്നേരം 6 മണിക്ക് ഓണാഘോഷം";
    const today = studio.localToday(NOW, 330);
    const ok = studio.validateDesign({ title: "ഓണാഘോഷം", dateISO: "2026-10-02", timeText: "6 PM" },
      { request: req, when: studio.resolveWhen(req, { now: NOW, tzOffsetMin: 330 }), today });
    assert.strictEqual(ok.title, "ഓണാഘോഷം");
    assert.strictEqual(ok.date, "2026-10-02");
    assert.strictEqual(ok.timeText, "6 PM");
    const far = studio.validateDesign({ dateISO: "2027-01-15" },
      { request: req, when: studio.resolveWhen(req, { now: NOW, tzOffsetMin: 330 }), today });
    assert.strictEqual(far.date, null);
  });

  await atest("brand colours lead the palette; bad colours are ignored", () => {
    const p = studio.paletteFor("corporate", { primary: "not-a-colour" }, ["#0a0", "#123456"]);
    assert.strictEqual(p.primary, "#00AA00");
    assert.strictEqual(p.secondary, "#123456");
    assert.ok(studio._test.contrast(p.ink, p.primary) >= 4.5);
  });

  /* ================================================================ */
  console.log("\n/posters/ai routes");
  /* ================================================================ */

  const { appAuth } = require("../src/middleware/auth");
  const app = express();
  app.use(express.json());
  app.use("/posters", appAuth, require("../src/posters/aiRoutes"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const sign = (id) => jwt.sign({ uid: id }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
  const post = (p, body, uid, headers = {}) => fetch(`${base}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(uid ? { Authorization: `Bearer ${sign(uid)}` } : {}), ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  await atest("design and background need a signed-in user", async () => {
    fresh();
    assert.strictEqual((await post("/posters/ai/design", { request: "x" })).status, 401);
    assert.strictEqual((await post("/posters/ai/background", { prompt: "x" })).status, 401);
  });

  await atest("POST /posters/ai/design: the model's JSON, checked, in the user's timezone", () => withEnv({ GEMINI_API_KEY: "g" }, async () => {
    fresh();
    let sent = null;
    H.geminiText = (call) => {
      sent = call;
      return geminiText(JSON.stringify({
        title: "Diwali Sale", subtitle: "", dateISO: "", timeText: "", location: "Main Street Store",
        cta: "Up to 50% off", details: ["Sweets for every customer"], style: "bold",
        palette: {}, backgroundPrompt: "diyas and marigolds, warm bokeh", missing: [],
      }));
    };
    const r = await post("/posters/ai/design", { request: "Poster for our Diwali sale this Saturday", format: "story", brand: { name: "Ravi Stores", colors: ["#E63946"] } }, U, { "X-TZ-Offset": "330" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const d = r.body.design;
    assert.strictEqual(d.title, "Diwali Sale");
    assert.strictEqual(d.location, "", "the store's street was never said");
    assert.strictEqual(d.cta, "", "a discount nobody mentioned is not printed");
    assert.deepStrictEqual(d.details, []);
    assert.strictEqual(d.format, "story");
    assert.strictEqual(d.style, "bold");
    assert.strictEqual(d.palette.primary, "#E63946");
    assert.ok(d.date && /^2026-10-0[3-9]$/.test(d.date) || d.date === null);
    assert.ok(d.missing.includes("location"));
    assert.strictEqual(d.source, "ai");
    const input = JSON.parse(sent.body.contents[0].parts[0].text);
    assert.strictEqual(input.request, "Poster for our Diwali sale this Saturday");
    assert.ok(input.todayISO && input.brand.name === "Ravi Stores");
  }));

  await atest("the design model down: the facts code can find, and a clear missing list", () => withEnv({ GEMINI_API_KEY: "g" }, async () => {
    fresh();
    H.geminiText = () => json(503, { error: { message: "busy" } });
    const r = await post("/posters/ai/design", { request: "Team meeting tomorrow at 4pm at the Conference Room" }, U);
    assert.strictEqual(r.status, 200);
    const d = r.body.design;
    assert.strictEqual(d.source, "fallback");
    assert.strictEqual(d.timeText, "4:00 PM");
    assert.strictEqual(d.location, "the Conference Room");
    assert.strictEqual(d.style, "corporate");
    assert.deepStrictEqual(d.missing, ["title"]);
  }));

  await atest("an empty request is a question, not a poster", async () => {
    fresh();
    const r = await post("/posters/ai/design", { request: "  " }, U);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, "need_request");
  });

  await atest("POST /posters/ai/background: text-free, finished at 1080x1350, stored as HIS document", () => withEnv({ CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, async () => {
    fresh();
    const jpg = fakeJpeg(1024, 1280);
    let prompt = "";
    H.cf = (call) => { prompt = call.init.body.get("prompt"); return json(200, { result: { image: jpg.toString("base64") }, success: true }); };
    const r = await post("/posters/ai/background", { prompt: 'a stage with "Annual Day" lights', style: "festive", format: "portrait", seed: 5 }, U);
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.deepStrictEqual(Object.keys(r.body).sort(), ["height", "id", "mime", "provider", "url", "width"]);
    assert.strictEqual(r.body.url, `/docs/${r.body.id}/file`);
    assert.strictEqual(r.body.provider, "cloudflare:flux-2-klein-4b");
    assert.match(prompt, /no text, no letters, no logos, no watermark/);
    assert.doesNotMatch(prompt, /Annual Day/);
    const doc = await docs.getDocument(U, r.body.id);
    assert.ok(doc && doc.tags.includes("poster-background"));
    assert.ok(fs.readFileSync(doc.path).equals(jpg));
    assert.strictEqual(await docs.getDocument(V, r.body.id), null, "not someone else's");
  }));

  await atest("one background at a time, and a daily cap; a failure gives the go back", () => withEnv({
    CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t", POSTER_AI_BACKGROUNDS_PER_DAY: "2",
  }, async () => {
    fresh();
    let release;
    const gate = new Promise((r) => { release = r; });
    H.cf = async () => { await gate; return json(200, { result: { image: fakeJpeg(1024, 1280).toString("base64") }, success: true }); };
    const first = post("/posters/ai/background", { style: "neon" }, U);
    await new Promise((r) => setTimeout(r, 150));
    const busy = await post("/posters/ai/background", { style: "neon" }, U);
    assert.strictEqual(busy.status, 429);
    assert.strictEqual(busy.body.error, "busy");
    release();
    assert.strictEqual((await first).status, 201);
    // A failed one costs nothing.
    H.cf = () => json(500, {});
    process.env.IMAGE_KEYLESS = "off";
    const failed = await post("/posters/ai/background", { style: "neon" }, U);
    assert.strictEqual(failed.status, 502);
    assert.strictEqual(failed.body.error, "generation_failed");
    delete process.env.IMAGE_KEYLESS;
    H.cf = () => json(200, { result: { image: fakeJpeg(1024, 1280).toString("base64") }, success: true });
    assert.strictEqual((await post("/posters/ai/background", { style: "neon" }, U)).status, 201);
    const over = await post("/posters/ai/background", { style: "neon" }, U);
    assert.strictEqual(over.status, 429);
    assert.strictEqual(over.body.error, "daily_limit");
    // Another user has his own allowance.
    assert.strictEqual((await post("/posters/ai/background", { style: "neon" }, V)).status, 201);
  }));

  await atest("POSTER_AI=off: 503 off", () => withEnv({ POSTER_AI: "off" }, async () => {
    fresh();
    const r = await post("/posters/ai/design", { request: "a poster" }, U);
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.error, "off");
  }));

  /* ================================================================ */
  console.log("\nthe voice tools");
  /* ================================================================ */

  const ctx = (extra = {}) => ({ userId: U, tzOffsetMin: 330, appBuild: 135, source: "voice", ...extra });

  await atest("create_event_poster: open_poster_studio with the checked design and the background", () => withEnv({
    GEMINI_API_KEY: "g", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t",
  }, async () => {
    fresh();
    H.geminiText = (call) => {
      const sys = JSON.stringify(call.body.systemInstruction || call.body);
      if (/lay out event posters/.test(sys)) {
        return geminiText(JSON.stringify({ title: "Annual Day", location: "Town Hall", timeText: "6 PM", style: "festive", backgroundPrompt: "golden stage lights", missing: [] }));
      }
      return json(500, {});
    };
    H.cf = () => json(200, { result: { image: fakeJpeg(1024, 1280).toString("base64") }, success: true });
    const r = await registry.execute("create_event_poster", { request: REQ }, ctx());
    assert.strictEqual(r.ok, true, r.error);
    const a = r.deviceAction;
    assert.strictEqual(a.type, "open_poster_studio");
    assert.strictEqual(a.design.title, "Annual Day");
    assert.strictEqual(a.design.location, "Town Hall");
    assert.ok(a.design.dateText.includes("October 2026"));
    assert.strictEqual(typeof a.backgroundId, "number");
    assert.strictEqual(a.background.id, a.backgroundId);
    assert.strictEqual(a.background.url, `/docs/${a.backgroundId}/file`);
    assert.strictEqual(a.backgroundJob, null);
    assert.strictEqual(r.data.backgroundReady, true);
    assert.match(r.note, /Never invent a venue/);
  }));

  await atest("a slow background: the studio opens now and the app polls the job", () => withEnv({
    CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t", POSTER_TOOL_WAIT_MS: "100",
  }, async () => {
    fresh();
    let release;
    const gate = new Promise((r) => { release = r; });
    H.cf = async () => { await gate; return json(200, { result: { image: fakeJpeg(1024, 1280).toString("base64") }, success: true }); };
    const r = await registry.execute("create_event_poster", { request: "Poster for the Onam celebration tomorrow at 10am at the Club House" }, ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.deviceAction.backgroundId, null);
    assert.ok(r.deviceAction.backgroundJob);
    assert.match(r.note, /still being made/);
    const poll = () => fetch(`${base}/posters/ai/background/jobs/${r.deviceAction.backgroundJob}`, { headers: { Authorization: `Bearer ${sign(U)}` } }).then(async (x) => ({ status: x.status, body: await x.json() }));
    assert.strictEqual((await poll()).body.status, "running");
    release();
    await new Promise((res) => setTimeout(res, 200));
    const done = await poll();
    assert.strictEqual(done.body.status, "done");
    assert.ok(done.body.background.id > 0);
    const other = await fetch(`${base}/posters/ai/background/jobs/${r.deviceAction.backgroundJob}`, { headers: { Authorization: `Bearer ${sign(V)}` } });
    assert.strictEqual(other.status, 404, "another user's job is not his to see");
  }));

  await atest("create_event_poster is offered only to app builds with the studio", () => {
    const t = registry.get("create_event_poster");
    assert.strictEqual(t.minAppBuild, studioTools.studioMinBuild());
    assert.strictEqual(t.deviceAction, true);
    assert.deepStrictEqual(t.inputSchema.required, ["request"]);
  });

  await atest("generate_image hands a poster WITH WORDS to the studio (new app), draws it on an old one", () => withEnv({
    CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t",
  }, async () => {
    fresh();
    H.cf = () => json(200, { result: { image: fakeJpeg(1024, 1280).toString("base64") }, success: true });
    const said = "Make a poster for our team meeting tomorrow at 4pm";
    const r = await registry.execute("generate_image", { prompt: "a corporate poster for a team meeting", aspect: "portrait" }, ctx({ userText: said }));
    assert.strictEqual(r.deviceAction.type, "open_poster_studio");
    assert.strictEqual(r.deviceAction.request, said);
    const old = await registry.execute("generate_image", { prompt: "a corporate poster for a team meeting", aspect: "portrait" }, ctx({ appBuild: 134, userText: said }));
    assert.strictEqual(old.deviceAction.type, "show_image");
    const tiger = await registry.execute("generate_image", { prompt: "a poster of a tiger in the jungle", aspect: "portrait" }, ctx({ userText: "draw a poster of a tiger" }));
    assert.strictEqual(tiger.deviceAction.type, "show_image", "a picture called a poster is still a picture");
    assert.ok(!studioTools.isWordsPoster("make a birthday card for my daughter tomorrow"), "greeting cards stay with the photo cards");
  }));

  // A photo he shared, for the edit tool.
  const shared = await docs.createDocument(U, { buffer: fakeJpeg(900, 1200), filename: "shared.jpg", mime: "image/jpeg", note: "shared photo" });

  await atest("edit_my_photo with no provider: a friendly reason, nothing saved, no crash", async () => {
    fresh();
    const before = (await docs.listDocuments(U, 500)).length;
    const r = await registry.execute("edit_my_photo", { instruction: "remove the background" }, ctx());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.data.code, "no_provider");
    assert.match(r.error, /isn't switched on/);
    assert.match(r.note, /not the photo's fault/);
    assert.strictEqual((await docs.listDocuments(U, 500)).length, before);
  });

  await atest("edit_my_photo never changes a face: declined before any model sees it", () => withEnv({ FAL_KEY: "k" }, async () => {
    fresh();
    const n = calls.length;
    const r = await registry.execute("edit_my_photo", { instruction: "make me look fairer and slimmer" }, ctx());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.data.code, "identity");
    assert.strictEqual(since(n).length, 0);
  }));

  await atest("remove the background: birefnet, a transparent PNG, a NEW document shown", () => withEnv({ FAL_KEY: "k" }, async () => {
    fresh();
    const png = fakePng(900, 1200);
    let asked = null;
    H.fal = (call) => { asked = call; return json(200, { image: { url: "https://v3.fal.media/files/cut.png", content_type: "image/png" } }); };
    H.falCdn = () => imageResponse(png, "image/png");
    const r = await registry.execute("edit_my_photo", { instruction: "remove the background", photo_doc_id: shared.id }, ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(asked.path, "/fal-ai/birefnet/v2");
    assert.strictEqual(asked.body.output_format, "png");
    assert.match(asked.body.image_url, /^data:image\/jpeg;base64,/);
    assert.strictEqual(r.deviceAction.type, "show_image");
    assert.notStrictEqual(r.deviceAction.doc_id, shared.id, "the original is never overwritten");
    assert.strictEqual(r.deviceAction.document.mime, "image/png");
    assert.strictEqual(r.data.transparent, true);
  }));

  await atest("a formal setting: qwen-image-edit with the identity rule; the newest shared photo by default", () => withEnv({ FAL_KEY: "k" }, async () => {
    fresh();
    let asked = null;
    H.fal = (call) => { asked = call; return json(200, { images: [{ url: "https://v3.fal.media/files/edit.jpg" }] }); };
    H.falCdn = () => imageResponse(fakeJpeg(900, 1200, 50 * 1024, 0x55));
    const r = await registry.execute("edit_my_photo", { instruction: "put this person in a formal office setting" }, ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(asked.path, "/fal-ai/qwen-image-edit-2511");
    assert.match(asked.body.prompt, /same face/);
    assert.strictEqual(asked.body.image_urls.length, 1);
    assert.strictEqual(r.data.from_document_id !== shared.id ? "newer" : "shared", "newer",
      "the birefnet result from the last test is now the newest photo");
  }));

  await atest("nothing left the machine", () => {
    assert.deepStrictEqual([...new Set(blocked)], []);
  });

  /* ================================================================ */
  server.close();
  const priv = require("../src/routes/privacy");
  for (const u of [U, V]) {
    await priv.deleteUserEverywhere(u, { reason: "test cleanup" }).catch((e) => console.warn("cleanup:", e.message));
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${passed} passed${skipped ? `, ${skipped} skipped (no ffmpeg)` : ""}`);
  await db.close();
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
