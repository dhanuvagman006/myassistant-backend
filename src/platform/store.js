/**
 * CONNECTED APPS — PERSISTENCE (2026-10-14).
 *
 * The owner: "the user can access their assistant even from different
 * apps — the memory is the same, the assistant just gets extra powers
 * there". A user builds their own app (a game, a voice gadget, a tracker),
 * registers it here, and gets an API key that acts as THEM, inside limits
 * they chose (scopes). Everything below is per user and per app:
 *
 *   platform_apps           an app the user connected: name, what it is,
 *                           the words people use for it (so "how did my
 *                           chess game go?" finds it), the scopes its keys
 *                           carry, and standing instructions for the
 *                           assistant inside it.
 *   platform_keys           its API keys. Only a SHA-256 of the key is
 *                           stored; the key itself is shown once.
 *   platform_records        the app's own data, kept by collection and id
 *                           (a match, a score, a saved board). `summary`
 *                           is the line the assistant reads back.
 *   platform_events         the app's activity feed ("Won against the
 *                           assistant in 34 moves") — what the main app
 *                           shows under the app, and what the assistant
 *                           searches when asked.
 *   platform_conversations  an assistant conversation held through the API,
 *                           including the app-side tool calls it is waiting
 *                           on. Kept 7 days.
 *   platform_usage          requests, assistant turns and voice per app per
 *                           day. The AI cost itself is on the user's own
 *                           account ledger (ai_spend / ai_usage), like any
 *                           turn in the main app.
 *
 * Every query is scoped by user_id (and app_id): another user's id is
 * "not found". Tables are created lazily with a cached migrate().
 */
const crypto = require("crypto");
const { query, one, run } = require("../db");

const LIMITS = Object.freeze({
  apps: Number(process.env.PLATFORM_MAX_APPS) || 20,
  keysPerApp: 5,
  name: 60,
  description: 300,
  instructions: 2000,
  keywords: 12,
  keyword: 30,
  recordBytes: 64 * 1024,
  recordsPerApp: Number(process.env.PLATFORM_MAX_RECORDS) || 10_000,
  summary: 400,
  collection: 40,
  externalId: 100,
  eventType: 40,
});

