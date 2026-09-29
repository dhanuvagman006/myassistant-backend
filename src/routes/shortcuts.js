/**
 * SHORTCUTS ROUTES (behind appAuth, with their own limiter — server.js
 * shortcutLimit). Everything is scoped by req.user.sub: another user's id
 * is a 404.
 *
 *   GET    /shortcuts                   → {ok, shortcuts:[Shortcut], limits}
 *   POST   /shortcuts                   {name, other_names?, steps:[{said}]}
 *                                        → 201 {ok, shortcut, read_back, warnings} · 400 {ok:false, error, data}
 *   PATCH  /shortcuts/:id               {version, name?, other_names?, steps?:[{i}|{said}]}
 *                                        → {ok, shortcut, read_back} · 409 {ok:false, error:"stale", shortcut}
 *   DELETE /shortcuts/:id               → {ok:true}  (the screen's own dialog is the confirmation)
 *   POST   /shortcuts/:id/run           → {ok, run:{id,status,report,confirm?:{summary}}, directive?}
 *   POST   /shortcuts/runs/:id/approve  → same shape as run · 410 {error:"expired"}
 *   POST   /shortcuts/runs/:id/decline  → {ok, run}
 *
 * A tap is the user's own request: there is no voice turn, so no input
 * quality; every step still runs through registry.execute with its gates.
 * The contract, with an example of every object, is
 * tests/fixtures/shortcuts/contract.json.
 */
const router = require("express").Router();
const store = require("../shortcuts/store");
const S = require("../shortcuts/steps");

function uid(req, res) {
  const id = Number(req.user?.sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ ok: false, error: "no_account" });
    return null;
  }
  return id;
}

router.use((req, res, next) => {
  if (process.env.SHORTCUTS === "off") return res.status(503).json({ ok: false, error: "off" });
  next();
});

async function ctxFor(userId, req, tag) {
  const runner = require("../shortcuts/runner");
  const caps = await runner.capsFor(userId, req);
  const tz = Number(req.get("X-TZ-Offset"));
  const sessionId = `screen:${userId}:${tag}:${Date.now()}`;
  const session = require("../agents/sessionState").begin(userId, sessionId, { surface: "screen", appBuild: caps.build });
  return {
    userId,
    appBuild: caps.build,
    deviceCaps: caps,
    platform: caps.platform,
    tzOffsetMin: Number.isFinite(tz) ? tz : 330,
    source: "screen",
    session,
    sessionId,
  };
}

const LIMITS = { max_shortcuts: S.MAX_SHORTCUTS, max_steps: S.MAX_STEPS, max_names: S.MAX_NAMES };

function saidTexts(steps) {
  if (!Array.isArray(steps)) return null;
  return steps.map((s) => (s && typeof s === "object" ? s.said : s)).map((x) => String(x || "").trim());
}

function otherNames(v) {
  return Array.isArray(v) ? v.map((x) => String(x || "").trim()).filter(Boolean).slice(0, S.MAX_NAMES - 1) : [];
}

function runShape(out) {
  if (out.parked) {
    return { ok: true, run: { id: out.run.id, status: out.run.status, report: "", confirm: { summary: out.summary } } };
  }
  return {
    ok: true,
    run: { id: out.run.id, status: out.run.status, report: out.run.report || out.speak || "" },
    ...(out.directive ? { directive: out.directive } : {}),
  };
}

router.get("/", async (req, res) => {
  const id = uid(req, res);
  if (!id) return;
  try {
    const list = await store.list(id);
    res.json({ ok: true, shortcuts: list.map(store.publicShortcut), limits: LIMITS });
  } catch (e) {
    console.error("shortcuts list:", e.message);
    res.status(500).json({ ok: false, error: "failed" });
  }
});

router.post("/", async (req, res) => {
  const id = uid(req, res);
  if (!id) return;
  const texts = saidTexts(req.body?.steps);
  const name = String(req.body?.name || "").slice(0, 200);
  if (!name || !texts || !texts.length) return res.status(400).json({ ok: false, error: "no_steps", data: {} });
  try {
    const ctx = await ctxFor(id, req, "create");
    const out = await require("../tools/registry").execute("create_shortcut",
      { name, other_names: otherNames(req.body?.other_names), steps: texts }, ctx);
    if (!out.ok) return res.status(400).json({ ok: false, error: out.error, data: out.data || {} });
    const sc = await store.get(id, out.data.shortcut_id);
    res.status(201).json({ ok: true, shortcut: store.publicShortcut(sc), read_back: out.speak, warnings: out.data.warnings || [] });
  } catch (e) {
    console.error("shortcuts create:", e.message);
    res.status(500).json({ ok: false, error: "failed" });
  }
});

