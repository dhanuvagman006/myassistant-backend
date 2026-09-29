/**
 * SHOPPING LIST — WORDS. Pure functions, no database, no model.
 *
 *   nameKey      "Onions", "onion" and "pyaz" are one line; "jeera" and
 *                "cumin seeds" merge by key but keep the name as said
 *   normalizeUnit g/gm/grams, kg, ml, l/litre, tsp, tbsp, cup,
 *                piece/pcs/nos, packet, bunch (+ dozen, m); anything else
 *                is kept, lower-cased and singular
 *   combine      the merge arithmetic: same unit adds up, g+kg and ml+l
 *                convert, another unit becomes a second amount on the
 *                same line ("1 kg + 2 pcs")
 *   categoryOf   keyword categories with "other" as the fallback
 */

/* ------------------------------------------------------------------ */
/* CATEGORIES                                                           */
/* ------------------------------------------------------------------ */

// `kind` decides which shopping app fits (links.js); the grocery kinds
// also merge the grocery way (by name alone).
const CATEGORIES = [
  { id: "vegetables_fruit", label: "Vegetables & fruit", kind: "grocery" },
  { id: "dairy_eggs", label: "Dairy & eggs", kind: "grocery" },
  { id: "meat_fish", label: "Meat & fish", kind: "grocery" },
  { id: "rice_atta_dal", label: "Rice, atta & dal", kind: "grocery" },
  { id: "spices_masala", label: "Spices & masala", kind: "grocery" },
  { id: "oils", label: "Oils & ghee", kind: "grocery" },
  { id: "bakery", label: "Bakery", kind: "grocery" },
  { id: "snacks_drinks", label: "Snacks & drinks", kind: "grocery" },
  { id: "household_cleaning", label: "Household & cleaning", kind: "grocery" },
  { id: "personal_care_beauty", label: "Personal care & beauty", kind: "beauty" },
  { id: "health_medicines", label: "Health & medicines", kind: "pharmacy" },
  { id: "clothing_footwear", label: "Clothing & footwear", kind: "fashion" },
  { id: "electronics_accessories", label: "Electronics & accessories", kind: "electronics" },
  { id: "home_kitchen", label: "Home & kitchen", kind: "home" },
  { id: "stationery_books", label: "Stationery & books", kind: "general" },
  { id: "baby_kids", label: "Baby & kids", kind: "general" },
  { id: "pets", label: "Pets", kind: "general" },
  { id: "gifts", label: "Gifts", kind: "general" },
  { id: "other", label: "Other", kind: "general" },
];
const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));
const ORDER = new Map(CATEGORIES.map((c, i) => [c.id, i]));

const slug = (s) =>
  String(s || "").toLowerCase().replace(/&|\band\b|[/,+_-]/g, " ").replace(/\s+/g, " ").trim();

const CATEGORY_ALIASES = {
  vegetables_fruit: ["vegetable", "vegetables", "veg", "veggies", "fruit", "fruits", "produce", "sabzi", "sabji", "greens", "fruits vegetables", "vegetables fruits", "fruit veg", "fruits veggies"],
  dairy_eggs: ["dairy", "egg", "eggs", "milk", "milk eggs"],
  meat_fish: ["meat", "fish", "seafood", "chicken", "mutton", "non veg", "fish meat"],
  rice_atta_dal: ["rice", "atta", "dal", "dals", "pulses", "grains", "staples", "flour", "foodgrains", "rice atta dal"],
  spices_masala: ["spice", "spices", "masala", "masalas", "condiments"],
  oils: ["oil", "oils", "ghee", "oil ghee", "edible oil", "edible oils"],
  bakery: ["bread", "breads", "bakery", "cakes"],
  snacks_drinks: ["snack", "snacks", "drink", "drinks", "beverage", "beverages", "snacks beverages"],
  household_cleaning: ["household", "cleaning", "home care", "household items", "cleaning supplies"],
  personal_care_beauty: ["personal care", "beauty", "cosmetics", "makeup", "toiletries", "grooming"],
  health_medicines: ["health", "medicine", "medicines", "pharmacy", "medical", "wellness"],
  clothing_footwear: ["clothing", "clothes", "fashion", "footwear", "shoes", "apparel", "dress", "dresses"],
  electronics_accessories: ["electronics", "electronic", "gadgets", "gadget", "accessories", "mobile accessories"],
  home_kitchen: ["home", "kitchen", "kitchenware", "home living", "home decor", "furniture"],
  stationery_books: ["stationery", "stationary", "books", "book", "office supplies", "school supplies"],
  baby_kids: ["baby", "kids", "children", "toys", "baby care"],
  pets: ["pet", "pets", "pet supplies", "pet food"],
  gifts: ["gift", "gifts", "presents"],
  other: ["other", "others", "misc", "miscellaneous"],
};
const CATEGORY_LOOKUP = new Map();
for (const c of CATEGORIES) {
  CATEGORY_LOOKUP.set(slug(c.id), c.id);
  CATEGORY_LOOKUP.set(slug(c.label), c.id);
}
for (const [id, list] of Object.entries(CATEGORY_ALIASES)) {
  for (const a of list) if (!CATEGORY_LOOKUP.has(slug(a))) CATEGORY_LOOKUP.set(slug(a), id);
}