const CONVERSATION_TTL_MS = 7 * 86_400_000;

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS platform_apps (
        id            BIGSERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL,
        slug          TEXT    NOT NULL,
        name          TEXT    NOT NULL,
        description   TEXT    NOT NULL DEFAULT '',
        icon          TEXT    NOT NULL DEFAULT '',
        homepage      TEXT    NOT NULL DEFAULT '',
        keywords      JSONB   NOT NULL DEFAULT '[]'::jsonb,
        scopes        JSONB   NOT NULL DEFAULT '[]'::jsonb,
        instructions  TEXT    NOT NULL DEFAULT '',
        status        TEXT    NOT NULL DEFAULT 'active',
        created_at    BIGINT  NOT NULL,
        updated_at    BIGINT  NOT NULL,
        last_used_at  BIGINT,
        UNIQUE (user_id, slug)
      );
      CREATE TABLE IF NOT EXISTS platform_keys (
        id            BIGSERIAL PRIMARY KEY,
        app_id        BIGINT  NOT NULL,
        user_id       INTEGER NOT NULL,
        prefix        TEXT    NOT NULL,
        hash          TEXT    NOT NULL UNIQUE,
        label         TEXT    NOT NULL DEFAULT '',
        created_at    BIGINT  NOT NULL,
        last_used_at  BIGINT,
        revoked_at    BIGINT
      );
      CREATE INDEX IF NOT EXISTS platform_keys_app ON platform_keys (app_id);
      CREATE TABLE IF NOT EXISTS platform_records (
        id            BIGSERIAL PRIMARY KEY,
        app_id        BIGINT  NOT NULL,
        user_id       INTEGER NOT NULL,
        collection    TEXT    NOT NULL,
        external_id   TEXT    NOT NULL,
        data          JSONB   NOT NULL DEFAULT '{}'::jsonb,
        summary       TEXT    NOT NULL DEFAULT '',
        created_at    BIGINT  NOT NULL,
        updated_at    BIGINT  NOT NULL,
        UNIQUE (app_id, collection, external_id)
      );
      CREATE INDEX IF NOT EXISTS platform_records_user ON platform_records (user_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS platform_events (
        id            BIGSERIAL PRIMARY KEY,
        app_id        BIGINT  NOT NULL,
        user_id       INTEGER NOT NULL,
        type          TEXT    NOT NULL DEFAULT 'activity',
        summary       TEXT    NOT NULL,
        data          JSONB   NOT NULL DEFAULT '{}'::jsonb,
        created_at    BIGINT  NOT NULL
      );
      CREATE INDEX IF NOT EXISTS platform_events_app ON platform_events (app_id, id DESC);
      CREATE INDEX IF NOT EXISTS platform_events_user ON platform_events (user_id, id DESC);
      CREATE TABLE IF NOT EXISTS platform_conversations (
        id            TEXT    PRIMARY KEY,
        app_id        BIGINT  NOT NULL,
        user_id       INTEGER NOT NULL,
        contents      JSONB   NOT NULL DEFAULT '[]'::jsonb,
        pending       JSONB,
        created_at    BIGINT  NOT NULL,
        updated_at    BIGINT  NOT NULL
      );
      CREATE INDEX IF NOT EXISTS platform_conversations_app ON platform_conversations (app_id, updated_at);
      CREATE TABLE IF NOT EXISTS platform_usage (
        app_id        BIGINT  NOT NULL,
        user_id       INTEGER NOT NULL,
        day           TEXT    NOT NULL,
        requests      INTEGER NOT NULL DEFAULT 0,
        turns         INTEGER NOT NULL DEFAULT 0,
        voice_sessions INTEGER NOT NULL DEFAULT 0,
        voice_seconds INTEGER NOT NULL DEFAULT 0,
        notifications INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (app_id, day)
      );
    `).catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10);
const clip = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);

/** "Chess Arena!" → "chess-arena". */
function slugOf(name) {
  return String(name || "").toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app";
}

function cleanKeywords(v) {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const out = [];
  for (const k of arr) {
    const w = clip(k, LIMITS.keyword).toLowerCase();
    if (w && !out.includes(w)) out.push(w);
    if (out.length >= LIMITS.keywords) break;
  }
  return out;
}

const parseJson = (v, d) => {
  if (v == null) return d;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch (_) { return d; }
};

function appRow(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    slug: r.slug,
    name: r.name,
    description: r.description || "",
    icon: r.icon || "",
    homepage: r.homepage || "",
    keywords: parseJson(r.keywords, []),
    scopes: parseJson(r.scopes, []),
    instructions: r.instructions || "",
    status: r.status,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
  };
}

/* ------------------------------------------------------------------ apps */

async function listApps(userId) {
  await migrate();
  const rows = await query(
    `SELECT * FROM platform_apps WHERE user_id=$1 ORDER BY COALESCE(last_used_at, created_at) DESC, id DESC`,
    [userId]);
  return rows.map(appRow);
}

async function getApp(userId, appId) {
  await migrate();
  return appRow(await one(`SELECT * FROM platform_apps WHERE user_id=$1 AND id=$2`, [userId, Number(appId)]));
}

async function createApp(userId, { name, description, icon, homepage, keywords, scopes, instructions }) {
  await migrate();
  const n = clip(name, LIMITS.name);
  if (!n) return { error: "name required" };
  const count = await one(`SELECT COUNT(*)::int AS n FROM platform_apps WHERE user_id=$1`, [userId]);
  if (count && count.n >= LIMITS.apps) return { error: `you can connect up to ${LIMITS.apps} apps` };
  // A second "Chess" becomes chess-2: the slug is how the assistant and the
  // conversation record name the app, so it is unique per user.
  const base = slugOf(n);
  let slug = base;
  for (let i = 2; await one(`SELECT 1 FROM platform_apps WHERE user_id=$1 AND slug=$2`, [userId, slug]); i++) {
    slug = `${base}-${i}`;
  }
  const t = now();
  const r = await one(
    `INSERT INTO platform_apps (user_id, slug, name, description, icon, homepage, keywords, scopes, instructions, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$10) RETURNING *`,
    [userId, slug, n, clip(description, LIMITS.description), clip(icon, 8), clip(homepage, 300),
      JSON.stringify(cleanKeywords(keywords)), JSON.stringify(scopes || []),
      String(instructions || "").trim().slice(0, LIMITS.instructions), t]);
  return { app: appRow(r) };
}

async function updateApp(userId, appId, patch) {
  await migrate();
  const app = await getApp(userId, appId);
  if (!app) return null;
  const next = {
    name: patch.name !== undefined ? clip(patch.name, LIMITS.name) || app.name : app.name,
    description: patch.description !== undefined ? clip(patch.description, LIMITS.description) : app.description,
    icon: patch.icon !== undefined ? clip(patch.icon, 8) : app.icon,
    homepage: patch.homepage !== undefined ? clip(patch.homepage, 300) : app.homepage,
    keywords: patch.keywords !== undefined ? cleanKeywords(patch.keywords) : app.keywords,
    scopes: patch.scopes !== undefined ? patch.scopes : app.scopes,
    instructions: patch.instructions !== undefined ? String(patch.instructions || "").trim().slice(0, LIMITS.instructions) : app.instructions,
    status: patch.status !== undefined ? patch.status : app.status,
  };
  const r = await one(
    `UPDATE platform_apps SET name=$3, description=$4, icon=$5, homepage=$6, keywords=$7::jsonb,
            scopes=$8::jsonb, instructions=$9, status=$10, updated_at=$11
      WHERE user_id=$1 AND id=$2 RETURNING *`,
    [userId, app.id, next.name, next.description, next.icon, next.homepage, JSON.stringify(next.keywords),
      JSON.stringify(next.scopes), next.instructions, next.status, now()]);
  return appRow(r);
}

/** The app and everything it holds. Returns whether it existed. */
async function deleteApp(userId, appId) {
  await migrate();
  const app = await getApp(userId, appId);
  if (!app) return false;
  for (const t of ["platform_keys", "platform_records", "platform_events", "platform_conversations", "platform_usage"]) {
    await run(`DELETE FROM ${t} WHERE user_id=$1 AND app_id=$2`, [userId, app.id]);
  }
  await run(`DELETE FROM platform_apps WHERE user_id=$1 AND id=$2`, [userId, app.id]);
  return true;
}

function touchApp(appId) {
  run(`UPDATE platform_apps SET last_used_at=$2 WHERE id=$1`, [appId, now()]).catch(() => {});
}

/* ------------------------------------------------------------------ keys */

const hashKey = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");

/**
 * A fresh key: "mya_" + 40 base62 characters (~238 bits). Returned whole
 * exactly once; only its hash and its first 12 characters are kept.
 */
function newKey() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(40);
  let s = "";
  for (const b of bytes) s += alphabet[b % 62];
  return `mya_${s}`;
}

const keyRow = (r) => r && ({
  id: Number(r.id),
  appId: Number(r.app_id),
  prefix: r.prefix,
  label: r.label || "",
  createdAt: Number(r.created_at),
  lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
  revokedAt: r.revoked_at == null ? null : Number(r.revoked_at),
});

async function createKey(userId, appId, label = "") {
  await migrate();
  const app = await getApp(userId, appId);
  if (!app) return null;
  const live = await one(
    `SELECT COUNT(*)::int AS n FROM platform_keys WHERE app_id=$1 AND revoked_at IS NULL`, [app.id]);
  if (live && live.n >= LIMITS.keysPerApp) {
    return { error: `an app can have up to ${LIMITS.keysPerApp} keys — revoke one first` };
  }
  const key = newKey();
  const r = await one(
    `INSERT INTO platform_keys (app_id, user_id, prefix, hash, label, created_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [app.id, userId, key.slice(0, 12), hashKey(key), clip(label, 40), now()]);
  return { key, info: keyRow(r) };
}

