/**
 * SHOPPING APPS — which app fits each line, and the search link that opens
 * it on that thing. Used by shop_from_list and POST /shopping/handoff.
 *
 * HONEST LIMIT (the same one fulfillment/deeplinks.js states): these are
 * SEARCH links. The user lands on the results for "curd" or "kurti blue
 * floral M" in their own app, picks, and pays there. Nothing here orders,
 * and nothing here ever opens a payment or UPI app.
 *
 * Blinkit, Zepto, Amazon and Flipkart searches come from deeplinks.shop()
 * (called without a platform, so they stay plain https). The rest are new
 * templates kept here until they move into deeplinks.js: Swiggy Instamart,
 * BigBasket, JioMart, Amazon Fresh, Flipkart Minutes, Myntra, AJIO, Nykaa,
 * Croma, Meesho, Tata 1mg, PharmEasy, Netmeds, Apollo Pharmacy.
 *
 * The app opens `url` in the group's `pkg` when it is installed and in the
 * browser otherwise. A package is only given where it is certain.
 */
const deeplinks = require("../fulfillment/deeplinks");
const N = require("./normalize");

const enc = encodeURIComponent;
const viaDeeplinks = (provider) => (q) => {
  const link = deeplinks.shop({ provider, query: q });
  return link ? link.url : null;
};

// kinds: grocery | fashion | beauty | electronics | home | pharmacy | general
const APPS = {
  blinkit: { label: "Blinkit", pkg: "com.grofers.customerapp", hosts: ["blinkit.com"], kinds: ["grocery"], search: viaDeeplinks("blinkit") },
  zepto: { label: "Zepto", pkg: "com.zeptoconsumerapp", hosts: ["zeptonow.com", "zepto.com"], kinds: ["grocery"], search: viaDeeplinks("zepto") },
  instamart: { label: "Swiggy Instamart", pkg: "in.swiggy.android", hosts: ["swiggy.com"], kinds: ["grocery"], search: (q) => `https://www.swiggy.com/instamart/search?custom_back=true&query=${enc(q)}` },
  bigbasket: { label: "BigBasket", pkg: "com.bigbasket.mobileapp", hosts: ["bigbasket.com"], kinds: ["grocery"], search: (q) => `https://www.bigbasket.com/ps/?q=${enc(q)}` },
  jiomart: { label: "JioMart", pkg: "com.jpl.jiomart", hosts: ["jiomart.com"], kinds: ["grocery"], search: (q) => `https://www.jiomart.com/search/${enc(q)}` },
  amazon_fresh: { label: "Amazon Fresh", pkg: "in.amazon.mShop.android.shopping", hosts: [], kinds: ["grocery"], search: (q) => `https://www.amazon.in/s?k=${enc(q)}&i=nowstore` },
  flipkart_minutes: { label: "Flipkart Minutes", pkg: "com.flipkart.android", hosts: [], kinds: ["grocery"], search: (q) => `https://www.flipkart.com/search?q=${enc(q)}&marketplace=HYPERLOCAL` },
  amazon: { label: "Amazon", pkg: "in.amazon.mShop.android.shopping", hosts: ["amazon.in", "amzn.in", "amazon.com"], kinds: ["general", "electronics", "home", "fashion", "pharmacy", "beauty"], search: viaDeeplinks("amazon"), grocery: "amazon_fresh" },
  flipkart: { label: "Flipkart", pkg: "com.flipkart.android", hosts: ["flipkart.com", "fkrt.it"], kinds: ["general", "electronics", "home", "fashion"], search: viaDeeplinks("flipkart"), grocery: "flipkart_minutes" },
  myntra: { label: "Myntra", pkg: "com.myntra.android", hosts: ["myntra.com"], kinds: ["fashion"], search: (q) => `https://www.myntra.com/${N.words(q).join("-") || "search"}?rawQuery=${enc(q)}` },
  ajio: { label: "AJIO", pkg: "com.ril.ajio", hosts: ["ajio.com"], kinds: ["fashion"], search: (q) => `https://www.ajio.com/search/?text=${enc(q)}` },
  meesho: { label: "Meesho", pkg: "com.meesho.supply", hosts: ["meesho.com"], kinds: ["fashion"], search: (q) => `https://www.meesho.com/search?q=${enc(q)}` },
  nykaa: { label: "Nykaa", pkg: "com.fsn.nykaa", hosts: ["nykaa.com", "nykaafashion.com"], kinds: ["beauty"], search: (q) => `https://www.nykaa.com/search/result/?q=${enc(q)}` },
  croma: { label: "Croma", pkg: "", hosts: ["croma.com"], kinds: ["electronics"], search: (q) => `https://www.croma.com/searchB?q=${enc(q)}%3Arelevance&text=${enc(q)}` },
  tata1mg: { label: "Tata 1mg", pkg: "com.aranoah.healthkart.plus", hosts: ["1mg.com"], kinds: ["pharmacy"], search: (q) => `https://www.1mg.com/search/all?name=${enc(q)}` },
  pharmeasy: { label: "PharmEasy", pkg: "com.phonegap.rxpal", hosts: ["pharmeasy.in"], kinds: ["pharmacy"], search: (q) => `https://pharmeasy.in/search/all?name=${enc(q)}` },
  netmeds: { label: "Netmeds", pkg: "", hosts: ["netmeds.com"], kinds: ["pharmacy"], search: (q) => `https://www.netmeds.com/catalogsearch/result/${enc(q)}/all` },
  apollo: { label: "Apollo Pharmacy", pkg: "", hosts: ["apollopharmacy.in", "apollo247.com"], kinds: ["pharmacy"], search: (q) => `https://www.apollopharmacy.in/search-medicines/${enc(q)}` },
};

