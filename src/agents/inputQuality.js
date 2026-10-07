/**
 * INPUT QUALITY — is this sentence safe to act on?
 * ------------------------------------------------
 * Speech-to-text hands the assistant nonsense more often than anyone
 * expects: a cough becomes "con", a spoken phone number arrives as bare
 * digits, Tulu comes back as Japanese. The model, asked to be helpful,
 * fills the gap from the last thing it understood — which is how "con"
 * placed a call to the previous contact, and how a phone number was read
 * as "call Loki sir".
 *
 * This module judges the TEXT ONLY, before any tool can run:
 *   clear   — act on it normally
 *   weak    — understandable but thin; fine for talk, not for actions
 *             that touch the world (calls, messages, app launches)
 *   garbled — do not act at all; ask the user to repeat
 *
 * The rule it enforces downstream (src/tools/registry.js) is simple and
 * structural: an action tool may not run on garbled input, and may not
 * INHERIT its subject from an earlier turn when the input is weak.
 */

/** Words that are short but perfectly clear, so length alone never damns them. */
const SHORT_OK = new Set([
  "yes", "yeah", "yep", "ok", "okay", "no", "nope", "stop", "wait", "hi",
  "hey", "hello", "call", "next", "back", "done", "sure", "cancel", "repeat",
  "louder", "again", "who", "why", "what", "when", "where", "how",
  "haan", "haa", "nahi", "nahin", "sari", "sari", "ille", "aayta", "bodchi",
  "aan", "athe", "ho", "hoon", "acha", "theek", "bas", "ಹೌದು", "ಇಲ್ಲ", "ಸರಿ",
  "हाँ", "हां", "नहीं", "ठीक", "बस", "रुको",
  // ONE-WORD DEVICE COMMANDS. "hotspot", "flashlight", "mute" are complete
  // requests on a phone — a user saying one of these wants exactly that,
  // and refusing them as "a single word with no sentence around it" was
  // measured in production ("hotspot" → asked to repeat).
  // YES, NO, OKAY, ENOUGH IN THE SOUTHERN LANGUAGES (2026-09-26). The
  // client, answering in Malayalam, was told "sorry, I didn't catch that"
  // to a plain "ശരി": no Malayalam, Tamil or Telugu word was here, and the
  // Kannada and Hindi ones above never matched either (see the single-word
  // check below). Written as spoken, and romanised as recognisers often
  // return them.
  "ശരി", "അതെ", "ഇല്ല", "വേണ്ട", "വേണം", "മതി", "ഉണ്ട്", "ഓക്കെ", "ശരിയാണ്",
  "சரி", "ஆமாம்", "ஆம்", "இல்லை", "வேண்டாம்", "போதும்",
  "సరే", "అవును", "ఔను", "లేదు", "వద్దు", "చాలు",
  "ಬೇಡ", "ಬೇಕು", "ಸಾಕು", "जी", "हाँजी",
  "shari", "sheri", "illa", "venda", "venam", "mathi", "aama", "aamaam",
  "illai", "vendaam", "podhum", "sare", "avunu", "ledu", "vaddu", "chaalu",
  "ji", "beda", "beku", "saaku",
  "hotspot", "flashlight", "torch", "bluetooth", "wifi", "wi-fi", "volume",
  "mute", "unmute", "quieter", "softer", "brighter", "dimmer", "pause",
  "play", "resume", "skip", "previous", "alarm", "timer", "snooze", "camera",
  "screenshot", "lock", "silent", "vibrate", "home", "settings", "news",
  "weather", "brief", "update", "help", "navigate", "music", "radio",
]);

/** Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam. */
const INDIC_SCRIPT = /[ऀ-ൿ]/u;

for (const w of [...SHORT_OK]) SHORT_OK.add(w.normalize("NFC"));

/** Verbs that make two to four words a request rather than a fragment. */
const IMPERATIVE =
  /^(open|close|call|ring|dial|set|remind|play|pause|stop|show|send|text|message|turn|switch|start|book|order|search|find|look|navigate|take|read|check|tell|wake|mute|unmute|increase|decrease|raise|lower|enable|disable|cancel|delete|add|create|make|schedule|note|save|kholo|खोलो|band|बंद|chalao|चलाओ|lagao|लगाओ|karo|करो|dikhao|दिखाओ|bhejo|भेजो|bulao|बुलाओ|batao|बताओ|ತೆರೆ|ತೆರೆಯಿರಿ|ಮಾಡು|ಮಾಡಿ|ಹಾಕು|ಹಾಕಿ|ತೋರಿಸು|ತೋರಿಸಿ|ಕರೆ|ಕಳಿಸು|ಕಳಿಸಿ)$/iu;

