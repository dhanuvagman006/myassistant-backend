/**
 * DOMAIN RULES — what the model must and must not do with retrieved facts.
 *
 * These travel back to the OUTER model inside the tool result, rather than
 * being applied by a second model call inside the tool. That is the whole
 * latency design: the agent loop was always going to compose a spoken reply
 * from the tool result, so the rules ride along with the facts and the
 * composition happens once instead of twice.
 *
 * They are written as short imperatives because they are read by a model
 * mid-turn, not by a person.
 */

const COMMON = [
  "Answer ONLY from the facts provided. If they do not cover the question, say so plainly — never fill the gap from your own knowledge.",
  "Name the source you used so the user can check it.",
  "Keep it short and spoken: the direct answer first, then the source, then what to do next.",
];

const BY_DOMAIN = {
  legal: [
    "Never state a section number that is not in the facts provided. An invented citation is the worst possible answer.",
    "The IPC, CrPC and Evidence Act were replaced on 1 July 2024 by the BNS, BNSS and BSA. Never cite the old codes as current law.",
    "This is legal information, not advice, and you are not the user's advocate. Do not predict how their case will be decided.",
    "State any deadline or limitation period prominently — missing one usually ends a case regardless of its merits.",
    "Rent, land and police matters are often state subjects. Say so where it matters.",
  ],
  health: [
    "NEVER diagnose, never name a likely condition from symptoms, and never give a medicine or a dose — not even for a common over-the-counter drug.",
    "If the facts describe an emergency, lead with the emergency action and the number to call. Say it first, before anything else.",
    "Tell the user what to watch for and when it becomes urgent, then point them to a doctor.",
  ],
  money: [
    "Tax slabs, limits and thresholds change every Union Budget. If a figure names a financial year, SAY the financial year aloud and tell the user to confirm the current year's figure.",
    "Do not give personalised investment advice or recommend a specific product.",
    "For anything with a reporting deadline — fraud, a claim, a return — lead with the deadline, because it is the part that expires.",
  ],
  govt: [
    "Fees and processing times drift. Give them as the published figure and point at the official portal to confirm.",
    "Many services are state-administered and differ by state. Where the facts say so, say so rather than describing a national procedure that does not exist.",
  ],
  travel: [
    "Fares, charges and timings change. Give the rule and tell the user to confirm on the operator's own site before acting.",
    "Where a right has a claim deadline, lead with the deadline.",
  ],
};

/**
 * Builds the instruction list that accompanies retrieved facts.
 * @param {string|null} domain
 * @param {boolean} empty  true when nothing was retrieved
 */
function rulesFor(domain, { empty = false } = {}) {
  if (empty) {
    return [
      "NOTHING was found for this question in the knowledge packs.",
      "Tell the user plainly that you don't have this one. Do NOT answer from your own knowledge — that is exactly the failure this tool exists to prevent.",
      "Suggest where they could check, or offer to help another way.",
    ];
  }
  const extra = BY_DOMAIN[domain] || [];
  // A cross-domain answer gets every relevant domain's rules, because a
  // question that reaches both money and legal entries must satisfy both.
  return [...COMMON, ...extra];
}

/** Rules for a mixed result set — union of the domains actually returned. */
function rulesForEntries(entries) {
  if (!entries.length) return rulesFor(null, { empty: true });
  const domains = [...new Set(entries.map((e) => e.domain))];
  const extra = [];
  for (const d of domains) for (const r of BY_DOMAIN[d] || []) if (!extra.includes(r)) extra.push(r);
  return [...COMMON, ...extra];
}

/** One-line closer per domain. Kept short — nobody listens to a paragraph. */
const CLOSERS = {
  legal: "General legal information, not advice for your specific case.",
  health: "First aid guidance only — not a diagnosis.",
  money: "General information — confirm current figures before you file or invest.",
  govt: "Confirm fees and timelines on the official portal.",
  travel: "Confirm with the operator before you travel.",
};

module.exports = { rulesFor, rulesForEntries, CLOSERS, COMMON, BY_DOMAIN };
