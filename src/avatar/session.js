/**
 * Avatar session lifecycle — and, because HeyGen bills per minute of
 * rendered video, the cost boundary of this feature.
 *
 * A session is created on demand when the app opens face mode and is torn
 * down the moment the conversation ends. Three independent guards make
 * sure a session cannot outlive the conversation that paid for it:
 *
 *   ATTACH_GRACE_MS  the app asked for an avatar but its /live/ws socket
 *                    never arrived (crash, denied mic, backgrounded app).
 *   MAX_SESSION_MS   a hard ceiling. Even a genuinely long call stops
 *                    billing here rather than running until morning.
 *   detach()         the normal path — the live socket closed, so the
 *                    session goes immediately.
 *
 * Every exit route funnels through stop(), which ends HeyGen's session
 * server-side (their room, their billing) and is safe to call repeatedly
 * and from anywhere.
 *
 * Provider: HeyGen LiveAvatar only. Simli (quality rejected by users) and
 * BeyondPresence (never taken live) were removed 2026-09-02 — git history
 * has both if a second provider is ever needed again.
 */
const crypto = require("crypto");
const heygen = require("./heygen");

const ATTACH_GRACE_MS = Number(process.env.AVATAR_ATTACH_GRACE_MS || 45000);
const MAX_SESSION_MS = Number(process.env.AVATAR_MAX_SESSION_MS || 15 * 60 * 1000);

/// room name → session record. Process-local: a session is only ever
/// driven by the same backend instance that created it, because the audio
/// websocket to HeyGen lives in-process.
const sessions = new Map();

const configured = () => heygen.configured();
const provider = () => "heygen";

function clearTimers(s) {
  clearTimeout(s.attachTimer);
  clearTimeout(s.maxTimer);
  s.attachTimer = null;
  s.maxTimer = null;
}

// One avatar per user, and no machine-gunning: rapid open/close cycles
// (observed during app reconnect storms) can trip provider rate limits and
// then the face "randomly" refuses to appear for everyone.
const lastStartByUser = new Map();

// SHARED-PLAN PROTECTION. Every user burns the same HeyGen account, and a
// plan allows only a few CONCURRENT sessions: several testers toggling
// faces at once locks everyone out. So:
//  • cap concurrent avatar sessions (env AVATAR_MAX_CONCURRENT, default 3);
//  • after the provider rate-limits us, hold a cooldown instead of
//    hammering it — every retry during the window makes the lockout worse.
const MAX_CONCURRENT = () =>
  Number(process.env.AVATAR_MAX_CONCURRENT || process.env.SIMLI_MAX_CONCURRENT || 3);
let rateLimitCooldownUntil = 0;

function noteRateLimited() {
  rateLimitCooldownUntil = Date.now() + 60_000;
}

/**
 * Start a HeyGen session for this user. Returns what the app needs to
 * join the provider's LiveKit room as a subscriber.
 */
async function start({ userId }) {
  if (!configured()) throw new Error("avatar not configured");
  const key = String(userId ?? ""); // matches rec.userId below

  if (Date.now() < rateLimitCooldownUntil) {
    throw new Error("avatar busy: provider rate-limited, cooling down");
  }
  // Count OTHER users' live sessions (this user's own are superseded
  // below, so they don't count against the cap).
  let others = 0;
  for (const [, rec] of sessions) if (rec.userId !== key) others++;
  if (others >= MAX_CONCURRENT()) {
    throw new Error("avatar busy: all concurrent slots in use");
  }

  // Close any session this user already has BEFORE opening a new one —
  // concurrent sessions all bill, and providers count them per account.
  for (const [room, rec] of sessions) {
    if (rec.userId === key) {
      await stop(room, "superseded by a new session").catch(() => {});
    }
  }

  const last = lastStartByUser.get(key) || 0;
  const since = Date.now() - last;
  if (since < 3000) {
    await new Promise((r) => setTimeout(r, 3000 - since));
  }
  lastStartByUser.set(key, Date.now());

  const room = `heygen-${userId || "anon"}-${crypto.randomBytes(6).toString("hex")}`;
  const conn = new heygen.HeyGenConnection();

  const rec = {
    room,
    userId: key,
    provider: "heygen",
    publisher: conn,
    attached: false,
    createdAt: Date.now(),
    attachTimer: null,
    maxTimer: null,
  };
  sessions.set(room, rec);

  let lkInfo;
  try {
    // The face the user picked in Settings (verified against HeyGen's
    // catalog inside createSession; empty → deployment default).
    let face = "";
    try {
      const p = await require("../users/context").getProfile(Number(userId));
      face = p?.assistant?.avatar_id || "";
    } catch (_) {}
    lkInfo = await conn.connect({ faceId: face });
  } catch (e) {
    await stop(room, `heygen start failed: ${e.message}`);
    if (/rate ?limit|4029|too many/i.test(String(e?.message || ""))) noteRateLimited();
    throw e;
  }

  rec.attachTimer = setTimeout(() => stop(room, "no live socket attached"), ATTACH_GRACE_MS);
  rec.maxTimer = setTimeout(() => stop(room, "max session reached"), MAX_SESSION_MS);

  return {
    room,
    url: lkInfo.url,
    token: lkInfo.token,
    provider: "heygen",
    avatarId: heygen.avatarId(),
    sessionId: null,
  };
}

/**
 * Bind a live WS to its room. Returns the publisher to feed, or null when
 * the room is unknown, already finished, or owned by a different user.
 */
function attach(room, userId) {
  const s = sessions.get(room);
  if (!s) return null;
  if (s.userId && String(userId ?? "") !== s.userId) return null;
  s.attached = true;
  clearTimeout(s.attachTimer);
  s.attachTimer = null;
  return s.publisher;
}

/// The conversation ended — stop paying for the avatar.
const detach = (room) => stop(room, "live socket closed");

async function stop(room, why = "") {
  const s = sessions.get(room);
  if (!s) return;
  sessions.delete(room);
  clearTimers(s);

  // close() ends the session on HeyGen's side too — their room, their
  // billing; there is nothing of ours to delete.
  try { await s.publisher.close(); } catch (_) {}
  console.log(`avatar: session ended ${room}${why ? ` (${why})` : ""}`);
}

/// Shut everything down on SIGTERM so a deploy cannot orphan a paid session.
async function stopAll() {
  await Promise.all([...sessions.keys()].map((r) => stop(r, "server shutting down")));
}

module.exports = { start, attach, detach, stop, stopAll, configured, provider, sessions };
