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

/**
 * THE ONE PLACE A SESSION TOKEN IS JUDGED. REST, /auth/me and the live
 * WebSocket each used to call jwt.verify on their own, which is how the
 * admin panel's "Pause account" came to do nothing: nobody read status.
 *
 * A token is good only if it verifies as HS256 (pinned, not inferred from
 * the token), its account still exists and is not paused, and it was
 * issued after the account's sessions_valid_after (unix seconds) — which
 * is how every outstanding token is revoked at once, e.g. when a password
 * of unproven ownership is removed.
 *
 * @returns {{user}|{error:string, status:number}}
 */
async function verifySession(token) {
  let payload;
  try {
    payload = jwt.verify(String(token || ""), process.env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch (_) {
    return { error: "invalid or expired token", status: 401 };
  }
  const user = await db.findById(payload.uid);
  if (!user) return { error: "account not found", status: 401 };
  // 401, not 403: the app treats 401 as "signed out" and returns to the
  // sign-in screen, where the login routes explain the pause.
  if (user.status === "paused") return { error: "this account is paused", status: 401 };
  const validAfter = Number(user.sessions_valid_after) || 0;
  if (validAfter && Number(payload.iat || 0) < validAfter) {
    return { error: "signed out — please sign in again", status: 401 };
  }
  return { user };
}

async function appAuth(req, res, next) {
  if (process.env.AUTH_DISABLED === "true") {
    req.user = { sub: "anonymous-dev", email: null, name: "Dev User" };
    return next();
  }
  try {
    const authz = req.get("Authorization") || "";
    if (authz.startsWith("Bearer ")) {
      const v = await verifySession(authz.slice(7));
      if (v.error) return res.status(v.status).json({ error: v.error });
      const user = v.user;
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

module.exports = { appAuth, verifySession };
