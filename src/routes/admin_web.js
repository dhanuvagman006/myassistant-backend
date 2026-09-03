/**
 * ADMIN PANEL — session login + JSON API + static single-page app.
 *
 * Rewritten 2026-09-03 (v2). The old panel took the key as ?key=… in the
 * URL (which leaks into logs/history) and served one server-rendered page.
 * Now:
 *   - GET  /admin-panel            → the SPA shell (login screen included)
 *   - POST /admin-panel/api/login  → verifies ADMIN_KEY, sets an HttpOnly
 *     signed session cookie (12 h). The key never appears in a URL again.
 *   - /admin-panel/api/*           → JSON endpoints behind that cookie.
 *
 * Powers: full user management (search, detail, edit profile fields,
 * attach+verify phone, pause/resume, clear device, test push, cascade
 * delete via the same table list as /privacy/account), analytics series,
 * audit-trail explorer, live feature-flag overrides (kv-backed, read by
 * /config), push broadcast, and a debug page with DB/integration probes.
 *
 * Guard notes: login is rate-limited per IP; the session token is
 * HMAC(ADMIN_KEY)-signed with an expiry, so rotating ADMIN_KEY invalidates
 * every session. With ADMIN_KEY unset the panel refuses to serve.
 */
const router = require("express").Router();
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const db = require("../db");
const { normalizePhone } = require("../users/phone");
const appUpdate = require("./appUpdate");
const push = require("../services/push");
const remoteConfig = require("../config/remoteConfig");
const privacy = require("./privacy");

router.use(express.json());

/* ------------------------------------------------------------------ */
/* Session auth                                                        */
/* ------------------------------------------------------------------ */

const COOKIE = "admin_session";
const SESSION_MS = 12 * 3600_000;
const KEY = () => process.env.ADMIN_KEY || "";

const sign = (exp) =>
  crypto.createHmac("sha256", KEY()).update(`admin:${exp}`).digest("hex");

function makeToken() {
  const exp = Date.now() + SESSION_MS;
  return `${exp}.${sign(exp)}`;
}

function validToken(tok) {
  const [expS, sig] = String(tok || "").split(".");
  const exp = parseInt(expS, 10);
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
  const want = sign(exp);
  return (
    sig.length === want.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))
  );
}

function cookieOf(req) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return "";
}

