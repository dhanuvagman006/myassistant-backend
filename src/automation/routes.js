/**
 * AUTOMATION ROUTES (behind appAuth). The phone runs the loop:
 *
 *   POST /automation/:id/step    { screen, last }   → next action, or a stop
 *   POST /automation/:id/finish  { reason, kind? }  → the phone stopped it
 *   GET  /automation/recent                        → the last few runs
 *   GET  /automation/:id                           → one run with its steps
 *
 * Runs are STARTED by the do_task_in_app tool, never directly: the tool is
 * where the assistant's safety gates (untrusted content, unattended turns)
 * already apply.
 */
const express = require("express");
const svc = require("./service");

const router = express.Router();
router.use(express.json({ limit: "400kb" }));

function uid(req) {
  const n = Number(req.user?.sub);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Only what the planner reads — never trust the shape the phone sends. */
function cleanScreen(s) {
  const nodes = Array.isArray(s?.nodes) ? s.nodes.slice(0, 400) : [];
  const str = (v, n) => (v == null ? "" : String(v).slice(0, n));
  return {
    pkg: str(s?.pkg, 120),
    keyboard: !!s?.keyboard,
    nodes: nodes.map((n) => ({
      id: Number(n?.id),
      cls: str(n?.cls, 30),
      text: n?.pwd ? "" : str(n?.text, 200),
      desc: str(n?.desc, 200),
      hint: str(n?.hint, 120),
      rid: str(n?.rid, 80),
      label: str(n?.label, 240),
      click: n?.click ? 1 : 0,
      edit: n?.edit ? 1 : 0,
      scroll: n?.scroll ? 1 : 0,
      check: n?.check ? 1 : 0,
      checked: n?.checked ? 1 : 0,
      sel: n?.sel ? 1 : 0,
      pwd: n?.pwd ? 1 : 0,
      en: n?.en === 0 ? 0 : 1,
    })).filter((n) => Number.isInteger(n.id)),
  };
}

router.post("/:id(\\d+)/step", async (req, res) => {
  const id = uid(req);
  if (!id) return res.status(401).json({ error: "sign in required" });
  try {
    const out = await svc.step(id, Number(req.params.id), {
      screen: cleanScreen(req.body?.screen),
      last: req.body?.last || null,
    });
    res.json(out);
  } catch (e) {
    console.error("automation step:", e.message);
    res.status(500).json({ status: "failed", report: "Something went wrong on my side, so I stopped." });
  }
});

router.post("/:id(\\d+)/finish", async (req, res) => {
  const id = uid(req);
  if (!id) return res.status(401).json({ error: "sign in required" });
  try {
    res.json(await svc.finish(id, Number(req.params.id), {
      reason: String(req.body?.reason || "error").slice(0, 30),
      kind: String(req.body?.kind || "").slice(0, 30),
      detail: String(req.body?.detail || "").slice(0, 120),
    }));
  } catch (e) {
    console.error("automation finish:", e.message);
    res.status(500).json({ error: "could not record that" });
  }
});

router.get("/recent", async (req, res) => {
  const id = uid(req);
  if (!id) return res.status(401).json({ error: "sign in required" });
  res.json({ runs: await svc.recent(id, req.query.limit).catch(() => []) });
});

router.get("/:id(\\d+)", async (req, res) => {
  const id = uid(req);
  if (!id) return res.status(401).json({ error: "sign in required" });
  const r = await svc.get(id, Number(req.params.id)).catch(() => null);
  if (!r) return res.status(404).json({ error: "not found" });
  res.json({ run: r });
});

module.exports = router;
module.exports.cleanScreen = cleanScreen;
