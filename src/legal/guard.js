/**
 * LEGAL GUARDRAILS.
 *
 * Two jobs, both about not misleading someone who is going to act on the
 * answer.
 *
 * 1. THE REPEALED-STATUTE PROBLEM
 * -------------------------------
 * On 1 July 2024 the Indian Penal Code, Criminal Procedure Code and
 * Evidence Act were replaced by the BNS, BNSS and BSA. Every textbook,
 * every judgment before that date, every forum post and effectively all
 * model training data uses the old numbering. So the single most likely
 * error in any Indian criminal-law answer is a confident citation of a
 * section that no longer exists — "file a 420 case", "he's been booked
 * under 302".
 *
 * The mapping below is used in both directions:
 *   • the user says "498A"      -> we find the law they mean (BNS 85)
 *   • the answer would say IPC  -> we translate and flag it
 *
 * The map is DELIBERATELY PARTIAL. It covers the sections people actually
 * name. An unmapped old section returns null, which the tool reports as
 * "I can't confirm the new number" — far better than guessing one, since a
 * wrong section number is worse than none.
 *
 * 2. THE ADVICE BOUNDARY
 * ----------------------
 * Explaining what the law says is useful and safe. Telling someone what to
 * do in their specific dispute is legal advice, and getting it wrong costs
 * them a case, a deadline or their liberty. `NEEDS_ADVOCATE` marks the
 * situations where the answer must end by pointing at a real lawyer —
 * including free legal aid, so that is never a dead end for someone who
 * cannot pay.
 */

/**
 * Old citation -> new one. Format: "<code> <section>" (lowercased key).
 * `note` carries the cases where it is NOT a clean renumbering.
 */
const REPEALED_MAP = {
  // ---- IPC -> BNS ----
  "ipc 34": { act: "BNS", section: "3(5)", title: "Common intention" },
  "ipc 120b": { act: "BNS", section: "61(2)", title: "Criminal conspiracy" },
  "ipc 124a": {
    act: "BNS", section: "152", title: "Act endangering sovereignty, unity and integrity of India",
    note: "Sedition was REPEALED, not renumbered. BNS 152 is a differently worded and narrower offence — do not treat them as equivalent.",
  },
  "ipc 300": { act: "BNS", section: "101", title: "Murder (definition)" },
  "ipc 302": { act: "BNS", section: "103(1)", title: "Punishment for murder" },
  "ipc 304": { act: "BNS", section: "105", title: "Culpable homicide not amounting to murder" },
  "ipc 304a": { act: "BNS", section: "106(1)", title: "Causing death by negligence" },
  "ipc 304b": { act: "BNS", section: "80", title: "Dowry death" },
  "ipc 306": { act: "BNS", section: "108", title: "Abetment of suicide" },
  "ipc 307": { act: "BNS", section: "109", title: "Attempt to murder" },
  "ipc 323": { act: "BNS", section: "115(2)", title: "Voluntarily causing hurt" },
  "ipc 324": { act: "BNS", section: "118(1)", title: "Voluntarily causing hurt by dangerous weapons" },
  "ipc 325": { act: "BNS", section: "117(2)", title: "Voluntarily causing grievous hurt" },
  "ipc 354": { act: "BNS", section: "74", title: "Assault on a woman with intent to outrage modesty" },
  "ipc 354a": { act: "BNS", section: "75", title: "Sexual harassment" },
  "ipc 354d": { act: "BNS", section: "78", title: "Stalking" },
  "ipc 375": { act: "BNS", section: "63", title: "Rape (definition)" },
  "ipc 376": { act: "BNS", section: "64", title: "Punishment for rape" },
  "ipc 379": { act: "BNS", section: "303(2)", title: "Theft" },
  "ipc 392": { act: "BNS", section: "309(4)", title: "Robbery" },
  "ipc 395": { act: "BNS", section: "310(2)", title: "Dacoity" },
  "ipc 406": { act: "BNS", section: "316(2)", title: "Criminal breach of trust" },
  "ipc 420": { act: "BNS", section: "318(4)", title: "Cheating and dishonestly inducing delivery of property" },
  "ipc 425": { act: "BNS", section: "324", title: "Mischief" },
  "ipc 441": { act: "BNS", section: "329", title: "Criminal trespass" },
  "ipc 447": { act: "BNS", section: "329", title: "Criminal trespass" },
  "ipc 498a": { act: "BNS", section: "85", title: "Cruelty by husband or his relatives" },
  "ipc 499": { act: "BNS", section: "356", title: "Defamation" },
  "ipc 500": { act: "BNS", section: "356", title: "Defamation" },
  "ipc 503": { act: "BNS", section: "351", title: "Criminal intimidation" },
  "ipc 506": { act: "BNS", section: "351", title: "Criminal intimidation" },
  "ipc 509": { act: "BNS", section: "79", title: "Insulting the modesty of a woman" },

  // ---- CrPC -> BNSS ----
  "crpc 41": { act: "BNSS", section: "35", title: "Arrest without warrant" },
  "crpc 41a": { act: "BNSS", section: "35(3)", title: "Notice of appearance instead of arrest" },
  "crpc 50": { act: "BNSS", section: "47", title: "Right to be informed of grounds of arrest" },
  "crpc 50a": { act: "BNSS", section: "48", title: "Right to have a relative informed" },
  "crpc 57": { act: "BNSS", section: "58", title: "Production before a Magistrate in 24 hours" },
  "crpc 125": { act: "BNSS", section: "144", title: "Maintenance of wife, children and parents" },
  "crpc 154": { act: "BNSS", section: "173", title: "Registration of FIR" },
  "crpc 156": { act: "BNSS", section: "175", title: "Police investigation; Magistrate's direction to investigate" },
  "crpc 161": { act: "BNSS", section: "180", title: "Examination of witnesses by police" },
  "crpc 164": { act: "BNSS", section: "183", title: "Recording of confessions and statements" },
  "crpc 167": { act: "BNSS", section: "187", title: "Default bail when investigation is not completed" },
  "crpc 436a": { act: "BNSS", section: "479", title: "Maximum detention of an undertrial" },
  "crpc 438": { act: "BNSS", section: "482", title: "Anticipatory bail" },

  // ---- Evidence Act -> BSA ----
  "evidence act 25": { act: "BSA", section: "23", title: "Confession to police not admissible" },
  "evidence act 26": { act: "BSA", section: "23", title: "Confession in police custody" },
  "evidence act 65b": { act: "BSA", section: "63", title: "Admissibility of electronic records" },
};

