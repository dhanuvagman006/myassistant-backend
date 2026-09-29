/**
 * KITCHEN ROUTES (behind appAuth and the per-user limiter in ./index.js).
 * Everything is scoped by req.user.sub: another user's id is a 404.
 * Errors are { ok:false, error:<code>, message:<sentence> }. The shopping
 * list itself lives at /shopping (src/shopping/routes.js).
 *
 *   GET    /kitchen/pantry               -> { items:[{ name, status:"have"|"out", updatedAt }] }
 *   PUT    /kitchen/pantry               { have?:[names], out?:[names] } -> same (merges; does not replace)
 *   GET    /kitchen/recipes              ?q=<title search> -> { recipes:[SavedRecipe] }
 *   POST   /kitchen/recipes              { recipe, notes? } -> { recipe:SavedRecipe }  (same title = update)
 *   PATCH  /kitchen/recipes/:id          { notes?, rating?:1-5|null, recipe? } -> { recipe }
 *   DELETE /kitchen/recipes/:id          -> { ok:true }
 *   POST   /kitchen/recipes/:id/cooked   { rating?, notes? } -> { recipe }
 *   POST   /kitchen/recipes/:id/shop     { servings?, skip?:[names] }
 *                                        -> { added, merged, items, skipped }  (onto the shopping list)
 *   GET    /kitchen/plan                 -> { plan | null }
 *   PUT    /kitchen/plan                 { weekStart, days:[{ date, meals:[{ slot, title, recipeId? }] }],
 *                                          shoppingItems?:[{ name, quantity?, unit?, category? }] }
 *                                        -> { plan, shopping?:{ added, merged, skipped } }
 *   GET    /kitchen/prefs                -> { diet, allergies, spice, household, cuisine, language,
 *                                             groceryApp, staples }
 */
const router = require("express").Router();
const store = require("./store");
const { kitchenPrefs } = require("./prefs");
const shopping = require("../shopping/store");

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
    fail(res, 400, "bad_id", "The recipe id must be a positive whole number");
    return null;
  }
  return id;
}

