/**
 * THE DAY'S QUOTE (src/quotecards/service.js).
 *
 *   GET /quote-cards/today              (appAuth) → { date, text, status, total, cards: [
 *                                         { style, label, ink, font, scrim, url, width, height } ] }
 *   GET /quote-cards/img/:date/:file    (public)  → image/jpeg
 *
 * The pictures are the same for every user and carry nothing personal,
 * so they are served without auth — Image.network on the phone cannot
 * send a header, and a dated, style-named file reveals nothing.
 */
const express = require("express");
const svc = require("../quotecards/service");

const router = express.Router();
router.get("/today", async (req, res) => {
  try {
    res.json(await svc.today());
  } catch (e) {
    console.error("quote cards today:", e && (e.stack || e.message));
    res.status(500).json({ error: "error", message: "The quote did not load. Try again in a moment." });
  }
});

const images = express.Router();
images.get("/:date/:file", (req, res) => {
  const p = svc.imagePath(req.params.date, req.params.file);
  if (!p) return res.status(404).json({ error: "not_found" });
  res.set("Cache-Control", "public, max-age=604800, immutable");
  res.type("image/jpeg").sendFile(p);
});

module.exports = { router, images };
