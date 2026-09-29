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
const router = require("express").Router();
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
  res.json(await require("./config").forUser(uid, { build: req.query.build }));
});

router.post("/context", async (req, res) => {
  const uid = userOf(req, res);
  if (!uid) return;
  const body = req.body && typeof req.body === "object" ? req.body : {};
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
