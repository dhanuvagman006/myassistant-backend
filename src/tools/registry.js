/**
 * TOOL REGISTRY — the extensible capability layer for the agent runtime.
 *
 * Before this, capabilities were selected by ~8 hard-coded regex functions
 * inside a 750-line route (detectCallIntent, detectVideoMode, …). Adding a
 * capability meant editing that route and inventing another regex, and any
 * phrasing the regex didn't anticipate simply didn't work.
 *
 * Now every capability is a Tool with a declared schema. The MODEL chooses
 * which to call (Gemini function-calling), so "find me somewhere to eat
 * near here" and "any good dosa places around?" both reach the same tool
 * without a single new pattern.
 *
 *   Tool {
 *     name            unique id the model calls
 *     description     what it does / when to use it (the model reads this)
 *     inputSchema     JSON-schema-ish; becomes the function declaration
 *     risk            "low" | "medium" | "high"   (see permissions)
 *     deviceAction    true if the PHONE must perform it, not the server
 *     execute(args, ctx) -> { ok, data?, error?, speak? }
 *   }
 *
 * risk drives confirmation (§17):
 *   low     search, weather, memory reads          — run immediately
 *   medium  create reminder, save document         — run immediately
 *   high    place a call, send a message, delete    — confirm first
 *
 * deviceAction tools never "succeed" on the server: they return an action
 * for the app to perform, and the app reports the real result (§7/§27) —
 * the backend must never claim it dialled a phone it cannot dial.
 */

const contract = require("./contract");
const capabilities = require("./capabilities");

const REGISTRY = new Map();

/** Registers a tool. Throws on duplicate/invalid — fail at boot, not in a turn. */
function register(tool) {
  if (!tool || typeof tool.name !== "string" || !tool.name) {
    throw new Error("tool: name required");
  }
  if (typeof tool.execute !== "function") {
    throw new Error(`tool ${tool.name}: execute() required`);
  }
  if (!["low", "medium", "high"].includes(tool.risk || "low")) {
    throw new Error(`tool ${tool.name}: invalid risk "${tool.risk}"`);
  }
  if (REGISTRY.has(tool.name)) {
    throw new Error(`tool ${tool.name}: already registered`);
  }
  // THE CONTRACT. Fills in what the tool did not state, and throws on a
  // declaration that contradicts itself — a malformed capability must fail
  // the boot, never a user's turn. A tool that declares no `effects` is a
  // legacy tool and passes through untouched but for the shape checks, so
  // the seed lists below continue to govern it.
  REGISTRY.set(tool.name, contract.normalize({
    risk: "low",
    deviceAction: false,
    inputSchema: { type: "object", properties: {} },
    ...tool,
  }));
  return tool.name;
}

function get(name) {
  return REGISTRY.get(name) || null;
}

/**
 * Removes a tool. Needed by MCP: when a server disconnects or fails, its
 * tools must disappear from the registry so the model can no longer select
 * something that cannot run.
 */
function unregister(name) {
  return REGISTRY.delete(name);
}

function list() {
  return [...REGISTRY.values()];
}

/**
 * Gemini functionDeclarations for the registered tools.
 * `only` optionally restricts the set (e.g. a channel that can't do device
 * actions shouldn't be offered them).
 */
function declarations({ only = null, includeDeviceActions = true, userId = null, deviceCaps = null } = {}) {
  const uid = userId === null || userId === undefined ? null : Number(userId);
  return list()
    .filter((t) => (only ? only.includes(t.name) : true))
    // AVAILABILITY: never OFFER a tool that cannot run.
    //
    // A tool whose integration is unconfigured used to be declared anyway,
    // so the model would pick it, get back "not configured", and then tell
    // the user it was unable to help — when a plain search would have
    // answered them. Asked for flight timings with no airline API key, that
    // is exactly what happened. Hiding the tool lets the model reach for
    // something that works instead.
    .filter((t) => {
      if (typeof t.available !== "function") return true;
      try {
        return t.available() !== false;
      } catch (_) {
        return false;
      }
    })
    .filter((t) => (includeDeviceActions ? true : !t.deviceAction))
    // FEASIBILITY, DECLARED RATHER THAN DISCOVERED. A tool needing a
    // permission the user has denied, or an app build too old to perform
    // it, used to be offered anyway: the assistant said it was doing the
    // thing and the phone silently dropped it. Hidden here, the model
    // reaches for something that works — and can still explain the limit,
    // because limitsFor() below says what was withheld and why.
    // ONE RESOLVER for every kind of prerequisite — a permission, an app
    // build, a signed-in user, a configured third party, a platform. It
    // replaces the two-field special case that came before it and behaves
    // identically for the tools that only used those two fields.
    //
    // A per-user integration (a Google OAuth link) resolves as DEFERRED and
    // does not hide the tool: withholding the calendar from someone whose
    // link we have not checked yet is worse than letting the call come back
    // with an honest "their Google account is not connected".
    .filter((t) => {
      if (!t.requires || !t.requires.length) return true;
      return capabilities.resolveSync(t, { userId: uid, deviceCaps, forDeclaration: true }).available;
    })
    // TENANT BOUNDARY: an MCP tool belongs to the user who configured that
    // server. Another user must never even SEE it in their declarations,
    // let alone be able to call it (§6).
    .filter((t) => t.source !== "mcp" || (uid !== null && t.userId === uid))
    .map((t) => ({
      name: t.name,
      description: t.description || "",
      parameters: normalizeSchema(t.inputSchema),
    }));
}

