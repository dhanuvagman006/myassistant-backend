/**
 * SESSION STATE — one place that knows what is happening RIGHT NOW.
 * -----------------------------------------------------------------
 * The assistant used to keep its working state in four unrelated places:
 * the model's prompt (injected memory), the SSE session object
 * (pendingContactName, pending), the live socket's local variables, and
 * the model's own recollection. Nothing owned "what is the user asking
 * for in this turn", "who are we talking about", "what is waiting for a
 * yes", or "what has actually been done" — so those blurred into each
 * other. That is how "Hello." in a fresh session produced "you asked me
 * to call Jeevan", and how a garbled "con" dialled the previous
 * conversation's contact.
 *
 * Five kinds of state, deliberately separated:
 *   1. CURRENT TURN     — the words just spoken, and their quality.
 *   2. CONVERSATION      — this session's turns (context, never commands).
 *   3. REMEMBERED FACTS  — durable memory; injected as context only and
 *                          never treated as an instruction (elsewhere).
 *   4. PENDING ACTION    — something waiting on an explicit user yes.
 *                          A new session starts with NONE, always.
 *   5. EXECUTED ACTIONS  — what really ran (src/actions/store.js).
 *
 * Held in memory and keyed by session: a session is minutes long, and
 * anything that must outlive it (facts, reminders, the action log) has
 * its own durable home. Nothing here is ever inherited by a new session.
 */
const actions = require("../actions/store");

const SESSION_TTL_MS = 60 * 60 * 1000;
const PENDING_TTL_MS = 3 * 60 * 1000; // a yes must follow the question
const ENTITY_TTL_MS = 10 * 60 * 1000; // "her/him" only means someone recent

const sessions = new Map(); // key -> state

function key(userId, sessionId) {
  return `${Number(userId) || 0}:${String(sessionId || "")}`;
}

function gc() {
  const now = Date.now();
  for (const [k, s] of sessions) {
    if (now - s.touchedAt > SESSION_TTL_MS) sessions.delete(k);
  }
}

/**
 * Start (or fetch) the state for a session. A BRAND NEW session is born
 * with no pending action and no active entity — the guarantee that last
 * session's request can never execute in this one.
 */
function begin(userId, sessionId, { surface = "", appBuild = 0 } = {}) {
  gc();
  const k = key(userId, sessionId);
  const existing = sessions.get(k);
  if (existing) {
    existing.touchedAt = Date.now();
    return existing;
  }
  const state = {
    userId: Number(userId) || 0,
    sessionId: String(sessionId || ""),
    surface,
    appBuild,
    startedAt: Date.now(),
    touchedAt: Date.now(),
    turnCount: 0,
    // 1. current turn
    turn: null, // { id, text, quality, at }
    // 2. this session's exchanges (context only)
    turns: [], // { role, text, at }
    // 3. who we are talking about
    activeEntity: null, // { kind, name, phone, setAt, source }
    // 4. waiting on the user's yes
    pending: null, // { tool, args, summary, askedAt }
    // 5. what ran in THIS session (the durable log is in actions/store)
    executed: [], // { turnId, tool, target, ok, at }
  };
  sessions.set(k, state);
  return state;
}

function get(userId, sessionId) {
  const s = sessions.get(key(userId, sessionId));
  if (s) s.touchedAt = Date.now();
  return s || null;
}

/** Drop a session's working state (sign-out, account switch, socket close). */
function end(userId, sessionId) {
  sessions.delete(key(userId, sessionId));
}

/* ------------------------------------------------------------------ */
/* 1. CURRENT TURN                                                     */
/* ------------------------------------------------------------------ */

/**
 * Open a new turn. Anything that was pending and is not answered by this
 * turn expires here, so a stale "shall I call X?" cannot be revived by an
 * unrelated sentence three turns later.
 */
function beginTurn(state, { turnId, text, quality = "clear" }) {
  if (!state) return null;
  state.turnCount++;
  state.turn = { id: turnId, text: String(text || ""), quality, at: Date.now() };
  state.turns.push({ role: "user", text: state.turn.text, at: state.turn.at });
  if (state.turns.length > 40) state.turns.splice(0, state.turns.length - 40);
  if (state.pending && Date.now() - state.pending.askedAt > PENDING_TTL_MS) {
    state.pending = null;
  }
  if (state.activeEntity && Date.now() - state.activeEntity.setAt > ENTITY_TTL_MS) {
    state.activeEntity = null;
  }
  return state.turn;
}

function recordReply(state, text) {
  if (!state || !text) return;
  state.turns.push({ role: "assistant", text: String(text), at: Date.now() });
  if (state.turns.length > 40) state.turns.splice(0, state.turns.length - 40);
}

