/**
 * AGENT-CALL ROUTES
 *
 * App-facing (behind appAuth):
 *   POST /agent-call/preview  { contactName, task, lang? } -> { opening, allowed, reason? }
 *   POST /agent-call          { toNumber, contactName, task, lang? } -> 202 { id }
 *                              503 when telephony not configured, 502 when
 *                              the calling service refused the call — both
 *                              carry { fallback:"direct_dial", say } and the
 *                              app dials the contact directly;
 *                              402 over the daily limit.
 *   GET  /agent-call/:id      -> { state, result?, answer? }
 *
 * Provider webhooks (public — mounted WITHOUT appAuth in server.js, gated
 * by a URL secret = sha256(provider api key)[:32]):
 *   POST /agent-call/bolna/webhook/:secret
 */

const express = require("express");
const crypto = require("crypto");
const agent = require("../agents/agentCall");
const { safeEqual } = require("../services/safeCompare");

function uidOf(req) {
  const id = Number(req.user?.sub);
  return Number.isInteger(id) && id > 0 ? id : null;
}
function firstName(req) {
  const n = req.user?.name;
  return n ? String(n).split(" ")[0] : null;
}

/** 503 body: the same fallback as a failed call, and why. */
function notConfigured(name) {
  return {
    error: "agent calling not configured",
    fallback: "direct_dial",
    say: `I can't place calls myself on this setup, so I'm dialling ${name} from your phone.`,
  };
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
    return res.status(503).json(notConfigured(contactName));
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
      tone: req.body?.tone,
      // "in a male voice": woman (default) or man — agentCall.pickGender.
      gender: req.body?.voice,
    });
    res.status(202).json({ id });
  } catch (e) {
    if (e?.code === "unavailable") {
      return res.status(503).json(notConfigured(contactName));
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
    // THE CALLING SERVICE SAID NO — and the owner still needs the call.
    //
    // 2026-09-24: every relay died on the service rejecting our caller
    // number. The phone already dials the contact itself on any failure
    // here; what it lacked was the words. So the answer carries the same
    // fallback as "not configured" — dial directly — and the sentence to
    // say, so no build is left with a dialler opening and nothing said.
    // The service's own reply is logged (numbers blanked) and filed for
    // the developer inside agent.start; it never reaches the owner.
    if (!e?.reason) {
      // Not the service's refusal (that is logged where it happens) —
      // something of ours. Logged with any number blanked.
      console.error("agent-call start error:", agent.redactNumbers(e?.message || e));
    }
    res.status(502).json({
      error: "could not start call",
      reason: e?.reason === "caller_rejected" ? "call_service_rejected" : "call_service_failed",
      fallback: "direct_dial",
      say: callServiceFailedLine(contactName),
    });
  }
});

/** What the owner hears when the relay could not be placed. */
function callServiceFailedLine(name) {
  return (
    `I couldn't place the call through my calling service just now, so ` +
    `I'm dialling ${name} from your phone — you can tell them yourself.`
  );
}

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
    // Constant-time: the derivation stays (it is baked into the webhook URL
    // configured at the provider), only the comparison stops leaking.
    if (!key || !safeEqual(String(req.params.secret || ""), want)) {
      return res.status(404).json({ error: "not found" });
    }
    try {
      handle(req.body || {});
    } catch (e) {
      console.error(`${envKey} webhook failed:`, e.message);
    }
    res.json({ ok: true });
  });
  // MID-CALL TOOLS: the live call asks us something (note_for_user,
  // check_free_time — callAgentConfig.apiTools). Same secret, same
  // public mount; the body names the call by its reference.
  r.post("/tool/:secret/:name", async (req, res) => {
    const key = process.env[envKey] || "";
    const want = crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
    if (!key || !safeEqual(String(req.params.secret || ""), want)) {
      return res.status(404).json({ error: "not found" });
    }
    try {
      const out = await agent.tool(String(req.params.name || ""), req.body || {});
      res.json(out);
    } catch (e) {
      console.error(`${envKey} tool failed:`, e.message);
      res.json({ ok: false, error: "tool failed" });
    }
  });
  // INBOUND CALLER LOOKUP (2026-10-03): before the inbound agent speaks,
  // Bolna asks who is calling (GET, ?contact_number=…, 3 s budget).
  r.get("/inbound/:secret", async (req, res) => {
    const key = process.env[envKey] || "";
    const want = crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
    if (!key || !safeEqual(String(req.params.secret || ""), want)) {
      return res.status(404).json({ error: "not found" });
    }
    const lookup = require("../agents/inboundCalls").lookup(String(req.query.contact_number || ""));
    const timeout = new Promise((ok) => setTimeout(() => ok({ caller_kind: "unknown" }), 2500));
    res.json(await Promise.race([lookup, timeout]));
  });
  return r;
}

const bolnaWebhooks = providerWebhook("BOLNA_API_KEY", agent.bolnaWebhook);

module.exports = { router, bolnaWebhooks };