/** Gemini wants uppercase JSON-schema types and no unsupported keywords. */
/**
 * What was withheld from this device, and why — so the assistant can say
 * "I need contacts permission for that" instead of failing at it, or
 * going quiet about a capability it does have a name for.
 */
function limitsFor(deviceCaps) {
  if (!deviceCaps) return [];
  const denied = new Set(deviceCaps.denied || []);
  const granted = new Set(deviceCaps.granted || []);
  const build = Number(deviceCaps.build || 0);
  const out = [];
  for (const t of list()) {
    if (t.requiresPermission) {
      const need = Array.isArray(t.requiresPermission)
        ? t.requiresPermission : [t.requiresPermission];
      const missing = need.filter((p) => denied.has(p) && !granted.has(p));
      if (missing.length) {
        out.push({ tool: t.name, reason: "permission", missing });
        continue;
      }
    }
    if (t.minAppBuild && build && build < t.minAppBuild) {
      out.push({ tool: t.name, reason: "app_too_old", needsBuild: t.minAppBuild });
    }
  }
  return out;
}

/** One prompt line naming the real limits, in the user's terms. */
function limitsBlock(deviceCaps) {
  const limits = limitsFor(deviceCaps);
  if (!limits.length) return "";
  const byPermission = new Map();
  const old = [];
  for (const l of limits) {
    if (l.reason === "permission") {
      for (const p of l.missing) {
        if (!byPermission.has(p)) byPermission.set(p, []);
        byPermission.get(p).push(l.tool);
      }
    } else old.push(l.tool);
  }
  const lines = [];
  for (const [perm, tools] of byPermission) {
    lines.push(
      `- ${perm.toUpperCase()} permission is NOT granted on this phone, so ` +
      `${tools.join(", ")} cannot run. If the user asks for one of these, say ` +
      `you need ${perm} permission and offer to open the settings page — do ` +
      `NOT attempt it and do NOT say it is done.`
    );
  }
  if (old.length) {
    lines.push(
      `- This phone's app version is too old for: ${old.join(", ")}. Say an ` +
      `update is needed rather than trying.`
    );
  }
  return "WHAT THIS PHONE CANNOT DO RIGHT NOW:\n" + lines.join("\n");
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return { type: "OBJECT", properties: {} };
  }
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "type" && typeof v === "string") out.type = v.toUpperCase();
    else if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(
        Object.entries(v).map(([pk, pv]) => [pk, normalizeSchema(pv)])
      );
    } else if (k === "items") out.items = normalizeSchema(v);
    else if (["description", "required", "enum", "format"].includes(k)) out[k] = v;
    // anything else (additionalProperties, $schema, default…) is dropped:
    // Gemini rejects unknown fields in a declaration.
  }
  if (!out.type) out.type = "OBJECT";
  if (out.type === "OBJECT" && !out.properties) out.properties = {};
  return out;
}

/** Coerces model-supplied args to the declared types; drops unknown keys. */
function coerceArgs(tool, raw) {
  const props = (tool.inputSchema && tool.inputSchema.properties) || {};
  const args = {};
  for (const [key, spec] of Object.entries(props)) {
    if (!(key in (raw || {}))) continue;
    let v = raw[key];
    const t = String(spec.type || "string").toLowerCase();
    if (t === "number" || t === "integer") {
      const n = Number(v);
      if (Number.isFinite(n)) args[key] = t === "integer" ? Math.trunc(n) : n;
    } else if (t === "boolean") {
      args[key] = v === true || v === "true";
    } else if (t === "array") {
      args[key] = Array.isArray(v) ? v : [v];
    } else if (t === "object") {
      if (v && typeof v === "object") args[key] = v;
    } else {
      if (v !== null && v !== undefined) args[key] = String(v);
    }
  }
  return args;
}

/** Missing required args, so the agent can ask instead of failing. */
function missingRequired(tool, args) {
  const req = (tool.inputSchema && tool.inputSchema.required) || [];
  return req.filter(
    (k) => args[k] === undefined || args[k] === null || args[k] === ""
  );
}

/**
 * Executes a tool by name.
 *
 * Returns a RESULT ENVELOPE, never throws:
 *   { ok:true,  data, speak? }
 *   { ok:false, error }                       real failure, reported honestly
 *   { ok:false, needsArgs:[…] }               agent should ask the user
 *   { ok:false, needsConfirmation:true, … }   high-risk, awaiting yes/no
 *   { ok:true,  deviceAction:{…} }            the APP must perform it
 */
/**
 * WORLD ACTIONS — tools whose effect leaves the conversation: a phone
 * rings, an app opens, a message arrives, a record changes. These are the
 * ones that must never fire on a misheard fragment, and the ones a reply
 * may not claim without evidence (src/agents/claimCheck.js).
 *
 * Everything else (lookups, reads, brief, memory recall) is harmless to
 * run on a poor transcript — at worst the answer is unhelpful.
 */
