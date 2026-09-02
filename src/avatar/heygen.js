/**
 * HeyGen LiveAvatar provider (LITE mode) — higher-fidelity replacement for
 * Simli, chosen after the client judged Simli's rendering too rough.
 *
 * Architecturally a twin of the Simli path, which is why it slots in
 * without touching the app:
 *
 *   1. POST /v1/sessions/token   (X-API-KEY)          → session_token
 *   2. POST /v1/sessions/start   (Bearer session_token)
 *        → { livekit_url, livekit_client_token, ws_url }
 *   3. we open ws_url and stream base64 PCM16 up it; HeyGen renders the
 *      avatar and publishes lip-synced video+audio into ITS LiveKit room
 *   4. the APP joins that room with livekit_client_token — the exact same
 *      { url, token } fields the Simli path hands it today
 *
 * Two things are genuinely better than Simli here:
 *   • LITE mode takes PCM16 AT 24 kHz — Gemini's native output rate — so
 *     the resampling step disappears entirely;
 *   • rendering quality is selectable (video_settings.quality).
 *
 * SANDBOX: with HEYGEN_SANDBOX=true (the default until a plan is bought)
 * sessions are free — no credits consumed — but capped at ~1 minute and
 * restricted to HeyGen's stock "Wayne" avatar. Flipping to production is
 * removing that flag and setting a real HEYGEN_AVATAR_ID.
 *
 * The connection exposes the SAME shape as SimliConnection — push /
 * interrupt / avatarReady / close / onAudioActive — so the live proxy
 * drives either provider without knowing which one it has.
 */
const crypto = require("crypto");
const WebSocket = require("ws");

const API = process.env.HEYGEN_API_BASE || "https://api.liveavatar.com";

/// LiveAvatar's public default avatar (the id the official SDKs fall back
/// to). Used only OUTSIDE sandbox, when no HEYGEN_AVATAR_ID is set.
const DEFAULT_AVATAR_ID = "1c690fe7-23e0-49f9-bfba-14344450285b";

/// Sandbox accepts EXACTLY ONE avatar — "Wayne" — and rejects any other id
/// with a 400. Verified against the live API on 2026-09-02.
const SANDBOX_AVATAR_ID = "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a";

const RATE = 24000; // PCM16 mono, both Gemini's output and LiveAvatar's input

/// See simli.js — same reasoning: the avatar keeps speaking for its buffer
/// plus the room round-trip after the last byte lands.
const PLAYOUT_TAIL_MS = Number(process.env.HEYGEN_PLAYOUT_TAIL_MS || 900);

const configured = () => Boolean(process.env.HEYGEN_API_KEY);
const avatarId = () => process.env.HEYGEN_AVATAR_ID || DEFAULT_AVATAR_ID;
const sandbox = () => String(process.env.HEYGEN_SANDBOX || "true") !== "false";

/**
 * Step 1+2: mint a session and start it. Returns everything the connection
 * and the app need. Kept as ONE call because the two REST hits are useless
 * apart, and session.js mirrors the simli flow (token → connect).
 */