function setSession(req, res, value, maxAgeS) {
  const secure =
    req.secure || req.get("x-forwarded-proto") === "https" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${encodeURIComponent(value)}; Path=/admin-panel; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure}`
  );
}

// Login attempts: 8 per 10 minutes per IP.
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 600_000);
  attempts.set(ip, list);
  return list.length >= 8;
}

router.post("/api/login", (req, res) => {
  const key = KEY();
  if (key.length < 16) return res.status(503).json({ error: "panel disabled" });
  const ip = req.ip || "?";
  if (throttled(ip)) {
    return res.status(429).json({ error: "Too many attempts — wait 10 minutes." });
  }
  const got = String(req.body?.key || "");
  const ok =
    got.length === key.length &&
    crypto.timingSafeEqual(Buffer.from(got), Buffer.from(key));
  if (!ok) {
    attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]);
    return res.status(401).json({ error: "Wrong admin key." });
  }
  setSession(req, res, makeToken(), SESSION_MS / 1000);
  res.json({ ok: true });
});

router.post("/api/logout", (req, res) => {
  setSession(req, res, "", 0);
  res.json({ ok: true });
});

router.use("/api", (req, res, next) => {
  if (KEY().length < 16) return res.status(503).json({ error: "panel disabled" });
  if (!validToken(cookieOf(req))) return res.status(401).json({ error: "sign in" });
  next();
});

router.get("/api/session", (_req, res) => res.json({ ok: true }));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Query that returns [] instead of throwing (schema drift tolerant). */
async function sq(sql, params = []) {
  try {
    return await db.query(sql, params);
  } catch (_) {
    return [];
  }
}
const cnt = async (sql, params) =>
  parseInt((await sq(sql, params))?.[0]?.count ?? 0, 10) || 0;

/** Per-day counts for the last `days`, zero-filled. col is epoch-ms. */
async function perDay(table, col, days, extraWhere = "") {
  const rows = await sq(
    `SELECT to_char(to_timestamp(${col}/1000.0),'YYYY-MM-DD') AS d, COUNT(*) AS count
       FROM ${table} WHERE ${col} > $1 ${extraWhere} GROUP BY d`,
    [Date.now() - days * 86400_000]
  );
  const byDay = Object.fromEntries(rows.map((r) => [r.d, parseInt(r.count, 10)]));
  return [...Array(days)].map((_, i) => {
    const d = new Date(Date.now() - (days - 1 - i) * 86400_000)
      .toISOString()
      .slice(0, 10);
    return { d, count: byDay[d] || 0 };
  });
}

async function distinctPerDay(days) {
  const rows = await sq(
    `SELECT to_char(to_timestamp(created_at/1000.0),'YYYY-MM-DD') AS d,
            COUNT(DISTINCT user_id) AS count
       FROM actions_log WHERE created_at > $1 GROUP BY d`,
    [Date.now() - days * 86400_000]
  );
  const byDay = Object.fromEntries(rows.map((r) => [r.d, parseInt(r.count, 10)]));
  return [...Array(days)].map((_, i) => {
    const d = new Date(Date.now() - (days - 1 - i) * 86400_000)
      .toISOString()
      .slice(0, 10);
    return { d, count: byDay[d] || 0 };
  });
}

const USER_COLS = `id, name, email, provider, created_at, status, gender,
  birthday, profession, organisation, location, preferred_language,
  phone_number, phone_verified_at,
  fcm_token IS NOT NULL AND fcm_token <> '' AS has_device`;

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

router.get("/api/overview", async (_req, res) => {
  const dayAgo = Date.now() - 86400_000;
  const weekAgo = Date.now() - 7 * 86400_000;
  const t0 = Date.now();
  await sq("SELECT 1");
  const dbMs = Date.now() - t0;

  const [
    users, verified, paused, devices, newWeek,
    dau, wau, actions24,
    docs, reminders, commitsOpen, clients, agentMsgs, memories, financeItems,
  ] = await Promise.all([
    cnt("SELECT COUNT(*) AS count FROM users"),
    cnt("SELECT COUNT(*) AS count FROM users WHERE phone_verified_at IS NOT NULL"),
    cnt("SELECT COUNT(*) AS count FROM users WHERE status='paused'"),
    cnt("SELECT COUNT(*) AS count FROM users WHERE fcm_token IS NOT NULL AND fcm_token <> ''"),
    cnt("SELECT COUNT(*) AS count FROM users WHERE created_at > $1", [weekAgo]),
    cnt("SELECT COUNT(DISTINCT user_id) AS count FROM actions_log WHERE created_at > $1", [dayAgo]),
    cnt("SELECT COUNT(DISTINCT user_id) AS count FROM actions_log WHERE created_at > $1", [weekAgo]),
    cnt("SELECT COUNT(*) AS count FROM actions_log WHERE created_at > $1", [dayAgo]),
    cnt("SELECT COUNT(*) AS count FROM documents"),
    cnt("SELECT COUNT(*) AS count FROM reminders WHERE done=0"),
    cnt("SELECT COUNT(*) AS count FROM commitments WHERE status='open'"),
    cnt("SELECT COUNT(*) AS count FROM clients WHERE archived=0"),
    cnt("SELECT COUNT(*) AS count FROM agent_messages"),
    cnt("SELECT COUNT(*) AS count FROM agent_memories WHERE valid=1"),
    cnt("SELECT COUNT(*) AS count FROM finance_items"),
  ]);

  const [signups14, actions14, activity] = await Promise.all([
    perDay("users", "created_at", 14),
    perDay("actions_log", "created_at", 14),
    sq(`SELECT a.action, a.detail, a.created_at, a.user_id, u.name
          FROM actions_log a LEFT JOIN users u ON u.id = a.user_id
         ORDER BY a.created_at DESC LIMIT 15`),
  ]);

  res.json({
    kpis: { users, verified, paused, devices, newWeek, dau, wau, actions24 },
    adoption: { docs, reminders, commitsOpen, clients, agentMsgs, memories, financeItems },
    signups14, actions14, activity,
    health: {
      dbMs,
      uptimeS: Math.floor(process.uptime()),
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      node: process.version,
    },
  });
});

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

router.get("/api/users", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  let where = "";
  let params = [];
  if (q) {
    where = `WHERE name ILIKE $1 OR email ILIKE $1 OR phone_number LIKE $1 OR id::text = $2`;
    params = [`%${q}%`, q];
  }
  const rows = await sq(
    `SELECT ${USER_COLS} FROM users ${where}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  const total = await cnt(`SELECT COUNT(*) AS count FROM users ${where}`, params);
  res.json({ users: rows, total });
});