const SEED_WORLD = new Set([
  "place_phone_call", "send_agent_message", "send_whatsapp_message",
  "send_document", "send_patient_document", "book_by_calling_business",
  "arrange_meeting_with", "order_food", "book_ride", "book_movie_tickets",
  "collect_payment", "open_app", "open_webpage", "open_service_app",
  "open_video_mode", "start_navigation", "phone_control", "play_music",
  "capture_document", "analyze_camera", "set_alarm", "create_reminder",
  "update_reminder", "schedule_task", "schedule_patient_recall",
  "record_entry", "amend_last_entry", "record_patient_payment",
  "file_document_under_client", "associate_document", "save_web_document",
  "forget_memory", "start_interpreter_mode", "generate_image", "generate_video",
  "try_a_look",
  // ADDED after a drift audit found these absent. Each of them changes
  // something outside the conversation, and being missing here meant three
  // separate protections silently did not apply: the claim checker had no
  // evidence they ran (so a reply could assert or deny them freely), GATE 2
  // never suppressed a duplicate, and recordExecution filed them in the
  // ledger with world:0 — i.e. as though they were lookups.
  // delete_calendar_event is the worst of them: high risk and irreversible
  // on a third party's service.
  "create_calendar_event", "update_calendar_event", "delete_calendar_event",
  "set_timer", "complete_commitment", "configure_assistant",
  "remove_finance_item", "remove_standing_instruction", "set_morning_brief",
]);

function isWorldAction(name) {
  return EFFECTIVE.world.has(name);
}

/**
 * Tools that WRITE to durable memory or the user's profile. These are the
 * ones that must be grounded in the current turn — see GATE 0.
 */
const SEED_MEMORY = new Set([
  "remember_fact", "update_my_profile", "remember_person", "add_person_note",
  // WAS "add_instruction" — a tool that does not exist. The real name is
  // add_standing_instruction, so for as long as the typo stood, the ONE
  // tool that writes a permanent behaviour rule into every future prompt
  // had no GATE 0 grounding check at all. drift() below now fails the boot
  // on a name that matches no registered tool, so this cannot recur.
  "add_standing_instruction",
  // Also durable writes, also absent.
  "remember_case", "remember_event", "remember_person_date",
]);

/** Words too common to count as grounding. */
const MEM_STOP = new Set(
  ("that this they them their there then than with from about have has had " +
   "would could should will shall want wants need needs like likes user " +
   "assistant please thanks thank okay yeah yes no not prefers prefer " +
   "speaking speak message messaging name").split(" ")
);

/**
 * REPEAT-GUARDED (same breath, same socket) — world actions where firing
 * twice in one turn is a double-fire, not a second request. Broad on
 * purpose: launching an app twice in the same breath is always a bug.
 *
 * Deliberately NOT everything in WORLD_ACTIONS. Reminders, alarms, ledger
 * entries and generated media are things a user legitimately repeats — two
 * reminders about "the meeting", two payments logged for one client — and
 * suppressing those would invent a bug in place of the one being fixed.
 */
const SEED_REPEAT = new Set([
  "place_phone_call", "book_by_calling_business", "send_agent_message",
  "send_whatsapp_message", "send_document", "send_patient_document",
  "arrange_meeting_with", "order_food", "book_ride", "book_movie_tickets",
  "collect_payment", "open_app", "open_webpage", "open_service_app",
  "start_navigation", "play_music",
  // Every look costs money at a paid image model, so a stutter must not
  // buy two of them. An intentional "try that again" lands after 20 s.
  "try_a_look",
]);

/**
 * DURABLE-GUARDED (cross-session, 45 s) — the far narrower set where a
 * repeat arriving on another surface is still the same request: something
 * has left the device and cannot be taken back.
 *
 * App launches and navigation are NOT here. Reopening an app you just
 * backed out of, or restarting navigation, is ordinary and happens well
 * inside the window; refusing it reads as the assistant breaking.
 *
 * Calls are not here either, and that is deliberate. executed_actions is
 * written when a call is DISPATCHED — before the user approves the card
 * and before the handset finds the contact — so a declined or failed call
 * leaves an ok=1 row behind. Suppressing on that row would refuse the
 * retry of a call that never happened. Calls are guarded by the in-flight
 * tier below, which reads the outcome's real state instead.
 */
const SEED_DURABLE = new Set([
  "send_agent_message", "send_whatsapp_message", "send_document",
  "send_patient_document", "order_food", "book_ride", "book_movie_tickets",
  "collect_payment",
]);

const SEED_UNATTENDED = new Set([
    "collect_payment", "book_by_calling_business", "forget_memory",
    "arrange_meeting_with",
  ]);

