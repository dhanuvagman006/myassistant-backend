/**
 * WHICH LANGUAGE TO SPEAK — read from what the user actually said.
 * ---------------------------------------------------------------
 * The old rule was a pin: whatever language was chosen once on the
 * onboarding screen was spoken in EVERY reply forever, and the only
 * escape was the model noticing an explicit request and remembering to
 * call update_my_profile. Measured 2026-09-14: a user asked in plain
 * English to be spoken to in English, and was greeted in Hindi again the
 * next session. The pin held and the tool call never happened — the same
 * live model that narrates actions without performing them.
 *
 * So the language of a reply is no longer a judgement call. Two things
 * are decided here, in code, before the model sees anything:
 *
 *   requestedLanguage(text)  an EXPLICIT ask — "speak in English",
 *                            "hindi mein baat karo", "ಕನ್ನಡದಲ್ಲಿ ಮಾತಾಡಿ".
 *                            The caller persists it. No tool call needed.
 *
 *   detectSpoken(text)       which language this transcript is IN, so the
 *                            reply can mirror it. Returns "" when unsure,
 *                            because a guess here is worse than silence.
 *
 * TRANSCRIPTION IS NOT TRUTH — see src/agents/inputQuality.js. Indian
 * speech comes back as Japanese, French or German often enough that
 * following the transcript's language is a bug, not a feature. Nothing
 * here ever reports a language outside the set this product's users
 * actually speak; a European or East-Asian transcript returns "" and the
 * existing garbled path handles it.
 */

/* ------------------------------------------------------------------ *
 * The languages this assistant speaks.
 *
 * `script` is the decisive signal — Indic text is unambiguous about its
 * language in a way Latin text never is. `names` are the ways a user
 * refers to the language out loud, in English, romanised, and natively.
 * ------------------------------------------------------------------ */
const LANGUAGES = [
  {
    name: "English",
    script: null, // Latin — inferred by elimination, never by script
    names: ["english", "angrezi", "angreji", "inglish",
            "अंग्रेजी", "अंग्रेज़ी", "इंग्लिश", "ಇಂಗ್ಲಿಷ್", "ಆಂಗ್ಲ",
            "ஆங்கிலம்", "ஆங்கில", "ఇంగ్లీష్", "ഇംഗ്ലീഷ്", "ইংরেজি"],
  },
  {
    name: "Hindi",
    script: /[ऀ-ॿ]/,
    names: ["hindi", "hindhi", "हिंदी", "हिन्दी", "ಹಿಂದಿ", "ஹிந்தி", "హిందీ", "ഹിന്ദി"],
  },
  {
    name: "Kannada",
    script: /[ಀ-೿]/,
    names: ["kannada", "kannad", "canada language", "ಕನ್ನಡ", "कन्नड़", "कन्नड"],
  },
  {
    name: "Tamil",
    script: /[஀-௿]/,
    names: ["tamil", "தமிழ்", "தமிழ", "तमिल", "ತಮಿಳು"],
  },
  {
    name: "Telugu",
    script: /[ఀ-౿]/,
    names: ["telugu", "తెలుగు", "तेलुगु", "ತೆಲುಗು"],
  },
  {
    name: "Malayalam",
    script: /[ഀ-ൿ]/,
    names: ["malayalam", "മലയാളം", "മലയാള", "मलयालम", "ಮಲಯಾಳಂ"],
  },
  {
    name: "Marathi",
    script: null, // Devanagari, shared with Hindi — named only
    names: ["marathi", "मराठी", "ಮರಾಠಿ"],
  },
  {
    name: "Konkani",
    script: null, // Devanagari or Kannada script — named only
    names: ["konkani", "कोंकणी", "ಕೊಂಕಣಿ"],
  },
  {
    name: "Tulu",
    script: null, // written in Kannada script — named only
    names: ["tulu", "ತುಳು", "तुळू", "तुलु"],
  },
  {
    name: "Bengali",
    script: /[ঀ-৿]/,
    names: ["bengali", "bangla", "বাংলা", "बंगाली"],
  },
  {
    name: "Gujarati",
    script: /[઀-૿]/,
    names: ["gujarati", "ગુજરાતી", "गुजराती"],
  },
  {
    name: "Punjabi",
    script: /[਀-੿]/,
    names: ["punjabi", "panjabi", "ਪੰਜਾਬੀ", "पंजाबी"],
  },
  {
    name: "Odia",
    script: /[଀-୿]/,
    names: ["odia", "oriya", "ଓଡ଼ିଆ", "उड़िया"],
  },
  {
    name: "Urdu",
    script: /[؀-ۿ]/,
    names: ["urdu", "اردو", "उर्दू"],
  },
];

