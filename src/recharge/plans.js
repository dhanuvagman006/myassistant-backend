/**
 * MOBILE RECHARGE PLANS (2026-10-19, owner: "if I say I need to make a
 * recharge for my Jio phone … suggest a good plan … directly take to the
 * payment app with the less manual").
 *
 * Real plans only, from the operators' own public plan lists (the same
 * calls their websites make; no login). Checked from the production
 * server on 2026-10-19:
 *   Jio — one national list, 193 plans: jio-mdmdata-service plans.
 *   Vi  — one list per circle: myvi.in catalog/<circlecode>.
 *   Airtel and BSNL lock theirs (browser-made security tokens / login),
 *   so their plans are NEVER described; the tool opens their page.
 *
 * The pay link opens the operator's own recharge page on the phone:
 *   Jio — number AND plan filled in (serviceId + planId): it goes straight
 *         to the payment step, where Google Pay / any UPI app pays.
 *   Vi  — the pack opened (?mrp=); the number is typed there.
 *   BSNL — the number filled in (?mobile=); plan picked there.
 *   Airtel — the recharge page.
 * Google Pay and PhonePe publish no recharge link, so none is guessed.
 */
const JIO_PLANS =
  "https://www.jio.com/api/jio-mdmdata-service/mdmdata/recharge/plans?productType=MOBILITY&billingType=1";
const VI_CATALOG = "https://www.myvi.in/wildfly/consumer/api/vodafoneidea/catalog/";
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const TTL_MS = 6 * 3600_000;

// Vi's circles (codes from myvi.in's own page), and the states each covers.
const VI_CIRCLES = [
  ["0001", "Andhra Pradesh", ["andhra", "telangana", "hyderabad", "ap", "ts"]],
  ["0002", "Chennai", ["chennai"]],
  ["0003", "Delhi", ["delhi", "ncr", "new delhi", "noida", "gurgaon", "gurugram"]],
  ["0004", "UP East", ["up east", "lucknow", "varanasi", "kanpur", "prayagraj", "gorakhpur"]],
  ["0005", "Gujarat", ["gujarat", "ahmedabad", "surat"]],
  ["0006", "Haryana", ["haryana"]],
  ["0007", "Karnataka", ["karnataka", "bangalore", "bengaluru", "mysore", "mysuru", "mangalore"]],
  ["0008", "Kolkata", ["kolkata", "calcutta"]],
  ["0009", "Mumbai", ["mumbai", "bombay", "thane", "navi mumbai"]],
  ["0010", "Rajasthan", ["rajasthan", "jaipur"]],
  ["0011", "West Bengal", ["west bengal", "bengal", "sikkim"]],
  ["0012", "Punjab", ["punjab", "chandigarh"]],
  ["0013", "UP West", ["up west", "uttarakhand", "meerut", "agra", "dehradun", "uttar pradesh"]],
  ["0014", "Maharashtra", ["maharashtra", "goa", "pune", "nagpur", "nashik"]],
  ["0015", "Tamil Nadu", ["tamil nadu", "tamilnadu", "coimbatore", "madurai"]],
  ["0016", "Kerala", ["kerala", "kochi", "trivandrum"]],
  ["0017", "Odisha", ["odisha", "orissa", "bhubaneswar"]],
  ["0018", "Assam", ["assam", "guwahati"]],
  ["0019", "North East", ["north east", "meghalaya", "manipur", "mizoram", "nagaland", "tripura", "arunachal"]],
  ["0020", "Bihar", ["bihar", "jharkhand", "patna", "ranchi"]],
  ["0021", "Madhya Pradesh", ["madhya pradesh", "chhattisgarh", "mp", "bhopal", "indore", "raipur"]],
  ["0022", "Himachal Pradesh", ["himachal"]],
  ["0023", "Jammu & Kashmir", ["jammu", "kashmir", "ladakh", "j&k"]],
];

/** "Bengaluru" → { code: "0007", name: "Karnataka" }; null when unknown. */
function viCircle(state) {
  const s = String(state || "").toLowerCase().trim();
  if (!s) return null;
  for (const [code, name, words] of VI_CIRCLES) {
    if (name.toLowerCase() === s || words.some((w) => s === w || s.includes(w))) return { code, name };
  }
  return null;
}

const cache = new Map(); // url → { at, body }
async function getJson(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.body;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`plans ${res.status}`);
  const body = await res.json();
  cache.set(url, { at: Date.now(), body });
  return body;
}

