/**
 * Simli avatar provider — real-time lip-sync over Simli's own LiveKit room.
 *
 * Simli is much simpler to host than a "join my room" provider, because it
 * brings its own room:
 *
 *   1. POST /compose/token            → session_token
 *   2. WS  /compose/webrtc/livekit    → {livekit_url, livekit_token}
 *   3. we stream PCM up that socket; Simli renders the face and publishes
 *      video+audio into ITS room
 *   4. the APP joins that room with the token from step 2 and renders it
 *
 * So the phone watches Simli's room directly. We never decode or re-encode
 * video, we run no LiveKit room of our own, and — importantly — the API key
 * never leaves this server. (The published `simli_flutter` package would put
 * the key in the app, where anyone can pull it out of the APK and spend the
 * account's minutes.)
 *
 * The client here exposes the SAME shape as the BeyondPresence publisher —
 * push / interrupt / avatarReady / close — so the live proxy drives either
 * provider without knowing which one it has.
 */
const WebSocket = require("ws");

const API = process.env.SIMLI_API_BASE || "https://api.simli.ai";
const WS_URL = () =>
  (process.env.SIMLI_WS_BASE || "wss://api.simli.ai") + "/compose/webrtc/livekit";

/// Gemini Live emits 24 kHz; Simli expects 16 kHz PCM16 mono. The rate is
/// configurable because it is a convention of Simli's SDKs rather than
/// something their published spec pins down.
const IN_RATE = 24000;

/// How long the avatar keeps talking after the last byte reaches it — its
/// own buffer plus the trip back through the room. Deliberately generous:
/// unmuting early costs a broken sentence, waiting costs a moment.
const PLAYOUT_TAIL_MS = Number(process.env.SIMLI_PLAYOUT_TAIL_MS || 900);
const OUT_RATE = Number(process.env.SIMLI_SAMPLE_RATE || 16000);

const configured = () => Boolean(process.env.SIMLI_API_KEY);
const faceId = () => process.env.SIMLI_FACE_ID || "";

