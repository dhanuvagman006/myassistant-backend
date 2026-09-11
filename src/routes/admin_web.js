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
  // One key per IP forever adds up; sweep stale IPs once it grows.
  if (attempts.size > 500) {
    for (const [k, v] of attempts) {
      if (!v.length || now - v[v.length - 1] > 600_000) attempts.delete(k);
    }
  }
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
  phone_number, phone_verified_at, app_build, app_build_at, last_seen_at,
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
  // What this user actually said and what the assistant answered, with
  // timings — the fastest way to see why a tester is unhappy.
  const conversations = await require("../memory/recent")
    .adminConversations({ userId: id, limit: 25 })
    .catch(() => []);

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
    conversations,
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

/* ------------------------------------------------------------------ */
/* Conversations — every question, answer and response time             */
/* ------------------------------------------------------------------ */

router.get("/api/conversations", async (req, res) => {
  const recent = require("../memory/recent");
  const userId = parseInt(req.query.user_id, 10);
  const rows = await recent
    .adminConversations({
      q: String(req.query.q || "").trim() || null,
      userId: Number.isFinite(userId) ? userId : undefined,
      source: String(req.query.source || "").trim() || null,
      minLatency: parseInt(req.query.min_ms, 10) || 0,
      limit: parseInt(req.query.limit, 10) || 50,
      offset: parseInt(req.query.offset, 10) || 0,
    })
    .catch(() => []);
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
  const stats = await recent.adminStats(days).catch(() => null);
  res.json({ conversations: rows, stats });
});

/**
 * CSV of the Conversations view — same rows, same filters, as a
 * spreadsheet: every question, the answer, how long it took, which tools
 * ran and from which app build. Opens straight into Excel or Sheets.
 */
