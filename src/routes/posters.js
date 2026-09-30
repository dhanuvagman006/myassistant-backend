/**
 * PHOTO CARDS ROUTES (all behind appAuth, with their own limiter —
 * server.js posterLimit — never the shared 30/min voice bucket).
 *
 *   GET    /posters/consent            → {accepted, version, text, aiRestore}
 *   POST   /posters/consent            → {accepted:true, version}
 *   DELETE /posters/consent            → {accepted:false, photosRemoved} — every
 *                                      working photo goes (taken off his cards)
 *   POST   /posters/photos             multipart {photo, source?, posterId?, colour?, ai?}
 *                                      → 201 {photo, poster?} · 413 too_large (bytes
 *                                      OR pixels) · 415 unsupported_type (doesn't open)
 *   POST   /posters/photos/from-document {documentId, posterId?, colour?} → 201 {photo, poster?}
 *   GET    /posters/photos/:id         → {photo}
 *   DELETE /posters/photos/:id         → {ok:true, posterIds} (the cards it was taken off)
 *   GET    /posters/photos/:id/file?v=original|enhanced[&colour=keep|bw|sepia] → image bytes
 *                                      (a card asks for its spec.photoColour)
 *   POST   /posters/photos/:id/colour  {colour: keep|bw|sepia} → {photo} — a photo on
 *                                      its own; a CARD's colour is PATCH change.photoColour
 *   POST   /posters/photos/:id/restore → 503 {error:'off'} (no AI in v1)
 *   POST   /posters/photos/:id/keep    {v} → 201 {document}
 *   POST   /posters                    {occasion?, spec?, photoId?} → 201 {poster}
 *   GET    /posters/latest             → {poster} | 404
 *   GET    /posters/:id                → {poster}
 *   PATCH  /posters/:id                {version, change} → {poster}  (change.photoColour
 *                                      keep|bw|sepia is the card photo's colour, undoable)
 *                                      409 version_conflict {poster} · 422 need · 400 bad_change
 *                                      503 unavailable (a colour asked where ffmpeg is missing)
 *   POST   /posters/:id/final          multipart {image: png, version} → 201 {document, poster}
 *   DELETE /posters/:id                → {ok:true}
 *
 * The contract, with an example of every object, is
 * tests/fixtures/posters/contract.json; the app's tests parse the same
 * file. Errors are {error: code, message}.
 */
const router = require("express").Router();
const multer = require("multer");
const svc = require("../posters/service");

// AI POSTER STUDIO (2026-09-30): /posters/ai/design, /posters/ai/background
// and its job poll, behind the same app auth and poster limiter.
router.use(require("../posters/aiRoutes"));

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: svc.MAX_PHOTO_BYTES, files: 1 },
});
const finalUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: svc.MAX_FINAL_BYTES, files: 1 },
});

function uid(req, res) {
  let sub = req.user?.sub;
  if (sub === "anonymous-dev") sub = 0;
  const id = Number(sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "no_account", message: "Photo cards need a signed-in account." });
    return null;
  }
  return id;
}

/** Multer as an explicit step, so a too-large file reads as clean JSON. */
const receive = (upload, field, tooLarge) => (req, res, next) =>
  upload.single(field)(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "too_large", message: tooLarge });
    console.error("posters upload:", err.message);
    return res.status(400).json({ error: "bad_upload", message: "That upload didn't come through — try again." });
  });

function fail(res, e, where) {
  if (e instanceof svc.PosterError) {
    return res.status(e.http).json({ error: e.code, message: e.message, ...e.extra });
  }
  if (e && e.constructor?.name === "DocumentLimitError") {
    return res.status(507).json({ error: "storage_full", message: e.message });
  }
  console.error(`posters ${where}:`, e && (e.stack || e.message));
  return res.status(500).json({ error: "error", message: "Something went wrong with the card. Try that again in a moment." });
}

/* ---- consent ---- */

router.get("/consent", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try { res.json(await svc.consent(id)); } catch (e) { fail(res, e, "GET /consent"); }
});

router.post("/consent", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const out = await svc.acceptConsent(id);
    require("../audit/log").record(id, "posters.consent", `accepted ${out.version}`).catch(() => {});
    res.json(out);
  } catch (e) { fail(res, e, "POST /consent"); }
});

router.delete("/consent", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const out = await svc.withdrawConsent(id);
    require("../audit/log").record(id, "posters.consent.withdrawn", "family-photo consent withdrawn").catch(() => {});
    res.json(out);
  } catch (e) { fail(res, e, "DELETE /consent"); }
});

