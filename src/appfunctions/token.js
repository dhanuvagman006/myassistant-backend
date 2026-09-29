/**
 * ASSISTANT-FUNCTIONS KEYS — the narrow token the phone's background
 * AppFunctionService holds (Android 16+), so Gemini and other system
 * agents can reach the user's list, reminders and Today's 3 while the app
 * is closed. Minted and revoked by a NORMAL signed-in session only (the
 * mount in server.js is behind appAuth, which refuses an appfn key):
 *
 *   POST   /appfunctions/token → { token, expiresAt }   expiresAt = unix ms
 *   DELETE /appfunctions/token → { ok: true }           every key issued
 *                                                        before stops working
 *
 * The key is signed exactly like a session (HS256, JWT_SECRET, 30 days)
 * with scope "appfn" and the user's appfn_epoch as `ep`. middleware/auth.js
 * refuses it on every route but /appfunctions/*, and refuses it there too
 * once DELETE has moved the epoch on. Several phones may each hold one;
 * issuing a key never revokes another.
 */
const router = require("express").Router();
const jwt = require("jsonwebtoken");
const db = require("../db");
const audit = require("../audit/log");
const { APPFN_SCOPE, APPFN_ONLY } = require("../middleware/auth");

const KEY_DAYS = 30;

/** A fresh key for this users row: { token, expiresAt (unix ms) }. */
function issue(user) {
  const ep = Number(user.appfn_epoch) || 0;
  const token = jwt.sign({ uid: user.id, scope: APPFN_SCOPE, ep }, process.env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: `${KEY_DAYS}d`,
  });
  return { token, expiresAt: jwt.decode(token).exp * 1000 };
}

/** Every key issued before now stops working. Returns the new epoch. */
async function revokeAll(userId) {
  const row = await db.one(
    `UPDATE users SET appfn_epoch = appfn_epoch + 1 WHERE id = $1 RETURNING appfn_epoch`,
    [Number(userId)]
  );
  return row ? Number(row.appfn_epoch) : null;
}

/** The signed-in account, or null after answering. Never an appfn key. */
function sessionUid(req, res) {
  if (req.auth && req.auth.scope === APPFN_SCOPE) {
    res.status(403).json({ error: APPFN_ONLY });
    return null;
  }
  const id = Number(req.user && req.user.sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(401).json({ error: "sign in required" });
    return null;
  }
  return id;
}

router.post("/", async (req, res) => {
  const uid = sessionUid(req, res);
  if (uid === null) return;
  const user = await db.findById(uid);
  if (!user) return res.status(401).json({ error: "account not found" });
  audit.record(uid, "appfunctions.key.issued", "Assistants on your phone may use My Assistant");
  res.json(issue(user));
});

router.delete("/", async (req, res) => {
  const uid = sessionUid(req, res);
  if (uid === null) return;
  await revokeAll(uid);
  audit.record(uid, "appfunctions.key.revoked", "Assistants on your phones can no longer use My Assistant");
  res.json({ ok: true });
});

module.exports = { router, issue, revokeAll, KEY_DAYS };