const BY_NAME = new Map();
for (const l of LANGUAGES) for (const n of l.names) BY_NAME.set(n, l.name);

/** Devanagari is shared. Without a naming word it is read as Hindi, which
 *  is right far more often than it is wrong for this user base. */
const DEVANAGARI = /[ऀ-ॿ]/;

/** Scripts that mean the recogniser guessed wrong, not that the user
 *  switched language. Mirrored NEVER — see inputQuality.FOREIGN_SCRIPT. */
const NOT_OURS = /[぀-ヿㇰ-ㇿ가-힯Ѐ-ӿ฀-๿一-鿿]/;

/* ------------------------------------------------------------------ *
 * canonical()
 * ------------------------------------------------------------------ */

/** "hindi", "हिन्दी", "  Hindi  " -> "Hindi". Unknown values pass through
 *  trimmed, because a preference we do not recognise is still the user's. */
function canonical(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  const hit = BY_NAME.get(v.toLowerCase());
  if (hit) return hit;
  for (const l of LANGUAGES) if (l.name.toLowerCase() === v.toLowerCase()) return l.name;
  return v.slice(0, 40);
}

/** True when this is a language we are willing to mirror into — i.e. one
 *  a user of this product plausibly speaks. */
function mirrorable(name) {
  const c = canonical(name);
  return LANGUAGES.some((l) => l.name === c);
}

/* ------------------------------------------------------------------ *
 * requestedLanguage() — an explicit ask, not an inference
 * ------------------------------------------------------------------ */

/**
 * ASKING ABOUT A LANGUAGE IS NOT ASKING FOR IT.
 *
 * "how do you say this in Tamil", "translate it to Hindi", "what's the
 * Kannada word for rain" all name a language and mean nothing about which
 * language the conversation should be in. Every one of these would have
 * silently rewritten the user's saved preference.
 */
const ABOUT_NOT_FOR =
  /\b(translat\w*|transliterat\w*|meaning|means|word for|words for|how do (you|i) say|how to say|spell|pronounce|subtitle|dub|caption|lyrics|song|movie|film|news in|teach me|learn|learning|course|class|typing|keyboard|font)\b/i;

/**
 * "SAY IT IN HINDI" IS NOT "SPEAK HINDI FROM NOW ON".
 *
 * One asks for this reply in another language; the other changes the
 * conversation for good. Both should switch the current turn. Only the
 * second may rewrite what the user is greeted in tomorrow morning — the
 * failure that started all of this was a preference the user never chose
 * surviving into the next session.
 */
const SPEAK_VERB =
  "(?:speak|speaking|talk|talking|reply|replying|respond|responding|answer|answering|converse|chat|communicate|switch|change|continue|carry on|stick)";

/** Verbs that ask for THIS reply in another language, and nothing more. */
const ONESHOT_VERB = "(?:say|write|repeat|tell me that|put that|send it)";

/**
 * "DON'T TALK TO ME IN HINDI" IS NOT A REQUEST FOR HINDI.
 *
 * Caught in review before this shipped: every complaint about a language
 * names that language, and a naive reading turned the complaint into a
 * saved preference for the very thing the user was objecting to. The user
 * most likely to say it is the one already stuck in the wrong language —
 * so the failure lands precisely where it does the most damage.
 *
 * A complaint is not a request. When someone rejects a language without
 * naming another, the honest response is to ask which one they want, not
 * to guess — so this returns nothing and the asking path takes over.
 */
const NEGATED =
  /\b(?:dont|don't|do not|doesn't|stop|quit|never|no more|not|avoid|hate|tired of|sick of|why (?:are|do) you|instead of|other than|except)\b/i;

/** A question ABOUT a language is not an instruction to use it. */
const INTERROGATIVE = /^(?:do|does|did|can|could|are|is|was|will|would|why|what|which|how)\b/i;

