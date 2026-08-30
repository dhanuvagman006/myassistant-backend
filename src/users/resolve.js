/**
 * CONTACT RESOLUTION — turn "Ravi" into a number.
 *
 * The user speaks names, never digits. Any tool that reaches a person —
 * WhatsApp, an agent message, a call — needs the same lookup, and it was
 * previously written inline inside send_agent_message while the WhatsApp
 * tool simply demanded a phone number as an argument. The model has no way
 * to know a phone number, so that tool could only ever work if the user
 * recited digits out loud, which is precisely the effort we are trying to
 * remove.
 *
 * MATCHING RULES, in priority order:
 *   1. exact name match — "Ann" must never resolve to "Annabel"
 *   2. name starts with the query — "Ravi" finds "Ravi Kumar"
 *   3. name contains the query
 * Among equal matches the SHORTEST name wins, because it is the closest
 * fit. Both the synced phone address book and the user's curated client
 * list are searched, address book first.
 *
 * AMBIGUITY IS RETURNED, NOT GUESSED. Two Ravis means the caller asks
 * which one — silently picking one sends a message to the wrong person,
 * and an outbound message cannot be recalled.
 */
const { query } = require("../db");
const { normalizePhone } = require("./phone");

/**
 * @returns {Promise<{match:{name,phone,source}|null, candidates:Array}>}
 *   `match` is set when exactly one plausible contact was found.
 *   `candidates` holds 2+ when the name is ambiguous.
 */
async function resolveContact(userId, name, { limit = 5 } = {}) {
  const q = String(name || "").trim().toLowerCase();
  if (!userId || !q) return { match: null, candidates: [] };

  let rows = [];
  try {
    rows = await query(
      `SELECT name, phone, source, exact, starts, length(name) AS len FROM (
         SELECT name, phone, 'contacts' AS source,
                (lower(name) = $2)            AS exact,
                (lower(name) LIKE $3)         AS starts
           FROM contacts
          WHERE user_id = $1 AND lower(name) LIKE $4
         UNION ALL
         SELECT name, phone, 'clients' AS source,
                (lower(name) = $2)            AS exact,
                (lower(name) LIKE $3)         AS starts
           FROM clients
          WHERE user_id = $1 AND lower(name) LIKE $4 AND COALESCE(phone,'') <> ''
       ) m
       ORDER BY exact DESC, starts DESC, len ASC
       LIMIT $5`,
      [userId, q, `${q}%`, `%${q}%`, limit]
    );
  } catch (_) {
    return { match: null, candidates: [] };
  }
  // An exact match is decisive even when other names contain the query.
  const exact = rows.filter((r) => r.exact);
  if (exact.length === 1) return { match: clean(exact[0]), candidates: [] };
  if (exact.length > 1) return { match: null, candidates: exact.map(clean) };

  // Nickname tier: a contact whose WHOLE name collapses to the query —
  // "Ammmmaaa" for "amma" — is the person the user calls by that name.
  // It beats names that merely CONTAIN the query ("Dammayathi"), and SQL
  // LIKE cannot see it at all, so this runs even when rows were found.
  const collapsed = collapseRuns(q);
  if (collapsed.length >= 3) {
    try {
      const all = await query(
        `SELECT name, phone, 'contacts' AS source FROM contacts WHERE user_id = $1
         UNION ALL
         SELECT name, phone, 'clients' AS source FROM clients
          WHERE user_id = $1 AND COALESCE(phone,'') <> ''`,
        [userId]
      );
      const hits = dedupe(
        all.filter((r) => collapseRuns(String(r.name).toLowerCase()) === collapsed)
      );
      if (hits.length === 1) return { match: hits[0], candidates: [] };
      if (hits.length > 1) return { match: null, candidates: hits.slice(0, limit) };

      // Speech-to-text drops and swaps single letters ("Amba" for "Amma").
      // When nothing else matched at all, a UNIQUE contact within edit
      // distance 1 of the collapsed query is who they meant; two such
      // contacts are returned for the caller to disambiguate.
      if (!rows.length) {
        const near = dedupe(
          all.filter((r) => {
            const c = collapseRuns(String(r.name).toLowerCase());
            return (
              editDistance(c, collapsed) <= 1 ||
              editDistance(
                collapseRuns(String(r.name).toLowerCase().split(/\s+/)[0]),
                collapsed
              ) <= 1
            );
          })
        );
        if (near.length === 1) return { match: near[0], candidates: [] };
        if (near.length > 1)
          return { match: null, candidates: near.slice(0, limit) };
      }
    } catch (_) {}
  }
  if (!rows.length) return { match: null, candidates: [] };

  // Otherwise: unique on the person, not on the row — the same human often
  // appears in both the address book and the client list.
  const byPerson = dedupe(rows);
  if (byPerson.length === 1) return { match: byPerson[0], candidates: [] };
  return { match: null, candidates: byPerson };
}

/** "ammmmaaa" → "ama"; strips non-letters so "am ma" collapses too. */
function collapseRuns(s) {
  return String(s).replace(/[^a-z]/g, "").replace(/(.)\1+/g, "$1");
}

/** Plain Levenshtein, early-out when the length gap alone exceeds 1. */
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = dp[i];
      dp[i] = Math.min(
        dp[i] + 1,
        dp[i - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = cur;
    }
  }
  return dp[a.length];
}

function clean(r) {
  return {
    name: r.name,
    phone: normalizePhone(r.phone) || r.phone,
    source: r.source,
  };
}

/** Collapses rows that are the same person reached twice. */
function dedupe(rows) {
  const seen = new Map();
  for (const r of rows) {
    const c = clean(r);
    const key = c.phone || c.name.toLowerCase();
    if (!seen.has(key)) seen.set(key, c);
  }
  return [...seen.values()];
}

module.exports = { resolveContact };
