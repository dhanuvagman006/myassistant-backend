/**
 * THE TOOL CONTRACT — what a capability is allowed to declare about itself.
 * ----------------------------------------------------------------------
 * WHY THIS FILE EXISTS. The registry knew three things about a tool: its
 * risk word, whether the phone performs it, and its input schema. Every
 * other property that matters — does it leave the system, may it be
 * retried, may it run unattended, must it be confirmed, what does it need
 * configured, what does it return — lived OUTSIDE the tool, in five
 * hand-maintained name lists in registry.js and a sixth in claimCheck.
 *
 * Hand-maintained lists drift, and this set had already drifted in ways
 * with teeth:
 *   • MEMORY_WRITES named "add_instruction". No such tool exists — it is
 *     `add_standing_instruction`. So the ONE tool that writes a permanent
 *     behaviour rule into every future prompt had no grounding gate at all.
 *   • delete_calendar_event is high-risk and irreversible on a third
 *     party's service, and was absent from WORLD_ACTIONS — so it was never
 *     claim-checked, never repeat-guarded, and was filed in the ledger as
 *     a non-action.
 *   • claimCheck's "remind" family names set_morning_brief, which was not a
 *     world action and could therefore never appear as evidence.
 * None of that was detectable by reading either file alone. A new tool
 * inherited the same silence: low risk, no recording, no guard, unattended
 * allowed, and nothing anywhere noticed.
 *
 * So the properties move ONTO the declaration, the sets are DERIVED from
 * the declarations, and `drift()` fails the boot when a list names a tool
 * that does not exist or a tool's own declaration contradicts the list.
 *
 * MIGRATION IS DELIBERATELY INCREMENTAL. The legacy name lists remain as a
 * seed and are UNIONED with what is derived, so all 89 existing tools keep
 * their exact current behaviour on day one. A tool opts in by declaring
 * `effects`, and only then are the stricter invariants enforced against it.
 * There is no flag day.
 */

/* ------------------------------------------------------------------ */
/* VOCABULARY                                                          */
/* ------------------------------------------------------------------ */

/**
 * WHAT A TOOL DOES TO THE WORLD. This replaces `risk` as the load-bearing
 * property — risk is a judgement, an effect is a fact, and the safety
 * machinery should key off facts.
 */
const EFFECTS = Object.freeze({
  READ: "read",                  // a lookup. No trace, safe to repeat.
  WRITE_MEMORY: "write:memory",   // durable memory, profile, standing rule
  WRITE_RECORD: "write:record",   // the user's own records: finance, docs, commitments
  SEND_EXTERNAL: "send:external", // leaves the system: a message, an email, a call
  DEVICE: "device",              // only the handset can perform it
  MONEY: "money",                // spends or moves money, ours or theirs
  IRREVERSIBLE: "irreversible",   // we cannot undo it
});
const EFFECT_VALUES = new Set(Object.values(EFFECTS));

/** How a repeat of the same request should be treated. */
const DEDUPE = Object.freeze({
  NEVER: "never",          // repeating is harmless, or is the point
  PER_TURN: "per-turn",     // same breath, same socket — 20 s in-memory
  DURABLE: "durable",       // any surface, 45 s, read from Postgres
  BY_OUTCOME: "by-outcome", // guarded by whether the last one finished (calls)
});
const DEDUPE_VALUES = new Set(Object.values(DEDUPE));

/** What must be true before a tool can even be offered to the model. */
const REQUIRE_KINDS = new Set([
  "auth",              // a signed-in user (replaces `if (!ctx.userId)` in ~60 tools)
  "os_permission",     // an Android runtime permission, by manifest name
  "device_capability", // a phone feature the app reported (sms, telephony…)
  "app_build",         // a minimum installed app build number
  "integration",       // a configured third party: google_oauth, razorpay, plivo…
  "platform",          // android | ios | server
]);

/**
 * THE OUTCOME TAXONOMY. "Done" was previously indistinguishable from
 * "handed to the phone and never heard about again". These five are, and
 * every execution records which one it was.
 */
const OUTCOME = Object.freeze({
  OK: "ok",                 // finished, verified, nothing outstanding
  DISPATCHED: "dispatched",  // correctly sent to the handset; awaiting its receipt
  PARTIAL: "partial",        // some of it succeeded and some did not
  NEEDS_USER: "needs_user",  // blocked on a person: missing argument, confirmation
  FAILED: "failed",          // it did not happen
  SUPPRESSED: "suppressed",  // deliberately not run (a gate, a repeat guard)
});

