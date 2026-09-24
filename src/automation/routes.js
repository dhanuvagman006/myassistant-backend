/**
 * AUTOMATION ROUTES (behind appAuth). The phone runs the loop:
 *
 *   POST /automation/:id/step       { seq?, screen, last } → next action, or a stop
 *   POST /automation/:id/finish     { reason, kind?, detail? } → the phone stopped it
 *   POST /automation/:id/owner_done                        → the owner tapped Continue
 *   GET  /automation/recent                               → the last few runs
 *   GET  /automation/:id                                  → one run with its steps
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

// What the phone could see on this look (app build 105+). Only these
// values pass; anything else reads as "not reported".
const SHOT = new Set(["ok", "black", "failed", "rate_limited", "unsupported", "none"]);
const TREE = new Set(["ok", "empty", "no_root"]);
function cleanAccess(a) {
  if (!a || typeof a !== "object") return null;
  return {
    shot: SHOT.has(a.shot) ? a.shot : "none",
    tree: TREE.has(a.tree) ? a.tree : "ok",
    locked: a.locked === true,
  };
}

/**
 * Only what the planner reads — never trust the shape the phone sends.
 *
 * A LEANER UPLOAD (phase B, 2026-09-24): the phone may leave out keys
 * that hold nothing (0, "", -1) and gzip the body (Content-Encoding:
 * gzip; express.json inflates it, and the size limit counts the inflated
 * bytes). Every missing key reads as its default here — a missing `en`
 * is ENABLED, a missing `up` is no parent — so the phone must keep
 * `en: 0` for a disabled element.
 */
function cleanScreen(s) {
  const nodes = Array.isArray(s?.nodes) ? s.nodes.slice(0, 400) : [];
  const str = (v, n) => (v == null ? "" : String(v).slice(0, n));
  const access = cleanAccess(s?.access);
  // The screenshot: a small JPEG, base64. Anything else is dropped — and
  // so is a picture the phone itself called black (a protected screen):
  // it shows nothing and would only invite taps at nothing.
  const shot = access?.shot !== "black" && typeof s?.shot === "string" && s.shot.length < 900_000 &&
    /^[A-Za-z0-9+/=]+$/.test(s.shot.slice(0, 200)) ? s.shot : "";
  const box = (b) => Array.isArray(b) && b.length === 4 && b.every((v) => Number.isFinite(Number(v)))
    ? b.map((v) => Math.max(0, Math.min(1000, Math.round(Number(v))))) : null;
  return {
    pkg: str(s?.pkg, 120),
    keyboard: !!s?.keyboard,
    shot,
    ...(access ? { access } : {}),
    nodes: nodes.map((n) => ({
      id: Number(n?.id),
      up: Number.isInteger(Number(n?.up)) ? Number(n.up) : -1,
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
      b: box(n?.b),
    })).filter((n) => Number.isInteger(n.id)),
  };
}

router.post("/:id(\\d+)/step", async (req, res) => {
  const id = uid(req);
  if (!id) return res.status(401).json({ error: "sign in required" });
  const runId = Number(req.params.id);
  const started = Date.now();
  const screen = cleanScreen(req.body?.screen);
  const raw = req.body?.seq;
  const seq = Number.isInteger(raw) && raw >= 0 && raw < 1000 ? raw : null;
  const meta = {};
  try {
    const out = await svc.step(id, runId, {
      screen,
      last: req.body?.last && typeof req.body.last === "object" ? req.body.last : null,
      seq,
    }, meta);
    // COUNTS AND TIMES ONLY — never the screen's content. One line per
    // step, so a slow run can be read phase by phase: the model's share
    // (llm_ms, in_tok; ≈ when the model did not report its count) beside
    // the whole step (ms). Phase B (2026-09-24) adds how the call was made
    // — thinking level, picture resolution, model — and what the phone
    // uploaded (KB on the wire; gz when it came compressed), so every
    // speed change is measured on this same line.
    const len = Number(req.headers["content-length"]);
    const gz = /gzip|deflate|br/i.test(String(req.headers["content-encoding"] || ""));
    console.log(`automation step run=${runId} seq=${seq ?? "-"} llm_ms=${meta.llm_ms || 0} ` +
      `in_tok≈${meta.in_tok || 0} nodes=${screen.nodes.length} ` +
      `shot=${screen.shot ? Math.round(screen.shot.length * 0.75 / 1024) + "KB" : "none"}` +
      `${req.body?.screen?.shot && !screen.shot ? " (dropped)" : ""} ` +
      `calls=${meta.calls || 0} ms=${Date.now() - started} status=${out?.status || "?"} ` +
      `think=${String(meta.think || "-").toLowerCase()} ` +
      `res=${String(meta.res || "-").replace(/^MEDIA_RESOLUTION_/, "").toLowerCase()} ` +
      `model=${meta.model || "-"} up=${Number.isFinite(len) ? Math.round(len / 1024) + "KB" : "-"}${gz ? " gz" : ""}`);
    res.json(out);
  } catch (e) {
    console.error(`automation step run=${runId}:`, e.message);
    // A 500 read on the phone as "I lost the connection" and a retry; the
    // truth is that the step broke here. The run ends, with that sentence.
    const f = await svc.finish(id, runId, { reason: "error", detail: "server" }).catch(() => null);
    res.json({ status: "failed", report: f?.report || "Something went wrong on my side, so I stopped." });
  }
});

router.post("/:id(\\d+)/owner_done", async (req, res) => {
  const id = uid(req);
  if (!id) return res.status(401).json({ error: "sign in required" });
  try {
    res.json(await svc.ownerDone(id, Number(req.params.id)));
  } catch (e) {
    console.error("automation owner_done:", e.message);
    res.status(500).json({ ok: false, error: "could not record that" });
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
