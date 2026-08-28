/**
 * One Firebase Admin app, shared by push delivery and phone verification.
 *
 * initializeApp() throws if called twice, and two modules that each keep
 * their own "did I init yet" boolean will do exactly that. The guard here
 * is admin.apps — the SDK's own state — so it holds no matter which module
 * gets there first or how many more start using it later.
 */
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const KEY_PATH = path.join(__dirname, "../../firebase-adminsdk.json");

function ensure() {
  if (admin.apps.length) return true;
  if (!fs.existsSync(KEY_PATH)) return false;
  try {
    admin.initializeApp({ credential: admin.credential.cert(require(KEY_PATH)) });
    return true;
  } catch (e) {
    // "already exists" means another module won the race — that is success.
    if (/already exists/i.test(String(e.message))) return true;
    console.error("firebase: init failed:", e.message);
    return false;
  }
}

const configured = () => fs.existsSync(KEY_PATH);

/**
 * Verify a Firebase ID token and return its decoded claims, or null.
 *
 * This is the whole basis for trusting a phone number. The app runs the SMS
 * OTP through Firebase; Firebase mints a token carrying phone_number ONLY
 * once the code was actually entered on that handset. Verifying it here
 * means the number is proven, not merely typed — which is what stops one
 * person registering another's number and receiving their agent's messages.
 */
async function verifyIdToken(idToken) {
  if (!idToken || !ensure()) return null;
  try {
    return await admin.auth().verifyIdToken(String(idToken), true);
  } catch (e) {
    console.warn("firebase: token rejected:", String(e.message).slice(0, 140));
    return null;
  }
}

module.exports = { admin, ensure, configured, verifyIdToken };
