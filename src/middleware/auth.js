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
const { offsetOr } = require("../services/tz");

// WHICH BUILD IS THIS USER ON? The app sends X-App-Build on every
// request. Writing that on each one would be a pointless write per call,
// so a process-local cache limits it to a row update when the build
// changes or once an hour (which doubles as a last-seen stamp).
// The timezone rides along: background work (quiet hours, the morning
// brief, commitment nudges) has no request to read it from.
const buildSeen = new Map(); // uid -> { build, tz, at }
function noteAppBuild(uid, req) {
  try {
    const build = Number(req.get("X-App-Build")) || 0;
    const tz = offsetOr(req.get("X-TZ-Offset"), null);
    const now = Date.now();
    const prev = buildSeen.get(uid);
    if (prev && prev.build === build && prev.tz === tz && now - prev.at < 3600_000) return;
    buildSeen.set(uid, { build, tz, at: now });
    const db2 = require("../db");
    if (build > 0) {
      db2.run(
        `UPDATE users SET app_build=$2, app_build_at=$3, last_seen_at=$3,
                tz_offset_min=COALESCE($4, tz_offset_min) WHERE id=$1`,
        [uid, build, now, tz]
      ).catch(() => {});
    } else {
      db2.run(
        `UPDATE users SET last_seen_at=$2, tz_offset_min=COALESCE($3, tz_offset_min) WHERE id=$1`,
        [uid, now, tz]
      ).catch(() => {});
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
 * TWO KINDS OF TOKEN (2026-09-29). A session token (no scope claim) opens
 * everything. An ASSISTANT-FUNCTIONS key (scope "appfn", src/appfunctions)
 * is what the phone's background AppFunctionService holds so Gemini can
 * add to the list or set a reminder without the app open: it is refused
 * everywhere except /appfunctions/* (allowAppFn), and dies with the
 * user's appfn_epoch — DELETE /appfunctions/token bumps it, and every key
 * issued before stops working at once. Any other scope is not ours.
 *
 * @param {string} token
 * @param {{allowAppFn?: boolean}} [opts] only the /appfunctions mount sets it
 * @returns {{user, scope:"session"|"appfn"}|{error:string, status:number}}
 */
const APPFN_SCOPE = "appfn";
const APPFN_ONLY = "this key only works for assistant functions";

async function verifySession(token, { allowAppFn = false } = {}) {
  let payload;
  try {
    payload = jwt.verify(String(token || ""), process.env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch (_) {
    return { error: "invalid or expired token", status: 401 };
  }
  const scope = payload.scope === undefined ? "session" : payload.scope;
  if (scope !== "session" && scope !== APPFN_SCOPE) {
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
  if (scope === APPFN_SCOPE) {
    if (!allowAppFn) return { error: APPFN_ONLY, status: 403 };
    // 401, like a revoked session: the phone drops the key and asks the
    // app for a new one the next time it is opened.
    if (!Number.isInteger(payload.ep) || payload.ep !== (Number(user.appfn_epoch) || 0)) {
      return { error: "this assistant key was turned off — open My Assistant to turn it back on", status: 401 };
    }
  }
  return { user, scope };
}

/**
 * The request gate. `appAuth` (every protected route) takes session
 * tokens only; `appFnAuth` (the /appfunctions mount alone) also takes an
 * assistant-functions key. req.auth says which one it was, and carries
 * the user's saved UTC offset for routes that have no header to read.
 */
function makeAppAuth({ allowAppFn = false } = {}) {
  return async function appAuth(req, res, next) {
    if (process.env.AUTH_DISABLED === "true") {
      req.user = { sub: "anonymous-dev", email: null, name: "Dev User" };
      return next();
    }
    try {
      const authz = req.get("Authorization") || "";
      if (authz.startsWith("Bearer ")) {
        const v = await verifySession(authz.slice(7), { allowAppFn });
        if (v.error) return res.status(v.status).json({ error: v.error });
        const user = v.user;
        req.user = { sub: String(user.id), email: user.email, name: user.name };
        req.auth = { scope: v.scope, tzOffsetMin: user.tz_offset_min ?? null };
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
  };
}

const appAuth = makeAppAuth();
const appFnAuth = makeAppAuth({ allowAppFn: true });

module.exports = { appAuth, appFnAuth, verifySession, APPFN_SCOPE, APPFN_ONLY };
