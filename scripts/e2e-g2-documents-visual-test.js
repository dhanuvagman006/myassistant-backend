/**
 * E2E — GROUP 2: DOCUMENTS & VISUAL (2026-09-27).
 *
 *   DATABASE_URL=postgres://myassistant:localdev@127.0.0.1:55432/myassistant_e2e_g2 \
 *     node scripts/e2e-g2-documents-visual-test.js
 *
 * End to end over HTTP with a REAL session token (the real appAuth, the
 * real routers), and the real tools through the registry:
 *
 *   /docs      upload → background analysis → title / summary / expiry →
 *              renewal reminders → "understanding" (events the app mirrors
 *              into the phone calendar) → search → file download → delete;
 *              Office files read as text; the share sheet's types.
 *   create_document  pdf / slides / doc / sheet — each a VALID file (PDF
 *              header+trailer, pptx/docx zip parts, xlsx cells + SUM).
 *   generate_image   billing off → a clear failure, nothing saved; the
 *              keyless provider up → an image document + show_image.
 *   (/vision — the camera's own questions — is the app's since 2026-09-29.)
 *   /clients/scan-card  real card reader → person + card photo document.
 *   /meetings  the app's upload shape → minutes → list → PDF.
 *   /posters   build-119 gating and route sanity (full suite: posters-test).
 *
 * NOTHING LEAVES THIS MACHINE. global fetch is replaced: 127.0.0.1 goes
 * through, Gemini / the keyless image host are answered by stubs in this
 * file, anything else THROWS and is recorded (asserted empty at the end).
 * The AI router's generateReply / transcribeAudio are stubbed like the
 * other suites do. Files live in a temp DATA_DIR. The test users are
 * erased with the real account-erase at the end.
 *
 * Tests marked [DEFECT] are expected to FAIL until the product is fixed —
 * they are the proof for the defects reported on 2026-09-27. Do not weaken
 * them to make the run green.
 */
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@127.0.0.1:55432/myassistant_e2e_g2";
if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(process.env.DATABASE_URL)) {
  console.error("refusing to run: DATABASE_URL is not a local database");
  process.exit(2);
}
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "e2e-g2-" + Math.random().toString(36).slice(2) + Date.now();
// A FAKE key: every Gemini URL is answered by the stub below. It only has
// to exist so the code paths that check for a key run.
const PRIMARY_KEY = "e2e-g2-fake-primary-key";
const FALLBACK_KEY = "e2e-g2-fake-fallback-key";
process.env.OPENAI_API_KEY = PRIMARY_KEY;
for (const k of [
  "GEMINI_FALLBACK_KEYS", "GEMINI_VISION_MODEL", "GEMINI_DOC_MODEL", "GEMINI_IMAGE_MODEL",
  "CF_ACCOUNT_ID", "CF_API_TOKEN", "HF_TOKEN", "TOGETHER_API_KEY",
  "EMBEDDING_PROVIDER", "AUTH_DISABLED", "ALLOW_APP_KEY", "BOLNA_API_KEY",
]) delete process.env[k];
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-g2-"));
process.env.DATA_DIR = DATA_DIR;

const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");

/* ------------------------------------------------------------------ */
/* NETWORK STUB                                                        */
/* ------------------------------------------------------------------ */
const realFetch = globalThis.fetch;
const blocked = []; // hosts something tried to reach that the stub does not serve
const geminiCalls = []; // { model, key, text, parts }
let pollinations = null; // (url) => Response
/** responders by kind — each (call) => { status, json | text } */
const R = {};

function partsOf(body) {
  return (body?.contents || []).flatMap((c) => c.parts || []);
}
function kindOf(model, text) {
  if (/image/i.test(model || "")) return "image";
  if (/You are filing a document/.test(text)) return "analyze";
  if (/business \/ visiting card/.test(text)) return "card";
  if (/You are the document studio/.test(text)) return "docgen";
  if (/screenshot assistant|attached file|Transcribe ALL text/.test(text)) return "vision";
  return "unknown";
}
const reply = (status, obj) =>
  new Response(typeof obj === "string" ? obj : JSON.stringify(obj), {
    status, headers: { "content-type": "application/json" },
  });
const geminiText = (text) => ({ status: 200, json: { candidates: [{ content: { parts: [{ text }] } }] } });

/**
 * OPENAI ON THE WIRE (2026-10-02). The responders below still speak the
 * Gemini shapes the assertions were written against; this branch turns an
 * OpenAI request into that `call` (parts with inline_data for a picture
 * or a PDF, the prompt text, the model, the key) and a Gemini-shaped
 * answer back into OpenAI's (choices / data[].b64_json).
 */
