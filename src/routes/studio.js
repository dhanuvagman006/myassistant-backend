/**
 * STYLE STUDIO ROUTES (all behind appAuth).
 *
 *   GET    /studio                  → catalogue + the user's photos + looks
 *   POST   /studio/photos           multipart {file, role, label} → photo
 *   POST   /studio/photos/:id/default
 *   DELETE /studio/photos/:id
 *   POST   /studio/run              multipart {recipe, params, photo?, garment?,
 *                                              photoId?, garmentId?} → look
 *   GET    /studio/looks            → looks
 *   POST   /studio/looks/:id/favorite {on}
 *   DELETE /studio/looks/:id
 *
 * /studio/run is SYNCHRONOUS and can take up to a minute — a try-on is a
 * thing the user is sitting and watching, and a job queue would only add
 * a poll loop between them and the picture. The client's timeout is the
 * one that matters; the server does not hold anything open after it.
 *
 * CONSENT. The first upload of a face is gated behind an explicit consent
 * the app collects and sends, because a photograph of a face is sensitive
 * personal data under the DPDP Act and "they tapped the feature" is not
 * informed consent for storing their biometrics. It is recorded once,
 * per user, with a timestamp.
 */
const router = require("express").Router();
const multer = require("multer");

const recipes = require("../studio/recipes");
const store = require("../studio/store");
const run = require("../studio/run");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 18 * 1024 * 1024, files: 2 },
});
const OK_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

function uid(req, res) {
  let sub = req.user?.sub;
  if (sub === "anonymous-dev") sub = 0;
  const id = Number(sub);
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json({ error: "Style Studio needs a signed-in account" });
    return null;
  }
  return id;
}

/** Multer as an explicit step so LIMIT_FILE_SIZE reads as clean JSON. */
const receive = (fields) => (req, res, next) =>
  upload.fields(fields)(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "that photo is too large (max 18 MB)" });
    }
    console.error("studio upload:", err.message);
    return res.status(400).json({ error: "bad upload" });
  });

function firstFile(req, name) {
  const f = req.files?.[name]?.[0];
  if (!f?.buffer?.length) return null;
  if (!OK_MIME.has(f.mimetype)) {
    throw Object.assign(new Error(`unsupported image type ${f.mimetype}`), { http: 415 });
  }
  return { buffer: f.buffer, mime: f.mimetype };
}

/** Map a thrown error onto the right status and a sentence worth reading. */
function fail(res, e, where) {
  const code = e.code || "";
  if (e.http) return res.status(e.http).json({ error: e.message });
  if (code === "daily_cap") return res.status(429).json({ error: e.message, code });
  if (code === "no_model_photo") return res.status(409).json({ error: e.message, code });
  if (code === "unknown_recipe") return res.status(404).json({ error: e.message, code });
  if (code === "missing_photo" || code === "missing_file") {
    return res.status(410).json({ error: e.message, code });
  }
  if (code === "no_provider" || code === "edit_failed") {
    // 503 not 500: nothing the user did is wrong, and the app says so.
    console.error(`studio ${where}: ${code} — ${(e.notes || []).join(" | ")}`);
    return res.status(503).json({ error: e.message, code });
  }
  if (e.constructor?.name === "DocumentLimitError") {
    return res.status(507).json({ error: "your document storage is full — delete a few files first" });
  }
  console.error(`studio ${where}:`, e.stack || e.message);
  return res.status(500).json({ error: "Style Studio hit a snag. Try that again in a moment." });
}

/* ------------------------------------------------------------------ */

router.get("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const [photos, looks, used] = await Promise.all([
      store.listPhotos(id),
      store.listLooks(id, { limit: 60 }),
      store.spentToday(id),
    ]);
    res.json({
      recipes: recipes.catalogue(),
      photos,
      looks,
      cap: { used, limit: store.dailyCap() },
      consentedAt: await store.consentAt(id),
      // Named so the app can say "this needs setting up on the server"
      // instead of blaming the photo.
      providers: require("../services/imageEdit").configured(),
    });
  } catch (e) {
    fail(res, e, "GET /");
  }
});

/** The presets and colour swatches, whole — the catalogue only carries ids. */
router.get("/presets", (_req, res) => {
  res.json({
    outfit: recipes.OUTFIT_PRESETS,
    hair: recipes.HAIR_PRESETS,
    hairColours: recipes.HAIR_COLOURS,
    beard: recipes.BEARD_PRESETS,
    backdrop: recipes.BACKDROP_PRESETS,
    idSpecs: recipes.ID_SPECS.map((s) => ({ id: s.id, label: s.label, mm: s.mm, px: s.px, bg: s.bg })),
  });
});

/* ---- consent, recorded once ---- */

