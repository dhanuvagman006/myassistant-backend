/**
 * FINANCE SECTION — the user's money map, editable from the app screen
 * and by voice (add_finance_item / get_finance_plan tools).
 *
 *   kind 'income'  — expected inflow  (salary, client payment…)
 *   kind 'emi'     — a loan instalment: monthly amount + interest rate +
 *                    outstanding principal (both optional but they make
 *                    the planning real)
 *   kind 'expense' — a recurring outflow (rent, school fees…)
 *
 * due_day = day of month (1-31) the item hits, 0 = unspecified.
 * All amounts are rupees as entered; nothing here moves money — it is a
 * ledger the user maintains so the assistant can PLAN, not a bank link.
 *
 *   GET    /finance        → { items:[...], summary:{...} }
 *   POST   /finance        { kind,name,amount,interest_rate?,due_day?,outstanding? }
 *   PATCH  /finance/:id    same fields, partial
 *   DELETE /finance/:id
 */
const router = require("express").Router();
const db = require("../db");

let ready;
async function ensure() {
  if (!ready) {
    ready = db.query(`
      CREATE TABLE IF NOT EXISTS finance_items (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL,
        kind          TEXT NOT NULL,
        name          TEXT NOT NULL,
        amount        NUMERIC NOT NULL,
        interest_rate NUMERIC DEFAULT 0,
        due_day       INTEGER DEFAULT 0,
        outstanding   NUMERIC DEFAULT 0,
        created_at    BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS finance_items_user ON finance_items(user_id);
    `);
  }
  return ready;
}

function uid(req, res) {
  const id = Number(req.user?.sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "sign in required" });
    return null;
  }
  return id;
}

const KINDS = new Set(["income", "emi", "expense"]);

function clean(body = {}, partial = false) {
  const out = {};
  const set = (k, v) => {
    if (v !== undefined) out[k] = v;
  };
  if (!partial || body.kind !== undefined) {
    const kind = String(body.kind || "").toLowerCase();
    if (!KINDS.has(kind)) return { error: "kind must be income, emi or expense" };
    set("kind", kind);
  }
  if (!partial || body.name !== undefined) {
    const name = String(body.name || "").trim().slice(0, 80);
    if (!name) return { error: "name required" };
    set("name", name);
  }
  if (!partial || body.amount !== undefined) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return { error: "amount must be positive" };
    set("amount", Math.round(amount * 100) / 100);
  }
  const rate = Number(body.interest_rate);
  if (Number.isFinite(rate) && rate >= 0 && rate <= 100) set("interest_rate", rate);
  const day = Number(body.due_day);
  if (Number.isInteger(day) && day >= 0 && day <= 31) set("due_day", day);
  const outAmt = Number(body.outstanding);
  if (Number.isFinite(outAmt) && outAmt >= 0) set("outstanding", outAmt);
  return { fields: out };
}

async function listItems(userId) {
  await ensure();
  const rows = await db.query(
    `SELECT id, kind, name, amount::float, interest_rate::float, due_day,
            outstanding::float
       FROM finance_items WHERE user_id=$1
      ORDER BY kind, interest_rate DESC, due_day, id`,
    [userId]
  );
  return rows;
}

function summarize(items) {
  const sum = (k) =>
    items.filter((i) => i.kind === k).reduce((s, i) => s + i.amount, 0);
  const income = sum("income");
  const emi = sum("emi");
  const expense = sum("expense");
  const debt = items
    .filter((i) => i.kind === "emi")
    .reduce((s, i) => s + (i.outstanding || 0), 0);
  return {
    monthly_income: income,
    monthly_emi: emi,
    monthly_expense: expense,
    surplus: Math.round((income - emi - expense) * 100) / 100,
    total_debt: debt,
  };
}

router.get("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const items = await listItems(id);
  res.json({ items, summary: summarize(items) });
});

router.post("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const c = clean(req.body);
  if (c.error) return res.status(400).json({ error: c.error });
  await ensure();
  const f = c.fields;
  const row = await db.one(
    `INSERT INTO finance_items
       (user_id, kind, name, amount, interest_rate, due_day, outstanding, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [id, f.kind, f.name, f.amount, f.interest_rate || 0, f.due_day || 0,
     f.outstanding || 0, Date.now()]
  );
  res.json({ ok: true, id: row.id });
});

router.patch("/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const c = clean(req.body, true);
  if (c.error) return res.status(400).json({ error: c.error });
  const keys = Object.keys(c.fields);
  if (!keys.length) return res.json({ ok: true });
  await ensure();
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
  await db.run(
    `UPDATE finance_items SET ${sets} WHERE id=$1 AND user_id=$2`,
    [Number(req.params.id), id, ...keys.map((k) => c.fields[k])]
  );
  res.json({ ok: true });
});

router.delete("/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  await ensure();
  await db.run(`DELETE FROM finance_items WHERE id=$1 AND user_id=$2`,
    [Number(req.params.id), id]);
  res.json({ ok: true });
});

module.exports = { router, listItems, summarize };
