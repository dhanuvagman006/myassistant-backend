/**
 * WHICH LANGUAGE A CALL SPEAKS (2026-09-26).
 *
 * The client asked his assistant to call and leave a message in
 * Malayalam, and the call "speaks in a different Chinese language". The
 * language never reached the calling service at all: no tool field, no
 * call variable, and a calling agent told to mirror the other person —
 * whose Malayalam its English-only hearing turned into nonsense.
 *
 * Now the language is worked out for every call — from what the tool was
 * told, then from the user's own words ("in Malayalam", "മലയാളത്തിൽ"),
 * then from the message's own script — and the call is told plainly to
 * speak that language from first word to goodbye and to give the message
 * as written (see agentCall.bolnaPlaceCall).
 */

const LANGS = [
  { name: "Malayalam", code: "ml", script: /[ഀ-ൿ]/u, said: /\bmalayalam\w*|മലയാള/iu },
  { name: "Kannada", code: "kn", script: /[ಀ-೿]/u, said: /\bkannada\w*|ಕನ್ನಡ/iu },
  { name: "Tamil", code: "ta", script: /[஀-௿]/u, said: /\btamil\w*|தமிழ/iu },
  { name: "Telugu", code: "te", script: /[ఀ-౿]/u, said: /\btelugu\w*|తెలుగు/iu },
  { name: "Bengali", code: "bn", script: /[ঀ-৿]/u, said: /\b(bengali|bangla)\b|বাংলা/iu },
  { name: "Gujarati", code: "gu", script: /[઀-૿]/u, said: /\bgujarati\b|ગુજરાતી/iu },
  { name: "Punjabi", code: "pa", script: /[਀-੿]/u, said: /\bpunjabi\b|ਪੰਜਾਬੀ/iu },
  { name: "Odia", code: "or", script: /[଀-୿]/u, said: /\b(odia|oriya)\b|ଓଡ଼ିଆ/iu },
  // Devanagari is shared: Marathi only when named, Hindi otherwise.
  { name: "Marathi", code: "mr", script: null, said: /\bmarathi\b|मराठी/iu },
  { name: "Hindi", code: "hi", script: /[ऀ-ॿ]/u, said: /\bhindi\b|हिंदी|हिन्दी/iu },
  { name: "English", code: "en", script: null, said: /\benglish\b/iu },
];

function byNameOrCode(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return null;
  return LANGS.find((l) => l.name.toLowerCase() === s || l.code === s.slice(0, 2) && s.length <= 5) ||
    LANGS.find((l) => l.said.test(s)) || null;
}

/**
 * The language a call should speak, or null for the usual (English, or
 * whatever the other person speaks).
 * @param {object} p
 * @param {string} [p.requested] the tool's `language`, or a code like "ml"
 * @param {string} [p.message]   the words to deliver
 * @param {string} [p.userText]  what the user said when asking
 * @returns {{name:string, code:string}|null}
 */
function resolve({ requested, message, userText } = {}) {
  const asked = byNameOrCode(requested);
  if (asked) return { name: asked.name, code: asked.code };
  // "Leave him a message in Malayalam" — named in the request itself.
  const said = String(userText || "");
  for (const l of LANGS) {
    if (said && l.said.test(said) && /\b(in|speak|language|il|lu|mein|alli)\b|ത്തിൽ|ಲ್ಲಿ|में/iu.test(said)) {
      return { name: l.name, code: l.code };
    }
  }
  // Written in a language's own script.
  const text = String(message || "");
  for (const l of LANGS) {
    if (l.script && l.script.test(text)) return { name: l.name, code: l.code };
  }
  return null;
}

/**
 * What the calling agent is told to do, for a call in [language]: the
 * language is fixed for the whole call and the message is given as
 * written. Plain English instructions around the user's own words — the
 * agent's model reads English best.
 */
function taskFor(task, language) {
  const words = String(task || "").trim();
  if (!language || language.code === "en") return words;
  const L = language.name;
  return (
    `SPEAK ONLY ${L.toUpperCase()} ON THIS CALL — every sentence after your ` +
    `greeting, until goodbye, in natural spoken ${L}. Never switch to ` +
    `English, Hindi or any other language, even if what they say sounds ` +
    `unclear: their replies may come through garbled, so after giving the ` +
    `message and hearing any reply, confirm briefly in ${L} and say ` +
    `goodbye in ${L}. ` +
    `The message to give, in ${L}, exactly as written: «${words}»`
  );
}

/**
 * THE APP DIALS, THE SERVER SPEAKS. A relayed call leaves the tool as a
 * device action; the phone resolves the contact and posts the task back
 * to /agent-call, and apps before build 112 do not send the language with
 * it. So the language chosen when the call was confirmed is remembered
 * for that user and those exact words, for ten minutes.
 */
const chosen = new Map(); // userId -> { text, language, at }
const { norm } = require("./readBack");

function remember(userId, text, language) {
  if (!userId || !language || !String(text || "").trim()) return;
  chosen.set(String(userId), { text: norm(text), language, at: Date.now() });
  if (chosen.size > 5000) chosen.delete(chosen.keys().next().value);
}

function recall(userId, text) {
  const c = chosen.get(String(userId || ""));
  if (!c || Date.now() - c.at > 10 * 60_000) return null;
  return c.text === norm(text) ? c.language : null;
}

module.exports = { resolve, taskFor, byNameOrCode, remember, recall, LANGS };
