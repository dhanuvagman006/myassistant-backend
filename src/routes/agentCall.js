/**
 * AGENT-CALL ROUTES
 *
 * App-facing (behind appAuth):
 *   POST /agent-call/preview  { contactName, task, lang? } -> { opening, allowed, reason? }
 *   POST /agent-call          { toNumber, contactName, task, lang? } -> 202 { id }
 *                              503 when telephony not configured (app falls
 *                              back to a direct dial); 402 over the daily limit.
 *   GET  /agent-call/:id      -> { state, result?, answer? }
 *
 * Provider webhooks (public — mounted WITHOUT appAuth in server.js, gated
 * by a URL secret = sha256(provider api key)[:32]):
 *   POST /agent-call/bolna/webhook/:secret
 */

const express = require("express");
const crypto = require("crypto");
const agent = require("../agents/agentCall");

function uidOf(req) {
  const id = Number(req.user?.sub);
  return Number.isInteger(id) && id > 0 ? id : null;
}
function firstName(req) {
  const n = req.user?.name;
  return n ? String(n).split(" ")[0] : null;
}

const router = express.Router();

router.post("/preview", async (req, res) => {
  const contactName = String(req.body?.contactName || "").trim();
  const task = String(req.body?.task || "").trim();
  const lang = req.body?.lang ? String(req.body.lang) : null;
  if (!contactName || !task) {
    return res.status(400).json({ error: "contactName and task required" });
  }
  try {
    const p = await agent.preview({ userName: firstName(req), contactName, task, lang });
    if (!agent.enabled()) {
      // Preview still shows what WOULD be said; flag that calling is off.
      return res.json({
        opening: p.opening,
        allowed: false,
        reason:
          "Calling on your behalf isn't set up on this server yet, but I can connect you directly.",
      });
    }
    res.json({ opening: p.opening, allowed: p.allowed, reason: p.reason });
  } catch (e) {
    console.error("agent-call preview error:", e.message || e);
    res.status(502).json({ error: "preview failed" });
  }
});

router.post("/", async (req, res) => {
  const toNumber = String(req.body?.toNumber || "").trim();
  const contactName = String(req.body?.contactName || "").trim();
  const task = String(req.body?.task || "").trim();
  const lang = req.body?.lang ? String(req.body.lang) : null;
  if (!toNumber || !contactName || !task) {
    return res.status(400).json({ error: "toNumber, contactName and task required" });
  }
  if (!agent.enabled()) {
    return res.status(503).json({ error: "agent calling not configured" });
  }
  try {
    const { id } = await agent.start({
      userId: uidOf(req),
      userName: firstName(req),
      toNumber,
      contactName,
      task,
      lang,
      // The user's own answer to "and if they don't pick up?" — absent
      // means one attempt.
      retryTimes: Number(req.body?.retryTimes) || 0,
      retryGapMinutes: Number(req.body?.retryGapMinutes) || 0,
    });
    res.status(202).json({ id });
  } catch (e) {
    if (e?.code === "unavailable") {
      return res.status(503).json({ error: "agent calling not configured" });
    }
    if (e?.code === "quota") {
      return res.status(402).json({
        error: "quota",
        message: "You've reached today's limit for calls I place for you.",
      });
    }
    if (e?.code === "bad_number") {
      return res.status(400).json({ error: "invalid number" });
    }
    console.error("agent-call start error:", e.message || e);
    res.status(502).json({ error: "could not start call" });
  }
});

router.get("/:id", (req, res) => {
  const rec = agent.get(String(req.params.id));
  // Transcripts and outcomes are the caller's own business only.
  if (!rec || (rec.userId && String(rec.userId) !== String(req.user?.sub))) {
    return res.status(404).json({ error: "unknown call" });
  }
  res.json(agent.status(String(req.params.id)));
});

/** Webhook router gated by sha256(api key)[:32] in the path; always 200s
 *  fast (providers retry on non-2xx and duplicate events are harmless). */
function providerWebhook(envKey, handle) {
  const r = express.Router();
  r.use(express.json({ limit: "2mb" }));
  r.post("/webhook/:secret", (req, res) => {
    const key = process.env[envKey] || "";
    const want = crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
    if (!key || req.params.secret !== want) return res.status(404).json({ error: "not found" });
    try {
      handle(req.body || {});
    } catch (e) {
      console.error(`${envKey} webhook failed:`, e.message);
    }
    res.json({ ok: true });
  });
  return r;
}

const bolnaWebhooks = providerWebhook("BOLNA_API_KEY", agent.bolnaWebhook);

module.exports = { router, bolnaWebhooks };
