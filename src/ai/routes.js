/**
 * /ai — the backend half of the app's hybrid brain (2026-09-29).
 *
 * The phone runs the models itself: Gemini Nano on the device for what it
 * can answer in words, Gemini in the cloud through Firebase AI Logic for
 * the rest (tools, fresh facts, images), Gemini TTS for the voice. This
 * server is what those models stand on — the context and memory, the
 * tools, the approvals, the record — and no model is called here:
 *
 *   GET  /ai/config          models, voice, Nano on/off, routing words
 *   POST /ai/context         one turn's system instruction, Nano preamble,
 *                            tools and history (ai/context.js)
 *   POST /ai/tool            run a tool the model called (ai/tool.js)
 *   POST /ai/turn            claim-check and record the reply (ai/turn.js)
 *   POST /ai/firebase-token  a Firebase custom token ("u<id>") so Firebase
 *                            AI Logic can require a signed-in user
 *
 * Mounted behind appAuth (server.js). Background, stored-data and
 * multi-user work stays on the server's own agent (agents/runtime.js).
 */
const express = require("express");
const router = express.Router();
const sessions = require("./sessions");

/** The signed-in account, or null (anonymous dev sessions have none). */
function userOf(req, res) {
  const uid = Number(req.user && req.user.sub);
  if (!Number.isInteger(uid) || uid <= 0) {
    res.status(401).json({ error: "sign in required" });
    return null;
  }
  // Deleted on this pod a moment ago: nothing more is created or written.
  if (sessions.isErased(uid)) {
    res.status(401).json({ error: "account deleted" });
    return null;
  }
  return uid;
}

router.get("/config", async (req, res) => {
  const uid = userOf(req, res);
  if (!uid) return;
  // The app says its build in the X-App-Build header on every call (the
  // query form is for scripts); without it a build-gated switch never flips.
  const build = req.query.build || req.get("X-App-Build");
  res.json(await require("./config").forUser(uid, { build, live: req.query.live }));
});

router.post("/context", async (req, res) => {
  const uid = userOf(req, res);
  if (!uid) return;
  const body = req.body && typeof req.body === "object" ? req.body : {};
  // A LIVE SESSION HAS NO WORDS YET (2026-09-30): the app opens the session
  // and each turn before the transcript is final, so an empty text is an
  // app note, not a mistake.
  if (body.mode === "live" && (typeof body.text !== "string" || !body.text.trim())) {
    body.text = body.turnOnly ? "[SYSTEM] Live turn" : "[SYSTEM] Live session starting";
  }
  if (typeof body.text !== "string" || !body.text.trim()) {
    return res.status(400).json({ error: "text required" });
  }
  res.json(await require("./context").prepare(uid, body));
});

router.post("/tool", async (req, res) => {
  const uid = userOf(req, res);
  if (!uid) return;
  const out = await require("./tool").runTool(uid, req.body && typeof req.body === "object" ? req.body : {});
  res.status(out.status).json(out.json);
});

router.post("/turn", async (req, res) => {
  const uid = userOf(req, res);
  if (!uid) return;
  const out = await require("./turn").recordTurn(uid, req.body && typeof req.body === "object" ? req.body : {});
  res.status(out.status).json(out.json);
});

/**
 * A LIVE TURN'S AUDIO, for review (2026-10-01, src/live/turnAudio.js):
 * multipart with `user` (PCM16 mono, user_rate Hz, default 16000) and
 * `agent` (PCM16 mono, agent_rate Hz, default 24000), plus turn_id and
 * started_at. Stored only for a user who said yes to "help improve";
 * otherwise 204 and the phone simply stops sending.
 */
const turnAudioUpload = require("multer")({
  storage: require("multer").memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 2, fields: 8 },
});
/**
 * WHY THE FAST VOICE GAVE WAY (2026-10-01). The phone reports the reason
 * it fell back to the classic voice, so "why did Live drop for the
 * client?" is in the server log — and, for an error, in the developer's
 * inbox (once an hour).
 */
router.post("/live-fallback", async (req, res) => {
  const uid = userOf(req, res);
  if (!uid) return;
  const reason = String((req.body && req.body.reason) || "").slice(0, 200);
  const keep = req.body && req.body.keep_live === true;
  console.log(`ai: live fallback uid=${uid} keepLive=${keep} build=${Number((req.body && req.body.build) || req.get("X-App-Build")) || 0} reason=${JSON.stringify(reason)}`);
  if (!keep && /error|fail|quota|429|exhaust|unavailable|closed|denied|timeout|refused/i.test(reason)) {
    require("../feedback/store").alert(`Fast voice fell back to the classic voice: ${reason.slice(0, 120)}`,
      { details: `user ${uid}, build ${Number((req.body && req.body.build) || req.get("X-App-Build")) || 0}`, windowMs: 3600_000 }).catch(() => {});
  }
  res.json({ ok: true });
});

