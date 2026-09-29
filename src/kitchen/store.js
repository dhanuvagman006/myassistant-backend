/**
 * KITCHEN — PERSISTENCE: the pantry, saved recipes and the week plan.
 * The shopping list is NOT here: it is the general list in src/shopping,
 * and kitchen code adds ingredients through its store (source "recipe" or
 * "plan"), so they merge with everything else the user wants to buy.
 *
 *   kitchen_pantry   one row per thing: have | out, remembered from their
 *                    answers ("I have everything except curd and mint")
 *   kitchen_recipes  saved recipes as the app generated them (<= 64 KB of
 *                    JSON), a 1-5 rating, notes, how often cooked
 *   kitchen_plans    one week plan per user
 *
 * Every query is scoped by user_id: another user's id is "not found".
 * Tables are created lazily with a cached migrate(), like shortcuts/store.js.
 */
const { query, one, run, tx } = require("../db");
const N = require("../shopping/normalize");
const shopping = require("../shopping/store");

const LIMITS = Object.freeze({
  recipes: 200, recipeBytes: 64 * 1024, pantry: 500, name: 80, title: 120, notes: 2000,
  planDays: 7, mealsPerDay: 8, ingredients: 150, steps: 100,
});
const SLOTS = ["breakfast", "lunch", "dinner", "snack"];
const STATUSES = ["have", "out"];
// What most Indian kitchens keep; a pantry answer overrides any of these.
const DEFAULT_STAPLES = [
  "Salt", "Sugar", "Oil", "Turmeric", "Chilli powder", "Coriander powder",
  "Cumin seeds", "Mustard seeds", "Garam masala", "Asafoetida",
];
const LOCK_NS = 7402;

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS kitchen_pantry (
        user_id     INTEGER NOT NULL,
        name_key    TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        status      TEXT    NOT NULL,
        updated_at  BIGINT  NOT NULL,
        PRIMARY KEY (user_id, name_key)
      );

      CREATE TABLE IF NOT EXISTS kitchen_recipes (
        id              BIGSERIAL PRIMARY KEY,
        user_id         INTEGER NOT NULL,
        title           TEXT    NOT NULL,
        title_key       TEXT    NOT NULL,
        recipe          JSONB   NOT NULL,
        rating          SMALLINT,
        notes           TEXT    NOT NULL DEFAULT '',
        cooked_count    INTEGER NOT NULL DEFAULT 0,
        last_cooked_at  BIGINT,
        created_at      BIGINT  NOT NULL,
        updated_at      BIGINT  NOT NULL
      );
      CREATE INDEX IF NOT EXISTS kitchen_recipes_user ON kitchen_recipes (user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS kitchen_recipes_title ON kitchen_recipes (user_id, title_key);

      CREATE TABLE IF NOT EXISTS kitchen_plans (
        user_id     INTEGER PRIMARY KEY,
        week_start  TEXT    NOT NULL,
        days        JSONB   NOT NULL,
        created_at  BIGINT  NOT NULL,
        updated_at  BIGINT  NOT NULL
      );
    `).catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

class KitchenError extends Error {
  constructor(code, message, data = {}) {
    super(message || code);
    this.code = code;
    this.data = data;
  }
}
const fail = (code, message, data) => {
  throw new KitchenError(code, message, data);
};

function uidOf(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) fail("no_account", "A signed-in user is required");
  return id;
}

/* ------------------------------------------------------------------ */
/* PANTRY                                                               */
/* ------------------------------------------------------------------ */

function cleanNames(list, field) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) fail(`bad_${field}`, `${field} must be a list of names`);
  if (list.length > 100) fail(`too_many_${field}`, `At most 100 names in ${field} at a time`);
  return list.map((raw) => {
    if (typeof raw !== "string") fail(`bad_${field}`, `${field} must be a list of names`);
    const name = N.cleanName(raw);
    if (!name) fail(`bad_${field}`, `Names in ${field} can't be empty`);
    if (name.length > LIMITS.name) fail("name_too_long", `A name can be at most ${LIMITS.name} characters`);
    return { name, key: N.nameKey(name) };
  });
}

