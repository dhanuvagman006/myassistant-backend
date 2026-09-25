/**
 * MOMENTUM ROUTES (behind appAuth) — Today's 3, habits, focus, streak.
 *
 *   GET    /momentum?day=YYYY-MM-DD           the summary for that local day
 *   PUT    /momentum/priorities               {day, items:[{id?, title}]}  (3 at most)
 *   PATCH  /momentum/priorities/:id           {done?, title?, day?}  (day moves it)
 *   DELETE /momentum/priorities/:id
 *   POST   /momentum/habits                   {title, emoji?, remindAt?}  → + habitId
 *   PATCH  /momentum/habits/:id               {title?, emoji?, remindAt?}
 *   DELETE /momentum/habits/:id
 *   PUT    /momentum/habits/:id/check         {day, done}
 *   POST   /momentum/focus                    {plannedMin, label?}  → + focusId
 *   PATCH  /momentum/focus/:id                {actualMin, completed}
 *
 * EVERY WRITE ANSWERS WITH THE FRESH SUMMARY (for ?day=, else the local
 * day from X-TZ-Offset), so the app never has to guess what a tick did to
 * the streak — it draws what the server now holds. A refusal is
 * {ok:false, error} with 400 (bad input), 404 (not theirs, or gone) or
 * 409 (a limit), in words the app can show as they are.
 */
const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { tzFromReq } = require("../services/tz");
const svc = require("./service");
const S = require("./streak");

// Its own per-user budget, NOT the shared perUserLimit: that instance
// counts every chat, speech and vision call together at 30 a minute, and
// ticking boxes must neither spend the voice budget nor be starved by it.
router.use(rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  keyGenerator: (req) => `momentum:${req.user?.sub || req.ip}`,
}));

function userOf(req, res) {
  const id = Number(req.user?.sub);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(401).json({ ok: false, error: "sign in required" });
    return null;
  }
  return id;
}

/** The local day the answer is about: ?day=, else today by their clock. */
function dayOf(req) {
  const q = req.query.day;
  if (q === undefined || q === "") return S.localDay(Date.now(), tzFromReq(req));
  if (!S.isDay(String(q))) throw new svc.MomentumError(400, "day must be a date like 2026-09-25");
  return String(q);
}

/** Runs a write, then answers with the summary (plus anything it returns). */
function handle(fn) {
  return async (req, res) => {
    const userId = userOf(req, res);
    if (userId === null) return;
    const tz = tzFromReq(req);
    try {
      const day = dayOf(req);
      const extra = fn ? await fn(userId, req.body || {}, req.params, tz) : null;
      res.json({ ...(await svc.summary(userId, day, { tz })), ...(extra || {}) });
    } catch (e) {
      if (e instanceof svc.MomentumError) {
        return res.status(e.status).json({ ok: false, error: e.message });
      }
      throw e;
    }
  };
}

router.get("/", handle(null));

router.put("/priorities", handle((uid, b) => svc.setPriorities(uid, b.day, b.items)));
router.patch("/priorities/:id", handle((uid, b, p, tz) =>
  svc.patchPriority(uid, p.id, { done: b.done, title: b.title, day: b.day }, { tz })));
router.delete("/priorities/:id", handle((uid, b, p) => svc.deletePriority(uid, p.id)));

router.post("/habits", handle(async (uid, b) => ({
  habitId: await svc.addHabit(uid, { title: b.title, emoji: b.emoji, remindAt: b.remindAt }),
})));
router.patch("/habits/:id", handle((uid, b, p) =>
  svc.patchHabit(uid, p.id, { title: b.title, emoji: b.emoji, remindAt: b.remindAt })));
router.delete("/habits/:id", handle((uid, b, p) => svc.archiveHabit(uid, p.id)));
router.put("/habits/:id/check", handle((uid, b, p, tz) =>
  svc.checkHabit(uid, p.id, { day: b.day, done: b.done }, { tz })));

router.post("/focus", handle(async (uid, b, p, tz) => ({
  focusId: await svc.startFocus(uid, { plannedMin: b.plannedMin, label: b.label }, { tz }),
})));
router.patch("/focus/:id", handle((uid, b, p) =>
  svc.finishFocus(uid, p.id, { actualMin: b.actualMin, completed: b.completed })));

module.exports = router;
