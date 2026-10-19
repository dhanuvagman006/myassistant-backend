/**
 * NOTIFICATIONS FROM THE PHONE (src/notify/triage.js).
 *
 *   POST /notify/triage (appAuth) { app, title, text, can_reply, group }
 *     → { action: "reply"|"inform"|"none", say, remembered }
 *
 * Sent by the phone's notification listener once the owner switched it on
 * (You → Assistant over other apps). Nothing is stored except a lasting
 * fact the triage chose to remember.
 */
const express = require("express");
const { triage } = require("../notify/triage");

const router = express.Router();
router.post("/triage", async (req, res) => {
  const uid = Number(req.user?.sub);
  if (!uid) return res.status(401).json({ error: "sign in required" });
  try {
    res.json(await triage(uid, req.body || {}));
  } catch (e) {
    console.error("notify triage route:", e && (e.stack || e.message));
    res.status(500).json({ error: "error" });
  }
});

module.exports = router;
