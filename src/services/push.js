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

/**
 * Sends a push notification to a specific FCM token.
 */
async function sendNotification(fcmToken, title, body, data) {
  init();
  if (!initialized || !fcmToken) return false;

  const message = {
    notification: {
      title,
      body,
    },
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
    return true;
  } catch (error) {
    console.error("Error sending push notification:", error.message || error);
    return false;
  }
}

module.exports = { sendNotification };
