/**
 * CONNECTED APPS — the My Assistant API (2026-10-14).
 *
 * The owner: "the user can access their assistant even from different
 * apps — the memory is the same, the exact same assistant gets extra
 * power … if he builds a custom app he can allow his assistant to do the
 * work there using the unique API key … the connected app should appear
 * in the main app, and if he asks for any details from it, the main app
 * should be able to fetch it and respond."
 *
 * Wiring (server.js / builtins.js / privacy.js) needs only what is here:
 *
 *   app.use("/v1", platform.v1);                          // key-authenticated API
 *   app.use("/platform", appAuth, platform.manage);       // the main app manages apps
 *   app.get("/developers", platform.docs);                // the developer docs
 *   platform.registerPlatformTools(registry);              // in registerBuiltins()
 *   ...platform.USER_TABLES                                // privacy export / erase
 *
 *   store.js      tables, keys (hashed), records, events, conversations, usage
 *   auth.js       the key gate, scopes, the per-key limiter
 *   assistant.js  a turn of the user's assistant with the app's tools
 *   voice.js      realtime voice sessions, tool relay, transcripts
 *   routes.js     /v1          manage.js   /platform
 *   tools.js      connected_apps — the main assistant reads the apps' activity
 */
const fs = require("fs");
const path = require("path");
const express = require("express");
const { platformAuth, limiter } = require("./auth");
const store = require("./store");
const tools = require("./tools");

const v1 = express.Router();
v1.use(platformAuth, limiter, require("./routes"));

let page = null;
function docs(req, res) {
  if (!page) page = fs.readFileSync(path.join(__dirname, "docs.html"), "utf8");
  const base = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  // Inline style and script are the page's own; nothing else may load.
  res.setHeader("Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.send(page.split("{{API}}").join(`${base}/v1`));
}

module.exports = {
  v1,
  manage: require("./manage"),
  docs,
  registerPlatformTools: tools.registerPlatformTools,
  wantsApps: tools.wantsApps,
  hasApps: tools.hasApps,
  migrate: store.migrate,
  USER_TABLES: store.USER_TABLES,
};