async function listKeys(userId, appId) {
  await migrate();
  const rows = await query(
    `SELECT * FROM platform_keys WHERE user_id=$1 AND app_id=$2 ORDER BY revoked_at IS NOT NULL, id DESC`,
    [userId, Number(appId)]);
  return rows.map(keyRow);
}

async function revokeKey(userId, appId, keyId) {
  await migrate();
  const r = await one(
    `UPDATE platform_keys SET revoked_at=$4 WHERE user_id=$1 AND app_id=$2 AND id=$3 AND revoked_at IS NULL RETURNING id`,
    [userId, Number(appId), Number(keyId), now()]);
  return Boolean(r);
}

/** The live key, its app and the app's owner — or null. */
async function resolveKey(key) {
  if (typeof key !== "string" || !/^mya_[A-Za-z0-9]{40}$/.test(key)) return null;
  await migrate();
  const r = await one(
    `SELECT k.id AS key_id, k.last_used_at AS key_used, a.*
       FROM platform_keys k JOIN platform_apps a ON a.id = k.app_id AND a.user_id = k.user_id
      WHERE k.hash=$1 AND k.revoked_at IS NULL`,
    [hashKey(key)]);
  if (!r) return null;
  // Last used, at most once a minute per key: not a write per request.
  if (!r.key_used || now() - Number(r.key_used) > 60_000) {
    run(`UPDATE platform_keys SET last_used_at=$2 WHERE id=$1`, [r.key_id, now()]).catch(() => {});
    touchApp(r.id);
  }
  return { keyId: Number(r.key_id), app: appRow(r) };
}

