/**
 * MEETING ROUTES (all behind appAuth).
 *
 *   POST /meetings                 { transcript, title?, participants?, client_id?, duration_s? }
 *   POST /meetings/audio           multipart audio -> transcribed here, then analysed
 *   POST /meetings/record          a whole recording of any length -> 202 {id};
 *                                  minutes follow in the background + a push
 *   GET  /meetings                 recent meetings with their action items
 *   GET  /meetings/:id             one meeting, including the full transcript
 *   GET  /meetings/:id/pdf         the minutes as a shareable PDF
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
const { tzFromReq } = require("../services/tz");
const multer = require("multer");
const meetings = require("./service");
const ai = require("../services/ai/router");
// Looked up at call time (not destructured) so tests can stub the model.
const transcribeAudio = (...a) => ai.transcribeAudio(...a);

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
  return tzFromReq(req);
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
    // transcribeAudio returns {text, language}. Calling .trim() on that
    // object threw, so this endpoint failed on every request.
    const text = (await transcribeAudio(req.file.buffer, req.file.mimetype,
      { timeoutMs: 90_000 }))?.text || "";
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
    const transcript = (await transcribeAudio(req.file.buffer, req.file.mimetype,
      { timeoutMs: 90_000 }))?.text || "";
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

/* ------------------------------------------------------------------ *
 * RECORD A WHOLE MEETING — the app's Meeting recorder.
 *
 * Owner's pick, 2026-09-23 ("Meeting recorder → minutes"). The app
 * uploads one compressed recording of any length; the meeting appears at
 * once as 'processing' and the minutes arrive a few minutes later with a
 * notification. Long audio is cut into 4-minute pieces with ffmpeg
 * (already in the image for video) so each transcription fits the
 * model's inline limit and time budget; the audio is deleted after.
 * ------------------------------------------------------------------ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const recUpload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      const ext = String(file.originalname || "").toLowerCase().match(/\.\w+$/)?.[0] || ".m4a";
      cb(null, `meeting-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  // ~3 hours of the app's 32 kbps AAC.
  limits: { fileSize: 150 * 1024 * 1024 },
});

const SEGMENT_S = 240;
const STT_MS = 90_000;
const INLINE_LIMIT = 14 * 1024 * 1024;

function mimeOf(file) {
  const ext = String(file).toLowerCase().match(/\.(\w+)$/)?.[1] || "";
  return { wav: "audio/wav", mp3: "audio/mpeg", aac: "audio/aac", ogg: "audio/ogg",
    amr: "audio/amr", "3gp": "audio/3gpp" }[ext] || "audio/mp4";
}

/** Cut a recording into SEGMENT_S pieces; [file] when ffmpeg can't. */
function splitAudio(file) {
  return new Promise((resolve) => {
    const ext = path.extname(file) || ".m4a";
    const base = file.slice(0, -ext.length) + "-part";
    execFile("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", file,
      "-f", "segment", "-segment_time", String(SEGMENT_S),
      "-reset_timestamps", "1", "-c", "copy", `${base}%03d${ext}`,
    ], { timeout: 120_000 }, (err) => {
      const dir = path.dirname(file);
      const prefix = path.basename(base);
      const parts = err ? [] : fs.readdirSync(dir)
        .filter((f) => f.startsWith(prefix))
        .sort()
        .map((f) => path.join(dir, f));
      resolve(parts.length ? parts : [file]);
    });
  });
}

async function processRecording(u, id, file, meta) {
  const parts = await splitAudio(file);
  const texts = [];
  let partial = false;
  try {
    for (const p of parts) {
      let buf = fs.readFileSync(p);
      if (buf.length > INLINE_LIMIT) { buf = buf.subarray(0, INLINE_LIMIT); partial = true; }
      const r = await transcribeAudio(buf, mimeOf(p), { timeoutMs: STT_MS }).catch(() => null);
      if (r?.text) texts.push(r.text.trim());
    }
  } finally {
    for (const p of new Set([file, ...parts])) fs.unlink(p, () => {});
  }
  let transcript = texts.join("\n").trim();
  if (transcript.length < 40) {
    await meetings.fail(u, id, "Couldn't make out enough speech in this recording.");
    return null;
  }
  if (partial) transcript += "\n[Part of the recording could not be transcribed.]";
  const out = await meetings.complete(u, id, { transcript, userName: meta.userName, tzOffsetMin: meta.tzOffsetMin });

  // Tell them the minutes are ready — they walked out of the meeting.
  try {
    const user = await require("../db").findById(u);
    if (user?.fcm_token && out) {
      const n = out.actions?.length || 0;
      await require("../services/push").sendNotification(
        user.fcm_token,
        "Meeting minutes ready",
        `${out.title}: ${n ? `${n} action item${n === 1 ? "" : "s"}` : "summary and decisions"} — tap to read.`,
        { kind: "meeting_minutes", id: String(id) }
      );
    }
  } catch (_) {}
  return out;
}

