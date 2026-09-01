/**
 * HTTP surface for the avatar.
 *
 *   GET  /live/avatar          probe — may the app offer the avatar at all?
 *   POST /live/avatar/session  start one, returns LiveKit join details
 *   DELETE /live/avatar/session/:room  explicit teardown (app closed cleanly)
 *
 * The probe exists so the app can hide the toggle instead of offering a
 * button that fails: an unset BEY key or a retired avatar id should look
 * like "not available here", not like a crash.
 */
const session = require("./session");
const bey = require("./bey");

function router() {
  const r = require("express").Router();

  // Faces the user may pick in Settings. Cached an hour — the account's
  // avatar list changes rarely and BEY shouldn't be polled per open.
  let facesCache = null;
  r.get("/faces", async (_req, res) => {
    if (!session.configured()) return res.json({ faces: [] });
    try {
      if (!facesCache || Date.now() - facesCache.ts > 3600_000) {
        let data = [];
        if (session.provider() === "simli") {
          data = await require("./simli").listFaces();
        } else {
          const out = await bey.listAvatars();
          data = (out?.data || [])
            .filter((a) => a.status === "available")
            .map((a) => ({ id: a.id, name: a.name }));
        }
        facesCache = { ts: Date.now(), data };
      }
      const def =
        session.provider() === "simli"
          ? require("./simli").faceId()
          : bey.avatarId();
      res.json({ faces: facesCache.data, default_id: def });
    } catch (e) {
      console.error("avatar faces:", e.message);
      res.status(502).json({ error: "avatar list unavailable" });
    }
  });

  r.get("/", async (_req, res) => {
    if (!session.configured()) {
      return res.json({ available: false, reason: "not configured" });
    }
    // Simli has no cheap "is this face healthy" probe, and burning a billed
    // session just to answer a probe would be worse than the question. The
    // key and face id being present is the honest answer here; a genuine
    // failure surfaces on /session, where the app already falls back.
    if (session.provider() === "simli") {
      return res.json({
        available: true,
        provider: "simli",
        avatarId: require("./simli").faceId() || null,
      });
    }
    try {
      const a = await bey.describeAvatar();
      res.json({
        available: a?.status === "available",
        provider: "bey",
        avatarId: a?.id,
        name: a?.name,
      });
    } catch (e) {
      res.json({ available: false, reason: String(e.message).slice(0, 160) });
    }
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
