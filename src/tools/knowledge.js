/**
 * KNOWLEDGE TOOL — one tool, every domain pack.
 *
 * WHY ONE TOOL AND NOT ONE PER DOMAIN
 * -----------------------------------
 * Every registered tool's name, description and schema are sent to the
 * model on EVERY turn, whatever the user asked about. Five domain tools
 * would mean five more declarations in the prompt for someone asking about
 * the weather — slower first token, and a longer list for the model to pick
 * wrongly from. One tool with a `domain` argument keeps the declaration
 * list flat as packs are added: the next five packs cost nothing per turn.
 *
 * WHY THERE IS NO MODEL CALL IN HERE
 * ----------------------------------
 * The first version of this (the legal tool) called generateReply inside
 * itself to compose an answer, which the outer agent loop then had to turn
 * into speech anyway — a whole extra round-trip to do the same job twice.
 * This returns FACTS plus the rules for using them, and the outer loop
 * composes once. On a spoken interface that is the difference between a
 * reply that lands in about a second and one that lands in three.
 */
const registry = require("./registry");
const engine = require("../knowledge/engine");
const rules = require("../knowledge/rules");
const legalGuard = require("../legal/guard");

/** Citations in the shape the app's existing results card already renders. */
function toCitations(entries) {
  return entries.map((e) => ({
    title: [e.source_short, e.ref].filter(Boolean).join(" ") + ` — ${e.title}`,
    url: e.source_url || "",
    snippet: e.summary,
    source: e.source_title,
  }));
}

/** The compact fact block the model reasons over. */
function toFacts(entries) {
  return entries.map((e) => ({
    source: [e.source_short, e.ref].filter(Boolean).join(" "),
    of: e.source_title,
    title: e.title,
    says: e.summary,
    detail: e.detail || undefined,
    status: e.status !== "in_force" ? e.status : undefined,
    replaces: e.replaces || undefined,
  }));
}

/**
 * Things that change by the hour — a search question, never a rules one.
 */
const LIVE_FACT_RX =
  /\b(timing|timings|schedule|departure|arrival|flight|flights|train|trains|bus|fare|fares|price|prices|cost|ticket availability|available seats|availability|weather|forecast|news|headline|score|match|open now|opening hours|closing time|how much is|book a|cheapest)\b/i;

/**
 * ...unless they are plainly asking about the RULE rather than the fact.
 * "What are the rules for train ticket refunds" is a knowledge question
 * even though it contains "train" and "ticket".
 */
const RULE_RX =
  /\b(rule|rules|law|laws|legal|right|rights|entitled|entitlement|section|act\b|penalty|fine|punishment|procedure|how do i (apply|file|register|claim)|deadline|limitation|compensation|refund|cancellation|cancel(ling)? charge|tatkal|baggage|allowance|eligib|am i allowed|can they|is it legal)/i;

let registered = false;