router.post("/turn-audio", turnAudioUpload.fields([{ name: "user", maxCount: 1 }, { name: "agent", maxCount: 1 }]),
  async (req, res) => {
    const uid = userOf(req, res);
    if (!uid) return;
    const f = req.files || {};
    const body = req.body || {};
    const turnId = String(body.turn_id || "").trim();
    if (!turnId) return res.status(400).json({ error: "turn_id required" });
    const rate = (v, d) => { const n = Number(v); return n >= 8000 && n <= 48000 ? Math.round(n) : d; };
    try {
      const id = await require("../live/turnAudio").save(uid, {
        turnId,
        userPcm: f.user && f.user[0] ? f.user[0].buffer : null,
        userRate: rate(body.user_rate, 16000),
        agentPcm: f.agent && f.agent[0] ? f.agent[0].buffer : null,
        agentRate: rate(body.agent_rate, 24000),
        startedAt: Number(body.started_at) || Date.now(),
      });
      if (!id) return res.status(204).end();
      res.json({ ok: true, id });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e).slice(0, 120) });
    }
  });

/**
 * THE PHONE'S MODEL (2026-10-02, src/ai/proxy.js): Gemini's request shape
 * in, Gemini's response shape out, OpenAI behind it. `stream: true` in
 * the body makes it server-sent events, one chunk per `data:` line.
 */
router.post("/generate", express.json({ limit: "25mb" }), async (req, res) => {
  const uid = userOf(req, res);
  if (!uid) return;
  const body = req.body || {};
  const proxy = require("./proxy");
  if (!body.stream) {
    try {
      let last = null;
      await proxy.generate(body, { stream: false, userId: uid, emit: (j) => { last = j; } });
      return res.json(last || { candidates: [] });
    } catch (e) {
      console.warn("ai/generate failed:", e.message);
      return res.status(e.status === 429 ? 429 : 502).json({ error: { message: String(e.message || e).slice(0, 200) } });
    }
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const send = (j) => res.write(`data: ${JSON.stringify(j)}\n\n`);
  try {
    await proxy.generate(body, { stream: true, userId: uid, emit: send });
  } catch (e) {
    console.warn("ai/generate stream failed:", e.message);
    send({ error: { message: String(e.message || e).slice(0, 200), status: e.status || 0 } });
  }
  res.write("data: [DONE]\n\n");
  res.end();
});

/**
 * THE DRAFT PAD (2026-10-04): writes or edits the pad's text, streamed as
 * `data: {"t": "..."}` lines and `data: [DONE]` (see ./draft.js).
 */
router.post("/draft", express.json({ limit: "2mb" }), async (req, res) => {
  const uid = userOf(req, res);
  if (!uid) return;
  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (typeof body.instruction !== "string" || !body.instruction.trim()) {
    return res.status(400).json({ error: "instruction required" });
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const send = (j) => res.write(`data: ${JSON.stringify(j)}\n\n`);
  try {
    await require("./draft").streamDraft(body, (t) => send({ t }));
  } catch (e) {
    console.warn("ai/draft failed:", e.message);
    send({ error: { message: String(e.message || e).slice(0, 200), status: e.status || 0 } });
  }
  res.write("data: [DONE]\n\n");
  res.end();
});

/** How she sounds on the fast voice (the owner, 2026-10-02: "there is no emotion in the voice"). */
const VOICE_STYLE =
  "VOICE: use Marin, a natural, clear, warm female voice. Speak with formal courtesy and deep respect, never curtly or over-familiarly; sound like a considerate person, not a reader — lively, natural intonation, real " +
  "feeling that follows what they say (delight, concern, a smile in the voice, calm firmness when it " +
  "is serious). Short sentences, no filler, never read a list aloud. Match their language and energy.\n" +
  // The owner, 2026-10-03: never an American accent for Indian languages.
  "ACCENT: always an Indian accent, never American or British. Kannada, Hindi, Malayalam, Tamil, " +
  "Telugu and every Indian language with its own native pronunciation, like a native speaker; " +
  "English in a natural Indian English accent; mixed Kannada-English or Hindi-English the way " +
  "people in India speak it.";

// From this build the phone answers all of a response's tool calls together.
const PARALLEL_TOOLS_BUILD = 154;
/** A short-lived key for the phone's own realtime voice session (Phase C). */
router.post("/realtime/secret", async (req, res) => {
  const uid = userOf(req, res);
  if (!uid) return;
  try {
    const openai = require("../services/ai/openai");
    const b = req.body || {};
    const cfg = require("./config");
    const profile = await require("../users/context").getProfile(uid).catch(() => null);
    const language = cfg.speechLanguage(profile && profile.user && profile.user.preferred_language).slice(0, 2);
    const out = await openai.realtimeClientSecret({
      language, silenceMs: cfg.liveBlock(uid).silenceMs, user: uid,
      parallelTools: (Number(req.get("X-App-Build")) || 0) >= PARALLEL_TOOLS_BUILD,
      voice: require("./proxy").DEFAULT_VOICE,
      instructions: (VOICE_STYLE + "\n\n" + String(b.instructions || "")).slice(0, 60_000),
      tools: Array.isArray(b.tools) ? b.tools : [],
    });
    res.json({ value: out.value, expiresAt: out.expiresAt, model: out.model });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e).slice(0, 200) });
  }
});

