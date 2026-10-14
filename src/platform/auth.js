/**
 * THE CONNECTED-APP KEY GATE for /v1 (2026-10-14).
 *
 *   Authorization: Bearer mya_…     (or X-Api-Key: mya_…)
 *
 * A key acts as the user who made it, inside its app's scopes. It is good
 * only while the key is not revoked, the app is active and the account is
 * not paused or deleted — all read on every request, so turning any of
 * them off works at once. On success:
 *
 *   req.user     = { sub, email, name }   (as appAuth sets it: the spend
 *                                           meter and the usage ledger see
 *                                           the same account as the app)
 *   req.platform = { app, keyId }
 *
 * A key is never accepted anywhere but /v1: appAuth only reads JWTs, and a
 * key is not one.
 */
const rateLimit = require("express-rate-limit");
const db = require("../db");
const store = require("./store");

function error(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

async function platformAuth(req, res, next) {
  const authz = req.get("Authorization") || "";
  const key = authz.startsWith("Bearer ") ? authz.slice(7).trim() : String(req.get("X-Api-Key") || "").trim();
  if (!key) return error(res, 401, "missing_key", "Send your app's API key: Authorization: Bearer mya_…");
  try {
    const found = await store.resolveKey(key);
    if (!found) return error(res, 401, "invalid_key", "This API key is not valid or was revoked.");
    const { app } = found;
    if (app.status !== "active") {
      return error(res, 403, "app_paused", `"${app.name}" is paused in My Assistant. Turn it back on in the Developer Console (/console).`);
    }
    const user = await db.findById(app.userId);
    if (!user || user.status === "paused") return error(res, 401, "account_unavailable", "The account behind this key is not available.");
    req.user = { sub: String(user.id), email: user.email, name: user.name };
    req.auth = { scope: "platform", tzOffsetMin: user.tz_offset_min ?? null };
    req.platform = { app, keyId: found.keyId, user };
    store.bump(app, "requests");
    next();
  } catch (e) {
    console.warn("[platform] key check failed:", e && e.message);
    return error(res, 503, "unavailable", "A brief hiccup — please try again in a moment.");
  }
}

/** 403 unless the app holds `scope`. */
function need(scope) {
  return (req, res, next) => {
    const scopes = (req.platform && req.platform.app.scopes) || [];
    if (!scopes.includes(scope)) {
      return error(res, 403, "missing_scope",
        `This key's app is not allowed "${scope}". Allow it in the Developer Console (/console) → ${req.platform ? req.platform.app.name : "the app"}.`);
    }
    next();
  };
}

// Per key: a busy app must not starve the user's own phone (whose routes
// have their own per-user buckets). The global per-IP limit still applies.
const limiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.PLATFORM_RATE_PER_MIN) || 120,
  standardHeaders: true,
  keyGenerator: (req) => `pk:${req.platform ? req.platform.keyId : req.ip}`,
  handler: (req, res) => error(res, 429, "rate_limited", "Too many requests for this key — slow down a little."),
});

module.exports = { platformAuth, need, limiter, error };
