/**
 * NEARBY — the app's screen for people around who share what they do.
 *
 *   GET  /nearby/me                              what I share
 *   PUT  /nearby/me   {profession, organisation, shared, lat, lng}
 *   GET  /nearby/professionals?q=lawyer&lat=&lng=&radius=
 *   POST /nearby/contact {user_id, text}         a message through their assistant
 *
 * The assistant's own route to the same list is find_places_nearby
 * (tools/builtins), which lists these people beside real places.
 */
const express = require("express");
const nearby = require("../people/nearby");

const router = express.Router();

function uidOf(req) {
  const id = Number(req.user && req.user.sub);
  return Number.isInteger(id) && id > 0 ? id : null;
}
function coord(v, max) {
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= max ? n : undefined;
}

router.get("/me", async (req, res) => {
  const uid = uidOf(req);
  if (!uid) return res.status(401).json({ error: "sign in" });
  res.json((await nearby.me(uid)) || {});
});

router.put("/me", async (req, res) => {
  const uid = uidOf(req);
  if (!uid) return res.status(401).json({ error: "sign in" });
  const b = req.body || {};
  const out = await nearby.setProfession(uid, {
    profession: b.profession !== undefined ? String(b.profession) : undefined,
    organisation: b.organisation !== undefined ? String(b.organisation) : undefined,
    shared: b.shared === undefined ? undefined : b.shared === true || b.shared === 1 || b.shared === "1",
    lat: coord(b.lat, 90), lng: coord(b.lng, 180),
  });
  res.json(out || {});
});

router.get("/professionals", async (req, res) => {
  const uid = uidOf(req);
  if (!uid) return res.status(401).json({ error: "sign in" });
  const q = String(req.query.q || "").slice(0, 80);
  const lat = coord(req.query.lat, 90);
  const lng = coord(req.query.lng, 180);
  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ error: "location required", message: "Turn on location so I can look around you." });
  }
  // Being on the list is the price of reading it kept fresh: the asker's
  // own coarse position moves with them while they share.
  nearby.touchLocation(uid, lat, lng).catch(() => {});
  const people = await nearby.search({ q, lat, lng, radiusKm: req.query.radius, excludeUserId: uid });
  res.json({ query: q, people });
});

router.post("/contact", async (req, res) => {
  const uid = uidOf(req);
  if (!uid) return res.status(401).json({ error: "sign in" });
  const out = await nearby.contact(uid, req.body && req.body.user_id, req.body && req.body.text);
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

module.exports = router;
