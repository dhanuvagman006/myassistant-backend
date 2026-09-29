/**
 * SHOPPING LIST ROUTES (behind appAuth and the per-user limiter in
 * ./index.js). Everything is scoped by req.user.sub: another user's id is
 * a 404. Errors are { ok:false, error:<code>, message:<sentence> }.
 *
 *   GET    /shopping                  -> { items:[ShoppingItem], updatedAt, categories:[{id,label}] }
 *   POST   /shopping/items            { items:[{ name, quantity?, unit?, details?, link?, store?,
 *                                        note?, category?, recipe? }], source? }
 *                                     -> { added:[ShoppingItem], merged:[ShoppingItem], items:[ShoppingItem] }
 *   PATCH  /shopping/items/:id        { checked?, quantity?, unit?, name?, details?, link?, store?,
 *                                        note?, category? } -> { item }
 *   DELETE /shopping/items/:id        -> { ok:true }
 *   POST   /shopping/clear            { checkedOnly: true|false } -> { removed }
 *   GET    /shopping/share-text       ?category=<id> -> { text }
 *   POST   /shopping/handoff          { ids?:[id], app?, groceryApp? }
 *                                     -> { handoff:{type:"shop_handoff",groups}|null, summary,
 *                                          needsGroceryApp:[names], groceryApps:[labels], rememberedGroceryApp }
 */
const router = require("express").Router();
const store = require("./store");
const N = require("./normalize");
const { shareText } = require("./share");
const links = require("./links");
const { buildHandoff } = require("./handoff");

const MAX_BODY = 64 * 1024;

const fail = (res, status, error, message, data) =>
  res.status(status).json({ ok: false, error, message, ...(data ? { data } : {}) });

function uid(req, res) {
  const id = Number(req.user?.sub);
  if (!Number.isInteger(id) || id <= 0) {
    fail(res, 400, "no_account", "A signed-in account is required");
    return null;
  }
  return id;
}

function idParam(req, res) {
  const s = String(req.params.id || "");
  const id = /^\d{1,15}$/.test(s) ? Number(s) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    fail(res, 400, "bad_id", "The item id must be a positive whole number");
    return null;
  }
  return id;
}

function tooBig(req, res, max = MAX_BODY) {
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(req.body ?? {}));
  } catch (_) {
    size = Infinity;
  }
  if (size > max) {
    fail(res, 400, "too_large", `The request is too large (at most ${Math.round(max / 1024)} KB)`);
    return true;
  }
  return false;
}

function sendError(res, e) {
  if (e instanceof store.ShoppingError) return fail(res, 400, e.code, e.message, e.data);
  if (e && (e.code === "money_app" || e.code === "unknown_app")) return fail(res, 400, e.code, e.message);
  console.error("shopping route:", e);
  return fail(res, 500, "server_error", "Something went wrong on our side. Try again.");
}

const categories = () => N.CATEGORIES.map(({ id, label }) => ({ id, label }));

router.get("/", async (req, res) => {
  const userId = uid(req, res);
  if (!userId) return;
  try {
    const items = await store.list(userId);
    res.json({ items, updatedAt: store.updatedAtOf(items), categories: categories() });
  } catch (e) {
    sendError(res, e);
  }
});

router.post("/items", async (req, res) => {
  const userId = uid(req, res);
  if (!userId || tooBig(req, res)) return;
  const body = req.body || {};
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return fail(res, 400, "no_items", "Send items: [{ name, quantity?, unit?, … }] with at least one item");
  }
  if (body.items.length > store.LIMITS.perRequest) {
    return fail(res, 400, "too_many_items", `At most ${store.LIMITS.perRequest} items at a time`);
  }
  const source = body.source === undefined || body.source === null ? "manual" : body.source;
  if (!store.SOURCES.includes(source)) {
    return fail(res, 400, "bad_source", `source must be one of: ${store.SOURCES.join(", ")}`);
  }
  try {
    const clean = body.items.map((raw, index) => store.cleanItem(raw, { strict: true, index }));
    res.json(await store.addItems(userId, clean, { source }));
  } catch (e) {
    sendError(res, e);
  }
});

