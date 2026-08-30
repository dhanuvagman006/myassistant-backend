/**
 * MEETING ROUTES (all behind appAuth).
 *
 *   POST /meetings                 { transcript, title?, participants?, client_id?, duration_s? }
 *   POST /meetings/audio           multipart audio -> transcribed here, then analysed
 *   GET  /meetings                 recent meetings with their action items
 *   GET  /meetings/:id             one meeting, including the full transcript
 *
 * Two entry points on purpose. A phone that already produced a transcript
 * should not pay to transcribe twice; a plain recording still has to work.
 *
 * SIZE: a meeting is long, and speech-to-text has request limits. The audio
 * route accepts a single chunk up to AUDIO_LIMIT and the app is expected to
 * send a long meeting as sequential chunks, appending to the transcript on
 * its side, then POST the assembled text here. That keeps the failure mode
 * visible ("this chunk didn't transcribe") rather than a silent truncation
 * halfway through an hour-long recording.
 */
const express = require("express");
const multer = require("multer");
const meetings = require("./service");
const { transcribeAudio } = require("../services/ai/router");

const AUDIO_LIMIT = 20 * 1024 * 1024; // 20 MB per chunk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AUDIO_LIMIT },
});

const router = express.Router();

function uid(req) {
  const n = Number(req.user?.sub);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function tz(req) {
  return Number(req.get("X-TZ-Offset")) || 330;
}
function firstName(req) {
  const n = req.user?.name;
  return n ? String(n).split(" ")[0] : "the user";
}

/** Analyse a transcript the app already has. */
router.post("/", async (req, res) => {
  const u = uid(req);
  if (!u) return res.status(401).json({ error: "unauthorized" });

  const transcript = String(req.body?.transcript || "").trim();
  if (transcript.length < 40) {
    return res.status(400).json({ error: "transcript too short to analyse" });
  }

  try {
    const out = await meetings.record(u, {
      transcript,
      title: req.body?.title,
      participants: req.body?.participants,
      clientId: Number(req.body?.client_id) || null,
      durationS: Number(req.body?.duration_s) || 0,
      userName: firstName(req),
      tzOffsetMin: tz(req),
    });
    res.status(201).json(out);
  } catch (e) {
    console.error("meeting analyse error:", e.message || e);
    res.status(502).json({ error: "could not analyse the meeting" });
  }
});

/** Transcribe one audio chunk. Returns text; does NOT store a meeting. */
router.post("/transcribe", upload.single("audio"), async (req, res) => {
  const u = uid(req);
  if (!u) return res.status(401).json({ error: "unauthorized" });
  if (!req.file?.buffer?.length) {
    return res.status(400).json({ error: "audio file required" });
  }
  try {
    const text = await transcribeAudio(req.file.buffer, req.file.mimetype);
    // An empty transcript is reported as empty, never as success with
    // nothing in it — the app needs to know the chunk failed so it can
    // retry that chunk rather than lose a slice of the meeting silently.
    if (!text || !text.trim()) {
      return res.status(422).json({ error: "no speech detected in this chunk" });
    }
    res.json({ text: text.trim() });
  } catch (e) {
    console.error("meeting transcribe error:", e.message || e);
    res.status(502).json({ error: "transcription failed" });
  }
});

/** Record a whole short meeting from one audio file. */
router.post("/audio", upload.single("audio"), async (req, res) => {
  const u = uid(req);
  if (!u) return res.status(401).json({ error: "unauthorized" });
  if (!req.file?.buffer?.length) {
    return res.status(400).json({ error: "audio file required" });
  }
  try {
    const transcript = await transcribeAudio(req.file.buffer, req.file.mimetype);
    if (!transcript || transcript.trim().length < 40) {
      return res.status(422).json({ error: "couldn't make out enough speech to analyse" });
    }
    const out = await meetings.record(u, {
      transcript: transcript.trim(),
      title: req.body?.title,
      participants: req.body?.participants,
      clientId: Number(req.body?.client_id) || null,
      durationS: Number(req.body?.duration_s) || 0,
      userName: firstName(req),
      tzOffsetMin: tz(req),
    });
    res.status(201).json(out);
  } catch (e) {
    console.error("meeting audio error:", e.message || e);
    res.status(502).json({ error: "could not process the recording" });
  }
});

router.get("/", async (req, res) => {
  const u = uid(req);
  if (!u) return res.status(401).json({ error: "unauthorized" });
  try {
    res.json({ meetings: await meetings.list(u, { limit: Number(req.query.limit) || 10 }) });
  } catch (e) {
    res.status(500).json({ error: "could not read meetings" });
  }
});

router.get("/:id", async (req, res) => {
  const u = uid(req);
  if (!u) return res.status(401).json({ error: "unauthorized" });
  try {
    const m = await meetings.get(u, req.params.id);
    if (!m) return res.status(404).json({ error: "not found" });
    res.json(m);
  } catch (e) {
    res.status(500).json({ error: "could not read meeting" });
  }
});

module.exports = router;
