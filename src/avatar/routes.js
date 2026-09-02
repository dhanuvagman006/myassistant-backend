/**
 * HTTP surface for the avatar.
 *
 *   GET  /live/avatar          probe — may the app offer the avatar at all?
 *   GET  /live/avatar/faces    catalog for the Settings face picker
 *   POST /live/avatar/session  start one, returns LiveKit join details
 *   DELETE /live/avatar/session/:room  explicit teardown (app closed cleanly)
 *
 * The probe exists so the app can hide the toggle instead of offering a
 * button that fails: a missing HeyGen key should look like "not available
 * here", not like a crash.
 */
const session = require("./session");
const heygen = require("./heygen");

function router() {
  const r = require("express").Router();

  // Faces the user may pick in Settings — HeyGen's stock catalog,
  // portrait-framed avatars first (heygen.listFaces caches it).
  r.get("/faces", async (_req, res) => {
    if (!session.configured()) return res.json({ faces: [] });
    try {
      res.json({ faces: await heygen.listFaces(), default_id: heygen.avatarId() });
    } catch (e) {
      console.error("avatar faces:", e.message);
      res.status(502).json({ error: "avatar list unavailable" });
    }
  });

  r.get("/", async (_req, res) => {
    if (!session.configured()) {
      return res.json({ available: false, reason: "not configured" });
    }
    // No cheap "is this healthy" probe exists, and burning a billed
    // session just to answer one would be worse than the question. The key
    // being present is the honest answer here; a genuine failure surfaces
    // on /session, where the app already falls back to voice-only.
    res.json({
      available: true,
      provider: "heygen",
      avatarId: heygen.avatarId() || null,
    });
  });

  r.post("/session", async (req, res) => {
    if (!session.configured()) {
      return res.status(503).json({ error: "avatar not configured" });
    }
    try {
      res.json(await session.start({ userId: req.user?.sub ?? req.user?.uid }));
    } catch (e) {
      console.error("avatar: start failed:", e.message);
      res.status(502).json({ error: String(e.message).slice(0, 200) });
    }
  });

  r.delete("/session/:room", async (req, res) => {
    await session.stop(req.params.room, "app requested teardown");
    res.json({ ok: true });
  });

  return r;
}

module.exports = { router };
