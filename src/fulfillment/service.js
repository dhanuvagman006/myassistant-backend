/**
 * FULFILLMENT SERVICE — the part that actually gets things done.
 *
 * Three execution paths, chosen by what the world genuinely allows:
 *
 *   call     Hari phones the business and negotiates. Real autonomy, and
 *            the only path that can end in a genuine 'confirmed' — because
 *            a human on the other end said yes. Used for appointments,
 *            table reservations and direct restaurant orders.
 *
 *   handoff  Hari resolves the exact target and deep-links the provider
 *            app; the user pays. Ends at 'handed_off', never 'confirmed'
 *            (see deeplinks.js for why no API path exists for Swiggy,
 *            BookMyShow, Uber & co).
 *
 *   api      a real partner integration. `PROVIDER_ADAPTERS` is the seam;
 *            it is deliberately empty, and an empty seam is honest where a
 *            mocked one is not.
 *
 * The rule every function here obeys: the ledger and the spoken sentence
 * must describe what REALLY happened. A call that nobody answered is a
 * call nobody answered.
 */
const places = require("../services/tools/places");
const agentCall = require("../agents/agentCall");
const store = require("./store");
const deeplinks = require("./deeplinks");

/**
 * Real provider APIs, when a partner key exists. Empty today — every
 * consumer platform we target (Swiggy, Zomato, BookMyShow, Ola) offers no
 * public ordering API, and Uber's Rides API is partner-gated. Register an
 * adapter here and the tools below will prefer it over a handoff.
 *
 *   PROVIDER_ADAPTERS.uber = {
 *     kind: "ride",
 *     available: () => Boolean(process.env.UBER_SERVER_TOKEN),
 *     async execute(task, ctx) { … return { ok, confirmation, outcome } },
 *   };
 */
const PROVIDER_ADAPTERS = Object.create(null);

