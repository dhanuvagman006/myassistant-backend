/**
 * SHOPPING LIST + KITCHEN (src/shopping, src/kitchen).
 *
 *   (a) words: names, plurals, Indian synonyms, units, amounts, categories
 *   (b) /shopping: every route, merging (groceries by name; clothes only
 *       with the same details), limits, another user's ids (404), bad
 *       input (400), the share text, the shop hand-off
 *   (c) /kitchen: pantry (and what it learns), recipes (save, update by
 *       title, rating, notes, cooked, limits, onto the list), the week plan,
 *       preferences with safe defaults and read from memory
 *   (d) every tool through registry.execute on a FRESH registry that holds
 *       only these tools: confirmation for clearing everything and for
 *       shopping, the shop_handoff links, never a payment app, the
 *       WhatsApp share, app-build gating
 *
 * Run: DATABASE_URL=postgres://… node scripts/kitchen-test.js
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
// No embedding calls from memory writes, and no limiter in the way.
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY;
process.env.SHOPPING_RATE_PER_MIN = "100000";
process.env.KITCHEN_RATE_PER_MIN = "100000";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "warn"; // no per-tool log lines

const assert = require("assert");
const express = require("express");
const db = require("../src/db");
const N = require("../src/shopping/normalize");
const shopStore = require("../src/shopping/store");
const links = require("../src/shopping/links");
const { shareText } = require("../src/shopping/share");
const { readPrefs } = require("../src/shopping/prefs");
const shopping = require("../src/shopping");
const kitchen = require("../src/kitchen");
const kStore = require("../src/kitchen/store");
const { readKitchen } = require("../src/kitchen/prefs");

// A FRESH registry with only these tools. It must not load registerBuiltins
// (which registers them too once wired) — a second registration throws.
const registry = require("../src/tools/registry");
registry._clear();
shopping.registerShoppingTools(registry);
kitchen.registerKitchenTools(registry);

let passed = 0;
async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

const CAPS = (build) => ({ platform: "android", build, granted: [], denied: [] });
const ctxFor = (userId, extra = {}) => ({
  userId, appBuild: 124, deviceCaps: CAPS(124), platform: "android", source: "voice", tzOffsetMin: 330, ...extra,
});
const exec = (name, args, ctx) => registry.execute(name, args, ctx);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RECIPE = (over = {}) => ({
  title: "Paneer butter masala",
  cuisine: "North Indian",
  diet: "veg",
  servings: 4,
  prepMinutes: 15,
  cookMinutes: 25,
  equipment: ["kadai"],
  ingredients: [
    { name: "Paneer", quantity: 200, unit: "g", category: "dairy" },
    { name: "Tomatoes", quantity: 3, unit: "pcs" },
    { name: "Butter", quantity: 2, unit: "tbsp" },
    { name: "Salt", localName: "namak", staple: true },
    { name: "Mint", quantity: 1, unit: "bunch" },
    { name: "Fresh cream", quantity: 100, unit: "ml" },
  ],
  steps: [{ n: 1, text: "Heat butter.", minutes: 2 }, { n: 2, text: "Add tomatoes.", minutes: 10, timer: true }],
  tips: ["Soak paneer in warm water."],
  substitutions: [{ ingredient: "cream", use: "cashew paste" }],
  nutritionPerServing: { kcal: 320, proteinG: 12, carbsG: 10, fatG: 25, estimate: true },
  language: "en",
  ...over,
});

(async () => {
  await db.init();
  await shopping.migrate();
  await kitchen.migrate();
  await require("../src/routes/contacts").migrate();

  // seal() derives the safety sets from the declared effects. On a registry
  // holding only these tools it reports every seed name as a phantom, so
  // it runs quietly here.
  {
    const [e, w] = [console.error, console.warn];
    console.error = console.warn = () => {};
    try { registry.seal({ strict: false }); } finally { [console.error, console.warn] = [e, w]; }
  }

  const stamp = String(Date.now()).slice(-8);
  const users = [];
  const mkUser = async (tag) => {
    const u = await db.createUser({ email: `kitchen-${tag}-${stamp}@example.test`, name: `Kitchen ${tag}` });
    users.push(u.id);
    return u.id;
  };
  const A = await mkUser("a");
  const B = await mkUser("b");

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.user = { sub: String(req.headers["x-uid"]) };
    next();
  });
  app.use("/shopping", shopping.limiter, shopping.router);
  app.use("/kitchen", kitchen.limiter, kitchen.router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (userId, method, path, body) => {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", "x-uid": String(userId) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const bad = (r, status, code) => {
    assert.strictEqual(r.status, status, JSON.stringify(r.body));
    assert.strictEqual(r.body.ok, false);
    if (code) assert.strictEqual(r.body.error, code, JSON.stringify(r.body));
    assert.ok(r.body.message && r.body.message.length > 5, "a clear message");
  };

  /* ================================================================ */
  console.log("\nwords");

  await atest("plurals, Indian names and English names merge by key", () => {
    const same = (xs) => assert.strictEqual(new Set(xs.map(N.nameKey)).size, 1, xs.join(" / "));
    same(["onions", "Onion", "pyaz", "kanda"]);
    same(["tomatoes", "tomato", "tamatar"]);
    same(["chillies", "chilli", "chili"]);
    same(["green chillies", "hari mirch", "green chilli"]);
    same(["jeera", "cumin seeds", "Cumin"]);
    same(["dhania", "coriander leaves", "coriander"]);
    same(["haldi", "turmeric", "turmeric powder"]);
    same(["curd", "dahi", "yogurt", "yoghurt"]);
    same(["kurtis", "kurti"]);
    same(["cookies", "cookie"]);
    same(["shoes", "shoe"]);
    assert.strictEqual(N.nameKey("dress"), "dress");
    assert.strictEqual(N.nameKey("glasses"), "glass");
    assert.notStrictEqual(N.nameKey("coconut oil"), N.nameKey("coconut"));
    assert.notStrictEqual(N.nameKey("chilli powder"), N.nameKey("green chilli"));
  });

  await atest("units: g/gm/grams, kg, ml, l/litre, tsp, tbsp, cup, pcs/nos, packet, bunch; others kept", () => {
    const u = (xs, want) => xs.forEach((x) => assert.strictEqual(N.normalizeUnit(x), want, x));
    u(["g", "gm", "grams", "GMS", "gram"], "g");
    u(["kg", "Kgs", "kilo"], "kg");
    u(["ml", "millilitres"], "ml");
    u(["l", "litre", "Ltr", "liters"], "l");
    u(["tsp", "teaspoons"], "tsp");
    u(["tbsp", "tablespoon"], "tbsp");
    u(["cup", "cups"], "cup");
    u(["piece", "pcs", "Nos", "pcs."], "piece");
    u(["packet", "pack", "pkts"], "packet");
    u(["bunch", "bunches"], "bunch");
    assert.strictEqual(N.normalizeUnit("bottles"), "bottle");
    assert.strictEqual(N.normalizeUnit("strips"), "strip");
    assert.strictEqual(N.normalizeUnit(""), null);
    assert.strictEqual(N.normalizeUnit("x".repeat(30)), undefined);
    assert.strictEqual(N.normalizeUnit("<b>"), undefined);
  });

  await atest("quantities: numbers, fractions, words; 0, negatives and junk are refused", () => {
    assert.strictEqual(N.parseQuantity(2), 2);
    assert.strictEqual(N.parseQuantity("1.5"), 1.5);
    assert.strictEqual(N.parseQuantity("1/2"), 0.5);
    assert.strictEqual(N.parseQuantity("1 1/2"), 1.5);
    assert.strictEqual(N.parseQuantity("½"), 0.5);
    assert.strictEqual(N.parseQuantity("two"), 2);
    assert.strictEqual(N.parseQuantity(null), null);
    for (const x of [0, -1, "lots", 1e9, {}]) assert.strictEqual(N.parseQuantity(x), undefined, String(x));
  });

  await atest("amounts: same unit adds, g+kg / ml+l convert, another unit is a second amount", () => {
    const c = (a, add, o) => N.combine(a, add, o);
    assert.deepStrictEqual(c([{ quantity: 1, unit: "kg" }], { quantity: 500, unit: "g" }), [{ quantity: 1.5, unit: "kg" }]);
    assert.deepStrictEqual(c([{ quantity: 700, unit: "g" }], { quantity: 500, unit: "g" }), [{ quantity: 1.2, unit: "kg" }]);
    assert.deepStrictEqual(c([{ quantity: 1, unit: "l" }], { quantity: 250, unit: "ml" }), [{ quantity: 1.25, unit: "l" }]);
    assert.deepStrictEqual(c([{ quantity: 200, unit: "g" }], { quantity: 300, unit: "g" }), [{ quantity: 500, unit: "g" }]);
    const two = c([{ quantity: 1, unit: "kg" }], { quantity: 2, unit: "piece" });
    assert.deepStrictEqual(two, [{ quantity: 1, unit: "kg" }, { quantity: 2, unit: "piece" }]);
    assert.strictEqual(N.amountText(two), "1 kg + 2 pcs");
    assert.deepStrictEqual(c([{ quantity: null, unit: null }], { quantity: 2, unit: "kg" }), [{ quantity: 2, unit: "kg" }]);
    // groceries: said again with no amount changes nothing
    assert.deepStrictEqual(c([{ quantity: 1, unit: "kg" }], { quantity: null, unit: null }), [{ quantity: 1, unit: "kg" }]);
    // anything else: said again is one more
    assert.deepStrictEqual(c([{ quantity: null, unit: null }], { quantity: null, unit: null }, { countable: true }), [{ quantity: 2, unit: null }]);
    assert.deepStrictEqual(c([{ quantity: 2, unit: null }], { quantity: null, unit: null }, { countable: true }), [{ quantity: 3, unit: null }]);
    assert.strictEqual(N.amountText([{ quantity: 1, unit: "l" }]), "1 L");
    assert.strictEqual(N.amountText([{ quantity: 2, unit: "packet" }]), "2 packets");
    assert.strictEqual(N.amountText([{ quantity: 1, unit: "bunch" }]), "1 bunch");
    assert.strictEqual(N.amountText([{ quantity: null, unit: null }]), "");
  });

  await atest("categories by keyword, 'other' as the fallback", () => {
    const want = {
      onions: "vegetables_fruit", "baby corn": "vegetables_fruit", "green chilli": "vegetables_fruit",
      milk: "dairy_eggs", eggs: "dairy_eggs", chicken: "meat_fish", prawns: "meat_fish",
      "toor dal": "rice_atta_dal", atta: "rice_atta_dal", "garam masala": "spices_masala",
      "chilli powder": "spices_masala", jeera: "spices_masala", "coconut oil": "oils", ghee: "oils",
      bread: "bakery", "potato chips": "snacks_drinks", tea: "snacks_drinks",
      detergent: "household_cleaning", "dish wash liquid": "household_cleaning",
      shampoo: "personal_care_beauty", "hair oil": "personal_care_beauty", lipstick: "personal_care_beauty",
      "Dolo 650": "health_medicines", "paracetamol tablets": "health_medicines",
      kurti: "clothing_footwear", "running shoes": "clothing_footwear", saree: "clothing_footwear",
      "phone charger": "electronics_accessories", "power bank": "electronics_accessories",
      "pressure cooker": "home_kitchen", bedsheet: "home_kitchen", notebook: "stationery_books",
      diapers: "baby_kids", "dog food": "pets", "birthday gift for Amma": "gifts", "xyz widget": "other",
    };
    for (const [name, cat] of Object.entries(want)) assert.strictEqual(N.categoryOf(name), cat, name);
    assert.strictEqual(N.CATEGORIES.length, 19);
    assert.strictEqual(N.normalizeCategory("Dairy & eggs"), "dairy_eggs");
    assert.strictEqual(N.normalizeCategory("clothes"), "clothing_footwear");
    assert.strictEqual(N.normalizeCategory("electronics_accessories"), "electronics_accessories");
    assert.strictEqual(N.normalizeCategory("home"), "home_kitchen");
    assert.strictEqual(N.normalizeCategory("nonsense"), null);
  });

  /* ================================================================ */
  console.log("\n/shopping");

  await atest("an empty list, with the categories", async () => {
    const r = await call(A, "GET", "/shopping");
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.items, []);
    assert.strictEqual(r.body.updatedAt, null);
    assert.strictEqual(r.body.categories.length, 19);
    assert.deepStrictEqual(r.body.categories[0], { id: "vegetables_fruit", label: "Vegetables & fruit" });
  });

  let onionId;
  await atest("groceries: added with category, source and recipe", async () => {
    const r = await call(A, "POST", "/shopping/items", {
      source: "recipe",
      items: [
        { name: "onions", quantity: 1, unit: "kg", recipe: "Chicken biryani" },
        { name: "tomatoes", quantity: 500, unit: "grams", recipe: "Chicken biryani" },
        { name: "jeera", quantity: 2, unit: "tbsp", recipe: "Chicken biryani" },
        { name: "curd", quantity: 400, unit: "gm", recipe: "Chicken biryani" },
      ],
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.added.length, 4);
    assert.strictEqual(r.body.merged.length, 0);
    const onion = r.body.added.find((i) => i.name === "Onions");
    onionId = onion.id;
    assert.strictEqual(onion.quantity, 1);
    assert.strictEqual(onion.unit, "kg");
    assert.strictEqual(onion.category, "vegetables_fruit");
    assert.strictEqual(onion.source, "recipe");
    assert.strictEqual(onion.recipe, "Chicken biryani");
    assert.strictEqual(onion.checked, false);
    for (const k of ["id", "name", "quantity", "unit", "note", "category", "recipe", "source", "checked",
      "createdAt", "updatedAt", "details", "link", "store", "amounts", "amountText"]) {
      assert.ok(k in onion, `ShoppingItem.${k}`);
    }
    assert.strictEqual(r.body.items.length, 4);
  });

  await atest("merging: same unit adds, g+kg converts, another unit is a second amount, synonyms keep the first name", async () => {
    const r = await call(A, "POST", "/shopping/items", {
      source: "recipe",
      items: [
        { name: "Onion", quantity: 500, unit: "g", recipe: "Raita" },
        { name: "tomato", quantity: 2, unit: "pieces" },
        { name: "cumin seeds", quantity: 1, unit: "tbsp" },
        { name: "dahi", quantity: 200, unit: "g", recipe: "Raita" },
      ],
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.added.length, 0);
    assert.strictEqual(r.body.merged.length, 4);
    const by = Object.fromEntries(r.body.items.map((i) => [i.name, i]));
    assert.strictEqual(by.Onions.id, onionId);
    assert.strictEqual(by.Onions.amountText, "1.5 kg");
    assert.strictEqual(by.Onions.recipe, "Chicken biryani, Raita");
    assert.strictEqual(by.Tomatoes.amountText, "500 g + 2 pcs");
    assert.deepStrictEqual(by.Tomatoes.amounts, [{ quantity: 500, unit: "g" }, { quantity: 2, unit: "piece" }]);
    assert.strictEqual(by.Jeera.amountText, "3 tbsp", "jeera and cumin seeds are one line, named as first said");
    assert.strictEqual(by.Curd.amountText, "600 g");
    assert.strictEqual(r.body.items.length, 4);
  });

  await atest("within one request the same thing merges too; 'milk' again with no amount changes nothing", async () => {
    const r = await call(A, "POST", "/shopping/items", { items: [{ name: "milk" }, { name: "Milk" }, "bread"] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.added.length, 2);
    const milk = r.body.items.filter((i) => N.nameKey(i.name) === "milk");
    assert.strictEqual(milk.length, 1);
    assert.strictEqual(milk[0].quantity, null);
    assert.strictEqual(milk[0].source, "manual");
  });

  let dressId;
  let kurtiIds;
  await atest("anything to buy: a dress with size and colour, a link, a store, a medicine", async () => {
    const r = await call(A, "POST", "/shopping/items", {
      source: "voice",
      items: [
        { name: "dress", details: "M, blue floral, cotton", store: "Myntra", note: "for Onam" },
        { name: "sneakers", link: "https://www.myntra.com/sneakers/puma/123/buy" },
        { name: "Dolo 650", quantity: 2, unit: "strips" },
        { name: "phone charger", details: "USB-C 25W" },
      ],
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const by = Object.fromEntries(r.body.added.map((i) => [i.name, i]));
    dressId = by.Dress.id;
    assert.strictEqual(by.Dress.category, "clothing_footwear");
    assert.strictEqual(by.Dress.details, "M, blue floral, cotton");
    assert.strictEqual(by.Dress.store, "Myntra");
    assert.strictEqual(by.Dress.note, "for Onam");
    assert.strictEqual(by.Sneakers.link, "https://www.myntra.com/sneakers/puma/123/buy");
    assert.strictEqual(by.Sneakers.category, "clothing_footwear");
    assert.strictEqual(by["Dolo 650"].category, "health_medicines");
    assert.strictEqual(by["Dolo 650"].amountText, "2 strips");
    assert.strictEqual(by["Phone charger"].category, "electronics_accessories");
  });

  await atest("two kurtis with different details stay two lines; the same details (any order) merge", async () => {
    let r = await call(A, "POST", "/shopping/items", {
      items: [{ name: "kurti", details: "blue, M" }, { name: "kurti", details: "red, L" }],
    });
    assert.strictEqual(r.body.added.length, 2);
    kurtiIds = r.body.added.map((i) => i.id);
    r = await call(A, "POST", "/shopping/items", { items: [{ name: "Kurtis", details: "L red" }] });
    assert.strictEqual(r.body.merged.length, 1);
    assert.strictEqual(r.body.merged[0].id, kurtiIds[1]);
    assert.strictEqual(r.body.merged[0].quantity, 2, "the red L kurti is now 2");
    assert.strictEqual(r.body.items.filter((i) => N.nameKey(i.name) === "kurti").length, 2);
  });

  await atest("the same thing again with no new detail bumps the count", async () => {
    let r = await call(A, "POST", "/shopping/items", { items: [{ name: "umbrella" }] });
    const id = r.body.added[0].id;
    r = await call(A, "POST", "/shopping/items", { items: [{ name: "umbrellas" }] });
    assert.strictEqual(r.body.merged[0].id, id);
    assert.strictEqual(r.body.merged[0].quantity, 2);
    // one charger with details: "phone charger" again (no detail) is one more of it
    r = await call(A, "POST", "/shopping/items", { items: [{ name: "Phone charger" }] });
    assert.strictEqual(r.body.merged.length, 1);
    assert.strictEqual(r.body.merged[0].details, "USB-C 25W");
    assert.strictEqual(r.body.merged[0].quantity, 2);
  });

  await atest("a bought line said again comes back unticked with the new amount", async () => {
    const milk = (await call(A, "GET", "/shopping")).body.items.find((i) => i.name === "Milk");
    await call(A, "PATCH", `/shopping/items/${milk.id}`, { checked: true });
    const r = await call(A, "POST", "/shopping/items", { items: [{ name: "milk", quantity: 2, unit: "litre" }] });
    assert.strictEqual(r.body.added.length, 1);
    assert.strictEqual(r.body.added[0].id, milk.id);
    assert.strictEqual(r.body.added[0].checked, false);
    assert.strictEqual(r.body.added[0].amountText, "2 L");
  });

  await atest("POST /shopping/items: bad input is a 400 with a clear message", async () => {
    bad(await call(A, "POST", "/shopping/items", {}), 400, "no_items");
    bad(await call(A, "POST", "/shopping/items", { items: "milk" }), 400, "no_items");
    bad(await call(A, "POST", "/shopping/items", { items: Array.from({ length: 51 }, (_, i) => `x${i}`) }), 400, "too_many_items");
    bad(await call(A, "POST", "/shopping/items", { items: [{ name: "  " }] }), 400, "name_required");
    bad(await call(A, "POST", "/shopping/items", { items: [{ name: "x".repeat(81) }] }), 400, "name_too_long");
    bad(await call(A, "POST", "/shopping/items", { items: [{ name: "rice", quantity: "lots" }] }), 400, "bad_quantity");
    bad(await call(A, "POST", "/shopping/items", { items: [{ name: "rice", quantity: 0 }] }), 400, "bad_quantity");
    bad(await call(A, "POST", "/shopping/items", { items: [{ name: "rice", unit: "a very long unit name here" }] }), 400, "bad_unit");
    bad(await call(A, "POST", "/shopping/items", { items: [{ name: "shoes", link: "http://example.com/a" }] }), 400, "bad_link");
    bad(await call(A, "POST", "/shopping/items", { items: [{ name: "shoes", link: "javascript:alert(1)" }] }), 400, "bad_link");
    bad(await call(A, "POST", "/shopping/items", { items: [{ name: "shoes", link: `https://a.com/${"x".repeat(500)}` }] }), 400, "bad_link");
    bad(await call(A, "POST", "/shopping/items", { items: [{ name: "shoes", category: "spaceships" }] }), 400, "bad_category");
    bad(await call(A, "POST", "/shopping/items", { items: [{ name: "shoes", details: "x".repeat(201) }] }), 400, "details_too_long");
    bad(await call(A, "POST", "/shopping/items", { items: ["rice"], source: "robot" }), 400, "bad_source");
    bad(await call(A, "POST", "/shopping/items", { items: ["rice"], pad: "x".repeat(70 * 1024) }), 400, "too_large");
    const r = await call(A, "POST", "/shopping/items", { items: ["rice", { name: "" }] });
    bad(r, 400, "name_required");
    assert.match(r.body.message, /item 2/);
    const list = (await call(A, "GET", "/shopping")).body.items;
    assert.ok(!list.some((i) => i.name === "Rice"), "a rejected request writes nothing");
  });

  await atest("PATCH: tick, amount (replaces all amounts), rename re-files, details, link, store, category", async () => {
    let r = await call(A, "PATCH", `/shopping/items/${onionId}`, { checked: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.item.checked, true);
    const tomatoes = (await call(A, "GET", "/shopping")).body.items.find((i) => i.name === "Tomatoes");
    r = await call(A, "PATCH", `/shopping/items/${tomatoes.id}`, { quantity: 1, unit: "kg" });
    assert.deepStrictEqual(r.body.item.amounts, [{ quantity: 1, unit: "kg" }]);
    r = await call(A, "PATCH", `/shopping/items/${tomatoes.id}`, { quantity: null });
    assert.strictEqual(r.body.item.quantity, null);
    assert.strictEqual(r.body.item.unit, null);
    r = await call(A, "PATCH", `/shopping/items/${dressId}`, { name: "Saree", details: "silk, green", link: "https://www.myntra.com/saree/1", store: "Myntra", note: "" });
    assert.strictEqual(r.body.item.name, "Saree");
    assert.strictEqual(r.body.item.category, "clothing_footwear");
    assert.strictEqual(r.body.item.details, "silk, green");
    assert.strictEqual(r.body.item.link, "https://www.myntra.com/saree/1");
    r = await call(A, "PATCH", `/shopping/items/${dressId}`, { name: "Phone stand" });
    assert.strictEqual(r.body.item.category, "electronics_accessories", "a new name without a category re-files it");
    r = await call(A, "PATCH", `/shopping/items/${dressId}`, { name: "Dress", category: "gifts", link: null });
    assert.strictEqual(r.body.item.category, "gifts");
    assert.strictEqual(r.body.item.link, null);
  });

  await atest("PATCH: bad input 400, another user's id 404", async () => {
    bad(await call(A, "PATCH", "/shopping/items/abc", { checked: true }), 400, "bad_id");
    bad(await call(A, "PATCH", "/shopping/items/0", { checked: true }), 400, "bad_id");
    bad(await call(A, "PATCH", `/shopping/items/${onionId}`, {}), 400, "nothing_to_change");
    bad(await call(A, "PATCH", `/shopping/items/${onionId}`, { checked: "yes" }), 400, "bad_checked");
    bad(await call(A, "PATCH", `/shopping/items/${onionId}`, { quantity: -2 }), 400, "bad_quantity");
    bad(await call(A, "PATCH", `/shopping/items/${onionId}`, { name: "" }), 400, "name_required");
    bad(await call(A, "PATCH", `/shopping/items/${onionId}`, { link: "ftp://x" }), 400, "bad_link");
    bad(await call(A, "PATCH", `/shopping/items/${onionId}`, { category: "moon" }), 400, "bad_category");
    bad(await call(B, "PATCH", `/shopping/items/${onionId}`, { checked: false }), 404, "not_found");
    bad(await call(A, "PATCH", "/shopping/items/999999999", { checked: true }), 404, "not_found");
    const still = (await call(A, "GET", "/shopping")).body.items.find((i) => i.id === onionId);
    assert.strictEqual(still.checked, true, "B could not untick A's line");
  });

  await atest("DELETE: own line ok, then 404; another user's id 404", async () => {
    const r0 = await call(A, "POST", "/shopping/items", { items: ["batteries"] });
    const id = r0.body.added[0].id;
    bad(await call(B, "DELETE", `/shopping/items/${id}`), 404, "not_found");
    let r = await call(A, "DELETE", `/shopping/items/${id}`);
    assert.deepStrictEqual(r.body, { ok: true });
    bad(await call(A, "DELETE", `/shopping/items/${id}`), 404, "not_found");
    bad(await call(A, "DELETE", "/shopping/items/x1"), 400, "bad_id");
  });

  await atest("B's list is B's: A's lines are not visible to B", async () => {
    await call(B, "POST", "/shopping/items", { items: ["eggs"] });
    const b = (await call(B, "GET", "/shopping")).body.items;
    assert.deepStrictEqual(b.map((i) => i.name), ["Eggs"]);
    const a = (await call(A, "GET", "/shopping")).body;
    assert.ok(!a.items.some((i) => i.name === "Eggs"));
    assert.ok(a.updatedAt > 0);
    assert.strictEqual(a.items[a.items.length - 1].checked, true, "bought lines last");
  });

  await atest("share text: header, bold category headings, amounts, details, notes, links; nothing bought, no ids", async () => {
    const r = await call(A, "GET", "/shopping/share-text");
    assert.strictEqual(r.status, 200);
    const t = r.body.text;
    const items = (await call(A, "GET", "/shopping")).body.items;
    const open = items.filter((i) => !i.checked);
    assert.ok(t.startsWith(`*Shopping list* (${open.length} items)`), t.slice(0, 60));
    assert.match(t, /\*Vegetables & fruit\*/);
    assert.match(t, /\*Dairy & eggs\*\n- Curd — 600 g/);
    assert.match(t, /- Kurti \(red, L\)/);
    assert.match(t, /- Dolo 650 — 2 strips/);
    assert.match(t, /\n {2}https:\/\/www\.myntra\.com\/sneakers\/puma\/123\/buy/);
    assert.ok(!t.includes("Onions"), "the bought onion is not shared");
    for (const i of items) assert.ok(!new RegExp(`\\b${i.id}\\b`).test(t), "no internal ids");
    assert.ok(t.indexOf("*Vegetables & fruit*") < t.indexOf("*Dairy & eggs*"), "grouped in category order");
    const one = await call(A, "GET", "/shopping/share-text?category=clothing");
    assert.ok(one.body.text.startsWith("*Shopping list: Clothing & footwear* (3 items)"), one.body.text);
    assert.ok(!one.body.text.includes("Curd"));
    bad(await call(A, "GET", "/shopping/share-text?category=moon"), 400, "bad_category");
    const empty = await call(B, "GET", "/shopping/share-text?category=gifts");
    assert.strictEqual(empty.body.text, "");
  });

  await atest("share text stays under 3500 characters and says how many more", () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      id: 1000 + i, name: `Thing number ${i}`, details: "a fairly long description of the variant wanted",
      category: N.CATEGORY_IDS[i % 19], checked: false, amountText: "2 pcs",
    }));
    const t = shareText(many);
    assert.ok(t.length <= 3500, String(t.length));
    assert.match(t, /…and \d+ more$/);
    const shown = (t.match(/\n- /g) || []).length;
    assert.strictEqual(Number(t.match(/and (\d+) more$/)[1]), 150 - shown);
  });

  await atest("clear: the flag is required; bought only, then everything; B's list untouched", async () => {
    bad(await call(A, "POST", "/shopping/clear", {}), 400, "bad_checked_only");
    bad(await call(A, "POST", "/shopping/clear", { checkedOnly: "true" }), 400, "bad_checked_only");
    const before = (await call(A, "GET", "/shopping")).body.items;
    const bought = before.filter((i) => i.checked).length;
    assert.ok(bought >= 1);
    let r = await call(A, "POST", "/shopping/clear", { checkedOnly: true });
    assert.deepStrictEqual(r.body, { removed: bought });
    const after = (await call(A, "GET", "/shopping")).body.items;
    assert.strictEqual(after.length, before.length - bought);
    assert.ok(after.every((i) => !i.checked));
    const C = await mkUser("c");
    await call(C, "POST", "/shopping/items", { items: ["a", "b", "c"] });
    r = await call(C, "POST", "/shopping/clear", { checkedOnly: false });
    assert.deepStrictEqual(r.body, { removed: 3 });
    assert.strictEqual((await call(B, "GET", "/shopping")).body.items.length, 1);
  });

  await atest("300 lines at most: the 301st is refused and that request writes nothing", async () => {
    const D = await mkUser("d");
    for (let b = 0; b < 6; b++) {
      const r = await call(D, "POST", "/shopping/items", { items: Array.from({ length: 50 }, (_, i) => `item ${b}-${i}`) });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    }
    const r = await call(D, "POST", "/shopping/items", { items: ["one more", "and another"] });
    bad(r, 400, "list_full");
    assert.match(r.body.message, /300/);
    assert.strictEqual((await call(D, "GET", "/shopping")).body.items.length, 300);
    const merge = await call(D, "POST", "/shopping/items", { items: [{ name: "item 0-0" }] });
    assert.strictEqual(merge.status, 200, "merging into a line still works when full");
  });

  /* ---------------- hand-off ---------------- */

  await atest("hand-off: groceries need the user's app first (asked once)", async () => {
    const r = await call(A, "POST", "/shopping/handoff", {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.handoff, null);
    assert.ok(r.body.needsGroceryApp.includes("Curd"));
    assert.ok(r.body.groceryApps.includes("Blinkit") && r.body.groceryApps.includes("BigBasket") && r.body.groceryApps.includes("JioMart"));
  });

  await atest("hand-off: grouped by the app that fits, search links, own links kept, grocery app remembered", async () => {
    const r = await call(A, "POST", "/shopping/handoff", { groceryApp: "Zepto" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const h = r.body.handoff;
    assert.strictEqual(h.type, "shop_handoff");
    const by = Object.fromEntries(h.groups.map((g) => [g.app, g]));
    assert.strictEqual(h.groups[0].app, "zepto", "groceries first");
    assert.strictEqual(by.zepto.pkg, "com.zeptoconsumerapp");
    const curd = by.zepto.items.find((i) => i.name === "Curd");
    assert.strictEqual(curd.url, "https://www.zeptonow.com/search?query=Curd");
    assert.ok(typeof curd.id === "number" && curd.amountText === "600 g");
    const sneakers = by.myntra.items.find((i) => i.name === "Sneakers");
    assert.strictEqual(sneakers.url, "https://www.myntra.com/sneakers/puma/123/buy", "an item's own link is used");
    const kurti = by.myntra.items.find((i) => i.details === "blue, M");
    assert.strictEqual(kurti.url, "https://www.myntra.com/kurti-blue-m?rawQuery=Kurti%20blue%20M");
    assert.ok(by.amazon.items.some((i) => i.name === "Dolo 650" && i.url === "https://www.amazon.in/s?k=Dolo%20650"));
    assert.ok(by.amazon.items.some((i) => i.name === "Phone charger" && i.url.includes("Phone%20charger%20USB-C%2025W")));
    assert.strictEqual(r.body.rememberedGroceryApp, "Zepto");
    assert.match(r.body.summary, /on Zepto/);
    const again = await call(A, "POST", "/shopping/handoff", {});
    assert.strictEqual(again.body.handoff.groups[0].app, "zepto", "remembered: not asked again");
    assert.strictEqual(again.body.rememberedGroceryApp, null);
    const prefs = await call(A, "GET", "/kitchen/prefs");
    assert.strictEqual(prefs.body.groceryApp, "Zepto");
  });

  await atest("hand-off: one named app takes everything (Amazon Fresh for groceries); chosen ids only", async () => {
    let r = await call(A, "POST", "/shopping/handoff", { app: "amazon" });
    const apps = r.body.handoff.groups.map((g) => g.app);
    assert.deepStrictEqual([...new Set(apps)].sort(), ["amazon", "amazon_fresh"]);
    const fresh = r.body.handoff.groups.find((g) => g.app === "amazon_fresh");
    assert.strictEqual(fresh.label, "Amazon Fresh");
    assert.ok(fresh.items.every((i) => i.url.endsWith("&i=nowstore")));
    r = await call(A, "POST", "/shopping/handoff", { ids: [kurtiIds[1]], app: "AJIO" });
    assert.deepStrictEqual(r.body.handoff.groups.map((g) => [g.app, g.items.length]), [["ajio", 1]]);
    assert.strictEqual(r.body.handoff.groups[0].items[0].url, "https://www.ajio.com/search/?text=Kurti%20red%20L");
  });

  await atest("hand-off: never a payment app; unknown apps, other users' ids and bad ids refused", async () => {
    for (const app of ["PhonePe", "Google Pay", "paytm", "Amazon Pay", "BHIM UPI", "my bank app"]) {
      const r = await call(A, "POST", "/shopping/handoff", { app });
      bad(r, 400, "money_app");
    }
    bad(await call(A, "POST", "/shopping/handoff", { groceryApp: "GPay" }), 400, "money_app");
    bad(await call(A, "POST", "/shopping/handoff", { app: "DMart Ready" }), 400, "unknown_app");
    const bEggs = (await call(B, "GET", "/shopping")).body.items[0].id;
    bad(await call(A, "POST", "/shopping/handoff", { ids: [bEggs] }), 404, "not_found");
    bad(await call(A, "POST", "/shopping/handoff", { ids: ["1"] }), 400, "bad_ids");
    bad(await call(A, "POST", "/shopping/handoff", { app: 42 }), 400, "bad_app");
  });

  await atest("links: every app's search template, and money detection", () => {
    const q = "toor dal";
    const want = {
      blinkit: "https://blinkit.com/s/?q=toor%20dal",
      zepto: "https://www.zeptonow.com/search?query=toor%20dal",
      instamart: "https://www.swiggy.com/instamart/search?custom_back=true&query=toor%20dal",
      bigbasket: "https://www.bigbasket.com/ps/?q=toor%20dal",
      jiomart: "https://www.jiomart.com/search/toor%20dal",
      amazon_fresh: "https://www.amazon.in/s?k=toor%20dal&i=nowstore",
      flipkart_minutes: "https://www.flipkart.com/search?q=toor%20dal&marketplace=HYPERLOCAL",
      amazon: "https://www.amazon.in/s?k=toor%20dal",
      flipkart: "https://www.flipkart.com/search?q=toor%20dal",
      nykaa: "https://www.nykaa.com/search/result/?q=toor%20dal",
      meesho: "https://www.meesho.com/search?q=toor%20dal",
      tata1mg: "https://www.1mg.com/search/all?name=toor%20dal",
      pharmeasy: "https://pharmeasy.in/search/all?name=toor%20dal",
    };
    for (const [key, url] of Object.entries(want)) assert.strictEqual(links.searchUrl(key, q), url, key);
    for (const key of Object.keys(links.APPS)) assert.match(links.searchUrl(key, q), /^https:\/\//, key);
    assert.strictEqual(links.resolveApp("the Swiggy Instamart app"), "instamart");
    assert.strictEqual(links.resolveApp("Big Basket"), "bigbasket");
    assert.strictEqual(links.resolveApp("PhonePe"), null);
    for (const m of ["phonepe", "gpay", "Google Pay", "Paytm", "BHIM", "CRED", "Amazon Pay", "MobiKwik", "SBI YONO"]) {
      assert.ok(links.isMoneyApp(m), m);
    }
    for (const s of ["BigBasket", "Blinkit", "Flipkart", "PharmEasy", "Myntra"]) assert.ok(!links.isMoneyApp(s), s);
    assert.ok(links.isMoneyLink("https://paytm.com/x") && !links.isMoneyLink("https://www.myntra.com/x"));
  });

  await atest("where they like to shop is read from what they said (newest first; avoid wins)", () => {
    const p = readPrefs([
      "User's usual grocery app is BigBasket.",
      "User buys clothes on Ajio",
      "User never uses Amazon",
      "User prefers Swiggy over Zomato",
      "User orders medicines from PharmEasy",
      "User's usual grocery app is Zepto.",
    ]);
    assert.strictEqual(p.byKind.grocery, "bigbasket", "the newest statement wins");
    assert.strictEqual(p.byKind.fashion, "ajio");
    assert.strictEqual(p.byKind.pharmacy, "pharmeasy");
    assert.ok(p.avoid.has("amazon"));
    assert.ok(!Object.values(p.byKind).includes("instamart"), "Swiggy the food app is not a grocery preference");
    const plan = links.plan(
      [{ id: 1, name: "Phone charger", category: "electronics_accessories" }, { id: 2, name: "Lipstick", category: "personal_care_beauty" }],
      { prefs: p });
    assert.deepStrictEqual(plan.groups.map((g) => g.app), ["flipkart", "nykaa"], "Amazon avoided: next default");
  });

  /* ================================================================ */
  console.log("\n/kitchen");

  await atest("prefs: safe defaults for someone we know nothing about", async () => {
    const r = await call(B, "GET", "/kitchen/prefs");
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(Object.keys(r.body).sort(),
      ["allergies", "cuisine", "diet", "groceryApp", "household", "language", "spice", "staples"]);
    assert.strictEqual(r.body.diet, null);
    assert.deepStrictEqual(r.body.allergies, []);
    assert.strictEqual(r.body.spice, "medium");
    assert.strictEqual(r.body.household, 2);
    assert.strictEqual(r.body.cuisine, null);
    assert.strictEqual(r.body.language, "English");
    assert.strictEqual(r.body.groceryApp, null);
    assert.ok(r.body.staples.includes("Salt") && r.body.staples.includes("Turmeric"));
  });

  await atest("pantry: have / out remembered, learns when it changes, B sees none of it", async () => {
    let r = await call(A, "GET", "/kitchen/pantry");
    assert.deepStrictEqual(r.body, { items: [] });
    r = await call(A, "PUT", "/kitchen/pantry", { have: ["Eggs", "paneer"], out: ["rice", "haldi"] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const st = Object.fromEntries(r.body.items.map((i) => [i.name, i.status]));
    assert.deepStrictEqual(st, { Eggs: "have", Paneer: "have", Rice: "out", Haldi: "out" });
    assert.ok(r.body.items.every((i) => i.updatedAt > 0));
    r = await call(A, "PUT", "/kitchen/pantry", { have: ["Rice"], out: ["eggs"] });
    const st2 = Object.fromEntries(r.body.items.map((i) => [i.name, i.status]));
    assert.strictEqual(st2.Rice, "have");
    assert.strictEqual(st2.Eggs, "out");
    assert.strictEqual(r.body.items.length, 4, "the same thing is one row");
    const prefs = (await call(A, "GET", "/kitchen/prefs")).body;
    assert.ok(!prefs.staples.includes("Turmeric"), "haldi ran out: turmeric is not a staple now");
    assert.ok(prefs.staples.includes("Paneer") && prefs.staples.includes("Rice"));
    assert.deepStrictEqual((await call(B, "GET", "/kitchen/pantry")).body, { items: [] });
  });

  await atest("pantry: bad input 400", async () => {
    bad(await call(A, "PUT", "/kitchen/pantry", {}), 400, "nothing_to_change");
    bad(await call(A, "PUT", "/kitchen/pantry", { have: "rice" }), 400, "bad_have");
    bad(await call(A, "PUT", "/kitchen/pantry", { out: [3] }), 400, "bad_out");
    bad(await call(A, "PUT", "/kitchen/pantry", { have: ["x".repeat(81)] }), 400, "name_too_long");
    bad(await call(A, "PUT", "/kitchen/pantry", { have: ["curd"], out: ["dahi"] }), 400, "both");
  });

  let recipeId;
  await atest("recipes: save (as given), the same title updates it, list and search", async () => {
    let r = await call(A, "POST", "/kitchen/recipes", { recipe: RECIPE(), notes: "Amma's way" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const s = r.body.recipe;
    recipeId = s.id;
    assert.strictEqual(s.title, "Paneer butter masala");
    assert.deepStrictEqual(s.recipe, RECIPE());
    assert.strictEqual(s.rating, null);
    assert.strictEqual(s.notes, "Amma's way");
    assert.strictEqual(s.cookedCount, 0);
    assert.strictEqual(s.lastCookedAt, null);
    assert.ok(s.createdAt > 0 && s.updatedAt > 0);
    r = await call(A, "POST", "/kitchen/recipes", { recipe: RECIPE({ title: "paneer  Butter masala", servings: 2 }) });
    assert.strictEqual(r.body.recipe.id, recipeId, "same title: updated, not duplicated");
    assert.strictEqual(r.body.recipe.recipe.servings, 2);
    assert.strictEqual(r.body.recipe.notes, "Amma's way", "notes kept when not sent");
    await call(A, "POST", "/kitchen/recipes", { recipe: RECIPE({ title: "Rasam", servings: 4 }) });
    r = await call(A, "GET", "/kitchen/recipes");
    assert.strictEqual(r.body.recipes.length, 2);
    r = await call(A, "GET", "/kitchen/recipes?q=paneer");
    assert.deepStrictEqual(r.body.recipes.map((x) => x.id), [recipeId]);
    assert.deepStrictEqual((await call(B, "GET", "/kitchen/recipes")).body, { recipes: [] });
  });

  await atest("recipes: shape and size are checked (400)", async () => {
    bad(await call(A, "POST", "/kitchen/recipes", {}), 400, "bad_recipe");
    bad(await call(A, "POST", "/kitchen/recipes", { recipe: [] }), 400, "bad_recipe");
    bad(await call(A, "POST", "/kitchen/recipes", { recipe: RECIPE({ title: "" }) }), 400, "bad_recipe");
    bad(await call(A, "POST", "/kitchen/recipes", { recipe: RECIPE({ ingredients: "onion" }) }), 400, "bad_recipe");
    bad(await call(A, "POST", "/kitchen/recipes", { recipe: RECIPE({ ingredients: [{ quantity: 2 }] }) }), 400, "bad_recipe");
    bad(await call(A, "POST", "/kitchen/recipes", { recipe: RECIPE({ steps: undefined }) }), 400, "bad_recipe");
    bad(await call(A, "POST", "/kitchen/recipes", { recipe: RECIPE({ servings: 0 }) }), 400, "bad_recipe");
    bad(await call(A, "POST", "/kitchen/recipes", { recipe: RECIPE({ tips: ["x".repeat(66 * 1024)] }) }), 400, "recipe_too_large");
    bad(await call(A, "POST", "/kitchen/recipes", { recipe: RECIPE(), notes: "x".repeat(2001) }), 400, "notes_too_long");
    bad(await call(A, "POST", "/kitchen/recipes", { recipe: RECIPE(), pad: "x".repeat(80 * 1024) }), 400, "too_large");
  });

  await atest("recipes: rating 1-5, notes, recipe replaced; cooked adds a dated note and remembers it", async () => {
    let r = await call(A, "PATCH", `/kitchen/recipes/${recipeId}`, { rating: 5, notes: "Great with naan" });
    assert.strictEqual(r.body.recipe.rating, 5);
    assert.strictEqual(r.body.recipe.notes, "Great with naan");
    bad(await call(A, "PATCH", `/kitchen/recipes/${recipeId}`, { rating: 6 }), 400, "bad_rating");
    bad(await call(A, "PATCH", `/kitchen/recipes/${recipeId}`, { rating: 2.5 }), 400, "bad_rating");
    bad(await call(A, "PATCH", `/kitchen/recipes/${recipeId}`, {}), 400, "nothing_to_change");
    bad(await call(A, "PATCH", `/kitchen/recipes/${recipeId}`, { recipe: { title: "x" } }), 400, "bad_recipe");
    r = await call(A, "PATCH", `/kitchen/recipes/${recipeId}`, { rating: null });
    assert.strictEqual(r.body.recipe.rating, null);
    r = await call(A, "POST", `/kitchen/recipes/${recipeId}/cooked`, { rating: 4, notes: "less chilli next time" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.recipe.cookedCount, 1);
    assert.strictEqual(r.body.recipe.rating, 4);
    assert.ok(r.body.recipe.lastCookedAt > 0);
    assert.match(r.body.recipe.notes, /^Great with naan\n\d{4}-\d{2}-\d{2}: less chilli next time$/);
    r = await call(A, "POST", `/kitchen/recipes/${recipeId}/cooked`, {});
    assert.strictEqual(r.body.recipe.cookedCount, 2);
    assert.strictEqual(r.body.recipe.rating, 4, "rating kept when not sent");
    const mem = await db.one(
      "SELECT fact FROM agent_memories WHERE user_id = $1 AND fact ILIKE $2", [A, "%after cooking Paneer butter masala%"]);
    assert.ok(mem && /less chilli next time/.test(mem.fact), "the note is in memory");
    bad(await call(A, "POST", `/kitchen/recipes/${recipeId}/cooked`, { rating: 0 }), 400, "bad_rating");
  });

  await atest("recipes: another user's id is 404 everywhere; bad ids 400", async () => {
    bad(await call(B, "PATCH", `/kitchen/recipes/${recipeId}`, { rating: 1 }), 404, "not_found");
    bad(await call(B, "POST", `/kitchen/recipes/${recipeId}/cooked`, {}), 404, "not_found");
    bad(await call(B, "POST", `/kitchen/recipes/${recipeId}/shop`, {}), 404, "not_found");
    bad(await call(B, "DELETE", `/kitchen/recipes/${recipeId}`), 404, "not_found");
    bad(await call(A, "PATCH", "/kitchen/recipes/abc", { rating: 1 }), 400, "bad_id");
    const still = await call(A, "GET", "/kitchen/recipes?q=paneer");
    assert.strictEqual(still.body.recipes[0].rating, 4);
  });

  await atest("a saved recipe onto the shopping list: scaled, staples and what they have left off", async () => {
    const E = await mkUser("e");
    const saved = (await call(E, "POST", "/kitchen/recipes", { recipe: RECIPE() })).body.recipe;
    await call(E, "PUT", "/kitchen/pantry", { have: ["paneer"] });
    const r = await call(E, "POST", `/kitchen/recipes/${saved.id}/shop`, { servings: 8, skip: ["mint"] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.skipped.sort(), ["Mint", "Paneer", "Salt"]);
    const by = Object.fromEntries(r.body.added.map((i) => [i.name, i]));
    assert.strictEqual(by.Tomatoes.amountText, "6 pcs", "4 servings -> 8: doubled");
    assert.strictEqual(by.Butter.amountText, "4 tbsp");
    assert.strictEqual(by["Fresh cream"].category, "dairy_eggs");
    assert.ok(r.body.added.every((i) => i.source === "recipe" && i.recipe === "Paneer butter masala"));
    bad(await call(E, "POST", `/kitchen/recipes/${saved.id}/shop`, { servings: 0 }), 400, "bad_servings");
    bad(await call(E, "POST", `/kitchen/recipes/${saved.id}/shop`, { skip: "mint" }), 400, "bad_skip");
  });

  await atest("200 saved recipes at most", async () => {
    const F = await mkUser("f");
    const now = Date.now();
    await db.run(
      `INSERT INTO kitchen_recipes (user_id, title, title_key, recipe, created_at, updated_at)
       SELECT $1, 'Dish ' || g, 'dish ' || g, '{"title":"x","ingredients":[],"steps":[]}'::jsonb, $2, $2
         FROM generate_series(1, 200) g`, [F, now]);
    bad(await call(F, "POST", "/kitchen/recipes", { recipe: RECIPE() }), 400, "recipes_full");
    const r = await call(F, "POST", "/kitchen/recipes", { recipe: RECIPE({ title: "Dish 7" }) });
    assert.strictEqual(r.status, 200, "an existing title still updates");
  });

  await atest("recipes: delete, then 404", async () => {
    const r0 = await call(A, "GET", "/kitchen/recipes?q=rasam");
    const id = r0.body.recipes[0].id;
    assert.deepStrictEqual((await call(A, "DELETE", `/kitchen/recipes/${id}`)).body, { ok: true });
    bad(await call(A, "DELETE", `/kitchen/recipes/${id}`), 404, "not_found");
  });

  await atest("week plan: round trip, own recipes only, shape checked, B has none", async () => {
    assert.deepStrictEqual((await call(A, "GET", "/kitchen/plan")).body, { plan: null });
    const days = [
      { date: "2026-09-29", meals: [{ slot: "dinner", title: "Paneer butter masala", recipeId }] },
      { date: "2026-09-28", meals: [{ slot: "breakfast", title: "Idli sambar" }, { slot: "lunch", title: "Rasam rice" }] },
    ];
    let r = await call(A, "PUT", "/kitchen/plan", { weekStart: "2026-09-28", days });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.plan.weekStart, "2026-09-28");
    assert.deepStrictEqual(r.body.plan.days.map((d) => d.date), ["2026-09-28", "2026-09-29"], "sorted by date");
    assert.deepStrictEqual(r.body.plan.days[1].meals[0], { slot: "dinner", title: "Paneer butter masala", recipeId });
    assert.strictEqual(r.body.plan.days[0].meals[0].recipeId, null);
    r = await call(A, "GET", "/kitchen/plan");
    assert.strictEqual(r.body.plan.days.length, 2);
    assert.ok(r.body.plan.updatedAt > 0);
    assert.deepStrictEqual((await call(B, "GET", "/kitchen/plan")).body, { plan: null });
    const bRecipe = (await call(B, "POST", "/kitchen/recipes", { recipe: RECIPE({ title: "B's dal" }) })).body.recipe.id;
    bad(await call(A, "PUT", "/kitchen/plan", { weekStart: "2026-09-28", days: [{ date: "2026-09-28", meals: [{ slot: "lunch", title: "x", recipeId: bRecipe }] }] }), 400, "unknown_recipe");
    bad(await call(A, "PUT", "/kitchen/plan", { weekStart: "28-09-2026", days }), 400, "bad_week_start");
    bad(await call(A, "PUT", "/kitchen/plan", { weekStart: "2026-02-30", days }), 400, "bad_week_start");
    bad(await call(A, "PUT", "/kitchen/plan", { weekStart: "2026-09-28", days: [] }), 400, "bad_days");
    bad(await call(A, "PUT", "/kitchen/plan", { weekStart: "2026-09-28", days: Array.from({ length: 8 }, (_, i) => ({ date: `2026-10-0${i + 1}`, meals: [] })) }), 400, "bad_days");
    bad(await call(A, "PUT", "/kitchen/plan", { weekStart: "2026-09-28", days: [days[0], days[0]] }), 400, "bad_days");
    bad(await call(A, "PUT", "/kitchen/plan", { weekStart: "2026-09-28", days: [{ date: "2026-09-28", meals: [{ slot: "brunch", title: "x" }] }] }), 400, "bad_meals");
    bad(await call(A, "PUT", "/kitchen/plan", { weekStart: "2026-09-28", days: [{ date: "2026-09-28", meals: [{ slot: "lunch", title: "" }] }] }), 400, "bad_meals");
    assert.strictEqual((await call(A, "GET", "/kitchen/plan")).body.plan.days.length, 2, "a rejected plan changes nothing");
  });

  await atest("week plan: its merged shopping list goes onto the list (source plan)", async () => {
    const G = await mkUser("g");
    const r = await call(G, "PUT", "/kitchen/plan", {
      weekStart: "2026-09-28",
      days: [{ date: "2026-09-28", meals: [{ slot: "lunch", title: "Sambar rice" }] }],
      shoppingItems: [{ name: "toor dal", quantity: 500, unit: "g" }, { name: "drumsticks", quantity: 4 }, { name: "salt" }],
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.shopping.added.length, 2);
    assert.deepStrictEqual(r.body.shopping.skipped, ["Salt"]);
    const list = (await call(G, "GET", "/shopping")).body.items;
    assert.ok(list.every((i) => i.source === "plan" && i.recipe === "Week of 2026-09-28"));
    bad(await call(G, "PUT", "/kitchen/plan", {
      weekStart: "2026-09-28", days: [{ date: "2026-09-28", meals: [] }], shoppingItems: [{ name: "" }],
    }), 400, "name_required");
  });

  await atest("prefs are read from memory and rules: diet, allergies (family too), spice, household, cuisine, language", async () => {
    const H = await mkUser("h");
    const now = Date.now();
    const fact = (t, at, subject = "") => db.run(
      `INSERT INTO agent_memories (user_id, fact, importance, created_at, kind, subject_type, valid)
       VALUES ($1, $2, 2, $3, 'semantic', $4, 1)`, [H, t, at, subject]);
    await fact("User is vegetarian but eats eggs", now - 5000);
    await fact("User's wife is non-vegetarian", now - 4000);
    await fact("User is allergic to peanuts and prawns", now - 3000);
    await fact("User's son has a cashew allergy", now - 2500);
    await fact("User prefers mild food, not too spicy", now - 2000);
    await fact("User lives with a family of four", now - 1500);
    await fact("User loves Kerala food", now - 1000);
    await fact("is lactose intolerant", now - 900, "person");
    await db.run("INSERT INTO user_instructions (user_id, instruction, created_at) VALUES ($1, $2, $3)",
      [H, "Always order my groceries on Blinkit", now - 500]);
    await db.run("UPDATE users SET preferred_language = 'Malayalam' WHERE id = $1", [H]);
    await call(H, "PUT", "/kitchen/pantry", { out: ["salt"], have: ["ghee"] });
    const r = await call(H, "GET", "/kitchen/prefs");
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.diet, "egg");
    assert.deepStrictEqual(r.body.allergies, ["Lactose (milk)", "Cashew", "Peanuts", "Prawns"]);
    assert.strictEqual(r.body.spice, "mild");
    assert.strictEqual(r.body.household, 4);
    assert.strictEqual(r.body.cuisine, "Kerala");
    assert.strictEqual(r.body.language, "Malayalam");
    assert.strictEqual(r.body.groceryApp, "Blinkit");
    assert.ok(!r.body.staples.includes("Salt") && r.body.staples.includes("Ghee"));
  });

  await atest("prefs parsing: another person's diet is not the user's; 'not vegetarian'; lives alone; no allergies", () => {
    const rows = (xs) => xs.map((t) => ({ t, subject: "" }));
    assert.strictEqual(readKitchen(rows(["User's mother is vegetarian"])).diet, null);
    assert.strictEqual(readKitchen(rows(["User is not vegetarian"])).diet, "non-veg");
    assert.strictEqual(readKitchen(rows(["User is vegan"])).diet, "vegan");
    assert.strictEqual(readKitchen(rows(["User is strictly Jain, no onion or garlic"])).diet, "jain");
    assert.strictEqual(readKitchen(rows(["User's colleague is Rahul Jain"])).diet, null);
    assert.strictEqual(readKitchen(rows(["User is pure veg"])).diet, "veg");
    assert.strictEqual(readKitchen(rows(["User lives alone"])).household, 1);
    assert.strictEqual(readKitchen(rows(["User likes spicy food"])).spice, "hot");
    assert.strictEqual(readKitchen(rows(["User doesn't like spicy food"])).spice, "mild");
    assert.deepStrictEqual(readKitchen(rows(["User has no allergies"])).allergies, []);
    assert.strictEqual(readKitchen(rows(["User lives in Mangalore"])).cuisine, null, "a home town is not a cuisine");
  });

  /* ================================================================ */
  console.log("\ntools (fresh registry)");

  const T = await mkUser("t");
  const ctxT = (extra) => ctxFor(T, extra);
  await db.run(
    "INSERT INTO contacts (user_id, name, phone, updated_at) VALUES ($1,$2,$3,$4), ($1,$5,$6,$4), ($1,$7,$8,$4)",
    [T, "Amma", "+919800000011", Date.now(), "Ravi Kumar", "+919800000012", "Ravi Shetty", "+919800000013"]);

  await atest("the contract: effects, risk, confirmation, app-build gating", () => {
    const names = registry.list().map((t) => t.name).sort();
    assert.deepStrictEqual(names, [
      "pantry_update", "share_shopping_list", "shop_from_list", "shopping_list_add", "shopping_list_check",
      "shopping_list_clear", "shopping_list_clear_all", "shopping_list_remove", "shopping_list_show",
    ]);
    assert.ok(registry.requiresConfirmation("shop_from_list", {}));
    assert.ok(registry.requiresConfirmation("shopping_list_clear_all", {}));
    assert.ok(!registry.requiresConfirmation("shopping_list_clear", {}));
    assert.ok(!registry.requiresConfirmation("shopping_list_add", {}));
    assert.ok(registry.describe("shopping_list_add").world, "a list write is a world action");
    assert.ok(!registry.describe("shopping_list_show").world);
    const old = registry.declarations({ deviceCaps: CAPS(120) }).map((d) => d.name);
    assert.ok(!old.includes("shop_from_list") && !old.includes("share_shopping_list"));
    assert.ok(old.includes("shopping_list_add") && old.includes("shopping_list_show"));
    const now = registry.declarations({ deviceCaps: CAPS(124) }).map((d) => d.name);
    assert.ok(now.includes("shop_from_list") && now.includes("share_shopping_list"));
    for (const d of registry.declarations()) assert.ok(d.description.length > 80, d.name);
  });

  await atest("shopping_list_add: anything, with details; a notice for the new app only", async () => {
    const res = await exec("shopping_list_add", {
      items: [
        { name: "onions", quantity: 1, unit: "kg" },
        { name: "kurti", details: "blue, M" },
        { name: "kurti", details: "red, L" },
        "milk",
        { name: "Dolo 650", quantity: "2", unit: "strips" },
        { name: "phone charger", details: "USB-C", store: "Amazon" },
      ],
    }, ctxT({ turnId: "t1" }));
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.data.added.length, 6);
    assert.match(res.speak, /^Added onions, kurti, kurti, milk, dolo 650 and phone charger to your shopping list\.$/);
    assert.deepStrictEqual(res.deviceAction, { type: "shopping_list_updated", notice: true });
    const old = await exec("shopping_list_add", { items: [{ name: "bread" }] }, ctxT({ appBuild: 120, deviceCaps: CAPS(120) }));
    assert.strictEqual(old.ok, true);
    assert.strictEqual(old.deviceAction, undefined, "an older app gets no notice");
  });

  await atest("shopping_list_add: the same call twice in one turn is not doubled; a new turn adds", async () => {
    const args = { items: [{ name: "onion", quantity: 500, unit: "g" }] };
    const one = await exec("shopping_list_add", args, ctxT({ turnId: "t2" }));
    assert.match(one.speak, /Onions was already there — now 1\.5 kg/);
    const twice = await exec("shopping_list_add", args, ctxT({ turnId: "t2" }));
    assert.strictEqual(twice.repeated, true);
    const onion = (await shopStore.list(T)).find((i) => i.name === "Onions");
    assert.strictEqual(onion.amountText, "1.5 kg");
    await exec("shopping_list_add", args, ctxT({ turnId: "t3" }));
    assert.strictEqual((await shopStore.list(T)).find((i) => i.name === "Onions").amountText, "2 kg");
  });

  await atest("shopping_list_add: long names are trimmed, junk quantities dropped, no names asked for", async () => {
    const res = await exec("shopping_list_add", { items: [{ name: `a ${"very ".repeat(30)}long thing`, quantity: "loads", unit: "x".repeat(30) }] }, ctxT());
    assert.strictEqual(res.ok, true);
    assert.ok(res.data.added[0].name.length <= 80);
    assert.strictEqual(res.data.added[0].amount, "");
    const spokenAmount = await exec("shopping_list_add", { items: [{ name: "sugar", quantity: "2 kg" }] }, ctxT());
    assert.strictEqual(spokenAmount.data.added[0].amount, "2 kg", "a spoken '2 kg' is a number and a unit");
    await exec("shopping_list_remove", { items: ["sugar"] }, ctxT());
    const none = await exec("shopping_list_add", { items: [{ name: "  " }] }, ctxT());
    assert.strictEqual(none.ok, false);
    const missing = await exec("shopping_list_add", {}, ctxT());
    assert.deepStrictEqual(missing.needsArgs, ["items"]);
    const signedOut = await exec("shopping_list_add", { items: ["x"] }, { appBuild: 124 });
    assert.strictEqual(signedOut.ok, false);
    await exec("shopping_list_remove", { items: [res.data.added[0].name] }, ctxT());
  });

  await atest("shopping_list_show: names read back; the screen opens on 124+; category filter", async () => {
    const res = await exec("shopping_list_show", {}, ctxT());
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.toBuy, 7);
    assert.match(res.speak, /^You have 7 things on your list: onions, milk, bread, dolo 650, kurti, kurti and phone charger\.$/);
    assert.deepStrictEqual(res.deviceAction, { type: "open_app_screen", screen: "shopping_list" });
    const cat = await exec("shopping_list_show", { category: "clothes" }, ctxT());
    assert.strictEqual(cat.data.toBuy, 2);
    assert.deepStrictEqual(cat.deviceAction, { type: "open_app_screen", screen: "shopping_list", category: "clothing_footwear" });
    assert.match(cat.speak, /for clothing & footwear/);
    const quiet = await exec("shopping_list_show", { open: false }, ctxT());
    assert.strictEqual(quiet.deviceAction, undefined);
    const old = await exec("shopping_list_show", {}, ctxT({ appBuild: 120, deviceCaps: CAPS(120) }));
    assert.strictEqual(old.ok, true, "older apps still hear their list");
    assert.strictEqual(old.deviceAction, undefined);
    const bogus = await exec("shopping_list_show", { category: "moon" }, ctxT());
    assert.strictEqual(bogus.ok, false);
  });

  await atest("shopping_list_check: tick by what was said (synonyms too), untick, unknown named", async () => {
    let res = await exec("shopping_list_check", { items: ["the onion", "doodh", "mangoes"] }, ctxT());
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.data.changed.sort(), ["Milk", "Onions"]);
    assert.deepStrictEqual(res.data.notOnList, ["mangoes"]);
    assert.match(res.speak, /Ticked off onions and milk\. mangoes isn't on your list\./);
    const list = await shopStore.list(T);
    assert.ok(list.find((i) => i.name === "Milk").checked);
    res = await exec("shopping_list_check", { items: ["milk"], bought: false }, ctxT());
    assert.ok(!(await shopStore.list(T)).find((i) => i.name === "Milk").checked);
  });

  await atest("shopping_list_remove: 'kurti' is ambiguous (ask), 'the blue kurti' is not", async () => {
    let res = await exec("shopping_list_remove", { items: ["kurti"] }, ctxT());
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "which_one");
    assert.match(res.note, /Kurti \(blue, M\) and Kurti \(red, L\)/);
    assert.strictEqual((await shopStore.list(T)).filter((i) => i.name === "Kurti").length, 2, "nothing removed");
    res = await exec("shopping_list_remove", { items: ["the blue kurti"] }, ctxT());
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.data.removed, ["Kurti"]);
    const left = (await shopStore.list(T)).filter((i) => i.name === "Kurti");
    assert.deepStrictEqual(left.map((i) => i.details), ["red, L"]);
  });

  await atest("share_shopping_list: send_whatsapp_message's action, the list written, owner taps Send", async () => {
    let res = await exec("share_shopping_list", { to: "Amma" }, ctxT());
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.deviceAction.type, "open_url");
    assert.ok(res.deviceAction.url.startsWith("whatsapp://send?phone=+919800000011&text="));
    const text = decodeURIComponent(res.deviceAction.url.split("&text=")[1]);
    assert.ok(text.startsWith("*Shopping list* ("));
    assert.match(text, /- Kurti \(red, L\)/);
    assert.ok(!text.includes("Onions"), "bought items are not sent");
    assert.strictEqual(res.data.drafted, text);
    assert.match(res.speak, /tap send/);
    assert.ok(!/\bsent\b/i.test(res.speak), "never claims it was sent");
    res = await exec("share_shopping_list", { to: "family group", is_group: true, category: "health" }, ctxT());
    assert.ok(res.deviceAction.url.startsWith("whatsapp://send?text="));
    assert.match(decodeURIComponent(res.deviceAction.url), /Shopping list: Health & medicines/);
    res = await exec("share_shopping_list", { to: "the kirana" }, ctxT());
    assert.strictEqual(res.data.target, "picker");
    assert.ok(res.deviceAction.url.startsWith("whatsapp://send?text="));
    res = await exec("share_shopping_list", { to: "Ravi" }, ctxT());
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /Ask which one/);
    res = await exec("share_shopping_list", { category: "pets" }, ctxT());
    assert.strictEqual(res.ok, false, "nothing to share");
    res = await exec("share_shopping_list", { to: "Amma" }, ctxT({ appBuild: 120, deviceCaps: CAPS(120) }));
    assert.strictEqual(res.ok, false, "needs build 124");
  });

  await atest("shop_from_list: asks for the grocery app once — nothing opened", async () => {
    const res = await exec("shop_from_list", {}, ctxT());
    assert.strictEqual(res.ok, false);
    assert.ok(!res.needsConfirmation && !res.deviceAction);
    assert.match(res.error, /Ask which app they use for groceries \(Blinkit, Zepto, Swiggy Instamart, BigBasket, JioMart/);
    assert.match(res.error, /grocery_app/);
  });

  await atest("shop_from_list: always asks first, with what will open where", async () => {
    const res = await exec("shop_from_list", { grocery_app: "Blinkit" }, ctxT());
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.needsConfirmation, true);
    assert.strictEqual(res.tool, "shop_from_list");
    assert.strictEqual(res.summary, "Open 2 items on Blinkit, 2 on Amazon and 1 on Myntra — you choose and pay in the app");
    assert.ok(!res.deviceAction);
    const summary = registry.get("shop_from_list").confirmSummary({ items: ["curd"], app: "Zepto" });
    assert.strictEqual(summary, "Open curd on Zepto — you choose and pay in the app");
  });

  await atest("shop_from_list, approved: shop_handoff grouped per app, search links, grocery app remembered", async () => {
    const res = await exec("shop_from_list", { grocery_app: "Blinkit" }, ctxT({ approved: true }));
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    const h = res.deviceAction;
    assert.strictEqual(h.type, "shop_handoff");
    assert.deepStrictEqual(h.groups.map((g) => [g.app, g.label, g.pkg, g.items.map((i) => i.name)]), [
      ["blinkit", "Blinkit", "com.grofers.customerapp", ["Milk", "Bread"]],
      ["amazon", "Amazon", "in.amazon.mShop.android.shopping", ["Dolo 650", "Phone charger"]],
      ["myntra", "Myntra", "com.myntra.android", ["Kurti"]],
    ]);
    const urls = h.groups.flatMap((g) => g.items.map((i) => i.url));
    assert.deepStrictEqual(urls, [
      "https://blinkit.com/s/?q=Milk",
      "https://blinkit.com/s/?q=Bread",
      "https://www.amazon.in/s?k=Dolo%20650",
      "https://www.amazon.in/s?k=Phone%20charger%20USB-C",
      "https://www.myntra.com/kurti-red-l?rawQuery=Kurti%20red%20L",
    ]);
    const kurti = h.groups[2].items[0];
    assert.strictEqual(kurti.details, "red, L");
    assert.ok(Number.isInteger(kurti.id), "ids so the app can tick lines as it goes");
    assert.strictEqual(res.data.total, 5);
    assert.strictEqual(res.data.rememberedGroceryApp, "Blinkit");
    assert.strictEqual(res.speak,
      "Opening Blinkit for milk, then Amazon and Myntra — tap the notification for the next one. You choose and pay in the app.");
    const again = await exec("shop_from_list", {}, ctxT({ approved: true }));
    assert.strictEqual(again.deviceAction.groups[0].app, "blinkit", "remembered: not asked again");
    assert.strictEqual(again.data.rememberedGroceryApp, null);
    const mem = await db.one("SELECT fact FROM agent_memories WHERE user_id = $1 AND fact LIKE 'User''s usual grocery app%'", [T]);
    assert.strictEqual(mem.fact, "User's usual grocery app is Blinkit.");
  });

  await atest("shop_from_list: one named app, only some items, unknown items, one item", async () => {
    let res = await exec("shop_from_list", { app: "Amazon" }, ctxT({ approved: true }));
    assert.deepStrictEqual(res.deviceAction.groups.map((g) => [g.app, g.items.length]), [["amazon_fresh", 2], ["amazon", 3]]);
    assert.strictEqual(res.deviceAction.groups[0].items[0].url, "https://www.amazon.in/s?k=Milk&i=nowstore");
    res = await exec("shop_from_list", { items: ["kurti"] }, ctxT({ approved: true }));
    assert.deepStrictEqual(res.deviceAction.groups.map((g) => g.app), ["myntra"]);
    assert.strictEqual(res.speak, "Opening Myntra for kurti. You choose and pay in the app.");
    res = await exec("shop_from_list", { items: ["unicorn"] }, ctxT());
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /unicorn is not on the shopping list — ask whether to add it first/);
  });

  await atest("shop_from_list: NEVER a payment app — asked or approved", async () => {
    for (const args of [{ app: "PhonePe" }, { app: "Google Pay" }, { grocery_app: "Paytm" }, { app: "Amazon Pay" }]) {
      for (const approved of [false, true]) {
        const res = await exec("shop_from_list", args, ctxT({ approved }));
        assert.strictEqual(res.ok, false, JSON.stringify(args));
        assert.ok(!res.deviceAction && !res.needsConfirmation, "nothing opened, nothing to confirm");
        assert.match(res.error, /payment app/);
        assert.match(res.error, /Never open a payment or UPI app/);
      }
    }
    const unknown = await exec("shop_from_list", { app: "DMart" }, ctxT({ approved: true }));
    assert.strictEqual(unknown.ok, false);
    assert.match(unknown.error, /can't open DMart/);
    const old = await exec("shop_from_list", {}, ctxT({ approved: true, appBuild: 120, deviceCaps: CAPS(120) }));
    assert.strictEqual(old.ok, false, "needs build 124");
    assert.ok(!old.deviceAction);
  });

  await atest("shopping_list_clear: bought lines at once; everything only after a yes", async () => {
    let res = await exec("shopping_list_clear", {}, ctxT());
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.removed, 1, "the ticked onions");
    assert.match(res.speak, /Cleared 1 bought item\./);
    res = await exec("shopping_list_clear", { scope: "all" }, ctxT());
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.needsConfirmation, true);
    assert.strictEqual(res.tool, "shopping_list_clear_all");
    assert.deepStrictEqual(res.args, {});
    assert.strictEqual(res.summary, "Clear your whole shopping list (5 items)");
    assert.strictEqual((await shopStore.list(T)).length, 5, "nothing cleared yet");
    res = await exec("shopping_list_clear_all", {}, ctxT());
    assert.strictEqual(res.needsConfirmation, true, "calling it directly asks too");
    assert.strictEqual(res.summary, "Clear your whole shopping list (5 items)");
    assert.strictEqual((await shopStore.list(T)).length, 5);
    res = await exec("shopping_list_clear_all", {}, ctxT({ approved: true }));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.removed, 5);
    assert.strictEqual((await shopStore.list(T)).length, 0);
    res = await exec("shopping_list_clear", { scope: "all" }, ctxT());
    assert.strictEqual(res.ok, true);
    assert.match(res.speak, /already empty/);
    res = await exec("shopping_list_clear_all", {}, ctxT());
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /already empty/);
    const bg = await exec("shopping_list_clear_all", {}, ctxT({ approved: true, background: true }));
    assert.strictEqual(bg.ok, false, "never unattended");
  });

  await atest("pantry_update: have / out remembered ('out' wins a tie); offers to add what ran out", async () => {
    const res = await exec("pantry_update", { have: ["eggs", "paneer", "curd"], out: ["rice", "dahi"] }, ctxT());
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.match(res.speak, /^Noted you have eggs and paneer\. Noted you're out of rice and dahi\.$/);
    assert.match(res.note, /offer to add/);
    const st = Object.fromEntries((await kStore.getPantry(T)).map((p) => [p.name, p.status]));
    assert.deepStrictEqual(st, { Dahi: "out", Eggs: "have", Paneer: "have", Rice: "out" });
    const none = await exec("pantry_update", {}, ctxT());
    assert.ok(none.needsArgs);
    assert.strictEqual((await shopStore.list(T)).length, 0, "the pantry never adds to the list by itself");
  });

  console.log(`\n${passed} checks passed`);
  server.close();
  await sleep(300);
  for (const t of ["shopping_items", "kitchen_pantry", "kitchen_recipes", "kitchen_plans", "agent_memories",
    "user_instructions", "contacts", "executed_actions", "actions_log"]) {
    await db.run(`DELETE FROM ${t} WHERE user_id = ANY($1)`, [users]).catch((e) => console.warn(`cleanup ${t}:`, e.message));
  }
  await db.run("DELETE FROM users WHERE id = ANY($1)", [users]).catch((e) => console.warn("cleanup users:", e.message));
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
