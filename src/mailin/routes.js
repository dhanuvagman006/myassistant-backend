/**
 * BILLS BY EMAIL — the app's routes, behind appAuth (spec §6.1, §6.2).
 * When the feature is off every write answers 503 and GET /mailin says
 * available:false, so the app hides every entry point.
 */
const express = require("express");
const address = require("./address");
const service = require("./service");
const audit = require("../audit/log");

const router = express.Router();

function uid(req, res) {
  const id = Number(req.user && req.user.sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "a signed-in account is needed" });
    return null;
  }
  return id;
}

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error("mailin route:", e.message);
  res.status(500).json({ error: "something went wrong" });
});

function needOn(res) {
  if (service.available()) return true;
  res.status(503).json({ error: "not available" });
  return false;
}

router.get("/", wrap(async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  res.json(await service.status(id));
}));

router.post("/address", wrap(async (req, res) => {
  const id = uid(req, res);
  if (id === null || !needOn(res)) return;
  const row = await address.turnOn(id);
  audit.record(id, "mailin.on", "bills by email turned on");
  res.json({ address: address.toClient(row) });
}));

router.post("/address/state", wrap(async (req, res) => {
  const id = uid(req, res);
  if (id === null || !needOn(res)) return;
  const on = req.body && req.body.on === true;
  const row = await address.setOn(id, on);
  if (!row) return res.status(404).json({ error: "no address yet" });
  audit.record(id, on ? "mailin.on" : "mailin.off", `bills by email switched ${on ? "on" : "off"}`);
  res.json({ address: address.toClient(row) });
}));

router.post("/address/rotate", wrap(async (req, res) => {
  const id = uid(req, res);
  if (id === null || !needOn(res)) return;
  try {
    const r = await address.rotate(id);
    audit.record(id, "mailin.rotate", "bills by email: new address");
    res.json({ address: address.toClient(r.address), retired: r.retired ? address.toClient(r.retired).address : null });
  } catch (e) {
    if (e.code === "rotate_limit") {
      return res.status(429).json({ error: `You can get a new address ${address.ROTATE_PER_DAY} times a day.` });
    }
    throw e;
  }
}));

router.get("/messages", wrap(async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  res.json({ messages: await service.recent(id, Number(req.query.limit) || 20) });
}));

router.post("/messages/:id/remind", wrap(async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const r = await service.remindAnyway(id, Number(req.params.id));
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ reminders: r.reminders });
}));

router.post("/messages/:id/trust", wrap(async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const r = await service.trustAndRemind(id, Number(req.params.id));
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ trustedFrom: r.trustedFrom, reminders: r.reminders });
}));

router.post("/trusted/remove", wrap(async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const list = await address.untrust(id, req.body && req.body.address);
  if (!list) return res.status(404).json({ error: "not in the list" });
  res.json({ trustedFrom: list });
}));

module.exports = { router };
