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

/**
 * HEAR IT — the provider exposes no voice-sample endpoint (probed
 * 2026-09-20: /voice/preview, /tts/preview and four others are 404, and
 * the dashboard's own play button makes no network call at all), so a
 * clip cannot be played in the app.
 *
 * The real thing is better anyway: it rings the user on their own
 * verified number and speaks a couple of lines in exactly the voice,
 * language and character they just chose. What they hear IS the call
 * their contacts will get, not an approximation of it.
 */
router.post("/preview", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  if (!agentCall.enabled()) {
    return res.status(503).json({ error: "calling is not configured yet" });
  }
  try {
    const me = await require("../db").findById(id);
    const own = String(me?.phone_number || "").trim();
    if (!own) {
      return res.status(400).json({
        error: "no_number",
        message:
          "Add and verify your phone number in Profile first — that is the " +
          "number I would ring.",
      });
    }
    const first = me?.name ? String(me.name).split(" ")[0] : null;
    const { id: callId } = await agentCall.start({
      userId: id,
      userName: first,
      toNumber: own,
      contactName: first || "you",
      task:
        "This is a sample call so they can hear how you sound. Say hello, " +
        "tell them this is how you will sound when you call people for " +
        "them, ask if the voice sounds right, and then say goodbye. Keep " +
        "the whole call under thirty seconds.",
      selfCall: true,
      // A sample is never chased — one ring, and only if they answer.
      retryTimes: 0,
    });
    res.status(202).json({ id: callId, to: "your number" });
  } catch (e) {
    if (e?.code === "quota") {
      return res.status(402).json({ error: "quota", message: "Today's call limit is reached." });
    }
    console.error("calling-agent preview:", e.message || e);
    res.status(502).json({ error: "could not place the sample call" });
  }
});

module.exports = router;