// One at a time: transcription holds audio in memory.
const _jobs = [];
let _busy = false;
function enqueue(job) {
  _jobs.push(job);
  if (_busy) return;
  _busy = true;
  (async () => {
    while (_jobs.length) {
      await _jobs.shift()().catch((e) => console.error("meeting: processing failed —", e.message));
    }
    _busy = false;
  })();
}

router.post("/record", recUpload.single("audio"), async (req, res) => {
  const u = uid(req);
  const file = req.file;
  const drop = () => file?.path && fs.unlink(file.path, () => {});
  if (!u) { drop(); return res.status(401).json({ error: "unauthorized" }); }
  if (!file || file.size < 16 * 1024) {
    drop();
    return res.status(400).json({ error: "the recording is too short" });
  }
  try {
    const id = await meetings.createPending(u, {
      title: req.body?.title,
      participants: req.body?.participants,
      clientId: Number(req.body?.client_id) || null,
      durationS: Number(req.body?.duration_s) || 0,
      tzOffsetMin: tz(req),
    });
    res.status(202).json({ id, status: "processing" });
    const meta = { userName: firstName(req), tzOffsetMin: tz(req) };
    enqueue(() => processRecording(u, id, file.path, meta).catch(async (e) => {
      console.error(`meeting #${id} failed —`, e.message);
      await meetings.fail(u, id).catch(() => {});
      drop();
    }));
  } catch (e) {
    drop();
    console.error("meeting record error:", e.message || e);
    if (!res.headersSent) res.status(500).json({ error: "could not save the recording" });
  }
});

/** The minutes as a PDF to share. */
router.get("/:id(\\d+)/pdf", async (req, res) => {
  const u = uid(req);
  if (!u) return res.status(401).json({ error: "unauthorized" });
  const m = await meetings.get(u, req.params.id).catch(() => null);
  if (!m) return res.status(404).json({ error: "not found" });
  if (m.status !== "done") return res.status(409).json({ error: "the minutes are not ready yet" });
  try {
    const docgen = require("../services/docgen");
    const when = new Date(Number(m.created_at) + tz(req) * 60_000);
    const dateLine = when.toLocaleDateString("en-IN", {
      weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    });
    const mins = Math.round((Number(m.duration_s) || 0) / 60);
    const sections = [
      { heading: "Details", bullets: [
        `Date: ${dateLine}`,
        ...(mins ? [`Duration: ${mins} min`] : []),
        ...(m.participants ? [`Participants: ${m.participants}`] : []),
      ] },
      ...(m.summary ? [{ heading: "Summary", paragraphs: [m.summary] }] : []),
      ...(m.decisions.length ? [{ heading: "Decisions", bullets: m.decisions }] : []),
      ...(m.actions.length ? [{
        heading: "Action items",
        table: {
          columns: ["Action", "Owner", "When"],
          rows: m.actions.map((a) => [a.text, a.owner || "", a.when || ""]),
        },
      }] : []),
      ...(m.follow_up ? [{ heading: "Follow-up message", paragraphs: [m.follow_up] }] : []),
    ];
    const spec = docgen.normalize("pdf", { title: `Minutes — ${m.title}`, sections });
    const buffer = await docgen.RENDER.pdf(spec, "#6366F1");
    const safe = String(m.title || "meeting").replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="minutes-${safe}.pdf"`);
    res.end(buffer);
  } catch (e) {
    console.error("meeting pdf error:", e.message || e);
    res.status(500).json({ error: "could not make the PDF" });
  }
});

router.get("/", async (req, res) => {
  const u = uid(req);
  if (!u) return res.status(401).json({ error: "unauthorized" });
  try {
    res.json({ meetings: await meetings.list(u, { limit: Math.min(Math.max(1, Number(req.query.limit) || 10), 200) }) });
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