const clean = (s, n = 160) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

/** One Jio plan as the assistant should read it. */
function jioPlan(p, category) {
  const d = {};
  for (const x of (p.misc && p.misc.details) || []) d[String(x.header || "").toLowerCase()] = clean(x.value, 60);
  return {
    id: String(p.id),
    price: Number(p.amount),
    validity: d["pack validity"] || "",
    data: d["data at high speed*"] || d["total data"] || "",
    total_data: d["total data"] || "",
    voice: d.voice || "",
    sms: d.sms || "",
    details: clean(p.description, 200),
    category,
  };
}

/** Every Jio plan, Popular first, each plan once. */
async function jioPlans() {
  const body = await getJson(JIO_PLANS);
  const seen = new Set();
  const out = [];
  const cats = (body.planCategories || []).slice().sort((a, b) =>
    (/popular/i.test(categoryName(b)) ? 1 : 0) - (/popular/i.test(categoryName(a)) ? 1 : 0));
  for (const c of cats) {
    for (const s of c.subCategories || []) {
      for (const p of s.plans || []) {
        if (!p || !p.id || seen.has(p.id) || !(Number(p.amount) > 0)) continue;
        seen.add(p.id);
        out.push(jioPlan(p, categoryName(c)));
      }
    }
  }
  return out;
}
function categoryName(c) {
  return clean(c.type || c.name || c.categoryName || c.title || "", 40);
}

/** Vi's packs for a circle, cheapest first, recharge packs only. */
async function viPlans(code) {
  const body = await getJson(VI_CATALOG + code);
  const keep = /^(unlimited|internet|talktime|voice|plan voucher)$/i;
  const seen = new Set();
  return (Array.isArray(body) ? body : [])
    .filter((p) => p && p["WEB-SELLABLE"] !== "0" && keep.test(String(p["PRODUCT-CATEGORY"] || "")))
    .map((p) => ({
      id: String(p.ITEM_ID || ""),
      price: Number(p.UNIT_COST),
      validity: clean(p["WEB-VALIDITY"], 40),
      name: clean(p["PRODUCT-NAME"] || p.RECHARGENAME_ATTR, 60),
      data: clean(p.DATA_LINE_1, 40),
      voice: clean([p.VOICE_LINE_1, p.VOICE_LINE_2].filter(Boolean).join(" "), 40),
      sms: clean(p.SMS_LINE_1, 30),
      details: clean(p["PRODUCT-MKT-DESC"] || p.READ_MORE || p.CONSUMER_PRODUCT_DESCRIPTION, 200),
      category: clean(p["PRODUCT-CATEGORY"], 30),
      // The packs Vi's own home page features first.
      rank: p.HOMEPAGE_DISPLAY_FLAG === "Y" ? Number(p.HOMEPAGE_DISPLAY_RANK) || 50 : 99,
    }))
    .filter((p) => p.price > 0 && !seen.has(p.price + p.category) && seen.add(p.price + p.category))
    .sort((a, b) => a.price - b.price);
}

/** The few to offer: Jio's popular ones; Vi's unlimited ones by its rank. */
function shortlist(operator, plans, n = 8) {
  if (operator === "jio") return plans.filter((p) => /popular/i.test(p.category)).slice(0, n);
  const unl = plans.filter((p) => /unlimited/i.test(p.category)).sort((a, b) => a.rank - b.rank || a.price - b.price);
  return (unl.length ? unl : plans).slice(0, n).sort((a, b) => a.price - b.price);
}

/** The pay page for a chosen plan (or none) on this operator. */
function payUrl(operator, { number, plan } = {}) {
  switch (operator) {
    case "jio":
      return plan
        ? `https://www.jio.com/selfcare/recharge/mobility/?serviceId=${number}&planId=${encodeURIComponent(plan.id)}`
        : `https://www.jio.com/selfcare/recharge/mobility/?serviceId=${number}`;
    case "vi":
      return plan
        ? `https://www.myvi.in/prepaid/online-mobile-recharge?mrp=${plan.price}`
        : "https://www.myvi.in/prepaid/online-mobile-recharge";
    case "bsnl":
      return `https://bsnl.co.in/mobile/recharge?mobile=${number}`;
    case "airtel":
      return "https://www.airtel.in/recharge-online";
    default:
      return null;
  }
}

module.exports = { jioPlans, viPlans, viCircle, shortlist, payUrl, VI_CIRCLES };
