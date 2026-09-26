/**
 * SEND MESSAGES AS YOU — the user's own identity (all behind appAuth).
 *
 *   GET    /avatar-profile          → {consented, consented_at, enabled,
 *                                      has_video, video, has_face,
 *                                      has_voice, script_version}
 *   POST   /avatar-profile/consent  → {ok}
 *   DELETE /avatar-profile/consent  → {ok}  off, and waiting notes cancelled
 *   PUT    /avatar-profile/prefs    {enabled} → {ok} | 409 {error}
 *   DELETE /avatar-profile          → {ok}  every file and the row, gone
 *   POST   /avatar-profile/video    multipart file + duration_ms,
 *                                   script_version → {ok, video}
 *   POST   /avatar-profile/face     multipart file (builds <= 117)
 *   POST   /avatar-profile/voice    multipart file (builds <= 117)
 *
 * The app has called these since 2026-09-04 and none of them existed, so
 * the screen behind "Send messages as you" spun forever. The owner's
 * version (2026-09-26): the user reads a scrolling script to the front
 * camera for about 30 s and taps Save — that clip lands here — and later
 * "send a video note to Danush saying…" is made from it by hand
 * (videonotes/service.js).
 *
 * CONSENT IS CHECKED HERE, before a byte is written. A consent screen in
 * the app is a courtesy; a server that stores a face without its own
 * record of a yes has not implemented consent at all.
 *
 * NO GALLERY — IN THE APP. The app records the clip live with the front
 * camera and offers no file picker, because a video note made from a clip
 * of somebody else is exactly the harm to prevent. The SERVER cannot
 * enforce that: POST /video accepts any MP4/MOV a signed-in, consented
 * client sends (curl included), and duration_ms and script_version are
 * the client's word. The enforced check is downstream — the owner watches
 * every take on the admin Video notes page and confirms it is the account
 * holder reading the consent sentence before any clip is stored
 * (videonotes/service.js confirmIdentity; review, 2026-09-26).
 */
const router = require("express").Router();
const multer = require("multer");
const os = require("os");
const fs = require("fs");
const rateLimit = require("express-rate-limit");

const store = require("../videonotes/store");
const notes = require("../videonotes/service");
const media = require("../storage/media");
const audit = require("../audit/log");

const MB = 1024 * 1024;
// A 30 s 1080p front-camera clip is ~30-60 MB. AVATAR_VIDEO_MAX_MB moves
// the ceiling without a deploy (and lets the tests reach it cheaply).
const VIDEO_MAX = (Number(process.env.AVATAR_VIDEO_MAX_MB) > 0
  ? Number(process.env.AVATAR_VIDEO_MAX_MB) : 120) * MB;
const MIN_MS = 15_000;
const MAX_MS = 90_000;

const VIDEO_MIME = { "video/mp4": ".mp4", "video/quicktime": ".mov" };
const FACE_MIME = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic" };
const VOICE_MIME = {
  "audio/mp4": ".m4a", "audio/m4a": ".m4a", "audio/x-m4a": ".m4a", "audio/aac": ".aac",
  "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/ogg": ".ogg",
  "audio/webm": ".webm",
};

function uid(req, res) {
  const id = Number(req.user?.sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "this needs a signed-in account" });
    return null;
  }
  return id;
}

// Uploads on top of the per-user minute limit the mount already has: a
// few re-takes are normal, more than twenty in an hour is not a person.
const uploadLimit = rateLimit({
  windowMs: 60 * 60_000,
  max: 20,
  standardHeaders: true,
  keyGenerator: (req) => `avatar-upload:${req.user?.sub || req.ip}`,
  message: { error: "Too many uploads for now — try again in a little while." },
});

/** Spooled to disk, never RAM: the pod has 512Mi and live calls to relay. */
function receiver(maxBytes) {
  const upload = multer({
    storage: multer.diskStorage({
      destination: os.tmpdir(),
      filename: (_req, _file, cb) => cb(null, `avatar-${Date.now()}-${media.newId()}.upload`),
    }),
    limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 1024 },
  });
  const mb = Math.round(maxBytes / MB);
  return (req, res, next) =>
    upload.single("file")(req, res, (err) => {
      if (!err) return next();
      if (req.file?.path) fs.rm(req.file.path, { force: true }, () => {});
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: `that file is too large (the limit is ${mb} MB)` });
      }
      console.warn("avatar-profile upload:", err.message);
      return res.status(400).json({ error: "bad upload" });
    });
}

