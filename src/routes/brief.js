/**
 * GET /brief — the home dashboard's single aggregate fetch.
 * Query: lat, lng (optional, for the weather chip).
 * Header: X-TZ-Offset (minutes east of UTC; defaults to IST 330).
 */
const router = require("express").Router();
const { buildBrief } = require("../services/brief");

router.get("/", async (req, res) => {
  const uid = Number(req.user?.sub);
  if (!Number.isInteger(uid) || uid <= 0) {
    // Dev/appKey sessions have no user row — an EMPTY brief, not an error,
    // so the home screen renders its calm state instead of a banner.
    return res.json({
      name: null, weather_line: null, agenda: [], promises: [],
      messages: [], people: [], people_count: 0, headlines: [],
    });
  }
  try {
    const brief = await buildBrief(uid, {
      lat: parseFloat(req.query.lat),
      lng: parseFloat(req.query.lng),
      tzOffsetMin: Number(req.get("X-TZ-Offset")) || 330,
    });
    res.json(brief);
  } catch (e) {
    console.error("brief failed:", e.message);
    res.status(500).json({ error: "brief failed" });
  }
});

module.exports = router;
