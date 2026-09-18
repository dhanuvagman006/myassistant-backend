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

module.exports = router;