/** Refuses before the body is read when there is no consent on record. */
async function requireConsent(req, res, next) {
  const id = uid(req, res);
  if (id === null) return;
  const p = await store.getProfile(id);
  if (!p || Number(p.consented) !== 1) {
    // Nothing is written: multer has not run yet. Node drains whatever
    // is still arriving, so the app reads this answer rather than a reset.
    return res.status(403).json({ error: "consent_required" });
  }
  next();
}

/**
 * An MP4 or MOV starts with an ISO-BMFF box: 4 bytes of size, then its
 * type. A file whose first box is not one of these is not a video,
 * whatever its Content-Type said.
 */
async function looksLikeVideo(file) {
  let fh;
  try {
    fh = await fs.promises.open(file, "r");
    const buf = Buffer.alloc(12);
    const { bytesRead } = await fh.read(buf, 0, 12, 0);
    if (bytesRead < 12) return false;
    return ["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(buf.toString("latin1", 4, 8));
  } catch (_) {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

const drop = (req) => req.file?.path && fs.promises.rm(req.file.path, { force: true }).catch(() => {});

/* ------------------------------------------------------------------ */

router.get("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  res.json(store.toClient(await store.getProfile(id)));
});

router.post("/consent", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  await store.setConsent(id, true);
  audit.record(id, "avatar.consent",
    `agreed to video notes in their face and voice (${store.CONSENT_VERSION})`).catch(() => {});
  res.json({ ok: true });
});

router.delete("/consent", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  await store.setConsent(id, false);
  // Consent is off from here: storing and delivering a clip both read it
  // again. A cancel that fails is still reported as a failure, not an
  // ok:true, so the app says so and the user can try again.
  let cancelled;
  try {
    cancelled = await notes.cancelForUser(id, "consent withdrawn");
  } catch (e) {
    console.error("avatar-profile consent withdrawal:", e.message);
    return res.status(500).json({ error: "that didn't finish — try again" });
  }
  audit.record(id, "avatar.consent.withdrawn",
    `video notes switched off${cancelled ? `, ${cancelled} waiting note(s) cancelled` : ""}`).catch(() => {});
  res.json({ ok: true });
});

router.put("/prefs", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const raw = req.body?.enabled;
  if (raw !== true && raw !== false && raw !== "true" && raw !== "false") {
    return res.status(400).json({ error: "enabled must be true or false" });
  }
  const on = raw === true || raw === "true";
  const p = await store.getProfile(id);
  if (on) {
    if (!p || Number(p.consented) !== 1) {
      return res.status(409).json({ error: "Agree to video notes first." });
    }
    if (!p.video_key) {
      return res.status(409).json({ error: "Record your 30-second video first." });
    }
  }
  if (p) await store.setEnabled(id, on);
  res.json({ ok: true });
});

/** "Delete everything": the video, photo, voice sample, kept clips, row. */
router.delete("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  // THE ROW GOES FIRST. Every other writer re-reads it under lock — a new
  // note, an upload landing, a clip being stored or delivered — so once it
  // is gone none of them can add anything; whatever committed before it
  // is cancelled or swept below. Files first and row last left a window
  // where an upload finishing in between kept its file (review,
  // 2026-09-26).
  await store.deleteProfile(id);
  // The files go whatever happens to the cancel; a cancel that failed is
  // reported (nothing can be delivered without the row either way).
  let cancelled = 0;
  let cancelFailed = false;
  try {
    cancelled = await notes.cancelForUser(id, "identity deleted");
  } catch (e) {
    cancelFailed = true;
    console.error("avatar-profile delete:", e.message);
  }
  const files =
    (await media.deletePrefix(`identity/${id}/`).catch(() => 0)) +
    (await notes.deleteOutputsFor(id).catch(() => 0));
  audit.record(id, "avatar.deleted",
    `identity video and ${files} file(s) deleted` +
      (cancelled ? `, ${cancelled} waiting note(s) cancelled` : "")).catch(() => {});
  if (cancelFailed) return res.status(500).json({ error: "that didn't finish — try again" });
  res.json({ ok: true });
});