/** How far before the language name a negation still governs it. */
const NEGATION_REACH = 30;

/** True when the language named here is being rejected, not requested. */
function negatedAround(raw, lang) {
  for (const n of nameHits(raw, lang)) {
    const before = raw.slice(Math.max(0, n - NEGATION_REACH), n);
    if (NEGATED.test(before)) return true;
  }
  return NEGATED.test(raw.slice(0, NEGATION_REACH));
}

/** Every index at which this language is named in the utterance. */
function nameHits(raw, canonicalName) {
  const l = LANGUAGES.find((x) => x.name === canonicalName);
  const hits = [];
  for (const n of (l ? l.names : [canonicalName])) {
    let from = 0;
    const hay = /^[a-z ]+$/.test(n) ? raw.toLowerCase() : raw;
    const needle = /^[a-z ]+$/.test(n) ? n : n;
    for (;;) {
      const i = hay.indexOf(needle, from);
      if (i < 0) break;
      hits.push(i);
      from = i + 1;
    }
  }
  return hits;
}

/**
 * Reads an explicit request about the language of the conversation.
 * Deliberately narrow: a false positive rewrites a saved preference,
 * which is worse than missing one phrasing.
 *
 * @param {string} text  what the user said, as transcribed
 * @returns {{language:string, permanent:boolean}}  language "" when the
 *          user asked no such thing; permanent false for a one-off.
 */
function requestedLanguage(text) {
  const none = { language: "", permanent: false };
  const raw = String(text || "").trim();
  if (!raw || raw.length > 400) return none;
  if (ABOUT_NOT_FOR.test(raw)) return none;

  const lower = raw.toLowerCase();
  const named = namesPresent(lower, raw);
  if (named.length !== 1) return none; // zero, or an ambiguous comparison
  const lang = named[0];
  if (negatedAround(raw, lang)) return none;
  if (INTERROGATIVE.test(raw) && !/\bplease\b/i.test(raw)) return none;
  const alt = alternation(lang);

  // ── English and romanised: "speak in English", "reply in Hindi only",
  //    "switch to Kannada", "can you talk to me in Tamil"
  const english = new RegExp(
    `\\b${SPEAK_VERB}\\b[^.?!]{0,40}?\\b(?:in|to|into|with)\\s+${alt}\\b`, "i");
  if (english.test(raw) && !aimedAtSomeoneElse(raw)) {
    return { language: lang, permanent: true };
  }

  // ── No preposition at all — the commonest form of the request that
  //    started this, and the one the first pattern missed: "speak
  //    English", "please speak English", "just talk English to me".
  const bareVerb = new RegExp(
    `\\b${SPEAK_VERB}\\s+(?:(?:to\\s+)?(?:me|us)\\s+)?(?:only\\s+|just\\s+)?${alt}\\b`, "i");
  if (bareVerb.test(raw) && !aimedAtSomeoneElse(raw)) {
    return { language: lang, permanent: true };
  }

  // ── This reply only: "say it in Hindi", "write that in Kannada".
  const oneshot = new RegExp(
    `\\b${ONESHOT_VERB}\\b[^.?!]{0,40}?\\b(?:in|to|into)\\s+${alt}\\b`, "i");
  if (oneshot.test(raw)) return { language: lang, permanent: false };

  // ── "English please", "in Hindi please", "Kannada only", "English mein"
  const bare = new RegExp(
    `(?:^|\\b)(?:in\\s+)?${alt}\\s*(?:please|only|hi|maatra|matra)\\b`, "i");
  if (bare.test(raw)) return { language: lang, permanent: true };

  // ── Romanised Hindi/Urdu word order: "hindi mein baat karo",
  //    "english me bolo", "hindi mein reply karna"
  const hinglish = new RegExp(
    `\\b${alt}\\s+(?:me|mein|mai|main|ma)\\b[^.?!]{0,30}?` +
    `\\b(?:baat|bat|bol|bolo|bolna|bolo na|kar|karo|karna|likh|likho|jawab|reply|answer|type)\\b`, "i");
  if (hinglish.test(raw)) return { language: lang, permanent: true };

  // ── Dravidian word order, romanised: "kannada alli maatadi",
  //    "tamil la pesunga", "telugu lo matladandi"
  const dravidian = new RegExp(
    `\\b${alt}\\s*(?:alli|nalli|la|le|lo|il|il\\s)\\b[^.?!]{0,30}?` +
    `\\b(?:maatad\\w*|matad\\w*|mata\\w*|pesu\\w*|pesa\\w*|matlad\\w*|paray\\w*|helu|heli|sollu|solla)\\b`, "i");
  if (dravidian.test(raw)) return { language: lang, permanent: true };

  // ── Native scripts. The postposition carries the request, so the verb
  //    list stays short and specific to "speak/say/reply".
  //    "हिंदी में बात करो", "ಕನ್ನಡದಲ್ಲಿ ಮಾತಾಡಿ", "தமிழில் பேசு"
  // Indic text routinely carries a zero-width non-joiner between a
  // loanword and its postposition — "ಇಂಗ್ಲಿಷ್\u200cನಲ್ಲಿ" — which \\s does not match.
  const native = new RegExp(
    `${alt}[\\s\\u200b-\\u200d]*(?:में|मे| में|ಲ್ಲಿ|ದಲ್ಲಿ|ನಲ್ಲಿ|ில்|த்தில்|లో|ിൽ|ത്തിൽ|তে|ে|য়)` +
    `[^।.?!]{0,30}?` +
    `(?:बात|बोल|बोलो|बोलिए|कहो|जवाब|लिख|ಮಾತ|ಹೇಳ|ಬರ|பேச|பேசு|சொல|మాట|చెప|പറ|സംസാര|বল|কথা)`, "u");
  if (native.test(raw)) return { language: lang, permanent: true };

  // ── The shortest honest form, as a whole utterance: "English", "हिंदी".
  //    Only when the user said nothing else at all — otherwise a passing
  //    mention of a language would rewrite their preference.
  const only = raw.replace(/[^\p{L}\p{M}]/gu, "").toLowerCase();
  if (BY_NAME.get(only) === lang || lang.toLowerCase() === only) {
    return { language: lang, permanent: true };
  }

  return none;
}