/* ------------------------------------------------------------------ */
/* THE SEALED UNION — seeds ∪ what the tools declared                   */
/*                                                                     */
/* The five sets above are SEEDS: they govern the tools that have not   */
/* yet declared `effects`, which on the day this landed was all of them.*/
/* seal() recomputes the union from the live registry, so a tool that   */
/* declares its own effects no longer needs a human to remember to add  */
/* its name in five places — and drift() fails the boot if a seed names */
/* a tool that does not exist, which is how a missing memory gate stood */
/* unnoticed in production.                                             */
/*                                                                     */
/* Starts as a copy of the seeds so the registry is correct BEFORE      */
/* seal() runs: a require-order accident must not silently disarm every */
/* gate at once.                                                        */
/* ------------------------------------------------------------------ */
const EFFECTIVE = {
  world: new Set(SEED_WORLD),
  memoryWrites: new Set(SEED_MEMORY),
  repeatGuarded: new Set(SEED_REPEAT),
  durableGuarded: new Set(SEED_DURABLE),
  unattendedBlocked: new Set(SEED_UNATTENDED),
  byOutcome: new Set(),
};

const SEEDS = {
  WORLD_ACTIONS: SEED_WORLD,
  MEMORY_WRITES: SEED_MEMORY,
  REPEAT_GUARDED: SEED_REPEAT,
  DURABLE_GUARDED: SEED_DURABLE,
  UNATTENDED_BLOCKED: SEED_UNATTENDED,
};

let sealed = null;

/**
 * Recompute the union and report drift. Call once after all tools are
 * registered (server.js does, right after registerBuiltins). Idempotent,
 * and safe to call again after MCP tools arrive.
 *
 * @param {object} o
 * @param {boolean} o.strict  throw on a phantom instead of warning.
 *   Defaults on outside production so a typo fails a test run, and warns
 *   in production so a bad deploy degrades rather than refusing to boot.
 * @returns {{phantoms:Array, contradictions:Array, counts:object}}
 */
function seal({ strict = process.env.NODE_ENV !== "production" } = {}) {
  const tools = list();
  const registeredNames = new Set(tools.map((t) => t.name));
  const derived = contract.derive(tools);

  for (const [key, set] of Object.entries(derived)) {
    if (!EFFECTIVE[key]) continue;
    for (const n of set) EFFECTIVE[key].add(n);
  }

  const report = contract.drift({ registeredNames, seedLists: SEEDS, derived });

  // A phantom is a protection that silently applies to nothing.
  if (report.phantoms.length) {
    const lines = report.phantoms.map((p) => `${p.list} names "${p.name}", which is not a registered tool`);
    const msg = "tool contract drift — a safety list protects nothing:\n  " + lines.join("\n  ");
    if (strict) throw new Error(msg);
    console.error("WARNING: " + msg);
  }
  if (report.contradictions.length) {
    console.warn(
      "tool contract: " + report.contradictions.length +
      " tool(s) declare membership a seed list does not list (the union covers it): " +
      report.contradictions.map((c) => `${c.name}→${c.list}`).join(", ")
    );
  }

  sealed = {
    ...report,
    counts: Object.fromEntries(Object.entries(EFFECTIVE).map(([k, v]) => [k, v.size])),
    tools: tools.length,
  };
  return sealed;
}

/** What seal() concluded, for the admin panel and the tests. */
function contractReport() {
  return sealed;
}

/**
 * Everything the registry knows about one tool, in a shape safe to render.
 * This is the discovery surface a planner needs: it can read what a tool
 * costs, what it needs configured, whether it may be retried and whether it
 * must be confirmed, without importing the registry's internals.
 */
function describe(name) {
  const t = get(name);
  if (!t) return null;
  return {
    name: t.name,
    description: t.description || "",
    risk: t.risk || "low",
    effects: t.effects,
    declaredEffects: t.declaredEffects,
    // THE EFFECTIVE POLICY, not the contract default. For a legacy tool
    // (no declared effects) the seed lists are what actually govern it, so
    // reporting `dedupe: "never"` for place_phone_call — which is in fact
    // guarded by outcome and by repeat — would be a lie to whatever reads
    // this next, which is exactly the class of bug the contract exists to
    // end.
    dedupe: EFFECTIVE.byOutcome.has(t.name) || CALL_TOOLS.has(t.name)
      ? "by-outcome"
      : EFFECTIVE.durableGuarded.has(t.name)
        ? "durable"
        : EFFECTIVE.repeatGuarded.has(t.name)
          ? "per-turn"
          : t.declaredEffects ? t.dedupe : "never",
    declaredDedupe: t.dedupe,
    unattendedEffective: !EFFECTIVE.unattendedBlocked.has(t.name),
    deviceAction: !!t.deviceAction,
    requires: t.requires,
    timeoutMs: t.timeoutMs,
    retry: t.retry,
    unattended: t.unattended,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema || null,
    world: EFFECTIVE.world.has(t.name),
    memoryWrite: EFFECTIVE.memoryWrites.has(t.name),
    confirmable: typeof t.confirmSummary === "function",
    source: t.source || "builtin",
  };
}

/** The whole catalogue, for the admin panel and for tool-discovery. */
function catalogue() {
  return list().map((t) => describe(t.name));
}

/** Tools that put a call on a line — guarded by outcome, not by clock. */
const CALL_TOOLS = new Set(["place_phone_call", "book_by_calling_business"]);

