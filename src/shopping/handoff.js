/**
 * THE HAND-OFF — the lines to buy, grouped by the app that fits each one,
 * with that app's search link per line. Shared by the shop_from_list tool
 * and POST /shopping/handoff so both open exactly the same thing.
 *
 *   { type: "shop_handoff",
 *     groups: [{ app, label, pkg, items: [{ id, name, details?, quantity,
 *                unit, amountText, url }] }] }
 *
 * The app opens the first line's url (in `pkg` when installed, else the
 * browser) and offers the next ones one at a time. The user picks and pays
 * in their own app; nothing is ordered or paid from here.
 */
const links = require("./links");
const { shoppingPrefs, rememberGroceryApp } = require("./prefs");

/**
 * @returns {{ action, summary, groups, needsGroceryApp, rememberedGroceryApp }}
 *   action is null while a grocery line has no app (ask once, then call
 *   again with groceryApp). Throws {code:"money_app"|"unknown_app"}.
 */
async function buildHandoff(userId, lines, { app = null, groceryApp = null, remember = true } = {}) {
  const prefs = await shoppingPrefs(userId);
  const p = links.plan(lines, { app, groceryApp, prefs });
  let rememberedGroceryApp = null;

  // ASKED ONCE, REMEMBERED: the grocery app they just named, when none
  // was known and it was used for grocery lines.
  if (remember && !prefs.byKind.grocery && !p.needsGroceryApp.length) {
    const namedKey = groceryApp ? links.resolveApp(groceryApp)
      : app && links.APPS[links.resolveApp(app)]?.kinds.join() === "grocery" ? links.resolveApp(app) : null;
    const usedForGroceries = namedKey && p.groups.some((g) => g.app === links.forKind(namedKey, "grocery"));
    if (usedForGroceries) {
      try {
        if (await rememberGroceryApp(userId, namedKey)) rememberedGroceryApp = links.labelOf(namedKey);
      } catch (e) {
        console.warn("shopping: could not remember the grocery app:", e.message);
      }
    }
  }

  const ready = p.groups.length > 0 && p.needsGroceryApp.length === 0;
  return {
    action: ready ? { type: "shop_handoff", groups: p.groups } : null,
    summary: links.summaryOf(p.groups),
    groups: p.groups,
    needsGroceryApp: p.needsGroceryApp,
    rememberedGroceryApp,
  };
}

module.exports = { buildHandoff };