/**
 * "TALK TO HER IN KANNADA" IS ABOUT THE CALL, NOT ABOUT US.
 *
 * The assistant places calls and drafts messages for other people, so a
 * language named next to a third person is an instruction about that
 * errand — never a standing preference for this conversation.
 */
function aimedAtSomeoneElse(raw) {
  return /\b(?:to|with|for)\s+(?:him|her|them|my|his|her|their|the)\b/i.test(raw) &&
    !/\b(?:to|with)\s+(?:me|us)\b/i.test(raw);
}

/** Which of our languages are named in this utterance (canonical, deduped). */
function namesPresent(lower, raw) {
  const out = new Set();
  for (const l of LANGUAGES) {
    for (const n of l.names) {
      const needle = n.toLowerCase();
      // Latin names need word boundaries; Indic names have no case and no
      // reliable \b, so a substring match is the correct test.
      const hit = /^[a-z ]+$/.test(needle)
        ? new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower)
        : raw.includes(n);
      if (hit) { out.add(l.name); break; }
    }
  }
  return [...out];
}

/** A regex alternation matching any spoken name of one language. */
function alternation(canonicalName) {
  const l = LANGUAGES.find((x) => x.name === canonicalName);
  const parts = (l ? l.names : [canonicalName]).map((n) =>
    n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `(?:${parts.join("|")})`;
}

/* ------------------------------------------------------------------ *
 * detectSpoken() — which language this transcript is IN
 * ------------------------------------------------------------------ */

/**
 * Reports the language of a transcript, and HOW SURE IT IS.
 *
 *   evidence "script"  an Indic block matched. Decisive: no other
 *                      language is written in this script.
 *   evidence "latin"   Latin letters, judged by vocabulary. Suggestive
 *                      only — the recogniser renders Kannada as
 *                      Portuguese often enough that Latin text proves
 *                      nothing on its own.
 *   evidence ""        no idea. Say so rather than guess.
 *
 * Callers that change something durable — saving a preference, asking
 * the user to confirm one — must require "script". Review caught the
 * alternative: resolving every Latin string to English by elimination
 * turned a mis-transcribed Kannada sentence into positive evidence that
 * the user speaks English, and the whole point of this module is to stop
 * exactly that kind of confident wrongness.
 *
 * @param {string} text
 * @returns {{language:string, evidence:"script"|"latin"|""}}
 */
function detectSpoken(text) {
  const unknown = { language: "", evidence: "" };
  const raw = String(text || "").trim();
  if (!raw) return unknown;

  // A recogniser that produced Japanese or Cyrillic guessed wrong.
  if (NOT_OURS.test(raw)) return unknown;

  for (const l of LANGUAGES) {
    if (l.script && l.script.test(raw)) {
      if (l.script === DEVANAGARI) {
        const named = namesPresent(raw.toLowerCase(), raw);
        if (named.includes("Marathi")) return { language: "Marathi", evidence: "script" };
        if (named.includes("Konkani")) return { language: "Konkani", evidence: "script" };
      }
      return { language: l.name, evidence: "script" };
    }
  }

  // Latin from here. Too short to judge — "ok", "yes", "stop" are said
  // the same way in every language this assistant speaks.
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length < 3) return unknown;

  // Romanised Indian speech is that language being spoken, not English.
  const buckets = ROMANISED.filter((b) => b.re.test(raw));
  if (buckets.length === 1) return { language: buckets[0].name, evidence: "latin" };
  if (buckets.length > 1) return unknown; // markers shared between languages

  // English needs POSITIVE evidence, never elimination.
  const stop = (raw.toLowerCase().match(ENGLISH_STOPWORDS) || []).length;
  if (stop >= 2) return { language: "English", evidence: "latin" };
  return unknown;
}

