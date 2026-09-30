/**
 * AI POSTER STUDIO ROUTES (2026-09-30) — mounted inside routes/posters.js,
 * so they sit behind appAuth and the posters' own per-user limiter
 * (server.js posterLimit), with daily caps of their own (studio.js).
 *
 *   POST /posters/ai/design      {request, format?: portrait|story|square,
 *                                 brand?: {name?, colors?[]}}
 *        → 200 {design: {title, subtitle, dateText, timeText, location, cta,
 *                        details[], style, palette{primary,secondary,accent,ink},
 *                        backgroundPrompt, missing[], format, date, source}}
 *          400 need_request · 429 daily_limit · 503 off
 *   POST /posters/ai/background  {prompt, style, format, seed?}
 *        → 201 {id, url, width, height, provider, mime}   (id is a document id;
 *          url is /docs/:id/file) · 429 busy | daily_limit · 502
 *          generation_failed · 503 off · 507 storage_full
 *   GET  /posters/ai/background/jobs/:jobId  (a background the voice tool started)
 *        → 200 {jobId, status: running|done|failed, background?, error?} · 404
 *
 * X-TZ-Offset (minutes east of UTC) sets the user's "today" for words like
 * "tomorrow". Errors are {error: code, message}, like every /posters route.
 */
const router = require("express").Router();
const { PosterError } = require("./service");
const studio = require("./studio");
const { tzFromReq } = require("../services/tz");

function uid(req, res) {
  let sub = req.user?.sub;
  if (sub === "anonymous-dev") sub = 0;
  const id = Number(sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "no_account", message: "The poster studio needs a signed-in account." });
    return null;
  }
  return id;
}

function fail(res, e, where) {
  if (e instanceof PosterError) {
    return res.status(e.http).json({ error: e.code, message: e.message, ...e.extra });
  }
  if (e && e.constructor?.name === "DocumentLimitError") {
    return res.status(507).json({ error: "storage_full", message: e.message });
  }
  console.error(`posters ai ${where}:`, e && (e.stack || e.message));
  return res.status(500).json({ error: "error", message: "Something went wrong with the poster. Try that again in a moment." });
}

router.post("/ai/design", async (req, res) => {
  const id = uid(req, res);
  if (!id) return;
  const b = req.body || {};
  try {
    const design = await studio.design(id, {
      request: typeof b.request === "string" ? b.request : "",
      format: b.format,
      brand: b.brand && typeof b.brand === "object" ? b.brand : {},
      tzOffsetMin: tzFromReq(req),
    });
    res.json({ design });
  } catch (e) {
    fail(res, e, "design");
  }
});

router.post("/ai/background", async (req, res) => {
  const id = uid(req, res);
  if (!id) return;
  const b = req.body || {};
  try {
    const bg = await studio.background(id, {
      prompt: typeof b.prompt === "string" ? b.prompt : "",
      style: b.style,
      format: b.format,
      seed: b.seed,
    });
    res.status(201).json(bg);
  } catch (e) {
    fail(res, e, "background");
  }
});

router.get("/ai/background/jobs/:jobId", (req, res) => {
  const id = uid(req, res);
  if (!id) return;
  const job = studio.getJob(id, req.params.jobId);
  if (!job) return res.status(404).json({ error: "not_found", message: "That background isn't here any more." });
  res.json(job);
});

module.exports = router;