async function execute(name, rawArgs, ctx = {}) {
  const tool = get(name);
  if (!tool) return { ok: false, error: `unknown tool "${name}"` };

  // ── GATE 0: REMEMBER WHAT THEY SAID, NOT WHAT YOU INFERRED ────────
  //
  // "Tell me the times. And the price." — a question about flights —
  // came back having also written `remember_fact: "prefers speaking
  // English, not Hindi"` and rewritten the profile's language. Nothing in
  // the turn said anything of the kind. The model had two contradictory
  // language facts in its injected memory and decided to tidy them up
  // mid-turn, which is memory acting as its own instruction: the one
  // thing this architecture is supposed to prevent.
  //
  // A memory WRITE must be grounded in the words just spoken. The test is
  // deliberately crude — does the thing being recorded share any real
  // word with what the user just said — because the failure it catches is
  // not subtle. "I'm vegetarian" → "is vegetarian" passes. A flight
  // question producing a claim about language does not.
  if (EFFECTIVE.memoryWrites.has(name) && !ctx.approved) {
    const turnText = String(
      (ctx.session && ctx.session.turn && ctx.session.turn.text) || ctx.intent || ""
    );
    if (turnText.trim()) {
      const words = (t) =>
        new Set(
          String(t).toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, " ")
            .split(/\s+/)
            .filter((w) => w.length >= 4 && !MEM_STOP.has(w))
        );
      const said = words(turnText);
      const writing = words(
        Object.values(rawArgs || {})
          .filter((v) => typeof v === "string" || typeof v === "number")
          .join(" ")
      );
      const overlap = [...writing].some((w) => said.has(w));
      // An explicit instruction to remember is always honoured, even when
      // the wording shares nothing ("note that down for me").
      const askedToRemember =
        /\b(remember|note that|make a note|save that|don'?t forget|my name is|call me)\b/i
          .test(turnText);
      if (writing.size && !overlap && !askedToRemember) {
        noteDecision(name, rawArgs, ctx, "refused",
          `nothing in "${turnText.slice(0, 60)}" says this`);
        return {
          ok: false,
          error: "not_in_this_turn",
          data: {
            heard: turnText.slice(0, 120),
            hint:
              "Do NOT record this: the user did not say it in this turn, and " +
              "a fact you inferred from an earlier conversation is not theirs " +
              "to have written down. Answer what they actually asked. If a " +
              "remembered fact looks wrong, say so and ask — never correct it " +
              "silently mid-turn.",
          },
        };
      }
    }
  }

  // ── GATE 1: DO NOT ACT ON WHAT WE DID NOT HEAR ────────────────────
  // The model, handed a fragment like "con" or a bare phone number, will
  // helpfully complete it from the previous turn — and place a call the
  // user never asked for. Input quality is judged before the turn
  // (src/agents/inputQuality.js) and carried on ctx; a world action on a
  // garbled turn is refused outright, and the model is told to ask.
  if (isWorldAction(name) && ctx.inputQuality && ctx.inputQuality.quality !== "clear") {
    const quality = ctx.inputQuality.quality;
    if (quality === "garbled" || !ctx.approved) {
      // OBSERVABLE REFUSAL. Declining to act used to leave no trace at
      // all — no row, no audit line, not even a log entry — so "it
      // ignored me", "it asked me to repeat myself" and "it said it was
      // already doing that" were indistinguishable afterwards.
      // rawArgs, not args: GATE 1 runs before coercion, deliberately —
      // nothing about a garbled turn should reach a tool's schema.
      noteDecision(name, rawArgs, ctx, "refused",
        `input ${ctx.inputQuality.reason || quality}: "${ctx.inputQuality.heard || ""}"`);
      return {
        ok: false,
        error: "unclear_request",
        data: {
          heard: ctx.inputQuality.heard || "",
          reason: ctx.inputQuality.reason || "the last thing said was not clear",
          hint:
            "Do NOT guess what was meant and do NOT reuse the subject of an " +
            "earlier request. Ask the user to say it again, in one short line.",
        },
      };
    }
  }

  // Defence in depth: even if a name were guessed, an MCP tool may only be
  // run by the user whose server provides it.
  if (tool.source === "mcp" && Number(tool.userId) !== Number(ctx.userId)) {
    return { ok: false, error: `unknown tool "${name}"` };
  }

  // ── REQUIREMENTS, BEFORE ANYTHING ELSE ────────────────────────────
  // A tool whose credential is absent must not be able to pretend. This is
  // the one place that decides, and it names the missing variable for the
  // operator while telling the model to give the USER a plain sentence and
  // no homework. Legacy tools declare nothing here and are unaffected.
  if (tool.requires && tool.requires.length) {
    const verdict = await capabilities.resolve(tool, {
      userId: ctx.userId, deviceCaps: ctx.deviceCaps, platform: ctx.platform,
    });
    if (!verdict.available) {
      const res = capabilities.unavailable(verdict.blockers);
      const opDetail = res.data && res.data.operatorDetail;
      if (opDetail) console.warn(`tool ${name} unavailable — ${opDetail}`);
      noteDecision(name, rawArgs, ctx, "refused",
        verdict.blockers.map((b) => b.reason).join("; ").slice(0, 300));
      res.status = contract.OUTCOME.FAILED;
      return res;
    }
  }

  const args = coerceArgs(tool, rawArgs);
  const missing = missingRequired(tool, args);
  if (missing.length) return { ok: false, needsArgs: missing, status: contract.OUTCOME.NEEDS_USER };

  // High-risk actions need explicit approval unless it has already been
  // granted for THIS call (the confirm endpoint replays with approved:true).
  // A background (scheduled) run carries approved:true because the user
  // consented when they scheduled it — but that consent covers the TASK,
  // not open-ended access to every dangerous tool. Money, third-party
  // business calls and memory deletion stay human-attended, always.
  // (hoisted to module scope as SEED_UNATTENDED so it can be sealed)

  if (ctx.background && EFFECTIVE.unattendedBlocked.has(name)) {
    return {
      ok: false,
      error:
        "this action cannot run unattended in a scheduled task — tell the " +
        "user to do it live in a conversation",
    };
  }

  if (tool.risk === "high" && !ctx.approved) {
    let confirmArgs = args;

    // RESOLVE BEFORE ASKING.
    //
    // Some high-risk actions only become reviewable once we have looked
    // something up. "Call Apollo Clinic and book me in" is not a decision
    // the user can actually make: there are four Apollo Clinics nearby and
    // Hari is about to phone one of them. They need the branch, the
    // address and the number in front of them.
    //
    // prepare() also PINS the result. Without it the lookup would run
    // after approval, so the business that was approved and the business
    // that gets called could be different ones.
    if (typeof tool.prepare === "function") {
      try {
        const prep = await tool.prepare(args, ctx);
        // A tool may refuse here — "no number found" is a dead end, and
        // asking the user to approve a call we cannot place is worse than
        // telling them plainly.
        if (prep && prep.error) return { ok: false, error: prep.error };
        if (prep && prep.args) confirmArgs = { ...args, ...prep.args };
        if (prep && prep.summary) {
          return {
            ok: false,
            needsConfirmation: true,
            tool: name,
            args: confirmArgs,
            summary: prep.summary,
          };
        }
      } catch (e) {
        return {
          ok: false,
          error: String((e && e.message) || e).slice(0, 200),
        };
      }
    }

    return {
      ok: false,
      needsConfirmation: true,
      tool: name,
      args: confirmArgs,
      summary: tool.confirmSummary ? tool.confirmSummary(confirmArgs, ctx) : name,
    };
  }

  // ── GATE 2: THE SAME REQUEST, TWICE ───────────────────────────────
  // Testers saw one "Call Dikshit Pujari" answered three different ways in
  // forty seconds, because each repetition took a different path.
  //
  // Three tiers, in order of authority: what the world is actually doing
  // right now, what this socket did a breath ago, and what any surface did
  // in the last three-quarters of a minute.
  //
  // A suppressed action is pushed into the session's executed list before
  // returning. Without that, claimCheck sees no tool for this turn and
  // rewrites the reply into "I couldn't start that call — nothing was
  // dialled" about a call that is, at that moment, ringing.
  if (ctx.userId && !ctx.background && isWorldAction(name)) {
    const store = require("../actions/store");
    const target = store.targetOf(name, args);

    const suppress = (data, note) => {
      try {
        if (ctx.session) {
          require("../agents/sessionState").noteSuppressed(ctx.session, {
            turnId: ctx.turnId,
            tool: name,
            args,
          });
        }
      } catch (_) {}
      noteDecision(name, args, ctx, "suppressed", note);
      return { ok: true, repeated: true, data, speak: "", note };
    };

    // An action we cannot identify a target for is never a known repeat —
    // matching on an empty target would collapse every order, every ride
    // and every untargeted message onto one another.
    if (target) {
      // TIER 1 — A CALL ALREADY ON THE LINE. This outranks everything and
      // runs even on the approved path: confirming the same call twice, on
      // two surfaces, is exactly the failure. Time does not decide it; the
      // task's own status does.
      if (CALL_TOOLS.has(name) || EFFECTIVE.byOutcome.has(name)) {
        try {
          const live = await require("../outcomes/store").findInFlight(
            ctx.userId, ["call", "agent_call"], target
          );
          if (live) {
            return suppress(
              { inFlight: true, tool: name, target, status: live.status },
              `A call to "${target}" is already ${live.status} — it was started ` +
              "moments ago and has not finished. Do NOT dial again. Tell the " +
              "user it is already going through, or ask if they want it cancelled."
            );
          }
        } catch (e) {
          console.warn("in-flight check failed:", e.message);
        }
      }

      // The remaining tiers are about a REQUEST repeating. An approved
      // replay is the same request continuing, so it passes through.
      if (!ctx.approved && EFFECTIVE.repeatGuarded.has(name)) {
        // TIER 2 — SAME BREATH, SAME SOCKET. The session's own list is in
        // memory and therefore instantaneous; the durable record below is
        // written fire-and-forget and would not yet exist for two calls
        // milliseconds apart.
        const twin = ((ctx.session && ctx.session.executed) || [])
          .filter((e) => e.tool === name && e.target === target && Date.now() - e.at < 20_000)
          .pop();
        if (twin && twin.ok) {
          return suppress(
            { alreadyDone: true, tool: name, target, at: twin.at },
            `${name} for "${target}" already ran moments ago in this turn or the ` +
            "one before. Do NOT run it again; tell the user it is already under " +
            "way, or ask whether they want it repeated."
          );
        }

        // TIER 3 — ANY SURFACE, LAST 45 SECONDS. This is how one request
        // repeated across the live and voice paths got two different
        // answers. Only for things that have already left the device.
        if (EFFECTIVE.durableGuarded.has(name)) {
          try {
            const prior = await store.findRecent(ctx.userId, name, target, 45_000);
            if (prior && (prior.ok === 1 || prior.ok === true)) {
              return suppress(
                { alreadyDone: true, tool: name, target, at: Number(prior.created_at) },
                `${name} for "${target}" already ran moments ago. Do NOT run it ` +
                "again; tell the user it is already under way, or ask whether they " +
                "want it repeated."
              );
            }
          } catch (e) {
            console.warn("repeat check failed:", e.message);
          }
        }
      }
    }
  }

  const started = Date.now();
  const res = await runWithPolicy(tool, args, ctx);
  res.ms = Date.now() - started;
  // THE OUTCOME, recorded rather than inferred later. "Done" and "handed to
  // the phone and never heard about again" used to be the same value.
  res.status = contract.outcomeOf(res);
  audit(tool, args, res, ctx);
  recordExecution(name, args, res, ctx);
  return res;
}