/// Simli's session token. Short-lived and scoped to one conversation, which
/// is why it is safe to hand the room token to the app afterwards.
async function createSessionToken({ faceId: faceOverride } = {}) {
  const res = await fetch(`${API}/compose/token`, {
    method: "POST",
    headers: {
      "x-simli-api-key": process.env.SIMLI_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      // The face the user picked in Settings wins; env default otherwise.
      faceId: faceOverride || faceId(),
      audioInputFormat: "pcm16",
      handleSilence: true,
      // Ceilings, not targets. Simli bills per minute, so an abandoned
      // session must expire on their side even if ours never tears down.
      maxSessionLength: Number(process.env.SIMLI_MAX_SESSION_S || 900),
      maxIdleTime: Number(process.env.SIMLI_MAX_IDLE_S || 120),
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`simli token → ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const token = json.session_token;
  // A 200 with "FAIL TOKEN" is Simli's documented soft failure — treating it
  // as success would strand the app waiting on a room that never appears.
  if (!token || /FAIL/i.test(token)) {
    throw new Error(`simli refused session: ${json.detail || text.slice(0, 200)}`);
  }
  return token;
}

/**
 * One live Simli connection. Resolve `ready` to get the room the app should
 * join; feed audio with push().
 */
class SimliConnection {
  constructor() {
    this.ws = null;
    this.closed = false;
    this.avatarReady = false;
    this.onReadyChange = null;
    this.livekit = null; // {url, token}
    this.framesPushed = 0;

    // Resampler state. Held ACROSS chunks: the read position almost never
    // lands on a chunk boundary, and restarting it at zero each time would
    // add a small discontinuity 20 times a second — audible as a buzz, and
    // enough to make the mouth jitter.
    this._pos = 0;
    this._tail = Buffer.alloc(0);
    this._last = 0;

    // ---- speaking window ----
    // Audio is forwarded to Simli THE MOMENT it arrives, deliberately.
    // Gemini hands over a whole reply in a burst (~10 s of speech in 60 ms)
    // and an earlier version of this file smoothed that into a real-time
    // 20 ms drip. That made the lip-sync markedly worse: Simli predicts
    // visemes from a window of audio, and feeding it one frame at a time
    // leaves it no lookahead, so the mouth degrades to a generic open/close.
    // Handing it the whole utterance at once gives it the context it wants.
    //
    // The cost of bursting is that "is she talking?" can no longer be read
    // from whether bytes are moving — they all moved in the first 60 ms. So
    // track how much audio has been HANDED OVER and derive when playback
    // should end from its duration.
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

  /// Connects and resolves once Simli has named the room to join.
  connect(sessionToken, { timeoutMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      // The parameter MUST be `session_token`. Simli's AsyncAPI spec only
      // says the token "is sent as query parameter string" without naming
      // it; every other spelling (?token=, bare query, path suffix) is
      // rejected with a bare 403 that looks like a bad key rather than a
      // bad URL. Verified by trying them.
      const url = `${WS_URL()}?session_token=${encodeURIComponent(sessionToken)}`;
      const ws = new WebSocket(url);
      this.ws = ws;

      const timer = setTimeout(() => {
        reject(new Error("simli: no room offered within timeout"));
        this.close();
      }, timeoutMs);

      ws.on("message", (data, isBinary) => {
        if (isBinary) return; // Simli publishes media to the room, not here
        const text = data.toString();

        // Control frames are plain strings; only the room hand-off is JSON.
        if (/^(ERROR|CLOSING)/i.test(text)) {
          console.error(`simli: ${text.slice(0, 200)}`);
          clearTimeout(timer);
          reject(new Error(text.slice(0, 200)));
          this.close();
          return;
        }
        if (/^RATE/i.test(text)) {
          // Rate limiting is the usual free-tier symptom — say so plainly
          // rather than letting it look like a silent avatar.
          console.warn(`simli: rate limited — ${text.slice(0, 160)}`);
          return;
        }

        let msg = null;
        try { msg = JSON.parse(text); } catch (_) { /* a START/ACK/SPEAK event */ }

        if (msg?.livekit_url && msg?.livekit_token) {
          this.livekit = { url: msg.livekit_url, token: msg.livekit_token };
          clearTimeout(timer);
          this._setReady(true);
          resolve(this.livekit);
        }
      });

      ws.on("error", (e) => {
        clearTimeout(timer);
        this._setReady(false);
        reject(new Error(`simli ws: ${e.message}`));
      });
      ws.on("close", () => {
        clearTimeout(timer);
        this._setReady(false);
        this.closed = true;
      });
    });
  }

  /**
   * Feed one PCM16/24k chunk from Gemini, resampled to Simli's rate.
   * Linear interpolation: for speech driving a mouth this is indistinguishable
   * from a filtered resample, and it costs no dependency.
   */
  push(chunk) {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) return;

    const buf = this._tail.length ? Buffer.concat([this._tail, chunk]) : chunk;
    const usable = buf.length - (buf.length % 2);
    this._tail = usable === buf.length ? Buffer.alloc(0) : buf.subarray(usable);
    if (usable === 0) return;

    const inCount = usable / 2;
    const ratio = IN_RATE / OUT_RATE;
    const out = [];
    let pos = this._pos;
    while (pos < inCount) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i === 0 ? this._last : buf.readInt16LE((i - 1) * 2);
      const b = buf.readInt16LE(i * 2);
      out.push(Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * frac))));
      pos += ratio;
    }
    this._pos = pos - inCount; // carry the fractional remainder into the next chunk
    this._last = buf.readInt16LE((inCount - 1) * 2);

    if (!out.length) return;
    const pcm = Buffer.alloc(out.length * 2);
    out.forEach((s, i) => pcm.writeInt16LE(s, i * 2));
    try {
      this.ws.send(pcm);
      this.framesPushed++;
    } catch (_) {
      return;
    }

    const now = Date.now();
    // A fresh utterance if she was silent, otherwise the same one continuing.
    if (!this._active) {
      this._speakStart = now;
      this._sentMs = 0;
      this._setActive(true);
    }
    this._sentMs += (out.length / OUT_RATE) * 1000;

    // She stops when the audio handed over has had time to PLAY OUT, not
    // when the last byte was sent. Those are seconds apart after a burst,
    // and reopening the caller's microphone in that gap is exactly what
    // made her interrupt herself.
    const endsIn = Math.max(0, this._speakStart + this._sentMs - now) + PLAYOUT_TAIL_MS;
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this._setActive(false), endsIn);
  }

  /// Barge-in: SKIP clears audio Simli has buffered but not yet spoken, so
  /// the face stops mid-sentence with the user instead of talking over them.
  interrupt() {
    this._tail = Buffer.alloc(0);
    this._pos = 0;
    this._last = 0;
    // Anything still queued belongs to the sentence being abandoned.
    this._sentMs = 0;
    this._speakStart = 0;
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
    this._setActive(false);
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("SKIP");
    } catch (_) {}
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this._setReady(false);
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
    this._setActive(false);
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send("DONE"); // lets Simli end the billed session cleanly
        this.ws.close();
      } else {
        this.ws?.terminate();
      }
    } catch (_) {}
  }
}

/**
 * Faces the Settings picker offers on the Simli provider:
 *   • SIMLI_FACES env — curated public-gallery faces as "id:Name" pairs,
 *     comma-separated (Simli has no API for the public gallery, so the
 *     IDs are pasted from it once and served from config).
 *   • plus the account's own custom faces from GET /faces.
 */
// Portrait for each preset face, from Simli's public docs site — lets the
// picker show real faces instead of a wall of names.
const THUMBS = {
  "cace3ef7-a4c4-425d-a8cf-a5358eb0c427": "asian_woman",
  "b9e5fba3-071a-4e35-896e-211c4d6eaa7b": "indian_woman_2",
  "d2a5c7c6-fed9-4f55-bcb3-062f7cd20103": "white_woman",
  "7e74d6e7-d559-4394-bd56-4923a3ab75ad": "indian_man",
  "1c6aa65c-d858-4721-a4d9-bda9fde03141": "black_man",
  "5fc23ea5-8175-4a82-aaaf-cdd8c88543dc": "madison",
  "804c347a-26c9-4dcf-bb49-13df4bed61e8": "black_programmer",
  "afdb6a3e-3939-40aa-92df-01604c23101c": "zahra",
  "9d0ba12e-ebad-4bfa-b1fb-c6c5be21abca": "teenager",
  "dd10cb5a-d31d-4f12-b69f-6db3383c006e": "hank",
  "c65af549-9105-442a-92a3-dc6c89e34149": "dj_real",
  "f0ba4efe-7946-45de-9955-c04a04c367b9": "doctor",
  "b1f6ad8f-ed78-430b-85ef-2ec672728104": "Charlotte",
  "c295e3a2-ed11-48d5-a1bd-ff42ac7eac73": "einstein_2",
  "4cce0ca0-550f-42d8-b500-834ffb35e0af": "catgirl",
  "c7451e55-ea04-41c8-ab47-bdca3e4a03d8": "Cleo_2",
  "14de6eb1-0ea6-4fde-9522-8552ce691cb6": "baby",
  "6926a39d-638b-49c5-9328-79efa034e9a4": "big_foot",
  "c2f1d5d7-074b-405d-be4c-df52cd52166a": "nonna",
  "121cd5ae-7df7-4ea3-a389-401a9463db52": "edna",
  "f1abe833-b44c-4650-a01c-191b9c3c43b8": "tony",
};
const thumbOf = (id) =>
  THUMBS[id] ? `https://docs.simli.com/images/${THUMBS[id]}.png` : null;

async function listFaces() {
  const out = [];
  for (const pair of String(process.env.SIMLI_FACES || "").split(",")) {
    const i = pair.indexOf(":");
    if (i > 0) {
      const id = pair.slice(0, i).trim();
      out.push({
        id,
        name: pair.slice(i + 1).trim() || "Face",
        thumb: thumbOf(id),
      });
    }
  }
  try {
    const res = await fetch(`${API}/faces`, {
      headers: { "x-simli-api-key": process.env.SIMLI_API_KEY },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const custom = await res.json();
      for (const f of Array.isArray(custom) ? custom : []) {
        const id = f.faceId || f.id;
        if (id && !out.some((o) => o.id === id)) {
          out.push({ id, name: f.faceName || f.name || "Custom face" });
        }
      }
    }
  } catch (_) {}
  return out;
}

module.exports = { createSessionToken, SimliConnection, configured, faceId, listFaces, IN_RATE, OUT_RATE };
