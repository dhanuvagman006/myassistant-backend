/**
 * THE APP'S CONVERSATIONS, AS THE TOOL SERVER SEES THEM.
 *
 * Since 2026-09-29 the phone calls the models itself (Gemini Nano on the
 * device, Gemini in the cloud through Firebase AI Logic) and this server
 * is its tool server and memory. What used to live for the length of one
 * Live WebSocket — the turn state, the taint an email or a relayed
 * message leaves, the tool log the claim check reads, the approvals —
 * now lives here, per (user, sessionId), between the app's HTTP calls:
 *
 *   POST /ai/context  opens a turn (creating the session when the app has
 *                     none, or names one this user does not own)
 *   POST /ai/tool     runs a tool inside that turn
 *   POST /ai/turn     records the reply and closes it
 *
 * A session is the same sessionState object the text agent uses
 * (src/agents/sessionState.js), wrapped with what only the phone knows:
 * build, platform, clock, place, permissions. It expires after 30 idle
 * minutes, and a user holds at most MAX_PER_USER at once (the oldest
 * goes first). The key includes the user id, so a session id never
 * reaches another account's state.
 *
 * In memory, on this pod — exactly as the live socket's state was.
 */
const crypto = require("crypto");
const sessionState = require("../agents/sessionState");

const IDLE_MS = 30 * 60_000;
const MAX_PER_USER = 5;
// A turn id stays usable for a late tool call or record this long after
// the next turn opened (a barge-in, a slow tool).
const MAX_TURNS_KEPT = 12;

const sessions = new Map(); // `${uid}:${id}` -> session
// Accounts deleted on this pod: nothing is created or written for them
// again (see closeUser). User ids are never reused.
const erased = new Set();

const key = (uid, id) => `${Number(uid) || 0}:${String(id || "")}`;

function drop(s) {
  sessions.delete(key(s.userId, s.id));
  try { sessionState.end(s.userId, s.id); } catch (_) {}
}

function gc(now = Date.now()) {
  for (const s of sessions.values()) {
    if (now - s.lastUsed > IDLE_MS) drop(s);
  }
}

function ofUser(uid) {
  const u = Number(uid);
  return [...sessions.values()].filter((s) => s.userId === u);
}

/** A new session for this user; the oldest goes when they hold too many. */
function create(uid, { build = 0 } = {}) {
  gc();
  const userId = Number(uid);
  const mine = ofUser(userId).sort((a, b) => a.lastUsed - b.lastUsed);
  while (mine.length >= MAX_PER_USER) drop(mine.shift());
  const id = "ai:" + crypto.randomUUID();
  const s = {
    userId,
    id,
    state: sessionState.begin(userId, id, { surface: "ai", appBuild: build }),
    createdAt: Date.now(),
    lastUsed: Date.now(),
    // What only the phone knows, refreshed by every /ai/context.
    device: { build: 0, platform: null, tz: 330, lat: undefined, lng: undefined, acc: undefined, caps: null },
    // The fix the WHERE line is built from: a coarse fix (over a km out)
    // moves the tools, not the model's picture of the area.
    promptFix: null,
    devicesSaved: "",
    // turnId -> { id, text, owner, mode ("chat" | "voice" | "live"),
    // shortcut, untrusted (someone else's words — kept out of LAST
    // RESULTS), at }
    turns: new Map(),
    turnId: "",
    // The owner's latest words and how clearly they came through: what
    // tools are judged against (an app note is not the owner speaking).
    owner: { text: "", quality: { quality: "clear", reason: "" }, at: 0 },
    // The assistant's last reply: expectations ("How old is she turning?"
    // → "25" is an answer) and the shortcut answer guard read it.
    lastReply: "",
    // The approval tokens already spent (nonce -> expiry).
    spent: new Map(),
    // The confirmation waiting on the owner's yes: { tool, args, summary, turnId }.
    asked: null,
    // Unread agent messages this session is passing on (ids, and the turn
    // that carried them; marked read when that turn is recorded).
    relay: null,
    // Interpreter mode, while on: the instructions the tool handed back.
    interpreter: null,
    // The language question, asked once in a session's first turn.
    languageAsk: "",
    firstTurnDone: false,
  };
  sessions.set(key(userId, id), s);
  return s;
}

/** This user's session, or null (unknown, another user's, or expired). */
function get(uid, id) {
  if (!id) return null;
  const s = sessions.get(key(uid, id));
  if (!s) return null;
  if (Date.now() - s.lastUsed > IDLE_MS) {
    drop(s);
    return null;
  }
  s.lastUsed = Date.now();
  // Kept alive in the shared turn-state store for as long as it is used.
  s.state.touchedAt = s.lastUsed;
  return s;
}

/** Opens a new turn in the session and returns its id. */
function openTurn(s, { text = "", owner = true, mode = "chat", shortcut = null } = {}) {
  const id = crypto.randomUUID();
  s.turns.set(id, { id, text: String(text || ""), owner, mode, shortcut, at: Date.now() });
  while (s.turns.size > MAX_TURNS_KEPT) s.turns.delete(s.turns.keys().next().value);
  s.turnId = id;
  return id;
}

function turn(s, turnId) {
  return (s && turnId && s.turns.get(String(turnId))) || null;
}

/**
 * Ends every session this user holds on this pod, now, and refuses them
 * from here on. Called by privacy.deleteUserEverywhere(). Returns how many
 * were open.
 */
function closeUser(userId) {
  const uid = Number(userId);
  if (!(uid > 0)) return 0;
  erased.add(uid);
  const open = ofUser(uid);
  for (const s of open) drop(s);
  return open.length;
}

/** The delete failed and the account is still there: it may talk again. */
function cancelErase(userId) {
  erased.delete(Number(userId));
}

const isErased = (userId) => erased.has(Number(userId));

// A pod that nobody talks to still lets go of its sessions.
setInterval(() => gc(), 5 * 60_000).unref?.();

module.exports = {
  create, get, openTurn, turn, closeUser, cancelErase, isErased, ofUser,
  IDLE_MS, MAX_PER_USER,
  _all: () => [...sessions.values()], // tests only
};
