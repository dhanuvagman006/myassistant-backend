/**
 * AI POSTER STUDIO — "make a poster for our event tomorrow" (2026-09-30).
 * ----------------------------------------------------------------------
 * The photo cards (service.js) carry a family's own words over a real
 * photo, no AI. This is the other kind of poster: an event, a sale, an
 * announcement, where the words are facts — a date, a time, a place —
 * and the picture behind them is made by an image model.
 *
 * TWO STEPS, split on purpose:
 *   design(request)   Gemini TEXT (JSON mode) lays the user's request out
 *                     as poster fields. Dates like "tomorrow" are resolved
 *                     IN CODE (chrono, in the user's timezone), not by the
 *                     model, and every field is then checked against the
 *                     user's own words: a venue, a price, a phone number,
 *                     a time or a name the user never said is removed and
 *                     listed in `missing` for the app to ask about. An
 *                     invented venue on a printed poster is worse than a
 *                     blank one.
 *   background(...)   a TEXT-FREE picture through the image chain
 *                     (imagegen.js, purpose 'background'), stored like
 *                     every other file (documents), returned by id + URL.
 *
 * The words are set by the app in real fonts over the background. No
 * image model ever spells anything on these posters.
 *
 * Switches: POSTER_AI=off turns both off (503 'off'). Per user per day:
 * POSTER_AI_DESIGNS_PER_DAY (60), POSTER_AI_BACKGROUNDS_PER_DAY (30); one
 * background at a time per user. The per-minute limit is the posters'
 * own (server.js posterLimit).
 */
const chrono = require("chrono-node");
const { PosterError } = require("./service");

const STYLES = ["neon", "corporate", "festive", "elegant", "minimal", "bold"];

/** The poster sizes the app draws at; shape names are imagegen's. */
const FORMATS = {
  portrait: { width: 1080, height: 1350, aspect: "4:5", shape: "poster" },
  story: { width: 1080, height: 1920, aspect: "9:16", shape: "story" },
  square: { width: 1080, height: 1080, aspect: "1:1", shape: "square" },
};

const PALETTES = {
  neon: { primary: "#0B0F2A", secondary: "#FF2E88", accent: "#00E5FF", ink: "#FFFFFF" },
  corporate: { primary: "#0F2D52", secondary: "#1F6FB2", accent: "#F2A900", ink: "#FFFFFF" },
  festive: { primary: "#7A1022", secondary: "#F29F05", accent: "#FFD166", ink: "#FFF8E7" },
  elegant: { primary: "#1C1C1C", secondary: "#C9A227", accent: "#F5E6CC", ink: "#F8F4EC" },
  minimal: { primary: "#F7F7F5", secondary: "#222222", accent: "#E4572E", ink: "#111111" },
  bold: { primary: "#FFD400", secondary: "#111111", accent: "#E63946", ink: "#111111" },
};

/** What each style looks like as a background — scene words, never text. */
const STYLE_LOOK = {
  neon: "dark night backdrop with glowing neon light trails in magenta and cyan, soft bokeh, light haze, high contrast",
  corporate: "clean modern abstract backdrop, soft gradient of deep blue and white, subtle geometric lines, bright even light",
  festive: "rich festive backdrop with warm golden light, marigold flowers and glowing diyas, soft bokeh, maroon and gold tones",
  elegant: "luxurious backdrop in champagne and black, delicate gold accents, soft silk texture, gentle rim light",
  minimal: "calm minimal backdrop, soft off-white paper texture, one gentle shadow, a lot of empty space",
  bold: "vivid high-energy backdrop, bold yellow and red colour blocks, dynamic diagonal shapes, strong light",
};