/* ---- photos ---- */

router.post("/photos",
  receive(photoUpload, "photo", "That photo is too large — please pick one under 18 MB."),
  async (req, res) => {
    const id = uid(req, res);
    if (id === null) return;
    try {
      const f = req.file;
      if (!f?.buffer?.length) return res.status(400).json({ error: "no_photo", message: "Please choose a photo." });
      const out = await svc.addPhoto(id, {
        buffer: f.buffer,
        mime: f.mimetype,
        source: req.body.source,
        colour: req.body.colour || "keep",
        posterId: req.body.posterId,
        ai: req.body.ai,
      });
      res.status(201).json(out);
    } catch (e) { fail(res, e, "POST /photos"); }
  });

router.post("/photos/from-document", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const b = req.body || {};
    res.status(201).json(await svc.addPhotoFromDocument(id, {
      documentId: b.documentId, posterId: b.posterId, colour: b.colour || "keep", ai: b.ai,
    }));
  } catch (e) { fail(res, e, "POST /photos/from-document"); }
});

router.get("/photos/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  // ?wait= is accepted and ignored: v1 photos are ready when the upload
  // answers, so there is nothing to wait for.
  try { res.json({ photo: await svc.getPhoto(id, req.params.id) }); } catch (e) { fail(res, e, "GET /photos/:id"); }
});

// "You can delete it any time" (the consent text) — one photo, for good.
router.delete("/photos/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const out = await svc.deletePhoto(id, req.params.id);
    require("../audit/log").record(id, "posters.photo.deleted", `photo ${Number(req.params.id)}`).catch(() => {});
    res.json(out);
  } catch (e) { fail(res, e, "DELETE /photos/:id"); }
});

router.get("/photos/:id/file", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const v = String(req.query.v || "enhanced");
    const colour = req.query.colour === undefined ? null : String(req.query.colour);
    const { file, mime } = await svc.photoFile(id, req.params.id, v, colour);
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) fail(res, err, "GET /photos/:id/file");
    });
  } catch (e) { fail(res, e, "GET /photos/:id/file"); }
});

router.post("/photos/:id/colour", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try { res.json({ photo: await svc.recolourPhoto(id, req.params.id, String(req.body?.colour || "")) }); }
  catch (e) { fail(res, e, "POST /photos/:id/colour"); }
});

router.post("/photos/:id/restore", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try { await svc.restorePhoto(id, req.params.id); } catch (e) { fail(res, e, "POST /photos/:id/restore"); }
});

router.post("/photos/:id/keep", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    res.status(201).json({ document: await svc.keepPhoto(id, req.params.id, String(req.body?.v || "enhanced")) });
  } catch (e) { fail(res, e, "POST /photos/:id/keep"); }
});

/* ---- posters ---- */

router.post("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const b = req.body || {};
    res.status(201).json({ poster: await svc.createPoster(id, { occasion: b.occasion, spec: b.spec, photoId: b.photoId }) });
  } catch (e) { fail(res, e, "POST /"); }
});

router.get("/latest", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const poster = await svc.latestPoster(id);
    if (!poster) return res.status(404).json({ error: "not_found", message: "There's no card yet." });
    res.json({ poster });
  } catch (e) { fail(res, e, "GET /latest"); }
});

router.get("/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try { res.json({ poster: await svc.getPoster(id, req.params.id) }); } catch (e) { fail(res, e, "GET /:id"); }
});

router.patch("/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const b = req.body || {};
    if (b.version === undefined || b.version === null) {
      return res.status(400).json({ error: "bad_change", message: "version is required" });
    }
    const out = await svc.patchPoster(id, req.params.id, { version: b.version, change: b.change });
    res.json({ poster: out.poster, ...(out.limitReached ? { limitReached: true } : {}) });
  } catch (e) { fail(res, e, "PATCH /:id"); }
});

router.post("/:id/final",
  receive(finalUpload, "image", "The card picture is too large."),
  async (req, res) => {
    const id = uid(req, res);
    if (id === null) return;
    try {
      if (!req.file?.buffer?.length) {
        return res.status(400).json({ error: "no_image", message: "The card picture is missing." });
      }
      const out = await svc.saveFinal(id, req.params.id, { buffer: req.file.buffer, version: req.body.version });
      res.status(201).json(out);
    } catch (e) { fail(res, e, "POST /:id/final"); }
  });

router.delete("/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try { res.json(await svc.deletePoster(id, req.params.id)); } catch (e) { fail(res, e, "DELETE /:id"); }
});

module.exports = router;
