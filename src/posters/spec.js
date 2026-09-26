/**
 * PHOTO CARDS — THE CARD'S WORDS AND LOOK, AS DATA (v1).
 * ----------------------------------------------------------------------
 * The client, an elderly father who mostly speaks to the app: "make a
 * birthday card for my daughter… with my signature". The owner
 * (2026-09-26): "build it without AI… create it like a GIFT CARD, not just
 * a photo — a photo with some designs like FLOWERS or something, with
 * 'Happy Birthday' and the caption or content the user gives".
 *
 * So the card is a SPEC — his exact words plus a few design choices — and
 * the phone draws it with bundled fonts and vector flowers. Nothing here
 * writes, polishes, translates, re-cases or cuts his words:
 *   • text is only trimmed, NFC-normalised and has runs of spaces
 *     collapsed; the wishes may keep up to 4 line breaks;
 *   • a word over a limit is REFUSED with a `need` ("can it be shorter?"),
 *     never truncated — a card that silently drops the end of a father's
 *     wishes is worse than a question;
 *   • the only words the product supplies is the heading when he did not
 *     dictate one, from the fixed table below, visible and editable.
 *
 * Pure functions only: the routes, the voice tools and the tests share
 * them, so the three can never disagree about what a card says.
 */

const OCCASIONS = ["birthday", "anniversary", "wedding", "festival", "other"];
const LANGUAGES = ["en", "ml", "hi", "kn", "ta", "te"];
const COLOURS = ["gold", "pink", "blue", "green", "white", "purple"];
const FORMATS = {
  // 4:5 is what WhatsApp shows uncropped in a chat; 9:16 fills a status.
  portrait: { width: 1080, height: 1350, aspect: "4:5" },
  story: { width: 1080, height: 1920, aspect: "9:16" },
};
const PHOTO_USES = ["enhanced", "original", "none"];
const PHOTO_COLOURS = ["keep", "bw", "sepia"];

/**
 * The gift-card designs, drawn on the phone (owner, 2026-09-26: "a photo
 * with some designs like flowers"). Each carries the colour it looks best
 * in; a colour he asks for ("make it pink") wins until he changes design.
 */
const DESIGNS = [
  { id: "floral_blush", label: "Floral Blush", colour: "pink" },
  { id: "golden_celebration", label: "Golden Celebration", colour: "gold" },
  { id: "balloons_confetti", label: "Balloons & Confetti", colour: "blue" },
  { id: "royal_mandala", label: "Royal Mandala", colour: "purple" },
  { id: "garden_green", label: "Garden Green", colour: "green" },
  { id: "classic_ivory", label: "Classic Ivory", colour: "white" },
];
const DESIGN_IDS = DESIGNS.map((d) => d.id);

/** The first design a card opens in. Flowers for a birthday, as asked. */
const DEFAULT_DESIGN = {
  birthday: "floral_blush",
  anniversary: "golden_celebration",
  wedding: "royal_mandala",
  festival: "royal_mandala",
  other: "classic_ivory",
};

/** Characters (code points), not bytes: a Malayalam name is not "longer". */
const LIMITS = { headline: 60, name: 60, message: 300, from: 80, date: 40, forWhom: 40 };
const MESSAGE_MAX_NEWLINES = 4;
const TEXT_SCALE = { min: 0.8, max: 1.6, step: 0.15, default: 1 };
const HISTORY_MAX = 20;
const AGE = { min: 1, max: 120 };

/** What each field is called when the assistant asks him to shorten it. */
const FIELD_WORDS = {
  headline: "the heading",
  name: "the name",
  message: "the wishes",
  from: "the 'from' line",
  date: "the date",
  forWhom: "who it is for",
  age: "the age",
};

/**
 * THE HEADINGS, by language and occasion. English birthdays and
 * anniversaries carry the ordinal ("Happy 25th Birthday"); the Indian
 * languages keep the heading as written and the card shows the age as a
 * numeral beside it — an ordinal in Malayalam or Tamil is a grammar this
 * table would get wrong. Every non-English line needs a native reader's
 * check before the client sees it (phone check owed).
 */