/** A category id from an id, a label or a common word; null if unknown. */
function normalizeCategory(input) {
  if (input === undefined || input === null) return null;
  const s = slug(input);
  if (!s) return null;
  return CATEGORY_LOOKUP.get(s) || null;
}

const categoryLabel = (id) => (BY_ID.get(id) || BY_ID.get("other")).label;
const categoryKind = (id) => (BY_ID.get(id) || BY_ID.get("other")).kind;
const isGroceryCategory = (id) => categoryKind(id) === "grocery";
const categoryOrder = (id) => (ORDER.has(id) ? ORDER.get(id) : ORDER.get("other"));

/* ------------------------------------------------------------------ */
/* NAMES                                                                */
/* ------------------------------------------------------------------ */

/** One tidy line: no control characters, no bullets, no trailing stop. */
function cleanText(raw) {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanName(raw) {
  let s = cleanText(raw).replace(/^[-–—•*·>\s]+/, "").replace(/[.,;:!?]+$/, "").trim();
  // "onion" -> "Onion", but "iPhone charger" stays as it is.
  if (/^[a-z]/.test(s) && !/^[a-z][A-Z]/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  return s;
}

const IRREGULAR = {
  tomatoes: "tomato", potatoes: "potato", mangoes: "mango", heroes: "hero",
  chillies: "chilli", chilies: "chilli", chilis: "chilli", chili: "chilli", chiles: "chilli",
  leaves: "leaf", knives: "knife", loaves: "loaf", halves: "half", shelves: "shelf",
  mice: "mouse", children: "child", teeth: "tooth", feet: "foot", men: "man", women: "woman",
};
// Plurals of words ending in -ie ("cookies" is not "cooky").
const IE_WORDS = new Set(("cookie brownie pie smoothie tie movie hoodie beanie onesie veggie " +
  "selfie calorie nightie rookie auntie lingerie").split(" "));

// Singular words that end in s. Indian plurals are NOT here on purpose:
// "kurtis", "laddus" and "rotis" are plurals of kurti, laddu and roti.
const KEEP_S = new Set(("tennis iris chassis basis axis analysis hummus couscous asparagus " +
  "citrus hibiscus lotus octopus cactus bus virus campus bonus status news series species " +
  "molasses swiss").split(" "));

/** Singular of ONE word, conservatively: a key only has to be consistent. */
function singular(w) {
  if (!w || w.length <= 3) return w;
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (KEEP_S.has(w) || w.endsWith("ss")) return w;
  if (w.endsWith("ies")) {
    const stem = w.slice(0, -3);
    return IE_WORDS.has(stem + "ie") ? stem + "ie" : stem + "y";
  }
  if (/(ches|shes|sses|xes|zzes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}

/** Lower-case words; letters, marks and digits of any script. */
function words(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Words with the head noun (the last word) made singular. */
function singularPhrase(s) {
  const w = words(s);
  if (!w.length) return "";
  w[w.length - 1] = singular(w[w.length - 1]);
  return w.join(" ");
}

// Indian and English names for the same thing. The first entry is the key;
// the line keeps whatever the user said.
const SYNONYM_GROUPS = [
  ["cumin seeds", "jeera", "cumin", "jeera seeds", "zeera", "jeerakam", "jeerige", "jeeragam"],
  ["coriander leaves", "dhania", "dhaniya", "coriander", "cilantro", "hara dhania", "kothamalli", "kothamalli leaves", "kottambari", "kothimbir", "malli ila", "coriander leaf"],
  ["coriander powder", "dhania powder", "dhaniya powder", "malli podi"],
  ["coriander seeds", "dhania seeds", "sabut dhania"],
  ["turmeric", "haldi", "turmeric powder", "haldi powder", "manjal", "manjal podi", "arishina", "pasupu", "manjal powder"],
  ["curd", "dahi", "yogurt", "yoghurt", "thayir", "thairu", "mosaru", "perugu", "doi", "plain curd"],
  ["onion", "pyaz", "pyaaz", "kanda", "vengayam", "ulli", "savala", "eerulli", "big onion"],
  ["tomato", "tamatar", "thakkali", "tamatar"],
  ["potato", "aloo", "alu", "batata", "urulaikizhangu", "urulakizhangu"],
  ["ginger", "adrak", "inji", "allam", "shunti"],
  ["garlic", "lehsun", "lahsun", "poondu", "veluthulli", "bellulli", "vellulli"],
  ["green chilli", "hari mirch", "green chillies", "pachai milagai", "pacha mulaku", "hasi menasinakai", "green chili"],
  ["chilli powder", "red chilli powder", "lal mirch powder", "mirchi powder", "mulaku podi"],
  ["mint", "pudina", "pudhina", "mint leaves"],
  ["curry leaves", "kadi patta", "kari patta", "curry patta", "karuveppilai", "kariveppila", "karibevu"],
  ["atta", "wheat flour", "gehun atta", "chakki atta", "whole wheat flour"],
  ["maida", "all purpose flour", "refined flour", "plain flour"],
  ["besan", "gram flour", "chickpea flour", "kadalai maavu"],
  ["rava", "sooji", "suji", "semolina", "ravva", "rawa", "bombay rava"],
  ["poha", "aval", "avalakki", "beaten rice", "flattened rice", "chivda"],
  ["jaggery", "gud", "gur", "vellam", "bella", "sharkara", "sarkara"],
  ["tamarind", "imli", "puli", "hunase"],
  ["asafoetida", "hing", "perungayam", "kayam", "ingu"],
  ["mustard seeds", "rai", "sarson", "kadugu", "sasive", "mustard"],
  ["cardamom", "elaichi", "elakkai", "elakka", "elakki", "green cardamom"],
  ["cloves", "laung", "lavang", "grambu", "karampu", "clove"],
  ["cinnamon", "dalchini", "pattai", "chakke", "cinnamon stick"],
  ["black pepper", "kali mirch", "pepper", "milagu", "kurumulaku", "menasu", "pepper corns", "peppercorns"],
  ["fennel seeds", "saunf", "sombu", "perinjeerakam", "fennel"],
  ["fenugreek", "methi"],
  ["fenugreek leaves", "methi leaves", "methi leaf", "kasuri methi leaves"],
  ["fenugreek seeds", "methi seeds", "methi dana", "vendayam", "menthya", "uluva"],
  ["coconut", "nariyal", "thengai", "thenga", "kobbari", "fresh coconut"],
  ["okra", "bhindi", "ladies finger", "lady finger", "ladys finger", "vendakkai", "bende", "vendakka"],
  ["brinjal", "baingan", "eggplant", "aubergine", "kathirikai", "badane", "vazhuthananga"],
  ["spinach", "palak", "palak leaves"],
  ["cauliflower", "gobi", "phool gobi", "gobhi"],
  ["cabbage", "patta gobi", "band gobi", "muttaikose"],
  ["capsicum", "shimla mirch", "bell pepper", "green capsicum"],
  ["green peas", "matar", "mattar", "peas", "pattani", "green pea"],
  ["egg", "anda", "muttai", "motte", "mutta"],
  ["milk", "doodh", "paal", "haalu", "toned milk"],
  ["ghee", "nei", "tuppa", "desi ghee", "neyyi"],
  ["butter", "makhan", "makkhan", "venna"],
  ["sugar", "chini", "cheeni", "sakkare", "panchasara"],
  ["salt", "namak", "uppu", "table salt"],
  ["rice", "chawal", "arisi", "akki", "ari"],
  ["toor dal", "arhar dal", "tuvar dal", "toovar dal", "thuvaram paruppu", "togari bele", "tur dal", "sambar dal"],
  ["moong dal", "mung dal", "green gram dal", "pesara pappu", "hesaru bele", "cherupayar parippu", "moong"],
  ["urad dal", "black gram dal", "ulundu", "uddina bele", "uzhunnu", "urad"],
  ["chana dal", "bengal gram dal", "kadalai paruppu", "kadale bele"],
  ["lemon", "nimbu", "lime", "elumichai", "cherunaranga", "nimbe", "lemons"],
  ["banana", "kela", "vazhaipazham", "pazham", "balehannu"],
  ["tea", "chai patti", "tea powder", "tea leaves", "chai"],
  ["paneer", "cottage cheese"],
  ["cashew", "kaju", "cashew nuts", "cashewnut", "godambi", "andi parippu"],
  ["almond", "badam"],
  ["raisin", "kishmish", "kismis", "dry grapes", "ounagi drakshi"],
  ["saffron", "kesar"],
];
const SYNONYM = new Map();
for (const group of SYNONYM_GROUPS) {
  const key = singularPhrase(group[0]);
  for (const alias of group) SYNONYM.set(singularPhrase(alias), key);
  for (const alias of group) SYNONYM.set(words(alias).join(" "), key);
}

/** The merge key: lower-case, singular head noun, synonyms folded. */
function nameKey(name) {
  const w = words(name);
  if (!w.length) return "";
  const joined = w.join(" ");
  if (SYNONYM.has(joined)) return SYNONYM.get(joined);
  const sing = singularPhrase(joined);
  return SYNONYM.get(sing) || sing;
}

/** Details compare as a set of words: "M, blue floral" == "blue floral M". */
function detailsKey(details) {
  return [...new Set(words(details).map(singular))].sort().join(" ");
}

/* ------------------------------------------------------------------ */
/* UNITS AND AMOUNTS                                                    */
/* ------------------------------------------------------------------ */

const UNIT_ALIASES = {
  g: "g gm gms gram grams gramme grammes gr grm grms",
  kg: "kg kgs kilo kilos kilogram kilograms kilogramme",
  ml: "ml mls millilitre millilitres milliliter milliliters",
  l: "l ltr ltrs litre litres liter liters lt lit",
  tsp: "tsp tsps teaspoon teaspoons",
  tbsp: "tbsp tbsps tablespoon tablespoons tbs tblsp",
  cup: "cup cups",
  piece: "piece pieces pc pcs nos no number numbers count unit units",
  packet: "packet packets pack packs pkt pkts pouch pouches sachet sachets",
  bunch: "bunch bunches gaddi katta",
  dozen: "dozen dozens doz",
  m: "m metre metres meter meters mtr mtrs",
};
const UNIT = new Map();
for (const [unit, list] of Object.entries(UNIT_ALIASES)) {
  for (const a of list.split(" ")) UNIT.set(a, unit);
}
const MAX_UNIT = 20;

/**
 * A unit as stored: a known unit's short form, or the word given (lower
 * case, singular). null for nothing; `undefined` for something unusable
 * (too long, not a word) so REST can say so.
 */
function normalizeUnit(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).toLowerCase().replace(/[.\s]+$/g, "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (UNIT.has(s)) return UNIT.get(s);
  if (s.length > MAX_UNIT || !/^[\p{L}][\p{L}\p{M} ]*$/u.test(s)) return undefined;
  const w = s.split(" ");
  w[w.length - 1] = singular(w[w.length - 1]);
  const one = w.join(" ");
  return UNIT.get(one) || one;
}

const MAX_QTY = 100000;
const FRACTIONS = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };
const NUMBER_WORDS = {
  half: 0.5, quarter: 0.25, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12, "a dozen": 12, "half a dozen": 6,
};

/**
 * A quantity: a number > 0, or null for "not said". Accepts "2", "1.5",
 * "1/2", "1 1/2", "½". `undefined` means given but unusable.
 */
function parseQuantity(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  let n;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string") {
    const s = raw.trim().toLowerCase().replace(/,/g, ".");
    let m;
    if (FRACTIONS[s] !== undefined) n = FRACTIONS[s];
    else if (NUMBER_WORDS[s] !== undefined) n = NUMBER_WORDS[s];
    else if ((m = s.match(/^(\d+)\s*([½¼¾⅓⅔])$/))) n = Number(m[1]) + FRACTIONS[m[2]];
    else if ((m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/))) n = Number(m[1]) + Number(m[2]) / Number(m[3]);
    else if ((m = s.match(/^(\d+)\/(\d+)$/))) n = Number(m[1]) / Number(m[2]);
    else if (/^\d+(\.\d+)?$/.test(s) || /^\.\d+$/.test(s)) n = Number(s);
    else return undefined;
  } else return undefined;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_QTY) return undefined;
  return Math.round(n * 1000) / 1000;
}

// Units that convert: to the base (g, ml) and back to the larger unit.
const CONVERT = { g: ["mass", 1], kg: ["mass", 1000], ml: ["vol", 1], l: ["vol", 1000] };
const BIG = { mass: "kg", vol: "l" };
const SMALL = { mass: "g", vol: "ml" };
const round3 = (n) => Math.round(n * 1000) / 1000;

function sumConverted(a, b) {
  const [fam, fa] = CONVERT[a.unit];
  const [, fb] = CONVERT[b.unit];
  const base = a.quantity * fa + b.quantity * fb;
  return base >= 1000
    ? { quantity: round3(base / 1000), unit: BIG[fam] }
    : { quantity: round3(base), unit: SMALL[fam] };
}

/**
 * THE MERGE ARITHMETIC. `amounts` is a line's list of amounts (the first
 * is the line's quantity/unit); `add` is one more. Returns a new list.
 *
 *   countable  false for groceries: "milk" said again changes nothing, and
 *              an amount fills an unspecified one. true for everything
 *              else: saying it again means one more ("no amount" is one).
 */
function combine(amounts, add, { countable = false } = {}) {
  const out = (amounts && amounts.length ? amounts : [{ quantity: null, unit: null }])
    .map((a) => ({ quantity: a.quantity ?? null, unit: a.unit ?? null }));
  const q = add ? add.quantity ?? null : null;
  const u = add ? add.unit ?? null : null;

  if (q === null) {
    if (!countable) return out;
    const i = out.findIndex((a) => a.unit === null);
    if (i >= 0) out[i].quantity = round3((out[i].quantity ?? 1) + 1);
    return out;
  }

  // The same unit adds up (a unitless count adds to a unitless count).
  const same = out.findIndex((a) => a.unit === u);
  if (same >= 0) {
    const had = out[same].quantity;
    out[same].quantity = round3((had === null ? (countable ? 1 : 0) : had) + q);
    if (u && CONVERT[u] && CONVERT[u][1] === 1 && out[same].quantity >= 1000) {
      out[same] = { quantity: round3(out[same].quantity / 1000), unit: BIG[CONVERT[u][0]] };
    }
    return out;
  }
  // g + kg, ml + l: one amount.
  if (u && CONVERT[u]) {
    const i = out.findIndex((a) => a.unit && CONVERT[a.unit] && CONVERT[a.unit][0] === CONVERT[u][0] && a.quantity !== null);
    if (i >= 0) {
      out[i] = sumConverted(out[i], { quantity: q, unit: u });
      return out;
    }
  }
  // An unspecified line takes the first real amount.
  if (out.length === 1 && out[0].quantity === null && (!countable || out[0].unit === null)) {
    return countable && out[0].unit === null && u === null
      ? [{ quantity: round3(1 + q), unit: null }]
      : [{ quantity: q, unit: u }];
  }
  out.push({ quantity: q, unit: u });
  return out;
}

const fmtNum = (q) => (Number.isInteger(q) ? String(q) : String(Math.round(q * 100) / 100));
const PLURAL_UNIT = { piece: ["pc", "pcs"], packet: ["packet", "packets"], bunch: ["bunch", "bunches"], cup: ["cup", "cups"], dozen: ["dozen", "dozen"] };
const SHORT_UNIT = { l: "L" };

function unitText(unit, q) {
  if (!unit) return "";
  if (PLURAL_UNIT[unit]) return q === 1 ? PLURAL_UNIT[unit][0] : PLURAL_UNIT[unit][1];
  if (SHORT_UNIT[unit]) return SHORT_UNIT[unit];
  if (["g", "kg", "ml", "tsp", "tbsp", "m"].includes(unit)) return unit;
  if (q === 1 || /s$/.test(unit)) return unit;
  return /(ch|sh|x|z)$/.test(unit) ? unit + "es" : unit + "s";
}

/** "1.5 kg + 2 pcs"; "" when nothing was said. */
function amountText(amounts) {
  return (amounts || [])
    .filter((a) => a && a.quantity !== null && a.quantity !== undefined)
    .map((a) => (a.unit ? `${fmtNum(a.quantity)} ${unitText(a.unit, a.quantity)}` : fmtNum(a.quantity)))
    .join(" + ");
}

/* ------------------------------------------------------------------ */
/* CATEGORY BY KEYWORD                                                  */
/* ------------------------------------------------------------------ */

// Phrases first, in order: they settle the words that mean two things
// ("hair oil" is not cooking oil, "baby corn" is a vegetable).
const PHRASES = [
  [/\b(dog|cat|puppy|kitten|pet|parrot|bird)s? (food|biscuits?|treats?|shampoo|bowls?|bed|toys?|collar|leash)\b|\bpedigree\b|\bwhiskas\b|\bdrools\b|\b(cat )?litter\b|\bfish food\b|\bbird seeds?\b|\bleash\b/, "pets"],
  [/\bbaby (oil|powder|soap|shampoo|lotion|wipes?|food|cream|diapers?|clothes|dress)\b|\bdiapers?\b|\bnapp(y|ies)\b|\bfeeding bottles?\b|\bsippers?\b|\bcerelac\b|\bteethers?\b|\bpacifiers?\b|\bstrollers?\b|\btoys?\b|\bschool bags?\b/, "baby_kids"],
  [/\b(gift|gifts|present|presents)\b|\bbouquets?\b|\bhampers?\b|\bgreeting cards?\b|\bgift ?(wrap|box|card)\b|\bwrapping paper\b/, "gifts"],
  [/\b(smart ?watch|smart ?phone|power ?bank|pen ?drive|memory card|sd card|screen guard|tempered glass|phone (cover|case)|mobile (cover|case)|extension (board|cord)|fitness band|led bulb|hard ?disk)\b/, "electronics_accessories"],
  [/\b(hair|body|massage|baby|beard) oil\b|\b(face|cold|night|day|fairness|shaving|body|hand|foot|sun|under ?eye) (cream|lotion|wash|scrub|pack|mask|gel|serum)\b|\btalc(um)?\b|\bface powder\b|\bcompact powder\b|\blip ?balm\b|\bface ?wash\b|\bbody ?wash\b|\bhand ?wash\b|\bsanitary (pads?|napkins?)\b|\bwhisper\b|\bstayfree\b|\bhair (dye|colou?r|gel|serum|spray|clips?|bands?|dryer|straightener)\b|\btrimmers?\b|\brazors?\b|\bshaving\b|\bnail (polish|cutter)\b|\bcotton buds\b/, "personal_care_beauty"],
  [/\b(detergent|dish ?wash|dishwashing|dish soap|washing (powder|soap|liquid)|laundry|floor cleaner|toilet cleaner|glass cleaner|surface cleaner|bleach|phenyl|harpic|lizol|colin|vim|surf excel|ariel|tide|rin|mosquito|good ?knight|all ?out|naphthalene|garbage bags?|dustbin bags?|trash bags?|toilet (paper|rolls?)|tissues?|paper napkins?|kitchen towels?|alumin(i)?um foil|cling (film|wrap)|scrubbers?|scotch ?brite|sponges?|mops?|brooms?|jhadu|agarbatti|incense|camphor|kapoor|match ?box(es)?|candles?|air freshener|odonil|pooja|diyas?)\b/, "household_cleaning"],
  [/\b(protein powder|whey|eye drops?|ear drops?|nasal spray|pain (relief|balm|killer)|cough|cold (tablets?|syrup)|first aid|band ?aid|test strips?|bp monitor|pulse oximeter|hot water bag|pregnancy test)\b/, "health_medicines"],
  [/\b(peanut butter|ice ?cream|coffee powder|filter coffee|mineral water|drinking water|packaged water|soft drinks?|energy drinks?|dry fruits?|milk ?shake)\b/, "snacks_drinks"],
  [/\b(milk powder|condensed milk|fresh cream|cooking cream|whipping cream|butter ?milk)\b/, "dairy_eggs"],
  [/\b(red chilli|dry chilli|dried chilli|kashmiri chilli|byadgi|bay leaf|bay leaves|star anise|kasuri methi|sambar powder|rasam powder|garam masala|chaat masala)\b/, "spices_masala"],
  [/\b(water bottles?|lunch ?box(es)?|pressure cooker|frying pan|non ?stick|chopping board|cutting board|dinner set|storage (box|containers?)|bed ?sheets?|pillow covers?|door ?mats?|iron box)\b/, "home_kitchen"],
  [/\b(t ?shirts?|night ?(dress|wear|suit)|track ?(pants?|suit)|flip ?flops?|sun ?glasses)\b/, "clothing_footwear"],
];

const WORD_LISTS = {
  vegetables_fruit: "vegetable veggie onion tomato potato ginger garlic chilli coriander mint curry leaf carrot bean cabbage cauliflower brinjal okra spinach methi capsicum cucumber beetroot radish pumpkin gourd lauki karela drumstick pea corn mushroom lemon lime banana apple mango orange grape papaya pineapple watermelon melon guava pomegranate coconut yam tapioca lettuce broccoli zucchini avocado kiwi strawberry jackfruit chikoo sapota fruit green greens amla gooseberry plantain tindora ivy colocasia arbi fenugreek",
  dairy_eggs: "milk curd paneer cheese butter buttermilk lassi khoa khoya egg cream yogurt tofu malai shrikhand mozzarella dahi",
  meat_fish: "chicken mutton lamb goat fish prawn shrimp crab squid pork beef sardine mackerel pomfret seer surmai anjal kingfish rohu tuna salmon keema mince sausage salami ham bacon meat bangda mathi ayala karimeen nethili anchovy hilsa catla",
  rice_atta_dal: "rice basmati atta flour maida besan rava sooji semolina poha dal lentil rajma chana chole chickpea kabuli oat millet ragi jowar bajra vermicelli semiya sabudana quinoa pasta dalia batter wheat barley moong masoor urad toor arhar",
  spices_masala: "masala powder turmeric cumin seed pepper cardamom clove cinnamon asafoetida hing salt sugar jaggery tamarind saffron ajwain kalonji fennel saunf paste spice mace nutmeg poppy khus sesame til mustard anise vinegar",
  oils: "oil ghee vanaspati dalda",
  bakery: "bread bun pav roti chapati paratha phulka naan kulcha rusk cake pastry croissant toast muffin brownie puff khari crumb baguette bagel donut doughnut loaf",
  snacks_drinks: "chip namkeen mixture bhujia biscuit cookie chocolate candy toffee juice cola coke pepsi sprite soda water tea coffee horlicks bournvita boost complan drink jam ketchup sauce pickle achar papad noodle maggi cornflake flake cereal muesli honey popcorn chikki sweet mithai laddoo ladoo laddu barfi samosa jalebi halwa soup cashew almond raisin pista pistachio walnut date nut peanut groundnut makhana wafer cracker khakhra mayonnaise spread squash sharbat snack",
  household_cleaning: "detergent cleaner bleach phenyl harpic lizol vim surf ariel tide rin broom mop scrubber sponge tissue napkin foil garbage agarbatti incense camphor kapoor matchbox candle freshener odonil naphthalene mosquito coil repellent wipe diya wick bucket dustbin",
  personal_care_beauty: "shampoo conditioner soap toothpaste toothbrush brush facewash lotion moisturiser moisturizer sunscreen lipstick kajal eyeliner mascara foundation primer concealer nailpolish perfume deodorant deo talc razor trimmer comb bindi mehendi henna serum cosmetic makeup sanitary pad floss mouthwash bodywash handwash shaving sindoor kumkum lipbalm",
  health_medicines: "tablet medicine capsule syrup paracetamol dolo crocin calpol combiflam vicks ointment bandage bandaid thermometer ors electral antiseptic savlon dettol vitamin multivitamin supplement inhaler drop balm sanitizer sanitiser mask glucometer insulin oximeter gauze digene eno antacid zincovit becosule pill tonic iodex volini moov burnol betadine medical pharmacy",
  clothing_footwear: "dress kurti kurta saree sari shirt tshirt jean trouser pant short skirt top legging dupatta lehenga salwar churidar blouse jacket sweater sweatshirt hoodie sock innerwear underwear brief boxer bra panty vest banian lungi dhoti mundu nightie nightwear pyjama pajama shoe sandal slipper chappal heel sneaker boot belt cap hat scarf stole shawl uniform frock sherwani blazer coat suit raincoat gown jumpsuit jogger petticoat cloth clothe handkerchief hanky glove handbag purse wallet watch sunglass earring necklace bangle jewellery jewelry kurtis",
  electronics_accessories: "charger cable usb earphone headphone earbud powerbank phone mobile iphone smartphone laptop mouse keyboard battery adapter adaptor pendrive speaker tv television remote hdmi router modem bulb led plug socket earpod airpod smartwatch camera tripod printer ink cartridge monitor webcam microphone mic ssd ipad kindle alexa firestick chromecast torch fan inverter stabilizer",
  home_kitchen: "cooker kadai kadhai tawa pan pot utensil plate bowl spoon fork ladle strainer knife mug glass tumbler bottle flask tiffin container jar box mixer grinder blender kettle induction stove lighter bedsheet pillow cushion curtain towel mat doormat rug carpet hanger lamp clock mirror vase frame chair table shelf rack organiser organizer basket tray peeler grater whisk casserole thermos apron tupperware cutlery furniture sofa mattress blanket quilt razai duvet hook",
  stationery_books: "pen pencil notebook book eraser rubber sharpener ruler scale glue fevicol tape stapler staple file folder diary paper a4 chart marker highlighter crayon envelope calculator novel magazine register sketchbook notepad",
  baby_kids: "diaper nappy toy cerelac sipper pacifier teether rattle stroller pram crib lego doll puzzle",
  pets: "pedigree whiskas drools litter leash kibble",
  gifts: "gift present bouquet hamper greeting",
};
const WORD_CATEGORY = new Map();
for (const [cat, list] of Object.entries(WORD_LISTS)) {
  for (const w of list.split(" ")) if (!WORD_CATEGORY.has(w)) WORD_CATEGORY.set(w, cat);
}

/**
 * The category for a name (and its details): phrases first, then the head
 * noun, then any other word from the right; "other" when nothing fits.
 */
function categoryOf(name, details = "") {
  const key = nameKey(name);
  const raw = words(name).join(" ");
  const text = ` ${raw} ${key} `;
  for (const [re, cat] of PHRASES) if (re.test(text)) return cat;
  const w = key.split(" ").filter(Boolean);
  for (let i = w.length - 1; i >= 0; i--) {
    const hit = WORD_CATEGORY.get(w[i]) || WORD_CATEGORY.get(singular(w[i]));
    if (hit) return hit;
  }
  const rawWords = raw.split(" ").filter(Boolean);
  for (let i = rawWords.length - 1; i >= 0; i--) {
    const hit = WORD_CATEGORY.get(singular(rawWords[i]));
    if (hit) return hit;
  }
  // The details sometimes say what it is ("for the puppy", "cotton").
  if (details) {
    const d = ` ${words(details).join(" ")} `;
    for (const [re, cat] of PHRASES) if (re.test(d)) return cat;
  }
  return "other";
}

module.exports = {
  CATEGORIES, CATEGORY_IDS, normalizeCategory, categoryLabel, categoryKind,
  isGroceryCategory, categoryOrder, categoryOf,
  cleanText, cleanName, nameKey, detailsKey, words, singular, singularPhrase,
  normalizeUnit, parseQuantity, combine, amountText, fmtNum, unitText,
  MAX_QTY, MAX_UNIT,
};
