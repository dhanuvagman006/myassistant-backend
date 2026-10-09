/**
 * READ IT BACK BEFORE IT GOES OUT (2026-09-26).
 *
 * The client, after a call went out in the wrong language: "the calls or
 * messages if my assistant conveys wrong then people will not like it."
 * A call that delivers a message, or a message sent to another person,
 * now goes out only once the assistant has read the exact words back and
 * the user has said yes to them:
 *
 *   1. The tool is called without `confirmed`. Nothing is sent. The words
 *      are remembered for this user and the model is told to read them
 *      back, word for word, and ask.
 *   2. The tool is called again with `confirmed: true` and the SAME words,
 *      after the user has said something NEW that means yes ("yes",
 *      "haan", "ശരി", "ಸರಿ"...). Anything else — a "no", a correction, the
 *      model calling twice in one breath — is a fresh read-back.
 *
 * Changed words are always a new read-back, so what goes out is exactly
 * what the user approved. Runs nobody is present for (a scheduled task
 * the user set up earlier) are not asked again.
 */

const TTL_MS = 5 * 60_000;

/** `${userId}|${kind}` -> { key, heard, at } */
const pending = new Map();

/** Words and marks only, lowercased: "Tell him — 5 PM!" and "tell him 5 pm" match. */
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

/** Short answers that mean yes, in the languages the product serves. */
const YES = new Set([
  "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "correct", "right",
  "fine", "perfect", "go", "ahead", "proceed", "please", "call", "send",
  "haan", "han", "haa", "ha", "ji", "haanji", "hanji", "theek", "thik",
  "sahi", "karo", "bhejo", "shari", "sheri", "athe", "uvvu", "sari",
  "houdu", "aytu", "maadi", "aamaam", "aama", "sare", "avunu",
  "हाँ", "हां", "जी", "हाँजी", "ठीक", "सही", "करो", "भेजो",
  "ശരി", "അതെ", "ഉവ്വ്", "ഓക്കെ", "വിളിക്കൂ", "അയക്കൂ", "ശരിയാണ്",
  "ಹೌದು", "ಸರಿ", "ಆಯ್ತು", "ಮಾಡಿ", "ಕಳಿಸಿ",
  "சரி", "ஆமாம்", "ஆம்", "సరే", "అవును",
].map((w) => w.normalize("NFC")));

/** Any of these and it is not a yes, whatever else was said. */
const NO = new Set([
  "no", "nope", "not", "don", "dont", "never", "wait", "stop", "cancel",
  "change", "instead", "but", "wrong", "hold", "later",
  "nahi", "nahin", "mat", "ruko", "illa", "venda", "beda", "vaddu", "ledu",
  "illai", "vendaam",
  "नहीं", "नही", "मत", "रुको", "ഇല്ല", "വേണ്ട", "ಇಲ್ಲ", "ಬೇಡ",
  "இல்லை", "வேண்டாம்", "లేదు", "వద్దు",
].map((w) => w.normalize("NFC")));

/** True when [text] is a short, plain yes (and nothing that takes it back). */
function saysYes(text) {
  const words = norm(text).split(" ").filter(Boolean);
  if (!words.length || words.length > 8) return false;
  if (words.some((w) => NO.has(w))) return false;
  return words.some((w) => YES.has(w)) || /\b(go ahead|do it|that s right|thats right|sounds good)\b/.test(words.join(" "));
}

/**
 * May this go out now?
 *
 * @param {object} p
 * @param {*}      p.userId
 * @param {string} p.kind       "call" | "message" — one pending read-back each
 * @param {string[]} p.parts    what identifies it: recipient and the words
 * @param {boolean} p.confirmed the model says the user approved it
 * @param {string|null} p.userText the user's latest words, when known
 * @param {boolean} p.unattended nobody is there to ask (a scheduled run)
 * @returns {boolean} true: send it. false: read it back and ask first.
 */
function mayGo({ userId, kind, parts, confirmed, userText = null, unattended = false }) {
  if (unattended) return true;
  const slot = `${userId || "anon"}|${kind}`;
  // THE WORDS ARE WHAT WAS APPROVED (2026-10-08). The recipient used to be
  // part of the key too, so picking "Ananth Shetty" from two matches for
  // "Anant Shetty" read the same message back again — and again. The
  // message must match exactly; the name only has to be the same person
  // (the first word starts the same), which a contact pick always is.
  const [who, ...rest] = (parts || []).map(norm);
  const key = rest.join("|");
  // "Anant" and "Ananth": the same person as spelled by the contact list.
  const first = (s) => String(s || "").split(" ")[0].slice(0, 4);
  // NO TRANSCRIPT IS NOT A "NO" (2026-10-08). A voice session with no
  // transcript of the user hands us "" (or a fragment like "uh", "you"):
  // "" !== "" was never new, so a spoken yes could never pass and every
  // message call looped on its read-back until the model gave up and
  // dialled without the message — no relayed call in a week on prod.
  // Without readable words, the model's confirmed:true after a pause is
  // the yes, as when no text is known at all.
  const heard = norm(userText);
  const unreadable = userText == null || heard.split(" ").filter(Boolean).length === 0 ||
    (heard.length <= 4 && !saysYes(heard) && !heard.split(" ").some((w) => NO.has(w)));
  const p = pending.get(slot);
  const fresh = p && Date.now() - p.at < TTL_MS;
  if (confirmed === true && fresh && p.key === key && first(p.who) === first(who)) {
    if (unreadable && Date.now() - p.at > 1500) {
      pending.delete(slot);
      return true;
    }
    // Something new must have been said since the words were read back —
    // the request itself, still the latest thing heard, is not a yes.
    const heardNew = userText == null
      ? Date.now() - p.at > 1500
      : norm(userText) !== p.heard;
    if (heardNew && (userText == null || saysYes(userText))) {
      pending.delete(slot);
      return true;
    }
  }
  pending.set(slot, { key, who, heard, at: Date.now() });
  // One slot per user and kind; old ones age out instead of piling up.
  if (pending.size > 5000) pending.delete(pending.keys().next().value);
  return false;
}

module.exports = { mayGo, saysYes, norm, _forget: () => pending.clear() };
