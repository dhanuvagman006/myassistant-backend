/**
 * WHERE THE APP'S SOURCE IS, for the tests that check the two halves agree
 * (a device action the server sends must be one the app handles).
 *
 * CI checks both repos out side by side, the app as ../myassistant-flutter.
 * A feature worktree pair (be-news beside fl-news, 2026-09-25) is checked
 * against ITS OWN app half: against the main checkout, a server change
 * that needs an app change could never be green before both are merged.
 * APP_DIR overrides both.
 */
const fs = require("fs");
const path = require("path");

function appRoot() {
  if (process.env.APP_DIR) return path.resolve(process.env.APP_DIR);
  const here = path.basename(path.resolve(__dirname, ".."));
  if (/^be-/.test(here)) {
    const twin = path.resolve(__dirname, "../..", here.replace(/^be-/, "fl-"));
    if (fs.existsSync(path.join(twin, "lib"))) return twin;
  }
  return path.resolve(__dirname, "../../myassistant-flutter");
}

module.exports = { appRoot, APP_ROOT: appRoot() };