router.get("/api/conversations.csv", async (req, res) => {
  const recent = require("../memory/recent");
  const userId = parseInt(req.query.user_id, 10);
  const rows = await recent
    .adminConversations({
      q: String(req.query.q || "").trim() || null,
      userId: Number.isFinite(userId) ? userId : undefined,
      source: String(req.query.source || "").trim() || null,
      minLatency: parseInt(req.query.min_ms, 10) || 0,
      limit: Math.min(parseInt(req.query.limit, 10) || 2000, 5000),
      offset: 0,
    })
    .catch(() => []);

  // Excel-safe quoting: double the quotes, wrap every field. A leading
  // =, +, - or @ is prefixed with a quote so a spreadsheet cannot execute
  // a pasted answer as a formula.
  const cell = (v) => {
    let t = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@]/.test(t)) t = "'" + t;
    return '"' + t.replace(/"/g, '""') + '"';
  };
  const when = (ms) => {
    const d = new Date(Number(ms) || 0);
    return Number.isFinite(d.getTime()) ? d.toISOString().replace("T", " ").slice(0, 19) : "";
  };
  const header = [
    "when_utc", "user_id", "user", "question", "answer",
    "reply_seconds", "reply_ms", "tools", "surface", "app_build",
  ];
  const lines = [header.map(cell).join(",")];
  for (const r of rows) {
    lines.push([
      when(r.created_at),
      r.user_id,
      r.user_name || "",
      r.question || "",
      r.answer || "",
      r.latency_ms ? (Number(r.latency_ms) / 1000).toFixed(2) : "",
      r.latency_ms || "",
      r.tools || "",
      r.source || "",
      r.app_build || "",
    ].map(cell).join(","));
  }
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="conversations-${stamp}.csv"`
  );
  // BOM so Excel opens UTF-8 (Kannada, Hindi, Tulu) correctly.
  res.send("\uFEFF" + lines.join("\n"));
});

/* ------------------------------------------------------------------ */
/* Failures — what is going wrong, across everyone                     */
/*                                                                     */
/* There was no way to ask "which tools failed today". An operator had  */
/* to already know which user to open, then read forty turns by eye, so */
/* a regression in one tool stayed invisible until somebody complained. */
/* ------------------------------------------------------------------ */

router.get("/api/failures", async (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 24 * 14);
  const out = await require("../actions/store")
    .failures({
      sinceMs: Date.now() - hours * 3600_000,
      limit: Math.min(parseInt(req.query.limit, 10) || 150, 500),
      tool: String(req.query.tool || "").trim() || undefined,
      includeRefusals: req.query.refusals !== "0",
    })
    .catch((e) => {
      console.warn("failures read failed:", e.message);
      return { rows: [], groups: [] };
    });

  // Names, so a row reads as a person rather than an id.
  const ids = [...new Set(out.rows.map((r) => r.user_id))].slice(0, 200);
  const names = new Map();
  if (ids.length) {
    const rows = await sq("SELECT id, name FROM users WHERE id = ANY($1)", [ids]).catch(() => []);
    for (const u of rows) names.set(u.id, u.name);
  }
  res.json({
    hours,
    groups: out.groups,
    rows: out.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userName: names.get(r.user_id) || null,
      tool: r.tool,
      target: r.resolved_target || r.target || "",
      decision: r.decision || "ran",
      ok: Number(r.ok) === 1,
      intent: r.intent || "",
      args: r.args || "",
      result: r.result || r.detail || "",
      reply: r.reply || "",
      ms: Number(r.ms) || 0,
      surface: r.surface || "",
      at: Number(r.created_at),
    })),
  });
});

/* ------------------------------------------------------------------ */
/* Action ledger — one turn, end to end                                */
/*                                                                     */
/* The panel could show what a user asked and what was answered, and    */
/* separately that a tool ran. It could not show the middle: which tool */
/* the model picked, with which arguments, and what came back. That is  */
/* precisely the span where the failures lived — a call placed to the   */
/* wrong contact, a settings page opened instead of an answer, an       */
/* action claimed that never ran.                                       */
/* ------------------------------------------------------------------ */

router.get("/api/users/:id/ledger", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad user id" });
  const turns = await require("../actions/store")
    .ledger(id, {
      limit: Math.min(parseInt(req.query.limit, 10) || 60, 200),
      sessionId: String(req.query.session_id || "").trim() || undefined,
      turnId: String(req.query.turn_id || "").trim() || undefined,
    })
    .catch((e) => {
      console.warn("ledger read failed:", e.message);
      return [];
    });
  res.json({ turns, total: turns.length });
});

/** The ledger as a spreadsheet — one row per tool step. */
router.get("/api/users/:id/ledger.csv", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad user id" });
  const turns = await require("../actions/store")
    .ledger(id, { limit: 500 }).catch(() => []);
  const cell = (v) => {
    let t = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@]/.test(t)) t = "'" + t;
    return '"' + t.replace(/"/g, '""') + '"';
  };
  const when = (ms) => {
    const d = new Date(Number(ms) || 0);
    return Number.isFinite(d.getTime()) ? d.toISOString().replace("T", " ").slice(0, 19) : "";
  };
  const header = ["when_utc", "turn_id", "surface", "requested_action",
    "tool_selected", "tool_arguments", "target", "execution_result",
    "succeeded", "final_response"];
  const lines = [header.map(cell).join(",")];
  for (const t of turns) {
    for (const st of t.steps) {
      lines.push([
        when(st.at), t.turnId, t.surface, t.intent, st.tool, st.args,
        st.target, st.result || st.detail, st.ok ? "yes" : "no", t.reply,
      ].map(cell).join(","));
    }
  }
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ledger-${id}-${stamp}.csv"`);
  res.send("\uFEFF" + lines.join("\n"));
});

/* ------------------------------------------------------------------ */
/* Saved documents — what users have actually filed                    */
/*                                                                     */
/* The panel could say "Documents: 14" and nothing more. Seeing the     */
/* documents themselves is how you tell a working filing flow from a   */
/* broken one: whether analysis landed (title/summary/category), which */
/* case file a document went into, and whether the bytes are still on  */
/* disk. The file itself is streamed from the same store the app reads,*/
/* so what the admin sees is what the user has.                        */
/* ------------------------------------------------------------------ */

