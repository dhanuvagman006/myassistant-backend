/**
 * TASK ROUTES (behind appAuth) — a running plan the user can actually see.
 *
 *   GET    /tasks              → { tasks }  open plans (running + blocked)
 *   GET    /tasks/recent       → { tasks }  the last 20, whatever their state
 *   GET    /tasks/:id          → { task }
 *   POST   /tasks/:id/cancel   → { task }   stop it where it stands
 *   POST   /tasks/:id/ack      → { task }   the phone's receipt for a step
 *
 * WHY THIS EXISTS. A multi-step task can outlive the turn that started it:
 * it parks on a confirmation, or the turn's time budget ends before the
 * plan does. Without a way to list and resume them, that work becomes
 * invisible — rows in a table nobody can reach. These routes are how the
 * app shows "3 of 4 done" and how a dispatched step gets its receipt.
 *
 * The ack route is the one that matters most for correctness: a step that
 * hands an envelope to the phone is DISPATCHED, not done, and stays that
 * way until the phone says otherwise. That is deliberate — "I opened
 * YouTube" was once said about an envelope that was dropped.
 */
const router = require("express").Router();
const tasks = require("../agents/tasks");
const driver = require("../agents/taskDriver");

function uid(req, res) {
  const id = Number(req.user?.sub === "anonymous-dev" ? 0 : req.user?.sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "sign in required" });
    return null;
  }
  return id;
}

/** Trim a task to what a screen needs — the step list, not the payloads. */
function forClient(task) {
  if (!task) return null;
  const steps = (task.steps || []).map((s) => ({
    n: s.i + 1,
    tool: s.tool,
    why: s.why,
    status: s.status,
    error: s.error || "",
  }));
  return {
    id: task.id,
    goal: task.goal,
    status: task.status,
    blocked_on: task.blockedOn || "",
    error: task.error || "",
    done: steps.filter((s) => s.status === tasks.STEP.DONE).length,
    total: steps.length,
    steps,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

router.get("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const open = await tasks.listOpen(id).catch(() => []);
  res.json({ ok: true, tasks: open.map(forClient) });
});

router.get("/recent", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const rows = await tasks.listRecent(id).catch(() => []);
  res.json({ ok: true, tasks: rows.map(forClient) });
});

router.get("/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const task = await tasks.get(id, Number(req.params.id)).catch(() => null);
  if (!task) return res.status(404).json({ error: "no such task" });
  res.json({ ok: true, task: forClient(task) });
});

router.post("/:id/cancel", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const task = await tasks
    .cancel(id, Number(req.params.id), String(req.body?.why || "").slice(0, 200))
    .catch(() => null);
  if (!task) return res.status(404).json({ error: "no such task" });
  res.json({ ok: true, task: forClient(task) });
});

/**
 * The phone's receipt for a DISPATCHED step, and the crank that turns
 * after it. `ok:false` fails the step and skips whatever depended on it
 * rather than marching on — the plan reports three of four, not four.
 */
router.post("/:id/ack", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const stepIndex = Number(req.body?.step);
  if (!Number.isInteger(stepIndex) || stepIndex < 0) {
    return res.status(400).json({ error: "step index required" });
  }
  const out = await driver
    .acknowledge(
      id,
      Number(req.params.id),
      stepIndex,
      { ok: req.body?.ok !== false, detail: String(req.body?.detail || "").slice(0, 300) },
      { source: "device_ack" }
    )
    .catch((e) => {
      console.warn("task ack failed:", e.message);
      return null;
    });
  if (!out) return res.status(404).json({ error: "no such task or step" });
  const task = out.task || out;
  res.json({ ok: true, task: forClient(task), speak: driver.summarise(task) });
});

module.exports = router;
