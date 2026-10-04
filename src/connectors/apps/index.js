/**
 * CONNECTED APPS — standard OAuth 2 sign-in for the apps listed in
 * PROVIDERS (owner, 2026-10-04). Same shape as the Notion connector:
 *
 *   POST   /connections/:id/start          (app)     the consent URL
 *   DELETE /connections/:id                (app)     forget the link
 *   GET    /connect/app/:id/callback       (public)  the provider sends the browser here
 *
 * The list itself is served by GET /connections (notion/routes.js), which
 * appends cards(). A provider is inert until the owner sets its
 * <PREFIX>_CLIENT_ID and <PREFIX>_CLIENT_SECRET; until then the app shows
 * it as "Coming soon". The code is exchanged here, on the server: no code,
 * secret or token reaches the phone, a log or an error message. Tokens are
 * encrypted at rest like the Notion ones.
 */
const crypto = require("crypto");
const express = require("express");
const { one, run } = require("../../db");
const { encryptSecrets } = require("../../mcp/schema");

const APP_SCHEME = "com.myassistant.myassistant";
const STATE_TTL_MS = 600_000;

const PROVIDERS = {
  microsoft: {
    name: "Microsoft 365", env: "MICROSOFT",
    blurb: "Outlook mail and calendar, Teams and OneDrive",
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Files.ReadWrite Chat.ReadWrite",
  },
  todoist: {
    name: "Todoist", env: "TODOIST",
    blurb: "Add and tick off your tasks",
    authorize: "https://todoist.com/oauth/authorize",
    token: "https://todoist.com/oauth/access_token",
    scope: "data:read_write", scopeSep: ",",
  },
  asana: {
    name: "Asana", env: "ASANA",
    blurb: "Your team's projects and tasks",
    authorize: "https://app.asana.com/-/oauth_authorize",
    token: "https://app.asana.com/-/oauth_token",
    pick: (j) => ({ ...j, account: j.data && j.data.name }),
  },
  spotify: {
    name: "Spotify", env: "SPOTIFY",
    blurb: "Play your music and playlists by voice",
    authorize: "https://accounts.spotify.com/authorize",
    token: "https://accounts.spotify.com/api/token",
    scope: "user-read-playback-state user-modify-playback-state playlist-read-private",
    basic: true,
  },
  zoom: {
    name: "Zoom", env: "ZOOM",
    blurb: "Create meeting links and share them",
    authorize: "https://zoom.us/oauth/authorize",
    token: "https://zoom.us/oauth/token",
    basic: true,
  },
  dropbox: {
    name: "Dropbox", env: "DROPBOX",
    blurb: "Find and share your files",
    authorize: "https://www.dropbox.com/oauth2/authorize",
    token: "https://api.dropboxapi.com/oauth2/token",
    extra: { token_access_type: "offline" },
  },
};

const env = (k) => String(process.env[k] || "").trim();
const clientId = (p) => env(`${p.env}_CLIENT_ID`);
const clientSecret = (p) => env(`${p.env}_CLIENT_SECRET`);

function redirectUri(id) {
  const base = env("PUBLIC_BASE_URL").replace(/\/+$/, "");
  return base ? `${base}/connect/app/${id}/callback` : "";
}

function enabled(id) {
  const p = PROVIDERS[id];
  return Boolean(p && clientId(p) && clientSecret(p) && redirectUri(id));
}

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

async function migrate(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS app_connections (
      user_id      INTEGER NOT NULL,
      provider     TEXT    NOT NULL,
      account      TEXT    NOT NULL DEFAULT '',
      secrets_enc  TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'connected',
      connected_at BIGINT  NOT NULL,
      updated_at   BIGINT  NOT NULL,
      PRIMARY KEY (user_id, provider)
    );
  `);
}

/* ---- states (shared table with Notion, provider-scoped) ---- */

async function createState(uid, id) {
  const raw = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  await run(`DELETE FROM connector_oauth_states WHERE user_id = $1 AND provider = $2`, [uid, id]);
  await run(
    `INSERT INTO connector_oauth_states (state_hash, user_id, provider, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [sha(raw), uid, id, now, now + STATE_TTL_MS]
  );
  return raw;
}

