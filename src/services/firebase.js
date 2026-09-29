/**
 * One Firebase Admin app, shared by push delivery and account deletion.
 *
 * initializeApp() throws if called twice, and two modules that each keep
 * their own "did I init yet" boolean will do exactly that. The guard here
 * is admin.apps — the SDK's own state — so it holds no matter which module
 * gets there first or how many more start using it later.
 */
// firebase-admin v12+ removed the old namespaced API: `admin.apps`,
// `admin.credential.cert`, `admin.messaging()` and `admin.auth()` are gone
// (admin.apps is undefined and everything else throws). Every push and
// every Firebase call was silently failing because of this —
// the errors were caught and reported as "skipped". The modular imports
// below are the only API v12+ supports.
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const fs = require("fs");
const path = require("path");

const KEY_PATH = path.join(__dirname, "../../firebase-adminsdk.json");

function ensure() {
  if (getApps().length) return true;
  if (!fs.existsSync(KEY_PATH)) return false;
  try {
    initializeApp({ credential: cert(require(KEY_PATH)) });
    return true;
  } catch (e) {
    // "already exists" means another module won the race — that is success.
    if (/already exists/i.test(String(e.message))) return true;
    console.error("firebase: init failed:", e.message);
    return false;
  }
}

const configured = () => fs.existsSync(KEY_PATH);

/// The Admin Auth client, behind ensure(). A function (not the SDK import
/// itself) so the /ai/firebase-token route and its tests share one seam.
const auth = () => getAuth();

/**
 * Forget a phone number at Firebase when its account is deleted.
 *
 * Owner, 2026-09-25: "delete old user accounts and data's from the
 * database". Numbers verified by the SMS code (removed 2026-09-29) left
 * a Firebase user holding the number; our side never stored that user's
 * id, so it is looked up by the number itself. Phone Number Verification
 * creates no Firebase user, so for newer numbers this finds nothing. Best effort: "not found" and "not configured" are both fine, and
 * nothing here may stop the account deletion that called it.
 *
 * @returns "deleted" | "not found" | "not configured" | "failed: …"
 */
async function deletePhoneUser(phone) {
  if (!phone) return "no phone";
  if (!ensure()) return "not configured";
  try {
    const u = await getAuth().getUserByPhoneNumber(String(phone));
    await getAuth().deleteUser(u.uid);
    return "deleted";
  } catch (e) {
    if (e && e.code === "auth/user-not-found") return "not found";
    return "failed: " + String(e?.message || e).slice(0, 120);
  }
}

module.exports = { ensure, configured, auth, deletePhoneUser };