/** Creates GPT-Live with the server-owned, immutable agent configuration. */
router.post("/live/session", async (req, res) => {
  const uid = userOf(req, res);
  if (!uid) return;
  const b = req.body || {};
  try {
    const openai = require("../services/ai/openai");
    const transport = b.transport && typeof b.transport === "object" ? b.transport : null;
    if (transport && transport.type !== "webrtc") {
      return res.status(400).json({ error: "transport.type must be webrtc" });
    }
    const out = await openai.liveSession({
      sdp: transport ? transport.sdp : b.sdp,
      user: uid,
    });
    res.status(201).json({ session: { id: out.session && out.session.id }, transport: out.transport });
  } catch (e) {
    console.error(`ai: gpt-live session failed uid=${uid}: ${String(e.message || e).slice(0, 200)}`);
    res.status(e.status === 400 ? 400 : 502).json({ error: String(e.message || e).slice(0, 200) });
  }
});

/** The voices the picker offers (ai/liveVoices.js), grouped by the app. */
router.get("/voices", (req, res) => {
  const uid = userOf(req, res);
  if (!uid) return;
  const lv = require("./liveVoices");
  res.json({ voices: lv.CATALOG, default: lv.DEFAULT_VOICE });
});

/** A voice's own sample (recorded once from GPT-Live, then kept). */
router.get("/voices/:id/sample", async (req, res) => {
  const uid = userOf(req, res);
  if (!uid) return;
  try {
    const wav = await require("./liveVoices").sample(req.params.id);
    if (!wav) return res.status(404).json({ error: "no such voice" });
    res.set("Content-Type", "audio/wav").set("Cache-Control", "private, max-age=604800").send(wav);
  } catch (e) {
    console.error(`ai: voice sample ${req.params.id} failed: ${String(e.message || e).slice(0, 160)}`);
    res.status(502).json({ error: "sample not ready, try again" });
  }
});

/** The orb's hello in a Live voice: generated once per voice and shared. */
async function serveGreeting(req, res) {
  const uid = userOf(req, res);
  if (!uid) return;
  try {
    const wav = await require("./liveVoices").greeting(req.params.id, req.query.line);
    if (!wav) return res.status(400).json({ error: "unknown voice or line" });
    res.set("Content-Type", "audio/wav").set("Cache-Control", "private, max-age=604800").send(wav);
  } catch (e) {
    console.error(`ai: greeting ${req.params.id} failed: ${String(e.message || e).slice(0, 160)}`);
    res.status(502).json({ error: "greeting not ready, try again" });
  }
}

// Keep old paths working for installed builds. v4 invalidates clips generated
// with an earlier voice source.
router.get("/voices/:id/greeting", serveGreeting);
router.get("/voices/:id/greeting-v3", serveGreeting);
router.get("/voices/:id/greeting-v4", serveGreeting);

router.post("/firebase-token", async (req, res) => {
  const uid = userOf(req, res);
  if (!uid) return;
  const firebase = require("../services/firebase");
  if (!firebase.ensure()) return res.status(503).json({ error: "firebase unavailable" });
  const fuid = `u${uid}`;
  try {
    const token = await firebase.auth().createCustomToken(fuid);
    res.json({ token, uid: fuid });
  } catch (e) {
    // Most often the service account lacks "Service Account Token Creator".
    console.error("ai: firebase custom token failed:", String((e && e.message) || e).slice(0, 200));
    res.status(503).json({ error: "firebase unavailable" });
  }
});

module.exports = router;
