/**
 * CONNECTED APPS, AS THE MAIN APP MANAGES THEM — behind appAuth, a signed-in
 * session only (an assistant-functions key or a connected app's key can
 * never mint keys).
 *
 *   GET    /platform/scopes                     what an app may be allowed
 *   GET    /platform/apps                       the user's apps, with usage and latest activity
 *   POST   /platform/apps                       connect one → { app, key }   (key shown once)
 *   GET    /platform/apps/:id                   one app, its keys, collections, usage
 *   PATCH  /platform/apps/:id                   rename, scopes, instructions, pause/resume
 *   DELETE /platform/apps/:id                   the app and everything it kept
 *   POST   /platform/apps/:id/keys              another key → { key }       (shown once)
 *   DELETE /platform/apps/:id/keys/:keyId       revoke one
 *   GET    /platform/apps/:id/activity          its feed (?before=<id>)
 *   GET    /platform/apps/:id/records/:collection   its records, to look through
 */
const router = require("express").Router();
const store = require("./store");
const scopes = require("./scopes");
const audit = require("../audit/log");
// The assistant's "is this about one of my apps?" words are cached a minute.
const forget = (uid) => require("./tools").forget(uid);

function uidOf(req, res) {
  if (req.auth && req.auth.scope && req.auth.scope !== "session") {
    res.status(403).json({ error: "sign in to My Assistant to manage connected apps" });
    return null;
  }
  const id = Number(req.user && req.user.sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(401).json({ error: "sign in required" });
    return null;
  }
  return id;
}

// Where the docs and the API are, as the phone should open them: the
// public address, or (no PUBLIC_BASE_URL, e.g. a local server) this request's host.
const baseOf = (req) => String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
const docsUrl = (req) => `${baseOf(req)}/developers`;
const apiBase = (req) => `${baseOf(req)}/v1`;

async function summary(app) {
  const [today, month, last] = await Promise.all([
    store.usageToday(app.id),
    store.usageMonth(app.id),
    store.listEvents(app.userId, app.id, { limit: 1 }),
  ]);
  return { ...app, usage: { today, month }, lastEvent: last[0] || null };
}

router.get("/scopes", (req, res) => {
  if (uidOf(req, res) === null) return;
  res.json({ scopes: scopes.SCOPES, docsUrl: docsUrl(req), apiBase: apiBase(req) });
});

router.get("/apps", async (req, res) => {
  const uid = uidOf(req, res);
  if (uid === null) return;
  const apps = await store.listApps(uid);
  res.json({ apps: await Promise.all(apps.map(summary)), docsUrl: docsUrl(req), apiBase: apiBase(req) });
});

router.post("/apps", async (req, res) => {
  const uid = uidOf(req, res);
  if (uid === null) return;
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const out = await store.createApp(uid, {
    name: b.name, description: b.description, icon: b.icon, homepage: b.homepage,
    keywords: b.keywords, instructions: b.instructions, scopes: scopes.clean(b.scopes),
  });
  if (out.error) return res.status(400).json({ error: out.error });
  forget(uid);
  const key = await store.createKey(uid, out.app.id, "First key");
  audit.record(uid, "platform.app.connected", `Connected "${out.app.name}" to your assistant`);
  res.status(201).json({ app: await summary(out.app), key: key.key, keyInfo: key.info, docsUrl: docsUrl(req), apiBase: apiBase(req) });
});

router.get("/apps/:id", async (req, res) => {
  const uid = uidOf(req, res);
  if (uid === null) return;
  const app = await store.getApp(uid, req.params.id);
  if (!app) return res.status(404).json({ error: "not found" });
  const [keys, collections] = await Promise.all([store.listKeys(uid, app.id), store.collections(app)]);
  res.json({ app: await summary(app), keys, collections, docsUrl: docsUrl(req), apiBase: apiBase(req) });
});

router.patch("/apps/:id", async (req, res) => {
  const uid = uidOf(req, res);
  if (uid === null) return;
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const patch = {};
  for (const k of ["name", "description", "icon", "homepage", "keywords", "instructions"]) {
    if (b[k] !== undefined) patch[k] = b[k];
  }
  if (b.scopes !== undefined) patch.scopes = scopes.clean(b.scopes);
  if (b.status !== undefined) {
    if (!["active", "paused"].includes(b.status)) return res.status(400).json({ error: "status: active or paused" });
    patch.status = b.status;
  }
  const app = await store.updateApp(uid, req.params.id, patch);
  if (!app) return res.status(404).json({ error: "not found" });
  forget(uid);
  if (patch.status) {
    audit.record(uid, `platform.app.${patch.status}`, `${patch.status === "paused" ? "Paused" : "Resumed"} "${app.name}"`);
  }
  res.json({ app: await summary(app) });
});

router.delete("/apps/:id", async (req, res) => {
  const uid = uidOf(req, res);
  if (uid === null) return;
  const app = await store.getApp(uid, req.params.id);
  if (!app || !(await store.deleteApp(uid, app.id))) return res.status(404).json({ error: "not found" });
  forget(uid);
  audit.record(uid, "platform.app.removed", `Removed "${app.name}" and everything it kept`);
  res.json({ ok: true });
});

router.post("/apps/:id/keys", async (req, res) => {
  const uid = uidOf(req, res);
  if (uid === null) return;
  const out = await store.createKey(uid, req.params.id, String((req.body && req.body.label) || ""));
  if (!out) return res.status(404).json({ error: "not found" });
  if (out.error) return res.status(400).json({ error: out.error });
  audit.record(uid, "platform.key.created", `New API key ${out.info.prefix}… for a connected app`);
  res.status(201).json({ key: out.key, keyInfo: out.info });
});

router.delete("/apps/:id/keys/:keyId", async (req, res) => {
  const uid = uidOf(req, res);
  if (uid === null) return;
  if (!(await store.revokeKey(uid, req.params.id, req.params.keyId))) return res.status(404).json({ error: "not found" });
  audit.record(uid, "platform.key.revoked", "Revoked an API key of a connected app");
  res.json({ ok: true });
});

router.get("/apps/:id/activity", async (req, res) => {
  const uid = uidOf(req, res);
  if (uid === null) return;
  const app = await store.getApp(uid, req.params.id);
  if (!app) return res.status(404).json({ error: "not found" });
  res.json({ events: await store.listEvents(uid, app.id, { limit: req.query.limit, before: req.query.before }) });
});

router.get("/apps/:id/records/:collection", async (req, res) => {
  const uid = uidOf(req, res);
  if (uid === null) return;
  const app = await store.getApp(uid, req.params.id);
  if (!app) return res.status(404).json({ error: "not found" });
  res.json({ records: await store.listRecords(app, req.params.collection, { limit: req.query.limit, before: req.query.before }) });
});

module.exports = router;