/** Romanised markers, per language. Deliberately distinctive words: a
 *  token shared between two of these buckets makes the turn unreadable,
 *  which is the correct answer. */
const ROMANISED = [
  {
    name: "Hindi",
    re: /\b(kaise|kaisa|kaisi|kya|kyun|kyu|kahan|mujhe|mera|meri|mere|tumhara|aapka|nahin|karo|karna|kijiye|chahiye|bhaiya|batao|dikhao|sunao|bhej|chalo|thoda|zyada|jyada|kuchh|matlab|samajh|hoga|hogi|karenge|karunga|karungi|paisa|paise|khana|ghar)\b/i,
  },
  {
    name: "Kannada",
    re: /\b(maatad\w*|matad\w*|hegidira|hegiddira|yaake|yaaru|barthini|madu|maadi|heli|helu|nimma|namma|naanu|neenu|yenu|ivattu|nale)\b/i,
  },
  {
    name: "Tamil",
    re: /\b(pesu\w*|pesa\w*|sollu|solla|epdi|eppadi|vanakkam|irukku|venum|panren|panni|enakku|unakku)\b/i,
  },
  {
    name: "Telugu",
    re: /\b(matlad\w*|cheppu|cheppandi|bagunnara|emiti|ela unnaru|nenu|meeru|kavali|undi)\b/i,
  },
  {
    name: "Malayalam",
    re: /\b(parayu|parayoo|sugamano|enthu|enthaanu|venam|njan|ningal|undo)\b/i,
  },
];

/** Common English function words. Two of them make a sentence English;
 *  fewer makes it a Latin string of unknown origin. */
const ENGLISH_STOPWORDS =
  /\b(the|and|is|are|was|to|for|of|what|when|where|which|can|could|would|please|my|your|you|me|with|about|from|that|this|have|has|do|does|it|on|at|in|tell|show|set|open|call|send)\b/g;

/**
 * True when this language shares its script with another one we speak,
 * so script evidence cannot tell them apart.
 *
 * Devanagari carries Hindi, Marathi and Konkani; the Kannada script
 * carries Kannada and Tulu. A Marathi speaker whose every sentence is
 * read as "Hindi" would otherwise be asked to switch, every session,
 * forever — and saying yes would overwrite their preference with the
 * wrong language. Tulu is an audience this product explicitly serves.
 */
function scriptAmbiguous(name) {
  return ["Hindi", "Marathi", "Konkani", "Kannada", "Tulu"].includes(canonical(name));
}

module.exports = {
  LANGUAGES,
  canonical,
  mirrorable,
  requestedLanguage,
  detectSpoken,
  scriptAmbiguous,
  SPOKEN_HERE: LANGUAGES.map((l) => l.name).join(", "),
};