/** Scripts an Indian user's speech should not normally arrive in — a
 *  strong sign the recogniser guessed the wrong language entirely. */
const FOREIGN_SCRIPT =
  /[぀-ヿㇰ-ㇿ가-힯Ѐ-ӿ؀-ۿ฀-๿]/;

/** Latin text that is almost certainly a mis-detected European language.
 *  Only words an English/Hinglish speaker never says: "para" ("write a
 *  para about..."), "und", "sono", "nous", "vous" and "de que" were
 *  dropped -- each could mark a real request garbled. */
const EUROPEAN_GIVEAWAY =
  /\b(je suis|je dis|n'accepte|prenez|arrêtez|c'est|el grupo|conciencia|estoy|gracias|ich bin|nicht|danke|war alle|questo)\b/i;

/**
 * COMBINING MARKS ARE PART OF THE LETTER, and forgetting that made this
 * gate reject Indian languages as noise.
 *
 * Devanagari and the southern scripts write most vowels as matras — ि े ो
 * ा ् — which Unicode classes as \p{M}, not \p{L}. Counting letters alone,
 * a perfectly clear Hindi sentence scores around 0.36 and is thrown out as
 * "mostly non-letters", while the same sentence scores 0.66 once its marks
 * are counted. Measured against real transcripts: a user asking about
 * Delhi-Bengaluru flights was told "I didn't hear that properly" SEVEN
 * times in four minutes, having said nothing wrong at any point.
 *
 * This is the whole product's audience — Hindi, Kannada, Tamil, Telugu,
 * Malayalam, Tulu, Bengali all carry marks the same way.
 */
function letterRatio(t) {
  const letters = (t.match(/[\p{L}\p{M}]/gu) || []).length;
  return t.length ? letters / t.length : 0;
}

/**
 * DIGITS ARE CONTENT IN A SHORT COMMAND. "4:30 a.m. alarm tomorrow" is a
 * complete, clear request, but letterRatio scores it 0.62 — the colon,
 * the digits and the dots all count against it — and it was refused as
 * "fragmentary" in production, so the alarm was never set. For the short
 * -phrase check the measure is letters, marks and digits over the
 * visible characters (whitespace and invisible format characters such as
 * the zero-width joiner Indic keyboards emit are neither for nor against).
 */
function contentRatio(t) {
  const visible = t.replace(/[\s\p{Cf}]/gu, "");
  if (!visible.length) return 0;
  const content = (visible.match(/[\p{L}\p{M}\p{N}]/gu) || []).length;
  return content / visible.length;
}

/**
 * ONE-WORD ANSWERS TO THE QUESTION JUST ASKED (photo cards, 2026-09-26).
 * The card flow asks one thing at a time — "How old is she turning?",
 * "What's her name, as it should be written?", "Pink, gold or blue?" —
 * and the answer is one word. Judged alone, "25" was garbled ("mostly
 * non-letters"), "Riya" and "pink" were garbled ("single short
 * fragment"), so the turn ended in "sorry, I didn't catch that" to a
 * perfectly clear answer. What the assistant just said is the context
 * that makes them answers; read from its last line:
 *   expectsNumber — it asked for a number, a phone, an age ("how old");
 *   expectsName   — it asked a question about a name;
 *   offered       — the words of the question it asked, plus, when it was
 *                   talking about the card, the card's own words (colours,
 *                   designs), so "pink" after "What would you like to
 *                   change?" is an answer too.
 * An answer found this way is 'weak', never 'clear': enough to talk and to
 * edit the draft on screen (registry draftEdit), never enough to act on
 * the world.
 */
const CARD_TALK = /\b(card|poster|design|colou?r|letters|heading|wishes)\b/i;
const CARD_WORDS =
  "pink gold blue green white purple red rose maroon peach golden yellow orange cream saffron " +
  "navy violet lavender classic ivory silver sky teal mint leaf flowers flower floral roses " +
  "peony blush celebration stars balloons balloon confetti party playful mandala rangoli royal " +
  "marigold indian festive garden leaves leafy wreath simple elegant plain bigger smaller larger " +
  "tall sepia undo";
const NOT_AN_ANSWER = new Set(("the and you your for with are was not but can its our has have had " +
  "she her his him they them this that there then than what which would like shall should will").split(" "));

