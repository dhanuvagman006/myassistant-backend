/**
 * THE WEB DEVELOPER CONSOLE (2026-10-14) — /console.
 *
 * The owner: "build the web developer console too". Developers copy keys
 * into code on a laptop, so connected apps are managed in the browser as
 * the app's Hub → Your own apps only shows them (the owner: "remove from phone app"). Same account, same API
 * (manage.js), different sign-in:
 *
 *   POST /console/auth/code      { identifier }        email or phone number
 *        → a 6-digit code is pushed to the phone signed in to that account.
 *          Works with every app build (it is an ordinary notification).
 *          The answer never says whether the account exists.
 *   POST /console/auth/verify    { identifier, code }  → { token, user }
 *   POST /console/auth/password  { email, password }   → { token, user }
 *   GET  /console/auth/me                              → { user }
 *   /console/api/*               manage.js, behind the console token
 *
 * The console token is NOT a session: scope "console", 12 hours, accepted
 * only on /console/api — a token left in a browser cannot read the user's
 * chats, documents or memory, only their connected apps. It dies with the
 * account's sessions_valid_after (sign out everywhere) like a session.
 *
 * Codes: 6 digits, kept as a hash, 5 minutes, 5 tries; at most 3 codes per
 * account per 15 minutes; per-IP limits on every auth route.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { query, one, run } = db;

const SCOPE = "console";
const TOKEN_HOURS = 12;
const CODE_MS = 5 * 60_000;
const MAX_TRIES = 5;
const MAX_CODES = 3;
const CODES_WINDOW_MS = 15 * 60_000;

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS platform_console_codes (
        id          BIGSERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        code_hash   TEXT    NOT NULL,
        tries       INTEGER NOT NULL DEFAULT 0,
        used        BOOLEAN NOT NULL DEFAULT false,
        created_at  BIGINT  NOT NULL,
        expires_at  BIGINT  NOT NULL
      );
      CREATE INDEX IF NOT EXISTS platform_console_codes_user ON platform_console_codes (user_id, id DESC);
    `).catch((e) => { migrated = null; throw e; });
  }
  return migrated;
}

const hashCode = (uid, code) =>
  crypto.createHmac("sha256", String(process.env.JWT_SECRET || "")).update(`${uid}:${code}`).digest("hex");

function issue(user) {
  return jwt.sign({ uid: user.id, scope: SCOPE }, process.env.JWT_SECRET, {
    algorithm: "HS256", expiresIn: `${TOKEN_HOURS}h`,
  });
}

const publicUser = (u) => ({ name: u.name || "", email: u.email || "" });

/** An account by email, or by a verified phone number (last 10 digits). */
async function findAccount(identifier) {
  const id = String(identifier || "").trim();
  if (!id) return null;
  if (id.includes("@")) return db.findByEmail(id.toLowerCase()).catch(() => null) || null;
  const digits = id.replace(/[^0-9]/g, "");
  if (digits.length < 10) return null;
  return one(
    `SELECT * FROM users
      WHERE phone_verified_at IS NOT NULL
        AND right(regexp_replace(COALESCE(phone_number,''), '[^0-9]', '', 'g'), 10) = $1
      ORDER BY id LIMIT 1`, [digits.slice(-10)]).catch(() => null);
}

