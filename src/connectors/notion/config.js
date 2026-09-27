/**
 * NOTION — configuration. The whole connector is inert until the owner
 * sets NOTION_CLIENT_ID and NOTION_CLIENT_SECRET (a Notion "public
 * connection"), and a redirect URI can be formed.
 */
const API_BASE = "https://api.notion.com/v1";
const APP_SCHEME = "com.myassistant.myassistant";
const STATE_TTL_MS = 600_000;

function NOTION_VERSION() {
  return process.env.NOTION_API_VERSION || "2026-03-11";
}

const env = (k) => String(process.env[k] || "").trim();

function redirectUri() {
  if (env("NOTION_REDIRECT_URI")) return env("NOTION_REDIRECT_URI");
  const base = env("PUBLIC_BASE_URL").replace(/\/+$/, "");
  return base ? `${base}/connect/notion/callback` : "";
}

function enabled() {
  return Boolean(env("NOTION_CLIENT_ID") && env("NOTION_CLIENT_SECRET") && redirectUri());
}

module.exports = { API_BASE, APP_SCHEME, STATE_TTL_MS, NOTION_VERSION, redirectUri, enabled, env };