/* ------------------------------------------------------------------ */
/* DEFAULTS DERIVED FROM EFFECTS                                       */
/* ------------------------------------------------------------------ */

function hasAny(effects, ...names) {
  return names.some((n) => effects.includes(n));
}

/** A consequential effect implies a dedupe policy; a read implies none. */
function defaultDedupe(effects) {
  if (hasAny(effects, EFFECTS.SEND_EXTERNAL, EFFECTS.MONEY, EFFECTS.IRREVERSIBLE)) {
    return DEDUPE.DURABLE;
  }
  if (hasAny(effects, EFFECTS.DEVICE)) return DEDUPE.PER_TURN;
  if (hasAny(effects, EFFECTS.WRITE_MEMORY, EFFECTS.WRITE_RECORD)) return DEDUPE.PER_TURN;
  return DEDUPE.NEVER;
}

/**
 * Whether a background/scheduled run may fire this without a person there.
 * Anything that leaves the system, spends money, or cannot be undone may
 * not — that is what "unattended" means and it should not be a name list.
 */
function defaultUnattended(effects) {
  return !hasAny(
    effects, EFFECTS.SEND_EXTERNAL, EFFECTS.MONEY, EFFECTS.IRREVERSIBLE, EFFECTS.DEVICE
  );
}

/** Retrying is only ever safe when repeating the call cannot double the effect. */
function defaultRetryable(effects) {
  return !hasAny(
    effects, EFFECTS.SEND_EXTERNAL, EFFECTS.MONEY, EFFECTS.IRREVERSIBLE
  );
}

const DEFAULT_TIMEOUT_MS = 30_000;

/* ------------------------------------------------------------------ */
/* NORMALISE + VALIDATE ONE DECLARATION                                */
/* ------------------------------------------------------------------ */

/**
 * Fills in the defaults a tool did not state and rejects a declaration
 * that contradicts itself. Throws — a malformed capability must fail the
 * boot, not a user's turn.
 *
 * A tool that declares no `effects` is a LEGACY tool: it is left alone
 * except for the shape checks, and the registry's seed lists continue to
 * govern it. That is what keeps this change safe to deploy.
 */