/**
 * Run a tool under its declared execution policy: a deadline, and retries
 * where retrying cannot double the effect.
 *
 * TWO THINGS HERE ARE DELIBERATE AND EASY TO GET WRONG.
 *
 * 1. A TIMEOUT IS NOT A FAILURE — it is the end of our patience. We cannot
 *    cancel work already in flight, so for a tool whose effect leaves the
 *    system the honest answer is "we do not know whether that happened",
 *    not "it failed". Reporting a timed-out message send as a failure is
 *    how a user gets told nothing was sent and then sends it again.
 *
 * 2. RETRY IS OPT-IN, NEVER INFERRED. A legacy tool (no declared `retry`)
 *    gets exactly one attempt, so nothing changes for the tools that
 *    existed before this policy did. The contract already refuses to let a
 *    consequential tool declare a retry without asserting idempotency.
 */
async function runWithPolicy(tool, args, ctx) {
  const attempts = tool.retry ? tool.retry.attempts : 1;
  const backoff = tool.retry ? tool.retry.backoffMs : 0;
  let last = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let timer = null;
    try {
      const out = await Promise.race([
        Promise.resolve().then(() => tool.execute(args, ctx)),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Object.assign(new Error(`timed out after ${tool.timeoutMs} ms`), { timedOut: true })),
            tool.timeoutMs
          );
        }),
      ]);
      const res = out && typeof out === "object" ? out : { ok: true, data: out };
      // A tool that failed for a transient reason may be retried; one that
      // failed because the request was wrong may not.
      if (res.ok === false && attempt < attempts && isTransient(res.error)) {
        last = res;
        await sleep(backoff * attempt);
        continue;
      }
      if (attempt > 1) res.attempts = attempt;
      return res;
    } catch (e) {
      const timedOut = e && e.timedOut === true;
      if (timedOut && isWorldAction(tool.name)) {
        // Unknown, and said so. `partial` keeps it out of both "it worked"
        // and "it failed", and the note tells the model not to guess.
        return {
          ok: false,
          partial: true,
          error: `no answer within ${tool.timeoutMs} ms — it may still be happening`,
          timedOut: true,
          note:
            "We stopped waiting; we did NOT confirm this failed and we did not " +
            "confirm it succeeded. Tell the user you are not sure it went " +
            "through and offer to check, and do NOT repeat the action.",
        };
      }
      const res = {
        ok: false,
        error: String((e && e.message) || e).slice(0, 300),
        ...(timedOut ? { timedOut: true } : {}),
      };
      if (attempt < attempts && (timedOut || isTransient(res.error))) {
        last = res;
        await sleep(backoff * attempt);
        continue;
      }
      if (attempt > 1) res.attempts = attempt;
      return res;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return last || { ok: false, error: "no attempt produced a result" };
}

