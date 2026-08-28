/**
 * LiveKit room + token minting for avatar sessions.
 *
 * Three identities share one room, with deliberately minimal grants:
 *
 *   agent-<room>   our publisher — publishes the assistant's PCM, subscribes
 *                  to nothing (it has no use for the avatar's own video).
 *   bey-<room>     BEY's worker  — subscribes to the agent audio, publishes
 *                  the lip-synced video+audio.
 *   user-<uid>     the phone     — SUBSCRIBE ONLY. The app never publishes
 *                  here; the mic keeps flowing over the existing /live/ws
 *                  socket, so this token cannot be used to source media.
 *
 * The room is the billing boundary: deleting it evicts BEY's worker and
 * stops the per-minute charge, so teardown must never be best-effort.
 */
const { AccessToken, RoomServiceClient } = require("livekit-server-sdk");

const wsUrl = () => process.env.LIVEKIT_URL || "";
const configured = () =>
  Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);

/// RoomServiceClient speaks HTTP even though clients use the wss:// URL.
function roomService() {
  const http = wsUrl().replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
  return new RoomServiceClient(http, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
}

async function mintToken({ room, identity, name, canPublish, canSubscribe, ttlSeconds = 3600 }) {
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity,
    name: name || identity,
    ttl: ttlSeconds,
  });
  at.addGrant({
    room,
    roomJoin: true,
    canPublish,
    canSubscribe,
    // Nobody in an avatar room needs the data channel; the app's control
    // messages already have a home on the /live/ws socket.
    canPublishData: false,
  });
  return at.toJwt();
}

/**
 * Evict everyone and stop BEY billing. Safe to call twice: LiveKit 404s
 * on an already-deleted room, which is success for our purposes.
 */
async function deleteRoom(room) {
  try {
    await roomService().deleteRoom(room);
  } catch (e) {
    if (!/not.?found|does not exist|404/i.test(String(e.message))) throw e;
  }
}

module.exports = { mintToken, deleteRoom, roomService, wsUrl, configured };
