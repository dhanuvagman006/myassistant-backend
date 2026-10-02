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
 * attach+verify phone, pause/resume, clear device, test push, delete
 * through the same routine as /privacy/account, and a "Leftovers" sweep
 * for what older deletes left behind), the video-note queue ("send
 * messages as you": download the sender's video, upload the clip made in
 * Colab, and it is delivered), analytics series,
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
const helpImprove = require("../users/helpImprove");

/**
 * "Help improve the assistant" (users/helpImprove.js): what the team may
 * see of a user's words. The SQL side is hari_reviewable(); these are the
 * JS helpers for the routes that need one answer per user.
 */
const HELP_COLS = `,
  (SELECT pp.help_improve FROM privacy_prefs pp WHERE pp.user_id = users.id) AS help_improve,
  (SELECT pp.on_since FROM privacy_prefs pp WHERE pp.user_id = users.id) AS on_since,
  (SELECT pp.decided_at FROM privacy_prefs pp WHERE pp.user_id = users.id) AS decided_at`;
const helpLabel = (v) => (v === null || v === undefined ? "not_asked" : Number(v) === 1 ? "on" : "off");
const RV = (u, t) => helpImprove.reviewableSql(u, t);

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
  fcm_token IS NOT NULL AND fcm_token <> '' AS has_device,
  (SELECT d.model FROM user_devices d WHERE d.user_id = users.id) AS device_model,
  (SELECT d.os_version FROM user_devices d WHERE d.user_id = users.id) AS device_os`;

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
    `SELECT ${USER_COLS}${HELP_COLS} FROM users ${where}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  const total = await cnt(`SELECT COUNT(*) AS count FROM users ${where}`, params);
  res.json({ users: rows, total });
});

/**
 * PHONES (2026-10-01, owner: "my app is acting differently in different
 * android phones"): every user's handset, OS and build beside how the
 * assistant performs for them this week — turns, median and slowest
 * reply, how many turns ran on the fast voice — so a slow or odd phone
 * shows up as a row, not a hunch.
 */
router.get("/api/devices", async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
  const since = Date.now() - days * 86400_000;
  const rows = await sq(
    `SELECT u.id AS user_id, u.name, u.app_build, u.last_seen_at,
            d.model, d.os_version, d.platform, d.build AS device_build, d.seen_at, d.granted, d.denied,
            s.turns, s.p50, s.max_ms, s.live_turns, s.slow_turns
       FROM users u
       LEFT JOIN user_devices d ON d.user_id = u.id
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS turns,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY t.latency_ms)::int AS p50,
                MAX(t.latency_ms)::int AS max_ms,
                COUNT(*) FILTER (WHERE t.source LIKE 'ai-live%')::int AS live_turns,
                COUNT(*) FILTER (WHERE t.latency_ms > 6000)::int AS slow_turns
           FROM conversation_turns t
          WHERE t.user_id = u.id AND t.role = 'assistant' AND t.created_at > $1
       ) s ON TRUE
      WHERE d.user_id IS NOT NULL OR s.turns > 0
      ORDER BY GREATEST(COALESCE(d.seen_at, 0), COALESCE(u.last_seen_at, 0)) DESC
      LIMIT 200`,
    [since]
  );
  res.json({ devices: rows, days });
});