/** Body size, measured as JSON (the app's recipe JSON is capped at 64 KB). */
function tooBig(req, res, max) {
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

const bodyOf = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

function sendError(res, e) {
  if (e instanceof store.KitchenError || e instanceof shopping.ShoppingError) {
    return fail(res, 400, e.code, e.message, Object.keys(e.data || {}).length ? e.data : undefined);
  }
  console.error("kitchen route:", e);
  return fail(res, 500, "server_error", "Something went wrong on our side. Try again.");
}

const RECIPE_BODY = store.LIMITS.recipeBytes + 8 * 1024; // the recipe plus notes
const notFound = (res) => fail(res, 404, "not_found", "That recipe is not in your saved recipes");

/* ---------------- pantry ---------------- */

router.get("/pantry", async (req, res) => {
  const userId = uid(req, res);
  if (!userId) return;
  try {
    res.json({ items: await store.getPantry(userId) });
  } catch (e) {
    sendError(res, e);
  }
});

router.put("/pantry", async (req, res) => {
  const userId = uid(req, res);
  if (!userId || tooBig(req, res, 32 * 1024)) return;
  const b = bodyOf(req);
  try {
    res.json({ items: await store.setPantry(userId, { have: b.have, out: b.out }) });
  } catch (e) {
    sendError(res, e);
  }
});

/* ---------------- recipes ---------------- */

router.get("/recipes", async (req, res) => {
  const userId = uid(req, res);
  if (!userId) return;
  try {
    res.json({ recipes: await store.listRecipes(userId, { q: String(req.query.q || "") }) });
  } catch (e) {
    sendError(res, e);
  }
});

router.post("/recipes", async (req, res) => {
  const userId = uid(req, res);
  if (!userId || tooBig(req, res, RECIPE_BODY)) return;
  const b = bodyOf(req);
  if (b.recipe === undefined) return fail(res, 400, "bad_recipe", "Send { recipe: <Recipe JSON>, notes? }");
  try {
    res.json({ recipe: await store.saveRecipe(userId, b.recipe, { notes: b.notes }) });
  } catch (e) {
    sendError(res, e);
  }
});

router.patch("/recipes/:id", async (req, res) => {
  const userId = uid(req, res);
  if (!userId) return;
  const id = idParam(req, res);
  if (!id || tooBig(req, res, RECIPE_BODY)) return;
  const b = bodyOf(req);
  const patch = {};
  for (const k of ["notes", "rating", "recipe"]) if (k in b) patch[k] = b[k];
  try {
    const recipe = await store.updateRecipe(userId, id, patch);
    if (!recipe) return notFound(res);
    res.json({ recipe });
  } catch (e) {
    sendError(res, e);
  }
});

router.delete("/recipes/:id", async (req, res) => {
  const userId = uid(req, res);
  if (!userId) return;
  const id = idParam(req, res);
  if (!id) return;
  try {
    if (!(await store.deleteRecipe(userId, id))) return notFound(res);
    res.json({ ok: true });
  } catch (e) {
    sendError(res, e);
  }
});

router.post("/recipes/:id/cooked", async (req, res) => {
  const userId = uid(req, res);
  if (!userId) return;
  const id = idParam(req, res);
  if (!id || tooBig(req, res, 8 * 1024)) return;
  const b = bodyOf(req);
  try {
    const recipe = await store.cooked(userId, id, { rating: b.rating, notes: b.notes });
    if (!recipe) return notFound(res);
    // The note also goes to memory, so the next "make biryani" hears it.
    if (typeof b.notes === "string" && b.notes.trim()) {
      await require("../memory/service").remember(userId, {
        fact: `User's note after cooking ${recipe.title}: ${b.notes.trim().slice(0, 200)}`,
        kind: "preference",
        importance: 1,
        source: "kitchen",
      }).catch((err) => console.warn("kitchen: note not remembered:", err.message));
    }
    res.json({ recipe });
  } catch (e) {
    sendError(res, e);
  }
});

router.post("/recipes/:id/shop", async (req, res) => {
  const userId = uid(req, res);
  if (!userId) return;
  const id = idParam(req, res);
  if (!id || tooBig(req, res, 16 * 1024)) return;
  const b = bodyOf(req);
  if (b.servings !== undefined && b.servings !== null &&
      !(typeof b.servings === "number" && b.servings > 0 && b.servings <= 100)) {
    return fail(res, 400, "bad_servings", "servings must be a number from 1 to 100");
  }
  if (b.skip !== undefined && (!Array.isArray(b.skip) || b.skip.length > 150 || !b.skip.every((s) => typeof s === "string"))) {
    return fail(res, 400, "bad_skip", "skip must be a list of ingredient names");
  }
  try {
    const saved = await store.getRecipe(userId, id);
    if (!saved) return notFound(res);
    const base = Number(saved.recipe.servings) > 0 ? Number(saved.recipe.servings) : null;
    const scale = b.servings && base ? b.servings / base : 1;
    res.json(await store.addIngredients(userId, saved.recipe.ingredients, {
      source: "recipe", recipe: saved.title, scale, skip: b.skip || [],
    }));
  } catch (e) {
    sendError(res, e);
  }
});

/* ---------------- week plan ---------------- */

router.get("/plan", async (req, res) => {
  const userId = uid(req, res);
  if (!userId) return;
  try {
    res.json({ plan: await store.getPlan(userId) });
  } catch (e) {
    sendError(res, e);
  }
});

router.put("/plan", async (req, res) => {
  const userId = uid(req, res);
  if (!userId || tooBig(req, res, 64 * 1024)) return;
  const b = bodyOf(req);
  if (b.shoppingItems !== undefined && (!Array.isArray(b.shoppingItems) || b.shoppingItems.length > 200)) {
    return fail(res, 400, "bad_shopping_items", "shoppingItems must be a list of at most 200 ingredients");
  }
  try {
    // Checked in full before anything is written.
    store.checkPlan(b);
    if (b.shoppingItems) {
      b.shoppingItems.forEach((it, index) => shopping.cleanItem(it, { strict: true, index }));
    }
    const plan = await store.putPlan(userId, b);
    if (!b.shoppingItems || !b.shoppingItems.length) return res.json({ plan });
    const out = await store.addIngredients(userId, b.shoppingItems, {
      source: "plan", recipe: `Week of ${plan.weekStart}`,
    });
    res.json({ plan, shopping: { added: out.added, merged: out.merged, skipped: out.skipped } });
  } catch (e) {
    sendError(res, e);
  }
});

/* ---------------- preferences ---------------- */

router.get("/prefs", async (req, res) => {
  const userId = uid(req, res);
  if (!userId) return;
  try {
    res.json(await kitchenPrefs(userId));
  } catch (e) {
    sendError(res, e);
  }
});

module.exports = router;