router.get("/api/users/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = await sq(`SELECT ${USER_COLS} FROM users WHERE id=$1`, [id]);
  if (!rows.length) return res.status(404).json({ error: "no such user" });

  const [assistant, instructions, google, counts, recent] = await Promise.all([
    sq("SELECT name, gender, voice, style, avatar_id FROM assistant_profiles WHERE user_id=$1", [id]),
    sq("SELECT id, instruction FROM user_instructions WHERE user_id=$1 ORDER BY id", [id]),
    sq("SELECT 1 AS ok FROM google_tokens WHERE user_id=$1", [String(id)]),
    Promise.all([
      cnt("SELECT COUNT(*) AS count FROM reminders WHERE user_id=$1", [id]),
      cnt("SELECT COUNT(*) AS count FROM reminders WHERE user_id=$1 AND done=0", [id]),
      cnt("SELECT COUNT(*) AS count FROM commitments WHERE user_id=$1 AND status='open'", [id]),
      cnt("SELECT COUNT(*) AS count FROM documents WHERE user_id=$1", [id]),
      cnt("SELECT COUNT(*) AS count FROM agent_memories WHERE user_id=$1 AND valid=1", [id]),
      cnt("SELECT COUNT(*) AS count FROM clients WHERE user_id=$1", [id]),
      cnt("SELECT COUNT(*) AS count FROM finance_items WHERE user_id=$1", [id]),
      cnt("SELECT COUNT(*) AS count FROM contacts WHERE user_id=$1", [id]),
      cnt("SELECT COUNT(*) AS count FROM agent_messages WHERE to_user_id=$1 OR from_user_id=$1", [id]),
      cnt("SELECT COUNT(*) AS count FROM actions_log WHERE user_id=$1", [id]),
    ]),
    sq(`SELECT action, detail, created_at FROM actions_log
         WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [id]),
  ]);

  const [remindersAll, remindersOpen, commitsOpen, docs, memories, clients,
         finance, contacts, msgs, actionsTotal] = counts;
  res.json({
    user: rows[0],
    assistant: assistant[0] || null,
    instructions,
    googleLinked: google.length > 0,
    counts: { remindersAll, remindersOpen, commitsOpen, docs, memories,
              clients, finance, contacts, msgs, actionsTotal },
    recent,
  });
});

const EDITABLE = new Set(["name", "email", "gender", "birthday", "status",
  "profession", "organisation", "location", "preferred_language"]);

router.patch("/api/users/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!EDITABLE.has(k)) continue;
    if (k === "status" && !["active", "paused"].includes(v)) continue;
    params.push(v === "" ? null : v);
    sets.push(`${k}=$${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: "nothing to update" });
  params.push(id);
  try {
    await db.query(`UPDATE users SET ${sets.join(", ")} WHERE id=$${params.length}`, params);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: /unique/i.test(e.message) ? "That email is already taken." : e.message });
  }
});

router.post("/api/users/:id/phone", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const e164 = normalizePhone(req.body?.phone);
  if (!e164) return res.status(400).json({ error: "Invalid phone number" });
  const clash = await sq("SELECT id FROM users WHERE phone_number=$1 AND id<>$2", [e164, id]);
  if (clash.length) {
    return res.status(409).json({ error: `${e164} already belongs to user #${clash[0].id}` });
  }
  await db.query(
    "UPDATE users SET phone_number=$1, phone_verified_at=$2 WHERE id=$3",
    [e164, Date.now(), id]
  );
  res.json({ ok: true, phone: e164 });
});

router.post("/api/users/:id/push", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = await sq("SELECT fcm_token FROM users WHERE id=$1", [id]);
  const token = rows[0]?.fcm_token;
  if (!token) return res.status(400).json({ error: "User has no registered device." });
  const r = await push.send(
    token,
    String(req.body?.title || "Test notification"),
    String(req.body?.body || "Hello from the admin panel."),
    { type: "admin_test" }
  );
  if (r.ok) return res.json({ ok: true });
  if (r.stale) {
    return res.status(410).json({
      error:
        "That device's token was stale (app uninstalled or reinstalled) — " +
        "it has been cleared. Ask the user to open the app once, then try again.",
    });
  }
  res.status(502).json({ error: "Push failed: " + r.error });
});

