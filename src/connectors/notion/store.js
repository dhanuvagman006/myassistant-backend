/**
 * NOTION — the per-user connection and the one-time OAuth states.
 *
 * Tokens are encrypted at rest with the same scheme as mail passwords and
 * MCP secrets (mcp/schema.js), and never logged, returned or exported.
 *
 * THE CACHE only decides which tools are OFFERED (declarations run
 * synchronously). It fails closed: a user who is not in it is offered
 * nothing. Every execution re-reads the database.
 */
const crypto = require("crypto");
const { one, run } = require("../../db");
const { encryptSecrets, decryptSecrets } = require("../../mcp/schema");
const config = require("./config");

const TTL_MS = 60_000;
const CACHE_MAX = 2000;
/** uid -> {connected, status, lastTitle, at} */
const cache = new Map();

async function migrate(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS notion_connections (
      user_id        INTEGER PRIMARY KEY,
      workspace_id   TEXT   NOT NULL DEFAULT '',
      workspace_name TEXT   NOT NULL DEFAULT '',
      workspace_icon TEXT   NOT NULL DEFAULT '',
      bot_id         TEXT   NOT NULL DEFAULT '',
      secrets_enc    TEXT   NOT NULL,
      status         TEXT   NOT NULL DEFAULT 'connected',
      last_error     TEXT   NOT NULL DEFAULT '',
      defaults       JSONB  NOT NULL DEFAULT '{}',
      connected_at   BIGINT NOT NULL,
      refreshed_at   BIGINT NOT NULL DEFAULT 0,
      last_used_at   BIGINT NOT NULL DEFAULT 0,
      updated_at     BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connector_oauth_states (
      state_hash TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      provider   TEXT    NOT NULL,
      created_at BIGINT  NOT NULL,
      expires_at BIGINT  NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_states_user ON connector_oauth_states(user_id);
  `);
}

const clip = (s, n) => String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim().slice(0, n);

function setCache(uid, row) {
  if (cache.size >= CACHE_MAX && !cache.has(uid)) cache.clear();
  cache.set(uid, {
    connected: Boolean(row && row.status === "connected"),
    status: row ? row.status : "",
    lastTitle: (row && row.defaults && row.defaults.last && row.defaults.last.title) || "",
    at: Date.now(),
  });
}

/** Upsert after a successful code exchange. */
async function saveConnection(userId, tok) {
  const uid = Number(userId);
  const now = Date.now();
  const secrets = encryptSecrets({
    access_token: String(tok.access_token || ""),
    refresh_token: tok.refresh_token ? String(tok.refresh_token) : null,
  });
  await run(
    `INSERT INTO notion_connections
       (user_id, workspace_id, workspace_name, workspace_icon, bot_id, secrets_enc,
        status, last_error, defaults, connected_at, refreshed_at, last_used_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'connected','','{}',$7,0,0,$7)
     ON CONFLICT (user_id) DO UPDATE SET
       workspace_id = EXCLUDED.workspace_id, workspace_name = EXCLUDED.workspace_name,
       workspace_icon = EXCLUDED.workspace_icon, bot_id = EXCLUDED.bot_id,
       secrets_enc = EXCLUDED.secrets_enc, status = 'connected', last_error = '',
       defaults = CASE WHEN notion_connections.workspace_id = EXCLUDED.workspace_id
                       THEN notion_connections.defaults ELSE '{}'::jsonb END,
       connected_at = EXCLUDED.connected_at, updated_at = EXCLUDED.updated_at`,
    [uid, clip(tok.workspace_id, 80), clip(tok.workspace_name, 120),
      clip(tok.workspace_icon, 300), clip(tok.bot_id, 80), secrets, now]
  );
  const row = await one(`SELECT status, defaults FROM notion_connections WHERE user_id = $1`, [uid]);
  setCache(uid, row);
}

/**
 * The row and its decrypted tokens, or null when not linked. `secrets` is
 * null when they cannot be read (the key changed): the link is then marked
 * as needing a reconnect.
 */
async function load(userId) {
  const uid = Number(userId);
  if (!(uid > 0)) return null;
  const row = await one(`SELECT * FROM notion_connections WHERE user_id = $1`, [uid]);
  if (!row) {
    setCache(uid, null);
    return null;
  }
  const secrets = decryptSecrets(row.secrets_enc);
  if (!secrets || !secrets.access_token) {
    if (row.status !== "needs_reconnect") {
      await markNeedsReconnect(uid, "stored credentials could not be read");
      row.status = "needs_reconnect";
    }
    setCache(uid, row);
    return { row, secrets: null };
  }
  setCache(uid, row);
  return { row, secrets };
}

/** Persists a refreshed pair BEFORE it is used. */
async function setTokens(userId, { access_token, refresh_token }) {
  const now = Date.now();
  await run(
    `UPDATE notion_connections SET secrets_enc = $2, refreshed_at = $3, updated_at = $3,
            status = 'connected', last_error = ''
      WHERE user_id = $1`,
    [Number(userId), encryptSecrets({ access_token, refresh_token: refresh_token || null }), now]
  );
}

async function markNeedsReconnect(userId, reason) {
  const uid = Number(userId);
  await run(
    `UPDATE notion_connections SET status = 'needs_reconnect', last_error = $2, updated_at = $3
      WHERE user_id = $1`,
    [uid, clip(reason, 200), Date.now()]
  ).catch(() => 0);
  const c = cache.get(uid);
  setCache(uid, { status: "needs_reconnect", defaults: { last: { title: c ? c.lastTitle : "" } } });
}

async function remove(userId) {
  const uid = Number(userId);
  const n = await run(`DELETE FROM notion_connections WHERE user_id = $1`, [uid]);
  setCache(uid, null);
  return n;
}

async function touch(userId) {
  await run(`UPDATE notion_connections SET last_used_at = $2 WHERE user_id = $1`,
    [Number(userId), Date.now()]).catch(() => 0);
}

/** Remembers the page last written to ("add it to the same page"). */
async function setLast(userId, target) {
  const uid = Number(userId);
  const last = { kind: target.kind, id: target.id, title: clip(target.title, 200) };
  await run(
    `UPDATE notion_connections SET defaults = jsonb_set(defaults, '{last}', $2::jsonb), updated_at = $3
      WHERE user_id = $1`,
    [uid, JSON.stringify(last), Date.now()]
  ).catch(() => 0);
  const c = cache.get(uid);
  if (c) c.lastTitle = last.title;
}

/** Offered only when cached as connected. A miss is "no" (fail closed). */
function isConnectedSync(userId) {
  const c = cache.get(Number(userId));
  return Boolean(c && c.connected);
}

function statusSync(userId) {
  const c = cache.get(Number(userId));
  return c ? c.status || "" : "";
}

function lastTitleSync(userId) {
  const c = cache.get(Number(userId));
  return (c && c.lastTitle) || "";
}

/**
 * Fills the cache right before declarations are built. Costs nothing
 * until the owner configures Notion; never throws.
 */
async function prime(userId) {
  const uid = Number(userId);
  if (!config.enabled() || !(uid > 0)) return;
  const c = cache.get(uid);
  if (c && Date.now() - c.at < TTL_MS) return;
  try {
    const row = await one(
      `SELECT status, defaults FROM notion_connections WHERE user_id = $1`, [uid]);
    setCache(uid, row);
  } catch (_) { /* stays a miss: nothing offered */ }
}

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/** A new single-use state; only its hash is stored. */
async function createState(userId) {
  const uid = Number(userId);
  const raw = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  await run(`DELETE FROM connector_oauth_states WHERE user_id = $1 AND provider = 'notion'`, [uid]);
  await run(
    `INSERT INTO connector_oauth_states (state_hash, user_id, provider, created_at, expires_at)
     VALUES ($1, $2, 'notion', $3, $4)`,
    [sha(raw), uid, now, now + config.STATE_TTL_MS]
  );
  return raw;
}

/** The user the state was made for, once; null if unknown, used or expired. */
async function consumeState(raw) {
  if (!raw || String(raw).length > 200) return null;
  const row = await one(
    `DELETE FROM connector_oauth_states
      WHERE state_hash = $1 AND provider = 'notion' AND expires_at > $2
      RETURNING user_id`,
    [sha(raw), Date.now()]
  );
  return row ? Number(row.user_id) : null;
}

async function sweepStates() {
  return run(`DELETE FROM connector_oauth_states WHERE expires_at <= $1`, [Date.now()]);
}

module.exports = {
  migrate, saveConnection, load, setTokens, markNeedsReconnect, remove, touch, setLast,
  isConnectedSync, statusSync, lastTitleSync, prime, createState, consumeState, sweepStates,
  _cache: cache,
};
