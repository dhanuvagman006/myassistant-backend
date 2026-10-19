/**
 * BORN TODAY (src/birthdays/service.js).
 *
 *   GET /birthdays/today  (appAuth) → { date, people: [{ id, name, role, age, photo }] }
 *
 * The same list for everyone; an empty list when it could not be fetched.
 */
const express = require("express");
const svc = require("../birthdays/service");

const router = express.Router();
router.get("/today", async (req, res) => {
  try {
    res.set("Cache-Control", "private, max-age=600");
    res.json(await svc.today());
  } catch (e) {
    console.error("birthdays today:", e && (e.stack || e.message));
    res.status(500).json({ error: "error", message: "Birthdays did not load. Try again in a moment." });
  }
});

module.exports = router;