const DOC_COLS = `d.id, d.user_id, d.filename, d.mime, d.size, d.path, d.title,
  d.category, d.doc_date, d.summary, d.note, d.tags, d.client_id, d.created_at`;

/** Row → panel shape. Never leaks the disk path; says whether it exists. */
function docRow(r) {
  const fs = require("fs");
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name || null,
    filename: r.filename,
    mime: r.mime,
    size: Number(r.size) || 0,
    title: r.title || require("../docs/store").fallbackTitle(r),
    analyzed: Boolean(r.title),
    category: r.category || "other",
    docDate: r.doc_date || "",
    summary: r.summary || "",
    note: r.note || "",
    tags: r.tags || "",
    clientId: r.client_id || null,
    clientName: r.client_name || null,
    area: r.client_id ? "case file" : "personal",
    onDisk: Boolean(r.path) && fs.existsSync(r.path),
    createdAt: Number(r.created_at) || 0,
  };
}

/** Shared filter for the per-user list, the global list and the CSV. */
function docFilters(q) {
  const params = [];
  const where = [];
  const uid = parseInt(q.user_id, 10);
  if (Number.isFinite(uid)) { params.push(uid); where.push(`d.user_id = $${params.length}`); }
  const cat = String(q.category || "").trim();
  if (cat) { params.push(cat); where.push(`d.category = $${params.length}`); }
  const area = String(q.area || "").trim();
  if (area === "personal") where.push("d.client_id IS NULL");
  else if (area === "clients") where.push("d.client_id IS NOT NULL");
  const term = String(q.q || "").trim();
  if (term) {
    params.push(`%${term}%`);
    const i = params.length;
    where.push(`(d.title ILIKE $${i} OR d.note ILIKE $${i} OR d.summary ILIKE $${i}
                 OR d.tags ILIKE $${i} OR d.filename ILIKE $${i} OR u.name ILIKE $${i})`);
  }
  return { where: where.length ? "WHERE " + where.join(" AND ") : "", params };
}

async function queryDocs(q, { limit = 60, offset = 0 } = {}) {
  const { where, params } = docFilters(q);
  const rows = await sq(
    `SELECT ${DOC_COLS}, u.name AS user_name, c.name AS client_name
       FROM documents d
       LEFT JOIN users u   ON u.id = d.user_id
       LEFT JOIN clients c ON c.id = d.client_id
       ${where}
      ORDER BY d.created_at DESC
      LIMIT ${Math.min(Math.max(limit, 1), 500)} OFFSET ${Math.max(offset, 0)}`,
    params
  );
  return rows.map(docRow);
}

/** Every document one user has saved, newest first. */
router.get("/api/users/:id/documents", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad user id" });
  const documents = await queryDocs(
    { ...req.query, user_id: String(id) },
    { limit: parseInt(req.query.limit, 10) || 200 }
  );
  const byCategory = await sq(
    `SELECT category, COUNT(*)::int AS n, COALESCE(SUM(size),0)::bigint AS bytes
       FROM documents WHERE user_id = $1 GROUP BY category ORDER BY n DESC`,
    [id]
  );
  const cats = byCategory.map((r) => ({ category: r.category, n: r.n, bytes: Number(r.bytes) }));
  res.json({
    documents,
    shown: documents.length,
    // The true count, not the page size — a user with 12 saved documents
    // and a limit of 3 must not be reported as having 3.
    total: cats.reduce((a, r) => a + r.n, 0),
    byCategory: cats,
    totalBytes: cats.reduce((a, r) => a + r.bytes, 0),
  });
});