const HEADLINES = {
  en: {
    birthday: "Happy Birthday",
    anniversary: "Happy Anniversary",
    wedding: "Happy Wedding Day",
    festival: "Warm Festive Wishes",
    other: "Best Wishes",
  },
  ml: {
    birthday: "ജന്മദിനാശംസകൾ",
    anniversary: "വിവാഹ വാർഷിക ആശംസകൾ",
    wedding: "വിവാഹ ആശംസകൾ",
    festival: "ഉത്സവ ആശംസകൾ",
    other: "ആശംസകൾ",
  },
  hi: {
    birthday: "जन्मदिन की शुभकामनाएँ",
    anniversary: "सालगिरह की शुभकामनाएँ",
    wedding: "विवाह की शुभकामनाएँ",
    festival: "त्योहार की शुभकामनाएँ",
    other: "शुभकामनाएँ",
  },
  kn: {
    birthday: "ಹುಟ್ಟುಹಬ್ಬದ ಶುಭಾಶಯಗಳು",
    anniversary: "ವಿವಾಹ ವಾರ್ಷಿಕೋತ್ಸವದ ಶುಭಾಶಯಗಳು",
    wedding: "ವಿವಾಹದ ಶುಭಾಶಯಗಳು",
    festival: "ಹಬ್ಬದ ಶುಭಾಶಯಗಳು",
    other: "ಶುಭಾಶಯಗಳು",
  },
  ta: {
    birthday: "பிறந்தநாள் வாழ்த்துகள்",
    anniversary: "திருமண நாள் வாழ்த்துகள்",
    wedding: "திருமண வாழ்த்துகள்",
    festival: "பண்டிகை வாழ்த்துகள்",
    other: "வாழ்த்துகள்",
  },
  te: {
    birthday: "పుట్టినరోజు శుభాకాంక్షలు",
    anniversary: "పెళ్లి రోజు శుభాకాంక్షలు",
    wedding: "వివాహ శుభాకాంక్షలు",
    festival: "పండుగ శుభాకాంక్షలు",
    other: "శుభాకాంక్షలు",
  },
};

/** 1st 2nd 3rd 4th … 11th 12th 13th … 21st 22nd … 101st 111th. */
function ordinalEn(n) {
  const v = Math.abs(Math.trunc(Number(n)));
  const mod100 = v % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${v}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[v % 10] || "th";
  return `${v}${suffix}`;
}

/** The heading the table gives for this card, when he dictated none. */
function autoHeadline({ language = "en", occasion = "birthday", age = null } = {}) {
  const lang = HEADLINES[language] ? language : "en";
  const occ = HEADLINES[lang][occasion] ? occasion : "other";
  const base = HEADLINES[lang][occ];
  if (lang === "en" && age && (occ === "birthday" || occ === "anniversary")) {
    return `Happy ${ordinalEn(age)} ${occ === "birthday" ? "Birthday" : "Anniversary"}`;
  }
  return base;
}

/* ------------------------------------------------------------------ */
/* WORDS                                                               */
/* ------------------------------------------------------------------ */

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Tidy, never rewrite. ZWJ/ZWNJ (U+200D/U+200C) are not whitespace to
 * JavaScript and must survive: Malayalam chillu letters and Hindi
 * half-forms are spelled with them.
 */
function cleanText(raw, { multiline = false } = {}) {
  let t = String(raw ?? "").normalize("NFC").replace(/\r\n?/g, "\n").replace(CONTROL, "");
  t = t.replace(/[^\S\n]+/g, " ");
  if (!multiline) return t.replace(/\s*\n\s*/g, " ").trim();
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  // Line breaks past the fourth become spaces: every word stays, the card
  // just does not grow a sixth line.
  const head = lines.slice(0, MESSAGE_MAX_NEWLINES + 1);
  if (lines.length > MESSAGE_MAX_NEWLINES + 1) {
    head[MESSAGE_MAX_NEWLINES] = lines.slice(MESSAGE_MAX_NEWLINES).join(" ");
  }
  return head.join("\n");
}

const lengthOf = (s) => [...String(s || "")].length;

const SCRIPTS = [
  ["ml", /\p{Script=Malayalam}/u],
  ["hi", /\p{Script=Devanagari}/u],
  ["kn", /\p{Script=Kannada}/u],
  ["ta", /\p{Script=Tamil}/u],
  ["te", /\p{Script=Telugu}/u],
];

/**
 * The language a text is WRITTEN in, by counting letters per script.
 * Counting (not "any Malayalam letter wins") keeps "Happy Birthday
 * അഞ്ജലി" an English card with a Malayalam name. null when no letters.
 */
function scriptOf(text) {
  const counts = { en: 0, ml: 0, hi: 0, kn: 0, ta: 0, te: 0 };
  for (const ch of String(text || "")) {
    if (/\p{Script=Latin}/u.test(ch)) { counts.en++; continue; }
    for (const [lang, rx] of SCRIPTS) {
      if (rx.test(ch)) { counts[lang]++; break; }
    }
  }
  let best = null;
  let bestN = 0;
  for (const [lang, n] of Object.entries(counts)) {
    if (n > bestN) { best = lang; bestN = n; }
  }
  return best;
}