// What each kind falls back to when nothing is remembered (in order; an
// app the user said they avoid is skipped). Groceries have no default: the
// user's own app is asked for once and remembered.
const DEFAULTS = {
  fashion: ["myntra", "ajio", "amazon"],
  electronics: ["amazon", "flipkart", "croma"],
  beauty: ["nykaa", "amazon"],
  home: ["amazon", "flipkart"],
  pharmacy: ["amazon", "tata1mg", "pharmeasy"],
  general: ["amazon", "flipkart"],
};

const GROCERY_APP_KEYS = Object.keys(APPS).filter((k) => APPS[k].kinds.includes("grocery"));

const ALIASES = {
  blinkit: "blinkit", "blink it": "blinkit", grofers: "blinkit",
  zepto: "zepto", zeptonow: "zepto", "zepto now": "zepto", "zepto cafe": "zepto",
  instamart: "instamart", "insta mart": "instamart", "swiggy instamart": "instamart", swiggy: "instamart",
  bigbasket: "bigbasket", "big basket": "bigbasket", bb: "bigbasket", bbnow: "bigbasket", "bb now": "bigbasket", "bigbasket now": "bigbasket",
  jiomart: "jiomart", "jio mart": "jiomart", jio: "jiomart",
  amazon: "amazon", amzn: "amazon", "amazon shopping": "amazon", "amazon india": "amazon",
  "amazon fresh": "amazon_fresh", "amazon now": "amazon_fresh", "amazon pantry": "amazon_fresh", fresh: "amazon_fresh",
  flipkart: "flipkart", fk: "flipkart",
  "flipkart minutes": "flipkart_minutes", "flipkart grocery": "flipkart_minutes", "flipkart supermart": "flipkart_minutes", minutes: "flipkart_minutes",
  myntra: "myntra", ajio: "ajio", meesho: "meesho",
  nykaa: "nykaa", "nykaa fashion": "nykaa",
  croma: "croma",
  "1mg": "tata1mg", "tata 1mg": "tata1mg", "one mg": "tata1mg", tata1mg: "tata1mg",
  pharmeasy: "pharmeasy", "pharm easy": "pharmeasy",
  netmeds: "netmeds", "net meds": "netmeds",
  apollo: "apollo", "apollo pharmacy": "apollo", "apollo 247": "apollo",
};
for (const k of Object.keys(APPS)) {
  ALIASES[k] = ALIASES[k] || k;
  ALIASES[APPS[k].label.toLowerCase()] = k;
}

