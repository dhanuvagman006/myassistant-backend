/**
 * SHOPPING LIST — PERSISTENCE. One list per user for ANYTHING they want to
 * buy: groceries, a dress, a phone charger, medicines, a gift.
 *
 *   shopping_items   one row per line. name_key is the merge key
 *                    (normalize.nameKey); quantity/unit is the line's first
 *                    amount and `extra` holds the others, so "1 kg" plus
 *                    "2 pieces" stays one line with both amounts.
 *
 * MERGING (addItems):
 *   groceries   same key -> one line; the same unit adds up (g+kg, ml+l
 *               convert), another unit is a second amount; "milk" said
 *               again with no amount changes nothing.
 *   the rest    one line only when the name AND the details match (a blue
 *               M kurti and a red L kurti are two lines); the same thing
 *               again with no new detail bumps the count.
 *   A bought (checked) line said again comes back unticked with the new
 *   amount — they need it again.
 *
 * Every query is scoped by user_id: another user's id is "not found".
 * Tables are created lazily with a cached migrate(), like shortcuts/store.js.
 */
const { query, one, run, tx } = require("../db");
const N = require("./normalize");

const LIMITS = Object.freeze({
  items: 300, perRequest: 50, name: 80, details: 200, note: 200, link: 500, store: 40, recipe: 120,
});
const SOURCES = ["voice", "recipe", "plan", "manual"];
// pg_advisory_xact_lock(namespace, user): one writer per user's list.
const LOCK_NS = 7401;

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS shopping_items (
        id           BIGSERIAL PRIMARY KEY,
        user_id      INTEGER NOT NULL,
        name         TEXT    NOT NULL,
        name_key     TEXT    NOT NULL,
        quantity     DOUBLE PRECISION,
        unit         TEXT,
        extra        JSONB   NOT NULL DEFAULT '[]'::jsonb,
        details      TEXT    NOT NULL DEFAULT '',
        details_key  TEXT    NOT NULL DEFAULT '',
        link         TEXT,
        store        TEXT,
        note         TEXT    NOT NULL DEFAULT '',
        category     TEXT    NOT NULL DEFAULT 'other',
        recipe       TEXT,
        source       TEXT    NOT NULL DEFAULT 'manual',
        checked      BOOLEAN NOT NULL DEFAULT false,
        created_at   BIGINT  NOT NULL,
        updated_at   BIGINT  NOT NULL
      );
      CREATE INDEX IF NOT EXISTS shopping_items_user ON shopping_items (user_id, checked, id);
      CREATE INDEX IF NOT EXISTS shopping_items_key ON shopping_items (user_id, name_key);
    `).catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

class ShoppingError extends Error {
  constructor(code, message, data = {}) {
    super(message || code);
    this.code = code;
    this.data = data;
  }
}

/* ------------------------------------------------------------------ */
/* INPUT                                                                */
/* ------------------------------------------------------------------ */

/** Cut to `max` characters at a word boundary (the lenient path). */
function cut(s, max) {
  if (s.length <= max) return s;
  const t = s.slice(0, max + 1);
  const at = t.lastIndexOf(" ");
  return (at > max / 2 ? t.slice(0, at) : s.slice(0, max)).trim();
}

/** https only, no credentials, <= 500 characters; null when unusable. */
function cleanLink(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s.length > LIMITS.link) return null;
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    return null;
  }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
  return u.toString();
}

/**
 * One incoming line, checked and tidied. `strict` (REST) turns anything
 * unusable into a ShoppingError with a clear message; the lenient path (a
 * voice tool) trims, drops or infers instead — a spoken request should
 * not fail on a long name or an odd unit.
 */
function cleanItem(raw, { strict = true, index = 0 } = {}) {
  const at = strict ? ` (item ${index + 1})` : "";
  const fail = (code, message) => {
    throw new ShoppingError(code, message + at, { index });
  };
  if (typeof raw === "string") raw = { name: raw };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("bad_item", "Each item must be an object with a name");

  let name = N.cleanName(raw.name);
  if (!name) fail("name_required", "Each item needs a name");
  if (name.length > LIMITS.name) {
    if (strict) fail("name_too_long", `A name can be at most ${LIMITS.name} characters`);
    name = cut(name, LIMITS.name);
  }

  // A spoken "2 kg" in the quantity (the lenient path): number and unit.
  let q0 = raw.quantity;
  let u0 = raw.unit;
  if (!strict && typeof q0 === "string" && (u0 === undefined || u0 === null || u0 === "")) {
    const m = q0.trim().match(/^(\d+(?:[.,]\d+)?|\d+\/\d+|[½¼¾])\s*([\p{L}][\p{L}.]*)$/u);
    if (m) [q0, u0] = [m[1], m[2]];
  }
  let quantity = N.parseQuantity(q0);
  if (quantity === undefined) {
    if (strict) fail("bad_quantity", `quantity must be a number above 0 and at most ${N.MAX_QTY}, or null`);
    quantity = null;
  }
  let unit = N.normalizeUnit(u0);
  if (unit === undefined) {
    if (strict) fail("bad_unit", `unit must be a word of at most ${N.MAX_UNIT} letters, like g, kg, ml, l, pcs or packet`);
    unit = null;
  }
  if (unit && quantity === null) quantity = 1; // "a bunch of coriander"

  const text = (key, max) => {
    let v = N.cleanText(raw[key]);
    if (v.length > max) {
      if (strict) fail(`${key}_too_long`, `${key} can be at most ${max} characters`);
      v = cut(v, max);
    }
    return v;
  };
  const details = text("details", LIMITS.details);
  const note = text("note", LIMITS.note);
  const store = text("store", LIMITS.store) || null;
  const recipe = text("recipe", LIMITS.recipe) || null;

  let link = null;
  if (raw.link !== undefined && raw.link !== null && String(raw.link).trim() !== "") {
    link = cleanLink(raw.link);
    if (!link && strict) fail("bad_link", `link must be an https:// address of at most ${LIMITS.link} characters`);
  }

  let category = null;
  if (raw.category !== undefined && raw.category !== null && String(raw.category).trim() !== "") {
    category = N.normalizeCategory(raw.category);
    if (!category && strict) {
      fail("bad_category", `category must be one of: ${N.CATEGORY_IDS.join(", ")}`);
    }
  }

  return {
    name, key: N.nameKey(name), quantity, unit,
    details, detailsKey: N.detailsKey(details), note, link, store, category, recipe,
  };
}

