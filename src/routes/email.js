/**
 * EMAIL ACCOUNT ROUTES (behind appAuth)
 *
 *   GET    /email/account   -> { connected, address? }   (never the password)
 *   POST   /email/account   -> { address, password, imapHost?, smtpHost? }
 *                              tests BOTH logins before storing; 400 with a
 *                              human reason on failure so the app can show it
 *   DELETE /email/account   -> disconnect + forget credentials
 */

const express = require("express");
const email = require("../services/email");

const router = express.Router();

function uidOf(req) {
  const id = Number(req.user?.sub);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.get("/account", async (req, res) => {
  try {
    const acc = await email.getAccount(uidOf(req));
    res.json(acc ? { connected: true, address: acc.address } : { connected: false });
  } catch (e) {
    console.error("email account read:", e.message || e);
    res.status(500).json({ error: "could not read email account" });
  }
});

router.post("/account", async (req, res) => {
  try {
    const out = await email.connectAccount(uidOf(req), {
      address: req.body?.address,
      password: req.body?.password,
      imapHost: req.body?.imapHost,
      smtpHost: req.body?.smtpHost,
    });
    res.json({ connected: true, address: out.address });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

router.delete("/account", async (req, res) => {
  try {
    await email.disconnectAccount(uidOf(req));
    res.json({ connected: false });
  } catch (e) {
    console.error("email disconnect:", e.message || e);
    res.status(500).json({ error: "could not disconnect" });
  }
});

/**
 * GET /email/inbox?limit=12 — the IMPORTANT mail, for the Email screen.
 *
 * Promotions, social, updates, forums, spam and trash are excluded by the
 * query itself (his spec: "the most important emails, filtering all the
 * spam as well as promotional and unwanted"). Works for either backend —
 * the Google link or an IMAP account.
 */
router.get("/inbox", async (req, res) => {
  try {
    const messages = await email.listRecent(uidOf(req), {
      limit: Math.min(Number(req.query.limit) || 12, 25),
      important: true,
    });
    res.json({ connected: true, messages });
  } catch (e) {
    if (e?.code === "no_account") {
      return res.json({ connected: false, messages: [] });
    }
    console.error("email inbox:", e.message || e);
    res.status(502).json({ error: "mailbox unreachable" });
  }
});

/** GET /email/message/:id — one message in full, for the detail view. */
router.get("/message/:id", async (req, res) => {
  try {
    const m = await email.readBody(uidOf(req), req.params.id);
    if (!m) return res.status(404).json({ error: "not found" });
    res.json(m);
  } catch (e) {
    if (e?.code === "no_account") return res.status(409).json({ error: "not linked" });
    res.status(502).json({ error: "mailbox unreachable" });
  }
});

/** POST /email/send { to, subject, body } — used by the app's reply box. */
router.post("/send", async (req, res) => {
  try {
    const out = await email.send(uidOf(req), {
      to: req.body?.to,
      subject: req.body?.subject,
      body: req.body?.body,
    });
    res.json({ ok: true, draft: Boolean(out.draft) });
  } catch (e) {
    if (e?.code === "no_account") return res.status(409).json({ error: "not linked" });
    if (e?.code === "bad_address") return res.status(400).json({ error: "invalid address" });
    console.error("email send:", e.message || e);
    res.status(502).json({ error: "could not send" });
  }
});

module.exports = router;