router.get("/api/users/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = await sq(`SELECT ${USER_COLS}${HELP_COLS} FROM users WHERE id=$1`, [id]);
  if (!rows.length) return res.status(404).json({ error: "no such user" });
  const reviewable = await helpImprove.effective(id).catch(() => false);

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
    sq(`SELECT action,
               CASE WHEN ${RV("user_id", "created_at")} THEN detail ELSE '(hidden)' END AS detail,
               created_at FROM actions_log
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
    helpImprove: helpLabel(rows[0].help_improve),
    assistant: assistant[0] || null,
    // Their standing rules are their own words: shown only with a yes.
    instructions: reviewable ? instructions : [],
    instructionsHidden: !reviewable,
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

/**
 * DELETE USER — the same eraser the app's own "Delete account" uses.
 *
 * Owner, 2026-09-25: "delete old user accounts and data's from the
 * database", then "i ran but db files have not yet deleted". This route
 * used to carry its own copy of the delete: rows only, so recordings,
 * document files and the Google grant all outlived the account, and the
 * Recordings page kept listing the calls. It now calls
 * privacy.deleteUserEverywhere() and answers with what was removed, so
 * the panel can show it instead of a bare "deleted".
 */
router.delete("/api/users/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!(id > 0)) return res.status(400).json({ error: "bad user id" });
  try {
    res.json(await privacy.deleteUserEverywhere(id, { reason: "admin panel" }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * LEFTOVERS — what earlier deletes left behind.
 *
 * Every delete before 2026-09-25 left rows in the tables the old list did
 * not know, plus call audio and document files on disk. GET counts them
 * (rows whose user no longer exists, per table, and the files); POST
 * removes exactly those. Behind the admin session like everything here.
 */
router.get("/api/maintenance/orphans", async (_req, res) => {
  try {
    res.json(await privacy.findOrphans());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/api/maintenance/orphans/purge", async (_req, res) => {
  try {
    res.json(await privacy.purgeOrphans());
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

/* ------------------------------------------------------------------ */
/* Recordings — the call itself, not just what was typed down           */
/* ------------------------------------------------------------------ */

router.get("/api/recordings", async (req, res) => {
  const rec = require("../live/recorder");
  const userId = parseInt(req.query.user_id, 10);
  const [rows, usage] = await Promise.all([
    rec.list({
      userId: Number.isFinite(userId) ? userId : undefined,
      limit: parseInt(req.query.limit, 10) || 50,
      offset: parseInt(req.query.offset, 10) || 0,
    }).catch(() => []),
    rec.usage().catch(() => null),
  ]);
  res.json({ recordings: rows, usage });
});

/**
 * Streams one recording, with byte ranges.
 *
 * Range is not optional here: without it an <audio> element can play
 * from the start but cannot seek, and a reviewer listening for one
 * moment thirty minutes in would have to sit through the whole call.
 */
router.get("/api/recordings/:id/audio", async (req, res) => {
  const fs = require("fs");
  const { pipeline } = require("stream");
  const row = await require("../live/recorder").get(req.params.id).catch(() => null);
  if (!row) return res.status(404).json({ error: "no such recording" });

  // Async, because this process is relaying live call audio while it
  // answers: a blocking stat here is a stutter in somebody's conversation.
  const st = await fs.promises.stat(row.file).catch(() => null);
  if (!st) return res.status(410).json({ error: "the audio file is gone" });
  const size = st.size;

  const stamp = new Date(Number(row.started_at)).toISOString()
    .replace(/[:.]/g, "-").slice(0, 19);
  const wav = row.format === "wav";
  res.setHeader("Content-Type", wav ? "audio/wav" : "audio/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=600");
  res.setHeader("Content-Disposition",
    `inline; filename="call-${row.user_id}-${stamp}.m4a"`);

  // pipeline, not pipe: pipe attaches an error listener to the DESTINATION
  // only, so a file that vanishes between the stat above and the open
  // below throws an unhandled 'error' — which in Node 20 takes the whole
  // process down. It also destroys the read stream when the browser
  // abandons a seek, which <audio> does constantly.
  const send = (opts) => pipeline(fs.createReadStream(row.file, opts), res, (err) => {
    if (err && !res.headersSent) res.status(410).end();
  });

  // Three forms are legal and browsers send all of them: "bytes=0-",
  // "bytes=100-200", and "bytes=-100" meaning the LAST hundred bytes.
  // Reading that last one as 0-100 answers with the wrong audio under a
  // 206 that claims otherwise.
  const m = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/.exec(String(req.headers.range || ""));
  if (!m) {
    res.setHeader("Content-Length", size);
    return send({});
  }
  let start, end;
  if (m[3] !== undefined) {
    const n = parseInt(m[3], 10);
    if (!n) {
      res.setHeader("Content-Range", `bytes */${size}`);
      return res.status(416).end();
    }
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] ? parseInt(m[2], 10) : size - 1;
  }
  if (end >= size) end = size - 1;
  if (!Number.isFinite(start) || start > end || start >= size) {
    res.setHeader("Content-Range", `bytes */${size}`);
    return res.status(416).end();
  }
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  res.setHeader("Content-Length", end - start + 1);
  send({ start, end });
});

/** Deletes one recording once it has been listened to — bytes included. */
router.delete("/api/recordings/:id", async (req, res) => {
  const gone = await require("../live/recorder").destroy(req.params.id)
    .catch(() => false);
  if (!gone) return res.status(404).json({ error: "no such recording" });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Video notes — "send messages as you", made by hand (2026-09-26)      */
/* ------------------------------------------------------------------ */
//
// The owner: "send a video note for Danush saying he should meet me at
// twelve PM" — with no GPU yet, HE makes the talking clip in Google Colab
// from the sender's 30-second video and the script, and uploads it here.
// The upload delivers it at once (videonotes/service.js): to the
// recipient's app when they have one, otherwise to the sender to share.

const videoNotes = () => require("../videonotes/store");
const videoNoteService = () => require("../videonotes/service");

function renderRow(r, sources) {
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  // The sender's consent NOW ('ok' | 'off' | 'withdrawn'). Without it the
  // page offers nothing that uses their face: no download, no upload.
  const consent = videoNotes().senderGate(
    r.sender_consented === null || r.sender_consented === undefined
      ? null
      : { consented: r.sender_consented, enabled: r.sender_enabled });
  const workable = (r.status === "pending" || r.status === "failed") && consent === "ok";
  const tp = videoNotes().teleprompter(r.script_version);
  return {
    id: Number(r.id),
    status: r.status,
    sender: {
      id: n(r.user_id), name: r.sender_name || null, phone: r.sender_phone || null, consent,
    },
    // THE OWNER'S CHECKPOINT: what the person in the video should be
    // saying, word for word, and whether he has confirmed it is them.
    scriptVersion: Number(r.script_version) || 0,
    consentVersion: r.consent_version || "",
    teleprompter: tp ? { consent: tp.consent, text: tp.text } : null,
    identityChecked: Boolean(r.identity_checked_at) &&
      Boolean(r.source_video_key) && r.identity_checked_key === r.source_video_key,
    identityCheckedAt: n(r.identity_checked_at),
    workable,
    recipient: {
      name: r.recipient_name,
      phone: r.recipient_phone,
      onApp: Boolean(r.recipient_now_id) &&
        (!r.recipient_user_id || Number(r.recipient_now_id) === Number(r.recipient_user_id)),
    },
    script: r.script,
    language: r.language || "",
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
    deliveredAt: n(r.delivered_at),
    deliveredTo: r.delivered_to || "",
    note: r.note || "",
    error: r.error || "",
    hasSource: Boolean(sources.get(Number(r.id))),
    sourceBytes: sources.get(Number(r.id)) || 0,
    hasOutput: Boolean(r.output_key),
    outputBytes: Number(r.output_bytes) || 0,
  };
}

router.get("/api/video-notes", async (req, res) => {
  const media = require("../storage/media");
  const status = String(req.query.status || "");
  const [rows, counts] = await Promise.all([
    videoNotes().listRenders({
      status,
      limit: parseInt(req.query.limit, 10) || 50,
      offset: parseInt(req.query.offset, 10) || 0,
    }),
    videoNotes().countByStatus(),
  ]);
  // Whether the sender's video is still there to download (it goes with
  // "Delete everything" and with the account).
  const sources = new Map();
  await Promise.all(rows.map(async (r) => {
    if (!r.source_video_key || !media.isKey(r.source_video_key)) return;
    const st = await media.stat(r.source_video_key).catch(() => null);
    if (st) sources.set(Number(r.id), st.bytes);
  }));
  res.json({ renders: rows.map((r) => renderRow(r, sources)), counts });
});

/**
 * The sender's identity video, for the owner's check and the Colab run.
 * Range-capable, so it plays and seeks in the page; ?download=1 saves it.
 *
 * Only while the note can still be made (waiting or failed) AND the
 * sender consents right now: a cancelled note, or one whose sender
 * withdrew, served their face to anyone with the panel open (review,
 * 2026-09-26).
 */
router.get("/api/video-notes/:id/source", async (req, res) => {
  const media = require("../storage/media");
  const r = await videoNotes().getRender(req.params.id);
  if (!r) return res.status(404).json({ error: "no such video note" });
  if (r.status !== "pending" && r.status !== "failed") {
    return res.status(410).json({ error: `this video note is ${r.status} — the sender's video is not needed` });
  }
  const gate = videoNotes().senderGate(await videoNotes().getProfile(r.user_id));
  if (gate !== "ok") {
    return res.status(410).json({
      error: gate === "off"
        ? "the sender has switched video notes off"
        : "the sender withdrew consent — their video can't be used",
    });
  }
  if (!r.source_video_key || !media.isKey(r.source_video_key)) {
    return res.status(410).json({ error: "the sender's video is gone (deleted by them)" });
  }
  const ext = /\.mov$/i.test(r.source_video_key) ? "mov" : "mp4";
  const sent = await media.send(req, res, r.source_video_key, {
    type: ext === "mov" ? "video/quicktime" : "video/mp4",
    filename: `note-${r.id}-sender-${r.user_id}.${ext}`,
    download: Boolean(req.query.download),
  });
  if (!sent) res.status(410).json({ error: "the sender's video is gone (deleted by them)" });
});