/**
 * Is this failure worth another go? Conservative on purpose: an unrecognised
 * error is treated as permanent, because retrying a real error wastes the
 * user's time and a paid API call.
 */
function isTransient(error) {
  const e = String(error || "").toLowerCase();
  if (!e) return false;
  return /\b(429|500|502|503|504|econnreset|etimedout|enotfound|eai_again|socket hang up|fetch failed|network|temporarily|rate.?limit|overloaded|unavailable|timed out)\b/
    .test(e);
}

function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/**
 * THE EXECUTION RECORD. Session state holds what ran in this turn (the
 * claim checker's evidence); actions/store holds it durably (so "why did
 * settings open?" has an answer tomorrow). A tool that merely READS is
 * not worth recording — only actions that touch the world.
 */
/**
 * A decision NOT to run something — a gate refusing it, a repeat guard
 * swallowing it. It goes in the ledger beside the executions, marked so
 * the two are never confused, and never into the session's executed list
 * (only `suppress` adds there, and only because a suppressed action means
 * the real one is already under way).
 */
function noteDecision(name, args, ctx, decision, detail) {
  try {
    if (!ctx.userId) return;
    require("../actions/store").record(ctx.userId, {
      sessionId: ctx.sessionId || (ctx.session && ctx.session.sessionId) || "",
      turnId: ctx.turnId || "",
      tool: name,
      args,
      ok: decision !== "refused",
      decision,
      detail: String(detail || "").slice(0, 300),
      result: String(detail || "").slice(0, 600),
      surface: ctx.background ? "background" : ctx.source || (ctx.session && ctx.session.surface) || "",
      intent: ctx.intent || (ctx.session && ctx.session.turn && ctx.session.turn.text) || "",
      world: isWorldAction(name),
    });
  } catch (e) {
    console.warn("decision record failed:", e.message);
  }
}

