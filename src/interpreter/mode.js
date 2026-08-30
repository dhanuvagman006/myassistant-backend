/**
 * INTERPRETER MODE — Hari sits between two people who don't share a
 * language.
 *
 *   The user speaks English. Their patient speaks Tamil. Hari hears both
 *   through the same microphone and speaks each one's words to the other.
 *
 * WHY THIS WORKS AT ALL
 * ---------------------
 * The live model is natively speech-to-speech and multilingual, so nothing
 * new has to be integrated: no translation API, no separate TTS. What is
 * needed is a change of ROLE — from an assistant that answers questions to
 * a conduit that answers nothing.
 *
 * That role change is the whole difficulty. An assistant's instinct is to
 * be helpful: asked "where is the station?" in Tamil it wants to answer.
 * An interpreter must translate the question and say nothing else, or it
 * starts inventing one side of a conversation between two real people who
 * cannot check what it said. The instructions below are written almost
 * entirely to suppress that instinct.
 *
 * Two consumers, one instruction block:
 *   • live mode injects it as a turn (the model is already streaming)
 *   • the voice loop appends it to the system prompt for the session
 */

/** Languages worth naming explicitly; anything else is passed through. */
const LANGUAGE_NAMES = {
  en: "English", hi: "Hindi", ta: "Tamil", te: "Telugu", kn: "Kannada",
  ml: "Malayalam", mr: "Marathi", bn: "Bengali", gu: "Gujarati",
  pa: "Punjabi", ur: "Urdu", or: "Odia", as: "Assamese",
  ar: "Arabic", fr: "French", de: "German", es: "Spanish",
  ja: "Japanese", zh: "Chinese", ru: "Russian", pt: "Portuguese",
};

function languageName(input) {
  if (!input) return null;
  const raw = String(input).trim();
  const code = raw.toLowerCase().slice(0, 2);
  if (LANGUAGE_NAMES[code] && raw.length <= 3) return LANGUAGE_NAMES[code];
  // A spoken language name ("Tamil") is already what we want.
  const match = Object.values(LANGUAGE_NAMES).find(
    (n) => n.toLowerCase() === raw.toLowerCase()
  );
  return match || raw.slice(0, 30);
}

/**
 * The instruction block that turns the assistant into an interpreter.
 *
 * @param {{a:string, b:string}} langs  the two languages, already named
 */
function instructions({ a, b }) {
  return [
    `INTERPRETER MODE IS NOW ACTIVE between ${a} and ${b}.`,
    "",
    "You are no longer an assistant. You are an INTERPRETER standing between",
    "two people. Your ONLY job is to convey what each says to the other.",
    "",
    "RULES — these override every other instruction you have:",
    `1. When you hear ${a}, say the same thing in ${b}. When you hear ${b},`,
    `   say the same thing in ${a}. Nothing else.`,
    "2. NEVER answer a question yourself. If someone asks 'where is the",
    "   station?', you translate the QUESTION — you do not answer it. The",
    "   answer is for the other person to give.",
    "3. Translate in the FIRST PERSON, as if you were the speaker. Say 'I",
    "   have a headache', never 'he says he has a headache'.",
    "4. Do not add, omit, soften or explain anything. If someone is angry or",
    "   rude, translate it faithfully — a softened translation misleads both",
    "   sides, and in a medical or legal setting that is dangerous.",
    "5. If you genuinely did not catch something, say only: 'Sorry, could you",
    "   repeat that?' in the language of the person who spoke.",
    "6. No greetings, no commentary, no offers to help. Just the translation.",
    "",
    "Stay in this mode until you are told interpreter mode is off.",
  ].join("\n");
}

/** Spoken confirmation, in the user's own language, before the mode starts. */
function announcement({ a, b }) {
  return `Interpreter mode on — ${a} and ${b}. Go ahead.`;
}

const OFF_INSTRUCTIONS =
  "INTERPRETER MODE IS NOW OFF. Stop translating and return to being the " +
  "user's assistant, answering normally in the language they speak to you.";

module.exports = { instructions, announcement, languageName, OFF_INSTRUCTIONS, LANGUAGE_NAMES };