router.patch("/:id(\\d+)", async (req, res) => {
  const id = uid(req, res);
  if (!id) return;
  try {
    const sc = await store.get(id, req.params.id);
    if (!sc) return res.status(404).json({ ok: false, error: "not_found" });
    const b = req.body || {};
    if (b.version !== undefined && Number(b.version) !== sc.version) {
      return res.status(409).json({ ok: false, error: "stale", shortcut: store.publicShortcut(sc) });
    }
    let keep;
    let said;
    if (Array.isArray(b.steps)) {
      keep = b.steps.filter((s) => s && s.i !== undefined && s.said === undefined).map((s) => Number(s.i));
      said = b.steps.filter((s) => s && s.said !== undefined).map((s) => String(s.said || "").trim()).filter(Boolean);
    }
    const ctx = await ctxFor(id, req, "update");
    const { applyUpdate } = require("../shortcuts/tools");
    const out = await applyUpdate(ctx, sc, {
      newName: b.name === undefined ? undefined : String(b.name),
      otherNames: b.other_names === undefined ? undefined : otherNames(b.other_names),
      keep, said, version: b.version,
    });
    if (!out.ok) return res.status(400).json({ ok: false, error: out.error, data: out.data || {} });
    const fresh = await store.get(id, sc.id);
    res.json({ ok: true, shortcut: store.publicShortcut(fresh), read_back: out.speak, warnings: out.data.warnings || [] });
  } catch (e) {
    if (e instanceof store.ShortcutError && e.code === "stale") {
      const cur = await store.get(id, req.params.id).catch(() => null);
      return res.status(409).json({ ok: false, error: "stale", shortcut: store.publicShortcut(cur) });
    }
    if (e instanceof store.ShortcutError) return res.status(400).json({ ok: false, error: e.code, data: e.data });
    console.error("shortcuts update:", e.message);
    res.status(500).json({ ok: false, error: "failed" });
  }
});

router.delete("/:id(\\d+)", async (req, res) => {
  const id = uid(req, res);
  if (!id) return;
  const gone = await store.remove(id, req.params.id).catch(() => false);
  if (!gone) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true });
});

router.post("/:id(\\d+)/run", async (req, res) => {
  const id = uid(req, res);
  if (!id) return;
  try {
    const sc = await store.get(id, req.params.id);
    if (!sc) return res.status(404).json({ ok: false, error: "not_found" });
    const ctx = await ctxFor(id, req, `run${sc.id}`);
    if (ctx.appBuild && ctx.appBuild < 120) return res.status(400).json({ ok: false, error: "app_too_old" });
    const out = await require("../shortcuts/runner").start(id, sc, ctx);
    if (!out.ok) return res.status(out.error === "daily_limit" ? 429 : 400).json({ ok: false, error: out.error, data: out.data || {} });
    res.json(runShape(out));
  } catch (e) {
    console.error("shortcuts run:", e.message);
    res.status(500).json({ ok: false, error: "failed" });
  }
});

router.post("/runs/:id(\\d+)/approve", async (req, res) => {
  const id = uid(req, res);
  if (!id) return;
  try {
    const ctx = await ctxFor(id, req, `approve${req.params.id}`);
    const out = await require("../shortcuts/runner").resume(id, req.params.id, ctx);
    if (!out.ok) {
      if (out.error === "expired") return res.status(410).json({ ok: false, error: "expired" });
      if (out.error === "no_such_run") return res.status(404).json({ ok: false, error: "not_found" });
      return res.status(400).json({ ok: false, error: out.error, data: out.data || {} });
    }
    res.json(runShape(out));
  } catch (e) {
    console.error("shortcuts approve:", e.message);
    res.status(500).json({ ok: false, error: "failed" });
  }
});

router.post("/runs/:id(\\d+)/decline", async (req, res) => {
  const id = uid(req, res);
  if (!id) return;
  const run = await store.getRun(id, req.params.id).catch(() => null);
  if (!run) return res.status(404).json({ ok: false, error: "not_found" });
  const out = await require("../shortcuts/runner").decline(id, run.id);
  res.json({ ok: true, run: { id: run.id, status: out.ok ? out.run.status : run.status } });
});

module.exports = router;
