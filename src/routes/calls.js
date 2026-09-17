/**
 * IN-APP DIALER — call analysis, history and recall.
 * ----------------------------------------------------------------------
 * The app is the phone's default dialer. When the user has AI call
 * analysis switched ON (explicit consent, stored with a timestamp), the
 * app records the call audio on-device and uploads it here when the call
 * ends. The server transcribes it, extracts anything actionable
 * (reminders, meetings, promises), files those into the user's real
 * agenda, and keeps ONLY the text. The audio is deleted the moment
 * transcription finishes — the disk on this box is nearly full and a
 * voice call is the most private thing a phone holds.
 *
 *   POST /calls/upload    multipart "audio" (wav) + fields  -> 202 {id}
 *   GET  /calls/recent    -> { calls: [...] }               (dialer list)
 *   GET  /calls/analysis  -> { enabled, consentAt }         (the toggle)
 *   POST /calls/analysis  { enabled } -> { enabled, consentAt }
 *
 * RECORDING REALITY (Android): a non-system app hears the user's side of
 * a SIM call clearly; the other party is audible only via the earpiece/
 * speaker bleed (clear on speakerphone). The transcription prompt knows
 * this, and nothing here pretends otherwise.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const multer = require("multer");

const db = require("../db");
const ai = require("../services/ai/router");
const reminders = require("../reminders/store");

const router = express.Router();

// Calls are long: an hour of 16 kHz mono PCM in a WAV is ~115 MB. Spool
// to disk, never RAM — the pod has little of either to spare, so the cap
// stays firm and the file is unlinked in every exit path.
const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      // Keep the real extension — it is how the pipeline knows wav (our
      // dialer) from m4a/amr (the phone's own recorder).
      const ext =
        String(file.originalname || "").toLowerCase().match(/\.\w+$/)?.[0] ||
        ".wav";
      cb(null,
        `call-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 130 * 1024 * 1024 },
});

// ---------------- consent toggle ----------------

const kvKey = (uid) => `call_analysis:${uid}`;

async function analysisState(uid) {
  const row = await db.one(`SELECT v FROM kv WHERE k = $1`, [kvKey(uid)]);
  if (!row) {
    // DEFAULT ON (owner's call, 2026-09-17): a fresh account starts with
    // analysis enabled — but consentAt stays 0 until the app has SHOWN
    // the sign-in notice and posted the decision. The watcher reads no
    // files while consentAt is 0, so "on by default" never means
    // "reading recordings nobody was told about".
    return { enabled: true, consentAt: 0 };
  }
  try {
    const v = JSON.parse(row.v || "{}");
    return { enabled: Boolean(v.enabled), consentAt: Number(v.consentAt) || 0 };
  } catch (_) {
    return { enabled: false, consentAt: 0 };
  }
}

router.get("/analysis", async (req, res) => {
  res.json(await analysisState(Number(req.user.sub)));
});

router.post("/analysis", async (req, res) => {
  const uid = Number(req.user.sub);
  const enabled = Boolean(req.body?.enabled);
  const prev = await analysisState(uid);
  // Consent is the FIRST enable's timestamp and survives toggling off —
  // it dates the user's standing agreement, not the switch position.
  const consentAt = enabled ? (prev.consentAt || Date.now()) : prev.consentAt;
  await db.run(
    `INSERT INTO kv (k, v) VALUES ($1, $2)
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [kvKey(uid), JSON.stringify({ enabled, consentAt })]
  );
  res.json({ enabled, consentAt });
});

// ---------------- history ----------------

router.get("/recent", async (req, res) => {
  const uid = Number(req.user.sub);
  const rows = await db.query(
    `SELECT id, direction, peer_number, peer_name, started_at, duration_s,
            summary, status
       FROM call_records WHERE user_id = $1
      ORDER BY started_at DESC LIMIT 30`,
    [uid]
  );
  res.json({ calls: rows });
});

// ---------------- upload + analysis pipeline ----------------

router.post("/upload", upload.single("audio"), async (req, res) => {
  const uid = Number(req.user.sub);
  const file = req.file;
  const clean = () => {
    if (file?.path) fs.unlink(file.path, () => {});
  };

  try {
    const state = await analysisState(uid);
    if (!state.enabled) {
      clean();
      return res.status(403).json({ error: "call analysis is switched off" });
    }
    if (!file || file.size < 32 * 1024) {
      // Under a second of audio — a misdial, nothing to analyse.
      clean();
      return res.status(400).json({ error: "no usable audio" });
    }

    const peerNumber = String(req.body?.peerNumber || "").slice(0, 24);
    const peerName = String(req.body?.peerName || "").slice(0, 120);
    const direction =
      req.body?.direction === "incoming" ? "incoming" : "outgoing";
    const startedAt = Number(req.body?.startedAtMs) || Date.now();
    const durationS = Number(req.body?.durationSec) || 0;

    const rec = await db.one(
      `INSERT INTO call_records
         (user_id, direction, peer_number, peer_name, started_at,
          duration_s, consent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [uid, direction, peerNumber, peerName, startedAt, durationS,
       state.consentAt]
    );

    // Answer NOW — the app must not hold a spinner through minutes of
    // transcription. The pipeline continues in the background and the
    // record's status tells the story.
    res.status(202).json({ id: rec.id });

    processCall(rec.id, uid, file.path, { peerName, peerNumber, startedAt })
      .catch((e) => {
        console.error(`calls: analysis of #${rec.id} failed —`, e.message);
        db.run(`UPDATE call_records SET status='failed' WHERE id=$1`,
          [rec.id]).catch(() => {});
      })
      .finally(clean);
  } catch (e) {
    clean();
    console.error("calls: upload failed —", e.message);
    if (!res.headersSent) res.status(500).json({ error: "upload failed" });
  }
});

/** Media type by extension — the system recorder saves m4a/amr/mp3. */
function mimeFor(name) {
  const ext = String(name || "").toLowerCase().match(/\.(\w+)$/)?.[1] || "";
  return {
    wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", mp3: "audio/mpeg",
    amr: "audio/amr", "3gp": "audio/3gpp", ogg: "audio/ogg",
  }[ext] || "audio/mp4";
}

