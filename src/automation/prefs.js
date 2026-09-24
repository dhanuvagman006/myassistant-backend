/**
 * WHICH APP, AND WHAT WE ALREADY KNOW — the two things the owner should
 * never have to say twice.
 *
 * pickApp: "book biryani" goes to the owner's food app, not ours. Order of
 * evidence, strongest first:
 *   1. the app they named in this request
 *   2. what they told us ("I prefer Swiggy", "never use Ola") — standing
 *      rules and remembered facts
 *   3. the app they actually used last time for the same kind of thing
 *   4. the most common app for it in India
 * Every pick carries its reason, so the report can say why.
 *
 * ownerInfo: everything we know about the owner that a form may ask —
 * name, phone, email, address, date of birth, gender, education, family
 * names, and answers they gave to earlier forms. Nothing that unlocks
 * anything — no passwords, card, bank or ID numbers — ever leaves this
 * file, even if a memory happens to contain one.
 */
const { query, one } = require("../db");
const deeplinks = require("../fulfillment/deeplinks");

// Category → candidate apps, most common first. Package names are only
// known for some; the phone resolves the rest by name.
const CATEGORIES = {
  food: ["swiggy", "zomato"],
  grocery: ["blinkit", "zepto", "swiggy", "bigbasket"],
  ride: ["uber", "ola", "rapido"],
  shopping: ["amazon", "flipkart", "myntra", "meesho"],
  movies: ["bookmyshow", "district"],
  travel: ["makemytrip", "goibibo", "irctc", "redbus"],
};
const EXTRA = {
  rapido: { label: "Rapido", pkg: "com.rapido.passenger" },
  bigbasket: { label: "BigBasket", pkg: "com.bigbasket.mobileapp" },
  myntra: { label: "Myntra", pkg: "com.myntra.android" },
  meesho: { label: "Meesho", pkg: "com.meesho.supply" },
  district: { label: "District", pkg: "com.application.zomato.district" },
  goibibo: { label: "Goibibo", pkg: "com.goibibo" },
  irctc: { label: "IRCTC", pkg: "cris.org.in.prs.ima" },
  redbus: { label: "redBus", pkg: "in.redbus.android" },
};
// fulfillment_tasks.kind for each category, for "what did they use last".
const TASK_KIND = { food: "food", ride: "ride", movies: "movie", shopping: "shop", grocery: "shop" };

function appInfo(name) {
  const key = String(name || "").toLowerCase().trim();
  const p = deeplinks.PROVIDERS?.[key];
  if (p) return { name: key, label: p.label, pkg: p.pkg };
  if (EXTRA[key]) return { name: key, ...EXTRA[key] };
  return null;
}