async function createSession({ faceId } = {}) {
  // Profiles can still carry face ids from the old provider — verify the
  // pick against HeyGen's live catalog and fall back to the deployment
  // default instead of letting a stale id 400 the whole session.
  const face = faceId && (await knownFace(faceId)) ? faceId : "";

  const mintToken = (durationS) =>
    fetch(`${API}/v1/sessions/token`, {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.HEYGEN_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mode: "LITE",
        // Sandbox allows only Wayne; otherwise the user's verified pick
        // wins, then the deployment default.
        avatar_id: sandbox() ? SANDBOX_AVATAR_ID : face || avatarId(),
        is_sandbox: sandbox(),
        video_settings: {
          quality: process.env.HEYGEN_QUALITY || "high",
          encoding: "H264",
        },
        // Ceiling, not target — same reasoning as Simli's maxSessionLength.
        max_session_duration: durationS,
      }),
    });

  // The allowed ceiling depends on the PLAN (sandbox 60s, trial 120s, paid
  // more) and their API rejects anything above it rather than clamping. So
  // ask for what we want, and when refused, re-ask with the exact maximum
  // the error names — the session then always runs as long as the account
  // allows, and upgrades take effect with no config change here.
  let wantS = sandbox() ? 60 : Number(process.env.HEYGEN_MAX_SESSION_S || 900);
  let tokRes = await mintToken(wantS);
  let tokText = await tokRes.text();
  if (tokRes.status === 400) {
    const m = tokText.match(/maximum allowed \((\d+)s\)/);
    if (m) {
      const capS = Number(m[1]);
      console.log(`heygen: plan caps sessions at ${capS}s — retrying with the cap`);
      tokRes = await mintToken(capS);
      tokText = await tokRes.text();
    }
  }
  if (!tokRes.ok) {
    throw new Error(`heygen token → ${tokRes.status}: ${tokText.slice(0, 300)}`);
  }
  const tok = JSON.parse(tokText)?.data;
  if (!tok?.session_token) {
    throw new Error(`heygen refused session: ${tokText.slice(0, 200)}`);
  }

  const startRes = await fetch(`${API}/v1/sessions/start`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tok.session_token}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  const startText = await startRes.text();
  if (!startRes.ok) {
    throw new Error(`heygen start → ${startRes.status}: ${startText.slice(0, 300)}`);
  }
  const s = JSON.parse(startText)?.data;
  if (!s?.livekit_url || !s?.livekit_client_token || !s?.ws_url) {
    throw new Error(`heygen start missing fields: ${startText.slice(0, 200)}`);
  }
  return {
    sessionId: s.session_id,
    sessionToken: tok.session_token,
    livekitUrl: s.livekit_url,
    clientToken: s.livekit_client_token,
    wsUrl: s.ws_url,
  };
}

class HeyGenConnection {
  constructor() {
    this.ws = null;
    this.closed = false;
    this.avatarReady = false;
    this.onReadyChange = null;
    this.livekit = null; // {url, token}
    this.framesPushed = 0;
    this._session = null;
    this._keepAlive = null;

    // Speaking window — identical playout-clock logic to SimliConnection:
    // audio is handed over in a burst, so "is she talking" is derived from
    // how much audio was sent, not from whether bytes are moving.
    this.onAudioActive = null;
    this._active = false;
    this._speakStart = 0;
    this._sentMs = 0;
    this._idleTimer = null;
  }

  _setReady(v) {
    if (this.avatarReady === v) return;
    this.avatarReady = v;
    try { this.onReadyChange?.(v); } catch (_) {}
  }

  _setActive(v) {
    if (this._active === v) return;
    this._active = v;
    try { this.onAudioActive?.(v); } catch (_) {}
  }