router.post("/consent", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    await store.setConsent(id);
    require("../audit/log")
      .record(id, "studio.consent", `accepted face-photo processing (${store.CONSENT_VERSION})`)
      .catch(() => {});
    res.json({ ok: true, at: await store.consentAt(id) });
  } catch (e) {
    fail(res, e, "POST /consent");
  }
});

/** Withdraw it — and take the stored face photos out with it. */
router.delete("/consent", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const removed = await store.withdrawConsent(id);
    require("../audit/log")
      .record(id, "studio.consent.withdrawn", `${removed} stored photo(s) deleted`)
      .catch(() => {});
    res.json({ ok: true, photosDeleted: removed });
  } catch (e) {
    fail(res, e, "DELETE /consent");
  }
});

/**
 * A face may not be stored or sent to a model until the user has said yes,
 * and that has to be enforced HERE. A consent screen in the app is a
 * courtesy; a server that accepts the upload anyway has not implemented
 * consent at all — an old build, a replayed request or a second client
 * would walk straight past it.
 */
async function requireConsent(userId, res) {
  if (await store.consentAt(userId)) return true;
  res.status(451).json({
    error:
      "Before Style Studio can use a photo of you, it needs your agreement " +
      "to store and process it. Open Style Studio and accept it once.",
    code: "consent_required",
  });
  return false;
}

/* ---- the user's photos and wardrobe ---- */

router.post("/photos", receive([{ name: "file", maxCount: 1 }]), async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const file = firstFile(req, "file");
    if (!file) return res.status(400).json({ error: "a photo is required" });
    const role = req.body.role === "garment" ? "garment" : "model";
    // A garment photo is a picture of a shirt; a model photo is a face.
    if (role === "model" && !(await requireConsent(id, res))) return;
    const photo = await run.addPhoto(id, {
      buffer: file.buffer,
      mime: file.mime,
      role,
      label: String(req.body.label || "").slice(0, 120),
      makeDefault: String(req.body.makeDefault) === "true",
    });
    res.status(201).json({ photo });
  } catch (e) {
    fail(res, e, "POST /photos");
  }
});

router.post("/photos/:id/default", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const row = await store.getPhoto(id, Number(req.params.id));
    if (!row) return res.status(404).json({ error: "not found" });
    await store.setDefaultModel(id, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    fail(res, e, "POST /photos/:id/default");
  }
});

router.delete("/photos/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const ok = await store.deletePhoto(id, Number(req.params.id));
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "not found" });
  } catch (e) {
    fail(res, e, "DELETE /photos/:id");
  }
});

/* ---- the actual work ---- */

router.post(
  "/run",
  receive([{ name: "photo", maxCount: 1 }, { name: "garment", maxCount: 1 }]),
  async (req, res) => {
    const id = uid(req, res);
    if (id === null) return;
    try {
      let params = {};
      if (req.body.params) {
        try { params = JSON.parse(req.body.params) || {}; }
        catch (_) { return res.status(400).json({ error: "params must be JSON" }); }
      }
      // Loose form fields are accepted too, so a quick client need not
      // build a JSON blob for one value.
      for (const [k, v] of Object.entries(req.body)) {
        if (["recipe", "params", "photoId", "garmentId", "keepPhoto"].includes(k)) continue;
        if (params[k] === undefined) params[k] = v;
      }

      if (!(await requireConsent(id, res))) return;

      const out = await run.runRecipe(id, {
        recipeId: req.body.recipe,
        params,
        photoId: req.body.photoId,
        garmentId: req.body.garmentId,
        photo: firstFile(req, "photo"),
        garment: firstFile(req, "garment"),
        surface: "app",
      });

      // An uploaded base photo is kept only when asked — otherwise the
      // studio would silently accumulate every selfie a user ever tried.
      if (String(req.body.keepPhoto) === "true" && req.files?.photo?.[0]) {
        const f = firstFile(req, "photo");
        await run
          .addPhoto(id, { buffer: f.buffer, mime: f.mime, role: "model", makeDefault: true })
          .catch(() => null);
      }
      res.json(out);
    } catch (e) {
      fail(res, e, "POST /run");
    }
  }
);

/* ---- looks ---- */

router.get("/looks", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const recipe = String(req.query.recipe || "").trim() || null;
    res.json({ looks: await store.listLooks(id, { recipe, limit: 200 }) });
  } catch (e) {
    fail(res, e, "GET /looks");
  }
});

router.post("/looks/:id/favorite", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const row = await store.getLook(id, Number(req.params.id));
    if (!row) return res.status(404).json({ error: "not found" });
    await store.favorite(id, Number(req.params.id), req.body?.on !== false);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e, "POST /looks/:id/favorite");
  }
});

router.delete("/looks/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const ok = await store.deleteLook(id, Number(req.params.id));
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "not found" });
  } catch (e) {
    fail(res, e, "DELETE /looks/:id");
  }
});

module.exports = router;
