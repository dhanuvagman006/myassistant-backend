/**
 * Avatar session lifecycle — and, because BEY bills per minute of rendered
 * video, the cost boundary of this feature.
 *
 * A session is created on demand when the app opens live mode and is torn
 * down the moment the conversation ends. Three independent guards make
 * sure a room cannot outlive the conversation that paid for it:
 *
 *   ATTACH_GRACE_MS  the app asked for an avatar but its /live/ws socket
 *                    never arrived (crash, denied mic, backgrounded app).
 *   MAX_SESSION_MS   a hard ceiling. Even a genuinely long call stops
 *                    billing here rather than running until morning.
 *   detach()         the normal path — the live socket closed, so the
 *                    room goes immediately.
 *
 * Every exit route funnels through stop(), which deletes the LiveKit room.
 * That eviction is what actually ends BEY's billing, so stop() is written
 * to be safe to call repeatedly and from anywhere.
 */
const crypto = require("crypto");
const bey = require("./bey");
const lk = require("./livekit");
const simli = require("./simli");
const { AvatarPublisher } = require("./publisher");

/// Which rendering service to use. They differ in who owns the room:
///
///   simli  Simli hosts the room and hands us a token for it. We stream PCM
///          up a websocket; the app joins Simli's room. No room of ours, no
///          video transcoding here.
///   bey    BeyondPresence joins a room WE create, so we run a LiveKit room
///          and publish the assistant's audio into it ourselves.
///
/// Both expose push/interrupt/avatarReady/close, so the live proxy is
/// provider-agnostic and nothing downstream branches on this.
const provider = () => (process.env.AVATAR_PROVIDER || "simli").toLowerCase();

const ATTACH_GRACE_MS = Number(process.env.AVATAR_ATTACH_GRACE_MS || 45000);
const MAX_SESSION_MS = Number(process.env.AVATAR_MAX_SESSION_MS || 15 * 60 * 1000);

/// room name → session record. Process-local: a room is only ever driven
/// by the same backend instance that created it, because the publisher is
/// an in-process WebRTC peer.
const sessions = new Map();

const configured = () =>
  provider() === "simli" ? simli.configured() : lk.configured() && bey.configured();

function clearTimers(s) {
  clearTimeout(s.attachTimer);
  clearTimeout(s.maxTimer);
  s.attachTimer = null;
  s.maxTimer = null;
}

/**
 * Create a room, put our publisher in it, and ask BEY to send the avatar.
 * Returns what the app needs to join as a subscriber.
 */
// One avatar per user, and no machine-gunning: rapid open/close cycles
// (observed during app reconnect storms) trip Simli's RATE LIMIT and then
// the face "randomly" refuses to appear for everyone.
const lastStartByUser = new Map();

async function start({ userId }) {
  if (!configured()) throw new Error("avatar not configured");
  const key = String(userId ?? ""); // matches rec.userId below

  // Close any session this user already has BEFORE opening a new one —
  // Simli counts them concurrently and rate-limits the account.
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

  return provider() === "simli" ? startSimli({ userId }) : startBey({ userId });
}

/**
 * Simli: ask for a session, take the room it offers, hand that to the app.
 * The "room" we track is Simli's, and closing the websocket is what ends
 * the billed session — there is nothing of ours to delete.
 */
async function startSimli({ userId }) {
  const room = `simli-${userId || "anon"}-${crypto.randomBytes(6).toString("hex")}`;
  const conn = new simli.SimliConnection();

  const rec = {
    room,
    userId: String(userId ?? ""),
    provider: "simli",
    publisher: conn,
    attached: false,
    createdAt: Date.now(),
    attachTimer: null,
    maxTimer: null,
  };
  sessions.set(room, rec);

  let lkInfo;
  try {
    // The face the user picked in Settings (empty → deployment default).
    let face = "";
    try {
      const p = await require("../users/context").getProfile(Number(userId));
      face = p?.assistant?.avatar_id || "";
    } catch (_) {}
    const token = await simli.createSessionToken({ faceId: face });
    lkInfo = await conn.connect(token);
  } catch (e) {
    await stop(room, `simli start failed: ${e.message}`);
    throw e;
  }

  rec.attachTimer = setTimeout(() => stop(room, "no live socket attached"), ATTACH_GRACE_MS);
  rec.maxTimer = setTimeout(() => stop(room, "max session reached"), MAX_SESSION_MS);

  return {
    room,
    url: lkInfo.url,
    token: lkInfo.token,
    provider: "simli",
    avatarId: simli.faceId(),
    sessionId: null,
  };
}

async function startBey({ userId }) {
  const room = `hari-${userId || "anon"}-${crypto.randomBytes(6).toString("hex")}`;

  // The publisher must be IN the room before BEY arrives. BEY's worker
  // looks for an audio track to render against as it joins; an empty room
  // makes it sit idle (and bill) with nothing to lip-sync.
  const publisher = new AvatarPublisher(room);
  const agentToken = await lk.mintToken({
    room,
    identity: `agent-${room}`,
    name: "Assistant",
    canPublish: true,
    canSubscribe: false,
  });

  const rec = {
    room,
    userId: String(userId ?? ""),
    provider: "bey",
    publisher,
    beySessionId: null,
    attached: false,
    createdAt: Date.now(),
    attachTimer: null,
    maxTimer: null,
  };
  sessions.set(room, rec);

  try {
    await publisher.connect(lk.wsUrl(), agentToken);

    const beyToken = await lk.mintToken({
      room,
      identity: `bey-${room}`,
      name: "avatar",
      canPublish: true,
      canSubscribe: true,
    });
    // The face the user picked in Settings (empty → deployment default).
    let face = "";
    try {
      const p = await require("../users/context").getProfile(Number(userId));
      face = p?.assistant?.avatar_id || "";
    } catch (_) {}
    const session = await bey.createLivekitSession({
      url: lk.wsUrl(),
      token: beyToken,
      avatarId: face,
    });
    rec.beySessionId = session?.id || null;
  } catch (e) {
    // Never leave a half-built room behind — it would bill silently.
    await stop(room, `start failed: ${e.message}`);
    throw e;
  }

  rec.attachTimer = setTimeout(
    () => stop(room, "no live socket attached"),
    ATTACH_GRACE_MS
  );
  rec.maxTimer = setTimeout(() => stop(room, "max session reached"), MAX_SESSION_MS);

  const appToken = await lk.mintToken({
    room,
    identity: `user-${userId || "anon"}`,
    name: "you",
    canPublish: false, // mic stays on /live/ws; this token cannot source media
    canSubscribe: true,
  });

  return {
    room,
    url: lk.wsUrl(),
    token: appToken,
    provider: "bey",
    avatarId: bey.avatarId(),
    sessionId: rec.beySessionId,
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

  try { await s.publisher.close(); } catch (_) {}
  // Only the BEY path runs a room of ours. For Simli, closing the websocket
  // above is what ends the billed session; there is no room to delete.
  if (s.provider !== "simli") {
    try {
      await lk.deleteRoom(room);
    } catch (e) {
      // Loud on purpose: a room we failed to delete is a room still billing.
      console.error(`avatar: FAILED to delete room ${room} (${e.message}) — may still bill`);
    }
  }
  console.log(`avatar: session ended ${room}${why ? ` (${why})` : ""}`);
}

/// Shut everything down on SIGTERM so a deploy cannot orphan a paid room.
async function stopAll() {
  await Promise.all([...sessions.keys()].map((r) => stop(r, "server shutting down")));
}

module.exports = { start, attach, detach, stop, stopAll, configured, provider, sessions };
