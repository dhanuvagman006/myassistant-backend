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
]);

/** Scripts an Indian user's speech should not normally arrive in — a
 *  strong sign the recogniser guessed the wrong language entirely. */
const FOREIGN_SCRIPT =
  /[぀-ヿㇰ-ㇿ가-힯Ѐ-ӿ؀-ۿ฀-๿]/;

/** Latin text that is almost certainly a mis-detected European language. */
const EUROPEAN_GIVEAWAY =
  /\b(je suis|je dis|n'accepte|prenez|arrêtez|c'est|nous|vous|el grupo|conciencia|de que|para|estoy|gracias|ich bin|nicht|danke|war alle|und|sono|questo)\b/i;

function letterRatio(t) {
  const letters = (t.match(/[\p{L}]/gu) || []).length;
  return t.length ? letters / t.length : 0;
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
    const repeated = new Set(norm).size < norm.length;
    const alnumMix = norm.some((w) => /\d/.test(w) && /\p{L}/u.test(w));
    if (repeated || alnumMix || letterRatio(raw) < 0.7) {
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
