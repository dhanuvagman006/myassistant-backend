/**
 * CAPABILITY RESOLUTION — can this tool actually run, for this user, on
 * this phone, right now?
 * ----------------------------------------------------------------------
 * WHY. Before this, a tool could express exactly two requirements: one
 * Android permission string and a minimum app build. Every other kind of
 * prerequisite was hand-coded inside the tool, and the result was visible
 * in three separate ways:
 *
 *   • `if (!ctx.userId) return {ok:false, error:"not signed in"}` appeared
 *     in roughly sixty tools, identically.
 *   • The four Google Calendar tools each re-checked `googleLinked()` and
 *     each returned the same NOT_LINKED constant, so the model discovered
 *     the integration was missing only by calling the tool and failing.
 *   • `limitsBlock()` — the paragraph that tells the user what their phone
 *     cannot do — could describe almost nothing, because only seven tools
 *     declared a permission and exactly one declared an app build.
 *
 * The fix is a single `requires: [{kind, id, when}]` list on the tool,
 * resolved HERE, once per turn. Two things then follow for free: the model
 * is never offered a tool that cannot run (so it reaches for one that
 * can), and when it is withheld there is a sentence saying why.
 *
 * THIS IS ALSO THE "NEVER FAKE AN INTEGRATION" MECHANISM. A tool whose
 * credential is absent is not offered and, if called anyway, returns an
 * honest `integration_unavailable` naming the exact environment variable
 * an operator must set. Nothing returns a fabricated success.
 */

/* ------------------------------------------------------------------ */
/* INTEGRATIONS — one entry per third party the tools depend on        */
/*                                                                     */
/* `ready` must be cheap and synchronous where possible: it runs for    */
/* every tool on every turn. Anything needing a database round trip     */
/* declares `readyAsync` and is resolved only when that tool is         */
/* actually about to be offered or called.                             */
/* ------------------------------------------------------------------ */

const INTEGRATIONS = {
  gemini: {
    label: "Google Gemini",
    env: ["GEMINI_API_KEY"],
    why: "the language, vision and speech models run on it",
  },
  google_oauth: {
    label: "Google account",
    // Not an env var — a per-user OAuth link, so this is resolved per user.
    perUser: true,
    async readyAsync(userId) {
      if (!userId) return false;
      try {
        return Boolean(await require("../google/tokens").accessToken(userId));
      } catch (_) {
        return false;
      }
    },
    why: "their Google account is not connected",
    fix: "offer to connect it in Settings",
  },
  razorpay: {
    label: "Razorpay",
    env: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"],
    why: "collecting a payment needs the payment gateway configured",
  },
  plivo: {
    label: "Plivo",
    env: ["PLIVO_AUTH_ID", "PLIVO_AUTH_TOKEN", "PLIVO_FROM_NUMBER"],
    why: "placing a call on the user's behalf needs the telephony provider configured",
  },
  places: {
    label: "Google Places",
    env: ["GOOGLE_PLACES_API_KEY"],
    why: "finding a business needs the Places API configured",
  },
  image_edit: {
    label: "an image-editing model",
    // Any ONE of these is enough, which `anyEnv` expresses and `env` cannot.
    anyEnv: ["GEMINI_API_KEY", "FASHN_API_KEY", "VERTEX_PROJECT_ID"],
    why: "editing a photo needs an image model that accepts a photo as input",
  },
  youtube: {
    label: "YouTube Data API",
    env: ["YOUTUBE_API_KEY"],
    why: "searching YouTube needs the Data API configured",
  },
  avatar: {
    label: "a talking-avatar provider",
    anyEnv: ["HEYGEN_API_KEY", "BEY_API_KEY", "SIMLI_FACE_ID", "TAVUS_API_KEY"],
    why: "a video avatar needs a provider configured",
  },
};

/** True when every env var an integration needs carries a non-empty value. */
function envReady(spec) {
  if (Array.isArray(spec.anyEnv)) {
    return spec.anyEnv.some((k) => String(process.env[k] || "").trim() !== "");
  }
  if (Array.isArray(spec.env)) {
    return spec.env.every((k) => String(process.env[k] || "").trim() !== "");
  }
  return true;
}