/* --------------------------------------------------------------- records */

const recordRow = (r) => r && ({
  collection: r.collection,
  id: r.external_id,
  data: parseJson(r.data, {}),
  summary: r.summary || "",
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const COLLECTION_RX = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const ID_RX = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;

async function putRecord(app, collection, externalId, { data, summary }) {
  await migrate();
  if (!COLLECTION_RX.test(collection || "")) return { error: "collection: letters, digits, _ and -, up to 40" };
  const id = externalId || `r_${crypto.randomBytes(8).toString("hex")}`;
  if (!ID_RX.test(id)) return { error: "id: letters, digits and _ . : -, up to 100" };
  const body = data === undefined ? {} : data;
  if (body === null || typeof body !== "object") return { error: "data must be a JSON object or array" };
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json) > LIMITS.recordBytes) return { error: "data is larger than 64 KB" };
  const exists = await one(
    `SELECT 1 FROM platform_records WHERE app_id=$1 AND collection=$2 AND external_id=$3`, [app.id, collection, id]);
  if (!exists) {
    const n = await one(`SELECT COUNT(*)::int AS n FROM platform_records WHERE app_id=$1`, [app.id]);
    if (n && n.n >= LIMITS.recordsPerApp) return { error: `this app already keeps ${LIMITS.recordsPerApp} records — delete some first` };
  }
  const t = now();
  const r = await one(
    `INSERT INTO platform_records (app_id, user_id, collection, external_id, data, summary, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$7)
     ON CONFLICT (app_id, collection, external_id) DO UPDATE SET
       data=EXCLUDED.data, summary=EXCLUDED.summary, updated_at=EXCLUDED.updated_at
     RETURNING *`,
    [app.id, app.userId, collection, id, json, clip(summary, LIMITS.summary), t]);
  return { record: recordRow(r), created: !exists };
}

async function getRecord(app, collection, externalId) {
  await migrate();
  return recordRow(await one(
    `SELECT * FROM platform_records WHERE app_id=$1 AND collection=$2 AND external_id=$3`,
    [app.id, String(collection), String(externalId)]));
}

async function listRecords(app, collection, { limit = 50, before = null } = {}) {
  await migrate();
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const params = [app.id, String(collection)];
  let where = "app_id=$1 AND collection=$2";
  if (Number(before) > 0) { params.push(Number(before)); where += ` AND updated_at < $${params.length}`; }
  params.push(n);
  const rows = await query(
    `SELECT * FROM platform_records WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT $${params.length}`, params);
  return rows.map(recordRow);
}

async function deleteRecord(app, collection, externalId) {
  await migrate();
  const r = await one(
    `DELETE FROM platform_records WHERE app_id=$1 AND collection=$2 AND external_id=$3 RETURNING id`,
    [app.id, String(collection), String(externalId)]);
  return Boolean(r);
}

async function collections(app) {
  await migrate();
  return query(
    `SELECT collection, COUNT(*)::int AS count, MAX(updated_at) AS updated_at
       FROM platform_records WHERE app_id=$1 GROUP BY collection ORDER BY MAX(updated_at) DESC`, [app.id])
    .then((rows) => rows.map((r) => ({ collection: r.collection, count: r.count, updatedAt: Number(r.updated_at) })));
}