function adapterFor(kind, provider) {
  const a = PROVIDER_ADAPTERS[provider];
  if (!a || a.kind !== kind) return null;
  try {
    return a.available() ? a : null;
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * RESOLUTION — turn "that biryani place near me" into a real business
 * ------------------------------------------------------------------ */

/**
 * Finds the business the user means, with a phone number where possible.
 * A phone number is what unlocks the `call` path, so we prefer a slightly
 * lower-rated place that we can actually ring over a better one we cannot.
 *
 * Returns null when nothing matches — the caller must then ask rather than
 * invent a venue.
 */
async function resolveBusiness({ query, lat, lng, requirePhone = false }) {
  if (!query) return null;
  let list = [];
  try {
    list = (await places.searchPlaces({ q: query, lat, lng })) || [];
  } catch (_) {
    return null;
  }
  if (!list.length) return null;

  if (requirePhone) {
    // This number is about to be DIALLED autonomously, so a near-enough
    // match is not acceptable. Results are distance-sorted, which means the
    // first callable place can easily be a different business entirely:
    // ask for a dentist whose number Google doesn't list and you would end
    // up phoning whoever happens to be nearest. Requiring the name to
    // actually match makes the failure "I couldn't find their number",
    // which is true, instead of a call to a stranger.
    const named = list.filter((p) => p.phone && nameMatches(query, p.name));
    return named[0] || null;
  }

  // Prefer callable, but only when it isn't a much worse match: the first
  // result is the best name match, so we only skip past it for a callable
  // place inside the top three.
  const callableNearTop = list.slice(0, 3).find((p) => p.phone);
  return callableNearTop || list[0];
}

/** Words too generic to identify a business on their own. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "of", "at", "in", "near", "me", "my",
  "clinic", "hospital", "restaurant", "salon", "centre", "center",
  "dr", "doctor", "cafe", "shop", "store", "hotel",
]);

function tokens(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Does this result plausibly refer to the business the user named?
 *
 * Every distinctive word the user gave must appear in the result's name.
 * "Apollo Clinic" matches "Apollo Clinic Indiranagar"; it does not match
 * "Manipal Hospital". When the user's phrase carries no distinctive word
 * at all ("the clinic"), nothing can be verified, so nothing matches —
 * Hari asks rather than guessing whose phone to ring.
 */
function nameMatches(query, name) {
  const q = tokens(query);
  if (!q.length) return false;
  const n = new Set(tokens(name));
  return q.every((w) => n.has(w));
}

/* ------------------------------------------------------------------ *
 * PATH: CALL — Hari rings the business herself
 * ------------------------------------------------------------------ */

/** Phrase the errand as a task the call-script writer can speak naturally. */
function callTaskFor({ kind, venue, when, partySize, items, purpose }) {
  const bits = [];
  if (kind === "table") {
    bits.push(`ask if they can hold a table for ${partySize || 2}`);
    if (when) bits.push(`at ${when}`);
  } else if (kind === "appointment") {
    bits.push(`ask for an appointment${purpose ? ` for ${purpose}` : ""}`);
    if (when) bits.push(`at ${when}`);
  } else if (kind === "food") {
    bits.push(`ask if they can take an order for ${items || "delivery"}`);
    if (when) bits.push(`for ${when}`);
  } else {
    bits.push(purpose || "ask about availability");
    if (when) bits.push(`at ${when}`);
  }
  return `Call ${venue} and ${bits.join(" ")}, then tell me exactly what they said.`;
}

/**
 * Starts a real phone call to a business and opens a ledger row for it.
 *
 * Throws nothing: returns a discriminated result so the tool layer can
 * speak the truth in every branch.
 *   { ok:true, task, callId }
 *   { ok:false, reason:"telephony" | "no_phone" | "quota" | "failed", … }
 */
async function startCallBooking({
  userId, userName, kind, venue, phone, when, whenMs, partySize, items, purpose, lang,
}) {
  if (!agentCall.enabled()) return { ok: false, reason: "telephony" };
  if (!phone) return { ok: false, reason: "no_phone" };

  const task = callTaskFor({ kind, venue, when, partySize, items, purpose });

  // Ledger FIRST, so a crash mid-call still leaves a traceable errand.
  const row = await store.create(userId, {
    kind,
    provider: "phone",
    path: "call",
    title: `${labelForKind(kind)} at ${venue}`,
    venue,
    phone,
    when_at: whenMs || null,
    party_size: partySize || null,
    details: { items: items || null, purpose: purpose || null, when: when || null },
    status: "calling",
  });

  try {
    const { id } = await agentCall.start({
      userId,
      userName,
      toNumber: phone,
      contactName: venue,
      task,
      lang: lang || null,
    });
    await store.update(row.id, { call_id: id });
    return { ok: true, task: { ...row, call_id: id }, callId: id };
  } catch (e) {
    const reason = e?.code === "quota" ? "quota" : "failed";
    await store.update(row.id, {
      status: "failed",
      outcome:
        reason === "quota"
          ? "Daily limit for calls placed on your behalf was reached."
          : `Could not start the call: ${String(e?.message || e).slice(0, 120)}`,
    });
    return { ok: false, reason, taskId: row.id };
  }
}

/**
 * Waits for a call to reach a terminal state and writes the TRUE outcome
 * to the ledger.
 *
 * `onStatus` is called with each state change so the SSE layer can keep the
 * user's screen honest while it rings. `isCancelled` lets a user hang up
 * the errand.
 */
async function awaitCallOutcome(taskId, callId, { onStatus, isCancelled, timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if (isCancelled && isCancelled()) {
      await store.update(taskId, { status: "cancelled", outcome: "You cancelled this while it was ringing." });
      return { state: "cancelled", result: null };
    }
    const st = agentCall.status(callId);
    if (!st) break; // record aged out of the in-memory store
    if (st.state !== last) {
      last = st.state;
      if (onStatus) onStatus(st.state);
    }
    if (st.state === "completed" || st.state === "no_answer" || st.state === "failed") {
      // 'completed' means the CALL completed, not that the booking was
      // agreed — the business's actual words are the outcome, and the
      // status reflects that distinction.
      await store.update(taskId, {
        status: st.state === "completed" ? "confirmed" : "failed",
        outcome: st.result || null,
      });
      return st;
    }
  }

  await store.update(taskId, {
    status: "failed",
    outcome: "The call didn't finish in time, so I can't tell you what they said.",
  });
  return { state: "timeout", result: null };
}

/* ------------------------------------------------------------------ *
 * PATH: HANDOFF — resolve the target, then open the provider app
 * ------------------------------------------------------------------ */

/**
 * Builds a handoff and records it. Returns { task, url, speak }.
 * `speak` always states that the user completes the payment step.
 */
async function handoff({ userId, kind, provider, link, title, venue, whenMs, details, what }) {
  const row = await store.create(userId, {
    kind,
    provider,
    path: "handoff",
    title,
    venue: venue || null,
    when_at: whenMs || null,
    details: details || {},
    deep_link: link.url,
    status: "handed_off",
    outcome: `Opened ${deeplinks.labelFor(provider)} (${link.note}). Payment is completed by you in the app.`,
  });
  return {
    task: row,
    url: link.url,
    speak: deeplinks.speakFor({
      precision: link.precision,
      providerLabel: deeplinks.labelFor(provider),
      what,
    }),
  };
}

function labelForKind(kind) {
  return (
    { food: "Order", ride: "Ride", movie: "Tickets", appointment: "Appointment", table: "Table" }[kind] ||
    "Task"
  );
}

module.exports = {
  PROVIDER_ADAPTERS,
  adapterFor,
  resolveBusiness,
  nameMatches,
  startCallBooking,
  awaitCallOutcome,
  handoff,
  callTaskFor,
  labelForKind,
};
