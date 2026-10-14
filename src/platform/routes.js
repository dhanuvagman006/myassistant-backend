/**
 * THE MY ASSISTANT API, v1 — what a connected app calls with its key
 * (src/platform/auth.js). Documented for developers at /developers.
 *
 *   GET    /v1/me                                  the app, its scopes, who it acts for
 *   POST   /v1/assistant/messages                  talk to the assistant (+ app tools)
 *   DELETE /v1/assistant/conversations/:id         forget a conversation's thread
 *   POST   /v1/voice/sessions                      a realtime voice session
 *   POST   /v1/voice/transcript                    file a voice conversation
 *   GET    /v1/tools                               assistant tools this key may call
 *   POST   /v1/tools/call                          run one
 *   GET    /v1/memory                              what the assistant remembers
 *   POST   /v1/memory                              add to it
 *   PUT    /v1/records/:collection/:id             the app's own data
 *   POST   /v1/records/:collection                 … with a new id
 *   GET    /v1/records/:collection(/:id)
 *   DELETE /v1/records/:collection/:id
 *   GET    /v1/records                             collections and counts
 *   POST   /v1/events                              the app's activity feed
 *   GET    /v1/events
 *   POST   /v1/notify                              a notification on the user's phone
 *
 * Every error is { error: { code, message } }.
 */
const express = require("express");
const router = express.Router();
const store = require("./store");
const { need, error } = require("./auth");
const { ApiError } = require("./assistant");
const registry = require("../tools/registry");

const NOTIFY_PER_DAY = () => Number(process.env.PLATFORM_DAILY_NOTIFICATIONS) || 20;

const appOf = (req) => req.platform.app;
const tzOf = (req) => {
  const h = Number(req.get("X-TZ-Offset"));
  return Number.isFinite(h) && Math.abs(h) <= 14 * 60 ? h : (req.auth && req.auth.tzOffsetMin) ?? null;
};

/** Runs fn; an ApiError becomes its status, anything else a 500 without detail. */
function handle(fn) {
  return async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      if (e instanceof ApiError) return error(res, e.status, e.code, e.message);
      if (e && (e.status === 429 || /429|rate/i.test(String(e.message)))) {
        return error(res, 503, "busy", "The assistant is busy — try again in a moment.");
      }
      // The model itself failed (down, timed out, not configured): the
      // request was fine, so it is said plainly and may simply be retried.
      if (e && /OpenAI|Gemini/i.test(String((e.constructor && e.constructor.name) || "") + " " + String(e.name || ""))) {
        console.warn(`[platform] ${req.method} ${req.path}: the model failed — ${String(e.message || e).slice(0, 160)}`);
        return error(res, 503, "assistant_unavailable", "Your assistant couldn't answer just now — try again in a moment.");
      }
      console.error(`[platform] ${req.method} ${req.path} failed:`, e && (e.stack || e.message));
      return error(res, 500, "server_error", "Something went wrong on our side.");
    }
  };
}

/* ------------------------------------------------------------------ me */

router.get("/me", handle(async (req) => {
  const app = appOf(req);
  const out = {
    app: { id: app.id, slug: app.slug, name: app.name, scopes: app.scopes },
  };
  if (app.scopes.includes("profile")) {
    const p = await require("../users/context").getProfile(Number(req.user.sub)).catch(() => null);
    out.user = { name: (p && p.user && p.user.name) || "" };
    out.assistant = { name: (p && p.assistant && p.assistant.name) || "Assistant" };
  }
  return out;
}));

/* ------------------------------------------------------------ assistant */

router.post("/assistant/messages", need("assistant"), handle(async (req) => {
  const user = { id: Number(req.user.sub) };
  return require("./assistant").converse({ app: appOf(req), user, body: req.body, tzOffsetMin: tzOf(req) });
}));

router.delete("/assistant/conversations/:id", need("assistant"), handle(async (req) => {
  const gone = await store.deleteConversation(appOf(req), req.params.id);
  if (!gone) throw new ApiError(404, "unknown_conversation", "No such conversation for this app.");
  return { ok: true };
}));

/* ---------------------------------------------------------------- voice */

router.post("/voice/sessions", need("voice"), handle(async (req, res) => {
  const out = await require("./voice").openSession({
    app: appOf(req), user: { id: Number(req.user.sub) }, body: req.body, tzOffsetMin: tzOf(req),
  });
  res.status(201).json(out);
}));

router.post("/voice/transcript", need("voice"), handle(async (req) =>
  require("./voice").transcript({ app: appOf(req), user: { id: Number(req.user.sub) }, body: req.body })));

/* ---------------------------------------------------------------- tools */

router.get("/tools", handle(async (req) => {
  const app = appOf(req);
  const { apiTool } = require("./assistant");
  const voice = require("./voice");
  let names = [];
  if (app.scopes.includes("tools")) names = registry.list().filter((t) => apiTool(t, app.scopes)).map((t) => t.name);
  else if (app.scopes.includes("voice")) names = voice.voiceToolNames(app.scopes);
  const decls = names.length ? registry.declarations({ userId: Number(req.user.sub), only: names }) : [];
  const toJson = (s) => {
    if (!s || typeof s !== "object") return s;
    const o = { ...s };
    if (typeof o.type === "string") o.type = o.type.toLowerCase();
    if (o.properties) o.properties = Object.fromEntries(Object.entries(o.properties).map(([k, v]) => [k, toJson(v)]));
    if (o.items) o.items = toJson(o.items);
    return o;
  };
  return { tools: decls.map((d) => ({ name: d.name, description: d.description, parameters: toJson(d.parameters) })) };
}));