/** Slice one mono 16-bit WAV file into playable WAV chunks of ~chunkSec. */
function wavChunks(filePath, chunkSec = 180) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") {
    return [buf]; // not a WAV we recognise — try it whole
  }
  const sampleRate = buf.readUInt32LE(24);
  const byteRate = buf.readUInt32LE(28) || sampleRate * 2;
  // Find the data chunk (headers can carry LIST/INFO blocks before it).
  let off = 12;
  let dataStart = 44, dataLen = buf.length - 44;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === "data") { dataStart = off + 8; dataLen = Math.min(len, buf.length - dataStart); break; }
    off += 8 + len + (len % 2);
  }
  const header = buf.subarray(0, dataStart);
  const step = byteRate * chunkSec;
  const out = [];
  for (let p = dataStart; p < dataStart + dataLen; p += step) {
    const piece = buf.subarray(p, Math.min(p + step, dataStart + dataLen));
    const h = Buffer.from(header);
    h.writeUInt32LE(36 + piece.length, 4);        // RIFF size
    h.writeUInt32LE(piece.length, dataStart - 4); // data size
    out.push(Buffer.concat([h, piece]));
  }
  return out.length ? out : [buf];
}

async function processCall(id, uid, filePath, meta) {
  // 1. TRANSCRIBE, within the model's inline-size limit. WAV (our own
  // dialer's recording) is sliced losslessly; compressed formats from the
  // phone's system recorder can't be cut mid-stream, so oversize ones are
  // transcribed up to the limit and honestly marked as partial.
  const mime = mimeFor(filePath);
  const parts = [];
  let partial = false;
  const LIMIT = 14 * 1024 * 1024; // inline request budget, base64 included
  if (mime === "audio/wav") {
    for (const chunk of wavChunks(filePath)) {
      const r = await ai.transcribeAudio(chunk, mime).catch(() => null);
      if (r?.text) parts.push(r.text.trim());
    }
  } else {
    let buf = fs.readFileSync(filePath);
    if (buf.length > LIMIT) { buf = buf.subarray(0, LIMIT); partial = true; }
    const r = await ai.transcribeAudio(buf, mime).catch(() => null);
    if (r?.text) parts.push(r.text.trim());
  }
  let transcript = parts.join("\n").trim();
  if (transcript && partial) {
    transcript += "\n[Recording was longer than could be analysed — this transcript covers the first part of the call.]";
  }

  if (!transcript) {
    await db.run(
      `UPDATE call_records SET status='done',
              summary='No clear speech was picked up on this call.'
        WHERE id=$1`, [id]);
    return;
  }

  // 2. UNDERSTAND. One structured pass: summary + anything actionable.
  const user = await db.findById(uid).catch(() => null);
  const when = new Date(meta.startedAt).toString();
  const prompt =
    `This is the transcript of a real phone call, recorded from the ` +
    `phone owner's side (the other person may be faint or missing — ` +
    `never invent what they said). Phone owner: ${user?.name || "the user"}. ` +
    `Other party: ${meta.peerName || meta.peerNumber || "unknown"}. ` +
    `Call started: ${when}.\n\nTRANSCRIPT:\n${transcript.slice(0, 24000)}\n\n` +
    `Reply with STRICT JSON only, no markdown fences:\n` +
    `{"summary":"<2-3 sentences, plain language>",` +
    `"items":[{"kind":"reminder|meeting|task|promise","text":"<what>",` +
    `"whenIso":"<ISO 8601 with timezone offset, or empty if no time was agreed>"}]}\n` +
    `kind guide: meeting = a time two people agreed to meet or talk; ` +
    `promise = something the phone owner committed to do for the other ` +
    `person; task = work the owner has to do; reminder = anything else ` +
    `worth surfacing at a time. ` +
    `Only include items the call ACTUALLY agreed on. No item is fine.`;

  const { reply } = await ai.generateReply(
    [{ role: "user", content: prompt }],
    { system: "You extract structured facts from call transcripts. JSON only." }
  );

  let summary = "";
  let items = [];
  try {
    const j = JSON.parse(String(reply).replace(/^```json?\s*|```\s*$/g, ""));
    summary = String(j.summary || "").slice(0, 1000);
    if (Array.isArray(j.items)) items = j.items.slice(0, 10);
  } catch (_) {
    summary = String(reply).slice(0, 500);
  }

  // 3. FILE THE ACTIONS where the app already looks for them: meetings,
  // tasks and reminders into the reminders store (the brief, the alarms
  // and the home agenda all read it); promises into the commitments
  // store, which is the "Promises you made" section and its nudges.
  const filed = [];
  for (const it of items) {
    const text = String(it?.text || "").trim();
    if (!text) continue;
    if (it.kind === "promise") {
      const who = meta.peerName || meta.peerNumber || "";
      const saved = await require("../commitments/service")
        .extract(uid, `I promised ${who ? who + " " : ""}on a phone call: ${text}` +
          (it.whenIso ? ` (by ${it.whenIso})` : ""), { source: "call" })
        .catch(() => []);
      for (const s of saved) {
        filed.push({ kind: "promise", text: s.text, dueAt: s.due_at ?? null });
      }
      continue;
    }
    const label = it.kind === "meeting" ? `Meeting: ${text}` : text;
    let dueAt = null;
    const t = Date.parse(String(it?.whenIso || ""));
    if (Number.isFinite(t) && t > Date.now() - 60_000) dueAt = t;
    const made = await reminders
      .create(uid, label, dueAt, "gentle")
      .catch(() => null);
    if (made) filed.push({ kind: it.kind || "reminder", text: label, dueAt });
  }

  await db.run(
    `UPDATE call_records
        SET transcript=$1, summary=$2, actions=$3, status='done'
      WHERE id=$4`,
    [transcript.slice(0, 100000), summary, JSON.stringify(filed), id]
  );

  // 4. Tell the user their call was understood — EVERY time. Silence
  // after an analysed call read as "the feature did nothing"; the whole
  // point of automatic analysis is that the user never has to ask.
  if (user?.fcm_token) {
    const n = filed.length;
    const withWho = meta.peerName ? `with ${meta.peerName} ` : "";
    const body = n
      ? `${n} item${n === 1 ? "" : "s"} from your call ${withWho}added to your agenda.`
      : `Your call ${withWho}was noted: ${summary.slice(0, 120)}`;
    require("../services/push")
      .sendNotification(user.fcm_token, "Call notes ready", body,
        { kind: "call_analysis" })
      .catch(() => {});
  }
}

module.exports = { router };
