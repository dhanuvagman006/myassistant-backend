/**
 * WHAT THE KITCHEN KNOWS ABOUT THE USER — GET /kitchen/prefs. Read from
 * what they already told the assistant (standing rules, remembered facts,
 * their profile's language, their pantry and their shopping app), never
 * invented. Anything unknown gets a safe default:
 *
 *   { diet: null, allergies: [], spice: "medium", household: 2,
 *     cuisine: null, language: "English", groceryApp: null,
 *     staples: [the usual Indian staples, adjusted by the pantry] }
 *
 * diet is "veg" | "egg" | "non-veg" | "jain" | "vegan" | null — the
 * user's own (a fact about "his wife" does not set it). allergies include
 * the family's: leaving out an ingredient someone at the table cannot eat
 * is the safer mistake.
 */
const { query, one } = require("../db");
const store = require("./store");
const N = require("../shopping/normalize");
const links = require("../shopping/links");
const { shoppingPrefs } = require("../shopping/prefs");

const DEFAULTS = Object.freeze({ spice: "medium", household: 2, language: "English" });

const OTHERS = /\b(wife|husband|mother|mom|mum|amma|father|dad|appa|son|daughter|kids?|child(ren)?|brother|sister|friend|boss|colleague|in-?laws?|grand\w*)\b/;