/** The clip that was uploaded, while it is kept (30 days after delivery). */
router.get("/api/video-notes/:id/output", async (req, res) => {
  const media = require("../storage/media");
  const r = await videoNotes().getRender(req.params.id);
  if (!r) return res.status(404).json({ error: "no such video note" });
  const sent = r.output_key && media.isKey(r.output_key)
    ? await media.send(req, res, r.output_key, {
        filename: `note-${r.id}.mp4`,
        download: Boolean(req.query.download),
      })
    : false;
  if (!sent) res.status(410).json({ error: "no clip is kept for this note" });
});

// The finished clip, spooled to disk — never RAM (the pod has 512Mi). The
// panel is the only upload path, so the key never goes into a notebook.
const clipUpload = (() => {
  const multer = require("multer");
  const os = require("os");
  const up = multer({
    storage: multer.diskStorage({
      destination: os.tmpdir(),
      filename: (_req, _file, cb) =>
        cb(null, `note-${Date.now()}-${Math.random().toString(36).slice(2)}.upload`),
    }),
    limits: { fileSize: 300 * 1024 * 1024, files: 1, fields: 5 },
  });
  return (req, res, next) =>
    up.single("file")(req, res, (err) => {
      if (!err) return next();
      if (req.file?.path) require("fs").rm(req.file.path, { force: true }, () => {});
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "that clip is too large (the limit is 300 MB)" });
      }
      return res.status(400).json({ error: "bad upload" });
    });
})();

