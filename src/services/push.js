const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

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
async function sendNotification(fcmToken, title, body) {
  init();
  if (!initialized || !fcmToken) return false;
  
  const message = {
    notification: {
      title,
      body,
    },
    token: fcmToken,
  };

  try {
    await admin.messaging().send(message);
    return true;
  } catch (error) {
    console.error("Error sending push notification:", error);
    return false;
  }
}

module.exports = { sendNotification };
