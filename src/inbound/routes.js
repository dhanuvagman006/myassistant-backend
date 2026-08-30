/**
 * INBOUND ROUTES.
 *
 * Public (Plivo calls these — NO app auth; mounted before appAuth):
 *   POST /inbound/plivo/answer                    -> Plivo XML, greets the caller
 *   POST /inbound/plivo/:id/:token/gather         -> Plivo XML, one spoken turn
 *   POST /inbound/plivo/:id/:token/hangup         -> 204, files the call
 *
 * The answer webhook is unauthenticated by necessity — Plivo cannot carry
 * our app key — but it is safe: it reveals nothing, and it only proceeds if
 * the DIALLED number is one we have assigned to a user. The follow-up
 * webhooks carry a per-call random token in the path, so a guessed call id
 * is useless on its own.
 *
 * App-facing (behind appAuth):
 *   GET   /inbound/settings          -> current screening configuration
 *   PATCH /inbound/settings          -> update it
 *   GET   /inbound/calls             -> the call log (?unseen=1)
 *   POST  /inbound/calls/seen        -> mark read
 *   GET   /inbound/number            -> the user's assigned Hari number
 */
const express = require("express");
const receptionist = require("./receptionist");
const { one, run } = require("../db");

/* ---------------- PUBLIC WEBHOOKS ---------------- */

const webhooks = express.Router();
webhooks.use(express.urlencoded({ extended: false }));

function sendXml(res, xml) {
  res.set("Content-Type", "text/xml").send(xml);
}

/** Any failure must still produce valid XML, or the caller hears silence. */
function byeXml(msg = "Sorry, something went wrong. Goodbye.") {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Speak>${msg}</Speak><Hangup/></Response>`
  );
}

webhooks.post("/answer", async (req, res) => {
  try {
    const xml = await receptionist.onAnswer({
      to: req.body?.To || req.body?.to,
      from: req.body?.From || req.body?.from,
      callUuid: req.body?.CallUUID,
    });
    sendXml(res, xml);
  } catch (e) {
    console.error("inbound answer error:", e.message || e);
    sendXml(res, byeXml());
  }
});

webhooks.post("/:id/:token/gather", async (req, res) => {
  const rec = receptionist.get(req.params.id, req.params.token);
  if (!rec) return sendXml(res, byeXml("Sorry, this call has expired. Goodbye."));
  try {
    sendXml(res, await receptionist.onGather(rec, req.body || {}));
  } catch (e) {
    console.error("inbound gather error:", e.message || e);
    sendXml(res, byeXml("Sorry, I didn't get that. Goodbye."));
  }
});

webhooks.post("/:id/:token/hangup", async (req, res) => {
  const rec = receptionist.get(req.params.id, req.params.token);
  // Plivo's <Dial action=…> also posts here when a forwarded call ends, and
  // expects XML back rather than a bare 204.
  const wantsXml = Boolean(req.body?.DialStatus || req.body?.DialAction);
  if (rec) {
    try {
      await receptionist.onHangup(rec, req.body || {});
    } catch (e) {
      console.error("inbound hangup error:", e.message || e);
    }
  }
  if (wantsXml) return sendXml(res, `<?xml version="1.0" encoding="UTF-8"?><Response/>`);
  res.status(204).end();
});

/* ---------------- APP-FACING ---------------- */

const router = express.Router();

function uid(req) {
  const n = Number(req.user?.sub);
  return Number.isInteger(n) && n > 0 ? n : null;
}

router.get("/settings", async (req, res) => {
  const u = uid(req);
  if (!u) return res.status(401).json({ error: "unauthorized" });
  try {
    const s = await receptionist.getSettings(u);
    res.json({
      ...s,
      // The app shows this so the user knows whether the feature can work
      // at all on this deployment.
      available: receptionist.enabled(),
    });
  } catch (e) {
    res.status(500).json({ error: "could not read settings" });
  }
});

router.patch("/settings", async (req, res) => {
  const u = uid(req);
  if (!u) return res.status(401).json({ error: "unauthorized" });
  const b = req.body || {};
  const patch = {};
  if (b.enabled !== undefined) patch.enabled = b.enabled === true;
  if (b.mode !== undefined) {
    if (!["screen_all", "screen_unknown", "take_messages"].includes(b.mode)) {
      return res.status(400).json({ error: "bad mode" });
    }
    patch.mode = b.mode;
  }
  if (b.forward_to !== undefined) patch.forward_to = b.forward_to || null;
  if (b.vip !== undefined) patch.vip = String(b.vip).slice(0, 500);
  if (b.availability !== undefined) patch.availability = String(b.availability).slice(0, 300);
  if (b.may_book !== undefined) patch.may_book = b.may_book === true;
  try {
    res.json(await receptionist.saveSettings(u, patch));
  } catch (e) {
    res.status(500).json({ error: "could not save settings" });
  }
});

router.get("/number", async (req, res) => {
  const u = uid(req);
  if (!u) return res.status(401).json({ error: "unauthorized" });
  const row = await one(`SELECT phone FROM inbound_numbers WHERE user_id=$1`, [u]).catch(() => null);
  res.json({ number: row?.phone || null, available: receptionist.enabled() });
});

router.get("/calls", async (req, res) => {
  const u = uid(req);
  if (!u) return res.status(401).json({ error: "unauthorized" });
  try {
    const calls = await receptionist.listCalls(u, {
      limit: Number(req.query.limit) || 20,
      unseenOnly: req.query.unseen === "1",
    });
    res.json({ calls });
  } catch (e) {
    res.status(500).json({ error: "could not read calls" });
  }
});

router.post("/calls/seen", async (req, res) => {
  const u = uid(req);
  if (!u) return res.status(401).json({ error: "unauthorized" });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : null;
  try {
    await receptionist.markSeen(u, ids);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "could not update" });
  }
});

/* ---------------- ADMIN: number assignment ---------------- */
//
// Assigning a Plivo number to a user is an operational act, not something a
// user may do for themselves — otherwise anyone could claim someone else's
// number and receive their calls. Guarded by ADMIN_KEY, like the rest of
// /admin.

const adminRouter = express.Router();

adminRouter.post("/assign-number", async (req, res) => {
  if (!process.env.ADMIN_KEY || req.get("X-Admin-Key") !== process.env.ADMIN_KEY) {
    return res.status(404).json({ error: "not found" });
  }
  const phone = receptionist.normalize(req.body?.phone);
  const userId = Number(req.body?.user_id);
  if (!phone || !Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: "phone and user_id required" });
  }
  try {
    await run(
      `INSERT INTO inbound_numbers (phone, user_id, created_at) VALUES ($1,$2,$3)
       ON CONFLICT (phone) DO UPDATE SET user_id=$2`,
      [phone, userId, Date.now()]
    );
    res.json({ ok: true, phone, user_id: userId });
  } catch (e) {
    res.status(500).json({ error: "could not assign" });
  }
});

module.exports = { router, webhooks, adminRouter };