/* ------------------------------------------------------------------ */
/* 3. ACTIVE ENTITY — who "her", "him", "that number" refers to        */
/* ------------------------------------------------------------------ */

/**
 * Set (or REPLACE) the person the conversation is about. A correction
 * always replaces: "no, it's Yashmita" must not leave Ashmita active,
 * which is why this takes the whole entity rather than merging fields.
 */
function setEntity(state, entity) {
  if (!state || !entity || !entity.name) return null;
  state.activeEntity = {
    kind: entity.kind || "person",
    name: String(entity.name).trim().slice(0, 120),
    phone: entity.phone ? String(entity.phone).slice(0, 40) : null,
    id: entity.id ?? null,
    source: entity.source || "spoken",
    setAt: Date.now(),
  };
  return state.activeEntity;
}

function clearEntity(state) {
  if (state) state.activeEntity = null;
}

/** The entity a pronoun refers to, or null when nothing is recent. */
function activeEntity(state) {
  if (!state || !state.activeEntity) return null;
  if (Date.now() - state.activeEntity.setAt > ENTITY_TTL_MS) {
    state.activeEntity = null;
    return null;
  }
  return state.activeEntity;
}

/* ------------------------------------------------------------------ */
/* 4. PENDING ACTION — only ever created by an explicit ask            */
/* ------------------------------------------------------------------ */

function setPending(state, { tool, args, summary }) {
  if (!state || !tool) return null;
  state.pending = { tool, args: args || {}, summary: summary || "", askedAt: Date.now() };
  return state.pending;
}

/**
 * Consume the pending action. Returns null when there is none, when it
 * has expired, or when the turn that would confirm it is not actually a
 * confirmation — a pending action may only be taken by a clear yes.
 */
function takePending(state, { confirmed = true } = {}) {
  if (!state || !state.pending) return null;
  if (Date.now() - state.pending.askedAt > PENDING_TTL_MS) {
    state.pending = null;
    return null;
  }
  const p = state.pending;
  state.pending = null;
  return confirmed ? p : null;
}

function clearPending(state) {
  if (state) state.pending = null;
}

/* ------------------------------------------------------------------ */
/* 5. EXECUTED ACTIONS                                                 */
/* ------------------------------------------------------------------ */

/**
 * A guarded action that was SUPPRESSED as a repeat. It belongs in the
 * session's executed list — the claim checker reads that list to decide
 * whether a reply may say "calling him now", and a call that is already
 * ringing makes that sentence true. It must NOT be written durably: the
 * first execution already has a row, and a second would slide the repeat
 * window forward every time the user asked again.
 */
function noteSuppressed(state, { turnId, tool, args }) {
  if (!state) return null;
  const entry = {
    turnId: turnId || (state.turn && state.turn.id) || "",
    tool,
    target: actions.targetOf(tool, args),
    ok: true,
    suppressed: true,
    at: Date.now(),
  };
  state.executed.push(entry);
  if (state.executed.length > 60) state.executed.shift();
  return entry;
}

/** Record an execution both in the session and durably. */
function recordExecution(state, { turnId, tool, args, ok, detail, result }) {
  const entry = {
    turnId: turnId || (state && state.turn && state.turn.id) || "",
    tool,
    target: actions.targetOf(tool, args),
    ok: ok !== false,
    at: Date.now(),
  };
  if (state) {
    state.executed.push(entry);
    if (state.executed.length > 60) state.executed.shift();
    // A call or message names a person: that person becomes the active
    // entity, so "call her again" and "what did she say" resolve without
    // another lookup.
    if (entry.ok && entry.target &&
        ["place_phone_call", "send_agent_message", "send_whatsapp_message"].includes(tool)) {
      setEntity(state, { name: entry.target, kind: "contact", source: tool });
    }
  }
  if (state && state.userId) {
    actions.record(state.userId, {
      sessionId: state.sessionId,
      turnId: entry.turnId,
      tool,
      args,
      ok: entry.ok,
      detail,
      surface: state.surface,
      // THE LEDGER'S FIRST FIELD. The request that led here — otherwise a
      // row says "place_phone_call failed" with no way to see what the
      // user actually asked for.
      intent: (state.turn && state.turn.text) || "",
      result,
    });
  }
  return entry;
}

/** What ran during the CURRENT turn — the claim checker's evidence. */
function executedThisTurn(state) {
  if (!state || !state.turn) return [];
  return state.executed.filter((e) => e.turnId === state.turn.id);
}

function executedThisSession(state) {
  return state ? state.executed.slice() : [];
}

module.exports = {
  begin, get, end,
  beginTurn, recordReply,
  setEntity, clearEntity, activeEntity,
  setPending, takePending, clearPending, noteSuppressed,
  recordExecution, executedThisTurn, executedThisSession,
  PENDING_TTL_MS, ENTITY_TTL_MS,
};
