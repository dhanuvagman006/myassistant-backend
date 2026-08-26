const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

let initialized = false;

function init() {
  if (initialized) return;
  const keyPath = path.join(__dirname, "../../firebase-adminsdk.json");
  if (fs.existsSync(keyPath)) {
    try {
      const serviceAccount = require(keyPath);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      initialized = true;
      console.log("Firebase Admin SDK initialized successfully.");
    } catch (err) {
      console.error("Failed to initialize Firebase Admin SDK:", err);
    }
  } else {
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