const STYLE_WORDS = [
  ["festive", /\b(diwali|deepavali|onam|pongal|eid|christmas|navratri|durga|ganesh|holi|festival|puja|pooja|vishu|ugadi|sankranti|birthday|celebration)\b/i],
  ["elegant", /\b(wedding|reception|engagement|gala|anniversary|award|dinner|banquet|soiree)\b/i],
  ["corporate", /\b(meeting|conference|seminar|webinar|workshop|summit|training|agm|business|office|corporate|launch|expo|orientation|interview)\b/i],
  ["neon", /\b(party|dj|night|club|concert|music|gaming|hackathon|fest|rave)\b/i],
  ["bold", /\b(sale|offer|discount|grand opening|opening|clearance|deal|sports|match|tournament|marathon|cricket|football)\b/i],
];

const FIELDS = ["title", "subtitle", "dateText", "timeText", "location", "cta", "details"];
/** Names the app may be told are missing. */
const MISSING_OK = new Set([...FIELDS, "contact", "price", "host", "speaker", "registration"]);
/** The facts a poster needs; empty → always in `missing`. */
const CORE = ["title", "dateText", "timeText", "location"];

/** Invitations that add no facts — allowed in cta and subtitle. */
const GENERIC =
  /^(you('| a)?re invited|save the date|join us|all are welcome|everyone is welcome|see you there|don't miss (it|out)|come one,? come all|celebrate with us|be there|coming soon)[.!]?$/i;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];

/** "tomorrow" in the languages the app speaks — the model may resolve these. */
const RELATIVE_DAY =
  /\b(today|tonight|tomorrow|day after|this (mon|tues|wednes|thurs|fri|satur|sun)day|next (mon|tues|wednes|thurs|fri|satur|sun)day|coming (mon|tues|wednes|thurs|fri|satur|sun)day)\b|आज|कल|परसों|ഇന്ന്|നാളെ|മറ്റന്നാൾ|ಇಂದು|ನಾಳೆ|ನಾಡಿದ್ದು|இன்று|நாளை|ఈరోజు|రేపు|ఎల్లుండి/i;

function envNum(name, fallback, min = 0) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function aiOn() {
  return String(process.env.POSTER_AI || "on").toLowerCase() !== "off";
}

function assertOn() {
  if (!aiOn()) throw new PosterError(503, "off", "The poster studio's AI is switched off right now.");
}

/* ------------------------------------------------------------------ */
/* WORDS AND FACTS                                                     */
/* ------------------------------------------------------------------ */

const STOP = new Set(["the", "and", "for", "our", "with", "your", "you", "are", "this", "that",
  "from", "will", "all", "its", "his", "her", "their", "has", "have", "was", "were", "into",
  "about", "poster", "flyer", "flier", "banner", "make", "create", "design", "please", "event",
  "can", "need", "want", "some", "just", "also", "there", "here", "who", "what", "when", "where"]);

function words(s) {
  return String(s || "").toLowerCase().normalize("NFKC").match(/[\p{L}\p{M}\p{N}]+/gu) || [];
}

function contentWords(s) {
  return words(s).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}

/** Five letters are enough to forgive "celebration"/"celebrate". */
const stem = (w) => w.slice(0, 5);

function corpusOf(texts) {
  const all = texts.filter(Boolean).join(" \n ");
  return {
    text: all.toLowerCase(),
    stems: new Set(contentWords(all).map(stem)),
    digits: new Set((all.match(/\d+/g) || []).map((d) => String(Number(d)))),
    digitString: all.replace(/\D/g, ""),
  };
}

/** Share of the value's content words the user actually said (1 when none). */
function groundedRatio(value, corpus) {
  const cw = contentWords(value);
  if (!cw.length) return 1;
  return cw.filter((w) => corpus.stems.has(stem(w))).length / cw.length;
}

/** Every word of the value was said — for a VENUE, where one invented
 *  word ("Town Hall, MG Road") sends people to the wrong place. */
const JOINERS = new Set(["of", "the", "at", "in", "near", "and", "on", "opp", "behind", "next", "to"]);
function fullyGrounded(value, corpus) {
  const ws = words(value).filter((w) => !JOINERS.has(w) && !/^\d+$/.test(w));
  const said = new Set(words(corpus.text));
  return ws.every((w) => said.has(w) || (w.length >= 3 && corpus.stems.has(stem(w))));
}