function recordExecution(name, args, res, ctx) {
  try {
    if (!ctx.userId) return;
    const sessionState = require("../agents/sessionState");
    // A LOOKUP IS STILL AN EXECUTION. Only world actions belong in the
    // session's claim-checking list — a search does not make "I called
    // him" true — but every tool call belongs in the durable ledger, or
    // "why did you answer that?" has nothing to read.
    if (!isWorldAction(name)) {
      require("../actions/store").record(ctx.userId, {
        sessionId: ctx.sessionId || (ctx.session && ctx.session.sessionId) || "",
        turnId: ctx.turnId || "",
        tool: name,
        args,
        ok: res.ok !== false,
        detail: res.error || "",
        surface: ctx.background ? "background" : ctx.source || (ctx.session && ctx.session.surface) || "",
        intent: ctx.intent || (ctx.session && ctx.session.turn && ctx.session.turn.text) || "",
        result: res,
        ms: res.ms,
        world: false,
      });
      return;
    }
    if (ctx.session) {
      sessionState.recordExecution(ctx.session, {
        turnId: ctx.turnId,
        tool: name,
        args,
        ok: res.ok !== false,
        detail: res.error || (res.speak ? String(res.speak).slice(0, 160) : ""),
        result: res,
        ms: res.ms,
      });
      return;
    }
    // No session object (scheduled task, webhook) — still keep the durable
    // record, since those actions are exactly the ones users ask about.
    require("../actions/store").record(ctx.userId, {
      sessionId: ctx.sessionId || "",
      turnId: ctx.turnId || "",
      tool: name,
      args,
      ok: res.ok !== false,
      detail: res.error || "",
      surface: ctx.background ? "background" : ctx.source || "",
      intent: ctx.intent || "",
      result: res,
      ms: res.ms,
    });
  } catch (e) {
    console.warn("execution record failed:", e.message);
  }
}

/**
 * OBSERVABILITY + AUDIT (§23/§26). Every tool execution is timed, counted
 * and — for anything that changes state or reaches an external system —
 * written to the user-visible audit trail. Arguments are redacted before
 * logging: a tool call can carry credentials or private content.
 */
function audit(tool, args, res, ctx) {
  try {
    const obs = require("../infra/observability");
    obs.observe(`tool.${tool.name}`, res.ms || 0);
    obs.count(`tool.${tool.name}.${res.ok ? "ok" : "error"}`);
    obs.logger.info("tool", {
      tool: tool.name,
      source: tool.source || "builtin",
      risk: tool.risk,
      ok: res.ok !== false,
      ms: res.ms,
      uid: ctx.userId ?? null,
      // CORRELATION. In stdout a tool line could not be tied to the
      // request that caused it, nor to the other tools in the same turn —
      // that only existed in Postgres. These two make the log greppable.
      rid: ctx.rid || null,
      turn: ctx.turnId || null,
      args: obs.redact(args),
      error: res.error,
    });
    // Durable trail for anything consequential.
    if (ctx.userId && (tool.risk !== "low" || tool.source === "mcp")) {
      require("../audit/log")
        .record(
          ctx.userId,
          `tool.${tool.name}`,
          `${res.ok !== false ? "ok" : "failed"}${res.error ? ": " + res.error.slice(0, 80) : ""}`
        )
        .catch(() => {});
    }
  } catch (_) {
    // Auditing must never break a turn.
  }
}

module.exports = {
  limitsFor,
  limitsBlock,
  isWorldAction,
  WORLD_ACTIONS: SEED_WORLD,
  seal,
  contractReport,
  integrationStatus: capabilities.integrationStatus,
  resolveRequires: capabilities.resolve,
  describe,
  catalogue,
  EFFECTIVE,
  register,
  get,
  unregister,
  list,
  declarations,
  execute,
  coerceArgs,
  missingRequired,
  normalizeSchema,
  _clear: () => REGISTRY.clear(), // tests only
};