/**
 * Finds references to repealed provisions in a piece of text.
 * Recognises "420 IPC", "IPC 420", "section 498A IPC", "u/s 302 IPC",
 * "65B of the Evidence Act", "CrPC 41A".
 *
 * @returns {Array<{cited:string, act:string, section:string, title:string, note?:string}>}
 */
function findRepealedRefs(text) {
  const s = String(text || "");
  const out = [];
  const seen = new Set();

  const CODES = [
    { rx: /\b(?:ipc|indian penal code)\b/i, key: "ipc" },
    { rx: /\b(?:crpc|cr\.?p\.?c\.?|code of criminal procedure)\b/i, key: "crpc" },
    { rx: /\b(?:evidence act|iea)\b/i, key: "evidence act" },
  ];

  // "<section> <code>" and "<code> <section>" both occur naturally.
  const patterns = [
    /\b(?:section|sec\.?|s\.?|u\/s)?\s*(\d{1,3}\s*[a-z]?)\s*(?:of\s+(?:the\s+)?)?(ipc|indian penal code|crpc|cr\.?p\.?c\.?|code of criminal procedure|evidence act|iea)\b/gi,
    /\b(ipc|indian penal code|crpc|cr\.?p\.?c\.?|code of criminal procedure|evidence act|iea)\s*(?:section|sec\.?|s\.?|u\/s)?\s*(\d{1,3}\s*[a-z]?)\b/gi,
  ];

  for (let pi = 0; pi < patterns.length; pi++) {
    let m;
    while ((m = patterns[pi].exec(s))) {
      const num = (pi === 0 ? m[1] : m[2]).replace(/\s+/g, "").toLowerCase();
      const codeRaw = pi === 0 ? m[2] : m[1];
      const code = CODES.find((c) => c.rx.test(codeRaw));
      if (!code) continue;
      const key = `${code.key} ${num}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = REPEALED_MAP[key];
      out.push({
        cited: `${code.key.toUpperCase()} ${num.toUpperCase()}`,
        ...(hit || { act: null, section: null, title: null }),
      });
    }
  }
  return out;
}

/**
 * The instruction block injected in front of every legal answer.
 *
 * It is written as hard constraints rather than advice because the failure
 * being prevented — an invented section number stated with confidence — is
 * exactly what a model does well when left to its own recollection.
 */
function legalSystemBlock({ provisions = [], repealed = [] } = {}) {
  const lines = [
    "You are answering a question about INDIAN LAW.",
    "",
    "HARD RULES:",
    "1. Answer ONLY from the retrieved provisions below. If they do not cover " +
      "the question, say plainly that you don't have that provision and " +
      "suggest where to check. NEVER produce a section number that is not " +
      "in the retrieved text — an invented citation is the worst possible " +
      "answer here.",
    "2. Always name the Act and section you are relying on, so the user can " +
      "verify it.",
    "3. The IPC, CrPC and Evidence Act were REPLACED on 1 July 2024 by the " +
      "BNS, BNSS and BSA. Never cite IPC/CrPC/Evidence Act sections as " +
      "current law. If the user uses an old number, tell them the new one.",
    "4. This is legal INFORMATION, not legal advice, and you are not the " +
      "user's advocate. Explain what the law says and what the process is; " +
      "do not predict how their case will be decided or guarantee outcomes.",
    "5. State any deadline or limitation period prominently — a missed " +
      "limitation period usually ends a case regardless of its merits.",
    "6. Laws differ by state, and rent, land, police and stamp duty matters " +
      "are often state subjects. Say so where it matters.",
    "7. Keep it short and spoken — this is read aloud. Lead with the direct " +
      "answer, then the section, then what to do next.",
  ];

  if (repealed.length) {
    lines.push("", "THE USER REFERRED TO REPEALED PROVISIONS — correct them:");
    for (const r of repealed) {
      lines.push(
        r.section
          ? `  • ${r.cited} is repealed. The current provision is ${r.act} ${r.section} — ${r.title}.${r.note ? " " + r.note : ""}`
          : `  • ${r.cited} is repealed. Tell the user it no longer exists and that you cannot confirm the replacing section number.`
      );
    }
  }

  if (provisions.length) {
    lines.push("", "RETRIEVED PROVISIONS (the ONLY basis for your answer):");
    for (const p of provisions) {
      lines.push(
        `  • ${p.act_short} ${p.section} — ${p.title}` +
          (p.status !== "in_force" ? ` [${p.status.toUpperCase()}]` : "") +
          `\n    ${p.summary}` +
          (p.detail ? `\n    ${p.detail}` : "") +
          (p.replaces ? `\n    (replaces ${p.replaces})` : "")
      );
    }
  } else {
    lines.push(
      "",
      "NO PROVISIONS WERE RETRIEVED. Say you don't have the law on this " +
        "point, and do not answer from memory."
    );
  }

  return lines.join("\n");
}

/**
 * Situations where information is not enough and a real lawyer is needed.
 * Matching one appends the referral — including free legal aid, so this is
 * never a dead end for someone who cannot afford a private advocate.
 */
const NEEDS_ADVOCATE = [
  { rx: /\b(arrest(ed)?|custody|remand|police station|detain(ed)?)\b/i,
    why: "you or someone is in police custody" },
  { rx: /\b(bail|anticipatory bail|fir against me|charge ?sheet|summons|warrant)\b/i,
    why: "there is a live criminal proceeding" },
  { rx: /\b(hearing|next date|court date|appeal|deadline|limitation|time.?barred)\b/i,
    why: "a court deadline may be running" },
  { rx: /\b(sign|signing|notarise|notarize|register(ed)? (the )?(sale|deed|agreement))\b/i,
    why: "you are about to sign something binding" },
  { rx: /\b(custody of (my )?(child|children)|divorce petition|maintenance case)\b/i,
    why: "a family court matter is involved" },
];

function advocateReferral(question) {
  const hit = NEEDS_ADVOCATE.find((n) => n.rx.test(String(question || "")));
  if (!hit) return null;
  return (
    `Because ${hit.why}, please get an actual advocate on this — I can tell you ` +
    `what the law says, but not act for you. If cost is the issue, free legal aid ` +
    `is a right: call 15100 or go to the District Legal Services Authority at your ` +
    `district court.`
  );
}

/** Short spoken disclaimer. Deliberately one line — nobody listens to five. */
const DISCLAIMER =
  "This is general legal information, not advice for your specific case.";

module.exports = {
  REPEALED_MAP,
  findRepealedRefs,
  legalSystemBlock,
  advocateReferral,
  NEEDS_ADVOCATE,
  DISCLAIMER,
};