/** Which variables are missing — named exactly, for the operator. */
function missingEnv(spec) {
  if (Array.isArray(spec.anyEnv)) {
    return envReady(spec) ? [] : [spec.anyEnv.join(" or ")];
  }
  return (spec.env || []).filter((k) => String(process.env[k] || "").trim() === "");
}

/**
 * Synchronous integration check. Returns null when the answer needs a
 * database round trip, so the caller knows to resolve it asynchronously.
 */
function integrationReadySync(id) {
  const spec = INTEGRATIONS[id];
  if (!spec) return true; // an unknown integration id never blocks a tool
  if (spec.perUser) return null;
  return envReady(spec);
}

async function integrationReady(id, userId) {
  const spec = INTEGRATIONS[id];
  if (!spec) return true;
  if (spec.perUser) return spec.readyAsync ? await spec.readyAsync(userId) : false;
  return envReady(spec);
}

/* ------------------------------------------------------------------ */
/* RESOLUTION                                                          */
/* ------------------------------------------------------------------ */

/**
 * Evaluate one requirement against the turn's context.
 * Returns null when satisfied, otherwise {kind, id, reason, audience}.
 *
 * `audience` matters: "you have not granted contacts permission" is for
 * the USER, and "RAZORPAY_KEY_SECRET is not set" is for the OPERATOR. The
 * two must never be shown to the wrong one — telling a user to set an
 * environment variable is the kind of homework this product does not give.
 */
function checkOne(req, { userId, deviceCaps, platform }) {
  switch (req.kind) {
    case "auth":
      return userId ? null : {
        kind: "auth", id: null, audience: "user",
        reason: "this needs them signed in",
      };

    case "app_build": {
      if (!deviceCaps) return null; // an app that reports nothing is not assumed old
      const need = Number(req.id);
      const have = Number(deviceCaps.build || 0);
      // An app that reports NO build is treated as too old, which is what
      // the filter this replaces did. The asymmetry with os_permission
      // below is deliberate: a missing permission report means "unknown,
      // so do not take abilities away", but a missing build report means
      // the app predates build reporting — i.e. it really is too old.
      if (have >= need) return null;
      return {
        kind: "app_build", id: req.id, audience: "user",
        reason: `their app is build ${have} and this needs ${need} or newer`,
      };
    }

    case "os_permission": {
      if (!deviceCaps) return null;
      const granted = new Set(deviceCaps.granted || []);
      const denied = new Set(deviceCaps.denied || []);
      // Only a KNOWN denial blocks. An unreported permission must not
      // silently remove half the assistant's abilities.
      if (denied.has(req.id) && !granted.has(req.id)) {
        return {
          kind: "os_permission", id: req.id, audience: "user",
          reason: `${req.id} permission is switched off on their phone`,
        };
      }
      return null;
    }

    case "device_capability": {
      if (!deviceCaps) return null;
      const caps = deviceCaps.capabilities || deviceCaps.caps || {};
      if (caps[req.id] === false) {
        return {
          kind: "device_capability", id: req.id, audience: "user",
          reason: `their phone cannot do ${req.id}`,
        };
      }
      return null;
    }

    case "platform": {
      const p = platform || deviceCaps?.platform || null;
      if (!p || p === req.id) return null;
      return {
        kind: "platform", id: req.id, audience: "user",
        reason: `this only works on ${req.id}`,
      };
    }

    case "integration": {
      const ready = integrationReadySync(req.id);
      if (ready === null) return { deferred: true, kind: "integration", id: req.id };
      if (ready) return null;
      const spec = INTEGRATIONS[req.id] || {};
      return {
        kind: "integration", id: req.id, audience: "operator",
        reason: spec.why || `${req.id} is not configured`,
        missing: missingEnv(spec),
        label: spec.label || req.id,
      };
    }

    default:
      return null;
  }
}