async function getPantry(userId) {
  const uid = uidOf(userId);
  await migrate();
  const rows = await query(
    "SELECT name, status, updated_at FROM kitchen_pantry WHERE user_id = $1 ORDER BY lower(name)", [uid]);
  return rows.map((r) => ({ name: r.name, status: r.status, updatedAt: Number(r.updated_at) }));
}

/** Remembers what they have and what ran out (merge, not replace). */
async function setPantry(userId, { have, out } = {}) {
  const uid = uidOf(userId);
  const h = cleanNames(have, "have");
  const o = cleanNames(out, "out");
  if (!h.length && !o.length) fail("nothing_to_change", "Send have: [names] and/or out: [names]");
  const outKeys = new Set(o.map((x) => x.key));
  const both = h.filter((x) => outKeys.has(x.key));
  if (both.length) fail("both", `${both[0].name} can't be in both have and out`);
  await migrate();
  await tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock($1, $2)", [LOCK_NS, uid]);
    const all = [...h.map((x) => ({ ...x, status: "have" })), ...o.map((x) => ({ ...x, status: "out" }))];
    const known = new Set((await c.query(
      "SELECT name_key FROM kitchen_pantry WHERE user_id = $1", [uid])).rows.map((r) => r.name_key));
    const fresh = new Set(all.filter((x) => !known.has(x.key)).map((x) => x.key));
    if (known.size + fresh.size > LIMITS.pantry) {
      fail("pantry_full", `The pantry can remember at most ${LIMITS.pantry} things`);
    }
    const now = Date.now();
    for (const x of all) {
      await c.query(
        `INSERT INTO kitchen_pantry (user_id, name_key, name, status, updated_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, name_key) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status,
                updated_at = EXCLUDED.updated_at`,
        [uid, x.key, x.name, x.status, now]
      );
    }
  });
  return getPantry(uid);
}

/** What they keep: the defaults and what they said they have, minus what ran out. */
function staplesFrom(pantry) {
  const out = new Set(pantry.filter((p) => p.status === "out").map((p) => N.nameKey(p.name)));
  const seen = new Set();
  const list = [];
  for (const name of [...DEFAULT_STAPLES, ...pantry.filter((p) => p.status === "have").map((p) => p.name)]) {
    const key = N.nameKey(name);
    if (out.has(key) || seen.has(key)) continue;
    seen.add(key);
    list.push(name);
  }
  return list;
}

/* ------------------------------------------------------------------ */
/* RECIPES                                                              */
/* ------------------------------------------------------------------ */

/**
 * The app's Recipe JSON, stored as given: checked for size (<= 64 KB) and
 * loosely for shape (a title, ingredients with names, steps).
 */
function checkRecipe(recipe) {
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) fail("bad_recipe", "recipe must be a Recipe object");
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(recipe));
  } catch (_) {
    fail("bad_recipe", "recipe must be plain JSON");
  }
  if (bytes > LIMITS.recipeBytes) fail("recipe_too_large", `A recipe can be at most ${LIMITS.recipeBytes / 1024} KB`);
  const title = N.cleanText(recipe.title);
  if (!title) fail("bad_recipe", "recipe.title is required");
  if (title.length > LIMITS.title) fail("bad_recipe", `recipe.title can be at most ${LIMITS.title} characters`);
  if (!Array.isArray(recipe.ingredients)) fail("bad_recipe", "recipe.ingredients must be a list");
  if (recipe.ingredients.length > LIMITS.ingredients) fail("bad_recipe", `At most ${LIMITS.ingredients} ingredients`);
  recipe.ingredients.forEach((ing, i) => {
    if (!ing || typeof ing !== "object" || typeof ing.name !== "string" || !ing.name.trim()) {
      fail("bad_recipe", `recipe.ingredients[${i}] needs a name`);
    }
  });
  if (!Array.isArray(recipe.steps)) fail("bad_recipe", "recipe.steps must be a list");
  if (recipe.steps.length > LIMITS.steps) fail("bad_recipe", `At most ${LIMITS.steps} steps`);
  recipe.steps.forEach((st, i) => {
    const ok = typeof st === "string" ? st.trim() : st && typeof st === "object" && typeof st.text === "string";
    if (!ok) fail("bad_recipe", `recipe.steps[${i}] needs text`);
  });
  if (recipe.servings !== undefined && recipe.servings !== null &&
      !(typeof recipe.servings === "number" && recipe.servings > 0 && recipe.servings <= 100)) {
    fail("bad_recipe", "recipe.servings must be a number from 1 to 100");
  }
  return title;
}

