/**
 * BeyondPresence REST client — the AVATAR (rendering) layer only.
 *
 * BEY does not host the brain here. We create a session in "livekit
 * transport" mode, which makes BEY's avatar worker JOIN A LIVEKIT ROOM WE
 * OWN using a token we mint. Inside that room it subscribes to the audio
 * our agent publishes and republishes it as a photorealistic, lip-synced
 * AUDIO+VIDEO pair. Because BEY emits both tracks itself, the app gets
 * A/V that is synchronised by construction — there is no second audio
 * path for the lips to drift against.
 *
 *   Gemini Live ──PCM──> our publisher ──LiveKit──> BEY worker
 *                                                      │
 *   app  <────────── lip-synced video + audio ─────────┘
 *
 * There is deliberately no deleteSession(): the BEY API exposes no such
 * endpoint. A session is ended by deleting the LiveKit room, which evicts
 * the worker and stops the per-minute billing (see livekit.deleteRoom).
 */
const BEY_API = process.env.BEY_API_BASE || "https://api.bey.dev/v1";

/// "Nelly — closeup", a female avatar framed for a full-screen talking
/// head. Only used when BEY_AVATAR_ID is unset.
const DEFAULT_AVATAR_ID = "8c37d173-929f-4a71-9a5f-45840bb2422b";

const avatarId = () => process.env.BEY_AVATAR_ID || DEFAULT_AVATAR_ID;
const configured = () => Boolean(process.env.BEY_API_KEY);

async function beyFetch(path, { method = "GET", body, timeoutMs = 20000 } = {}) {
  const key = process.env.BEY_API_KEY;
  if (!key) throw new Error("BEY_API_KEY not set");

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${BEY_API}${path}`, {
      method,
      signal: ctl.signal,
      headers: {
        "x-api-key": key,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // AbortError has a useless message; say what actually happened.
    throw new Error(
      e.name === "AbortError"
        ? `bey ${method} ${path} timed out after ${timeoutMs}ms`
        : `bey ${method} ${path} failed: ${e.message}`
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`bey ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Ask BEY to send an avatar worker into `roomUrl` using `token`.
 * Resolves once BEY has ACCEPTED the request — the worker still takes a
 * moment to actually appear in the room, which the app waits for by
 * watching for the remote video track.
 */
async function createLivekitSession({ url, token, avatarId: face }) {
  return beyFetch("/sessions", {
    method: "POST",
    // Per-user face from Settings wins; deployment default otherwise.
    body: { transport: "livekit", avatar_id: face || avatarId(), url, token },
  });
}

/// All avatars this account may use — drives the Settings face picker.
const listAvatars = () => beyFetch("/avatars");

const getSession = (id) => beyFetch(`/sessions/${id}`);

/// Used by the /live/avatar probe so the app can hide the avatar toggle
/// when the key is missing or the configured avatar has been retired.
async function describeAvatar() {
  return beyFetch(`/avatars/${avatarId()}`);
}

module.exports = { createLivekitSession, getSession, describeAvatar, listAvatars, avatarId, configured };