function normalize(tool) {
  const name = tool.name;
  const declared = tool.effects !== undefined;

  if (declared) {
    if (!Array.isArray(tool.effects) || tool.effects.length === 0) {
      throw new Error(`tool ${name}: effects must be a non-empty array`);
    }
    for (const e of tool.effects) {
      if (!EFFECT_VALUES.has(e)) {
        throw new Error(
          `tool ${name}: unknown effect "${e}" — one of ${[...EFFECT_VALUES].join(", ")}`
        );
      }
    }
  }
  const effects = declared ? [...new Set(tool.effects)] : [];

  // A tool the phone performs is a device effect whether or not it said so.
  if (declared && tool.deviceAction && !effects.includes(EFFECTS.DEVICE)) {
    effects.push(EFFECTS.DEVICE);
  }

  const dedupe = tool.dedupe === undefined ? defaultDedupe(effects) : tool.dedupe;
  if (!DEDUPE_VALUES.has(dedupe)) {
    throw new Error(
      `tool ${name}: unknown dedupe "${dedupe}" — one of ${[...DEDUPE_VALUES].join(", ")}`
    );
  }

  // THE INVARIANT WORTH FAILING A BOOT FOR. Something that leaves the
  // system, spends money, or cannot be undone must be confirmable: the
  // confirmation card needs a sentence, and `risk` must say it is serious.
  // Only checked for tools that opted in, so no existing tool is affected.
  if (declared && hasAny(effects, EFFECTS.SEND_EXTERNAL, EFFECTS.MONEY, EFFECTS.IRREVERSIBLE)) {
    if ((tool.risk || "low") !== "high") {
      throw new Error(
        `tool ${name}: effects include ${effects.filter((e) =>
          [EFFECTS.SEND_EXTERNAL, EFFECTS.MONEY, EFFECTS.IRREVERSIBLE].includes(e)
        ).join("/")} so risk must be "high", not "${tool.risk || "low"}"`
      );
    }
    if (typeof tool.confirmSummary !== "function") {
      throw new Error(
        `tool ${name}: effects include a consequential effect, so confirmSummary(args, ctx) ` +
        "is required — the confirmation card has to be able to say what will happen"
      );
    }
    if (dedupe === DEDUPE.NEVER) {
      throw new Error(
        `tool ${name}: dedupe "never" is not allowed for a consequential effect — ` +
        "a stutter would do it twice"
      );
    }
  }

  // ---- requires[] ----
  const requires = [];
  if (tool.requires !== undefined) {
    if (!Array.isArray(tool.requires)) throw new Error(`tool ${name}: requires must be an array`);
    for (const r of tool.requires) {
      if (!r || typeof r !== "object") throw new Error(`tool ${name}: each requires entry must be an object`);
      if (!REQUIRE_KINDS.has(r.kind)) {
        throw new Error(
          `tool ${name}: unknown requires kind "${r.kind}" — one of ${[...REQUIRE_KINDS].join(", ")}`
        );
      }
      if (r.kind !== "auth" && !r.id) {
        throw new Error(`tool ${name}: requires {kind:"${r.kind}"} needs an id`);
      }
      requires.push({ kind: r.kind, id: r.id || null, when: r.when || null, reason: r.reason || "" });
    }
  }
  // The two legacy fields are folded into the same list so one resolver
  // handles both and nothing has to be migrated for this to work.
  if (tool.requiresPermission) {
    const perms = Array.isArray(tool.requiresPermission)
      ? tool.requiresPermission : [tool.requiresPermission];
    for (const p of perms) requires.push({ kind: "os_permission", id: p, when: null, reason: "" });
  }
  if (tool.minAppBuild) {
    requires.push({ kind: "app_build", id: String(tool.minAppBuild), when: null, reason: "" });
  }

  // ---- execution policy ----
  const timeoutMs = tool.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(tool.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 500 || timeoutMs > 600_000) {
    throw new Error(`tool ${name}: timeoutMs must be between 500 and 600000, got ${tool.timeoutMs}`);
  }

  let retry = null;
  if (tool.retry) {
    const attempts = Number(tool.retry.attempts);
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 4) {
      throw new Error(`tool ${name}: retry.attempts must be 1-4`);
    }
    const safe = tool.retry.safe === true;
    if (declared && !defaultRetryable(effects) && !safe) {
      throw new Error(
        `tool ${name}: cannot retry a tool whose effects include ` +
        `${effects.filter((e) => !defaultRetryable([e])).join("/")} — a retry would do it twice. ` +
        "Set retry.safe:true only if the handler is genuinely idempotent (e.g. it sends an " +
        "idempotency key to the provider)."
      );
    }
    retry = {
      attempts,
      safe,
      backoffMs: Number(tool.retry.backoffMs) > 0 ? Number(tool.retry.backoffMs) : 400,
    };
  }

  return {
    ...tool,
    effects,
    declaredEffects: declared,
    dedupe,
    requires,
    timeoutMs,
    retry,
    unattended: tool.unattended === undefined ? defaultUnattended(effects) : tool.unattended !== false,
    claimFamily: tool.claimFamily || null,
  };
}

/* ------------------------------------------------------------------ */
/* DERIVE THE SAFETY SETS FROM THE DECLARATIONS                        */
/* ------------------------------------------------------------------ */

/**
 * Everything registry.js used to hold as a literal. Only tools that
 * declared `effects` contribute; the registry unions these with its seed
 * lists so legacy tools are unchanged.
 */
function derive(tools) {
  const world = new Set();
  const memoryWrites = new Set();
  const repeatGuarded = new Set();
  const durableGuarded = new Set();
  const byOutcome = new Set();
  const unattendedBlocked = new Set();

  for (const t of tools) {
    if (!t.declaredEffects) continue;
    const e = t.effects;
    // A world action is anything whose effect leaves the conversation.
    if (hasAny(e, EFFECTS.SEND_EXTERNAL, EFFECTS.DEVICE, EFFECTS.MONEY,
               EFFECTS.IRREVERSIBLE, EFFECTS.WRITE_RECORD, EFFECTS.WRITE_MEMORY)) {
      world.add(t.name);
    }
    if (e.includes(EFFECTS.WRITE_MEMORY)) memoryWrites.add(t.name);
    if (t.dedupe === DEDUPE.PER_TURN || t.dedupe === DEDUPE.DURABLE) repeatGuarded.add(t.name);
    if (t.dedupe === DEDUPE.DURABLE) durableGuarded.add(t.name);
    if (t.dedupe === DEDUPE.BY_OUTCOME) byOutcome.add(t.name);
    if (!t.unattended) unattendedBlocked.add(t.name);
  }
  return { world, memoryWrites, repeatGuarded, durableGuarded, byOutcome, unattendedBlocked };
}