function expectationsFrom(lastAssistantLine) {
  const t = String(lastAssistantLine || "");
  const asked = t.includes("?");
  return {
    expectsNumber: /\b(number|digits|phone|old|age)\b/i.test(t),
    expectsName: asked && /\bnames?\b/i.test(t),
    offered: (asked ? t : "") + (CARD_TALK.test(t) ? ` ${CARD_WORDS}` : ""),
  };
}

function offeredWords(text) {
  return new Set(
    String(text || "").normalize("NFC").toLowerCase()
      .split(/[^\p{L}\p{M}\p{N}]+/u)
      .filter((w) => [...w].length >= 3 && !NOT_AN_ANSWER.has(w))
  );
}

/**
 * @param text        what the recogniser produced
 * @param opts.expectsNumber  true when the conversation just asked for a
 *                            number (then bare digits are an ANSWER, not noise)
 * @param opts.expectsName    true when the conversation just asked for a name
 * @param opts.offered        words the assistant just offered (see above)
 * @param opts.languages      languages this user actually speaks
 * @returns {{quality:'clear'|'weak'|'garbled', reason:string, digitsOnly:boolean}}
 */
function assess(text, { expectsNumber = false, expectsName = false, offered = "", languages = [], known = null } = {}) {
  const raw = String(text || "").trim();
  if (!raw) return { quality: "garbled", reason: "empty", digitsOnly: false };

  // THE NAME OF ONE OF THEIR SHORTCUTS (2026-09-27). "pooja" or "പൂജ" on
  // its own reads as one weak word; said whole, it is a known command.
  // `known` is the caller's cached list of that user's name keys.
  if (known && known.length) {
    const m = require("../shortcuts/match");
    const keys = new Set(known);
    if (keys.has(m.nameKey(raw)) || keys.has(m.stripFillers(raw))) {
      return { quality: "clear", reason: "the name of one of their shortcuts", digitsOnly: false };
    }
  }

  const lower = raw.toLowerCase();
  const words = raw.split(/\s+/).filter(Boolean);
  const digitsOnly = /^[\d\s+()-]{4,}$/.test(raw);

  // A bare number is meaningful ONLY when something asked for one. Left to
  // itself it is a misheard fragment, and it must never be folded into the
  // previous sentence's intent ("16366895760" became "call Loki sir").
  if (digitsOnly) {
    return expectsNumber
      ? { quality: "clear", reason: "number in answer to a question", digitsOnly: true }
      : { quality: "weak", reason: "bare digits with nothing asking for a number", digitsOnly: true };
  }
  // A short number ("25", "60th") only ever as the answer to "how old?".
  if (expectsNumber && /^\d{1,3}(st|nd|rd|th)?\.?$/i.test(raw)) {
    return { quality: "clear", reason: "number in answer to a question", digitsOnly: /^\d+$/.test(raw) };
  }

  // Wrong-script output for a user who does not speak that script.
  const speaksForeign = languages.some((l) =>
    /japanese|korean|russian|arabic|thai|chinese|urdu|persian|farsi|kashmiri|sindhi/i.test(String(l))
  );
  if (!speaksForeign && FOREIGN_SCRIPT.test(raw)) {
    return { quality: "garbled", reason: "recognised in a script the user does not speak", digitsOnly: false };
  }
  const speaksEuropean = languages.some((l) =>
    /french|spanish|german|italian|portuguese/i.test(String(l))
  );
  if (!speaksEuropean && EUROPEAN_GIVEAWAY.test(raw)) {
    return { quality: "garbled", reason: "recognised as a European language the user does not speak", digitsOnly: false };
  }

  // Mostly punctuation or symbols.
  if (letterRatio(raw) < 0.4 && !digitsOnly) {
    return { quality: "garbled", reason: "mostly non-letters", digitsOnly: false };
  }

  // One short token that is not a known word: "con", "flow", "me", "aí".
  if (words.length === 1) {
    // Marks kept (2026-09-26): with them stripped, "ಸರಿ" became "ಸರ" and
    // "हाँ" became "ह", so the Indian words listed above never matched and
    // every one-word Indian-language answer was refused as noise.
    const w = lower.replace(/[^\p{L}\p{M}\p{N}]/gu, "").normalize("NFC");
    if (SHORT_OK.has(w)) return { quality: "clear", reason: "short but unambiguous", digitsOnly: false };
    // The answer to the question just asked (see expectationsFrom).
    if (offered && offeredWords(offered).has(w)) {
      return { quality: "weak", reason: "one of the words just offered", digitsOnly: false };
    }
    if (expectsName && [...w].length >= 2 && /^[\p{L}\p{M}]+$/u.test(w)) {
      return { quality: "weak", reason: "a name in answer to a question", digitsOnly: false };
    }
    // A single word in an Indian script is a real word the recogniser
    // heard, not the "con"/"flow" crumbs a mis-set English recogniser
    // makes of noise: understandable, just too thin to act on alone.
    if (INDIC_SCRIPT.test(w)) {
      return { quality: "weak", reason: "single word with no sentence around it", digitsOnly: false };
    }
    if (w.length <= 4) {
      return { quality: "garbled", reason: "single short fragment", digitsOnly: false };
    }
    return { quality: "weak", reason: "single word with no sentence around it", digitsOnly: false };
  }

  // Two to four words that read as fragments rather than a request:
  // a repeated word, a stray token with digits in it, no verb at all —
  // "that that Y2I tab", "el grupo", "photos photos mein".
  if (words.length <= 4) {
    const norm = words.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""));
    // A recogniser doubling a word ("Open Uber app Uber") is still a
    // request when it starts with a verb; only a verbless repeat is noise.
    const imperative = IMPERATIVE.test(norm[0] || "");
    const repeated = !imperative && new Set(norm).size < norm.length;
    // The same for a token with digits in it: "Call Ravi B2" is a contact
    // saved with a letter+digit tag, as Indian address books often are,
    // and refusing it sent one user round the same refusal 16 times
    // (2026-09-18..24). Verbless, "that that Y2I tab" is still noise.
    const alnumMix = !imperative && norm.some((w) => /\d/.test(w) && /\p{L}/u.test(w));
    // Nothing but crumbs: "o a", "a e i". contentRatio ignores whitespace
    // (so "4:30 a.m. alarm" passes), which also let a run of single
    // letters score as a full sentence — and live mode answered them
    // confidently. Single characters only: "go on" and "है ना" are real.
    // Marks are kept here: stripped, "हाँ" shrinks to one letter.
    const crumbs = words
      .map((w) => w.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, ""))
      .every((w) => [...w].length <= 1);
    if (repeated || alnumMix || crumbs || contentRatio(raw) < 0.7) {
      return { quality: "weak", reason: "fragmentary", digitsOnly: false };
    }
  }

  return { quality: "clear", reason: "", digitsOnly: false };
}

