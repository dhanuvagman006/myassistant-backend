/**
 * COMMITMENT ROUTES (behind appAuth) — lets the dashboard act on promises
 * without a voice turn: tap the circle to mark one kept, swipe to dismiss.
 *
 * POST   /commitments/:id/done   → { ok }   (kept it)
 * DELETE /commitments/:id        → { ok }   (never mind — cancelled)
 *
 * Rows are status-flipped, never hard-deleted: "cancelled" keeps history
 * honest and lets a wrong swipe be recovered by support if it ever matters.
 */
const router = require("express").Router();
const { run } = require("../db");

function uid(req, res) {
  const id = Number(req.user?.sub === "anonymous-dev" ? 0 : req.user?.sub);
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json({ error: "sign in required" });
    return null;
  }
  return id;
}

async function setStatus(userId, id, status) {
  return run(
    `UPDATE commitments SET status=$3, updated_at=$4
      WHERE user_id=$1 AND id=$2 AND status='open'`,
    [userId, Number(id), status, Date.now()]
  );
}

router.post("/:id/done", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  await setStatus(id, req.params.id, "done").catch(() => {});
  res.json({ ok: true });
});

router.delete("/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  await setStatus(id, req.params.id, "cancelled").catch(() => {});
  res.json({ ok: true });
});

module.exports = router;