/** Checks a PATCH body; returns { patch } or { error, message }. */
function cleanPatch(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const patch = {};
  const err = (error, message) => ({ error, message });
  if ("checked" in b) {
    if (typeof b.checked !== "boolean") return err("bad_checked", "checked must be true or false");
    patch.checked = b.checked;
  }
  if ("quantity" in b) {
    const q = N.parseQuantity(b.quantity);
    if (q === undefined) return err("bad_quantity", `quantity must be a number above 0 and at most ${N.MAX_QTY}, or null`);
    patch.quantity = q;
  }
  if ("unit" in b) {
    const u = N.normalizeUnit(b.unit);
    if (u === undefined) return err("bad_unit", `unit must be a word of at most ${N.MAX_UNIT} letters, like g, kg, ml, l, pcs or packet`);
    patch.unit = u;
  }
  if ("name" in b) {
    const name = N.cleanName(b.name);
    if (!name) return err("name_required", "name can't be empty");
    if (name.length > store.LIMITS.name) return err("name_too_long", `A name can be at most ${store.LIMITS.name} characters`);
    patch.name = name;
  }
  for (const [key, max] of [["details", store.LIMITS.details], ["note", store.LIMITS.note]]) {
    if (key in b) {
      if (b[key] !== null && typeof b[key] !== "string") return err(`bad_${key}`, `${key} must be text`);
      const v = N.cleanText(b[key]);
      if (v.length > max) return err(`${key}_too_long`, `${key} can be at most ${max} characters`);
      patch[key] = v;
    }
  }
  if ("store" in b) {
    if (b.store !== null && typeof b.store !== "string") return err("bad_store", "store must be text");
    const v = N.cleanText(b.store);
    if (v.length > store.LIMITS.store) return err("store_too_long", `store can be at most ${store.LIMITS.store} characters`);
    patch.store = v || null;
  }
  if ("link" in b) {
    if (b.link === null || String(b.link).trim() === "") patch.link = null;
    else {
      const link = store.cleanLink(b.link);
      if (!link) return err("bad_link", `link must be an https:// address of at most ${store.LIMITS.link} characters`);
      patch.link = link;
    }
  }
  if ("category" in b) {
    const c = N.normalizeCategory(b.category);
    if (!c) return err("bad_category", `category must be one of: ${N.CATEGORY_IDS.join(", ")}`);
    patch.category = c;
  }
  if (!Object.keys(patch).length) {
    return err("nothing_to_change", "Send at least one of: checked, quantity, unit, name, details, link, store, note, category");
  }
  return { patch };
}

router.patch("/items/:id", async (req, res) => {
  const userId = uid(req, res);
  if (!userId) return;
  const id = idParam(req, res);
  if (!id || tooBig(req, res, 8 * 1024)) return;
  const { patch, error, message } = cleanPatch(req.body);
  if (error) return fail(res, 400, error, message);
  try {
    const item = await store.update(userId, id, patch);
    if (!item) return fail(res, 404, "not_found", "That item is not on your list");
    res.json({ item });
  } catch (e) {
    sendError(res, e);
  }
});

router.delete("/items/:id", async (req, res) => {
  const userId = uid(req, res);
  if (!userId) return;
  const id = idParam(req, res);
  if (!id) return;
  try {
    if (!(await store.remove(userId, id))) return fail(res, 404, "not_found", "That item is not on your list");
    res.json({ ok: true });
  } catch (e) {
    sendError(res, e);
  }
});

router.post("/clear", async (req, res) => {
  const userId = uid(req, res);
  if (!userId) return;
  const checkedOnly = req.body && req.body.checkedOnly;
  // No default on purpose: a missing flag must never empty the whole list.
  if (typeof checkedOnly !== "boolean") {
    return fail(res, 400, "bad_checked_only", "Send checkedOnly: true to clear the bought items, or false to clear everything");
  }
  try {
    res.json({ removed: await store.clear(userId, { checkedOnly }) });
  } catch (e) {
    sendError(res, e);
  }
});

router.get("/share-text", async (req, res) => {
  const userId = uid(req, res);
  if (!userId) return;
  let category = null;
  if (req.query.category !== undefined && String(req.query.category) !== "") {
    category = N.normalizeCategory(req.query.category);
    if (!category) return fail(res, 400, "bad_category", `category must be one of: ${N.CATEGORY_IDS.join(", ")}`);
  }
  try {
    res.json({ text: shareText(await store.list(userId), { category }) });
  } catch (e) {
    sendError(res, e);
  }
});

router.post("/handoff", async (req, res) => {
  const userId = uid(req, res);
  if (!userId || tooBig(req, res, 16 * 1024)) return;
  const b = req.body || {};
  let ids = null;
  if (b.ids !== undefined && b.ids !== null) {
    if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > store.LIMITS.items ||
        !b.ids.every((x) => Number.isSafeInteger(x) && x > 0)) {
      return fail(res, 400, "bad_ids", "ids must be a list of item ids");
    }
    ids = [...new Set(b.ids)];
  }
  for (const f of ["app", "groceryApp"]) {
    if (b[f] !== undefined && b[f] !== null && (typeof b[f] !== "string" || b[f].length > 60)) {
      return fail(res, 400, `bad_${f}`, `${f} must be an app name`);
    }
  }
  try {
    const all = await store.list(userId);
    let lines;
    if (ids) {
      const byId = new Map(all.map((i) => [i.id, i]));
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length) return fail(res, 404, "not_found", "Some of those items are not on your list", { ids: missing });
      lines = ids.map((id) => byId.get(id));
    } else lines = all.filter((i) => !i.checked);
    if (!lines.length) return fail(res, 400, "nothing_to_buy", "There is nothing left to buy on the list");
    const h = await buildHandoff(userId, lines, { app: b.app || null, groceryApp: b.groceryApp || null });
    res.json({
      handoff: h.action,
      summary: h.summary,
      needsGroceryApp: h.needsGroceryApp,
      groceryApps: links.groceryLabels(),
      rememberedGroceryApp: h.rememberedGroceryApp,
    });
  } catch (e) {
    sendError(res, e);
  }
});

module.exports = router;
module.exports.cleanPatch = cleanPatch;