/** The language a card defaults to: its wishes, else its name, else English. */
function detectLanguage(spec) {
  return scriptOf(spec.message) || scriptOf(spec.name) || "en";
}

/** 'A-N-J-A-L-I' for a Latin name, so the read-back can be checked; else null. */
function spell(name) {
  const t = cleanText(name);
  if (!t || !/\p{Script=Latin}/u.test(t)) return null;
  if (/[^\p{Script=Latin}\s.'’-]/u.test(t)) return null;
  return t
    .split(/\s+/)
    .map((w) => [...w.replace(/[^\p{Script=Latin}]/gu, "")].map((c) => c.toUpperCase()).join("-"))
    .filter(Boolean)
    .join(" ");
}

/* ------------------------------------------------------------------ */
/* COLOURS AND DESIGNS BY THE WORDS PEOPLE USE                         */
/* ------------------------------------------------------------------ */

const COLOUR_ALIASES = {
  red: "pink", rose: "pink", maroon: "pink", peach: "pink", magenta: "pink",
  orange: "gold", yellow: "gold", cream: "gold", golden: "gold", saffron: "gold",
  navy: "purple", dark: "purple", night: "purple", violet: "purple", lavender: "purple",
  classic: "white", ivory: "white", silver: "white",
  sky: "blue", "light blue": "blue", teal: "blue",
  mint: "green", leaf: "green", "light green": "green",
};

/** "red" → pink, "Golden" → gold; null for a colour the cards do not have. */
function resolveColour(word) {
  const w = String(word || "").trim().toLowerCase();
  if (!w) return null;
  if (COLOURS.includes(w)) return w;
  return COLOUR_ALIASES[w] || null;
}

const DESIGN_ALIASES = {
  floral: "floral_blush", flower: "floral_blush", flowers: "floral_blush", roses: "floral_blush",
  blush: "floral_blush", peony: "floral_blush",
  gold: "golden_celebration", golden: "golden_celebration", celebration: "golden_celebration",
  stars: "golden_celebration",
  balloon: "balloons_confetti", balloons: "balloons_confetti", confetti: "balloons_confetti",
  party: "balloons_confetti", playful: "balloons_confetti",
  mandala: "royal_mandala", rangoli: "royal_mandala", royal: "royal_mandala",
  marigold: "royal_mandala", indian: "royal_mandala", festive: "royal_mandala",
  garden: "garden_green", leaves: "garden_green", leafy: "garden_green", wreath: "garden_green",
  classic: "classic_ivory", ivory: "classic_ivory", simple: "classic_ivory",
  elegant: "classic_ivory", plain: "classic_ivory",
};

/** A design id from an id, a label or a word ("flowers"); null if none. */
function resolveDesign(word) {
  const w = String(word || "").trim().toLowerCase().replace(/&/g, "and");
  if (!w) return null;
  const id = w.replace(/[\s-]+/g, "_").replace(/_and_/g, "_");
  if (DESIGN_IDS.includes(id)) return id;
  const byLabel = DESIGNS.find((d) => d.label.toLowerCase().replace(/&/g, "and") === w);
  if (byLabel) return byLabel.id;
  for (const part of w.split(/[\s_-]+/)) {
    if (DESIGN_ALIASES[part]) return DESIGN_ALIASES[part];
  }
  return null;
}

/** "Use the other design" — the next one round the list. */
function nextDesign(current) {
  const i = DESIGN_IDS.indexOf(current);
  return DESIGN_IDS[(i + 1) % DESIGN_IDS.length];
}

const designById = (id) => DESIGNS.find((d) => d.id === id) || DESIGNS[0];

/* ------------------------------------------------------------------ */
/* THE SPEC                                                            */
/* ------------------------------------------------------------------ */

function defaultSpec(occasion = "birthday") {
  const occ = OCCASIONS.includes(occasion) ? occasion : "birthday";
  const design = DEFAULT_DESIGN[occ];
  return {
    v: 1,
    occasion: occ,
    language: "en",
    languageCustom: false,
    forWhom: "",
    headline: autoHeadline({ language: "en", occasion: occ }),
    headlineCustom: false,
    name: "",
    age: null,
    message: "",
    from: "",
    date: "",
    design,
    colour: designById(design).colour,
    colourCustom: false,
    format: "portrait",
    textScale: TEXT_SCALE.default,
    photoUse: "none",
    // The photo's colours ON THIS CARD (review, 2026-09-26): part of the
    // card, so "black and white" is one versioned edit that undo takes
    // back, and each colour is its own file (?colour= on the photo URL).
    photoColour: "keep",
    photoFocus: { x: 0.5, y: 0.5, zoom: 1 },
    signature: false,
  };
}

const TEXT_FIELDS = ["headline", "name", "message", "from", "date", "forWhom"];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;

function badChange(message) {
  return { error: "bad_change", message };
}

/**
 * Merge `partial` (REST camelCase keys) over `prev` and re-derive what
 * follows from it. Returns {spec} or {need:[…]} or {error:'bad_change'}.
 *
 * Derived, never stored separately: the heading follows the occasion,
 * language and age until he dictates one (`headlineCustom`); the language
 * follows the words until someone names one (`languageCustom`); the colour
 * follows the design until he names one (`colourCustom`).
 */
function normalize(partial = {}, prev = null) {
  const p = partial && typeof partial === "object" ? partial : {};
  const spec = prev ? JSON.parse(JSON.stringify(prev)) : defaultSpec(p.occasion);
  const need = [];

  if (p.occasion !== undefined) {
    if (!OCCASIONS.includes(p.occasion)) return badChange(`occasion must be one of ${OCCASIONS.join(", ")}`);
    spec.occasion = p.occasion;
  }

  for (const f of TEXT_FIELDS) {
    if (p[f] === undefined || p[f] === null) continue;
    const t = cleanText(p[f], { multiline: f === "message" });
    const n = lengthOf(t);
    if (n > LIMITS[f]) {
      need.push({ field: f, reason: "too_long", max: LIMITS[f], length: n });
      continue;
    }
    if (f === "headline") {
      spec.headlineCustom = t !== "";
      if (t) spec.headline = t;
    } else {
      spec[f] = t;
    }
  }

  if (p.age !== undefined) {
    if (p.age === null || p.age === "") {
      spec.age = null;
    } else {
      const a = Number(p.age);
      if (!Number.isInteger(a) || a < AGE.min || a > AGE.max) {
        need.push({ field: "age", reason: "out_of_range", min: AGE.min, max: AGE.max });
      } else {
        spec.age = a;
      }
    }
  }
  if (need.length) return { need };

  if (p.language !== undefined && p.language !== null && p.language !== "") {
    if (!LANGUAGES.includes(p.language)) return badChange(`language must be one of ${LANGUAGES.join(", ")}`);
    spec.language = p.language;
    spec.languageCustom = true;
  } else if (!spec.languageCustom) {
    spec.language = detectLanguage(spec);
  }

  if (p.design !== undefined && p.design !== null && p.design !== "") {
    const d = p.design === "next" ? nextDesign(spec.design) : resolveDesign(p.design);
    if (!d) return badChange(`design must be one of ${DESIGN_IDS.join(", ")} or next`);
    spec.design = d;
    if (!spec.colourCustom) spec.colour = designById(d).colour;
  }
  if (p.colour !== undefined && p.colour !== null && p.colour !== "") {
    const c = resolveColour(p.colour);
    if (!c) return badChange(`colour must be one of ${COLOURS.join(", ")}`);
    spec.colour = c;
    spec.colourCustom = true;
  }
  if (p.format !== undefined && p.format !== null && p.format !== "") {
    if (!FORMATS[p.format]) return badChange(`format must be one of ${Object.keys(FORMATS).join(", ")}`);
    spec.format = p.format;
  }
  if (p.textScale !== undefined) {
    const s = Number(p.textScale);
    if (!Number.isFinite(s)) return badChange("textScale must be a number");
    spec.textScale = round2(clamp(s, TEXT_SCALE.min, TEXT_SCALE.max));
  }
  if (p.photoUse !== undefined) {
    if (!PHOTO_USES.includes(p.photoUse)) return badChange(`photoUse must be one of ${PHOTO_USES.join(", ")}`);
    spec.photoUse = p.photoUse;
  }
  if (p.photoColour !== undefined) {
    if (!PHOTO_COLOURS.includes(p.photoColour)) {
      return badChange(`photoColour must be one of ${PHOTO_COLOURS.join(", ")}`);
    }
    spec.photoColour = p.photoColour;
  }
  // A card saved before the field existed shows its photo in its own colours.
  if (!PHOTO_COLOURS.includes(spec.photoColour)) spec.photoColour = "keep";
  if (p.photoFocus !== undefined) {
    const f = p.photoFocus || {};
    const x = Number(f.x ?? spec.photoFocus.x);
    const y = Number(f.y ?? spec.photoFocus.y);
    const zoom = Number(f.zoom ?? spec.photoFocus.zoom);
    if (![x, y, zoom].every(Number.isFinite)) return badChange("photoFocus needs numbers x, y and zoom");
    spec.photoFocus = { x: round2(clamp(x, 0, 1)), y: round2(clamp(y, 0, 1)), zoom: round2(clamp(zoom, 1, 3)) };
  }
  if (p.signature !== undefined) spec.signature = p.signature === true || p.signature === "true";

  if (!spec.headlineCustom) spec.headline = autoHeadline(spec);
  spec.v = 1;
  return { spec };
}

/**
 * One edit, as the app or a voice tool asks for it. `undo` is handled by
 * the caller (it needs the history), so it is refused here.
 * Returns {spec, changed, limitReached?} | {need} | {error}.
 */
function applyChange(spec, change = {}) {
  const c = change && typeof change === "object" ? change : {};
  const known = ["set", "textSize", "colour", "design", "format", "photoUse", "photoColour",
    "photoFocus", "signature", "photoId", "occasion", "language", "undo"];
  const unknown = Object.keys(c).filter((k) => !known.includes(k));
  if (unknown.length) return badChange(`unknown change: ${unknown.join(", ")}`);
  if (c.undo) return badChange("undo is its own change");

  const partial = {};
  if (c.set !== undefined) {
    if (!c.set || typeof c.set !== "object") return badChange("set must be an object");
    const allowed = [...TEXT_FIELDS, "age"];
    const bad = Object.keys(c.set).filter((k) => !allowed.includes(k));
    if (bad.length) return badChange(`cannot set: ${bad.join(", ")}`);
    Object.assign(partial, c.set);
  }
  for (const k of ["colour", "design", "format", "photoUse", "photoColour", "photoFocus", "signature",
    "occasion", "language"]) {
    if (c[k] !== undefined) partial[k] = c[k];
  }

  let limitReached = false;
  if (c.textSize !== undefined) {
    const cur = Number(spec.textScale) || TEXT_SCALE.default;
    if (c.textSize === "bigger") {
      if (cur >= TEXT_SCALE.max) limitReached = true;
      partial.textScale = round2(Math.min(TEXT_SCALE.max, cur + TEXT_SCALE.step));
    } else if (c.textSize === "smaller") {
      if (cur <= TEXT_SCALE.min) limitReached = true;
      partial.textScale = round2(Math.max(TEXT_SCALE.min, cur - TEXT_SCALE.step));
    } else if (c.textSize === "reset") {
      partial.textScale = TEXT_SCALE.default;
    } else {
      return badChange("textSize must be bigger, smaller or reset");
    }
  }

  const out = normalize(partial, spec);
  if (out.need || out.error) return out;
  const changed = JSON.stringify(out.spec) !== JSON.stringify(spec);
  return { spec: out.spec, changed, ...(limitReached ? { limitReached } : {}) };
}

/**
 * The words printed on the card, top to bottom, exactly as they appear —
 * the saved document's text and the assistant's read-back. The age line is
 * the numeral the non-English cards show beside the heading.
 */
function words(spec) {
  const s = spec || {};
  const ageLine = s.language !== "en" && s.age &&
    (s.occasion === "birthday" || s.occasion === "anniversary") ? String(s.age) : "";
  return [
    s.headline,
    ageLine,
    s.name,
    ...String(s.message || "").split("\n"),
    s.from,
    s.date,
  ].map((x) => String(x || "").trim()).filter(Boolean);
}

/** What is still unsaid, in the order the assistant should ask for it. */
function missing(spec) {
  const out = [];
  if (!spec.name) out.push("name");
  if (!spec.age && (spec.occasion === "birthday" || spec.occasion === "anniversary")) out.push("age");
  if (!spec.message) out.push("message");
  if (!spec.from) out.push("from");
  return out;
}

module.exports = {
  OCCASIONS, LANGUAGES, COLOURS, FORMATS, DESIGNS, DESIGN_IDS, DEFAULT_DESIGN,
  PHOTO_USES, PHOTO_COLOURS, LIMITS, MESSAGE_MAX_NEWLINES, TEXT_SCALE, HISTORY_MAX,
  AGE, HEADLINES, FIELD_WORDS,
  ordinalEn, autoHeadline, cleanText, lengthOf, scriptOf, detectLanguage, spell,
  resolveColour, resolveDesign, nextDesign, designById,
  defaultSpec, normalize, applyChange, words, missing,
};