/** Every document across every user — searchable, filterable, paged. */
router.get("/api/documents", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 60, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const { where, params } = docFilters(req.query);
  const [documents, totalRow, cats] = await Promise.all([
    queryDocs(req.query, { limit, offset }),
    sq(`SELECT COUNT(*)::int AS count FROM documents d
          LEFT JOIN users u ON u.id = d.user_id ${where}`, params),
    sq(`SELECT category, COUNT(*)::int AS n FROM documents GROUP BY category ORDER BY n DESC`, []),
  ]);
  res.json({
    documents,
    total: totalRow[0] ? totalRow[0].count : 0,
    categories: cats.map((c) => ({ category: c.category, n: c.n })),
  });
});

/**
 * The file itself. Inline by default so images and PDFs preview in the
 * browser; ?download=1 forces a save. Read straight from the store's own
 * path, so a missing file reports 404 rather than an empty preview.
 */
router.get("/api/documents/:docId/file", async (req, res) => {
  const fs = require("fs");
  const docId = parseInt(req.params.docId, 10);
  if (!Number.isFinite(docId)) return res.status(400).json({ error: "bad document id" });
  const rows = await sq(
    "SELECT id, user_id, filename, mime, path, title FROM documents WHERE id = $1", [docId]
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: "no such document" });
  if (!row.path || !fs.existsSync(row.path)) {
    return res.status(404).json({ error: "the file is no longer on disk" });
  }
  const safe = String(row.title || row.filename || "document")
    .replace(/[^\w .\-]+/g, "_").slice(0, 80);
  res.setHeader("Content-Type", row.mime || "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `${req.query.download ? "attachment" : "inline"}; filename="${safe}"`
  );
  res.setHeader("Cache-Control", "private, max-age=3600");
  fs.createReadStream(row.path).pipe(res);
});