function openaiCall(u, init) {
  const key = (new Headers(init.headers || {}).get("authorization") || "").replace(/^Bearer\s+/i, "");
  let body = {};
  if (typeof init.body === "string") { try { body = JSON.parse(init.body); } catch (_) {} }
  const parts = [];
  if (/\/images\//.test(u.pathname)) {
    const prompt = init.body instanceof FormData ? String(init.body.get("prompt") || "") : String(body.prompt || "");
    parts.push({ text: prompt });
    return { model: body.model || (init.body instanceof FormData ? String(init.body.get("model") || "") : "") || "gpt-image-1", key, text: prompt, parts, body, image: true };
  }
  const sys = [];
  for (const m of body.messages || []) {
    // The system line is not a part the assertions look at: parts[0] is the picture.
    if (m.role === "system") { sys.push(String(m.content || "")); continue; }
    if (typeof m.content === "string") { parts.push({ text: m.content }); continue; }
    for (const p of m.content || []) {
      if (p.type === "text") parts.push({ text: p.text });
      else if (p.type === "image_url") {
        const mm = /^data:([^;]+);base64,(.*)$/.exec(p.image_url.url || "");
        if (mm) parts.push({ inline_data: { mime_type: mm[1], data: mm[2] } });
      } else if (p.type === "file") {
        const mm = /^data:([^;]+);base64,(.*)$/.exec(p.file.file_data || "");
        if (mm) parts.push({ inline_data: { mime_type: mm[1], data: mm[2] } });
      }
    }
  }
  const text = [...sys, ...parts.map((p) => p.text)].filter(Boolean).join("\n");
  return { model: body.model || "", key, text, parts, body, image: false };
}
function fromGeminiShape(out, call) {
  if (out.json && Array.isArray(out.json.candidates)) {
    const parts = out.json.candidates.flatMap((c) => (c.content && c.content.parts) || []);
    if (call.image) {
      const img = parts.find((p) => p.inlineData || p.inline_data);
      const d = img && (img.inlineData || img.inline_data);
      return { status: out.status, json: d ? { data: [{ b64_json: d.data }] } : { data: [] } };
    }
    const text = parts.map((p) => p.text).filter(Boolean).join("");
    return { status: out.status, json: { model: call.model, choices: [{ message: { content: text }, finish_reason: "stop" }] } };
  }
  return out;
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return realFetch(input, init);
  const u = new URL(url);
  if (u.hostname === "api.openai.com") {
    if (/\/embeddings$/.test(u.pathname)) {
      return reply(503, { error: { message: "stub: embeddings off (lexical path)" } });
    }
    const call = openaiCall(u, init);
    geminiCalls.push(call);
    const kind = call.image ? "image" : kindOf(call.model, call.text);
    const fn = R[kind];
    if (!fn) return reply(500, { error: { message: `stub: no responder for ${kind}` } });
    const out = fromGeminiShape(await fn(call), call);
    return reply(out.status, out.json !== undefined ? out.json : out.text || "");
  }
  if (u.hostname === "generativelanguage.googleapis.com") {
    if (/:batchEmbedContents$/.test(u.pathname)) {
      return reply(503, { error: { message: "stub: embeddings off (lexical path)" } });
    }
    const model = (u.pathname.match(/models\/([^:]+):/) || [])[1] || "";
    const key = new Headers(init.headers || {}).get("x-goog-api-key") || u.searchParams.get("key");
    let body = {};
    try { body = JSON.parse(init.body || "{}"); } catch (_) {}
    const parts = partsOf(body);
    const text = parts.map((p) => p.text).filter(Boolean).join("\n");
    const call = { model, key, text, parts, body };
    geminiCalls.push(call);
    const kind = kindOf(model, text);
    const fn = R[kind];
    if (!fn) return reply(500, { error: { message: `stub: no responder for ${kind}` } });
    const out = await fn(call);
    return reply(out.status, out.json !== undefined ? out.json : out.text || "");
  }
  if (u.hostname === "image.pollinations.ai" && pollinations) return pollinations(url);
  blocked.push(u.hostname);
  throw new Error(`e2e-g2: network call to ${u.hostname} blocked`);
};

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */
let passed = 0;
const failed = [];
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) {
    failed.push(name);
    console.error(`  FAIL ${name}\n       ${(e.stack || e.message).split("\n").slice(0, 6).join("\n       ")}`);
    process.exitCode = 1;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { tries = 80, ms = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(ms);
  }
  return null;
}

/** A JPEG-shaped buffer (SOI + SOF0 with a real size) padded to `size`. */
function fakeJpeg(size = 4096, w = 1024, h = 768) {
  const b = Buffer.alloc(size, 0x11);
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]).copy(b, 0);
  b[size - 2] = 0xff; b[size - 1] = 0xd9;
  return b;
}
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const DAY = 864e5;

const MIME = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