// Payment, UPI, wallet, banking and trading apps. Never opened from here,
// whatever the request says (a shopping list is not a way to reach them).
const MONEY_RE = /\b(pay|payment|payments|upi|bhim|gpay|g pay|google pay|tez|phonepe|phone pe|paytm|pay tm|cred|mobikwik|freecharge|airtel money|amazon pay|wallet|bank|banking|yono|imobile|net ?banking|navi|slice|jupiter|groww|zerodha|kite|upstox|angel one|super\.?money|supermoney|pop ?pay|bajaj finserv|bharatpe|payzapp|paypal|phonepay|samsung wallet)\b/i;
const MONEY_HOSTS = /(^|\.)(paytm\.(com|in|me)|phonepe\.com|pay\.google\.com|gpay\.app\.goo\.gl|cred\.club|mobikwik\.com|freecharge\.in|bhimupi\.org\.in|npci\.org\.in|upi\.link)$/i;

const cleanAppName = (name) => {
  let s = String(name ?? "").toLowerCase().replace(/[^a-z0-9 .]+/g, " ").replace(/\s+/g, " ").trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/^(open|launch|use|on|in|from|via|the|my)\s+/, "").replace(/\s+(app|application|store|website|site)$/, "").trim();
  } while (s !== prev);
  return s;
};

/** Is this name a payment / UPI / banking app? */
function isMoneyApp(name) {
  const s = cleanAppName(name);
  return !!s && (MONEY_RE.test(s) || /pay$/.test(s.replace(/\s+/g, "")));
}

/** An app key from what the user said ("Swiggy Instamart", "the zepto app"); null if unknown or a money app. */
function resolveApp(name) {
  if (isMoneyApp(name)) return null;
  const s = cleanAppName(name);
  if (!s) return null;
  return ALIASES[s] || ALIASES[s.replace(/\s+/g, "")] || null;
}

function hostOf(link) {
  try {
    return new URL(link).hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  } catch (_) {
    return "";
  }
}
const isMoneyLink = (link) => MONEY_HOSTS.test(hostOf(link));

/** The app whose site a link is on (amazon.in -> amazon); null for others. */
function appForHost(host) {
  const h = String(host || "").toLowerCase();
  for (const [key, a] of Object.entries(APPS)) {
    if (a.hosts.some((d) => h === d || h.endsWith("." + d))) return key;
  }
  return null;
}

/** The grocery flavour of an app for grocery lines (amazon -> Amazon Fresh). */
const forKind = (key, kind) => (kind === "grocery" && APPS[key] && APPS[key].grocery ? APPS[key].grocery : key);

const labelOf = (key) => (APPS[key] ? APPS[key].label : key);
const supportedLabels = () => [...new Set(Object.values(APPS).map((a) => a.label))];
const groceryLabels = () => GROCERY_APP_KEYS.map(labelOf);

/** "kurti M, blue floral" -> "kurti M blue floral": what the app's search gets. */
function searchQuery(item) {
  return N.cleanText(`${item.name} ${item.details || ""}`.replace(/[,;()]+/g, " ")).slice(0, 100);
}

function searchUrl(key, query) {
  const app = APPS[key];
  return app ? app.search(query) : null;
}

/**
 * THE PLAN: which app opens which lines. Per line, strongest first:
 *   1. `app` named for this request (applies to every line; Amazon and
 *      Flipkart use their Fresh / Minutes search for grocery lines)
 *   2. the line's own link, when it has one (never a payment link)
 *   3. the line's `store`, when it names an app we know
 *   4. the category's app: groceries -> `groceryApp` or the remembered
 *      grocery app; the rest -> the remembered app for that kind, else
 *      the default (DEFAULTS), skipping apps they said they avoid
 *
 * Returns { groups:[{app,label,pkg,items:[…]}], needsGroceryApp:[names] }.
 * needsGroceryApp lists grocery lines with no app to go to: ask once.
 * Throws with code "money_app" / "unknown_app" for a bad named app.
 */
