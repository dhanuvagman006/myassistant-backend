/**
 * THE DAY'S QUOTE (src/quotecards/service.js).
 *
 *   GET /quote-cards/today              (appAuth) → { date, text, status, total, cards: [
 *                                         { style, label, ink, font, scrim, url, width, height } ] }
 *   GET /quote-cards/img/:date/:file    (public)  → image/jpeg
 *   GET /quote-cards/public/today       (public)  → the same as /today, for the
 *                                         WishMe app (2026-10-19), whose users
 *                                         have no account here. It is the line
 *                                         and the picture list everyone gets;
 *                                         nothing personal. Picture urls stay
 *                                         relative to this server.
 *
 * The pictures are the same for every user and carry nothing personal,
 * so they are served without auth — Image.network on the phone cannot
 * send a header, and a dated, style-named file reveals nothing.
 */
const express = require("express");
const svc = require("../quotecards/service");

const router = express.Router();
async function today(req, res) {
  try {
    res.json(await svc.today());
  } catch (e) {
    console.error("quote cards today:", e && (e.stack || e.message));
    res.status(500).json({ error: "error", message: "The quote did not load. Try again in a moment." });
  }
}
router.get("/today", today);

const publicRouter = express.Router();
publicRouter.get("/today", today);

const images = express.Router();
images.get("/:date/:file", (req, res) => {
  const p = svc.imagePath(req.params.date, req.params.file);
  if (!p) return res.status(404).json({ error: "not_found" });
  res.set("Cache-Control", "public, max-age=604800, immutable");
  res.type("image/jpeg").sendFile(p);
});

module.exports = { router, images, publicRouter };