async function consumeState(raw, id) {
  if (!raw || String(raw).length > 200) return null;
  const row = await one(
    `DELETE FROM connector_oauth_states
      WHERE state_hash = $1 AND provider = $2 AND expires_at > $3
      RETURNING user_id`,
    [sha(raw), id, Date.now()]
  );
  return row ? Number(row.user_id) : null;
}

/* ---- OAuth ---- */

function authorizeUrl(id, state) {
  const p = PROVIDERS[id];
  const u = new URL(p.authorize);
  u.searchParams.set("client_id", clientId(p));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri(id));
  u.searchParams.set("state", state);
  if (p.scope) {
    u.searchParams.set(p.scopeParam || "scope", p.scope.split(" ").join(p.scopeSep || " "));
  }
  for (const [k, v] of Object.entries(p.extra || {})) u.searchParams.set(k, v);
  return u.toString();
}

async function exchange(id, code) {
  const p = PROVIDERS[id];
  const body = new URLSearchParams({
    grant_type: "authorization_code", code: String(code), redirect_uri: redirectUri(id),
  });
  const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (p.basic) {
    headers.Authorization = "Basic " + Buffer.from(`${clientId(p)}:${clientSecret(p)}`).toString("base64");
  } else {
    body.set("client_id", clientId(p));
    body.set("client_secret", clientSecret(p));
  }
  const res = await fetch(p.token, {
    method: "POST", headers, body, signal: AbortSignal.timeout(10_000),
  });
  let j = {};
  try { j = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok || j.ok === false || j.error) {
    const code = String(j.error || `http_${res.status}`).replace(/[^\w.-]/g, "").slice(0, 40);
    throw new Error(`${id} oauth: ${code || "error"}`);
  }
  const t = p.pick ? p.pick(j) : j;
  if (!t.access_token) throw new Error(`${id} oauth: no_token`);
  return t;
}

/* ---- storage ---- */

async function save(uid, id, t) {
  const now = Date.now();
  const secrets = encryptSecrets({
    access_token: String(t.access_token),
    refresh_token: t.refresh_token ? String(t.refresh_token) : null,
    expires_at: t.expires_in ? now + Number(t.expires_in) * 1000 : null,
  });
  const account = String(t.account || "").replace(/[\r\n]+/g, " ").trim().slice(0, 120);
  await run(
    `INSERT INTO app_connections (user_id, provider, account, secrets_enc, status, connected_at, updated_at)
     VALUES ($1,$2,$3,$4,'connected',$5,$5)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       account = EXCLUDED.account, secrets_enc = EXCLUDED.secrets_enc, status = 'connected',
       connected_at = EXCLUDED.connected_at, updated_at = EXCLUDED.updated_at`,
    [uid, id, account, secrets, now]
  );
}

/** The cards GET /connections appends after Notion's. Never a token. */
async function cards(uid) {
  let rows = [];
  if (uid > 0) {
    try {
      rows = (await require("../../db").query(
        `SELECT provider, account, status, connected_at FROM app_connections WHERE user_id = $1`,
        [uid])) || [];
    } catch (e) {
      console.warn("app connections read failed:", e.message);
    }
  }
  return Object.entries(PROVIDERS).map(([id, p]) => {
    const r = rows.find((x) => x.provider === id);
    return {
      id, name: p.name, description: p.blurb, available: enabled(id),
      status: r ? (r.status === "connected" ? "connected" : "needs_reconnect") : "not_connected",
      workspace: r ? r.account || null : null,
      connectedAt: r ? Number(r.connected_at) || null : null,
      lastUsedAt: null, minBuild: 158,
    };
  });
}