/** The same list as a spreadsheet, matching the conversations export. */
router.get("/api/documents.csv", async (req, res) => {
  const rows = await queryDocs(req.query, {
    limit: Math.min(parseInt(req.query.limit, 10) || 2000, 5000),
  });
  const cell = (v) => {
    let t = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@]/.test(t)) t = "'" + t;
    return '"' + t.replace(/"/g, '""') + '"';
  };
  const when = (ms) => {
    const d = new Date(Number(ms) || 0);
    return Number.isFinite(d.getTime()) ? d.toISOString().replace("T", " ").slice(0, 19) : "";
  };
  const header = ["saved_utc", "user_id", "user", "title", "category", "area",
    "case_file", "document_date", "size_kb", "type", "analyzed", "on_disk",
    "note", "summary", "tags", "filename"];
  const lines = [header.map(cell).join(",")];
  for (const d of rows) {
    lines.push([
      when(d.createdAt), d.userId, d.userName || "", d.title, d.category, d.area,
      d.clientName || "", d.docDate, Math.round(d.size / 1024), d.mime,
      d.analyzed ? "yes" : "no", d.onDisk ? "yes" : "missing",
      d.note, d.summary, d.tags, d.filename,
    ].map(cell).join(","));
  }
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="documents-${stamp}.csv"`);
  res.send("\uFEFF" + lines.join("\n"));
});

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
  const weekAgo = Date.now() - 7 * 86400_000;
  const [versions, convStats, engagement] = await Promise.all([
    // WHICH BUILD IS EVERYONE ON — updates landing or stalling.
    sq(`SELECT COALESCE(NULLIF(app_build,0), 0) AS build, COUNT(*)::int AS users,
               MAX(last_seen_at) AS last_seen
          FROM users WHERE status='active' GROUP BY 1 ORDER BY build DESC`),
    require("../memory/recent").adminStats(7).catch(() => null),
    // OVERLAP / STICKINESS: how many distinct days each active user showed
    // up in the last week, and how many came back at all.
    sq(`SELECT days_active, COUNT(*)::int AS users FROM (
          SELECT user_id, COUNT(DISTINCT to_char(to_timestamp(created_at/1000.0),'YYYY-MM-DD')) AS days_active
            FROM actions_log WHERE created_at > $1 GROUP BY user_id) x
        GROUP BY days_active ORDER BY days_active`, [weekAgo]),
  ]);
  res.json({
    signups30, dau14, actions14, msgs14, topActions, topUsers,
    versions, convStats, engagement,
  });
});

/* ------------------------------------------------------------------ */
/* Activity (audit trail explorer)                                     */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Task outcomes — what users asked for and what REALLY happened        */
/* ------------------------------------------------------------------ */

router.get("/api/outcomes", async (req, res) => {
  const outcomes = require("../outcomes/store");
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  try {
    const out = await outcomes.adminList({
      q: String(req.query.q || "").trim(),
      status: String(req.query.status || ""),
      kind: String(req.query.kind || ""),
      userId: parseInt(req.query.user_id, 10),
      limit: Math.min(parseInt(req.query.limit, 10) || 50, 200),
      offset: Math.max(parseInt(req.query.offset, 10) || 0, 0),
      sinceMs: Date.now() - days * 86400000,
    });
    const h = out.histogram;
    const sum = (...k) => k.reduce((a, x) => a + (h[x] || 0), 0);
    res.json({
      outcomes: out.rows.map((r) => ({ ...outcomes.toClient(r), userId: r.user_id, userName: r.user_name })),
      summary: {
        total: Object.values(h).reduce((a, b) => a + b, 0),
        succeeded: sum("connected", "completed"),
        failed: sum("failed", "no_answer", "cancelled"),
        unconfirmed: sum("unconfirmed"),
        pending: sum("requested", "dialing"),
        byStatus: h,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

  // Optional targeting: a userIds array narrows the send to those accounts
  // (and then the response carries a per-user outcome, because the admin
  // picked people by name and deserves to know exactly who got it). No
  // userIds keeps the original everyone-with-a-device broadcast.
  const ids = Array.isArray(req.body?.userIds)
    ? [...new Set(req.body.userIds.map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n) && n > 0))].slice(0, 500)
    : null;
  const targeted = ids !== null;
  if (targeted && !ids.length) return res.status(400).json({ error: "No recipients selected." });

  const rows = targeted
    ? await sq("SELECT id, name, fcm_token FROM users WHERE id = ANY($1) ORDER BY id", [ids])
    : await sq(
        "SELECT id, name, fcm_token FROM users WHERE fcm_token IS NOT NULL AND fcm_token <> '' LIMIT 500"
      );

  // One send per physical device: two accounts on one phone share a token,
  // and a pruned-stale token must not be retried for the second row.
  const seen = new Set();
  let sent = 0, stale = 0, failed = 0;
  const results = [];
  const pending = require("../services/pendingPush");
  for (const r of rows) {
    const who = { id: r.id, name: r.name || `#${r.id}` };
    if (!r.fcm_token) {
      // No device registered right now — queue it rather than dropping it.
      await pending.queue(r.id, title, body, { type: "announcement" }).catch(() => {});
      results.push({ ...who, outcome: "queued_no_device" });
      continue;
    }
    if (seen.has(r.fcm_token)) {
      results.push({ ...who, outcome: "shared_device" });
      continue;
    }
    seen.add(r.fcm_token);
    const out = await push.send(r.fcm_token, title, body, { type: "announcement" });
    if (out.ok) { sent++; results.push({ ...who, outcome: "sent" }); }
    else if (out.skipped) {
      return res.status(503).json({ error: "Push is not configured on this server." });
    } else {
      // A dead or not-yet-active token (every app update produces one for
      // a few minutes) must not lose the message: park it and deliver on
      // the device's next registration.
      await pending.queue(r.id, title, body, { type: "announcement" }).catch(() => {});
      if (out.stale) { stale++; results.push({ ...who, outcome: "queued_stale" }); }
      else { failed++; results.push({ ...who, outcome: "queued", error: out.error || "" }); }
    }
  }
  res.json({
    ok: true, sent, stale, failed, devices: seen.size,
    ...(targeted && { results }),
  });
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
