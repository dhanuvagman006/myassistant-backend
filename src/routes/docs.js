/**
 * DOCUMENT ROUTES (all behind appAuth) — "save it so Hari remembers".
 *
 *   POST   /docs            multipart {file, note?} → analyzed + stored
 *   GET    /docs            → { documents: [...] }
 *   GET    /docs/:id/file   → the original bytes (image/PDF), auth required
 *   PATCH  /docs/:id        { note } → update the user's spoken note
 *   DELETE /docs/:id        → { ok }
 *
 * Upload flow: file is written to disk FIRST (the save can never be lost
 * to an AI hiccup), then one Gemini call fills title/summary/date/tags.
 * happened even before any document search runs.
 */
const router = require("express").Router();
const multer = require("multer");
const fs = require("fs");
const db = require("../db");
const docs = require("../docs/store");
const { analyzeDocument } = require("../docs/analyze");
const intelligence = require("../docs/intelligence");
const audit = require("../audit/log");
// BUGFIX (Aug 2026): `memory` was used below but never required — every
// DELETE /docs/:id threw ReferenceError, and the post-analysis memory
// fact silently never landed.
const memory = require("../agents/memory");
const clients = require("../clients/store");
const outcomes = require("../outcomes/store");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 18 * 1024 * 1024 },
});
const OK_MIME = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

function uid(req, res) {
  let sub = req.user?.sub;
  if (sub === "anonymous-dev") sub = 0;
  const id = Number(sub);
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json({ error: "documents require a signed-in account" });
    return null;
  }
  return id;
}

/** Analyze + attach metadata — shared by fresh
 *  uploads and the lazy healing pass below. Never throws. */
async function analyzeInBackground(userId, row, buffer, mime) {
  try {
    const meta = await analyzeDocument(buffer, mime);
    if (!meta) return;
    const updated = (await docs.setMetadata(userId, row.id, meta)) || row;

    // CHUNK + EMBED the extracted text so "find Ravi's court notice" can
    // search inside the document, not just its title. Failure here must not
    // lose the document itself, so it is caught separately.
    try {
      const text = updated.full_text || meta.fullText || "";
      if (text) {
        // QUEUED, not inline: chunking + embedding a long PDF must never
        // sit in front of the user's next voice turn (§25).
        await require("../infra/jobs").enqueue(
          "document.index",
          { userId, documentId: row.id, text },
          { userId }
        );
      }
    } catch (e) {
      console.error("docs indexing enqueue failed (document kept):", e.message);
    }
    // A one-line durable fact ("context") so plain chat — with no document
    // search at all — still knows about the visit/purchase. Title + date
    // ONLY: the note/summary live on the document row and are injected by
    // doc search when relevant — duplicating them here made the AI read
    // the same content twice in recall answers.
    const when = meta.docDate || new Date().toISOString().slice(0, 10);
    await memory.saveMemory(
      userId,
      `Saved a ${updated.category || "document"}: "${updated.title}" dated ${when}`,
      1 // minor context fact — first to be evicted when memory is full
    );

    // UNDERSTAND, DON'T JUST FILE. A shared timetable or invite carries
    // OBLIGATIONS — the user should never have to say "now set reminders
    // from that image". Extract every dated commitment, file each as a
    // reminder, record the verdict on the row (the app reads it to mirror
    // events into the phone's calendar), and tell the user what happened.
    await understandDocument(userId, updated).catch((e) =>
      console.error("docs understanding failed (document kept):", e.message));
  } catch (e) {
    console.error("docs background analyze:", e.message);
  }
}