/* ---------------------------------------------------------------- events */

const eventRow = (r) => r && ({
  id: Number(r.id),
  appId: Number(r.app_id),
  type: r.type,
  summary: r.summary,
  data: parseJson(r.data, {}),
  createdAt: Number(r.created_at),
});

async function addEvent(app, { type, summary, data }) {
  await migrate();
  const s = clip(summary, LIMITS.summary);
  if (!s) return { error: "summary required — one line saying what happened" };
  const body = data === undefined || data === null ? {} : data;
  if (typeof body !== "object") return { error: "data must be a JSON object" };
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json) > 16 * 1024) return { error: "data is larger than 16 KB" };
  const ty = clip(type || "activity", LIMITS.eventType).toLowerCase().replace(/[^a-z0-9_.-]/g, "_") || "activity";
  const r = await one(
    `INSERT INTO platform_events (app_id, user_id, type, summary, data, created_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
    [app.id, app.userId, ty, s, json, now()]);
  // A feed, not an archive: the newest 2,000 per app are kept.
  run(`DELETE FROM platform_events WHERE app_id=$1 AND id < (
         SELECT id FROM platform_events WHERE app_id=$1 ORDER BY id DESC OFFSET 2000 LIMIT 1)`, [app.id]).catch(() => {});
  return { event: eventRow(r) };
}

async function listEvents(userId, appId, { limit = 30, before = null } = {}) {
  await migrate();
  const n = Math.max(1, Math.min(100, Number(limit) || 30));
  const params = [userId, Number(appId)];
  let where = "user_id=$1 AND app_id=$2";
  if (Number(before) > 0) { params.push(Number(before)); where += ` AND id < $${params.length}`; }
  params.push(n);
  const rows = await query(
    `SELECT * FROM platform_events WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`, params);
  return rows.map(eventRow);
}

/**
 * What the assistant reads when asked about a connected app: the newest
 * events and records across the user's apps (or one app), optionally only
 * those whose words match `q`. ILIKE on the summary and the data's text —
 * a user's own apps hold little enough that this needs no index.
 */
async function search(userId, { appId = null, appIds = null, q = "", limit = 8 } = {}) {
  await migrate();
  const n = Math.max(1, Math.min(25, Number(limit) || 8));
  const words = String(q || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3).slice(0, 6);
  const params = [userId];
  let appWhere = "";
  const ids = appIds && appIds.length ? appIds.map(Number) : appId ? [Number(appId)] : null;
  if (ids) { params.push(ids); appWhere = ` AND app_id = ANY($${params.length}::bigint[])`; }
  let match = "";
  if (words.length) {
    const ors = words.map((w) => { params.push(`%${w}%`); return `(lower(summary) LIKE $${params.length} OR lower(data::text) LIKE $${params.length})`; });
    match = ` AND (${ors.join(" OR ")})`;
  }
  params.push(n);
  const lim = `$${params.length}`;
  const [events, records] = await Promise.all([
    query(`SELECT * FROM platform_events WHERE user_id=$1${appWhere}${match} ORDER BY id DESC LIMIT ${lim}`, params),
    query(`SELECT * FROM platform_records WHERE user_id=$1${appWhere}${match} ORDER BY updated_at DESC LIMIT ${lim}`, params),
  ]);
  return {
    events: events.map(eventRow),
    records: records.map((r) => ({ ...recordRow(r), appId: Number(r.app_id) })),
  };
}

/* --------------------------------------------------------- conversations */

const CONV_RX = /^conv_[a-f0-9]{24}$/;

async function getConversation(app, id) {
  if (!CONV_RX.test(String(id || ""))) return null;
  await migrate();
  const r = await one(
    `SELECT * FROM platform_conversations WHERE id=$1 AND app_id=$2 AND user_id=$3`, [id, app.id, app.userId]);
  if (!r || now() - Number(r.updated_at) > CONVERSATION_TTL_MS) return null;
  return { id: r.id, contents: parseJson(r.contents, []), pending: parseJson(r.pending, null), createdAt: Number(r.created_at) };
}

function newConversationId() {
  return `conv_${crypto.randomBytes(12).toString("hex")}`;
}

async function saveConversation(app, conv) {
  await migrate();
  const t = now();
  await run(
    `INSERT INTO platform_conversations (id, app_id, user_id, contents, pending, created_at, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$6)
     ON CONFLICT (id) DO UPDATE SET contents=EXCLUDED.contents, pending=EXCLUDED.pending, updated_at=EXCLUDED.updated_at`,
    [conv.id, app.id, app.userId, JSON.stringify(conv.contents || []),
      conv.pending ? JSON.stringify(conv.pending) : null, t]);
  // Old conversations go, a few at a time.
  run(`DELETE FROM platform_conversations WHERE updated_at < $1`, [t - CONVERSATION_TTL_MS]).catch(() => {});
}

async function deleteConversation(app, id) {
  await migrate();
  const r = await one(`DELETE FROM platform_conversations WHERE id=$1 AND app_id=$2 RETURNING id`, [String(id), app.id]);
  return Boolean(r);
}

/* ----------------------------------------------------------------- usage */

const USAGE_COLS = new Set(["requests", "turns", "voice_sessions", "voice_seconds", "notifications"]);

function bump(app, col, by = 1) {
  if (!USAGE_COLS.has(col)) return Promise.resolve();
  return run(
    `INSERT INTO platform_usage (app_id, user_id, day, ${col}) VALUES ($1,$2,$3,$4)
     ON CONFLICT (app_id, day) DO UPDATE SET ${col} = platform_usage.${col} + EXCLUDED.${col}`,
    [app.id, app.userId, today(), Math.max(0, Math.round(Number(by) || 0))]).catch(() => {});
}

async function usageToday(appId) {
  await migrate();
  const r = await one(`SELECT * FROM platform_usage WHERE app_id=$1 AND day=$2`, [Number(appId), today()]);
  return {
    requests: r ? r.requests : 0,
    turns: r ? r.turns : 0,
    voiceSessions: r ? r.voice_sessions : 0,
    voiceSeconds: r ? r.voice_seconds : 0,
    notifications: r ? r.notifications : 0,
  };
}

async function usageMonth(appId) {
  await migrate();
  const from = today().slice(0, 7) + "-01";
  const r = await one(
    `SELECT COALESCE(SUM(requests),0)::int AS requests, COALESCE(SUM(turns),0)::int AS turns,
            COALESCE(SUM(voice_sessions),0)::int AS voice_sessions, COALESCE(SUM(voice_seconds),0)::int AS voice_seconds
       FROM platform_usage WHERE app_id=$1 AND day >= $2`, [Number(appId), from]);
  return { requests: r.requests, turns: r.turns, voiceSessions: r.voice_sessions, voiceSeconds: r.voice_seconds };
}

/** The last `days` days, oldest first, zeros filled in (the console chart). */
async function usageDays(appId, days = 30) {
  await migrate();
  const n = Math.max(1, Math.min(90, Number(days) || 30));
  const from = new Date(Date.now() - (n - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = await query(`SELECT * FROM platform_usage WHERE app_id=$1 AND day >= $2`, [Number(appId), from]);
  const by = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const r = by.get(day);
    out.push({ day, requests: r ? r.requests : 0, messages: r ? r.turns : 0, voiceSeconds: r ? r.voice_seconds : 0 });
  }
  return out;
}

const USER_TABLES = [
  ["platform_keys", "user_id"],
  ["platform_records", "user_id"],
  ["platform_events", "user_id"],
  ["platform_conversations", "user_id"],
  ["platform_usage", "user_id"],
  ["platform_apps", "user_id"],
  ["platform_console_codes", "user_id"],
];

module.exports = {
  migrate, LIMITS, slugOf, cleanKeywords,
  listApps, getApp, createApp, updateApp, deleteApp, touchApp,
  newKey, hashKey, createKey, listKeys, revokeKey, resolveKey,
  putRecord, getRecord, listRecords, deleteRecord, collections,
  addEvent, listEvents, search,
  getConversation, newConversationId, saveConversation, deleteConversation,
  bump, usageToday, usageMonth, usageDays,
  USER_TABLES,
};