const DIET_RULES = [
  [/\bvegan\b/, "vegan"],
  [/\b(is|follows?|eats?|strict|strictly|pure) jain\b|\bjain (food|diet|meals?|cooking|vegetarian)\b/, "jain"],
  [/\beggetarian\b|\bvegetarian\b[^.;]*\b(but|except|and)\b[^.;]*\beggs?\b|\beats? eggs?\b[^.;]*\bno (meat|chicken|fish)\b/, "egg"],
  [/\bnon[- ]?veg(etarian)?\b|\b(not|isn'?t|no longer)( a)? vegetarian\b|\beats? (meat|chicken|fish|mutton|seafood)\b/, "non-veg"],
  [/\bvegetarian\b|\bpure veg\b|\bveg only\b|\bonly veg\b|\bis veg\b|\bdoes(n'?t| not) eat (meat|non[- ]?veg|chicken|fish|eggs?)\b|\bno (meat|non[- ]?veg)\b/, "veg"],
];

const SPICE_RULES = [
  [/\b(mild|less spicy|not (too |very )?spicy|low spice|no spice|can'?t (handle|take) (spice|spicy)|does(n'?t| not) like spicy|avoids? spicy|less chilli)\b/, "mild"],
  [/\b(very spicy|extra spicy|loves? spicy|likes? (it |food )?spicy|hot and spicy|spicy food|more spice|extra chilli)\b/, "hot"],
  [/\bmedium spic/, "medium"],
];

const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const num = (s) => (/^\d+$/.test(s) ? Number(s) : NUM[s] || null);
const N_WORD = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)";
const HOUSEHOLD_RULES = [
  [/\b(lives?|stays?) alone\b/, () => 1],
  [new RegExp(`\\b(family|household) of ${N_WORD}\\b`), (m) => num(m[2])],
  [new RegExp(`\\b${N_WORD} (people|members|of us) (at home|in (the |my |our )?(family|house|household|home))\\b`), (m) => num(m[1])],
  [new RegExp(`\\bcooks? for ${N_WORD}\\b`), (m) => num(m[1])],
];

const REGIONS = [
  ["south indian", "South Indian"], ["north indian", "North Indian"], ["kerala", "Kerala"], ["malayali", "Kerala"],
  ["chettinad", "Chettinad"], ["tamil", "Tamil"], ["karnataka", "Karnataka"], ["mangalorean", "Mangalorean"],
  ["mangalore", "Mangalorean"], ["udupi", "Udupi"], ["konkani", "Konkani"], ["goan", "Goan"], ["andhra", "Andhra"],
  ["telugu", "Andhra"], ["hyderabadi", "Hyderabadi"], ["maharashtrian", "Maharashtrian"], ["gujarati", "Gujarati"],
  ["rajasthani", "Rajasthani"], ["punjabi", "Punjabi"], ["bengali", "Bengali"], ["odia", "Odia"],
  ["kashmiri", "Kashmiri"], ["mughlai", "Mughlai"], ["indo chinese", "Indo-Chinese"], ["chinese", "Chinese"],
  ["italian", "Italian"], ["continental", "Continental"], ["thai", "Thai"], ["mexican", "Mexican"],
];
const FOOD_CUE = /\b(food|cuisine|dish(es)?|cook(s|ing)?|meals?|recipes?|eats?)\b/;

const ALLERGY_RE = /\ballergic to ([^.;\n]+)|\ballerg(?:y|ies)(?: to|:)\s*([^.;\n]+)|\b([a-z][a-z-]{2,20}(?: [a-z-]{3,20})?) allergy\b/g;
const INTOLERANT = [[/\blactose intoleran/, "Lactose (milk)"], [/\b(gluten intoleran|coeliac|celiac)/, "Gluten"]];

function splitAllergens(s) {
  return String(s)
    .replace(/\b(and|or|also|too|as well|severely|mildly|very)\b/g, ",")
    .split(/[,&/]+/)
    .map((x) => x.replace(/^\s*(a|an|the|some)\s+/, "").trim())
    .filter((x) => x && x.length <= 40 && !/\b(anything|nothing|none|no known)\b/.test(x));
}

/** Pure: rows newest first ({ t, subject }) -> the parsed preferences. */
function readKitchen(rows) {
  let diet = null;
  let spice = null;
  let household = null;
  let cuisine = null;
  const allergies = [];
  const allergyKeys = new Set();
  const addAllergy = (name) => {
    const clean = N.cleanName(name);
    const key = N.nameKey(clean);
    if (!clean || allergyKeys.has(key) || allergies.length >= 10) return;
    allergyKeys.add(key);
    allergies.push(clean);
  };

  for (const r of rows) {
    const t = String(r.t || "").toLowerCase();
    if (!/\b(not allergic|no allergies|no known allergies)\b/.test(t)) {
      for (const m of t.matchAll(ALLERGY_RE)) splitAllergens(m[1] || m[2] || m[3]).forEach(addAllergy);
      for (const [re, name] of INTOLERANT) if (re.test(t)) addAllergy(name);
    }
    // The rest is the user's own, not someone they mentioned.
    if (r.subject) continue;
    const firstOther = t.search(OTHERS);
    const own = (re) => {
      const m = t.match(re);
      return m && (firstOther < 0 || m.index < firstOther) ? m : null;
    };
    if (!diet) for (const [re, v] of DIET_RULES) if (own(re)) { diet = v; break; }
    if (!spice) for (const [re, v] of SPICE_RULES) if (own(re)) { spice = v; break; }
    if (household === null) {
      for (const [re, f] of HOUSEHOLD_RULES) {
        const m = t.match(re);
        const n = m ? f(m) : null;
        if (n && n >= 1 && n <= 20) { household = n; break; }
      }
    }
    if (!cuisine && FOOD_CUE.test(t)) {
      for (const [word, label] of REGIONS) {
        if (new RegExp(`\\b${word}\\b`).test(t)) { cuisine = label; break; }
      }
    }
  }
  return { diet, allergies, spice, household, cuisine };
}

// Postgres \m = start of a word, so "eat" finds "eats" but not "great".
const RELEVANT = "\\m(veg|non-veg|vegan|jain|egg|allerg|intoleran|celiac|coeliac|spic|chilli|chili|mild|family|household|people|alone|cook|cuisine|food|dish|meal|recipe|eat)";

async function textsOf(uid) {
  const [rules, facts] = await Promise.all([
    query(
      `SELECT instruction AS t, '' AS subject, created_at AS at FROM user_instructions
        WHERE user_id = $1 AND active = 1 ORDER BY id DESC LIMIT 40`, [uid]
    ).catch(() => []),
    query(
      `SELECT fact AS t, COALESCE(subject_type, '') AS subject, created_at AS at FROM agent_memories
        WHERE user_id = $1 AND COALESCE(valid, 1) = 1 AND fact ~* $2
        ORDER BY id DESC LIMIT 100`, [uid, RELEVANT]
    ).catch(() => []),
  ]);
  return [...rules, ...facts].sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
}

async function kitchenPrefs(userId) {
  const uid = Number(userId);
  const [user, rows, pantry, shop] = await Promise.all([
    one("SELECT preferred_language FROM users WHERE id = $1", [uid]).catch(() => null),
    textsOf(uid),
    store.getPantry(uid),
    shoppingPrefs(uid),
  ]);
  const read = readKitchen(rows);
  const grocery = shop.byKind.grocery ? links.forKind(shop.byKind.grocery, "grocery") : null;
  return {
    diet: read.diet,
    allergies: read.allergies,
    spice: read.spice || DEFAULTS.spice,
    household: read.household || DEFAULTS.household,
    cuisine: read.cuisine,
    language: (user && String(user.preferred_language || "").trim()) || DEFAULTS.language,
    groceryApp: grocery ? links.labelOf(grocery) : null,
    staples: store.staplesFrom(pantry),
  };
}

module.exports = { kitchenPrefs, readKitchen, DEFAULTS };