function plan(items, { app = null, groceryApp = null, prefs = {} } = {}) {
  const named = pick(app, "app");
  const groceryNamed = pick(groceryApp, "grocery_app");
  const byKind = prefs.byKind || {};
  const avoid = prefs.avoid || new Set();

  const groups = new Map();
  const needsGroceryApp = [];
  const put = (key, label, pkg, line) => {
    const gk = `${key}|${label}`;
    if (!groups.has(gk)) groups.set(gk, { app: key, label, pkg, items: [] });
    groups.get(gk).items.push(line);
  };
  const entry = (item, url) => ({
    id: item.id,
    name: item.name,
    ...(item.details ? { details: item.details } : {}),
    quantity: item.quantity ?? null,
    unit: item.unit ?? null,
    amountText: item.amountText || "",
    url,
  });

  for (const item of items) {
    const kind = N.categoryKind(item.category);
    const q = searchQuery(item);

    if (named) {
      const key = forKind(named, kind);
      const linkApp = item.link && !isMoneyLink(item.link) ? appForHost(hostOf(item.link)) : null;
      const url = linkApp && (linkApp === named || linkApp === key) ? item.link : searchUrl(key, q);
      put(key, labelOf(key), APPS[key].pkg, entry(item, url));
      continue;
    }
    if (item.link && !isMoneyLink(item.link)) {
      const host = hostOf(item.link);
      const key = appForHost(host);
      if (key) put(key, labelOf(key), APPS[key].pkg, entry(item, item.link));
      else put("web", host, "", entry(item, item.link));
      continue;
    }
    const storeKey = item.store ? resolveApp(item.store) : null;
    if (storeKey) {
      const key = forKind(storeKey, kind);
      put(key, labelOf(key), APPS[key].pkg, entry(item, searchUrl(key, q)));
      continue;
    }
    let key = null;
    if (kind === "grocery") {
      const g = groceryNamed || byKind.grocery || null;
      if (!g) {
        needsGroceryApp.push(item.name);
        continue;
      }
      key = forKind(g, "grocery");
    } else {
      // A general preference ("I shop on Flipkart") only counts where that
      // app sells the thing: Flipkart is not where medicines come from.
      const general = byKind.general && APPS[byKind.general] && APPS[byKind.general].kinds.includes(kind)
        ? byKind.general : null;
      const remembered = byKind[kind] || general;
      const defaults = DEFAULTS[kind] || DEFAULTS.general;
      key = remembered && !avoid.has(remembered)
        ? remembered
        : defaults.find((k) => !avoid.has(k)) || defaults[0];
    }
    put(key, labelOf(key), APPS[key].pkg, entry(item, searchUrl(key, q)));
  }

  // Groceries first (usually the most lines), then in the order met.
  const out = [...groups.values()].sort((a, b) =>
    (APPS[b.app]?.kinds.includes("grocery") ? 1 : 0) - (APPS[a.app]?.kinds.includes("grocery") ? 1 : 0));
  return { groups: out, needsGroceryApp };
}

function pick(name, field) {
  if (name === undefined || name === null || String(name).trim() === "") return null;
  if (isMoneyApp(name)) {
    const e = new Error(`${name} is a payment app — shopping lists open shopping apps only`);
    e.code = "money_app";
    e.field = field;
    throw e;
  }
  const key = resolveApp(name);
  if (!key) {
    const e = new Error(`I can't open ${String(name).slice(0, 40)} for shopping yet — I can use ${supportedLabels().join(", ")}`);
    e.code = "unknown_app";
    e.field = field;
    throw e;
  }
  return key;
}

/** "5 items on Blinkit and 1 on Myntra" */
function summaryOf(groups) {
  const parts = groups.map((g, i) => {
    const n = g.items.length;
    const what = i === 0 ? `${n} ${n === 1 ? "item" : "items"}` : `${n}`;
    return `${what} on ${g.label}`;
  });
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

module.exports = {
  APPS, ALIASES, DEFAULTS, GROCERY_APP_KEYS,
  isMoneyApp, isMoneyLink, resolveApp, appForHost, hostOf, forKind, labelOf,
  supportedLabels, groceryLabels, searchQuery, searchUrl, plan, summaryOf,
};