function hasContent(value) {
  return contentWords(value).length > 0;
}

/** Every number in the value was said by the user (or is in `extra`). */
function numbersOk(value, corpus, extra = []) {
  const said = new Set([...corpus.digits, ...extra.map((d) => String(Number(d)))]);
  return (String(value || "").match(/\d+/g) || []).every((d) => said.has(String(Number(d))));
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|in|org|net|io|co)\b\S*/gi;
const PHONE = /\+?\d[\d\s-]{7,}\d/g;

/** Phone numbers, emails and links must be the user's own, exactly. */
function contactsOk(value, corpus) {
  const v = String(value || "");
  for (const e of v.match(EMAIL) || []) if (!corpus.text.includes(e.toLowerCase())) return false;
  for (const u of v.match(URL_RE) || []) if (!corpus.text.includes(u.toLowerCase().replace(/^https?:\/\//, ""))) return false;
  for (const p of v.match(PHONE) || []) if (!corpus.digitString.includes(p.replace(/\D/g, ""))) return false;
  return true;
}

const PRICE_TOKENS = [
  ["₹", /₹/], ["rs", /\brs\.?\b/i], ["inr", /\binr\b/i], ["$", /\$/], ["free", /\bfree\b/i],
  ["entry", /\bentry\b/i], ["ticket", /\btickets?\b/i], ["fee", /\bfees?\b/i],
  ["price", /\bprices?\b/i], ["discount", /\bdiscount/i], ["%", /%/],
];

/** A price, a fee or "free entry" the user never mentioned is invented. */
function pricesOk(value, corpus) {
  return PRICE_TOKENS.every(([, re]) => !re.test(String(value || "")) || re.test(corpus.text));
}

function factsOk(value, corpus, extraDigits = []) {
  return numbersOk(value, corpus, extraDigits) && contactsOk(value, corpus) && pricesOk(value, corpus);
}

function clean(s, max) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max);
}

/* ------------------------------------------------------------------ */
/* DATES, IN THE USER'S TIMEZONE                                       */
/* ------------------------------------------------------------------ */

function formatDate(y, m, d) {
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[w]}, ${d} ${MONTHS[m - 1]} ${y}`;
}

function iso(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function clock(h, min) {
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { text: `${h12}:${String(min || 0).padStart(2, "0")}`, ap };
}

function timeRange(start, end) {
  const a = clock(start.get("hour"), start.get("minute"));
  if (!end) return `${a.text} ${a.ap}`;
  const b = clock(end.get("hour"), end.get("minute"));
  return a.ap === b.ap ? `${a.text} – ${b.text} ${b.ap}` : `${a.text} ${a.ap} – ${b.text} ${b.ap}`;
}

/** The user's "today", as y/m/d in their timezone. */
function localToday(now, tzOffsetMin) {
  const d = new Date(now + tzOffsetMin * 60_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), w: d.getUTCDay() };
}

/**
 * Dates and times in the request, resolved here rather than by a model:
 * {date:{y,m,d}|null, dateText, iso, timeText}. "tomorrow" is tomorrow
 * where the USER is — at 1:30 a.m. in India that is not the server's.
 */
function resolveWhen(request, { now = Date.now(), tzOffsetMin = 330 } = {}) {
  const out = { date: null, dateText: "", iso: null, timeText: "" };
  let results = [];
  try {
    results = chrono.parse(String(request || ""), { instant: new Date(now), timezone: tzOffsetMin }, { forwardDate: true });
  } catch (_) {
    return out;
  }
  for (const r of results) {
    const s = r.start;
    const dated = s.isCertain("day") || s.isCertain("weekday");
    if (!out.date && dated) {
      const y = s.get("year");
      const m = s.get("month");
      const d = s.get("day");
      out.date = { y, m, d };
      out.dateText = formatDate(y, m, d);
      out.iso = iso(y, m, d);
    }
    if (!out.timeText && s.isCertain("hour")) {
      out.timeText = timeRange(s, r.end && r.end.isCertain("hour") ? r.end : null);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* COLOURS                                                             */
/* ------------------------------------------------------------------ */

function hex(c) {
  const s = String(c || "").trim();
  const m3 = s.match(/^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`.toUpperCase();
  const m6 = s.match(/^#?([0-9a-f]{6})$/i);
  return m6 ? `#${m6[1]}`.toUpperCase() : null;
}

function luminance(h) {
  const n = parseInt(h.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Style palette, the model's valid colours, the brand's colours on top;
 *  ink always readable (WCAG 4.5:1) against the primary. */
function paletteFor(style, fromModel, brandColors) {
  const base = { ...PALETTES[style] };
  for (const k of ["primary", "secondary", "accent", "ink"]) {
    const c = hex(fromModel && fromModel[k]);
    if (c) base[k] = c;
  }
  const brand = (Array.isArray(brandColors) ? brandColors : []).map(hex).filter(Boolean);
  if (brand[0]) base.primary = brand[0];
  if (brand[1]) base.secondary = brand[1];
  if (brand[2]) base.accent = brand[2];
  if (contrast(base.ink, base.primary) < 4.5) {
    base.ink = contrast("#FFFFFF", base.primary) >= contrast("#111111", base.primary) ? "#FFFFFF" : "#111111";
  }
  return base;
}

function styleFor(request, fromModel) {
  const s = String(fromModel || "").toLowerCase();
  if (STYLES.includes(s)) return s;
  for (const [name, re] of STYLE_WORDS) if (re.test(String(request || ""))) return name;
  return "minimal";
}

/* ------------------------------------------------------------------ */
/* THE CHECK — only what the user said                                 */
/* ------------------------------------------------------------------ */

/** Names, venues and dates never belong in a background prompt. */
function cleanBackgroundPrompt(p, avoid, style) {
  let s = require("../services/imagePrompt").stripQuoted(clean(p, 500));
  for (const a of avoid) {
    if (a && a.length >= 3) s = s.split(a).join(" ");
  }
  s = s.replace(/\b(text|words|letters|title|typography|logo|poster)\b/gi, " ").replace(/\s+/g, " ").trim();
  return s.length >= 12 ? s : STYLE_LOOK[style];
}

/**
 * The model's poster fields, checked against the request. Pure: the route,
 * the tool and the tests all use it.
 *
 * @param {object} raw     what the model returned (may be anything)
 * @param {object} o
 * @param {string} o.request   the user's words
 * @param {object} o.brand     {name, colors}
 * @param {object} o.when      resolveWhen(request)
 * @param {object} o.today     localToday()
 * @param {string} o.format
 */
function validateDesign(raw, { request, brand = {}, when, today, format = "portrait" }) {
  const r = raw && typeof raw === "object" ? raw : {};
  const brandName = clean(brand && brand.name, 60);
  const corpus = corpusOf([request, brandName]);
  const ok = (v, min, extra) => factsOk(v, corpus, extra) && groundedRatio(v, corpus) >= min;

  const design = {
    title: "", subtitle: "", dateText: "", timeText: "", location: "", cta: "", details: [],
    style: "minimal", palette: null, backgroundPrompt: "", missing: [],
    format: FORMATS[format] ? format : "portrait", date: null,
  };

  const title = clean(r.title, 80);
  if (title && hasContent(title) && ok(title, 0.75)) design.title = title;

  const subtitle = clean(r.subtitle, 100);
  if (subtitle && (GENERIC.test(subtitle) || (brandName && subtitle.toLowerCase() === brandName.toLowerCase()) ||
      (hasContent(subtitle) && ok(subtitle, 0.5))) && factsOk(subtitle, corpus)) {
    design.subtitle = subtitle;
  }

  // THE DATE: resolved in code wins; the model's only for a relative day
  // chrono could not read (another language), inside the next two weeks,
  // or an explicit day-of-month the user said.
  if (when && when.date) {
    design.dateText = when.dateText;
    design.date = when.iso;
  } else {
    const m = String(r.dateISO || r.date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m && today) {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const days = (Date.UTC(y, mo - 1, d) - Date.UTC(today.y, today.m - 1, today.d)) / 864e5;
      const relative = RELATIVE_DAY.test(request) && days >= 0 && days <= 14;
      const explicit = corpus.digits.has(String(d)) && days >= 0 && days <= 400;
      if (Number.isInteger(days) && (relative || explicit)) {
        design.dateText = formatDate(y, mo, d);
        design.date = iso(y, mo, d);
      }
    }
  }

  if (when && when.timeText) {
    design.timeText = when.timeText;
  } else {
    const t = clean(r.timeText, 40);
    if (t && /\d/.test(t) && factsOk(t, corpus)) design.timeText = t;
  }

  const location = clean(r.location, 120);
  if (location && hasContent(location) && ok(location, 1) && fullyGrounded(location, corpus)) design.location = location;

  const cta = clean(r.cta, 40);
  if (cta && (GENERIC.test(cta) || (hasContent(cta) && ok(cta, 0.6))) && factsOk(cta, corpus)) design.cta = cta;

  const taken = new Set([design.title, design.subtitle, design.location].map((s) => s.toLowerCase()));
  const details = Array.isArray(r.details) ? r.details : [];
  for (const d of details) {
    const s = clean(d, 90);
    if (!s || taken.has(s.toLowerCase()) || !hasContent(s) || !ok(s, 0.6)) continue;
    taken.add(s.toLowerCase());
    design.details.push(s);
    if (design.details.length >= 5) break;
  }

  design.style = styleFor(request, r.style);
  design.palette = paletteFor(design.style, r.palette, brand && brand.colors);
  design.backgroundPrompt = cleanBackgroundPrompt(r.backgroundPrompt || "",
    [design.title, design.subtitle, design.location, brandName], design.style);

  const missing = [];
  for (const f of CORE) if (!design[f]) missing.push(f);
  for (const m of Array.isArray(r.missing) ? r.missing : []) {
    const f = String(m || "").trim();
    if (MISSING_OK.has(f) && !missing.includes(f) && !(FIELDS.includes(f) && (Array.isArray(design[f]) ? design[f].length : design[f]))) {
      missing.push(f);
    }
  }
  design.missing = missing;
  return design;
}

/* ------------------------------------------------------------------ */
/* DESIGN                                                              */
/* ------------------------------------------------------------------ */

const DESIGN_SYSTEM =
  "You lay out event posters. From the user's request return ONLY a JSON object with: " +
  "title, subtitle, dateISO (YYYY-MM-DD or \"\"), timeText, location, cta, details (array of " +
  "short strings), style (one of neon, corporate, festive, elegant, minimal, bold), palette " +
  "{primary, secondary, accent, ink} as #RRGGBB, backgroundPrompt, missing (array of field names).\n" +
  "RULES. Use ONLY facts the user gave. NEVER invent a venue, address, price, fee, phone " +
  "number, email, website, speaker, organiser, date or time. Anything the user did not give " +
  "stays empty (\"\" or []) and its field name goes in missing (title, dateText, timeText, " +
  "location, contact, price, host, speaker, registration). title: the event's name as the user " +
  "said it (tidy capitalisation only); none given → empty. Keep the user's language and script " +
  "for title, subtitle and details. dateISO: use resolvedDate when given; else only a date the " +
  "user said, using today to resolve words like 'tomorrow'. timeText: only a time the user said. " +
  "cta: a short invitation that adds no facts ('All are welcome'), or empty. backgroundPrompt: " +
  "describe ONLY the background image for this event and style — scene or texture, lighting, " +
  "palette, mood; no words, letters, names, logos or faces; calm open space at the top and bottom.";

function modelDesignInput({ request, brand, when, today, format }) {
  return {
    request,
    brand: brand && (brand.name || (brand.colors || []).length) ? brand : undefined,
    today: formatDate(today.y, today.m, today.d),
    todayISO: iso(today.y, today.m, today.d),
    resolvedDate: when.iso || undefined,
    resolvedTime: when.timeText || undefined,
    format,
  };
}

function parseJson(reply) {
  try {
    const j = JSON.parse(String(reply || "").replace(/```json|```/g, "").trim());
    return j && typeof j === "object" ? j : null;
  } catch (_) {
    return null;
  }
}

/** Without the model: the facts code can find, nothing else. */
function fallbackFields(request) {
  const loc = String(request || "").match(/\b(?:at|venue:?)\s+((?:the\s+)?[A-Z][\w'&.-]*(?:\s+(?:[A-Z][\w'&.-]*|of|de|the)){0,5})/);
  return { location: loc ? loc[1].replace(/\s+(?:of|de|the)$/i, "").trim() : "" };
}

/* per-user daily counters and the one-background-at-a-time guard */
const used = new Map();
const running = new Set();

function dayKey(uid, kind) {
  return `${uid}:${kind}:${new Date().toISOString().slice(0, 10)}`;
}

function take(uid, kind) {
  const limit = kind === "background"
    ? envNum("POSTER_AI_BACKGROUNDS_PER_DAY", 30, 1)
    : envNum("POSTER_AI_DESIGNS_PER_DAY", 60, 1);
  const k = dayKey(uid, kind);
  const n = used.get(k) || 0;
  if (n >= limit) {
    throw new PosterError(429, "daily_limit",
      kind === "background"
        ? "That's all the poster backgrounds for today — try again tomorrow."
        : "That's all the poster designs for today — try again tomorrow.");
  }
  used.set(k, n + 1);
  if (used.size > 2000) used.clear(); // yesterday's keys; ~30 users
}

function giveBack(uid, kind) {
  const k = dayKey(uid, kind);
  const n = used.get(k) || 0;
  if (n > 0) used.set(k, n - 1);
}

/**
 * @param {number} uid
 * @param {object} o  {request, format, brand, tzOffsetMin, now}
 * @returns {Promise<object>} the checked design (see validateDesign) plus source 'ai'|'fallback'
 */
async function design(uid, { request, format = "portrait", brand = {}, tzOffsetMin = 330, now = Date.now() } = {}) {
  assertOn();
  const req = clean(request, 1500);
  if (!req) throw new PosterError(400, "need_request", "Tell me what the poster is for.");
  const fmt = FORMATS[format] ? format : "portrait";
  const b = {
    name: clean(brand && brand.name, 60) || undefined,
    colors: (Array.isArray(brand && brand.colors) ? brand.colors : []).map(hex).filter(Boolean).slice(0, 3),
  };
  take(uid, "design");

  const today = localToday(now, tzOffsetMin);
  const when = resolveWhen(req, { now, tzOffsetMin });
  let raw = null;
  let source = "fallback";
  if (require("../services/ai/openai").ready()) {
    try {
      const router = require("../services/ai/router");
      const { reply } = await router.generateReply(
        [{ role: "user", content: JSON.stringify(modelDesignInput({ request: req, brand: b, when, today, format: fmt })) }],
        {
          system: DESIGN_SYSTEM, json: true,
          model: router.envModel("POSTER_DESIGN_MODEL", router.chatModel()),
          modelEnv: "POSTER_DESIGN_MODEL",
          timeoutMs: envNum("POSTER_DESIGN_TIMEOUT_MS", 10_000, 1000),
          noRetry: true, thinking: "LOW",
        }
      );
      raw = parseJson(reply);
      if (raw) source = "ai";
    } catch (e) {
      console.warn("poster studio: design model unavailable, facts only —", String(e.message).slice(0, 120));
    }
  }
  const out = validateDesign(raw || fallbackFields(req), { request: req, brand: b, when, today, format: fmt });
  return { ...out, source };
}

/* ------------------------------------------------------------------ */
/* BACKGROUND                                                          */
/* ------------------------------------------------------------------ */

/**
 * A text-free background, stored in the user's documents.
 * @returns {Promise<{id, url, width, height, provider, mime}>}
 */
async function background(uid, { prompt = "", style = "minimal", format = "portrait", seed } = {}) {
  assertOn();
  const st = STYLES.includes(String(style)) ? String(style) : "minimal";
  const fmt = FORMATS[format] ? format : "portrait";
  if (running.has(uid)) {
    throw new PosterError(429, "busy", "A background is already being made — it'll be ready in a moment.");
  }
  take(uid, "background");
  running.add(uid);
  try {
    const f = FORMATS[fmt];
    const words = `${cleanBackgroundPrompt(prompt, [], st)}. ${STYLE_LOOK[st]}`;
    let img;
    try {
      img = await require("../services/imagegen").generateImage(words, {
        aspect: f.shape, target: { width: f.width, height: f.height },
        purpose: "background", enhance: true, style: st, aiUpscale: true,
        seed: Number.isFinite(Number(seed)) && seed !== null && seed !== "" ? Number(seed) : undefined,
      });
    } catch (e) {
      giveBack(uid, "background");
      console.warn("poster studio: background failed —", e.message);
      throw new PosterError(502, "generation_failed",
        "The background didn't come through just now — try again in a moment.");
    }
    const docs = require("../docs/store");
    const ext = img.mime === "image/png" ? "png" : "jpg";
    const row = await docs.createDocument(uid, {
      buffer: img.buffer,
      filename: `poster-background-${Date.now()}.${ext}`,
      mime: img.mime,
      note: "AI poster background",
    });
    await docs.setMetadata(uid, row.id, {
      title: `Poster background - ${st}`,
      category: "other",
      docDate: new Date().toISOString().slice(0, 10),
      summary: `An AI-generated poster background (${st}, no text), made in the poster studio.`,
      tags: ["poster-background", "generated", "ai-art"],
      fullText: `AI-generated poster background, no text. Prompt: ${img.prompt || words}`,
    }).catch(() => null);
    return {
      id: row.id,
      url: `/docs/${row.id}/file`,
      width: img.width || f.width,
      height: img.height || f.height,
      provider: img.provider,
      mime: img.mime,
    };
  } finally {
    running.delete(uid);
  }
}

/* ------------------------------------------------------------------ */
/* BACKGROUND JOBS — the voice tool starts one and does not wait long  */
/* ------------------------------------------------------------------ */

const jobs = new Map();
const JOB_TTL_MS = 30 * 60_000;

function jobOut(job) {
  return {
    jobId: job.id,
    status: job.status,
    ...(job.background ? { background: job.background } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function startBackgroundJob(uid, args) {
  for (const [id, j] of jobs) if (Date.now() - j.at > JOB_TTL_MS) jobs.delete(id);
  const id = require("crypto").randomBytes(9).toString("base64url");
  const job = { id, uid, status: "running", background: null, error: null, at: Date.now() };
  job.promise = background(uid, args).then(
    (bg) => { job.status = "done"; job.background = bg; },
    (e) => { job.status = "failed"; job.error = e instanceof PosterError ? e.code : "error"; }
  );
  jobs.set(id, job);
  return job;
}

/** Wait up to `ms` for a job; the snapshot either way. */
async function waitJob(job, ms) {
  let timer;
  await Promise.race([job.promise, new Promise((r) => { timer = setTimeout(r, ms); })]);
  clearTimeout(timer);
  return jobOut(job);
}

function getJob(uid, id) {
  const job = jobs.get(String(id || ""));
  return job && job.uid === uid ? jobOut(job) : null;
}

/** Tests only. */
function _reset() {
  used.clear();
  running.clear();
  jobs.clear();
}

module.exports = {
  STYLES, FORMATS, PALETTES, STYLE_LOOK,
  design, background, validateDesign, resolveWhen, localToday, paletteFor, styleFor,
  startBackgroundJob, waitJob, getJob, aiOn,
  _test: { groundedRatio, fullyGrounded, factsOk, corpusOf, contrast, hex, fallbackFields, cleanBackgroundPrompt, _reset },
};
