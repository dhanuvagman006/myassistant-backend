/**
 * AVATAR IDENTITY — HTTP surface (mounted at /avatar-profile, appAuth).
 *
 * A user manages ONLY their own representation; there is no route that
 * touches anyone else's, and renders always read the SENDER's profile —
 * the two facts that make "upload someone else's photo and impersonate
 * them" structurally impossible through this API.
 *
 *   GET    /            profile + engine availability (drives the UI)
 *   POST   /consent     { version }  explicit opt-in, audited
 *   DELETE /consent     revoke — renders stop immediately, assets kept
 *   POST   /face        multipart photo (jpeg/png/webp, ≤8MB)
 *   POST   /voice       multipart sample (wav/mp3/m4a, ≤15MB, ~10s is enough)
 *   PUT    /prefs       { enabled?, quality? }
 *   DELETE /            erase everything (files + provider-side clones)
 */
const multer = require("multer");
const db = require("../db");
const store = require("./store");
const service = require("./service");
const elevenlabs = require("./providers/elevenlabs");

const CONSENT_VERSION = "v1-2026-09";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const uid = (req, res) => {
  const id = Number(req.user?.sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "avatar identity requires a signed-in account" });
    return null;
  }
  return id;
};

const audit = (userId, action, detail) =>
  db
    .run(
      `INSERT INTO actions_log (user_id, action, detail, created_at) VALUES ($1,$2,$3,$4)`,
      [userId, action, detail, Date.now()]
    )
    .catch(() => {});

function router() {
  const r = require("express").Router();

  r.get("/", async (req, res) => {
    const id = uid(req, res);
    if (id === null) return;
    const p = await store.getProfile(id);
    res.json({
      consented: Boolean(p?.consent_at),
      consent_version: p?.consent_version || null,
      enabled: p ? Boolean(p.enabled) : true,
      has_face: Boolean(p?.face_path),
      has_voice: Boolean(p?.voice_path),
      quality: p?.quality || "standard",
      ready: store.renderable(p) && service.anyEngineConfigured(),
      engines: await service.status(),
    });
  });

  r.post("/consent", async (req, res) => {
    const id = uid(req, res);
    if (id === null) return;
    await store.upsertProfile(id, {
      consent_at: Date.now(),
      consent_version: String(req.body?.version || CONSENT_VERSION).slice(0, 40),
    });
    audit(id, "avatar.consent.granted", "user consented to AI face/voice representation");
    res.json({ ok: true });
  });

  r.delete("/consent", async (req, res) => {
    const id = uid(req, res);
    if (id === null) return;
    if (await store.getProfile(id)) {
      await store.upsertProfile(id, { consent_at: null });
    }
    audit(id, "avatar.consent.revoked", "user revoked avatar consent");
    res.json({ ok: true });
  });

  const requireConsent = async (id, res) => {
    const p = await store.getProfile(id);
    if (!p?.consent_at) {
      res.status(403).json({ error: "consent required before storing identity assets" });
      return false;
    }
    return true;
  };

  r.post("/face", upload.single("file"), async (req, res) => {
    const id = uid(req, res);
    if (id === null) return;
    if (!(await requireConsent(id, res))) return;
    const mime = req.file?.mimetype || "";
    if (!req.file?.buffer || !/^image\/(jpeg|png|webp)$/.test(mime)) {
      return res.status(400).json({ error: "a jpeg/png/webp photo is required" });
    }
    try {
      const p = await store.saveAsset("faces", id, req.file.buffer, mime);
      await store.upsertProfile(id, { face_path: p, face_mime: mime });
      audit(id, "avatar.face.updated", "reference photo replaced");
      res.json({ ok: true });
    } catch (e) {
      console.error("avatarmsg face upload:", e.message);
      res.status(500).json({ error: "could not store the photo" });
    }
  });

  r.post("/voice", upload.single("file"), async (req, res) => {
    const id = uid(req, res);
    if (id === null) return;
    if (!(await requireConsent(id, res))) return;
    const mime = req.file?.mimetype || "";
    if (!req.file?.buffer || !/^audio\/(wav|x-wav|mpeg|mp4|aac)$/.test(mime)) {
      return res.status(400).json({ error: "a wav/mp3/m4a voice sample is required" });
    }
    try {
      const p = await store.saveAsset("voices", id, req.file.buffer, mime);
      const fields = { voice_path: p, voice_mime: mime };

      // Managed-clone bootstrap: when ElevenLabs is the configured voice
      // path (no self-host worker), mint the IVC now so first sends are
      // fast. Failure is non-fatal — the worker path is zero-shot and the
      // Gemini floor always exists.
      const prev = await store.getProfile(id);
      if (elevenlabs.configured()) {
        try {
          if (prev?.voice_provider === "elevenlabs" && prev?.voice_ref) {
            await elevenlabs.deleteVoice(prev.voice_ref);
          }
          const ref = await elevenlabs.cloneVoice({
            samplePath: p,
            sampleMime: mime,
            label: `user-${id}`,
          });
          fields.voice_provider = "elevenlabs";
          fields.voice_ref = ref;
        } catch (e) {
          console.warn("avatarmsg: elevenlabs clone failed:", e.message);
        }
      }
      await store.upsertProfile(id, fields);
      audit(id, "avatar.voice.updated", "voice sample replaced");
      res.json({ ok: true, cloned: Boolean(fields.voice_ref) });
    } catch (e) {
      console.error("avatarmsg voice upload:", e.message);
      res.status(500).json({ error: "could not store the voice sample" });
    }
  });

  r.put("/prefs", async (req, res) => {
    const id = uid(req, res);
    if (id === null) return;
    const fields = {};
    if (typeof req.body?.enabled === "boolean") fields.enabled = req.body.enabled;
    if (["standard", "high"].includes(req.body?.quality)) fields.quality = req.body.quality;
    if (Object.keys(fields).length) await store.upsertProfile(id, fields);
    res.json({ ok: true });
  });

  r.delete("/", async (req, res) => {
    const id = uid(req, res);
    if (id === null) return;
    const p = await store.getProfile(id);
    if (p?.voice_provider === "elevenlabs" && p?.voice_ref) {
      await elevenlabs.deleteVoice(p.voice_ref).catch(() => {});
    }
    await store.deleteProfile(id);
    audit(id, "avatar.profile.erased", "face/voice identity deleted");
    res.json({ ok: true });
  });

  return r;
}

module.exports = { router, CONSENT_VERSION };