router.post("/api/users/:id/clear-device", async (req, res) => {
  await db.query("UPDATE users SET fcm_token='' WHERE id=$1", [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
});

router.delete("/api/users/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const tables = await privacy.existingUserTables();
    await db.tx(async (client) => {
      for (const [table, col] of tables) {
        await client.query(`DELETE FROM ${table} WHERE ${col} = $1`, [String(id)]);
      }
      await client.query("DELETE FROM users WHERE id = $1", [id]);
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

router.get("/api/analytics", async (_req, res) => {
  const monthAgo = Date.now() - 30 * 86400_000;
  const [signups30, dau14, actions14, msgs14, topActions, topUsers] =
    await Promise.all([
      perDay("users", "created_at", 30),
      distinctPerDay(14),
      perDay("actions_log", "created_at", 14),
      perDay("agent_messages", "created_at", 14),
      sq(`SELECT action, COUNT(*) AS count FROM actions_log
           WHERE created_at > $1 GROUP BY action
           ORDER BY count DESC LIMIT 12`, [monthAgo]),
      sq(`SELECT a.user_id, COALESCE(u.name, u.email, '#' || a.user_id) AS name,
                 COUNT(*) AS count
            FROM actions_log a LEFT JOIN users u ON u.id = a.user_id
           WHERE a.created_at > $1 GROUP BY a.user_id, u.name, u.email
           ORDER BY count DESC LIMIT 10`, [monthAgo]),
    ]);
  res.json({ signups30, dau14, actions14, msgs14, topActions, topUsers });
});

/* ------------------------------------------------------------------ */
/* Activity (audit trail explorer)                                     */
/* ------------------------------------------------------------------ */

router.get("/api/activity", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const userId = parseInt(req.query.user_id, 10);
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const where = [];
  const params = [];
  if (q) {
    params.push(`%${q}%`);
    where.push(`(a.action ILIKE $${params.length} OR a.detail ILIKE $${params.length})`);
  }
  if (Number.isFinite(userId)) {
    params.push(userId);
    where.push(`a.user_id = $${params.length}`);
  }
  const rows = await sq(
    `SELECT a.action, a.detail, a.created_at, a.user_id, u.name
       FROM actions_log a LEFT JOIN users u ON u.id = a.user_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY a.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  res.json({ activity: rows });
});

/* ------------------------------------------------------------------ */
/* Feature flags (live overrides, read by /config)                     */
/* ------------------------------------------------------------------ */

const configRoute = require("./config");

router.get("/api/flags", async (_req, res) => {
  const o = await configRoute.overrides();
  res.json({
    defaults: remoteConfig.features,
    overrides: o.features || {},
    announcement: o.announcement !== undefined ? o.announcement : remoteConfig.announcement,
    forceUpdateBelow: o.forceUpdateBelow !== undefined ? o.forceUpdateBelow : remoteConfig.forceUpdateBelow,
    apk: appUpdate.readMeta(),
  });
});

router.put("/api/flags", async (req, res) => {
  const body = req.body || {};
  const clean = {};
  if (body.features && typeof body.features === "object") {
    clean.features = {};
    for (const k of Object.keys(remoteConfig.features)) {
      if (typeof body.features[k] === "boolean") clean.features[k] = body.features[k];
    }
  }
  if (body.announcement !== undefined) {
    clean.announcement = body.announcement ? String(body.announcement) : null;
  }
  if (body.forceUpdateBelow !== undefined) {
    clean.forceUpdateBelow = parseInt(body.forceUpdateBelow, 10) || 0;
  }
  await db.query(
    `INSERT INTO kv (k, v) VALUES ('remote_config_overrides', $1)
     ON CONFLICT (k) DO UPDATE SET v = $1`,
    [JSON.stringify(clean)]
  );
  res.json({ ok: true, saved: clean });
});

/* ------------------------------------------------------------------ */
/* Broadcast push                                                      */
/* ------------------------------------------------------------------ */

router.post("/api/broadcast", async (req, res) => {
  const title = String(req.body?.title || "").trim();
  const body = String(req.body?.body || "").trim();
  if (!title || !body) return res.status(400).json({ error: "Title and message required." });
  const rows = await sq(
    "SELECT id, fcm_token FROM users WHERE fcm_token IS NOT NULL AND fcm_token <> '' LIMIT 500"
  );
  // One send per physical device: two accounts on one phone share a token,
  // and a pruned-stale token must not be retried for the second row.
  const seen = new Set();
  let sent = 0, stale = 0, failed = 0;
  for (const r of rows) {
    if (seen.has(r.fcm_token)) continue;
    seen.add(r.fcm_token);
    const out = await push.send(r.fcm_token, title, body, { type: "announcement" });
    if (out.ok) sent++;
    else if (out.stale) stale++;
    else if (out.skipped) {
      return res.status(503).json({ error: "Push is not configured on this server." });
    } else failed++;
  }
  res.json({ ok: true, sent, stale, failed, devices: seen.size });
});

/* ------------------------------------------------------------------ */
/* Debug / system                                                      */
/* ------------------------------------------------------------------ */

const TABLES = ["users", "actions_log", "reminders", "commitments", "documents",
  "agent_memories", "agent_messages", "clients", "client_notes", "contacts",
  "finance_items", "meetings", "payment_requests", "fulfillment_tasks",
  "fare_watches", "conversations", "messages", "mcp_servers"];

router.get("/api/debug", async (req, res) => {
  const t0 = Date.now();
  await sq("SELECT 1");
  const dbMs = Date.now() - t0;

  const tables = {};
  await Promise.all(
    TABLES.map(async (t) => {
      tables[t] = await cnt(`SELECT COUNT(*) AS count FROM ${t}`);
    })
  );

  const fulfillment = await sq(
    "SELECT status, COUNT(*) AS count FROM fulfillment_tasks GROUP BY status"
  );

  const env = (k) => Boolean(process.env[k] && process.env[k].length > 2);
  const integrations = {
    gemini: env("GEMINI_API_KEY"),
    heygen_avatar: env("HEYGEN_API_KEY"),
    exotel_telephony: env("EXOTEL_API_KEY") && env("EXOTEL_SID"),
    razorpay_payments: env("RAZORPAY_KEY_ID"),
    google_places: env("GOOGLE_PLACES_API_KEY"),
    youtube: env("YOUTUBE_API_KEY"),
    google_signin: env("GOOGLE_WEB_CLIENT_ID"),
    dev_otp_bypass: String(process.env.ALLOW_DEV_PHONE_VERIFY) === "true",
  };

  const probes = {};
  if (String(req.query.probe) === "1") {
    // Gemini: model list is a free metadata call.
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${process.env.GEMINI_API_KEY}`,
        { signal: AbortSignal.timeout(8000) }
      );
      probes.gemini = r.ok ? "ok" : `HTTP ${r.status}`;
    } catch (e) { probes.gemini = e.message; }
    // HeyGen: public avatar catalog.
    try {
      const heygen = require("../avatar/heygen");
      const faces = await heygen.listFaces();
      probes.heygen = faces.length ? `ok (${faces.length} faces)` : "empty catalog";
    } catch (e) { probes.heygen = e.message; }
    // Exotel: account status.
    try {
      const sub = (process.env.EXOTEL_SUBDOMAIN || "api.exotel.com").replace(/^https?:\/\//, "");
      const auth = Buffer.from(
        `${process.env.EXOTEL_API_KEY}:${process.env.EXOTEL_API_TOKEN}`
      ).toString("base64");
      const r = await fetch(
        `https://${sub}/v1/Accounts/${process.env.EXOTEL_SID}.json`,
        { headers: { authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(8000) }
      );
      const j = await r.json().catch(() => ({}));
      probes.exotel = r.ok ? `ok (${j?.Account?.Status || "?"})` : `HTTP ${r.status}`;
    } catch (e) { probes.exotel = e.message; }
  }

  res.json({
    server: {
      node: process.version,
      uptimeS: Math.floor(process.uptime()),
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
      env: process.env.NODE_ENV || "development",
      dbMs,
    },
    tables,
    fulfillment,
    integrations,
    probes,
    apk: appUpdate.readMeta(),
  });
});

/* ------------------------------------------------------------------ */
/* Static SPA                                                          */
/* ------------------------------------------------------------------ */

router.get("/", (_req, res) => {
  if (KEY().length < 16) {
    return res
      .status(503)
      .send("Admin panel disabled — set ADMIN_KEY (16+ chars) in the environment.");
  }
  res.sendFile(path.join(__dirname, "admin_panel", "index.html"));
});
router.use(express.static(path.join(__dirname, "admin_panel")));

module.exports = router;
