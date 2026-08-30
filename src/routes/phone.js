/**
 * Phone verification — the identity spine of agent-to-agent messaging.
 *
 *   POST /phone/verify   { firebaseIdToken }  → { ok, phone, user }
 *   GET  /phone          → { phone, verified }
 *
 * The number is never taken from the request body. The app runs Firebase's
 * SMS OTP, and Firebase mints a token containing phone_number only after
 * the code was entered on the handset that received it. We verify that
 * token server-side and read the number out of the VERIFIED claims, so a
 * caller cannot assert a number they do not control.
 *
 * That matters more here than in a typical signup: a phone number is the
 * address other people's agents deliver to. Letting someone claim a number
 * they do not own would let them receive another household member's
 * messages — the "tell mom I'll be late" note would go to a stranger.
 */
const express = require("express");
const db = require("../db");
const { verifyIdToken, configured } = require("../services/firebase");
const { normalizePhone } = require("../users/phone");

const router = express.Router();

router.get("/", async (req, res) => {
  const user = await db.findById(Number(req.user?.sub));
  if (!user) return res.status(404).json({ error: "user not found" });
  res.json({
    phone: user.phone_number || null,
    verified: Boolean(user.phone_verified_at),
  });
});

router.post("/verify", async (req, res) => {
  if (!configured()) {
    return res.status(503).json({ error: "phone verification unavailable" });
  }
  const uid = Number(req.user?.sub);
  if (!Number.isFinite(uid)) return res.status(401).json({ error: "unauthorized" });

  const decoded = await verifyIdToken(req.body?.firebaseIdToken);
  if (!decoded) return res.status(401).json({ error: "invalid verification token" });

  // Present only when the token came from a phone sign-in that completed.
  const claimed = decoded.phone_number || decoded.phoneNumber || null;
  if (!claimed) {
    return res.status(400).json({ error: "token carries no verified phone number" });
  }

  // Firebase already emits E.164, but normalise anyway: this is the single
  // point where a number enters the system, and everything downstream is an
  // exact-string match.
  const phone = normalizePhone(claimed);
  if (!phone) return res.status(400).json({ error: "phone number not usable" });

  const existing = await db.one(
    `SELECT id FROM users WHERE phone_number = $1 LIMIT 1`,
    [phone]
  );
  if (existing && existing.id !== uid) {
    // One number, one account. Deliberately a hard stop rather than a
    // silent move: agent messages are addressed by number, so reassigning
    // one would redirect a real person's mail.
    return res.status(409).json({
      error: "This number is already registered to another account.",
    });
  }

  try {
    await db.run(
      `UPDATE users SET phone_number = $1, phone_verified_at = $2 WHERE id = $3`,
      [phone, Date.now(), uid]
    );
  } catch (e) {
    // The partial unique index is the real guarantee; the SELECT above only
    // makes the common case a friendly message. Two devices verifying the
    // same number at once land here.
    if (/duplicate key|unique/i.test(String(e.message))) {
      return res.status(409).json({
        error: "This number is already registered to another account.",
      });
    }
    throw e;
  }

  const user = await db.findById(uid);
  res.json({ ok: true, phone, user: db.publicUser(user) });
});

/**
 * DEV ONLY — register a number with no OTP.
 *
 * Firebase Phone Auth needs the Blaze plan to send real SMS, which blocks
 * every downstream feature (agent-to-agent messaging is addressed BY phone
 * number) while that is being sorted out. This lets a number be claimed by
 * typing it.
 *
 * GATING: an ungated version of this endpoint is a complete
 * account-takeover primitive — anyone could claim anyone's number and
 * receive their messages. The ALLOW_DEV_PHONE_VERIFY flag is the single
 * gate (the old extra NODE_ENV!=production check was dropped 2026-08-30 at
 * the owner's request so investor-demo/testing phones can register by
 * typing a number in the production deployment); the number still goes
 * through normalisation AND the uniqueness rule.
 *
 * ██ BEFORE MARKET RELEASE: set ALLOW_DEV_PHONE_VERIFY=false (and enable
 * ██ Firebase Phone Auth / Blaze for real OTP). The boot warning below
 * ██ exists so this cannot be forgotten.
 */
const devVerifyAllowed = () => process.env.ALLOW_DEV_PHONE_VERIFY === "true";

if (devVerifyAllowed()) {
  console.warn(
    "⚠️  ALLOW_DEV_PHONE_VERIFY is ON: phone numbers can be claimed by " +
      "typing them (no OTP). Testing only — MUST be off for market release."
  );
}

router.get("/dev-available", (_req, res) =>
  res.json({ available: devVerifyAllowed() })
);

router.post("/dev-verify", async (req, res) => {
  if (!devVerifyAllowed()) {
    return res.status(403).json({ error: "not available" });
  }
  const uid = Number(req.user?.sub);
  if (!Number.isFinite(uid)) return res.status(401).json({ error: "unauthorized" });

  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: "Enter a valid phone number." });

  const existing = await db.one(
    `SELECT id FROM users WHERE phone_number = $1 LIMIT 1`,
    [phone]
  );
  if (existing && existing.id !== uid) {
    return res.status(409).json({
      error: "This number is already registered to another account.",
    });
  }

  try {
    await db.run(
      `UPDATE users SET phone_number = $1, phone_verified_at = $2 WHERE id = $3`,
      [phone, Date.now(), uid]
    );
  } catch (e) {
    if (/duplicate key|unique/i.test(String(e.message))) {
      return res.status(409).json({
        error: "This number is already registered to another account.",
      });
    }
    throw e;
  }

  console.warn(`phone: DEV verify (no OTP) — user ${uid} claimed ${phone}`);
  const user = await db.findById(uid);
  res.json({ ok: true, phone, user: db.publicUser(user) });
});

module.exports = router;
