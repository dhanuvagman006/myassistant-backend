/**
 * NOTION — OAuth for a public connection. The code is exchanged here, on
 * the server: neither the code nor the client secret reaches the phone.
 * Tokens never appear in an error message.
 */
const config = require("./config");

class OAuthError extends Error {
  constructor(code) {
    super(`notion oauth: ${code}`);
    this.code = code;
  }
}

function basic() {
  const id = config.env("NOTION_CLIENT_ID");
  const secret = config.env("NOTION_CLIENT_SECRET");
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

function authorizeUrl(state) {
  const u = new URL(`${config.API_BASE}/oauth/authorize`);
  u.searchParams.set("client_id", config.env("NOTION_CLIENT_ID"));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("owner", "user");
  u.searchParams.set("redirect_uri", config.redirectUri());
  u.searchParams.set("state", state);
  return u.toString();
}

async function post(path, body) {
  let res;
  try {
    res = await fetch(`${config.API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: basic(),
        "Content-Type": "application/json",
        "Notion-Version": config.NOTION_VERSION(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (_) {
    throw new OAuthError("unavailable");
  }
  let json = {};
  try { json = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok) {
    const code = String((json && json.error) || `http_${res.status}`).replace(/[^\w.-]/g, "").slice(0, 40);
    throw new OAuthError(code || "error");
  }
  return json;
}

function exchangeCode(code) {
  return post("/oauth/token", {
    grant_type: "authorization_code", code: String(code), redirect_uri: config.redirectUri(),
  });
}

function refresh(refreshToken) {
  return post("/oauth/token", { grant_type: "refresh_token", refresh_token: String(refreshToken) });
}

/** Best effort: true when Notion accepted it. */
async function revoke(token) {
  if (!token) return false;
  try {
    await post("/oauth/revoke", { token: String(token) });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { authorizeUrl, exchangeCode, refresh, revoke, OAuthError };