function registerKnowledgeTools() {
  if (registered) return;
  registered = true;

  registry.register({
    name: "consult_knowledge",
    description:
      "Look up RULES, RIGHTS, LAWS and official PROCEDURES. " +
      "DO NOT USE for live facts — flight or train timings, prices, seat " +
      "availability, weather, news, opening hours, scores. Those need a web " +
      "search, and this tool would return transport LAW instead of times. " +
      "Use this for questions about: INDIAN LAW (rights, offences, punishments, " +
      "police and FIR procedure, consumer, family, property, tenancy, " +
      "employment law); GOVERNMENT DOCUMENTS AND SERVICES (Aadhaar, PAN, " +
      "passport, driving licence, voter ID, birth/death certificates, " +
      "DigiLocker, grievances); MONEY (income tax, ITR, TDS, deductions, " +
      "EPF, credit score, insurance claims, UPI and bank fraud recovery); " +
      "HEALTH (first aid, emergencies, when to see a doctor, helplines); " +
      "TRAVEL (train refunds and Tatkal, flight cancellation and baggage " +
      "rights, vehicle documents, help abroad). " +
      "ALWAYS call this instead of answering from memory on these topics — " +
      "the facts it returns are current and your recollection may not be.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The user's question, in their own words",
        },
        domain: {
          type: "string",
          enum: ["legal", "govt", "money", "health", "travel"],
          description:
            "Narrows the search when the domain is obvious. OMIT when the " +
            "question could span domains (an insurance rejection is both " +
            "money and legal) — searching everything is just as fast.",
        },
      },
      required: ["question"],
    },

    async execute(args) {
      const question = String(args.question || "").trim();
      if (!question) return { ok: false, needsArgs: ["question"] };

      // LIVE FACTS ARE NOT KNOWLEDGE.
      //
      // A prompt is guidance; this is a guarantee. Asked for "flight
      // timings Mangalore to Bangalore tomorrow" the model called this
      // tool, the travel pack matched on the word "flight", and the user
      // got the Motor Vehicles Act and railway refund rules pushed onto
      // their screen. Refusing here — and returning NO citations — means
      // that cannot happen however the model is prompted.
      if (LIVE_FACT_RX.test(question) && !RULE_RX.test(question)) {
        return {
          ok: false,
          error:
            "this is a live-facts question (times, prices, availability), " +
            "not a rules question. Use Google Search or web_search and " +
            "answer from that. Do not call consult_knowledge again for this.",
        };
      }

      const domain = engine.DOMAINS.includes(args.domain) ? args.domain : null;

      let found;
      try {
        found = await engine.retrieve(question, { domain, limit: 6 });
      } catch (e) {
        return {
          ok: false,
          error: `the knowledge base is unavailable (${String(e.message).slice(0, 80)})`,
        };
      }

      // LEGAL ONLY: did they quote a section that no longer exists? This is
      // frequently the most useful part of the answer, and it is worth
      // returning even when nothing else matched.
      const repealed =
        (!domain || domain === "legal") ? legalGuard.findRepealedRefs(question) : [];

      let entries = found.entries;

      // Pull in the replacing provision for anything they cited by its old
      // number, if the retrieval did not already surface it.
      if (repealed.length) {
        for (const r of repealed) {
          if (!r.act || !r.section) continue;
          if (entries.some((e) => e.source_short === r.act && e.ref === r.section)) continue;
          const hit = await engine.retrieve(`${r.act} ${r.section}`, { domain: "legal", limit: 1 });
          if (hit.entries.length) entries = [...entries, hit.entries[0]];
        }
      }

      if (!entries.length && !repealed.length) {
        // Honest empty. The rules tell the model not to improvise, which is
        // the single most important instruction this tool ever sends.
        return {
          ok: true,
          data: {
            found: 0,
            rules: rules.rulesFor(domain, { empty: true }),
          },
          // No `speak`: the outer model composes the "I don't have that"
          // in the user's language and register.
        };
      }

      const corrections = repealed
        .filter((r) => r.cited)
        .map((r) =>
          r.section
            ? `${r.cited} is repealed — the current provision is ${r.act} ${r.section} (${r.title}).${r.note ? " " + r.note : ""}`
            : `${r.cited} is repealed and I cannot confirm the replacing section number — say so rather than guessing.`
        );

      const domains = [...new Set(entries.map((e) => e.domain))];

      return {
        ok: true,
        data: {
          found: entries.length,
          facts: toFacts(entries),
          corrections: corrections.length ? corrections : undefined,
          rules: rules.rulesForEntries(entries),
          close_with: domains.length === 1 ? rules.CLOSERS[domains[0]] : undefined,
          // Observability: which path served this, and how long retrieval
          // took in process. `used_embedding:false` means it cost zero API
          // calls to retrieve.
          retrieval_ms: found.ms,
          used_embedding: found.usedEmbedding,
        },
        // Citations land on screen so the user can verify what was spoken.
        deviceAction: {
          type: "search_results",
          query: question.slice(0, 80),
          results: toCitations(entries),
        },
      };
    },
  });
}

module.exports = { registerKnowledgeTools, toCitations, toFacts };
