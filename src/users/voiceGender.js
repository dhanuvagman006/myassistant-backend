/**
 * A FEMALE VOICE MUST NOT CARRY A MALE NAME, OR THE REVERSE.
 * ---------------------------------------------------------
 * His rule, 2026-09-20: "a female voice can only have a female name and a
 * male voice can only have a male name as assistant name" — checked every
 * time either one is set, not just at sign-up.
 *
 * The voice side is knowable: Gemini publishes the gender of each prebuilt
 * voice, and the app's own picker already labels them.
 *
 * The NAME side cannot be a hardcoded list. These are mostly Indian
 * names — Anjali, Meera, Arjun, Kavya, Hemanth — and any list short
 * enough to maintain would reject half of them as "unknown" and let the
 * rule fail open exactly where it matters. So a small table covers the
 * names people actually reach for, and anything it does not know is put
 * to the model ONCE and cached. A name whose gender genuinely cannot be
 * judged (an invented word, a unisex name) is allowed through: refusing
 * a name nobody can classify would be worse than the mismatch it guards.
 */

const VOICE_GENDER = {
  // female
  kore: "female", aoede: "female", leda: "female", zephyr: "female",
  callirrhoe: "female", autonoe: "female", despina: "female",
  erinome: "female", laomedeia: "female", achernar: "female",
  pulcherrima: "female", vindemiatrix: "female", sadachbia: "female",
  sulafat: "female", gacrux: "female",
  // male
  puck: "male", charon: "male", fenrir: "male", orus: "male",
  enceladus: "male", iapetus: "male", umbriel: "male", algieba: "male",
  algenib: "male", rasalgethi: "male", alnilam: "male", schedar: "male",
  achird: "male", zubenelgenubi: "male", sadaltager: "male",
};

/** The names people actually pick, including the Indian ones. */
const NAME_GENDER = {
  // female
  maya: "female", maria: "female", anjali: "female", meera: "female",
  mira: "female", kavya: "female", divya: "female", priya: "female",
  pooja: "female", sneha: "female", asha: "female", usha: "female",
  lakshmi: "female", laxmi: "female", saraswati: "female", radha: "female",
  sita: "female", gita: "female", geeta: "female", nisha: "female",
  neha: "female", riya: "female", diya: "female", aditi: "female",
  ananya: "female", shreya: "female", swati: "female", deepa: "female",
  rekha: "female", sunita: "female", kavitha: "female", shwetha: "female",
  shweta: "female", vidya: "female", amrita: "female", ishita: "female",
  tara: "female", nandini: "female", chitra: "female", bhavana: "female",
  alexa: "female", siri: "female", cortana: "female", eva: "female",
  ava: "female", sophia: "female", sofia: "female", luna: "female",
  // male
  arjun: "male", rahul: "male", rohit: "male", amit: "male", raj: "male",
  ravi: "male", kiran: "male", karthik: "male", hemanth: "male",
  ganesh: "male", suresh: "male", ramesh: "male", mahesh: "male",
  rajesh: "male", dinesh: "male", naveen: "male", praveen: "male",
  vikram: "male", vijay: "male", ajay: "male", sanjay: "male",
  aditya: "male", akash: "male", anand: "male", deepak: "male",
  gaurav: "male", harsh: "male", nikhil: "male", pradeep: "male",
  sachin: "male", varun: "male", yash: "male", krishna: "male",
  shiva: "male", hari: "male", arun: "male", manoj: "male",
  jarvis: "male", max: "male", leo: "male", milo: "male", atlas: "male",
  friday: "neutral", echo: "neutral", nova: "neutral", ace: "neutral",
};

const cache = new Map(); // lowercased name -> 'male' | 'female' | 'neutral'

/** @returns {'male'|'female'|null} */
function voiceGender(voice) {
  const v = String(voice || "").trim().toLowerCase();
  return VOICE_GENDER[v] || null;
}

/**
 * @returns {Promise<'male'|'female'|'neutral'>} 'neutral' whenever it
 * cannot be judged — the rule fails OPEN rather than rejecting a name
 * nobody can classify.
 */
async function nameGender(name) {
  const n = String(name || "").trim().toLowerCase().split(/\s+/)[0];
  if (!n || n.length < 2) return "neutral";
  if (NAME_GENDER[n]) return NAME_GENDER[n];
  if (cache.has(n)) return cache.get(n);

  let answer = "neutral";
  try {
    const { reply } = await require("../services/ai/router").generateReply(
      [{ role: "user", content: `Given name: "${name}"` }],
      {
        system:
          "You label given names by gender, for Indian and international " +
          "names alike. Answer with exactly one word: male, female, or " +
          "neutral. Use neutral for names that are genuinely unisex, " +
          "invented, or that you cannot judge. No punctuation, no " +
          "explanation.",
      }
    );
    const w = String(reply || "").trim().toLowerCase().replace(/[^a-z]/g, "");
    if (w === "male" || w === "female" || w === "neutral") answer = w;
  } catch (_) {
    // The model being unavailable must never block someone renaming their
    // assistant.
  }
  cache.set(n, answer);
  return answer;
}

/**
 * Do this name and this voice agree?
 * @returns {Promise<{ok:true}|{ok:false, message:string, nameGender:string, voiceGender:string}>}
 */
async function check(name, voice) {
  const vg = voiceGender(voice);
  if (!vg || !String(name || "").trim()) return { ok: true };
  const ng = await nameGender(name);
  if (ng === "neutral" || ng === vg) return { ok: true };

  const pick = vg === "female"
    ? "Kore, Aoede or Leda"
    : "Fenrir, Charon or Puck";
  const other = ng === "female" ? "Kore, Aoede or Leda" : "Fenrir, Charon or Puck";
  return {
    ok: false,
    nameGender: ng,
    voiceGender: vg,
    message:
      `"${String(name).trim()}" is a ${ng} name and ${voice} is a ${vg} ` +
      `voice. Either choose a ${vg} name to go with ${voice}, or switch ` +
      `the voice to ${other} to keep the name.` +
      (pick === other ? "" : ""),
  };
}

module.exports = { check, nameGender, voiceGender, VOICE_GENDER };