/** The console-token gate for /console/api. */
async function consoleAuth(req, res, next) {
  const authz = req.get("Authorization") || "";
  if (!authz.startsWith("Bearer ")) return res.status(401).json({ error: "sign in to the developer console" });
  let p;
  try {
    p = jwt.verify(authz.slice(7), process.env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch (_) {
    return res.status(401).json({ error: "your console sign-in has expired — sign in again" });
  }
  if (p.scope !== SCOPE) return res.status(401).json({ error: "sign in to the developer console" });
  try {
    const user = await db.findById(p.uid);
    if (!user || user.status === "paused") return res.status(401).json({ error: "this account is not available" });
    const after = Number(user.sessions_valid_after) || 0;
    if (after && Number(p.iat || 0) < after) return res.status(401).json({ error: "signed out — sign in again" });
    req.user = { sub: String(user.id), email: user.email, name: user.name };
    req.auth = { scope: SCOPE, tzOffsetMin: user.tz_offset_min ?? null };
    next();
  } catch (e) {
    console.warn("[console] auth check failed:", e && e.message);
    res.status(503).json({ error: "A brief hiccup — please try again in a moment." });
  }
}

const authLimit = rateLimit({
  windowMs: 10 * 60_000,
  max: Number(process.env.CONSOLE_AUTH_PER_10MIN) || 30,
  standardHeaders: true,
  handler: (req, res) => res.status(429).json({ error: "Too many tries — wait a few minutes and try again." }),
});

const auth = express.Router();
auth.use(authLimit);

const SENT = "If that account uses My Assistant on a phone, a 6-digit code is on its way there. It expires in 5 minutes.";

auth.post("/code", async (req, res) => {
  await migrate();
  const user = await findAccount(req.body && req.body.identifier);
  // The same answer whether or not the account exists.
  if (!user || user.status === "paused" || !user.fcm_token) return res.json({ ok: true, message: SENT });
  const recent = await one(
    `SELECT COUNT(*)::int AS n FROM platform_console_codes WHERE user_id=$1 AND created_at > $2`,
    [user.id, Date.now() - CODES_WINDOW_MS]);
  if (recent && recent.n >= MAX_CODES) return res.json({ ok: true, message: SENT });
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const now = Date.now();
  await run(
    `INSERT INTO platform_console_codes (user_id, code_hash, created_at, expires_at) VALUES ($1,$2,$3,$4)`,
    [user.id, hashCode(user.id, code), now, now + CODE_MS]);
  // Older codes for this account stop working.
  await run(`UPDATE platform_console_codes SET used=true WHERE user_id=$1 AND created_at < $2`, [user.id, now]);
  const r = await require("../services/push").send(user.fcm_token,
    "Developer console sign-in",
    `Your code is ${code}. It expires in 5 minutes. If you didn't ask for it, ignore this.`,
    { kind: "console_code" }).catch(() => ({ ok: false }));
  if (!r || !r.ok) console.warn(`[console] code push to user ${user.id} failed`);
  try { require("../audit/log").record(user.id, "console.code.sent", "A developer console sign-in code was sent to your phone"); } catch (_) {}
  res.json({ ok: true, message: SENT });
});

auth.post("/verify", async (req, res) => {
  await migrate();
  const b = req.body || {};
  const code = String(b.code || "").replace(/\s+/g, "");
  const bad = () => res.status(401).json({ error: "That code isn't right or has expired. Ask for a new one." });
  if (!/^\d{6}$/.test(code)) return bad();
  const user = await findAccount(b.identifier);
  if (!user) return bad();
  const row = await one(
    `SELECT * FROM platform_console_codes
      WHERE user_id=$1 AND used=false AND expires_at > $2 ORDER BY id DESC LIMIT 1`, [user.id, Date.now()]);
  if (!row) return bad();
  if (row.tries >= MAX_TRIES) {
    await run(`UPDATE platform_console_codes SET used=true WHERE id=$1`, [row.id]);
    return bad();
  }
  const want = Buffer.from(row.code_hash, "hex");
  const got = Buffer.from(hashCode(user.id, code), "hex");
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
    await run(`UPDATE platform_console_codes SET tries = tries + 1 WHERE id=$1`, [row.id]);
    return bad();
  }
  await run(`UPDATE platform_console_codes SET used=true WHERE id=$1`, [row.id]);
  if (user.status === "paused") return res.status(403).json({ error: "This account is paused." });
  try { require("../audit/log").record(user.id, "console.signin", "Signed in to the developer console (code from your phone)"); } catch (_) {}
  res.json({ token: issue(user), user: publicUser(user), expiresInHours: TOKEN_HOURS });
});

auth.post("/password", async (req, res) => {
  const { email, password } = req.body || {};
  const user = email ? await db.findByEmail(String(email).toLowerCase()).catch(() => null) : null;
  if (!user || !user.password_hash || !(await bcrypt.compare(String(password || ""), user.password_hash))) {
    return res.status(401).json({ error: "That email and password don't match. Signed up with Google or your phone? Use a code instead." });
  }
  if (user.status === "paused") return res.status(403).json({ error: "This account is paused." });
  try { require("../audit/log").record(user.id, "console.signin", "Signed in to the developer console (password)"); } catch (_) {}
  res.json({ token: issue(user), user: publicUser(user), expiresInHours: TOKEN_HOURS });
});

auth.get("/me", consoleAuth, async (req, res) => {
  res.json({ user: { name: req.user.name || "", email: req.user.email || "" } });
});

let page = null;
function consolePage(req, res) {
  if (!page) page = fs.readFileSync(path.join(__dirname, "console.html"), "utf8");
  const base = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.send(page.split("{{BASE}}").join(base));
}

module.exports = { auth, consoleAuth, consolePage, migrate, SCOPE, issue, findAccount, USER_TABLES: [["platform_console_codes", "user_id"]] };