function checkRating(rating) {
  if (rating === null) return null;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail("bad_rating", "rating must be a whole number from 1 to 5");
  return rating;
}

function checkNotes(notes) {
  if (notes === null || notes === undefined) return "";
  if (typeof notes !== "string") fail("bad_notes", "notes must be text");
  const s = String(notes).replace(/\r\n/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim();
  if (s.length > LIMITS.notes) fail("notes_too_long", `notes can be at most ${LIMITS.notes} characters`);
  return s;
}

function recipeOf(r) {
  return {
    id: Number(r.id),
    title: r.title,
    recipe: r.recipe,
    rating: r.rating === null ? null : Number(r.rating),
    notes: r.notes || "",
    cookedCount: Number(r.cooked_count),
    lastCookedAt: r.last_cooked_at === null ? null : Number(r.last_cooked_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

async function listRecipes(userId, { q = "" } = {}) {
  const uid = uidOf(userId);
  await migrate();
  const term = N.cleanText(q).slice(0, 80);
  const rows = term
    ? await query(
      `SELECT * FROM kitchen_recipes WHERE user_id = $1 AND title ILIKE $2 ORDER BY updated_at DESC`,
      [uid, `%${term.replace(/[\\%_]/g, (m) => "\\" + m)}%`])
    : await query("SELECT * FROM kitchen_recipes WHERE user_id = $1 ORDER BY updated_at DESC", [uid]);
  return rows.map(recipeOf);
}

async function getRecipe(userId, id) {
  const uid = uidOf(userId);
  await migrate();
  const r = await one("SELECT * FROM kitchen_recipes WHERE user_id = $1 AND id = $2", [uid, id]);
  return r ? recipeOf(r) : null;
}

/**
 * Saves a recipe. The same title again updates that saved recipe (its
 * rating and history stay) instead of making a second copy.
 */
async function saveRecipe(userId, recipe, { notes } = {}) {
  const uid = uidOf(userId);
  const title = checkRecipe(recipe);
  const n = notes === undefined ? undefined : checkNotes(notes);
  const key = N.words(title).join(" ");
  await migrate();
  return tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock($1, $2)", [LOCK_NS, uid]);
    const now = Date.now();
    const same = (await c.query(
      "SELECT id FROM kitchen_recipes WHERE user_id = $1 AND title_key = $2 ORDER BY id LIMIT 1", [uid, key])).rows[0];
    if (same) {
      const r = (await c.query(
        `UPDATE kitchen_recipes SET title = $3, recipe = $4, notes = COALESCE($5, notes), updated_at = $6
          WHERE user_id = $1 AND id = $2 RETURNING *`,
        [uid, same.id, title, JSON.stringify(recipe), n === undefined ? null : n, now])).rows[0];
      return recipeOf(r);
    }
    const count = Number((await c.query("SELECT count(*)::int AS n FROM kitchen_recipes WHERE user_id = $1", [uid])).rows[0].n);
    if (count >= LIMITS.recipes) {
      fail("recipes_full", `You can save at most ${LIMITS.recipes} recipes. Delete one first`, { limit: LIMITS.recipes });
    }
    const r = (await c.query(
      `INSERT INTO kitchen_recipes (user_id, title, title_key, recipe, notes, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
      [uid, title, key, JSON.stringify(recipe), n || "", now])).rows[0];
    return recipeOf(r);
  });
}

/** PATCH: notes (replace), rating (1-5 or null), recipe (replace). null if not theirs. */
async function updateRecipe(userId, id, patch = {}) {
  const uid = uidOf(userId);
  const sets = [];
  const vals = [uid, id];
  const set = (col, v) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if ("notes" in patch) set("notes", checkNotes(patch.notes));
  if ("rating" in patch) set("rating", checkRating(patch.rating));
  if ("recipe" in patch) {
    const title = checkRecipe(patch.recipe);
    set("recipe", JSON.stringify(patch.recipe));
    set("title", title);
    set("title_key", N.words(title).join(" "));
  }
  if (!sets.length) fail("nothing_to_change", "Send at least one of: notes, rating, recipe");
  set("updated_at", Date.now());
  await migrate();
  const r = await one(
    `UPDATE kitchen_recipes SET ${sets.join(", ")} WHERE user_id = $1 AND id = $2 RETURNING *`, vals);
  return r ? recipeOf(r) : null;
}

async function deleteRecipe(userId, id) {
  const uid = uidOf(userId);
  await migrate();
  return (await run("DELETE FROM kitchen_recipes WHERE user_id = $1 AND id = $2", [uid, id])) > 0;
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * "Cooked it": one more time cooked, the rating if given, and the note
 * added as a dated line ("2026-09-29: less chilli next time") so the next
 * time reads the history. The newest lines win when notes get long.
 */
async function cooked(userId, id, { rating, notes } = {}) {
  const uid = uidOf(userId);
  const r1 = rating === undefined ? undefined : checkRating(rating);
  const note = notes === undefined ? "" : checkNotes(notes);
  await migrate();
  return tx(async (c) => {
    const cur = (await c.query(
      "SELECT * FROM kitchen_recipes WHERE user_id = $1 AND id = $2 FOR UPDATE", [uid, id])).rows[0];
    if (!cur) return null;
    const now = Date.now();
    let all = cur.notes || "";
    if (note) {
      all = all ? `${all}\n${dayOf(now)}: ${note}` : `${dayOf(now)}: ${note}`;
      while (all.length > LIMITS.notes && all.includes("\n")) all = all.slice(all.indexOf("\n") + 1);
      if (all.length > LIMITS.notes) all = all.slice(-LIMITS.notes);
    }
    const r = (await c.query(
      `UPDATE kitchen_recipes SET cooked_count = cooked_count + 1, last_cooked_at = $3,
              rating = $4, notes = $5, updated_at = $3
        WHERE user_id = $1 AND id = $2 RETURNING *`,
      [uid, id, now, r1 === undefined ? cur.rating : r1, all])).rows[0];
    return recipeOf(r);
  });
}

/* ------------------------------------------------------------------ */
/* WEEK PLAN                                                            */
/* ------------------------------------------------------------------ */

function isDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function planOf(r) {
  return r ? {
    weekStart: r.week_start,
    days: r.days,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  } : null;
}

async function getPlan(userId) {
  const uid = uidOf(userId);
  await migrate();
  return planOf(await one("SELECT * FROM kitchen_plans WHERE user_id = $1", [uid]));
}

/** Checks a plan body; returns the normalised days. */
function checkPlan(body) {
  const b = body && typeof body === "object" ? body : {};
  if (!isDate(b.weekStart)) fail("bad_week_start", "weekStart must be a date like 2026-09-28");
  if (!Array.isArray(b.days) || !b.days.length || b.days.length > LIMITS.planDays) {
    fail("bad_days", `days must be a list of 1 to ${LIMITS.planDays} days`);
  }
  const seen = new Set();
  const recipeIds = new Set();
  const days = b.days.map((d, i) => {
    if (!d || typeof d !== "object" || !isDate(d.date)) fail("bad_days", `days[${i}].date must be a date like 2026-09-28`);
    if (seen.has(d.date)) fail("bad_days", `${d.date} is in the plan twice`);
    seen.add(d.date);
    const meals = d.meals === undefined ? [] : d.meals;
    if (!Array.isArray(meals) || meals.length > LIMITS.mealsPerDay) {
      fail("bad_meals", `days[${i}].meals must be a list of at most ${LIMITS.mealsPerDay} meals`);
    }
    return {
      date: d.date,
      meals: meals.map((m, j) => {
        const at = `days[${i}].meals[${j}]`;
        if (!m || typeof m !== "object") fail("bad_meals", `${at} must be a meal`);
        if (!SLOTS.includes(m.slot)) fail("bad_meals", `${at}.slot must be one of: ${SLOTS.join(", ")}`);
        const title = N.cleanText(m.title);
        if (!title || title.length > LIMITS.title) fail("bad_meals", `${at}.title must be 1 to ${LIMITS.title} characters`);
        let recipeId = null;
        if (m.recipeId !== undefined && m.recipeId !== null) {
          if (!Number.isSafeInteger(m.recipeId) || m.recipeId <= 0) fail("bad_meals", `${at}.recipeId must be a saved recipe's id`);
          recipeId = m.recipeId;
          recipeIds.add(recipeId);
        }
        return { slot: m.slot, title, recipeId };
      }),
    };
  });
  days.sort((a, b2) => a.date.localeCompare(b2.date));
  return { weekStart: b.weekStart, days, recipeIds: [...recipeIds] };
}