router.post("/tools/call", handle(async (req) => {
  const app = appOf(req);
  if (!app.scopes.includes("tools") && !app.scopes.includes("voice")) {
    throw new ApiError(403, "missing_scope", 'This app needs "tools" (or "voice" for its voice sessions) to run assistant tools.');
  }
  return require("./voice").callTool({ app, user: { id: Number(req.user.sub) }, body: req.body, tzOffsetMin: tzOf(req) });
}));

/* --------------------------------------------------------------- memory */

router.get("/memory", need("memory:read"), handle(async (req) => {
  const mem = require("../agents/memory");
  const all = await mem.listMemories(Number(req.user.sub));
  const q = String(req.query.q || "").toLowerCase().trim();
  const words = q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  const hit = (f) => !words.length || words.some((w) => String(f).toLowerCase().includes(w));
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  return {
    memories: all.filter((m) => hit(m.fact)).slice(0, limit)
      .map((m) => ({ id: Number(m.id), fact: m.fact, kind: m.kind || "semantic", createdAt: Number(m.created_at) || null })),
  };
}));

router.post("/memory", need("memory:write"), handle(async (req) => {
  const fact = typeof (req.body && req.body.fact) === "string" ? req.body.fact.trim() : "";
  if (!fact) throw new ApiError(400, "fact_required", "fact: one sentence about the user, e.g. \"Prefers metric units\"");
  if (fact.length > 300) throw new ApiError(400, "fact_too_long", "fact is longer than 300 characters");
  const app = appOf(req);
  await require("../agents/memory").saveMemory(Number(req.user.sub), fact, 2, "semantic");
  try {
    require("../audit/log").record(Number(req.user.sub), "platform.memory.added", `${app.name} added to your memory: ${fact.slice(0, 120)}`);
  } catch (_) {}
  return { ok: true };
}));

/* -------------------------------------------------------------- records */

const bodyOf = (req) => (req.body && typeof req.body === "object" ? req.body : {});
const recordOrThrow = (out) => {
  if (out.error) throw new ApiError(400, "bad_record", out.error);
  return out;
};

router.get("/records", need("data"), handle(async (req) => ({ collections: await store.collections(appOf(req)) })));

router.put("/records/:collection/:id", need("data"), handle(async (req, res) => {
  const b = bodyOf(req);
  const out = recordOrThrow(await store.putRecord(appOf(req), req.params.collection, req.params.id, { data: b.data, summary: b.summary }));
  res.status(out.created ? 201 : 200).json({ record: out.record });
}));

router.post("/records/:collection", need("data"), handle(async (req, res) => {
  const b = bodyOf(req);
  const out = recordOrThrow(await store.putRecord(appOf(req), req.params.collection, null, { data: b.data, summary: b.summary }));
  res.status(201).json({ record: out.record });
}));

router.get("/records/:collection", need("data"), handle(async (req) => ({
  records: await store.listRecords(appOf(req), req.params.collection, { limit: req.query.limit, before: req.query.before }),
})));

router.get("/records/:collection/:id", need("data"), handle(async (req) => {
  const r = await store.getRecord(appOf(req), req.params.collection, req.params.id);
  if (!r) throw new ApiError(404, "not_found", "No such record.");
  return { record: r };
}));

router.delete("/records/:collection/:id", need("data"), handle(async (req) => {
  if (!(await store.deleteRecord(appOf(req), req.params.collection, req.params.id))) {
    throw new ApiError(404, "not_found", "No such record.");
  }
  return { ok: true };
}));

/* --------------------------------------------------------------- events */

router.post("/events", need("data"), handle(async (req, res) => {
  const b = bodyOf(req);
  const out = await store.addEvent(appOf(req), { type: b.type, summary: b.summary, data: b.data });
  if (out.error) throw new ApiError(400, "bad_event", out.error);
  res.status(201).json({ event: out.event });
}));

router.get("/events", need("data"), handle(async (req) => {
  const app = appOf(req);
  return { events: await store.listEvents(app.userId, app.id, { limit: req.query.limit, before: req.query.before }) };
}));

/* --------------------------------------------------------------- notify */

router.post("/notify", need("notify"), handle(async (req) => {
  const app = appOf(req);
  const b = bodyOf(req);
  const title = String(b.title || app.name).replace(/\s+/g, " ").trim().slice(0, 80);
  const text = String(b.body || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!text) throw new ApiError(400, "body_required", "body: the notification text");
  const used = await store.usageToday(app.id);
  if (used.notifications >= NOTIFY_PER_DAY()) {
    throw new ApiError(429, "daily_limit", `This app has sent today's ${NOTIFY_PER_DAY()} notifications.`);
  }
  store.bump(app, "notifications");
  // Kept in the feed too, so the main app shows it under the app.
  await store.addEvent(app, { type: "notification", summary: `${title}: ${text}`.slice(0, 400) });
  const u = await require("../db").one(`SELECT fcm_token FROM users WHERE id=$1`, [app.userId]);
  if (!u || !u.fcm_token) return { ok: true, delivered: false, reason: "no phone signed in" };
  const r = await require("../services/push").send(u.fcm_token, title, text, {
    kind: "connected_app", appId: String(app.id), appName: app.name,
  });
  return { ok: true, delivered: Boolean(r && r.ok) };
}));

module.exports = router;