const PREFER = /\b(prefer|always|only|favou?rite|like|love|use|go with|stick (?:to|with))\b/i;
const AVOID = /\b(never|don'?t|do not|hate|avoid|stop using|no more)\b/i;

/**
 * Reads the owner's own words for a preference among [candidates].
 * "Swiggy over Zomato", "Swiggy instead of Zomato", "Swiggy rather than
 * Zomato" name a winner and a loser in one sentence.
 */
function scorePreferences(texts, candidates) {
  const score = Object.fromEntries(candidates.map((c) => [c, 0]));
  const quote = {};
  for (const raw of texts) {
    const t = String(raw || "").toLowerCase();
    const hits = candidates.filter((c) => t.includes(c));
    if (!hits.length) continue;
    const over = t.match(/\b([a-z]+)\s+(?:over|instead of|rather than|not)\s+([a-z]+)/);
    if (over && hits.includes(over[1]) && hits.includes(over[2])) {
      score[over[1]] += 3; score[over[2]] -= 3; quote[over[1]] = raw;
      continue;
    }
    for (const c of hits) {
      // The words right before the app name decide which way it goes.
      const i = t.indexOf(c);
      const before = t.slice(Math.max(0, i - 40), i);
      if (AVOID.test(before)) { score[c] -= 4; continue; }
      if (PREFER.test(before) || PREFER.test(t)) { score[c] += 2; quote[c] = quote[c] || raw; }
    }
  }
  return { score, quote };
}

async function pickApp(userId, category, explicit) {
  if (explicit) {
    const key = String(explicit).toLowerCase().replace(/\b(the|app)\b/g, "").trim();
    const resolved = deeplinks.resolveAppName ? deeplinks.resolveAppName(key) : key;
    const info = appInfo(resolved) || appInfo(key) ||
      { name: key, label: String(explicit).trim(), pkg: "" };
    return { ...info, reason: `you asked for ${info.label}` };
  }
  const candidates = CATEGORIES[category];
  if (!candidates) return null;

  const texts = [];
  if (userId) {
    const rules = await query(
      `SELECT instruction AS t FROM user_instructions WHERE user_id=$1 AND active=1`,
      [userId]).catch(() => []);
    const facts = await query(
      `SELECT fact AS t FROM agent_memories
        WHERE user_id=$1 AND COALESCE(valid,1)=1 AND fact ~* $2
        ORDER BY id DESC LIMIT 30`,
      [userId, candidates.join("|")]).catch(() => []);
    texts.push(...rules.map((r) => r.t), ...facts.map((r) => r.t));
  }
  const { score } = scorePreferences(texts, candidates);
  const best = candidates.slice().sort((a, b) => score[b] - score[a])[0];
  if (score[best] > 0) {
    const info = appInfo(best);
    return { ...info, reason: `you told me you prefer ${info.label}` };
  }
  const allowed = candidates.filter((c) => score[c] >= 0);

  if (userId && TASK_KIND[category]) {
    const last = await one(
      `SELECT provider FROM fulfillment_tasks
        WHERE user_id=$1 AND kind=$2 AND provider <> ''
        ORDER BY id DESC LIMIT 1`,
      [userId, TASK_KIND[category]]).catch(() => null);
    if (last && allowed.includes(last.provider)) {
      const info = appInfo(last.provider);
      if (info) return { ...info, reason: `you used ${info.label} last time` };
    }
  }
  const fallback = allowed[0] || candidates[0];
  const info = appInfo(fallback);
  return { ...info, reason: `${info.label} is the usual choice for this` };
}

/* ------------------------------------------------------------------ *
 * OWNER INFO FOR FORMS
 * ------------------------------------------------------------------ */

// Never passed on, whatever a memory contains.
const SECRET =
  /(password|passcode|\bpin\b(?!\s*code)|mpin|\botp\b|cvv|card (?:number|no)|account (?:number|no)|ifsc|aadhaa?r|\bpan\b|passport (?:number|no)|licen[cs]e (?:number|no)|\b\d{12,19}\b)/i;
// Questions whose answers describe the owner and fit the next form too.
const PERSONAL =
  /\b(?:name|date of birth|dob|birth|age|gender|father|mother|guardian|parent|spouse|address|pin ?code|postal|city|district|state|nationality|religion|caste|category|community|college|school|university|institute|course|class|branch|semester|year of study|roll|registration|marks|percentage|cgpa|gpa|qualification|education|occupation|profession|employer|income|email|phone|mobile|whatsapp|blood group|disability)\b/i;
const ADDRESSY =
  "(address|pincode|pin code|flat|apartment|street|road|nagar|layout|colony|sector|i live|lives at|home is|office is|house)";

async function ownerInfo(userId) {
  if (!userId) return {};
  const u = await one(
    `SELECT name, email, phone_number, location, birthday, gender, profession, organisation
       FROM users WHERE id=$1`, [userId]).catch(() => null);
  const out = {};
  if (u?.name) out.name = u.name;
  if (u?.phone_number) out.phone = u.phone_number;
  if (u?.email && !/@(?:phone|privaterelay|local)\b/i.test(u.email)) out.email = u.email;
  if (u?.location) out.city = u.location;
  if (u?.birthday) out.date_of_birth = u.birthday;
  if (u?.gender) out.gender = u.gender;
  if (u?.profession) out.profession = u.profession;
  if (u?.organisation) out.organisation = u.organisation;

  const facts = await query(
    `SELECT fact FROM agent_memories
      WHERE user_id=$1 AND COALESCE(valid,1)=1
        AND COALESCE(subject_type,'') IN ('', 'self', 'user')
        AND fact ~* $2
      ORDER BY importance DESC, id DESC LIMIT 6`,
    [userId, ADDRESSY]).catch(() => []);
  // Free text is where a secret can hide ("my address is …, account no
  // …"), so a memory carrying one is dropped whole. The profile fields
  // above are the owner's own contact details, meant for exactly this.
  const addr = facts.map((f) => String(f.fact)).filter((f) => !SECRET.test(f));
  if (addr.length) out.address_notes = addr;

  // Everything else remembered about the owner themselves (education,
  // family, work, earlier form answers) — answers first, then the most
  // important facts.
  const about = await query(
    `SELECT fact FROM agent_memories
      WHERE user_id=$1 AND COALESCE(valid,1)=1
        AND COALESCE(subject_type,'') IN ('', 'self', 'user')
      ORDER BY (source = 'form_answer') DESC, importance DESC, id DESC LIMIT 40`,
    [userId]).catch(() => []);
  const known = about.map((f) => String(f.fact))
    .filter((f) => !SECRET.test(f) && !addr.includes(f)).slice(0, 20);
  if (known.length) out.also_known = known;
  return out;
}

/** "What is your father's name, Sir?" → "father's name". */
function fieldName(question) {
  let q = String(question).trim()
    .replace(/[?.!]+$/, "")
    .replace(/,?\s*(?:sir|ma'?am|madam|ji)$/i, "");
  let prev;
  do {
    prev = q;
    q = q.replace(/^(?:what(?:'s| is| are)|which|please|kindly|enter|tell me|give me|your|is)\s+/i, "");
  } while (q !== prev);
  return q.trim() || String(question).trim();
}

/**
 * An answer the owner gave to a form question is remembered, so the next
 * form never asks again. Secrets are never kept.
 */
async function rememberAnswer(userId, question, answer) {
  const q = String(question || "").trim();
  const a = String(answer || "").trim();
  if (!userId || !q || !a || SECRET.test(q) || SECRET.test(a)) return false;
  // Only answers about the owner themselves — "for how many people?" is
  // about one booking, not something to remember.
  if (!PERSONAL.test(q)) return false;
  await require("../memory/service").remember(userId, {
    fact: `For forms — ${fieldName(q)}: ${a}`,
    kind: "semantic", importance: 3, source: "form_answer", confidence: 0.9,
  }).catch(() => null);
  return true;
}

module.exports = { pickApp, ownerInfo, rememberAnswer, scorePreferences, appInfo, CATEGORIES };
