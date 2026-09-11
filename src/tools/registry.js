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
  REGISTRY.set(tool.name, {
    risk: "low",
    deviceAction: false,
    inputSchema: { type: "object", properties: {} },
    ...tool,
  });
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
function declarations({ only = null, includeDeviceActions = true, userId = null } = {}) {
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
const WORLD_ACTIONS = new Set([
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
]);

function isWorldAction(name) {
  return WORLD_ACTIONS.has(name);
}

/**
 * REPEAT-GUARDED — the subset of world actions where doing it twice is
 * almost never what the user meant: a second call to the same person, a
 * second copy of the same message, a second order, the same app launched
 * again seconds later.
 *
 * Deliberately NOT everything in WORLD_ACTIONS. Reminders, alarms, ledger
 * entries and generated media are things a user legitimately repeats — two
 * reminders about "the meeting", two payments logged for one client — and
 * suppressing those would invent a bug in place of the one being fixed.
 */
const REPEAT_GUARDED = new Set([
  "place_phone_call", "book_by_calling_business", "send_agent_message",
  "send_whatsapp_message", "send_document", "send_patient_document",
  "arrange_meeting_with", "order_food", "book_ride", "book_movie_tickets",
  "collect_payment", "open_app", "open_webpage", "open_service_app",
  "start_navigation", "play_music",
]);

async function execute(name, rawArgs, ctx = {}) {
  const tool = get(name);
  if (!tool) return { ok: false, error: `unknown tool "${name}"` };

  // ── GATE 1: DO NOT ACT ON WHAT WE DID NOT HEAR ────────────────────
  // The model, handed a fragment like "con" or a bare phone number, will
  // helpfully complete it from the previous turn — and place a call the
  // user never asked for. Input quality is judged before the turn
  // (src/agents/inputQuality.js) and carried on ctx; a world action on a
  // garbled turn is refused outright, and the model is told to ask.
  if (isWorldAction(name) && ctx.inputQuality && ctx.inputQuality.quality !== "clear") {
    const quality = ctx.inputQuality.quality;
    if (quality === "garbled" || !ctx.approved) {
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

  const args = coerceArgs(tool, rawArgs);
  const missing = missingRequired(tool, args);
  if (missing.length) return { ok: false, needsArgs: missing };

  // High-risk actions need explicit approval unless it has already been
  // granted for THIS call (the confirm endpoint replays with approved:true).
  // A background (scheduled) run carries approved:true because the user
  // consented when they scheduled it — but that consent covers the TASK,
  // not open-ended access to every dangerous tool. Money, third-party
  // business calls and memory deletion stay human-attended, always.
  const UNATTENDED_BLOCKED = new Set([
    "collect_payment", "book_by_calling_business", "forget_memory",
    "arrange_meeting_with",
  ]);
  if (ctx.background && UNATTENDED_BLOCKED.has(name)) {
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

  // ── GATE 2: THE SAME ACTION TWICE IN A BREATH ─────────────────────
  // Testers saw one "Call Dikshit Pujari" answered three different ways in
  // forty seconds, because each repetition took a different path. A repeat
  // of the same world action on the same target inside the repeat window
  // returns what happened the FIRST time instead of racing it again.
  if (REPEAT_GUARDED.has(name) && ctx.userId && !ctx.approved && !ctx.background) {
    const store = require("../actions/store");
    const target = store.targetOf(name, args);

    // A CALL ALREADY IN FLIGHT outranks everything: the phone or the relay
    // is mid-dial to this very person. Time does not decide this — the
    // task's own state does.
    if (["place_phone_call", "book_by_calling_business"].includes(name)) {
      try {
        const live = await require("../outcomes/store").findInFlight(
          ctx.userId, "call", target
        );
        const relay = live || (await require("../outcomes/store").findInFlight(
          ctx.userId, "agent_call", target
        ));
        if (relay) {
          return {
            ok: true,
            repeated: true,
            data: { inFlight: true, tool: name, target, status: relay.status },
            speak: "",
            note:
              `A call to "${target}" is already ${relay.status} — it was started ` +
              "moments ago and has not finished. Do NOT dial again. Tell the " +
              "user it is already going through, or ask if they want it cancelled.",
          };
        }
      } catch (e) {
        console.warn("in-flight check failed:", e.message);
      }
    }

    // SAME BREATH, SAME SOCKET. The session's own list is in memory and
    // therefore instantaneous; the durable record below is written
    // fire-and-forget and would not yet exist for two calls milliseconds
    // apart. Both tiers are needed — this one catches the double-fire, the
    // next catches the repeat that arrives on a different surface.
    const session = ctx.session || null;
    if (session) {
      const twin = (session.executed || [])
        .filter((e) => e.tool === name && e.target === target && Date.now() - e.at < 20_000)
        .pop();
      if (twin && twin.ok) {
        return {
          ok: true,
          repeated: true,
          data: { alreadyDone: true, tool: name, target, at: twin.at },
          speak: "",
          note:
            `${name} for "${target}" already ran moments ago in this turn or the ` +
            "one before. Do NOT run it again; tell the user it is already under " +
            "way, or ask whether they want it repeated.",
        };
      }
    }

    // Otherwise: the same action on the same target already ran for this
    // user recently — on ANY surface, not just this socket, which is how
    // one request repeated across the live and voice paths got two
    // different answers.
    try {
      const prior = await store.findRecent(ctx.userId, name, target, 45_000);
      if (prior && (prior.ok === 1 || prior.ok === true)) {
        return {
          ok: true,
          repeated: true,
          data: { alreadyDone: true, tool: name, target, at: Number(prior.created_at) },
          speak: "",
          note:
            `${name} for "${target}" already ran moments ago. Do NOT run it ` +
            "again; tell the user it is already under way, or ask whether they " +
            "want it repeated.",
        };
      }
    } catch (e) {
      console.warn("repeat check failed:", e.message);
    }
  }

  const started = Date.now();
  try {
    const out = await tool.execute(args, ctx);
    const res = out && typeof out === "object" ? out : { ok: true, data: out };
    res.ms = Date.now() - started;
    audit(tool, args, res, ctx);
    recordExecution(name, args, res, ctx);
    return res;
  } catch (e) {
    // §28: report the actual failure; never fabricate success.
    const res = {
      ok: false,
      error: String((e && e.message) || e).slice(0, 300),
      ms: Date.now() - started,
    };
    audit(tool, args, res, ctx);
    recordExecution(name, args, res, ctx);
    return res;
  }
}

/**
 * THE EXECUTION RECORD. Session state holds what ran in this turn (the
 * claim checker's evidence); actions/store holds it durably (so "why did
 * settings open?" has an answer tomorrow). A tool that merely READS is
 * not worth recording — only actions that touch the world.
 */
function recordExecution(name, args, res, ctx) {
  try {
    if (!ctx.userId || !isWorldAction(name)) return;
    const sessionState = require("../agents/sessionState");
    if (ctx.session) {
      sessionState.recordExecution(ctx.session, {
        turnId: ctx.turnId,
        tool: name,
        args,
        ok: res.ok !== false,
        detail: res.error || (res.speak ? String(res.speak).slice(0, 160) : ""),
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
  isWorldAction,
  WORLD_ACTIONS,
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