/** Replaces the user's week plan. A recipeId must be one of THEIR recipes. */
async function putPlan(userId, body) {
  const uid = uidOf(userId);
  const { weekStart, days, recipeIds } = checkPlan(body);
  await migrate();
  if (recipeIds.length) {
    const mine = new Set((await query(
      "SELECT id FROM kitchen_recipes WHERE user_id = $1 AND id = ANY($2::bigint[])", [uid, recipeIds]))
      .map((r) => Number(r.id)));
    const missing = recipeIds.filter((id) => !mine.has(id));
    if (missing.length) fail("unknown_recipe", "A meal points at a recipe that is not in your saved recipes", { recipeIds: missing });
  }
  const now = Date.now();
  const r = await one(
    `INSERT INTO kitchen_plans (user_id, week_start, days, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)
     ON CONFLICT (user_id) DO UPDATE SET week_start = EXCLUDED.week_start, days = EXCLUDED.days,
            updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [uid, weekStart, JSON.stringify(days), now]);
  return planOf(r);
}

/* ------------------------------------------------------------------ */
/* INGREDIENTS -> THE SHOPPING LIST                                     */
/* ------------------------------------------------------------------ */

/**
 * Puts ingredients on the user's shopping list through src/shopping, so
 * they merge with whatever else is there. Staples they keep and things
 * the pantry says they have are left off (reported as skipped), unless
 * the pantry says they ran out. `scale` multiplies quantities (servings).
 */
async function addIngredients(userId, ingredients, { source = "recipe", recipe = null, scale = 1, skip = [] } = {}) {
  const uid = uidOf(userId);
  const pantry = await getPantry(uid);
  const status = new Map(pantry.map((p) => [N.nameKey(p.name), p.status]));
  const staples = new Set(staplesFrom(pantry).map((s) => N.nameKey(s)));
  const skipKeys = new Set((skip || []).map((s) => N.nameKey(s)));
  const lines = [];
  const skipped = [];
  for (const ing of ingredients || []) {
    if (!ing || typeof ing !== "object" || !String(ing.name || "").trim()) continue;
    const key = N.nameKey(ing.name);
    const st = status.get(key);
    const keeps = st === "have" || (st !== "out" && (ing.staple === true || staples.has(key)));
    if (skipKeys.has(key) || keeps) {
      skipped.push(N.cleanName(ing.name));
      continue;
    }
    const q = N.parseQuantity(ing.quantity);
    lines.push(shopping.cleanItem({
      name: ing.name,
      quantity: q ? Math.round(q * scale * 100) / 100 : null,
      unit: ing.unit,
      category: N.normalizeCategory(ing.category) || undefined,
      recipe,
    }, { strict: false }));
  }
  if (!lines.length) return { added: [], merged: [], items: await shopping.list(uid), skipped };
  // A week's plan can be more than one request's worth: add it in parts.
  const added = [];
  const merged = [];
  let items = [];
  for (let i = 0; i < lines.length; i += shopping.LIMITS.perRequest) {
    const out = await shopping.addItems(uid, lines.slice(i, i + shopping.LIMITS.perRequest), { source });
    added.push(...out.added);
    for (const m of out.merged) if (!added.some((a) => a.id === m.id) && !merged.some((x) => x.id === m.id)) merged.push(m);
    items = out.items;
  }
  const latest = new Map(items.map((i) => [i.id, i]));
  return {
    added: added.map((a) => latest.get(a.id) || a),
    merged: merged.map((m) => latest.get(m.id) || m),
    items,
    skipped,
  };
}

module.exports = {
  migrate, LIMITS, SLOTS, STATUSES, DEFAULT_STAPLES, KitchenError,
  getPantry, setPantry, staplesFrom,
  checkRecipe, listRecipes, getRecipe, saveRecipe, updateRecipe, deleteRecipe, cooked,
  getPlan, putPlan, checkPlan, isDate,
  addIngredients,
};
