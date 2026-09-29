/**
 * WHERE THE USER LIKES TO SHOP — read from what they told us, never
 * guessed: standing rules (user_instructions) and remembered facts
 * (agent_memories), newest first; the first word on a kind wins.
 *
 *   "User's usual grocery app is Zepto."   -> grocery: zepto
 *   "buys clothes on Ajio"                  -> fashion: ajio
 *   "orders medicines from PharmEasy"       -> pharmacy: pharmeasy
 *   "never use Amazon"                      -> avoid: amazon
 *
 * The grocery app is asked for once and remembered as a memory fact
 * (rememberGroceryApp), so it shows in memory like anything else they
 * told us, and "forget my grocery app" works the usual way.
 */
const { query } = require("../db");
const links = require("./links");

const KIND_WORDS = {
  grocery: /\b(grocer(y|ies)|vegetables?|veggies|kirana|daily needs|provisions|fruits?|milk|essentials)\b/,
  fashion: /\b(cloth(es|ing)?|dress(es)?|fashion|apparel|shoes?|footwear|kurtis?|sarees?|shirts?|jeans)\b/,
  electronics: /\b(electronics?|gadgets?|phones?|laptops?|appliances?|chargers?)\b/,
  beauty: /\b(beauty|make ?up|cosmetics?|skin ?care)\b/,
  pharmacy: /\b(medicines?|pharmacy|medical|tablets?|chemist)\b/,
  home: /\b(furniture|kitchenware|home decor|home needs)\b/,
};
const PREFER = /\b(prefers?|preferred|always|usually|usual|regularly|only|favou?rite|likes?|loves?|uses?|using|go(es)? with|sticks? (to|with)|buys?|orders?|shops?|gets?)\b/;
const AVOID = /\b(never|don'?t|doesn'?t|do not|does not|hates?|avoids?|stopped|stop using|no more|not)\b/;

// Names as they appear in free text. Words that are ordinary English on
// their own ("fresh", "minutes", "jio", "swiggy" — which is also food
// delivery) are left out here; the apps' full names still match.
const TEXT_NAMES = {};
{
  const skip = new Set(["fresh", "minutes", "jio", "bb", "fk", "swiggy", "one mg", "amzn"]);
  for (const k of Object.keys(links.APPS)) TEXT_NAMES[links.APPS[k].label.toLowerCase()] = k;
  for (const [alias, key] of Object.entries(links.ALIASES)) if (!skip.has(alias)) TEXT_NAMES[alias] = key;
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ALTERNATION = Object.keys(TEXT_NAMES).sort((a, b) => b.length - a.length).map(esc).join("|");
const APP_RE = new RegExp(`(?<![a-z0-9])(${ALTERNATION})(?![a-z0-9])`, "g");
const SQL_PATTERN = `(${Object.keys(TEXT_NAMES).map(esc).join("|")})`;

/** Pure: texts newest first -> { byKind: {kind: appKey}, avoid: Set }. */
function readPrefs(texts) {
  const byKind = {};
  const avoid = new Set();
  const decided = new Set();
  for (const raw of texts) {
    const t = String(raw || "").toLowerCase();
    const kinds = Object.keys(KIND_WORDS).filter((k) => KIND_WORDS[k].test(t));
    for (const m of t.matchAll(APP_RE)) {
      const key = TEXT_NAMES[m[1]];
      if (!key) continue;
      const before = t.slice(Math.max(0, m.index - 30), m.index);
      if (AVOID.test(before)) {
        if (!decided.has(key)) avoid.add(key);
        decided.add(key);
        continue;
      }
      if (!PREFER.test(t)) continue;
      decided.add(key);
      for (const k of kinds.length ? kinds : links.APPS[key].kinds) {
        if (!byKind[k]) byKind[k] = key;
      }
    }
  }
  return { byKind, avoid };
}

async function textsOf(uid) {
  const [rules, facts] = await Promise.all([
    query(
      `SELECT instruction AS t, created_at AS at FROM user_instructions
        WHERE user_id = $1 AND active = 1 ORDER BY id DESC LIMIT 40`, [uid]
    ).catch(() => []),
    query(
      `SELECT fact AS t, created_at AS at FROM agent_memories
        WHERE user_id = $1 AND COALESCE(valid, 1) = 1 AND fact ~* $2
          AND COALESCE(subject_type, '') = ''
        ORDER BY id DESC LIMIT 60`, [uid, SQL_PATTERN]
    ).catch(() => []),
  ]);
  return [...rules, ...facts]
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))
    .map((r) => r.t);
}

/** { byKind, avoid } for this user; empty when nothing is known. */
async function shoppingPrefs(userId) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) return { byKind: {}, avoid: new Set() };
  return readPrefs(await textsOf(uid));
}

/** The user's grocery app as an app key, or null. */
async function groceryApp(userId) {
  return (await shoppingPrefs(userId)).byKind.grocery || null;
}

/** Remembers the grocery app they just named (asked once). */
async function rememberGroceryApp(userId, key) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0 || !links.APPS[key]) return false;
  await require("../memory/service").remember(uid, {
    fact: `User's usual grocery app is ${links.labelOf(key)}.`,
    kind: "preference",
    importance: 2,
    source: "shopping",
  });
  return true;
}

module.exports = { shoppingPrefs, groceryApp, rememberGroceryApp, readPrefs };
