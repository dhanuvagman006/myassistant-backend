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
  if (!rows.length) return { match: null, candidates: [] };

  // An exact match is decisive even when other names contain the query.
  const exact = rows.filter((r) => r.exact);
  if (exact.length === 1) return { match: clean(exact[0]), candidates: [] };
  if (exact.length > 1) return { match: null, candidates: exact.map(clean) };

  // Otherwise: unique on the person, not on the row — the same human often
  // appears in both the address book and the client list.
  const byPerson = dedupe(rows);
  if (byPerson.length === 1) return { match: byPerson[0], candidates: [] };
  return { match: null, candidates: byPerson };
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
