/**
 * AUTH ROUTES
 * -----------
 * POST /auth/signup  { email, password, name }        → { token, user }
 * POST /auth/login   { email, password }              → { token, user }
 * POST /auth/google  { idToken }                      → { token, user }
 * POST /auth/apple   { identityToken, name? }         → { token, user }
 * GET  /auth/me      (Authorization: Bearer <token>)  → { user }
 *
 * All flows end the same way: we issue OUR OWN session JWT (30 days).
 * The app stores that one token and sends it on every request — it never
 * needs to juggle Google/Apple token refresh.
 */
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { createRemoteJWKSet, jwtVerify } = require("jose");

const db = require("../db");
const { verifySession } = require("../middleware/auth");

const JWT_SECRET = process.env.JWT_SECRET;
const SESSION_DAYS = 30;

const googleClient = new OAuth2Client();
// Apple publishes its signing keys here; jose caches them for us.
const appleJwks = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

function issueSession(user) {
  return jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
}

function respond(res, user, isNew = false) {
  // Every sign-in path ends here, so a paused account is refused here —
  // verifySession then keeps any token it already holds from working.
  if (user.status === "paused") {
    return res.status(403).json({ error: "this account is paused — contact support" });
  }
  // isNew → the app shows the one-time sign-up interview.
  res.json({ token: issueSession(user), user: db.publicUser(user), isNew });
}

/** Apple sends email_verified as a boolean or as the string "true". */
const isTrue = (v) => v === true || v === "true";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------- EMAIL ----------------

router.post("/signup", async (req, res) => {
  const { email, password, name, gender } = req.body || {};
  if (!EMAIL_RE.test(email || "")) {
    return res.status(400).json({ error: "valid email required" });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }
  if (await db.findByEmail(email)) {
    return res.status(409).json({ error: "an account with this email already exists" });
  }
  const user = await db.createUser({
    email,
    name: typeof name === "string" ? name.trim().slice(0, 100) : null,
    passwordHash: await bcrypt.hash(password, 10),
    provider: "email",
    gender: db.cleanGender(gender),
  });
  respond(res, user, true);
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  const user = email ? await db.findByEmail(email) : null;
  // Same error for "no user" and "wrong password" — don't leak which emails exist.
  if (!user || !user.password_hash || !(await bcrypt.compare(password || "", user.password_hash))) {
    return res.status(401).json({ error: "incorrect email or password" });
  }
  respond(res, user);
});

// ---------------- GOOGLE ----------------

/**
 * Which Google web clients may mint a sign-in token for us. Normally one:
 * GOOGLE_WEB_CLIENT_ID. During a move to a new OAuth client, installed
 * apps still carry the OLD client id until they update, so
 * GOOGLE_WEB_CLIENT_ID_LEGACY (comma-separated) keeps them signing in.
 * Google's `sub` is the same person across clients, so an account signed
 * in through either one is the same account. Remove the legacy value once
 * every install is on the new build.
 */
function googleAudiences() {
  const legacy = String(process.env.GOOGLE_WEB_CLIENT_ID_LEGACY || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return [process.env.GOOGLE_WEB_CLIENT_ID, ...legacy].filter(Boolean);
}

router.post("/google", async (req, res) => {
  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: "idToken required" });
  // With no audience, verifyIdToken accepts a token minted for ANY Google
  // app — refuse rather than skip the check.
  if (!process.env.GOOGLE_WEB_CLIENT_ID) {
    return res.status(503).json({ error: "Google sign-in is not configured on this server" });
  }
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: googleAudiences(),
    });
    const p = ticket.getPayload();
    const { user, created } = await db.upsertSocialUser({
      provider: "google",
      sub: p.sub,
      email: p.email,
      emailVerified: p.email_verified === true,
      name: p.name,
    });
    respond(res, user, created);
  } catch (e) {
    console.error("Google verifyIdToken error:", e);
    res.status(401).json({ error: "invalid Google token" });
  }
});

// ---------------- APPLE ----------------

router.post("/apple", async (req, res) => {
  const { identityToken, name } = req.body || {};
  if (!identityToken) return res.status(400).json({ error: "identityToken required" });
  // jose skips the audience check when it is undefined — same hole as Google.
  if (!process.env.APPLE_BUNDLE_ID) {
    return res.status(503).json({ error: "Apple sign-in is not configured on this server" });
  }
  try {
    const { payload } = await jwtVerify(identityToken, appleJwks, {
      issuer: "https://appleid.apple.com",
      audience: process.env.APPLE_BUNDLE_ID, // e.g. com.yourorg.myassistant
    });
    const { user, created } = await db.upsertSocialUser({
      provider: "apple",
      sub: payload.sub,
      email: payload.email || null,
      emailVerified: isTrue(payload.email_verified),
      // Apple only sends the name on FIRST sign-in, and only to the app —
      // the app forwards it here so we don't lose it.
      name: typeof name === "string" ? name.trim().slice(0, 100) : null,
    });
    respond(res, user, created);
  } catch {
    res.status(401).json({ error: "invalid Apple token" });
  }
});

// ---------------- SESSION ----------------

router.patch("/me", async (req, res) => {
  const authz = req.get("Authorization") || "";
  if (!authz.startsWith("Bearer ")) return res.status(401).json({ error: "token required" });
  try {
    const v = await verifySession(authz.slice(7));
    if (v.error) return res.status(v.status).json({ error: v.error });
    const uid = v.user.id;
    const { gender } = req.body || {};
    if (gender !== undefined && db.cleanGender(gender) === null && gender !== null) {
      return res.status(400).json({ error: "gender must be male, female or other" });
    }
    const user = await db.setGender(uid, gender);
    if (!user) return res.status(401).json({ error: "account not found" });
    res.json({ user: db.publicUser(user) });
  } catch (_) {
    res.status(401).json({ error: "invalid or expired session" });
  }
});

router.get("/me", async (req, res) => {
  const authz = req.get("Authorization") || "";
  if (!authz.startsWith("Bearer ")) return res.status(401).json({ error: "token required" });
  try {
    const v = await verifySession(authz.slice(7));
    if (v.error) return res.status(v.status).json({ error: v.error });
    res.json({ user: db.publicUser(v.user) });
  } catch {
    res.status(401).json({ error: "invalid or expired session" });
  }
});

module.exports = router;
module.exports.googleAudiences = googleAudiences; // tests
