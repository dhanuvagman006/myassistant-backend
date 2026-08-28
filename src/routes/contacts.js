/**
 * The user's address book, mirrored so server-side tools can resolve a name.
 *
 *   POST /contacts/sync  { contacts: [{name, phone}, …] }  → { stored }
 *   GET  /contacts/count                                   → { count }
 *
 * WHY THIS EXISTS: "tell mom I'll be late" is resolved by a tool running on
 * the server, inside the live model's turn. It cannot pause to ask the
 * handset who "mom" is, so the mapping has to be here already.
 *
 * WHAT IS STORED: names and numbers only, nothing else the address book
 * holds — no emails, photos, addresses or notes. Numbers are normalised to
 * E.164 on the way in, because matching them against registered users is an
 * exact-string comparison. Entries without a usable number are dropped
 * rather than stored as junk that can never match.
 *
 * This is kept separate from `clients`, which is the user's own curated
 * case-file list. Merging a whole phonebook into it would bury the handful
 * of records they actually maintain.
 */
const express = require("express");
const db = require("../db");
const { normalizePhone } = require("../users/phone");

const router = express.Router();

/// Bound on one sync so a large address book cannot become a huge request.
const MAX_CONTACTS = 5000;

async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id         BIGSERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      name       TEXT NOT NULL,
      phone      TEXT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_user_phone
      ON contacts (user_id, phone);
    CREATE INDEX IF NOT EXISTS idx_contacts_user_name
      ON contacts (user_id, lower(name));
  `);
}

router.post("/sync", async (req, res) => {
  const uid = Number(req.user?.sub);
  if (!Number.isFinite(uid)) return res.status(401).json({ error: "unauthorized" });

  const list = Array.isArray(req.body?.contacts) ? req.body.contacts : null;
  if (!list) return res.status(400).json({ error: "contacts array required" });

  await migrate();

  // Collapse by number first: one person is often several address-book rows
  // (mobile, home, WhatsApp), and inserting each would fight the unique
  // index row by row.
  const byPhone = new Map();
  for (const c of list.slice(0, MAX_CONTACTS)) {
    const phone = normalizePhone(c?.phone);
    const name = String(c?.name ?? "").trim().slice(0, 120);
    if (!phone || !name) continue;
    byPhone.set(phone, name);
  }
  if (byPhone.size === 0) return res.json({ stored: 0 });

  const now = Date.now();
  const values = [];
  const params = [];
  let i = 1;
  for (const [phone, name] of byPhone) {
    values.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
    params.push(uid, name, phone, now);
  }

  // A re-sync should reflect renames, so the name is refreshed on conflict.
  await db.query(
    `INSERT INTO contacts (user_id, name, phone, updated_at)
     VALUES ${values.join(",")}
     ON CONFLICT (user_id, phone)
     DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`,
    params
  );

  res.json({ stored: byPhone.size });
});

router.get("/count", async (req, res) => {
  await migrate();
  const row = await db.one(
    `SELECT count(*)::int AS count FROM contacts WHERE user_id = $1`,
    [Number(req.user?.sub)]
  );
  res.json({ count: row?.count ?? 0 });
});

module.exports = router;
module.exports.migrate = migrate;
