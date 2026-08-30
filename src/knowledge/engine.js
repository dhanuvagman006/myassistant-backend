/**
 * KNOWLEDGE ENGINE — retrieval built for a voice assistant's latency budget.
 *
 * WHERE THE TIME WENT BEFORE
 * --------------------------
 * The first version of this (the legal corpus) cost three sequential API
 * round-trips per question: the outer model deciding to call the tool, an
 * embedding call for the query, and then a SECOND model call inside the
 * tool to compose the answer — whose output the outer model then had to
 * turn into speech anyway. On a spoken interface that is roughly two extra
 * seconds of silence, and it would have multiplied by every domain added.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * 1. THE CORPUS LIVES IN MEMORY. A few hundred entries with 768-float
 *    vectors is a couple of megabytes. Loading once at boot turns every
 *    retrieval into an in-process scan — no Postgres round-trip, no JSON
 *    parse, no connection wait on the critical path of a spoken turn.
 *
 * 2. LEXICAL FIRST, AND OFTEN LEXICAL ONLY. An IDF-weighted token score
 *    runs in well under a millisecond. When it is DECISIVE — the user
 *    quoted a section number, a scheme name, a form number — the answer is
 *    already found and the embedding call is skipped entirely. That is the
 *    single biggest saving: the exact-citation questions cost zero API
 *    calls to retrieve.
 *
 * 3. THE EMBEDDING IS CACHED. Repeated and near-repeated questions ("what
 *    about 498A", asked again two turns later) reuse the vector.
 *
 * 4. NO NESTED MODEL CALL. This module returns FACTS plus the rules for
 *    using them. The outer agent loop composes the spoken answer in the
 *    call it was always going to make. One whole LLM round-trip removed
 *    from every domain question.
 *
 * Net: a citation lookup does zero extra API calls; a natural-language
 * question does one (the embedding), down from three.
 */
const { query, one, run } = require("../db");
const { embed, embedOne } = require("../memory/embeddings");

/* ------------------------------------------------------------------ *
 * PACKS
 * ------------------------------------------------------------------ */

function allPacks() {
  return [
    require("./packs/legal"),
    require("./packs/govt"),
    require("./packs/money"),
    require("./packs/health"),
    require("./packs/travel"),
  ];
}

/** Every entry from every pack, flattened. */
function allEntries() {
  const out = [];
  for (const p of allPacks()) {
    for (const e of p.ENTRIES) out.push({ ...e, domain: e.domain || p.DOMAIN });
  }
  return out;
}

const DOMAINS = ["legal", "govt", "money", "health", "travel"];

/* ------------------------------------------------------------------ *
 * IN-MEMORY INDEX
 * ------------------------------------------------------------------ */

/** @type {{entries:Array, df:Map<string,number>, n:number, loadedAt:number}|null} */
let INDEX = null;

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "was", "for",
  "on", "at", "by", "with", "my", "me", "i", "it", "this", "that", "what",
  "how", "do", "does", "can", "if", "be", "been", "from", "as", "have", "has",
  "you", "your", "we", "they", "he", "she", "his", "her", "them", "will",
  "should", "would", "about", "there", "not", "no", "any", "all",
  // Function words that carry no topic signal but were scoring matches:
  // "without" pulled a cardiac first-aid entry into an arrest-rights query.
  "without", "when", "where", "who", "why", "which", "into", "out", "up",
]);

function tokenize(s) {
  // Parentheses are SEPARATORS, not part of a token. Statute references are
  // written "318(4)" and "115(2)", and a user asking about "BNS 318" types
  // the bare number — keeping the brackets made those one indivisible token
  // and a citation lookup scored near zero against its own entry.
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && w.length > 1 && !STOP.has(w));
}

/** The searchable text of an entry. */
function entryText(e) {
  return [
    e.source_short, e.source_title, e.ref, e.title, e.summary, e.detail,
    e.topics, e.replaces ? `formerly ${e.replaces}` : "",
  ].filter(Boolean).join(" ");
}

/**
 * Builds the in-memory index from plain entry objects.
 *
 * Split out from load() so the index can be built straight from the pack
 * files with no database — which is how the tests measure retrieval, and
 * what would let a future read-only deployment run the packs without
 * Postgres at all.
 */
function buildIndex(rows) {
  const df = new Map();
  const entries = rows.map((r) => {
    const toks = new Set(tokenize(entryText(r)));
    for (const t of toks) df.set(t, (df.get(t) || 0) + 1);
    let vec = null;
    if (r.embedding) {
      try {
        vec = Array.isArray(r.embedding) ? r.embedding : JSON.parse(r.embedding);
      } catch (_) {}
    }
    const { embedding, ...rest } = r;
    return { ...rest, _tokens: toks, _vec: vec };
  });
  return { entries, df, n: entries.length || 1, loadedAt: Date.now() };
}

/**
 * Loads the corpus into memory and builds the document-frequency table used
 * for IDF weighting. Cheap enough to call on boot and after a reseed.
 */