/**
 * "I watched it: it is the account holder, reading the consent sentence."
 * Required before a clip can be uploaded for this note, and recorded in
 * the sender's own activity log. The server cannot tell a live take from
 * any MP4 a client posts; the owner, who watches every one, can.
 */
router.post("/api/video-notes/:id/verify", async (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: "confirm that you watched the video and it is them" });
  }
  try {
    const r = await videoNoteService().confirmIdentity(req.params.id);
    console.log(`admin: video note #${r.id} — sender's video checked`);
    res.json({ ok: true, identityCheckedAt: Number(r.identity_checked_at) });
  } catch (e) {
    res.status(e.http || 500).json({ error: e.message });
  }
});

/**
 * Refused before the clip is read, not after 300 MB has crossed the wire:
 * a note that is out, cancelled, unchecked, or whose sender withdrew.
 * storeOutput checks all of it again, under lock, once the file is here.
 */
async function clipAllowed(req, res, next) {
  try {
    await videoNoteService().canStore(req.params.id);
    next();
  } catch (e) {
    res.status(e.http || 500).json({ error: e.message });
  }
}

/** Upload the made clip → stored → delivered, in one step. */
router.post("/api/video-notes/:id/result", clipAllowed, clipUpload, async (req, res) => {
  const fs = require("fs");
  const f = req.file;
  try {
    if (!f) return res.status(400).json({ error: "choose the MP4 you made first" });
    const mime = String(f.mimetype || "").toLowerCase();
    if (!["video/mp4", "video/quicktime", "application/octet-stream"].includes(mime) &&
        !/\.(mp4|mov|m4v)$/i.test(f.originalname || "")) {
      return res.status(400).json({ error: "the clip must be an MP4" });
    }
    // An MP4 starts with an ISO-BMFF box; a mislabelled file is refused
    // rather than delivered to someone's phone as a "video".
    const head = Buffer.alloc(12);
    const fh = await fs.promises.open(f.path, "r");
    try { await fh.read(head, 0, 12, 0); } finally { await fh.close(); }
    if (!["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(head.toString("latin1", 4, 8))) {
      return res.status(400).json({ error: "that file is not an MP4 video" });
    }
    await videoNoteService().storeOutput(req.params.id, f.path);
    const r = await videoNoteService().deliver(req.params.id);
    console.log(`admin: video note #${r.id} uploaded and delivered (${r.delivered_to})`);
    res.json({ ok: true, status: r.status, deliveredTo: r.delivered_to, note: r.note });
  } catch (e) {
    if (e.http) return res.status(e.http).json({ error: e.message });
    console.error("admin video note upload:", e.stack || e.message);
    res.status(500).json({ error: "the clip could not be stored" });
  } finally {
    if (f?.path) fs.promises.rm(f.path, { force: true }).catch(() => {});
  }
});

/** A stored clip whose delivery failed: try again, no new upload. */
router.post("/api/video-notes/:id/deliver", async (req, res) => {
  try {
    const r = await videoNoteService().deliver(req.params.id);
    res.json({ ok: true, status: r.status, deliveredTo: r.delivered_to, note: r.note });
  } catch (e) {
    res.status(e.http || 500).json({ error: e.message });
  }
});

/** Could not be made: the sender is told, and it leaves the queue. */
router.post("/api/video-notes/:id/fail", async (req, res) => {
  try {
    const r = await videoNoteService().fail(req.params.id, req.body?.reason);
    res.json({ ok: true, status: r.status });
  } catch (e) {
    res.status(e.http || 500).json({ error: e.message });
  }
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

/**
 * The moment from which this user's ledger may be read, or null when it
 * may not be read at all ("Help improve" off, or never said yes).
 */
async function reviewSince(uid) {
  if (!(await helpImprove.effective(uid).catch(() => false))) return null;
  const s = await helpImprove.state(uid).catch(() => ({ helpImprove: null, onSince: 0 }));
  return s.helpImprove === true ? s.onSince : 0;
}
function onlySince(turns, since) {
  return turns
    .map((t) => ({ ...t, steps: (t.steps || []).filter((st) => Number(st.at) >= since) }))
    .filter((t) => t.steps.length);
}

router.get("/api/users/:id/ledger", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad user id" });
  const since = await reviewSince(id);
  if (since === null) return res.json({ hidden: true, reason: "help_improve_off", turns: [], total: 0 });
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
  const shown = onlySince(turns, since);
  res.json({ turns: shown, total: shown.length });
});

/** The ledger as a spreadsheet — one row per tool step. */
router.get("/api/users/:id/ledger.csv", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad user id" });
  const since = await reviewSince(id);
  const turns = since === null ? [] : onlySince(await require("../actions/store")
    .ledger(id, { limit: 500 }).catch(() => []), since);
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
  // Saved documents are the user's own files: listed only for people who
  // said yes to "Help improve", and only those saved after it.
  const where = [RV("d.user_id", "d.created_at")];
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
       FROM documents d WHERE user_id = $1 AND ${RV("d.user_id", "d.created_at")}
      GROUP BY category ORDER BY n DESC`,
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
    `SELECT id, user_id, filename, mime, path, title,
            ${RV("user_id", "created_at")} AS reviewable
       FROM documents WHERE id = $1`, [docId]
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: "no such document" });
  if (!row.reviewable) {
    return res.status(403).json({ error: "hidden: the user turned off Help improve" });
  }
  if (!row.path || !fs.existsSync(row.path)) {
    return res.status(404).json({ error: "the file is no longer on disk" });
  }
  const safe = String(row.title || row.filename || "document")
    .replace(/[^\w .\-]+/g, "_").slice(0, 80);
  // Only passive types preview inline. These files are user uploads served
  // on the admin panel's own origin, beside its session cookie: an
  // uploaded text/html rendered inline would run script as the admin.
  const PREVIEWABLE = new Set([
    "image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf", "text/plain",
    // Passive, like the images: a delivered video note plays in place.
    "video/mp4",
  ]);
  const mime = String(row.mime || "").toLowerCase();
  const inline = !req.query.download && PREVIEWABLE.has(mime);
  res.setHeader("Content-Type", inline ? mime : "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${safe}"`
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
  const rv = RV("a.user_id", "a.created_at");
  if (q) {
    params.push(`%${q}%`);
    // A search only looks inside rows the team may read, or it would
    // confirm which hidden rows hold a word.
    where.push(`(a.action ILIKE $${params.length} OR (${rv} AND a.detail ILIKE $${params.length}))`);
  }
  if (Number.isFinite(userId)) {
    params.push(userId);
    where.push(`a.user_id = $${params.length}`);
  }
  const rows = await sq(
    `SELECT a.action, CASE WHEN ${rv} THEN a.detail ELSE '(hidden)' END AS detail,
            a.created_at, a.user_id, u.name
       FROM actions_log a LEFT JOIN users u ON u.id = a.user_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY a.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  res.json({ activity: rows });
});

/* ------------------------------------------------------------------ */
/* Feedback — what the assistant told the developer                    */
/* ------------------------------------------------------------------ */

router.get("/api/feedback", async (req, res) => {
  const fb = require("../feedback/store");
  try {
    const [rows, counts] = await Promise.all([
      fb.list({
        status: String(req.query.status || ""),
        q: String(req.query.q || "").trim(),
        limit: req.query.limit,
        offset: req.query.offset,
      }),
      fb.counts(),
    ]);
    res.json({ feedback: rows, counts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/api/feedback/:id(\\d+)", async (req, res) => {
  const ok = await require("../feedback/store")
    .setStatus(req.params.id, String(req.body?.status || ""))
    .catch(() => false);
  if (!ok) return res.status(400).json({ error: "unknown feedback or status" });
  res.json({ ok: true });
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
  "fare_watches", "conversations", "messages", "mcp_servers",
  "avatar_profiles", "avatar_renders"];

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
    openai: env("OPENAI_API_KEY"),
    heygen_avatar: env("HEYGEN_API_KEY"),
    razorpay_payments: env("RAZORPAY_KEY_ID"),
    google_places: env("GOOGLE_PLACES_API_KEY"),
    youtube: env("YOUTUBE_API_KEY"),
    notion: env("NOTION_CLIENT_ID") && env("NOTION_CLIENT_SECRET"),
    google_signin: env("GOOGLE_WEB_CLIENT_ID"),
    dev_phone_typed: String(process.env.ALLOW_DEV_PHONE_VERIFY) === "true",
  };

  const probes = {};
  if (String(req.query.probe) === "1") {
    // OpenAI: the model list is a free metadata call.
    try {
      const r = await fetch("https://api.openai.com/v1/models?limit=1", {
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, signal: AbortSignal.timeout(8000),
      });
      probes.openai = r.ok ? "ok" : `HTTP ${r.status}`;
    } catch (e) { probes.openai = e.message; }
    // HeyGen: public avatar catalog.
    try {
      const heygen = require("../avatar/heygen");
      const faces = await heygen.listFaces();
      probes.heygen = faces.length ? `ok (${faces.length} faces)` : "empty catalog";
    } catch (e) { probes.heygen = e.message; }
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

/**
 * A DEPLOY THAT NOBODY SEES IS NOT A DEPLOY.
 *
 * index.html asked for /admin-panel/app.js by a name that never changes,
 * so a browser holding yesterday's copy kept running yesterday's panel
 * after a release — new pages simply absent, with nothing to suggest the
 * server had anything newer. Reported 2026-09-14 for the Recordings page,
 * which was live and being served correctly the whole time.
 *
 * The asset URLs now carry a hash of their own contents. Change a byte
 * and the URL changes, so the browser has no cached copy to reuse; change
 * nothing and it keeps what it has. The shell itself is never stored,
 * which is what makes the hash reachable in the first place.
 */
const PANEL_DIR = path.join(__dirname, "admin_panel");
let shellCache = null;

function panelShell() {
  const fs = require("fs");
  const index = path.join(PANEL_DIR, "index.html");
  const stamp = ["index.html", "app.js", "style.css"]
    .map((f) => {
      try {
        const st = fs.statSync(path.join(PANEL_DIR, f));
        return `${f}:${st.size}:${st.mtimeMs}`;
      } catch (_) { return f; }
    })
    .join("|");
  if (shellCache && shellCache.stamp === stamp) return shellCache.html;

  const version = crypto.createHash("sha1").update(stamp).digest("hex").slice(0, 10);
  const html = fs.readFileSync(index, "utf8")
    .replace(/(["'])(\/admin-panel\/(?:app\.js|style\.css))\1/g, `$1$2?v=${version}$1`);
  shellCache = { stamp, html };
  return html;
}

router.get("/", (_req, res) => {
  if (KEY().length < 16) {
    return res
      .status(503)
      .send("Admin panel disabled — set ADMIN_KEY (16+ chars) in the environment.");
  }
  let html;
  try {
    html = panelShell();
  } catch (e) {
    // Never fail the panel over a cache optimisation.
    return res.sendFile(path.join(PANEL_DIR, "index.html"));
  }
  // The shell is the only thing that knows which version to ask for, so
  // it is the one file that must never come from a cache.
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  res.type("html").send(html);
});

// Safe to cache hard: every reference to these carries a content hash, so
// a changed file is a changed URL.
router.use(express.static(PANEL_DIR, {
  maxAge: "1h",
  setHeaders(res, filePath) {
    if (/\.(?:js|css)$/.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=3600, must-revalidate");
    }
  },
}));

module.exports = router;