async function understandDocument(userId, doc) {
  const text = String(doc.full_text || "").trim();
  if (!text) {
    await db.run(
      `UPDATE documents SET understanding=$1 WHERE id=$2 AND user_id=$3`,
      [JSON.stringify({ kind: "other", events: [], remindersSet: 0 }),
       doc.id, userId]);
    return;
  }
  const { generateReply } = require("../services/ai/router");
  const now = new Date().toString();
  const prompt =
    `A user shared this document into their personal-assistant app. ` +
    `Title: "${doc.title}". Category: ${doc.category}. Today is ${now} ` +
    `(IST). Document text:\n${text.slice(0, 12000)}\n\n` +
    `Reply STRICT JSON, no fences:\n` +
    `{"kind":"timetable|meeting|invite|deadline|legal|other",` +
    `"events":[{"title":"<short, e.g. 'Maths exam' or 'Meeting with Rao'>",` +
    `"whenIso":"<ISO 8601 with +05:30 offset; empty if truly undated>"}]}\n` +
    `events = every FUTURE dated commitment this document puts on the ` +
    `user: exam slots, class times for the coming week, a meeting, a ` +
    `hearing date, a payment due date. Nothing from the past, nothing ` +
    `invented, at most 15. A legal contract or ID with no future date ` +
    `has kind "legal" or "other" and an empty list.`;
  let kind = "other";
  let events = [];
  try {
    const { reply } = await generateReply(
      [{ role: "user", content: prompt }],
      { system: "You extract structured obligations from documents. JSON only." }
    );
    const j = JSON.parse(String(reply).replace(/^```json?\s*|```\s*$/g, ""));
    kind = String(j.kind || "other");
    if (Array.isArray(j.events)) events = j.events.slice(0, 15);
  } catch (e) {
    console.error("docs understanding parse failed:", e.message);
  }

  const reminders = require("../reminders/store");
  const filed = [];
  for (const ev of events) {
    const title = String(ev?.title || "").trim();
    const t = Date.parse(String(ev?.whenIso || ""));
    if (!title || !Number.isFinite(t) || t < Date.now() - 60_000) continue;
    const made = await reminders
      .create(userId, title, t, "gentle")
      .catch(() => null);
    if (made) filed.push({ title, atMs: t });
  }

  await db.run(
    `UPDATE documents SET understanding=$1 WHERE id=$2 AND user_id=$3`,
    [JSON.stringify({ kind, events: filed, remindersSet: filed.length }),
     doc.id, userId]);

  // The user hears the OUTCOME, unprompted — that is the whole feature.
  try {
    const user = await db.findById(userId);
    if (user?.fcm_token) {
      const body = filed.length
        ? `${filed.length} reminder${filed.length === 1 ? "" : "s"} set from "${doc.title}".`
        : `"${doc.title}" saved — ask me about it any time.`;
      await require("../services/push").sendNotification(
        user.fcm_token, "Document understood", body, { kind: "doc_understood" });
    }
  } catch (_) {}
}

// The app polls this after a share to mirror extracted events into the
// phone's own calendar. `ready` flips once background analysis finished.
router.get("/:id(\\d+)/understanding", async (req, res) => {
  const uid = Number(req.user.sub);
  const row = await db.one(
    `SELECT id, title, understanding FROM documents
      WHERE id=$1 AND user_id=$2`,
    [Number(req.params.id), uid]);
  if (!row) return res.status(404).json({ error: "unknown document" });
  if (!row.understanding) return res.json({ ready: false });
  try {
    return res.json({ ready: true, title: row.title,
      ...JSON.parse(row.understanding) });
  } catch (_) {
    return res.json({ ready: true, title: row.title, kind: "other",
      events: [], remindersSet: 0 });
  }
});

// One attempt per document per server boot — a doc that failed analysis
// (key missing at the time, quota, junk output) is retried when it's next
// listed, but a persistently broken setup can't hammer Gemini in a loop.
const healAttempted = new Set();