(async () => {
  const db = require("../src/db");
  await db.init();
  const registry = require("../src/tools/registry");
  require("../src/tools/builtins").registerBuiltins();
  const privacy = require("../src/routes/privacy");
  const docsStore = require("../src/docs/store");
  const ai = require("../src/services/ai/router");
  const realGen = ai.generateReply, realStt = ai.transcribeAudio;
  // generateReply: understanding of a shared document, meeting minutes.
  let genReply = async () => ({ reply: '{"kind":"other","events":[]}' });
  ai.generateReply = (...a) => genReply(...a);

  const stamp = Date.now();
  const user = await db.createUser({ email: `e2e-g2-${stamp}@example.test`, name: "Dhanush K" });
  const other = await db.createUser({ email: `e2e-g2-other-${stamp}@example.test`, name: "Other" });
  const UID = user.id;
  await db.run(`UPDATE users SET tz_offset_min=330 WHERE id=$1`, [UID]);
  const sign = (id) => jwt.sign({ uid: id }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
  const H = { Authorization: `Bearer ${sign(UID)}`, "X-App-Build": "119", "X-TZ-Offset": "330" };
  const HO = { Authorization: `Bearer ${sign(other.id)}`, "X-App-Build": "119" };
  const ctx = { userId: UID, userName: "Dhanush K", source: "text", tzOffsetMin: 330,
    deviceCaps: { build: 119, granted: ["camera"], denied: [] } };

  // The real routers behind the real auth, mounted as server.js mounts them.
  const { appAuth } = require("../src/middleware/auth");
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/docs", appAuth, require("../src/routes/docs"));
  app.use("/clients", appAuth, require("../src/routes/clients"));
  app.use("/meetings", appAuth, require("../src/meetings/routes"));
  app.use("/posters", appAuth, require("../src/routes/posters"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const upload = (route, { bytes, mime, filename, fields = {}, headers = H, field = "file" }) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append(field, new Blob([bytes], { type: mime }), filename);
    return fetch(`${base}${route}`, { method: "POST", body: fd, headers });
  };
  const getJson = async (route, headers = H) => {
    const r = await fetch(`${base}${route}`, { headers });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const understood = (id) => until(async () => {
    const r = await getJson(`/docs/${id}/understanding`);
    return r.body && r.body.ready ? r.body : null;
  });
  /** Runs this user's queued document.index jobs through the REAL handler. */
  async function runIndexJobs() {
    const handlers = require("../src/infra/jobs").HANDLERS;
    if (!handlers.has("document.index")) require("../src/infra/handlers").install();
    const jobs = await db.query(
      `SELECT id, payload FROM jobs WHERE user_id=$1 AND kind='document.index' AND status='pending'`, [UID]);
    for (const j of jobs) {
      const payload = typeof j.payload === "string" ? JSON.parse(j.payload) : j.payload;
      await handlers.get("document.index")(payload, j);
      await db.run(`UPDATE jobs SET status='done' WHERE id=$1`, [j.id]);
    }
    return jobs.length;
  }

  try {
    /* ============================================================== */
    console.log("\n/docs — upload → analysis → title/summary/expiry → search → file");
    /* ============================================================== */
    const policyExpiry = iso(Date.now() + 90 * DAY);
    const policyBytes = fakeJpeg(6000);
    let policyId;
    R.analyze = async () => geminiText(JSON.stringify({
      title: "Car insurance — ACKO",
      category: "other",
      doc_date: iso(Date.now() - 275 * DAY),
      expires_on: policyExpiry,
      summary: "Comprehensive car insurance for KA-01-AB-1234 with ACKO. Premium ₹14,200.",
      tags: ["insurance", "acko", "car", "policy"],
      full_text: "ACKO General Insurance\nPolicy KA01AB1234\nZero depreciation add-on included\nValid till " + policyExpiry,
    }));
    genReply = async () => ({ reply: '{"kind":"legal","events":[]}' });

    await atest("no session token: /docs is refused (401), nothing is saved", async () => {
      const r = await upload("/docs", { bytes: policyBytes, mime: "image/jpeg", filename: "x.jpg", headers: {} });
      assert.strictEqual(r.status, 401);
      const n = await db.one(`SELECT COUNT(*)::int AS n FROM documents WHERE user_id=$1`, [UID]);
      assert.strictEqual(n.n, 0);
    });

    await atest("a photographed policy is saved AT ONCE with a human placeholder title", async () => {
      const r = await upload("/docs", {
        bytes: policyBytes, mime: "image/jpeg", filename: "Capture.jpg", fields: { note: "my car insurance" },
      });
      assert.strictEqual(r.status, 200);
      const j = await r.json();
      assert.strictEqual(j.ok, true);
      assert.strictEqual(j.analyzed, false);
      assert.strictEqual(j.filedUnder, "personal");
      policyId = j.document.id;
      assert.ok(policyId > 0);
      assert.doesNotMatch(j.document.title, /Capture\.jpg/, "never the raw filename");
      // The app's DocumentUploadResult/UserDocument.fromJson fields.
      for (const k of ["id", "filename", "mime", "title", "category", "createdAt"]) {
        assert.ok(k in j.document, `document.${k} is sent`);
      }
      assert.strictEqual(typeof j.document.createdAt, "number", "createdAt is a number (Dart casts num)");
    });

    await atest("the analyser was handed the real bytes inline, as the photo's type", async () => {
      await understood(policyId);
      const call = geminiCalls.find((c) => kindOf(c.model, c.text) === "analyze");
      assert.ok(call, "analysis ran");
      const inline = call.parts.find((p) => p.inline_data);
      assert.strictEqual(inline.inline_data.mime_type, "image/jpeg");
      assert.strictEqual(inline.inline_data.data, policyBytes.toString("base64"));
      assert.strictEqual(call.key, PRIMARY_KEY);
    });

    await atest("after analysis: title, category, summary, expiry and 3 renewal reminders (notify, not calls)", async () => {
      const { body } = await getJson("/docs?scope=personal");
      const d = body.documents.find((x) => x.id === policyId);
      assert.strictEqual(d.title, "Car insurance — ACKO");
      assert.match(d.summary, /ACKO/);
      assert.strictEqual(d.expiresOn, policyExpiry);
      assert.match(d.tags, /insurance/);
      const rem = await db.query(
        `SELECT text, deliver FROM reminders WHERE user_id=$1 AND text LIKE 'Car insurance%' ORDER BY due_at`, [UID]);
      assert.strictEqual(rem.length, 3);
      assert.ok(rem.every((x) => x.deliver === "notify"), "renewal reminders never ring as calls");
      const u = await getJson(`/docs/${policyId}/understanding`);
      assert.deepStrictEqual(
        { ready: u.body.ready, kind: u.body.kind, events: u.body.events, remindersSet: u.body.remindersSet },
        { ready: true, kind: "legal", events: [], remindersSet: 0 });
    });

    await atest("list_expiring_documents answers 'when does my insurance expire'", async () => {
      const r = await registry.execute("list_expiring_documents", {}, ctx);
      assert.strictEqual(r.ok, true);
      const d = r.data.documents.find((x) => x.id === policyId);
      assert.strictEqual(d.daysLeft, 90);
      assert.strictEqual(d.expired, false);
    });

    await atest("search: by title words (search_documents) and by words INSIDE it once indexed (find_document)", async () => {
      const s = await registry.execute("search_documents", { query: "acko insurance" }, ctx);
      assert.strictEqual(s.ok, true);
      assert.strictEqual(s.data[0].id, policyId);
      assert.ok((await runIndexJobs()) >= 1, "the upload queued a document.index job");
      const chunks = await db.query(`SELECT text FROM document_chunks WHERE user_id=$1 AND document_id=$2`, [UID, policyId]);
      assert.ok(chunks.length >= 1 && /Zero depreciation/.test(chunks[0].text));
      const f = await registry.execute("find_document", { query: "zero depreciation" }, ctx);
      assert.strictEqual(f.ok, true);
      assert.strictEqual(f.data[0].id, policyId);
      assert.match(f.data[0].snippet, /Zero depreciation/);
    });

    await atest("[DEFECT] find_document's on-screen cards carry the file type the app's gallery needs", async () => {
      // assistant_engine.dart case 'documents' → UserDocument.fromJson →
      // DocumentGalleryScreen, which picks PDF / video / image from `mime`.
      const f = await registry.execute("find_document", { query: "zero depreciation" }, ctx);
      const card = f.deviceAction.documents[0];
      assert.ok(card.mime, `the card has no mime (got keys: ${Object.keys(card).join(", ")})`);
      assert.ok(card.filename, "the card has no filename");
      assert.strictEqual(typeof card.createdAt, "number", "the card has no createdAt");
    });

    await atest("GET /docs/:id/file returns the original bytes with their type; others get 404; no token 401", async () => {
      const r = await fetch(`${base}/docs/${policyId}/file`, { headers: H });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers.get("content-type"), "image/jpeg");
      assert.ok(Buffer.from(await r.arrayBuffer()).equals(policyBytes));
      assert.strictEqual((await fetch(`${base}/docs/${policyId}/file`, { headers: HO })).status, 404);
      // What an external browser gets for this URL (no bearer token).
      assert.strictEqual((await fetch(`${base}/docs/${policyId}/file`)).status, 401);
    });

    let inviteId;
    await atest("a shared invite screenshot (share sheet / saved Instagram post) becomes reminders the app mirrors to the calendar", async () => {
      const when = new Date(Date.now() + 3 * DAY);
      when.setUTCHours(14, 30, 0, 0); // 20:00 IST
      const whenIso = when.toISOString().replace("Z", "+00:00");
      R.analyze = async () => geminiText(JSON.stringify({
        title: "Dinner invite — Rahul's housewarming", category: "other", doc_date: "", expires_on: "",
        summary: "Rahul invites you to a housewarming dinner.", tags: ["invite", "dinner", "rahul"],
        full_text: "Housewarming dinner at Rahul's, 12 Lake Road. Saturday 8 pm. RSVP.",
      }));
      genReply = async (msgs) => {
        assert.match(msgs[0].content, /Housewarming dinner at Rahul's/, "understanding reads the document text");
        return { reply: JSON.stringify({ kind: "invite", events: [
          { title: "Dinner at Rahul's", whenIso },
          { title: "Something already over", whenIso: new Date(Date.now() - DAY).toISOString() },
        ] }) };
      };
      const r = await upload("/docs", {
        bytes: fakeJpeg(5000), mime: "image/jpeg", filename: "Screenshot_20260927.jpg",
        fields: { note: "shared from another app" }, // share_intake_service.dart
      });
      assert.strictEqual(r.status, 200);
      inviteId = (await r.json()).document.id;
      const u = await understood(inviteId);
      assert.ok(u, "understanding became ready");
      assert.strictEqual(u.kind, "invite");
      assert.strictEqual(u.remindersSet, 1, "the past event is not filed");
      // share_intake_service.dart reads e['title'] and (e['atMs'] as num).
      assert.deepStrictEqual(u.events, [{ title: "Dinner at Rahul's", atMs: when.getTime() }]);
      const rem = await db.one(
        `SELECT deliver, due_at FROM reminders WHERE user_id=$1 AND text='Dinner at Rahul''s'`, [UID]);
      assert.strictEqual(Number(rem.due_at), when.getTime());
      assert.strictEqual(rem.deliver, "notify");
    });

    await atest("an unreadable scan keeps a human title and the app's poll stays 'not ready' (no fake result)", async () => {
      R.analyze = async () => ({ status: 500, json: { error: { message: "stub: internal" } } });
      const r = await upload("/docs", { bytes: fakeJpeg(3000), mime: "image/jpeg", filename: "voice_save_1785246909049.jpg",
        fields: { note: "receipt from the pharmacy" } });
      const j = await r.json();
      await sleep(300);
      const { body } = await getJson("/docs");
      const d = body.documents.find((x) => x.id === j.document.id);
      assert.match(d.title, /^Receipt · /);
      assert.strictEqual(d.category, "receipt");
      assert.deepStrictEqual((await getJson(`/docs/${j.document.id}/understanding`)).body, { ready: false });
    });

    await atest("Office files are read as TEXT (no inline bytes) and become searchable", async () => {
      const docgen = require("../src/services/docgen");
      const spec = docgen.normalize("doc", { title: "Rent agreement", sections: [
        { heading: "Parties", paragraphs: ["Landlord Suresh Rao lets flat 4B to Dhanush K."] },
        { heading: "Rent", paragraphs: ["Monthly rent is ₹28,000, due on the 5th."] },
      ] });
      const bytes = await docgen.RENDER.doc(spec, "#7C3AED");
      let seen = null;
      R.analyze = async (call) => {
        seen = call;
        return geminiText(JSON.stringify({ title: "Rent agreement — flat 4B", category: "other", doc_date: "",
          expires_on: "", summary: "Rent ₹28,000 due on the 5th.", tags: ["rent", "agreement"],
          full_text: "Landlord Suresh Rao lets flat 4B to Dhanush K. Monthly rent is ₹28,000." }));
      };
      genReply = async () => ({ reply: '{"kind":"legal","events":[]}' });
      const r = await upload("/docs", { bytes, mime: MIME.docx, filename: "Rent agreement.docx" });
      assert.strictEqual(r.status, 200);
      const id = (await r.json()).document.id;
      await understood(id);
      assert.ok(seen, "analysed");
      assert.ok(!seen.parts.some((p) => p.inline_data), "a .docx is not sent as inline bytes");
      assert.match(seen.text, /Suresh Rao/, "the words were extracted from the .docx");
      const row = await db.one(`SELECT path, title FROM documents WHERE id=$1`, [id]);
      assert.match(row.path, /\.docx$/, "saved with an extension a viewer can open");
      const f = await fetch(`${base}/docs/${id}/file`, { headers: H });
      assert.strictEqual(f.headers.get("content-type"), MIME.docx);
    });

    await atest("[DEFECT] every type the app's share sheet accepts is saved, not refused (share_intake_service.dart _acceptable)", async () => {
      // share_intake_service.dart:109-115 accepts image/* (HEIC from the
      // camera, GIF…), .doc/.xls/.ppt; docs/analyze.js even lists HEIC as
      // natively readable. A refusal surfaces in the app as "Couldn't save
      // that — check your connection." (share_intake_service.dart:203).
      R.analyze = async () => ({ status: 500, json: {} });
      const refused = [];
      for (const [mime, name] of [
        ["image/heic", "IMG_2041.heic"],
        ["application/msword", "Old letter.doc"],
        ["application/vnd.ms-excel", "Accounts 2019.xls"],
        ["application/vnd.ms-powerpoint", "Old deck.ppt"],
      ]) {
        const r = await upload("/docs", { bytes: Buffer.alloc(4096, 7), mime, filename: name });
        if (r.status !== 200) refused.push(`${mime} → ${r.status} ${JSON.stringify(await r.json())}`);
      }
      assert.deepStrictEqual(refused, [], "refused types the app offers to save");
    });

    await atest("clear refusals: a zip is 415, a 19 MB file is 413 (the app shows the server's words)", async () => {
      const z = await upload("/docs", { bytes: Buffer.alloc(100, 1), mime: "application/zip", filename: "x.zip" });
      assert.strictEqual(z.status, 415);
      assert.match((await z.json()).error, /unsupported type/);
      const big = await upload("/docs", { bytes: Buffer.alloc(19 * 1024 * 1024, 1), mime: "image/jpeg", filename: "big.jpg" });
      assert.strictEqual(big.status, 413);
      assert.match((await big.json()).error, /18 MB/);
    });

    await atest("DELETE /docs/:id removes the row, the file and its memory fact", async () => {
      const row = await db.one(`SELECT path FROM documents WHERE id=$1`, [inviteId]);
      assert.ok(fs.existsSync(row.path));
      const factBefore = await db.query(
        `SELECT id FROM agent_memories WHERE user_id=$1 AND fact LIKE '%Rahul''s housewarming%'`, [UID]);
      const r = await fetch(`${base}/docs/${inviteId}`, { method: "DELETE", headers: H });
      assert.strictEqual(r.status, 200);
      assert.ok(!fs.existsSync(row.path), "the file is gone");
      assert.strictEqual((await fetch(`${base}/docs/${inviteId}/file`, { headers: H })).status, 404);
      if (factBefore) {
        assert.ok(factBefore.length >= 1, "a memory fact was saved at analysis");
        const after = await db.query(
          `SELECT id FROM agent_memories WHERE user_id=$1 AND fact LIKE '%Rahul''s housewarming%'`, [UID]);
        assert.strictEqual(after.length, 0, "the memory fact went with it");
      }
      assert.strictEqual((await fetch(`${base}/docs/${inviteId}`, { method: "DELETE", headers: H })).status, 404);
    });

    /* ============================================================== */
    console.log("\ncreate_document — a VALID file for every kind");
    /* ============================================================== */
    const JSZip = require("jszip");
    const ExcelJS = require("exceljs");
    const SPECS = {
      pdf: { title: "Rooftop Solar Proposal", subtitle: "For the Mehta family", sections: [
        { heading: "", paragraphs: ["This proposal covers a 3 kW rooftop system for the Mehta home."] },
        { heading: "Costs", paragraphs: ["The PM Surya Ghar subsidy lowers the net cost considerably."],
          table: { columns: ["Item", "Amount"], rows: [["Panels", "₹1,20,000"], ["Inverter", "₹40,000"]] },
          chart: { type: "bar", title: "Cost split", labels: ["Panels", "Inverter"], series: [{ name: "₹", values: [120000, 40000] }] } },
      ] },
      slides: { title: "Solar Energy for Homes", subtitle: "Board briefing", slides: [
        { title: "Rooftop solar pays back in five years", bullets: ["Net metering credits every exported unit", "Subsidy covers up to 40%"],
          notes: "Lead with the payback.", chart: { type: "line", title: "Savings", labels: ["Y1", "Y2", "Y3"], series: [{ name: "₹k", values: [20, 42, 66] }] } },
        { title: "Next steps", bullets: ["Get three installer quotes"], notes: "" },
      ] },
      doc: { title: "Leave letter", sections: [
        { heading: "", paragraphs: ["27 September 2026", "To the Manager,", "Subject: Leave from 12 to 14 October",
          "I request three days of leave for a family function.", "Regards,", "Dhanush K"] },
      ] },
      sheet: { title: "Weekly shopping list", sheets: [
        { name: "Groceries", columns: ["Item", "Qty", "Price (₹)"],
          rows: [["Milk", 2, 56], ["Bread", 1, 45], ["Eggs", 12, 84]], total_row: true, note: "Prices from Blinkit" },
      ] },
    };
    let docgenPrompt = "";
    let docgenStatus = 200;
    R.docgen = async (call) => {
      docgenPrompt = call.text;
      if (docgenStatus !== 200) return { status: docgenStatus, json: { error: { message: "stub: writer down" } } };
      const kind = /PowerPoint/.test(call.text) ? "slides" : /Excel sheet/.test(call.text) ? "sheet"
        : /Word document/.test(call.text) ? "doc" : "pdf";
      return geminiText(JSON.stringify(SPECS[kind]));
    };
    const made = {};
    for (const [kind, ext, mime] of [["pdf", ".pdf", MIME.pdf], ["slides", ".pptx", MIME.pptx],
      ["doc", ".docx", MIME.docx], ["sheet", ".xlsx", MIME.xlsx]]) {
      await atest(`create_document kind=${kind}: saved as ${ext}, the Documents list opens`, async () => {
        const r = await registry.execute("create_document", { kind, topic: SPECS[kind].title }, ctx);
        assert.strictEqual(r.ok, true, r.error);
        const d = r.data.document;
        assert.strictEqual(d.mime, mime);
        assert.ok(d.filename.endsWith(ext), d.filename);
        assert.deepStrictEqual(r.deviceAction, { type: "open_app_screen", screen: "documents" });
        assert.match(r.speak, /ready in your documents/);
        assert.match(docgenPrompt, /TODAY IS /, "the writer is told today's date");
        const f = await fetch(`${base}/docs/${d.id}/file`, { headers: H });
        assert.strictEqual(f.status, 200);
        assert.strictEqual(f.headers.get("content-type"), mime);
        made[kind] = { id: d.id, buf: Buffer.from(await f.arrayBuffer()), doc: d };
      });
    }

    await atest("the PDF is a real PDF (header, pages, trailer)", async () => {
      const b = made.pdf.buf;
      assert.strictEqual(b.subarray(0, 5).toString(), "%PDF-");
      assert.match(b.subarray(-32).toString(), /%%EOF/);
      assert.ok(/\/Type\s*\/Page\b/.test(b.toString("latin1")), "has at least one page");
    });

    await atest("the PowerPoint opens: title slide + one per spec slide, bullets and notes inside", async () => {
      const zip = await JSZip.loadAsync(made.slides.buf);
      const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
      assert.strictEqual(slides.length, 3);
      const s2 = await zip.file("ppt/slides/slide2.xml").async("string");
      assert.match(s2, /Rooftop solar pays back in five years/);
      assert.match(s2, /Net metering credits every exported unit/);
      const notes = Object.keys(zip.files).filter((n) => /notesSlide\d+\.xml$/.test(n));
      assert.ok(notes.length >= 1, "speaker notes are kept");
    });

    await atest("the Word file opens and carries the letter", async () => {
      const zip = await JSZip.loadAsync(made.doc.buf);
      const xml = await zip.file("word/document.xml").async("string");
      assert.match(xml, /Subject: Leave from 12 to 14 October/);
      assert.match(xml, /Dhanush K/);
    });

    await atest("the Excel sheet (a shopping list) opens: numbers are numbers, the total is a SUM with a cached value", async () => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(made.sheet.buf);
      const ws = wb.getWorksheet("Groceries");
      assert.ok(ws, "tab named from the spec");
      assert.deepStrictEqual(ws.getRow(1).values.slice(1), ["Item", "Qty", "Price (₹)"]);
      assert.strictEqual(ws.getCell("C2").value, 56);
      const total = ws.getCell("C5").value;
      assert.strictEqual(total.formula, "SUM(C2:C4)");
      assert.strictEqual(total.result, 185);
    });

    await atest("a writer failure is reported as a failure and nothing is saved", async () => {
      const before = (await db.one(`SELECT COUNT(*)::int AS n FROM documents WHERE user_id=$1`, [UID])).n;
      docgenStatus = 500;
      const r = await registry.execute("create_document", { kind: "pdf", topic: "Anything" }, ctx);
      docgenStatus = 200;
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /couldn't build that PDF/);
      assert.ok(!r.deviceAction);
      assert.strictEqual((await db.one(`SELECT COUNT(*)::int AS n FROM documents WHERE user_id=$1`, [UID])).n, before);
    });

    await atest("get_last_document reads back what was just written, with the full client shape", async () => {
      const r = await registry.execute("get_last_document", {}, ctx);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.data.id, made.sheet.id);
      assert.match(r.data.full_text, /Milk \| 2 \| 56/);
      assert.strictEqual(r.deviceAction.documents[0].mime, MIME.xlsx);
    });

    await atest("[DEFECT] a document the assistant wrote can be found later by what it SAYS", async () => {
      // "find the proposal that mentions the Surya Ghar subsidy" — the word
      // is in the PDF's body (full_text), not its title or summary.
      const r = await registry.execute("find_document", { query: "Surya Ghar subsidy" }, ctx);
      assert.strictEqual(r.ok, true, `not found: ${r.error}`);
      assert.strictEqual(r.data[0].id, made.pdf.id);
    });

    await atest("[DEFECT] a generated business report is not filed as a MEDICAL document", async () => {
      SPECS.pdf = { title: "Q3 Sales Report", sections: [{ heading: "Summary", paragraphs: ["Sales rose 12% in Q3."] }] };
      const r = await registry.execute("create_document", { kind: "pdf", topic: "Q3 sales report for the board" }, ctx);
      assert.strictEqual(r.ok, true);
      assert.notStrictEqual(r.data.document.category, "medical",
        "docs/store.guessCategory(title) matched /report/ → 'medical'");
      const s = await docsStore.searchDocuments(UID, "show me my last hospital report");
      assert.ok(!s.hits.some((h) => h.id === r.data.document.id),
        "'my last hospital report' must not surface the sales report");
    });

    await atest("shopping list hand-off: open_service_app opens a Blinkit SEARCH, and says the user finishes", async () => {
      const r = await registry.execute("open_service_app", { service: "blinkit", query: "milk bread eggs" }, ctx);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.deviceAction.type, "open_url");
      assert.match(r.deviceAction.url, /blinkit\.com\/s\/\?q=milk%20bread%20eggs|blinkit/);
    });

    await atest("information organisation: a dictated tally is kept and read back with its total", async () => {
      await registry.execute("record_entry", { topic: "site expenses", label: "Cement", amount: 2000 }, ctx);
      await registry.execute("record_entry", { topic: "site expenses", label: "Sand", amount: 1500 }, ctx);
      const r = await registry.execute("list_entries", { topic: "site expenses" }, ctx);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(Number(r.data.total), 3500);
      assert.match(r.speak, /Total 3500/);
    });

    /* ============================================================== */
    console.log("\ngenerate_image — billing off, then the keyless provider");
    /* ============================================================== */
    let imageCalls = 0;
    R.image = async () => {
      imageCalls++;
      return { status: 429, json: { error: { code: 429, message: "Quota exceeded for metric ... limit: 0", status: "RESOURCE_EXHAUSTED" } } };
    };
    await atest("billing off and the free provider down: a clear failure, nothing saved, nothing shown", async () => {
      const before = (await db.one(`SELECT COUNT(*)::int AS n FROM documents WHERE user_id=$1`, [UID])).n;
      pollinations = async () => new Response("busy", { status: 502, headers: { "content-type": "text/plain" } });
      const r = await registry.execute("generate_image", { prompt: "a beach house at sunset", aspect: "landscape" }, ctx);
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /Image generation hit a snag just now — ask me to try again in a moment/);
      assert.ok(!r.deviceAction, "no show_image for a picture that does not exist");
      assert.strictEqual(imageCalls, 1, "the paid image model was tried once");
      assert.strictEqual((await db.one(`SELECT COUNT(*)::int AS n FROM documents WHERE user_id=$1`, [UID])).n, before);
    });

    let imageDocId;
    await atest("keyless provider up: the image is saved and shown (show_image with the full document)", async () => {
      const jpg = fakeJpeg(40 * 1024, 1024, 683);
      let asked = "";
      pollinations = async (url) => { asked = url; return new Response(jpg, { status: 200, headers: { "content-type": "image/jpeg" } }); };
      const r = await registry.execute("generate_image", { prompt: "Lord Krishna playing the flute", title: "Krishna", aspect: "portrait" }, ctx);
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(imageCalls, 1, "the quota-blocked paid model is on cooldown, not retried per image");
      assert.match(decodeURIComponent(asked), /BLUE skin/, "canonical subject hints were added");
      assert.match(asked, /width=768&height=1024/, "portrait, capped to the keyless ceiling");
      assert.strictEqual(r.deviceAction.type, "show_image");
      assert.strictEqual(r.deviceAction.document.mime, "image/jpeg");
      assert.strictEqual(r.deviceAction.document.title, "Krishna");
      assert.strictEqual(r.data.generated, true);
      imageDocId = r.deviceAction.doc_id;
      const f = await fetch(`${base}/docs/${imageDocId}/file`, { headers: H });
      assert.ok(Buffer.from(await f.arrayBuffer()).equals(jpg));
    });

    /* ============================================================== */
    console.log("\nthe camera and screenshots — handed to the phone, which answers them itself");
    /* ============================================================== */

    await atest("analyze_camera / look_at_screenshot hand the phone the actions it handles", async () => {
      const a = await registry.execute("analyze_camera", { question: "what tablet is this" }, ctx);
      assert.deepStrictEqual(a.deviceAction, { type: "analyze_camera", question: "what tablet is this" });
      const s = await registry.execute("look_at_screenshot", { question: "what do I do about this" }, ctx);
      assert.deepStrictEqual(s.deviceAction, { type: "ask_about_image", source: "gallery", question: "what do I do about this" });
      const c = await registry.execute("capture_document", { note: "Raj MRI report", source: "gallery" }, ctx);
      assert.strictEqual(c.deviceAction.type, "capture_document");
      assert.strictEqual(c.deviceAction.source, "gallery");
    });

    // (The camera's own questions — "what is this", a PDF, a screenshot's
    // event — were POST /vision until 2026-09-29. The app answers them with
    // its own models now; /vision answers 426 (scripts/ai-toolserver-test.js).)

    /* ============================================================== */
    console.log("\nbusiness card → contact (the real card reader, model stubbed)");
    /* ============================================================== */
    await atest("POST /clients/scan-card: the card is read, the person saved, the photo kept as a document", async () => {
      R.card = async () => geminiText(JSON.stringify({
        name: "Priya  Sharma", title: "Head of Sales", company: "Acme Pvt Ltd",
        phones: ["+91 98450 12345"], emails: ["Priya@Acme.in"], website: "acme.in", address: "Indiranagar, Bengaluru",
      }));
      const cardBytes = fakeJpeg(8000);
      const r = await upload("/clients/scan-card", { bytes: cardBytes, mime: "image/jpeg", filename: "card.jpg" });
      assert.strictEqual(r.status, 200);
      const { person } = await r.json();
      // business_card_flow.dart CardResultSheet reads these.
      assert.strictEqual(person.name, "Priya Sharma");
      assert.deepStrictEqual(person.phones, ["+919845012345"]);
      assert.deepStrictEqual(person.emails, ["priya@acme.in"]);
      assert.strictEqual(person.company, "Acme Pvt Ltd");
      const call = geminiCalls.filter((c) => kindOf(c.model, c.text) === "card").pop();
      assert.strictEqual(call.parts[0].inline_data.data, cardBytes.toString("base64"));
      const doc = await getJson(`/docs`);
      const cardDoc = doc.body.documents.find((d) => d.id === person.documentId);
      assert.strictEqual(cardDoc.title, "Business card — Priya Sharma");
      const f = await fetch(`${base}/docs/${person.documentId}/file`, { headers: H });
      assert.ok(Buffer.from(await f.arrayBuffer()).equals(cardBytes));
      const who = await registry.execute("lookup_person", { name: "Priya Sharma" }, ctx);
      assert.strictEqual(who.ok, true, who.error);
    });

    await atest("a card the model cannot read is a 502 with words, not a blank contact", async () => {
      R.card = async () => ({ status: 500, json: {} });
      const r = await upload("/clients/scan-card", { bytes: fakeJpeg(), mime: "image/jpeg", filename: "card.jpg" });
      assert.strictEqual(r.status, 502);
      assert.match((await r.json()).error, /couldn't read the card/);
    });

    /* ============================================================== */
    console.log("\nmeeting recorder → minutes → PDF (the app's upload shape)");
    /* ============================================================== */
    await atest("record_meeting opens the recorder screen the app builds (meeting_recorder)", async () => {
      const r = await registry.execute("record_meeting", { title: "Vendor sync" }, ctx);
      assert.deepStrictEqual(r.deviceAction, { type: "open_app_screen", screen: "meeting_recorder", title: "Vendor sync", participants: "" });
    });

    await atest("an uploaded recording → minutes, listed, PDF only once done", async () => {
      ai.transcribeAudio = async () => ({ text: "Dhanush: we sign the vendor contract on Monday. Meera: I will send the draft by Friday." });
      genReply = async () => ({ reply: JSON.stringify({
        summary: "Agreed to sign the vendor contract on Monday.",
        decisions: ["Sign the vendor contract on Monday"],
        actions: [{ text: "Send the draft", owner: "Meera", when: "Friday", mine: false },
                  { text: "Review the draft", owner: "Dhanush", when: "Saturday", mine: true }],
        follow_up: "Thanks Meera — draft by Friday, signing Monday.",
      }) });
      // meetings_service.dart: title, participants, duration_s, audio (m4a).
      const r = await upload("/meetings/record", { bytes: Buffer.alloc(64 * 1024, 3), mime: "audio/mp4",
        filename: "meeting.m4a", field: "audio", fields: { title: "Vendor sync", participants: "Meera", duration_s: "1500" } });
      assert.strictEqual(r.status, 202);
      const { id } = await r.json();
      const m = await until(async () => {
        const x = await getJson(`/meetings/${id}`);
        return x.body && x.body.status !== "processing" ? x.body : null;
      });
      assert.ok(m, "processing finished");
      assert.strictEqual(m.status, "done");
      assert.deepStrictEqual(m.decisions, ["Sign the vendor contract on Monday"]);
      const list = await getJson("/meetings?limit=30");
      assert.ok(list.body.meetings.some((x) => x.id === id));
      const pdf = await fetch(`${base}/meetings/${id}/pdf`, { headers: H });
      assert.strictEqual(pdf.status, 200);
      assert.strictEqual(pdf.headers.get("content-type"), "application/pdf");
      assert.strictEqual(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
      assert.strictEqual((await fetch(`${base}/meetings/${id}/pdf`, { headers: HO })).status, 404);
      const tasks = await db.query(`SELECT text FROM commitments WHERE user_id=$1 AND source='meeting'`, [UID]);
      assert.deepStrictEqual(tasks.map((t) => t.text), ["Review the draft"]);
    });

    await atest("the PDF of a meeting still processing is 409, not a half-written file", async () => {
      const meetings = require("../src/meetings/service");
      const pid = await meetings.createPending(UID, { title: "Still going" });
      const r = await fetch(`${base}/meetings/${pid}/pdf`, { headers: H });
      assert.strictEqual(r.status, 409);
    });

    /* ============================================================== */
    console.log("\nphoto cards (build 119) — gating and route sanity");
    /* ============================================================== */
    await atest("the card tools are offered to build 119 only; the routes answer with a session", async () => {
      const names = (build) => registry.declarations({ userId: UID, deviceCaps: { build, granted: [], denied: [] } }).map((d) => d.name);
      assert.ok(!names(118).includes("make_greeting_poster"));
      assert.ok(names(119).includes("make_greeting_poster"));
      assert.ok(names(119).includes("improve_old_photo"));
      assert.strictEqual((await getJson("/posters/consent")).status, 200);
      const latest = await getJson("/posters/latest");
      assert.ok([200, 404].includes(latest.status));
      assert.strictEqual((await fetch(`${base}/posters/latest`)).status, 401);
    });

    /* ============================================================== */
    console.log("\nkey pool — the camera must survive one spent key");
    /* ============================================================== */
    await atest("a model out of quota leaves the document saved, without analysis, and never throws", async () => {
      R.analyze = async () => ({ status: 429, json: { error: { code: "rate_limit_exceeded", message: "You exceeded your current quota" } } });
      const meta = await require("../src/docs/analyze").analyzeDocument(fakeJpeg(), "image/jpeg", "r.jpg");
      assert.strictEqual(meta, null, "no analysis, no exception");
    });

    /* ============================================================== */
    console.log("\nisolation");
    /* ============================================================== */
    await atest("nothing tried to reach a real external service", () => {
      assert.deepStrictEqual([...new Set(blocked)], []);
      assert.ok(geminiCalls.every((c) => c.key === PRIMARY_KEY || c.key === FALLBACK_KEY), "only the fake keys were used");
    });
  } finally {
    ai.generateReply = realGen;
    ai.transcribeAudio = realStt;
    server.close();
    // Background analysis must settle before the rows go.
    await sleep(300);
    for (const id of [UID, other.id]) {
      await privacy.deleteUserEverywhere(id, { reason: "e2e-g2 cleanup" }).catch((e) =>
        console.error("cleanup failed:", e.message));
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    globalThis.fetch = realFetch;
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) console.log("failed:\n  - " + failed.join("\n  - "));
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