router.post("/video", uploadLimit, requireConsent, receiver(VIDEO_MAX), async (req, res) => {
  const id = uid(req, res);
  if (id === null) return drop(req);
  const f = req.file;
  try {
    if (!f) return res.status(400).json({ error: "a video file is required" });
    const ext = VIDEO_MIME[String(f.mimetype || "").toLowerCase()];
    if (!ext) return res.status(400).json({ error: "the video must be MP4 or MOV" });
    const durationMs = Math.round(Number(req.body?.duration_ms));
    if (!Number.isFinite(durationMs) || durationMs < MIN_MS || durationMs > MAX_MS) {
      return res.status(400).json({
        error: `the video must be between ${MIN_MS / 1000} and ${MAX_MS / 1000} seconds long`,
      });
    }
    const sv = Number(req.body?.script_version);
    const scriptVersion = Number.isInteger(sv) && sv >= 0 && sv < 100000 ? sv : 0;
    if (!(await looksLikeVideo(f.path))) {
      return res.status(400).json({ error: "that file is not a video" });
    }

    const videoId = media.newId();
    const key = `identity/${id}/video-${videoId}${ext}`;
    const put = await media.put(key, { path: f.path });
    let saved;
    try {
      // Consent is read again under the row lock (it may have been
      // withdrawn while the upload ran) and nothing is committed without
      // it; this file is then the only thing to take back.
      saved = await store.setVideo(id, {
        key, id: videoId, mime: f.mimetype, bytes: put.bytes, durationMs, scriptVersion,
      });
    } catch (e) {
      await media.delete(key).catch(() => {});
      throw e;
    }
    // After the commit: the old take is not referenced any more.
    if (saved.prevKey && saved.prevKey !== key && media.isKey(saved.prevKey)) {
      await media.delete(saved.prevKey).catch(() => {});
    }
    audit.record(id, "avatar.video.saved",
      `${Math.round(durationMs / 1000)} s identity video (${Math.round(put.bytes / 1024)} kB)` +
        (saved.prevKey ? ", replacing the previous one" : "")).catch(() => {});
    res.json({ ok: true, video: store.toClient(saved.row).video });
  } catch (e) {
    if (e.http === 403) return res.status(403).json({ error: "consent_required" });
    console.error("avatar-profile video:", e.stack || e.message);
    res.status(500).json({ error: "the video could not be saved — try again" });
  } finally {
    drop(req);
  }
});

/**
 * The photo and the voice sample builds <= 117 still send. Stored like
 * the video, under the same identity/<uid>/ prefix, so Delete everything
 * and the account eraser find them too.
 */
function legacyUpload(kind, types, maxBytes) {
  return [uploadLimit, requireConsent, receiver(maxBytes), async (req, res) => {
    const id = uid(req, res);
    if (id === null) return drop(req);
    const f = req.file;
    try {
      if (!f) return res.status(400).json({ error: "a file is required" });
      const mime = String(f.mimetype || "").toLowerCase();
      const ext = types[mime] ||
        (kind === "face" && mime.startsWith("image/") ? ".img" : null) ||
        (kind === "voice" && mime.startsWith("audio/") ? ".audio" : null);
      if (!ext) return res.status(400).json({ error: `unsupported file type ${mime}` });
      const key = `identity/${id}/${kind}-${media.newId()}${ext}`;
      await media.put(key, { path: f.path });
      // Refused (403) when consent went, or the row did, mid-upload — and
      // then this file is deleted rather than left with nothing pointing at it.
      const prev = await store.setAsset(id, kind, key).catch(async (e) => {
        await media.delete(key).catch(() => {});
        throw e;
      });
      if (prev && prev !== key && media.isKey(prev)) await media.delete(prev).catch(() => {});
      audit.record(id, `avatar.${kind}.saved`, `${kind === "face" ? "photo" : "voice sample"} saved`)
        .catch(() => {});
      res.json({ ok: true });
    } catch (e) {
      if (e.http === 403) return res.status(403).json({ error: "consent_required" });
      console.error(`avatar-profile ${kind}:`, e.stack || e.message);
      res.status(500).json({ error: "that could not be saved — try again" });
    } finally {
      drop(req);
    }
  }];
}

router.post("/face", ...legacyUpload("face", FACE_MIME, 18 * MB));
router.post("/voice", ...legacyUpload("voice", VOICE_MIME, 20 * MB));

module.exports = router;
module.exports.MIN_MS = MIN_MS;
module.exports.MAX_MS = MAX_MS;
module.exports.VIDEO_MAX = VIDEO_MAX;
