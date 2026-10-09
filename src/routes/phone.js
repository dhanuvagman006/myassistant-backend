/**
 * Phone verification — the identity spine of agent-to-agent messaging.
 *
 *   GET  /phone          → { phone, verified }
 *   GET  /phone/methods  → { sim, typed }   which ways this server accepts
 *   POST /phone/verify   { pnvToken }      → { ok, phone, user }
 *
 * The number is never taken from the request body. The app runs Firebase
 * Phone Number Verification: Google reads the number of the SIM in the
 * phone from its carrier, with the user's consent, and signs it into a
 * token (services/pnv.js). We verify that token and read the number out of
 * its VERIFIED subject, so a caller cannot assert a number they do not
 * control. The SMS code (Firebase Auth) this replaced was removed on
 * 2026-09-29; builds up to 122 that still send one are told to update.
 *
 * That matters more here than in a typical signup: a phone number is the
 * address other people's agents deliver to. Letting someone claim a number
 * they do not own would let them receive another household member's
 * messages — the "tell mom I'll be late" note would go to a stranger.
 */
const express = require("express");
const db = require("../db");
const pnv = require("../services/pnv");
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

/**
 * THE ACCOUNT MAY BE GONE. 2026-09-25: the owner deleted every account
 * from the admin panel, including the one his own phone was signed in
 * to. The session token still verifies (it is signed, not looked up), so
 * both verify paths ran against a user that no longer exists, crashed
 * reading it back (publicUser(null)), and the app showed its catch-all
 * "Could not reach the server". Say what actually happened, as JSON the
 * app already displays, before touching anything.
 */
const ACCOUNT_GONE = "This account no longer exists. Tap Sign out, then sign in again.";
async function accountGone(uid) {
  return !(await db.findById(uid).catch(() => null));
}

const TAKEN = "This number is already registered to another account.";

/**
 * Give [phone] to [uid] as its verified number. One number, one account:
 * deliberately a hard stop rather than a silent move — agent messages are
 * addressed by number, so reassigning one would redirect a real person's
 * mail. Answers the request itself when it cannot (409) and returns false.
 */
async function assignNumber(uid, phone, res) {
  const existing = await db.one(
    `SELECT id FROM users WHERE phone_number = $1 LIMIT 1`,
    [phone]
  );
  if (existing && existing.id !== uid) {
    res.status(409).json({ error: TAKEN });
    return false;
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
      res.status(409).json({ error: TAKEN });
      return false;
    }
    throw e;
  }
  return true;
}

// What the verify screen may offer. "sim" is Phone Number Verification;
// "typed" is the testing switch below. The app asks rather than assumes.
router.get("/methods", (_req, res) =>
  res.json({ sim: pnv.configured(), typed: devVerifyAllowed() })
);

router.post("/verify", async (req, res) => {
  const uid = Number(req.user?.sub);
  if (!Number.isFinite(uid)) return res.status(401).json({ error: "unauthorized" });
  // Builds up to 122 send the SMS code's Firebase ID token; that way in is
  // gone. The old app shows this text as it stands.
  if (req.body?.firebaseIdToken && !req.body?.pnvToken) {
    return res.status(426).json({ error: "Update the app to verify your number." });
  }
  if (!pnv.configured()) {
    return res.status(503).json({ error: "phone verification unavailable" });
  }
  if (await accountGone(uid)) return res.status(401).json({ error: ACCOUNT_GONE });

  const v = await pnv.verify(req.body?.pnvToken);
  if (!v.ok) {
    if (v.error === "unavailable") {
      return res.status(503).json({ error: "Couldn't reach Google to check your number. Try again in a minute." });
    }
    if (v.error === "expired") {
      return res.status(401).json({ error: "That confirmation expired. Tap Confirm again." });
    }
    return res.status(401).json({ error: "invalid verification token" });
  }

  // Google already emits E.164, but normalise anyway: this is the single
  // point where a number enters the system, and everything downstream is an
  // exact-string match.
  const phone = normalizePhone(v.phone);
  if (!phone) return res.status(400).json({ error: "phone number not usable" });

  // A retry after a lost reply: already theirs, nothing to do.
  const me = await db.findById(uid);
  if (me && me.phone_number === phone && me.phone_verified_at) {
    return res.json({ ok: true, phone, user: db.publicUser(me) });
  }
  if (!(await pnv.claimOnce(v.hash, v.expiresAt))) {
    return res.status(401).json({ error: "This confirmation was already used. Tap Confirm again." });
  }
  if (!(await assignNumber(uid, phone, res))) return;

  const user = await db.findById(uid);
  res.json({ ok: true, phone, user: db.publicUser(user) });
});

/**
 * TESTING ONLY — register a number by typing it.
 *
 * Phone Number Verification works only where Google has a deal with the
 * carrier, and in September 2026 that is 12 countries, India not among
 * them: without this switch no tester in India could finish signing up
 * (agent-to-agent messaging is addressed BY phone number). This lets a
 * number be claimed by typing it.
 *
 * GATING: an ungated version of this endpoint is a complete
 * account-takeover primitive — anyone could claim anyone's number and
 * receive their messages. The ALLOW_DEV_PHONE_VERIFY flag is the single
 * gate (the old extra NODE_ENV!=production check was dropped 2026-08-30 at
 * the owner's request so investor-demo/testing phones can register by
 * typing a number in the production deployment); the number still goes
 * through normalisation AND the uniqueness rule.
 *
 * ██ BEFORE MARKET RELEASE: set ALLOW_DEV_PHONE_VERIFY=false (Phone Number
 * ██ Verification in production mode is then the only way in). The boot
 * ██ warning below exists so this cannot be forgotten.
 */
const devVerifyAllowed = () => process.env.ALLOW_DEV_PHONE_VERIFY === "true";
const devTries = new Map(); // uid -> [ms] of typed claims in the last day

if (devVerifyAllowed()) {
  console.warn(
    "⚠️  ALLOW_DEV_PHONE_VERIFY is ON: phone numbers can be claimed by " +
      "typing them (no proof). Testing only — MUST be off for market release."
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
  if (await accountGone(uid)) return res.status(401).json({ error: ACCOUNT_GONE });

  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: "Enter a valid phone number." });
  // Typed claims carry no proof: a few a day per account, so nobody can
  // walk through numbers looking for unclaimed ones (security review).
  const tries = (devTries.get(uid) || []).filter((t) => Date.now() - t < 86400_000);
  if (tries.length >= 5) {
    return res.status(429).json({ error: "Too many tries today. Please try again tomorrow." });
  }
  devTries.set(uid, [...tries, Date.now()]);

  if (!(await assignNumber(uid, phone, res))) return;

  console.warn(`phone: DEV verify (typed) — user ${uid} claimed ${phone}`);
  const user = await db.findById(uid);
  res.json({ ok: true, phone, user: db.publicUser(user) });
});

module.exports = router;
module.exports.ACCOUNT_GONE = ACCOUNT_GONE;