async function load() {
  const rows = await query(
    `SELECT id, slug, domain, source_title, source_short, ref, title, summary,
            detail, topics, replaces, source_url, status, effective, embedding
       FROM knowledge_entries`
  );

  INDEX = buildIndex(rows);
  return {
    entries: INDEX.entries.length,
    embedded: INDEX.entries.filter((e) => e._vec).length,
  };
}

function loaded() {
  return Boolean(INDEX && INDEX.entries.length);
}

/* ------------------------------------------------------------------ *
 * SEEDING
 * ------------------------------------------------------------------ */

async function seed({ reembed = false } = {}) {
  const now = Date.now();
  const entries = allEntries();
  let inserted = 0, updated = 0;

  for (const e of entries) {
    const existing = await one(
      `SELECT id, summary, detail, title FROM knowledge_entries WHERE slug=$1`,
      [e.slug]
    );
    const changed =
      !existing ||
      existing.summary !== e.summary ||
      existing.detail !== (e.detail || "") ||
      existing.title !== e.title;

    await run(
      `INSERT INTO knowledge_entries
         (slug, domain, source_title, source_short, ref, title, summary,
          detail, topics, replaces, source_url, status, effective, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (slug) DO UPDATE SET
         domain=$2, source_title=$3, source_short=$4, ref=$5, title=$6,
         summary=$7, detail=$8, topics=$9, replaces=$10, source_url=$11,
         status=$12, effective=$13, updated_at=$14,
         -- A changed entry must lose its old vector, or it stays findable
         -- by a meaning it no longer has.
         embedding = CASE WHEN $15 THEN NULL ELSE knowledge_entries.embedding END`,
      [
        e.slug, e.domain, e.source_title, e.source_short, e.ref || "", e.title,
        e.summary, e.detail || "", e.topics || "", e.replaces || "",
        e.source_url || "", e.status || "in_force", e.effective || "", now,
        changed,
      ]
    );
    if (existing) { if (changed) updated++; } else inserted++;
  }

  const embedded = await embedPending({ all: reembed });
  const stats = await load();
  return { total: entries.length, inserted, updated, embedded, ...stats };
}

/** Embeds entries with no vector. Batched; a provider failure is survivable. */
async function embedPending({ all = false, batch = 32 } = {}) {
  const rows = await query(
    all
      ? `SELECT id, source_short, source_title, ref, title, summary, detail, topics, replaces
           FROM knowledge_entries ORDER BY id`
      : `SELECT id, source_short, source_title, ref, title, summary, detail, topics, replaces
           FROM knowledge_entries WHERE embedding IS NULL ORDER BY id`
  );
  if (!rows.length) return 0;

  let done = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    let vectors = null;
    try {
      vectors = await embed(slice.map(entryText));
    } catch (_) {
      vectors = null;
    }
    if (!vectors) break; // no provider — lexical retrieval still works
    for (let j = 0; j < slice.length; j++) {
      if (!vectors[j]) continue;
      await run(`UPDATE knowledge_entries SET embedding=$1 WHERE id=$2`, [
        JSON.stringify(vectors[j]),
        slice[j].id,
      ]);
      done++;
    }
  }
  return done;
}

/* ------------------------------------------------------------------ *
 * SCORING
 * ------------------------------------------------------------------ */

/**
 * IDF-weighted overlap between the question and an entry.
 *
 * IDF matters here more than in general search: almost every legal entry
 * contains "punishment" and "section", so those words carry no signal,
 * while "498a", "gratuity" or "tatkal" identify an entry almost by
 * themselves. Weighting by rarity is what lets the lexical pass be
 * decisive often enough to skip the embedding.
 */
