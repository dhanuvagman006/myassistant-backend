/**
 * NOTION — HTTP.
 *
 *   GET    /connections                 (app)     what is linked
 *   POST   /connections/notion/start    (app)     the consent URL
 *   DELETE /connections/notion          (app)     revoke and forget
 *   GET    /connect/notion/callback     (public)  Notion sends the browser here
 *
 * The callback is public: the single-use `state` names the user. The code
 * is exchanged here, and the browser is sent back to the app with only a
 * result word — never a code or a token. Notion's public OAuth has no
 * PKCE, so the code must not go to a custom scheme another app could claim.
 */
const express = require("express");
const config = require("./config");
const store = require("./store");
const oauth = require("./oauth");

const appRouter = express.Router();
const publicRouter = express.Router();

async function audit(uid, action, detail) {
  try { await require("../../audit/log").record(uid, action, detail); } catch (_) {}
}

/** Best effort: both tokens of the stored grant. Returns true when a row existed. */
async function revokeStored(uid) {
  let conn = null;
  try { conn = await store.load(uid); } catch (_) { return false; }
  if (!conn) return false;
  if (conn.secrets) {
    await oauth.revoke(conn.secrets.access_token);
    if (conn.secrets.refresh_token) await oauth.revoke(conn.secrets.refresh_token);
  }
  return true;
}

/* ---- app ---- */

appRouter.get("/", async (req, res) => {
  const uid = Number(req.user.sub);
  const card = {
    id: "notion", name: "Notion", available: config.enabled(), status: "not_connected",
    workspace: null, connectedAt: null, lastUsedAt: null, minBuild: 120,
  };
  if (card.available && uid > 0) {
    try {
      const conn = await store.load(uid);
      if (conn) {
        card.status = conn.secrets && conn.row.status === "connected" ? "connected" : "needs_reconnect";
        card.workspace = conn.row.workspace_name || "your workspace";
        card.connectedAt = Number(conn.row.connected_at) || null;
        card.lastUsedAt = Number(conn.row.last_used_at) || null;
      }
    } catch (e) {
      console.warn("connections read failed:", e.message);
    }
  }
  res.setHeader("Cache-Control", "no-store");
  const more = await require("../apps").cards(uid);
  res.json({ connections: [card, ...more] });
});

/** Starts per user: 5 in 10 minutes. */
const starts = new Map();
function tooManyStarts(uid) {
  const now = Date.now();
  if (starts.size > 1000) starts.clear();
  const list = (starts.get(uid) || []).filter((t) => now - t < 600_000);
  starts.set(uid, list);
  if (list.length >= 5) return true;
  list.push(now);
  return false;
}

appRouter.post("/notion/start", async (req, res) => {
  const uid = Number(req.user.sub);
  if (!(uid > 0)) return res.status(401).json({ error: "sign in" });
  if (!config.enabled()) return res.status(503).json({ error: "not_available" });
  if (tooManyStarts(uid)) return res.status(429).json({ error: "too_many_attempts" });
  try {
    const state = await store.createState(uid);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      authUrl: oauth.authorizeUrl(state),
      callbackScheme: config.APP_SCHEME,
      expiresInS: Math.round(config.STATE_TTL_MS / 1000),
    });
  } catch (e) {
    console.warn("notion start failed:", e.message);
    res.status(500).json({ error: "could_not_start" });
  }
});

appRouter.delete("/notion", async (req, res) => {
  const uid = Number(req.user.sub);
  if (!(uid > 0)) return res.status(401).json({ error: "sign in" });
  try {
    const had = await revokeStored(uid);
    await store.remove(uid);
    if (had) await audit(uid, "connector.notion.disconnected", "");
    res.json({ ok: true });
  } catch (e) {
    console.warn("notion disconnect failed:", e.message);
    res.status(500).json({ error: "could_not_disconnect" });
  }
});

/* ---- public callback ---- */

function backToApp(res, result, reason) {
  const u = `${config.APP_SCHEME}://connected?app=notion&result=${result}${reason ? `&reason=${reason}` : ""}`;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  const words = result === "ok"
    ? "Notion is connected. You can go back to the app."
    : result === "cancelled"
      ? "Nothing was connected. You can go back to the app."
      : "Notion could not be connected. Please go back to the app and try again.";
  res.status(302).setHeader("Location", u);
  res.type("html").send(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Connected apps</title></head><body style="font-family:system-ui,sans-serif;padding:32px">` +
    `<p>${words}</p><p><a href="${u}">Back to the app</a></p></body></html>`
  );
}

publicRouter.get("/callback", async (req, res) => {
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const error = typeof req.query.error === "string" ? req.query.error : "";
  let uid = null;
  try {
    uid = await store.consumeState(state);
  } catch (e) {
    console.warn("notion callback state check failed:", e.message);
  }
  if (!uid) return backToApp(res, "error", "expired");
  if (error === "access_denied") return backToApp(res, "cancelled");
  if (error || !code) return backToApp(res, "error", "exchange_failed");
  if (!config.enabled()) return backToApp(res, "error", "exchange_failed");

  let tok;
  try {
    tok = await oauth.exchangeCode(code);
    if (!tok || !tok.access_token) throw new oauth.OAuthError("no_token");
  } catch (e) {
    // Notion's error field only — never the code, the state or a token.
    console.warn(`notion connect failed: ${e.code || "error"}`);
    return backToApp(res, "error", "exchange_failed");
  }
  try {
    // One workspace per user: the previous grant is revoked first.
    await revokeStored(uid);
    await store.saveConnection(uid, tok);
    await audit(uid, "connector.notion.connected", String(tok.workspace_name || "").slice(0, 120));
  } catch (e) {
    console.warn("notion connect save failed:", e.message);
    return backToApp(res, "error", "exchange_failed");
  }
  return backToApp(res, "ok");
});

module.exports = { appRouter, publicRouter, revokeStored };
