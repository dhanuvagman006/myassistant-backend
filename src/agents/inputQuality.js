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
  "hotspot", "flashlight", "torch", "bluetooth", "wifi", "wi-fi", "volume",
  "mute", "unmute", "quieter", "softer", "brighter", "dimmer", "pause",
  "play", "resume", "skip", "previous", "alarm", "timer", "snooze", "camera",
  "screenshot", "lock", "silent", "vibrate", "home", "settings", "news",
  "weather", "brief", "update", "help", "navigate", "music", "radio",
]);

/** Verbs that make two to four words a request rather than a fragment. */
const IMPERATIVE =
  /^(open|close|call|ring|dial|set|remind|play|pause|stop|show|send|text|message|turn|switch|start|book|order|search|find|look|navigate|take|read|check|tell|wake|mute|unmute|increase|decrease|raise|lower|enable|disable|cancel|delete|add|create|make|schedule|note|save|kholo|खोलो|band|बंद|chalao|चलाओ|lagao|लगाओ|karo|करो|dikhao|दिखाओ|bhejo|भेजो|bulao|बुलाओ|batao|बताओ|ತೆರೆ|ತೆರೆಯಿರಿ|ಮಾಡು|ಮಾಡಿ|ಹಾಕು|ಹಾಕಿ|ತೋರಿಸು|ತೋರಿಸಿ|ಕರೆ|ಕಳಿಸು|ಕಳಿಸಿ)$/iu;

/** Scripts an Indian user's speech should not normally arrive in — a
 *  strong sign the recogniser guessed the wrong language entirely. */
const FOREIGN_SCRIPT =
  /[぀-ヿㇰ-ㇿ가-힯Ѐ-ӿ؀-ۿ฀-๿]/;

/** Latin text that is almost certainly a mis-detected European language. */
const EUROPEAN_GIVEAWAY =
  /\b(je suis|je dis|n'accepte|prenez|arrêtez|c'est|nous|vous|el grupo|conciencia|de que|para|estoy|gracias|ich bin|nicht|danke|war alle|und|sono|questo)\b/i;

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
 * @param text        what the recogniser produced
 * @param opts.expectsNumber  true when the conversation just asked for a
 *                            number (then bare digits are an ANSWER, not noise)
 * @param opts.languages      languages this user actually speaks
 * @returns {{quality:'clear'|'weak'|'garbled', reason:string, digitsOnly:boolean}}
 */
function assess(text, { expectsNumber = false, languages = [] } = {}) {
  const raw = String(text || "").trim();
  if (!raw) return { quality: "garbled", reason: "empty", digitsOnly: false };

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

  // Wrong-script output for a user who does not speak that script.
  const speaksForeign = languages.some((l) =>
    /japanese|korean|russian|arabic|thai|chinese/i.test(String(l))
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
    const w = lower.replace(/[^\p{L}\p{N}]/gu, "");
    if (SHORT_OK.has(w)) return { quality: "clear", reason: "short but unambiguous", digitsOnly: false };
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
    const alnumMix = norm.some((w) => /\d/.test(w) && /\p{L}/u.test(w));
    if (repeated || alnumMix || contentRatio(raw) < 0.7) {
      return { quality: "weak", reason: "fragmentary", digitsOnly: false };
    }
  }

  return { quality: "clear", reason: "", digitsOnly: false };
}

/** What to say instead of acting, in the user's own language where known. */
function clarificationFor(assessment, { language = "" } = {}) {
  const l = String(language).toLowerCase();
  if (/hindi/.test(l)) return "माफ़ कीजिए, वह ठीक से सुनाई नहीं दिया — फिर से बोलिए?";
  if (/kannada/.test(l)) return "ಕ್ಷಮಿಸಿ, ಅದು ಸರಿಯಾಗಿ ಕೇಳಿಸಲಿಲ್ಲ — ಇನ್ನೊಮ್ಮೆ ಹೇಳ್ತೀರಾ?";
  if (/tulu/.test(l)) return "ಕ್ಷಮಿಸಿ, ಅವು ಸರಿಯಾದ್ ಕೇನ್ಜಿ — ಒಂಜಿ ಸರ್ತಿ ಪನ್ಪರಾ?";
  if (assessment && assessment.digitsOnly) {
    return "I heard some numbers but nothing else — what would you like me to do with them?";
  }
  return "Sorry, I didn't catch that — could you say it again?";
}

/** True when an action that touches the world may run on this input. */
function mayAct(assessment) {
  return !assessment || assessment.quality === "clear";
}

module.exports = { assess, clarificationFor, mayAct };
