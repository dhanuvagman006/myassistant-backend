/**
 * TASK OUTCOME ROUTES (behind appAuth).
 *
 *   GET  /outcomes?limit=&kind=   → { outcomes:[…] }   the user's recent tasks + real results
 *   POST /outcomes                → { outcome }        the DEVICE reports what actually happened
 *        { id?, kind, target, status, reason?, detail?, path? }
 *        With `id` it updates the row the server created when it dispatched
 *        the task; without one (live mode, on-device flows) it creates the row.
 */
const router = require("express").Router();
const outcomes = require("../outcomes/store");
const audit = require("../audit/log");

function uid(req, res) {
  const id = Number(req.user?.sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "sign in required" });
    return null;
  }
  return id;
}

router.get("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const rows = await outcomes.list(id, { limit: req.query.limit, kind: req.query.kind });
  res.json({ outcomes: rows.map(outcomes.toClient) });
});

router.post("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const b = req.body || {};
  const status = String(b.status || "");
  if (!outcomes.STATUSES.has(status)) return res.status(400).json({ error: "invalid status" });
  let row = null;
  if (b.id) {
    row = await outcomes.update(id, Number(b.id), { status, reason: b.reason, detail: b.detail });
  }
  if (!row) {
    row = await outcomes.create(id, {
      kind: b.kind || "other",
      target: b.target,
      detail: b.detail,
      status,
      path: b.path || "device",
    });
  }
  if (!row) return res.status(400).json({ error: "could not record" });
  if (row.kind === "call" || row.kind === "agent_call") {
    audit.record(
      id,
      outcomes.isFailure(row.status) ? "call.failed" : outcomes.isSuccess(row.status) ? "call.placed" : "call.status",
      `${row.target || "?"}: ${row.status}${row.reason ? ` — ${row.reason}` : ""}`
    );
  }
  res.json({ outcome: outcomes.toClient(row) });
});

module.exports = router;