function lexicalScore(qTokens, entry, df, n) {
  let score = 0, matched = 0;
  for (const t of qTokens) {
    if (!entry._tokens.has(t)) continue;
    matched++;
    score += Math.log(1 + n / (1 + (df.get(t) || 0)));
  }
  if (!matched) return 0;
  // Normalise by question length so a long question isn't inherently
  // higher-scoring than a short one.
  return score / Math.sqrt(qTokens.length);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Lexical score above which we trust the match and skip the embedding.
 * Calibrated against the packs: a question that names its subject scores
 * 3.7–6, while an unrelated question tops out below 2.
 */
const DECISIVE = 3.2;

/**
 * Absolute floor for returning anything on the LEXICAL-ONLY path.
 *
 * Without this, an unrelated question still returned entries: "capital
 * gains treatment of a Liechtenstein trust" scored 1.88 against criminal
 * breach of TRUST purely on one shared word, and those entries were then
 * handed to the model as the facts to answer from. Coincidental word
 * overlap is not a match, and returning nothing is the correct answer.
 */
const MIN_LEX = 2.0;

/**
 * Relative cutoff: keep only entries close to the best one. A strong hit
 * alongside weak ones means the weak ones are noise, and noise in the fact
 * block is what makes a grounded answer drift.
 */
const REL_CUTOFF = 0.7;

/** Below this combined score a "match" is noise dressed as a fact. */
const FLOOR = 0.55;

/** Applies both floors to a ranked lexical list. */
function trimLexical(ranked) {
  if (!ranked.length) return [];
  const top = ranked[0].lex;
  if (top < MIN_LEX) return [];
  const cut = Math.max(MIN_LEX, top * REL_CUTOFF);
  return ranked.filter((x) => x.lex >= cut);
}

/* ------------------------------------------------------------------ *
 * QUERY EMBEDDING CACHE
 * ------------------------------------------------------------------ */

const VEC_CACHE = new Map(); // normalised question -> vector
const VEC_CACHE_MAX = 200;

async function queryVector(text) {
  const key = text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
  if (VEC_CACHE.has(key)) return VEC_CACHE.get(key);
  let v = null;
  try {
    v = await embedOne(text);
  } catch (_) {
    v = null;
  }
  if (v) {
    if (VEC_CACHE.size >= VEC_CACHE_MAX) VEC_CACHE.delete(VEC_CACHE.keys().next().value);
    VEC_CACHE.set(key, v);
  }
  return v;
}

/* ------------------------------------------------------------------ *
 * RETRIEVAL
 * ------------------------------------------------------------------ */

/**
 * Finds entries relevant to a question.
 *
 * @param {string} q
 * @param {{domain?:string|null, limit?:number}} opts
 * @returns {Promise<{entries:Array, ms:number, usedEmbedding:boolean}>}
 *
 * An EMPTY entries array means the packs do not cover this. Callers must
 * report that rather than letting the model answer from its own memory —
 * that is the whole reason this layer exists.
 */
async function retrieve(q, { domain = null, limit = 6 } = {}) {
  const started = Date.now();
  const text = String(q || "").trim();
  if (!text) return { entries: [], ms: 0, usedEmbedding: false };
  if (!loaded()) {
    try {
      await load();
    } catch (_) {
      return { entries: [], ms: Date.now() - started, usedEmbedding: false };
    }
  }

  const { df, n } = INDEX;
  const pool = domain
    ? INDEX.entries.filter((e) => e.domain === domain)
    : INDEX.entries;
  const qTokens = tokenize(text);

  // Pass 1 — lexical, in process, sub-millisecond.
  const lex = [];
  for (const e of pool) {
    const s = lexicalScore(qTokens, e, df, n);
    if (s > 0) lex.push({ e, lex: s });
  }
  lex.sort((a, b) => b.lex - a.lex);

  // FAST PATH: the question named something specific enough to identify the
  // entry on its own. No embedding call, no network, done in about a
  // millisecond. This covers every "what is BNS 318" / "Tatkal timing" /
  // "PAN correction form" question.
  if (lex.length && lex[0].lex >= DECISIVE) {
    return {
      entries: trimLexical(lex).slice(0, limit).map(({ e, lex: l }) => strip(e, l, null)),
      ms: Date.now() - started,
      usedEmbedding: false,
    };
  }

  // Pass 2 — semantic. Only reached for genuinely fuzzy phrasing, and the
  // one API call on this path is cached.
  const vec = await queryVector(text);
  if (!vec) {
    // No embedding provider (or it failed): lexical order is the best we
    // honestly have. Degraded, not broken.
    return {
      entries: trimLexical(lex).slice(0, limit).map(({ e, lex: l }) => strip(e, l, null)),
      ms: Date.now() - started,
      usedEmbedding: false,
    };
  }

  const scored = [];
  const lexBy = new Map(lex.map((x) => [x.e.slug, x.lex]));
  for (const e of pool) {
    if (!e._vec) continue;
    const sim = cosine(vec, e._vec);
    const l = lexBy.get(e.slug) || 0;
    // Blend: semantic carries the meaning, lexical rescues exact terms the
    // embedding flattens (numbers, form names, statute abbreviations).
    const combined = sim + Math.min(l, 3) * 0.12;
    if (combined < FLOOR) continue;
    scored.push({ e, combined, sim, lex: l });
  }
  scored.sort((a, b) => b.combined - a.combined);

  return {
    entries: scored.slice(0, limit).map(({ e, lex: l, sim }) => strip(e, l, sim)),
    ms: Date.now() - started,
    usedEmbedding: true,
  };
}

/** Public shape — internal tokens and vectors never leave this module. */
function strip(e, lex, sim) {
  const { _tokens, _vec, ...rest } = e;
  return { ...rest, _lex: Number(lex.toFixed(3)), _sim: sim === null ? null : Number(sim.toFixed(3)) };
}

async function stats() {
  if (!loaded()) {
    try {
      await load();
    } catch (_) {
      return { total: 0, embedded: 0, byDomain: {} };
    }
  }
  const byDomain = {};
  for (const e of INDEX.entries) byDomain[e.domain] = (byDomain[e.domain] || 0) + 1;
  return {
    total: INDEX.entries.length,
    embedded: INDEX.entries.filter((e) => e._vec).length,
    byDomain,
  };
}

module.exports = {
  DOMAINS,
  seed,
  load,
  loaded,
  retrieve,
  stats,
  embedPending,
  allEntries,
  allPacks,
  // exported for tests
  tokenize,
  lexicalScore,
  buildIndex,
  entryText,
  DECISIVE,
  MIN_LEX,
  REL_CUTOFF,
  FLOOR,
  trimLexical,
  _index: () => INDEX,
  _setIndex: (i) => { INDEX = i; },
};