  _send(obj) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ event_id: crypto.randomUUID(), ...obj }));
    } catch (_) {}
  }

  /// Starts the session and resolves { url, token } for the app to join.
  async connect({ faceId } = {}, { timeoutMs = 20000 } = {}) {
    const session = await createSession({ faceId });
    this._session = session;
    this.livekit = { url: session.livekitUrl, token: session.clientToken };

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(session.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new Error("heygen: socket never reached connected state"));
        this.close();
      }, timeoutMs);

      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        let msg = null;
        try { msg = JSON.parse(data.toString()); } catch (_) { return; }
        // The docs are explicit: no commands before state "connected".
        const state = msg?.state || msg?.data?.state;
        if (state === "connected") {
          clearTimeout(timer);
          this._setReady(true);
          resolve();
        } else if (state === "closing" || state === "closed") {
          this._setReady(false);
        }
      });
      ws.on("error", (e) => {
        clearTimeout(timer);
        this._setReady(false);
        reject(new Error(`heygen ws: ${e.message}`));
      });
      ws.on("close", () => {
        clearTimeout(timer);
        this._setReady(false);
      });
    });

    // Their sessions idle out at 5 minutes; long quiet stretches (user
    // reading something the assistant showed) shouldn't kill the face.
    this._keepAlive = setInterval(
      () => this._send({ type: "session.keep_alive" }),
      150_000
    );
    return this.livekit;
  }

  /// Feed one PCM16/24k chunk from Gemini — no resampling, rates match.
  push(chunk) {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) return;
    if (!chunk?.length) return;
    this._send({ type: "agent.speak", audio: chunk.toString("base64") });
    this.framesPushed++;

    const now = Date.now();
    if (!this._active) {
      this._speakStart = now;
      this._sentMs = 0;
      this._setActive(true);
    }
    this._sentMs += (chunk.length / 2 / RATE) * 1000;
    const endsIn =
      Math.max(0, this._speakStart + this._sentMs - now) + PLAYOUT_TAIL_MS;
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this._setActive(false), endsIn);
  }

  /// Gemini finished its turn — lets the renderer flush its lookahead.
  speakEnd() {
    this._send({ type: "agent.speak_end" });
  }

  /// Barge-in: stop the mouth with the user, drop unspoken audio.
  interrupt() {
    this._sentMs = 0;
    this._speakStart = 0;
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
    this._setActive(false);
    this._send({ type: "agent.interrupt" });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this._setReady(false);
    clearInterval(this._keepAlive);
    this._keepAlive = null;
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
    this._setActive(false);
    // Stop the session server-side FIRST — that is what ends the billing
    // (and in sandbox, frees the single concurrent slot). The socket close
    // alone is not documented to do it.
    try {
      if (this._session?.sessionToken) {
        await fetch(`${API}/v1/sessions/stop`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this._session.sessionToken}`,
            "content-type": "application/json",
          },
          body: "{}",
          signal: AbortSignal.timeout(8000),
        });
      }
    } catch (_) {}
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.close();
      else this.ws?.terminate();
    } catch (_) {}
  }
}

/* ------------------------------------------------------------------ *
 * FACE CATALOG — drives the Settings face picker and voice matching.
 * ------------------------------------------------------------------ */

/// HeyGen's public catalog, cached 10 min. The API paginates at 20; four
/// pages cover the ~83 stock avatars.
let _catalog = null; // { ts, byId: Map<id, {id,name,thumb}> }
let _warming = null;

async function _loadCatalog() {
  const byId = new Map();
  let url = `${API}/v1/avatars/public?page=1&page_size=50`;
  for (let hops = 0; url && hops < 6; hops++) {
    const res = await fetch(url, {
      headers: { "X-API-KEY": process.env.HEYGEN_API_KEY },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`heygen avatars → ${res.status}`);
    const d = (await res.json())?.data || {};
    for (const a of d.results || []) {
      if (a.status !== "ACTIVE") continue;
      byId.set(a.id, { id: a.id, name: a.name, thumb: a.preview_url || null });
    }
    url = d.next || null;
  }
  _catalog = { ts: Date.now(), byId };
  return _catalog;
}

async function catalog() {
  if (_catalog && Date.now() - _catalog.ts < 600_000) return _catalog;
  _warming ??= _loadCatalog().finally(() => (_warming = null));
  return _warming;
}

/**
 * Faces the Settings picker offers. Portrait-framed avatars first — the
 * app renders the face full-screen on a phone, and landscape desk shots
 * letterbox badly there.
 */
async function listFaces() {
  const c = await catalog();
  const all = [...c.byId.values()];
  const portrait = all.filter((f) => /\(Portrait\)/i.test(f.name));
  const rest = all.filter((f) => !/\(Portrait\)/i.test(f.name));
  return [...portrait, ...rest].map((f) => ({
    ...f,
    // "Katya Sitting (Portrait)" reads like an SKU, not a person.
    name: f.name.replace(/\s*\(Portrait\)\s*/i, "").trim(),
  }));
}

/// A face id is only usable if HeyGen still lists it — this is also what
/// quietly retires the SIMLI ids stored in profiles before the switch.
async function knownFace(id) {
  if (!id) return false;
  try {
    return (await catalog()).byId.has(id);
  } catch (_) {
    return false;
  }
}

// A fitting Gemini voice per face, so a male avatar doesn't speak with
// Kore's female voice. HeyGen's catalog carries no gender field, so first
// names are the source of truth — every stock avatar uses one of these.
const FEMALE = /^(ann|judy|june|elenora|katya|amina|rika|alessandra|anastasia|marianne)\b/i;
const MALE = /^(shawn|dexter|silas|bryan|wayne|graham|anthony|pedro|thaddeus|santa)\b/i;

/// Sync by design — tts.js and the live proxy call it inline. Answers
/// from the warm catalog; cold cache returns null (default voice) and
/// warms in the background for the next call.
function voiceForFace(id) {
  if (!id) return null;
  const hit = _catalog?.byId?.get(id);
  if (!hit) {
    catalog().catch(() => {});
    return null;
  }
  if (FEMALE.test(hit.name)) return "Kore";
  if (MALE.test(hit.name)) return "Charon";
  return null;
}

module.exports = {
  createSession,
  HeyGenConnection,
  configured,
  avatarId,
  sandbox,
  listFaces,
  knownFace,
  voiceForFace,
};