/* ------------------------------------------------------------------ */
/* ROWS                                                                 */
/* ------------------------------------------------------------------ */

function lineOf(r) {
  return {
    id: Number(r.id),
    name: r.name,
    key: r.name_key,
    amounts: [{ quantity: r.quantity === null ? null : Number(r.quantity), unit: r.unit || null }, ...(r.extra || [])],
    details: r.details || "",
    detailsKey: r.details_key || "",
    link: r.link || null,
    store: r.store || null,
    note: r.note || "",
    category: r.category || "other",
    recipe: r.recipe || null,
    source: r.source,
    checked: !!r.checked,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** The public ShoppingItem. */
function itemOf(l) {
  const [first] = l.amounts;
  return {
    id: l.id,
    name: l.name,
    quantity: first.quantity,
    unit: first.unit,
    amounts: l.amounts.filter((a) => a.quantity !== null),
    amountText: N.amountText(l.amounts),
    details: l.details,
    link: l.link,
    store: l.store,
    note: l.note,
    category: l.category,
    recipe: l.recipe,
    source: l.source,
    checked: l.checked,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

/** Unticked first, then by category, then in the order added. */
function sortItems(items) {
  return items.sort((a, b) =>
    (a.checked - b.checked) ||
    (N.categoryOrder(a.category) - N.categoryOrder(b.category)) ||
    (a.createdAt - b.createdAt) || (a.id - b.id));
}

function uidOf(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) throw new ShoppingError("no_account", "A signed-in user is required");
  return id;
}

async function list(userId) {
  const uid = uidOf(userId);
  await migrate();
  const rows = await query("SELECT * FROM shopping_items WHERE user_id = $1", [uid]);
  return sortItems(rows.map((r) => itemOf(lineOf(r))));
}

async function get(userId, id) {
  const uid = uidOf(userId);
  await migrate();
  const r = await one("SELECT * FROM shopping_items WHERE user_id = $1 AND id = $2", [uid, id]);
  return r ? itemOf(lineOf(r)) : null;
}

/** The newest change to the list (null when it is empty). */
function updatedAtOf(items) {
  return items.length ? Math.max(...items.map((i) => i.updatedAt)) : null;
}

/* ------------------------------------------------------------------ */
/* ADD, WITH MERGING                                                    */
/* ------------------------------------------------------------------ */

const joinText = (a, b, max, sep = "; ") => {
  if (!b) return a;
  if (!a) return b;
  if (a.toLowerCase().includes(b.toLowerCase())) return a;
  return cut(`${a}${sep}${b}`, max);
};

/**
 * Adds cleaned items (cleanItem) to the user's list, merging as described
 * at the top. Throws ShoppingError("list_full") — and writes nothing —
 * when the new lines would take the list past LIMITS.items.
 * Returns { added: [ShoppingItem], merged: [ShoppingItem], items: [all] }.
 */
async function addItems(userId, inputs, { source = "manual" } = {}) {
  const uid = uidOf(userId);
  if (!SOURCES.includes(source)) throw new ShoppingError("bad_source", `source must be one of: ${SOURCES.join(", ")}`);
  if (!Array.isArray(inputs) || !inputs.length) throw new ShoppingError("no_items", "Give at least one item");
  if (inputs.length > LIMITS.perRequest) {
    throw new ShoppingError("too_many_items", `At most ${LIMITS.perRequest} items at a time`);
  }
  await migrate();

  return tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock($1, $2)", [LOCK_NS, uid]);
    const lines = (await c.query("SELECT * FROM shopping_items WHERE user_id = $1 ORDER BY id", [uid])).rows.map(lineOf);
    const now = Date.now();
    const touched = new Set(); // existing lines changed
    const fresh = new Set(); // lines created (or brought back) by this call
    let tmp = 0;

    for (const it of inputs) {
      const same = lines.filter((l) => l.key === it.key);
      const open = same.filter((l) => !l.checked);
      const category = it.category || (open[0] && open[0].category) || N.categoryOf(it.name, it.details);
      const grocery = N.isGroceryCategory(category);

      let target = null;
      if (grocery) target = open[0] || null;
      else {
        target = open.find((l) => l.detailsKey === it.detailsKey) || null;
        if (!target && it.detailsKey === "" && open.length === 1) target = open[0];
      }

      if (target) {
        target.amounts = N.combine(target.amounts, it, { countable: !grocery });
        if (grocery && it.details) {
          target.details = joinText(target.details, it.details, LIMITS.details);
          target.detailsKey = N.detailsKey(target.details);
        }
        if (it.link) target.link = it.link;
        if (it.store) target.store = it.store;
        target.note = joinText(target.note, it.note, LIMITS.note);
        target.recipe = joinText(target.recipe || "", it.recipe || "", LIMITS.recipe, ", ") || null;
        if (it.category) target.category = it.category;
        target.updatedAt = now;
        if (!fresh.has(target)) touched.add(target);
        continue;
      }

      // Bought already, and needed again: the same row comes back.
      const done = same.filter((l) => l.checked);
      const again = grocery ? done[0] : done.find((l) => l.detailsKey === it.detailsKey);
      if (again) {
        Object.assign(again, {
          checked: false,
          amounts: [{ quantity: it.quantity, unit: it.unit }],
          details: it.details || again.details,
          link: it.link || again.link,
          store: it.store || again.store,
          note: it.note,
          recipe: it.recipe,
          source,
          category,
          updatedAt: now,
        });
        again.detailsKey = N.detailsKey(again.details);
        fresh.add(again);
        touched.delete(again);
        continue;
      }

      if (lines.length + 1 > LIMITS.items) {
        throw new ShoppingError(
          "list_full",
          `The shopping list is full (${LIMITS.items} items). Clear the bought items or remove some first`,
          { limit: LIMITS.items }
        );
      }
      const line = {
        id: null, tmp: ++tmp, name: it.name, key: it.key,
        amounts: [{ quantity: it.quantity, unit: it.unit }],
        details: it.details, detailsKey: it.detailsKey, link: it.link, store: it.store,
        note: it.note, category, recipe: it.recipe, source, checked: false,
        createdAt: now, updatedAt: now,
      };
      lines.push(line);
      fresh.add(line);
    }

    const write = async (l) => {
      const [first, ...extra] = l.amounts;
      const vals = [
        l.name, l.key, first.quantity, first.unit, JSON.stringify(extra), l.details, l.detailsKey,
        l.link, l.store, l.note, l.category, l.recipe, l.checked, l.updatedAt,
      ];
      if (l.id === null) {
        const r = await c.query(
          `INSERT INTO shopping_items
             (name, name_key, quantity, unit, extra, details, details_key, link, store, note,
              category, recipe, checked, updated_at, user_id, source, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$14) RETURNING id`,
          [...vals, uid, l.source]
        );
        l.id = Number(r.rows[0].id);
      } else {
        await c.query(
          `UPDATE shopping_items SET name=$1, name_key=$2, quantity=$3, unit=$4, extra=$5, details=$6,
                  details_key=$7, link=$8, store=$9, note=$10, category=$11, recipe=$12, checked=$13,
                  updated_at=$14, source=$16
            WHERE id=$15 AND user_id=$17`,
          [...vals, l.id, l.source, uid]
        );
      }
    };
    for (const l of [...fresh, ...touched]) await write(l);

    return {
      added: [...fresh].map(itemOf),
      merged: [...touched].map(itemOf),
      items: sortItems(lines.map(itemOf)),
    };
  });
}

/* ------------------------------------------------------------------ */
/* CHANGE, REMOVE, CLEAR                                                */
/* ------------------------------------------------------------------ */

/**
 * Changes one line. `patch` is already checked (routes.cleanPatch or the
 * tools); a new quantity/unit replaces all of the line's amounts, and a
 * new name without a category re-files it. null when it is not theirs.
 */
async function update(userId, id, patch) {
  const uid = uidOf(userId);
  await migrate();
  return tx(async (c) => {
    const r = (await c.query("SELECT * FROM shopping_items WHERE user_id = $1 AND id = $2 FOR UPDATE", [uid, id])).rows[0];
    if (!r) return null;
    const l = lineOf(r);
    if ("name" in patch) {
      l.name = patch.name;
      l.key = N.nameKey(patch.name);
      if (!("category" in patch)) l.category = N.categoryOf(l.name, "details" in patch ? patch.details : l.details);
    }
    if ("quantity" in patch || "unit" in patch) {
      let q = "quantity" in patch ? patch.quantity : l.amounts[0].quantity;
      let u = "unit" in patch ? patch.unit : l.amounts[0].unit;
      if (q === null && "quantity" in patch && !("unit" in patch)) u = null; // cleared
      if (u && q === null) q = 1;
      l.amounts = [{ quantity: q, unit: u }];
    }
    if ("details" in patch) {
      l.details = patch.details;
      l.detailsKey = N.detailsKey(patch.details);
    }
    for (const k of ["link", "store", "note", "category", "checked"]) if (k in patch) l[k] = patch[k];
    l.updatedAt = Date.now();
    const [first, ...extra] = l.amounts;
    await c.query(
      `UPDATE shopping_items SET name=$3, name_key=$4, quantity=$5, unit=$6, extra=$7, details=$8,
              details_key=$9, link=$10, store=$11, note=$12, category=$13, checked=$14, updated_at=$15
        WHERE user_id=$1 AND id=$2`,
      [uid, id, l.name, l.key, first.quantity, first.unit, JSON.stringify(extra), l.details,
        l.detailsKey, l.link, l.store, l.note, l.category, l.checked, l.updatedAt]
    );
    return itemOf(l);
  });
}

async function remove(userId, id) {
  const uid = uidOf(userId);
  await migrate();
  return (await run("DELETE FROM shopping_items WHERE user_id = $1 AND id = $2", [uid, id])) > 0;
}

async function removeMany(userId, ids) {
  const uid = uidOf(userId);
  if (!ids.length) return 0;
  await migrate();
  return run("DELETE FROM shopping_items WHERE user_id = $1 AND id = ANY($2::bigint[])", [uid, ids]);
}

async function setChecked(userId, ids, checked) {
  const uid = uidOf(userId);
  if (!ids.length) return 0;
  await migrate();
  return run(
    "UPDATE shopping_items SET checked = $3, updated_at = $4 WHERE user_id = $1 AND id = ANY($2::bigint[])",
    [uid, ids, !!checked, Date.now()]
  );
}

/** Removes the bought lines, or everything. Returns how many went. */
async function clear(userId, { checkedOnly }) {
  const uid = uidOf(userId);
  await migrate();
  return run(
    "DELETE FROM shopping_items WHERE user_id = $1 AND (checked OR NOT $2::boolean)",
    [uid, !!checkedOnly]
  );
}

/* ------------------------------------------------------------------ */
/* FINDING A LINE BY WHAT WAS SAID                                      */
/* ------------------------------------------------------------------ */

const SAID_STOP = new Set(("the a an my our some all of for from to and or it this that these those " +
  "please list shopping item items bought buy got get remove delete tick untick off").split(" "));

/**
 * The line(s) a spoken name means: an exact key first, then shared words
 * across name and details ("the blue kurti"). Returns {item}, or
 * {candidates} when it could be more than one, or {} for none.
 */
function findBySaid(items, said) {
  const kept = N.words(said).filter((w) => !SAID_STOP.has(w));
  if (!kept.length) return {};
  const key = N.nameKey(kept.join(" "));
  const exact = items.filter((i) => N.nameKey(i.name) === key);
  if (exact.length === 1) return { item: exact[0] };
  if (exact.length > 1) return { candidates: exact };

  const want = [...new Set(kept.map(N.singular))];
  const scored = [];
  for (const i of items) {
    const have = new Set([
      ...N.words(i.name), ...N.words(i.details), ...N.nameKey(i.name).split(" "),
    ].map(N.singular));
    const hit = want.filter((w) => have.has(w)).length;
    if (hit) scored.push({ i, hit });
  }
  if (!scored.length) return {};
  const best = Math.max(...scored.map((s) => s.hit));
  const top = scored.filter((s) => s.hit === best).map((s) => s.i);
  if (top.length > 1) return { candidates: top };
  return best >= Math.ceil(want.length / 2) ? { item: top[0] } : {};
}

module.exports = {
  migrate, LIMITS, SOURCES, ShoppingError,
  cleanItem, cleanLink, cut,
  list, get, updatedAtOf, addItems, update, remove, removeMany, setChecked, clear,
  findBySaid, sortItems,
};