/* ---- HTTP ---- */

const appRouter = express.Router();
const publicRouter = express.Router();

async function audit(uid, action) {
  try { await require("../../audit/log").record(uid, action, ""); } catch (_) {}
}

const starts = new Map();
function tooManyStarts(uid) {
  const now = Date.now();
  if (starts.size > 1000) starts.clear();
  const list = (starts.get(uid) || []).filter((t) => now - t < 600_000);
  starts.set(uid, list);
  if (list.length >= 10) return true;
  list.push(now);
  return false;
}

appRouter.post("/:id/start", async (req, res) => {
  const uid = Number(req.user.sub);
  const id = req.params.id;
  if (!(uid > 0)) return res.status(401).json({ error: "sign in" });
  if (!PROVIDERS[id]) return res.status(404).json({ error: "unknown_app" });
  if (!enabled(id)) return res.status(503).json({ error: "not_available" });
  if (tooManyStarts(uid)) return res.status(429).json({ error: "too_many_attempts" });
  try {
    const state = await createState(uid, id);
    res.setHeader("Cache-Control", "no-store");
    res.json({ authUrl: authorizeUrl(id, state), callbackScheme: APP_SCHEME,
      expiresInS: Math.round(STATE_TTL_MS / 1000) });
  } catch (e) {
    console.warn(`${id} start failed:`, e.message);
    res.status(500).json({ error: "could_not_start" });
  }
});

appRouter.delete("/:id", async (req, res) => {
  const uid = Number(req.user.sub);
  const id = req.params.id;
  if (!(uid > 0)) return res.status(401).json({ error: "sign in" });
  if (!PROVIDERS[id]) return res.status(404).json({ error: "unknown_app" });
  try {
    await run(`DELETE FROM app_connections WHERE user_id = $1 AND provider = $2`, [uid, id]);
    await audit(uid, `connector.${id}.disconnected`);
    res.json({ ok: true });
  } catch (e) {
    console.warn(`${id} disconnect failed:`, e.message);
    res.status(500).json({ error: "could_not_disconnect" });
  }
});

function backToApp(res, id, result) {
  const name = PROVIDERS[id] ? PROVIDERS[id].name : "The app";
  const u = `${APP_SCHEME}://connected?app=${encodeURIComponent(id)}&result=${result}`;
  const words = result === "ok"
    ? `${name} is connected. You can go back to the app.`
    : result === "cancelled"
      ? "Nothing was connected. You can go back to the app."
      : `${name} could not be connected. Please go back to the app and try again.`;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.status(302).setHeader("Location", u);
  res.type("html").send(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Connected apps</title></head><body style="font-family:system-ui,sans-serif;padding:32px">` +
    `<p>${words}</p><p><a href="${u}">Back to the app</a></p></body></html>`
  );
}

publicRouter.get("/:id/callback", async (req, res) => {
  const id = req.params.id;
  if (!PROVIDERS[id]) return res.status(404).send("Not found");
  const q = (k) => (typeof req.query[k] === "string" ? req.query[k] : "");
  let uid = null;
  try {
    uid = await consumeState(q("state"), id);
  } catch (e) {
    console.warn(`${id} callback state check failed:`, e.message);
  }
  if (!uid) return backToApp(res, id, "error");
  if (q("error") === "access_denied") return backToApp(res, id, "cancelled");
  if (q("error") || !q("code") || !enabled(id)) return backToApp(res, id, "error");
  try {
    await save(uid, id, await exchange(id, q("code")));
    await audit(uid, `connector.${id}.connected`);
  } catch (e) {
    // The provider's error word only — never the code, the state or a token.
    console.warn(`${id} connect failed: ${e.message}`);
    return backToApp(res, id, "error");
  }
  return backToApp(res, id, "ok");
});

module.exports = { PROVIDERS, migrate, cards, enabled, appRouter, publicRouter, _authorizeUrl: authorizeUrl };