/* ------------------------------------------------------------------ */
/* DRIFT                                                               */
/* ------------------------------------------------------------------ */

/**
 * Two kinds of drift, both of which had already happened:
 *  • PHANTOM — a safety list names a tool that is not registered, so the
 *    protection silently applies to nothing. This is the `add_instruction`
 *    bug and it is the serious one.
 *  • CONTRADICTION — a tool declared effects that imply it belongs in a
 *    set, and the seed list disagrees.
 *
 * Returns {phantoms, contradictions}. The registry logs both and throws on
 * phantoms when STRICT_TOOL_CONTRACT is set, so a typo cannot reach
 * production as a missing gate a second time.
 */
function drift({ registeredNames, seedLists, derived }) {
  const phantoms = [];
  const contradictions = [];

  for (const [listName, names] of Object.entries(seedLists)) {
    for (const n of names) {
      if (!registeredNames.has(n)) {
        phantoms.push({ list: listName, name: n });
      }
    }
  }
  for (const [listName, names] of Object.entries(seedLists)) {
    const derivedSet = derived[SEED_TO_DERIVED[listName]];
    if (!derivedSet) continue;
    for (const n of derivedSet) {
      if (!names.has(n)) {
        contradictions.push({ list: listName, name: n, reason: "declared by the tool, absent from the seed list" });
      }
    }
  }
  return { phantoms, contradictions };
}

const SEED_TO_DERIVED = {
  WORLD_ACTIONS: "world",
  MEMORY_WRITES: "memoryWrites",
  REPEAT_GUARDED: "repeatGuarded",
  DURABLE_GUARDED: "durableGuarded",
};

/* ------------------------------------------------------------------ */
/* OUTCOMES                                                            */
/* ------------------------------------------------------------------ */

/**
 * Classify a result envelope. Deliberately reads the EXISTING envelope
 * shape, so no tool has to change for the taxonomy to start working.
 *
 * The important distinction it introduces is DISPATCHED: a deviceAction
 * returning ok:true means the server did its part and the handset has been
 * asked — not that the thing happened. Recording those as plain successes
 * is how "I opened YouTube" came to be asserted about an envelope the app
 * had dropped on the floor.
 */
function outcomeOf(res) {
  if (!res || typeof res !== "object") return OUTCOME.FAILED;
  if (res.repeated || res.suppressed || res.inFlight || res.alreadyDone) return OUTCOME.SUPPRESSED;
  if (res.needsConfirmation) return OUTCOME.NEEDS_USER;
  if (Array.isArray(res.needsArgs) && res.needsArgs.length) return OUTCOME.NEEDS_USER;
  // PARTIAL IS CHECKED BEFORE ok:false, and the order is the whole point.
  // A partial result carries ok:false — it did not fully succeed — but
  // calling it FAILED is precisely the lie this taxonomy exists to prevent:
  // a send that timed out mid-flight would be reported as "nothing was
  // sent", and the user would send it again.
  if (res.partial === true) return OUTCOME.PARTIAL;
  if (res.ok === false) return OUTCOME.FAILED;
  // A device action is only "ok" once the phone says so. `data.generated`
  // marks the server-side results (an image, a video) that are genuinely
  // finished despite riding in a deviceAction envelope.
  if (res.deviceAction && !(res.data && res.data.generated)) return OUTCOME.DISPATCHED;
  return OUTCOME.OK;
}

/** Did this outcome actually change the world? Used by the claim checker. */
function isSettled(outcome) {
  return outcome === OUTCOME.OK || outcome === OUTCOME.PARTIAL;
}

module.exports = {
  EFFECTS, EFFECT_VALUES, DEDUPE, DEDUPE_VALUES, REQUIRE_KINDS, OUTCOME,
  DEFAULT_TIMEOUT_MS,
  normalize, derive, drift, outcomeOf, isSettled,
  defaultDedupe, defaultUnattended, defaultRetryable,
  SEED_TO_DERIVED,
};
