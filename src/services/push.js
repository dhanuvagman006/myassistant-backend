// v12+ modular API — see services/firebase.js for why the old
// admin.messaging() namespace no longer exists.
const { getMessaging } = require("firebase-admin/messaging");

let initialized = false;

function init() {
  if (initialized) return;
  // Delegated so push and phone verification share ONE app: calling
  // initializeApp twice throws, and each module used to keep its own flag.
  initialized = require("./firebase").ensure();
  if (!initialized) {
    console.warn("firebase-adminsdk.json not found. Push notifications will be skipped.");
  }
}

// FCM error codes that mean the token is DEAD, not that the send glitched:
// the app was uninstalled/reinstalled or the token was rotated away. FCM
// will never deliver to it again, so keeping it stored just makes every
// future push fail silently.
const STALE_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

/**
 * Full-fidelity send. Returns
 *   { ok, stale, skipped, error }
 * — ok:true only when FCM ACCEPTED the message. A stale (dead) token is
 * additionally PRUNED from every users row holding it, so the device is
 * cleanly re-registered the next time the app opens (PushService.syncToken
 * re-sends the current token on every launch after sign-in).
 */
async function send(fcmToken, title, body, data) {
  init();
  if (!initialized) return { ok: false, stale: false, skipped: true, error: "push not configured on this server" };
  if (!fcmToken) return { ok: false, stale: false, skipped: true, error: "no device token" };

  const message = {
    notification: {
      title,
      body,
    },
    // HIGH priority, explicitly. The default is "normal", which Android
    // (Samsung especially) defers in doze and app-standby — measured on
    // the SM-E156B: normal-priority sends were ACCEPTED by FCM and never
    // displayed, while the Firebase console's high-priority campaign
    // arrived instantly on the same device. Everything this server sends
    // is user-facing (a message, a reminder, an admin notice), so
    // immediate display is the correct default.
    android: { priority: "high" },
    // FCM data values must all be strings; the app uses these to react to
    // the push (e.g. kind=agent_message → fetch the inbox and speak it).
    ...(data
      ? {
          data: Object.fromEntries(
            Object.entries(data).map(([k, v]) => [k, String(v)])
          ),
        }
      : {}),
    token: fcmToken,
  };

  try {
    await getMessaging().send(message);
    return { ok: true, stale: false, skipped: false, error: null };
  } catch (error) {
    const code = error?.errorInfo?.code || error?.code || "";
    const stale =
      STALE_CODES.has(code) || /not.?registered/i.test(String(error?.message || ""));
    if (stale) {
      try {
        const db = require("../db");
        // GRACE PERIOD. A newly-minted token takes a few minutes to
        // propagate to FCM's send backend, and until then sends return
        // "registration-token-not-registered" — the SAME code as a
        // genuinely dead token. Pruning on that answer turned every
        // send-right-after-registering into a permanently deleted token
        // (measured: a send 60s after mint failed; sends to the same
        // kind of token at 7 minutes old were accepted). So a token
        // younger than 15 minutes is KEPT and the caller told to retry.
        const rows = await db.query(
          "SELECT id, fcm_token_at FROM users WHERE fcm_token=$1",
          [fcmToken]
        );
        const newestAt = Math.max(0, ...rows.map((r) => Number(r.fcm_token_at) || 0));
        if (rows.length && Date.now() - newestAt < 15 * 60_000) {
          console.warn(
            `push: token for user(s) ${rows.map((r) => r.id).join(",")} not yet ` +
              `active at FCM (registered ${Math.round((Date.now() - newestAt) / 1000)}s ago) — kept, retry shortly`
          );
          return {
            ok: false,
            stale: false,
            skipped: false,
            error:
              "device registered moments ago and its token is still activating at Google — try again in a few minutes",
          };
        }
        const cleared = await db.query(
          "UPDATE users SET fcm_token='' WHERE fcm_token=$1 RETURNING id",
          [fcmToken]
        );
        console.warn(
          `push: stale token (${code || "NotRegistered"}) cleared from user(s) ` +
            `${cleared.map((r) => r.id).join(",") || "?"} — device re-registers on next app open`
        );
      } catch (e) {
        console.warn("push: failed to clear stale token:", e.message);
      }
    } else {
      console.error("Error sending push notification:", code || error.message || error);
    }
    return { ok: false, stale, skipped: false, error: code || error.message || String(error) };
  }
}

/**
 * Boolean wrapper kept for existing callers (scheduler, receptionist,
 * payments, fares, builtins): true only when FCM accepted the message.
 * Stale-token pruning happens inside send() either way.
 */
async function sendNotification(fcmToken, title, body, data) {
  return (await send(fcmToken, title, body, data)).ok;
}

module.exports = { sendNotification, send };
