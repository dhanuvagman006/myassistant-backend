/**
 * REQUEST AUTH for protected routes (/chat, and future user data routes).
 *
 * Priority:
 *  1. Session JWT (issued by /auth/*) — `Authorization: Bearer <token>`.
 *     This is the normal production path for email, Google AND Apple users.
 *  2. X-App-Key shared secret — dev fallback, only when ALLOW_APP_KEY=true.
 *  3. AUTH_DISABLED=true — dev only; the server refuses to boot with this
 *     in production (see server.js).
 *
 * On success: req.user = { sub, email, name } where sub is our DB user id.
 */
const jwt = require("jsonwebtoken");
const db = require("../db");

// WHICH BUILD IS THIS USER ON? The app sends X-App-Build on every
// request. Writing that on each one would be a pointless write per call,
// so a process-local cache limits it to a row update when the build
// changes or once an hour (which doubles as a last-seen stamp).
const buildSeen = new Map(); // uid -> { build, at }
function noteAppBuild(uid, req) {
  try {
    const build = Number(req.get("X-App-Build")) || 0;
    const now = Date.now();
    const prev = buildSeen.get(uid);
    if (prev && prev.build === build && now - prev.at < 3600_000) return;
    buildSeen.set(uid, { build, at: now });
    const db2 = require("../db");
    if (build > 0) {
      db2.run(
        `UPDATE users SET app_build=$2, app_build_at=$3, last_seen_at=$3 WHERE id=$1`,
        [uid, build, now]
      ).catch(() => {});
    } else {
      db2.run(`UPDATE users SET last_seen_at=$2 WHERE id=$1`, [uid, now]).catch(() => {});
    }
  } catch (_) {}
}

async function appAuth(req, res, next) {
  if (process.env.AUTH_DISABLED === "true") {
    req.user = { sub: "anonymous-dev", email: null, name: "Dev User" };
    return next();
  }
  try {
    const authz = req.get("Authorization") || "";
    if (authz.startsWith("Bearer ")) {
      const { uid } = jwt.verify(authz.slice(7), process.env.JWT_SECRET);
      const user = await db.findById(uid);
      if (!user) return res.status(401).json({ error: "account not found" });
      req.user = { sub: String(user.id), email: user.email, name: user.name };
      noteAppBuild(user.id, req);
      return next();
    }
    if (
      process.env.ALLOW_APP_KEY === "true" &&
      process.env.APP_API_KEY &&
      req.get("X-App-Key") === process.env.APP_API_KEY
    ) {
      req.user = { sub: "dev", email: "dev@local", name: "Dev" };
      return next();
    }
    return res.status(401).json({ error: "sign in required" });
  } catch (e) {
    return res.status(401).json({ error: "invalid or expired token" });
  }
}

module.exports = { appAuth };