router.post(
  "/",
  upload.single("file"),
  async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const f = req.file;
  if (!f || !f.buffer?.length) return res.status(400).json({ error: "file required" });
  if (!OK_MIME.has(f.mimetype)) return res.status(415).json({ error: `unsupported type ${f.mimetype}` });

  // PROFESSIONAL MODE: WHERE does this document belong? Decided BEFORE the
  // file is written so a document can never land in the wrong area:
  //  • explicit — the app sent clientId (upload from a case-file screen, or
  //    the agent resolved the patient first). Unknown id → 404, NOTHING is
  //    saved (silently falling back to "My Documents" is how a patient's
  //    report ended up in the user's own folder).
  //  • person   — the agent/capture flow named whose document it is. Matched
  //    against the user's REAL clients only; a confident, unambiguous hit
  //    files it there. No match → it stays a personal document and the
  //    response says so honestly (no placeholder patient is ever created).
  //  • note     — legacy: the spoken save-note names a known client.
  let targetClient = null;
  let clientCandidates = null; // names when the person was ambiguous
  const explicit = Number(req.body.clientId);
  if (Number.isInteger(explicit) && explicit > 0) {
    targetClient = await clients.getClient(id, explicit);
    if (!targetClient) return res.status(404).json({ error: "client not found — nothing was saved" });
  } else {
    const spoken = String(req.body.person || "").trim() || String(req.body.note || "").trim();
    if (spoken) {
      try {
        const r = await clients.resolveByName(id, spoken);
        if (r.client) targetClient = r.client;
        else if (r.ambiguous) clientCandidates = r.ambiguous.map((c) => ({ id: c.id, name: c.name }));
      } catch (e) {
        console.warn("docs client resolve skipped:", e.message);
      }
    }
  }

  let row;
  try {
    row = await docs.createDocument(id, {
      buffer: f.buffer,
      filename: f.originalname,
      mime: f.mimetype,
      note: req.body.note,
    });
  } catch (e) {
    if (e.code === "DOC_LIMIT") {
      outcomes.create(id, { kind: "document", target: "", detail: f.originalname || "", status: "failed" })
        .then((r) => r && outcomes.update(id, r.id, { status: "failed", reason: "document limit reached" })).catch(() => {});
      return res.status(409).json({ error: e.message });
    }
    console.error("docs create failed:", e.message);
    return res.status(500).json({ error: "could not save the document" });
  }

  let linkedClient = null;
  if (targetClient) {
    if (await clients.linkDocument(id, row.id, targetClient.id)) {
      linkedClient = targetClient;
    } else {
      // The link is the whole point of a case-file upload — if it cannot
      // be made the save must not be reported as one. Roll back.
      await docs.deleteDocument(id, row.id).catch(() => {});
      return res.status(500).json({ error: "could not file the document under that client" });
    }
  }

  // MEMORY-PEOPLE link. The voice tools (lookup_person, find_document,
  // list_person_documents) read the memory 'people' store, which is a
  // DIFFERENT store from clients — a doc filed only under a client was
  // invisible to "show me Prasant's records" by voice. When the capture
  // flow names the person, link there too; associate() upserts the person
  // so this works even before any "Prasant is my patient" turn.
  let linkedPerson = null;
  try {
    const person = String(req.body.person || "").trim();
    if (person) {
      const out = await intelligence.associate(id, row.id, { person });
      linkedPerson = out.person || null;
    }
  } catch (e) {
    console.warn("docs person-link skipped:", e.message);
  }

  // Respond the moment the file is safely on disk — a voice "save this
  // receipt" must not hold the conversation hostage to a slow AI call.
  // Analysis (title/summary/tags + the memory fact) completes in the
  // background and shows up on the next GET /docs.
  // Re-read so the app gets the row WITH client_id — the truth of where it
  // was filed, straight from the database, not an optimistic echo.
  const saved = (await docs.getDocument(id, row.id)) || row;
  res.json({
    ok: true,
    document: docs.toClient(saved),
    analyzed: false,
    // Filing confirmation for the app ("Saved to Ramesh's file").
    filedUnder: linkedClient ? "client" : "personal",
    client: linkedClient ? { id: linkedClient.id, name: linkedClient.name } : null,
    clientCandidates,
    person: linkedPerson,
  });
  outcomes.create(id, {
    kind: "document",
    target: linkedClient ? linkedClient.name : "My documents",
    detail: linkedClient ? `filed under ${linkedClient.name}` : "saved to My documents",
    status: "completed",
  }).catch(() => {});
  audit.record(
    id,
    "document.saved",
    (f.originalname || `document #${row.id}`) +
      (linkedClient ? ` → filed under "${linkedClient.name}"` : "")
  );

  healAttempted.add(row.id);
  await analyzeInBackground(id, row, f.buffer, f.mimetype);
});

// GET /docs?scope=personal|clients|all — the app's "My Documents" screen
// asks for `personal` (documents NOT filed under any client). Default is
// `all` so existing/other consumers keep seeing everything.
router.get("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const scope = ["personal", "clients", "all"].includes(req.query.scope) ? req.query.scope : "all";
  const rows = await docs.listDocuments(id, 500, scope);
  res.json({ documents: rows.map(docs.toClient), scope });

  // SELF-HEAL: docs whose analysis never landed (saved while the Gemini
  // key was missing or broken) OR that were analyzed before full-text
  // extraction existed get another background attempt now.
  if (!process.env.GEMINI_API_KEY) return;
  for (const row of rows) {
    if ((row.title && row.full_text) || healAttempted.has(row.id)) continue;
    healAttempted.add(row.id);
    fs.promises
      .readFile(row.path)
      .then((buf) => analyzeInBackground(id, row, buf, row.mime))
      .catch((e) => console.error("docs heal read:", e.message));
  }
});

router.get("/:id/file", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const row = await docs.getDocument(id, Number(req.params.id));
  if (!row || !fs.existsSync(row.path)) return res.status(404).json({ error: "not found" });
  res.setHeader("Content-Type", row.mime);
  res.setHeader("Cache-Control", "private, max-age=86400"); // immutable per id
  fs.createReadStream(row.path).pipe(res);
});

router.patch("/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const ok = await docs.setNote(id, Number(req.params.id), req.body?.note);
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "not found" });
});

router.delete("/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const docId = Number(req.params.id);
  // Read the row BEFORE deletion — the title identifies the context fact.
  const row = await docs.getDocument(id, docId);
  const ok = await docs.deleteDocument(id, docId);
  if (ok) {
    if (row?.title) {
      await memory.deleteFactsContaining(id, `"${row.title}"`).catch(() => {});
    }
    audit.record(id, "document.deleted", `document #${docId} and its memory fact`);
  }
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "not found" });
});

// Multer's size-limit error otherwise falls through to the generic 500.
router.use((err, _req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "file too large — the limit is 18 MB" });
  }
  next(err);
});

module.exports = router;