/**
 * SYNCHRONOUS resolution, used by declarations() — which runs for every
 * tool on every turn and cannot afford a query per tool.
 *
 * A per-user integration (Google OAuth) resolves to `deferred`. Deferred
 * requirements do NOT hide the tool: withholding the calendar from someone
 * whose link we have not checked would be worse than letting the call
 * return an honest "not connected". They are resolved properly in
 * resolve() before execution.
 */
function resolveSync(tool, ctx = {}) {
  const blockers = [];
  const deferred = [];
  for (const req of tool.requires || []) {
    // AUTH NEVER HIDES A TOOL FROM THE DECLARATIONS. Every tool needs a
    // signed-in user, so filtering on it would be noise the model cannot
    // act on — and it would silently shrink the tool set for any caller
    // that omits userId, which is how declaring it on the four calendar
    // tools dropped them out of the boot count. It is enforced at
    // execution instead, where it belongs.
    if (req.kind === "auth" && ctx.forDeclaration) continue;
    if (req.when && typeof req.when === "function") {
      try { if (!req.when(ctx)) continue; } catch (_) { continue; }
    }
    const bad = checkOne(req, ctx);
    if (!bad) continue;
    if (bad.deferred) deferred.push(bad);
    else blockers.push(bad);
  }
  return { available: blockers.length === 0, blockers, deferred };
}

/** Full resolution, including anything that needed a database read. */
async function resolve(tool, ctx = {}) {
  const sync = resolveSync(tool, ctx);
  const blockers = [...sync.blockers];
  for (const d of sync.deferred) {
    const ok = await integrationReady(d.id, ctx.userId);
    if (ok) continue;
    const spec = INTEGRATIONS[d.id] || {};
    blockers.push({
      kind: "integration", id: d.id, audience: spec.perUser ? "user" : "operator",
      reason: spec.why || `${d.id} is not configured`,
      fix: spec.fix || "",
      missing: spec.perUser ? [] : missingEnv(spec),
      label: spec.label || d.id,
    });
  }
  return { available: blockers.length === 0, blockers };
}

/**
 * The envelope a tool returns when a requirement is not met. Written for
 * the MODEL to read, and deliberately different for the two audiences:
 *  • a user-side gap gets a plain sentence and an offer to fix it;
 *  • an operator-side gap must never become the user's homework, so the
 *    model is told to say it is not set up and to stop there.
 */
function unavailable(blockers) {
  const user = blockers.filter((b) => b.audience === "user");
  const op = blockers.filter((b) => b.audience === "operator");
  if (user.length) {
    const b = user[0];
    return {
      ok: false,
      error: b.kind === "integration" ? "integration_unavailable" : "requirement_not_met",
      data: {
        requirement: b.kind,
        id: b.id,
        hint:
          `Cannot do this: ${b.reason}. Say that plainly in one line` +
          (b.fix ? ` and ${b.fix}` : "") +
          ". Do NOT invent a result, and do NOT describe what you would " +
          "have found.",
      },
    };
  }
  const b = op[0];
  return {
    ok: false,
    error: "integration_unavailable",
    data: {
      requirement: "integration",
      id: b.id,
      // The operator detail is kept OUT of the hint the model speaks from.
      operatorDetail: `${b.label}: set ${(b.missing || []).join(", ") || "the required credentials"}`,
      hint:
        `This is not set up on the server, so it cannot be done at all — ` +
        `${b.reason}. Tell the user plainly that you cannot do this one and ` +
        `offer something you CAN do. Do NOT tell them to configure anything, ` +
        `do NOT name a setting or an API key, and do NOT invent a result.`,
    },
  };
}

/** For the admin panel: which integrations this deployment can use. */
function integrationStatus() {
  return Object.entries(INTEGRATIONS).map(([id, spec]) => ({
    id,
    label: spec.label,
    perUser: !!spec.perUser,
    ready: spec.perUser ? null : envReady(spec),
    missing: spec.perUser ? [] : missingEnv(spec),
  }));
}

module.exports = {
  INTEGRATIONS,
  resolve, resolveSync, unavailable,
  integrationReady, integrationReadySync, integrationStatus,
  envReady, missingEnv,
};
