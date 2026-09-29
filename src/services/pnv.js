/**
 * FIREBASE PHONE NUMBER VERIFICATION — the only way a number is proven.
 *
 * Owner, 2026-09-29: remove the SMS code "completely and implement Firebase
 * Phone Number Verification". The phone asks Google, through Android's
 * Credential Manager and the user's own consent, for the number of the SIM
 * that is in it. Google gets that number from the carrier (no code, no SMS)
 * and hands the app a JWT signed with ES256 whose subject is the number.
 * The app sends us that token, never the digits; this checks it against
 * Google's published keys, the project it was minted for and its expiry.
 * Only then is the subject a proven number.
 *
 * https://firebase.google.com/docs/phone-number-verification/verify-tokens
 *   header  typ "JWT", alg ES256, keys at https://fpnv.googleapis.com/v1beta/jwks
 *   iss     https://fpnv.googleapis.com/projects/<PROJECT_NUMBER>
 *   aud     a list holding that same URL (and one with the project id)
 *   sub     the verified number, E.164
 *
 * The project number is not a secret: it ships in every APK, inside
 * google-services.json. FIREBASE_PROJECT_NUMBER overrides it for another
 * Firebase project; PNV_JWKS_URL exists for the tests.
 *
 * ONE USE PER TOKEN. The default Android flow carries no nonce, so a token
 * that leaked (a log line, a screenshot) would verify again until it
 * expired. Each accepted token's SHA-256 (nothing else) is kept until its
 * expiry, and a second use is refused.
 */
const crypto = require("crypto");
const { createRemoteJWKSet, jwtVerify } = require("jose");

// The "hari-62ec0" Firebase project (android/app/google-services.json).
const DEFAULT_PROJECT_NUMBER = "134941649419";

const projectNumber = () => String(process.env.FIREBASE_PROJECT_NUMBER || DEFAULT_PROJECT_NUMBER).trim();
const jwksUrl = () => process.env.PNV_JWKS_URL || "https://fpnv.googleapis.com/v1beta/jwks";
const issuer = () => `https://fpnv.googleapis.com/projects/${projectNumber()}`;

const configured = () => /^\d{6,20}$/.test(projectNumber());

let keySet = null;
let keySetUrl = "";
function keys() {
  const url = jwksUrl();
  if (!keySet || keySetUrl !== url) {
    // jose caches the key set, refetches on an unknown key id (Google
    // rotates them) and never more than once per cooldown.
    keySet = createRemoteJWKSet(new URL(url), { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
    keySetUrl = url;
  }
  return keySet;
}

// Google's keys out of reach is not the user's fault: that is "try again",
// never "your token is bad".
// ERR_JOSE_GENERIC is what jose throws when the key set answers other than 200.
const UNREACHABLE = new Set(["ERR_JWKS_TIMEOUT", "ERR_JWKS_INVALID", "ERR_JOSE_GENERIC"]);

/**
 * @returns {Promise<{ok:true, phone:string, expiresAt:number, hash:string}
 *   | {ok:false, error:"missing"|"malformed"|"expired"|"invalid"|"unavailable"}>}
 */
async function verify(token) {
  const t = typeof token === "string" ? token.trim() : "";
  if (!t) return { ok: false, error: "missing" };
  if (t.length > 8192 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(t)) return { ok: false, error: "malformed" };
  if (!configured()) return { ok: false, error: "unavailable" };
  let payload;
  try {
    ({ payload } = await jwtVerify(t, keys(), {
      algorithms: ["ES256"],
      typ: "JWT",
      issuer: issuer(),
      audience: issuer(),
      requiredClaims: ["sub", "exp"],
      clockTolerance: 30,
    }));
  } catch (e) {
    const code = String(e?.code || "");
    if (code === "ERR_JWT_EXPIRED") return { ok: false, error: "expired" };
    if (UNREACHABLE.has(code) || (!code && /fetch|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(String(e?.message)))) {
      console.warn("pnv: Google's keys unreachable:", String(e?.message || e).slice(0, 120));
      return { ok: false, error: "unavailable" };
    }
    console.warn("pnv: token rejected:", code || String(e?.message || e).slice(0, 120));
    return { ok: false, error: "invalid" };
  }
  const phone = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!phone) return { ok: false, error: "invalid" };
  return {
    ok: true,
    phone,
    expiresAt: Number(payload.exp) * 1000,
    hash: crypto.createHash("sha256").update(t).digest("hex"),
  };
}

let ready = null;
function ensureTable() {
  const { run } = require("../db");
  if (!ready) {
    ready = run(`
      CREATE TABLE IF NOT EXISTS phone_pnv_used (
        token_hash  TEXT   PRIMARY KEY,
        expires_at  BIGINT NOT NULL
      )`).catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

/** True the first time a token is presented; false every time after. */
async function claimOnce(hash, expiresAt, now = Date.now()) {
  const { run, one } = require("../db");
  await ensureTable();
  await run("DELETE FROM phone_pnv_used WHERE expires_at < $1", [now - 60_000]).catch(() => {});
  const row = await one(
    `INSERT INTO phone_pnv_used (token_hash, expires_at) VALUES ($1, $2)
     ON CONFLICT (token_hash) DO NOTHING RETURNING token_hash`,
    [hash, Math.max(Number(expiresAt) || 0, now) + 60_000]);
  return !!row;
}

module.exports = { verify, claimOnce, configured, issuer, DEFAULT_PROJECT_NUMBER };
