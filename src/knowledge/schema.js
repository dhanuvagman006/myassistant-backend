/**
 * KNOWLEDGE BASE — schema.
 *
 * One table for every domain pack (law, government services, money, health,
 * travel). The alternative — a table and a retrieval path per domain — was
 * the shape the legal capability started in, and it does not scale: each
 * new domain would have added its own tool to the model's declaration list
 * and its own database round-trip to every turn.
 *
 * `domain` is a column, not a table. Retrieval filters on it when the
 * caller knows the domain and ignores it when they don't, so a question
 * that straddles two packs ("my insurance claim was rejected") can reach
 * both money and legal entries.
 *
 * NO user_id — deliberate, as with the legal corpus it replaces: this is
 * public reference material, identical for every user, and read-only to
 * them. Only the seeder and an ADMIN_KEY route write here.
 */

async function migrate(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS knowledge_entries (
      id           BIGSERIAL PRIMARY KEY,
      -- Stable key so re-seeding UPDATES rather than duplicating.
      slug         TEXT UNIQUE NOT NULL,
      -- legal | govt | money | health | travel
      domain       TEXT NOT NULL,
      -- The authority the entry rests on: an Act, a scheme, a regulator.
      source_title TEXT NOT NULL,          -- "Bharatiya Nyaya Sanhita, 2023"
      source_short TEXT NOT NULL,          -- "BNS", "UIDAI", "CBDT"
      -- Section, rule, step or clause — whatever this domain cites by.
      ref          TEXT NOT NULL DEFAULT '',
      title        TEXT NOT NULL,
      summary      TEXT NOT NULL,          -- plain language, spoken aloud
      detail       TEXT NOT NULL DEFAULT '', -- amounts, deadlines, penalties
      topics       TEXT NOT NULL DEFAULT '', -- free tags for filtering
      -- Superseded reference this replaces, e.g. "IPC 420". Indexed, so a
      -- user quoting the old identifier still lands on the right entry.
      replaces     TEXT NOT NULL DEFAULT '',
      source_url   TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'in_force',
      effective    TEXT NOT NULL DEFAULT '',
      embedding    JSONB,
      updated_at   BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_domain
      ON knowledge_entries(domain, source_short);
    CREATE INDEX IF NOT EXISTS idx_knowledge_fts
      ON knowledge_entries
      USING GIN (to_tsvector('simple',
        source_short || ' ' || source_title || ' ' || ref || ' ' || title ||
        ' ' || summary || ' ' || detail || ' ' || topics || ' ' || replaces));

    -- The legal corpus was the prototype for this table and had exactly one
    -- domain in it. Everything it held is re-seeded here from the same pack
    -- file, so the old table is redundant rather than lost.
    DROP TABLE IF EXISTS legal_provisions;
  `);
}

module.exports = { migrate };