/** What to say instead of acting, in the user's own language where known. */
function clarificationFor(assessment, { language = "" } = {}) {
  // ENGLISH IN, ENGLISH OUT (client, 2026-10-01): a profile language of
  // Kannada must not turn "Tell me the" into a Kannada "say that again" —
  // what was heard was Latin script, so the reprompt is English. Only a
  // transcript with no Latin letters at all follows the profile language.
  const heard = String((assessment && assessment.heard) || "");
  const latin = /[A-Za-z]/.test(heard);
  const indic = /[ऀ-෿]/.test(heard);
  const l = latin && !indic ? "" : String(language).toLowerCase();
  if (/hindi/.test(l)) return "माफ़ कीजिए, वह ठीक से सुनाई नहीं दिया — फिर से बोलिए?";
  if (/kannada/.test(l)) return "ಕ್ಷಮಿಸಿ, ಅದು ಸರಿಯಾಗಿ ಕೇಳಿಸಲಿಲ್ಲ — ಇನ್ನೊಮ್ಮೆ ಹೇಳ್ತೀರಾ?";
  if (/tulu/.test(l)) return "ಕ್ಷಮಿಸಿ, ಅವು ಸರಿಯಾದ್ ಕೇನ್ಜಿ — ಒಂಜಿ ಸರ್ತಿ ಪನ್ಪರಾ?";
  if (/malayalam/.test(l)) return "ക്ഷമിക്കണം, അത് ശരിയായി കേട്ടില്ല — ഒന്നുകൂടി പറയാമോ?";
  if (/tamil/.test(l)) return "மன்னிக்கவும், அது சரியாகக் கேட்கவில்லை — மீண்டும் சொல்ல முடியுமா?";
  if (/telugu/.test(l)) return "క్షమించండి, అది సరిగ్గా వినిపించలేదు — మళ్ళీ చెప్పగలరా?";
  if (assessment && assessment.digitsOnly) {
    return "I heard some numbers but nothing else — what would you like me to do with them?";
  }
  return "Sorry, I didn't catch that — could you say it again?";
}

/** True when an action that touches the world may run on this input. */
function mayAct(assessment) {
  return !assessment || assessment.quality === "clear";
}

module.exports = { assess, clarificationFor, mayAct, expectationsFrom, SHORT_OK };
