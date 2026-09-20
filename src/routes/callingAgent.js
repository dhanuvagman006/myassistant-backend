/**
 * THE USER'S CALLING AGENT — settings for the Hub screen.
 *
 *   GET  /calling-agent   → every choice, what they picked, and the cost
 *   PUT  /calling-agent   → save; creates or updates their Bolna agent
 *
 * The heavy lifting (and the reasoning) is in agents/callingPersona.
 */
const router = require("express").Router();
const persona = require("../agents/callingPersona");
const agentCall = require("../agents/agentCall");

function uid(req, res) {
  const id = Number(req.user?.sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(401).json({ error: "sign in" });
    return null;
  }
  return id;
}

router.get("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  if (!agentCall.enabled()) {
    return res.status(503).json({ error: "calling is not configured yet" });
  }
  try {
    res.json(await persona.optionsFor(id));
  } catch (e) {
    console.error("calling-agent options:", e.message);
    res.status(502).json({ error: "could not load your calling agent" });
  }
});

router.put("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  if (!agentCall.enabled()) {
    return res.status(503).json({ error: "calling is not configured yet" });
  }
  try {
    await persona.setPrefs(id, req.body || {});
    // Return the full shape so the screen re-renders from one response —
    // including the cost, which moves when the brain changes.
    res.json(await persona.optionsFor(id));
  } catch (e) {
    console.error("calling-agent save:", e.message);
    res.status(502).json({ error: String(e.message).slice(0, 200) });
  }
});

module.exports = router;
