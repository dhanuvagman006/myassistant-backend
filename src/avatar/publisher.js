/**
 * Publishes the assistant's voice into a LiveKit room so BEY's avatar
 * worker can render lips against it.
 *
 * Gemini Live hands us raw PCM16 mono @24 kHz in chunks of arbitrary
 * length. LiveKit wants whole SAMPLES, so two things must be defended:
 *
 *   1. A chunk can end mid-sample (odd byte count). That byte belongs to
 *      the next chunk — dropping it would shift every following sample by
 *      one byte and turn the voice into static. `_tail` carries it over.
 *   2. Buffers from the WS layer sit in a shared pool at an arbitrary
 *      byteOffset, so a zero-copy Int16Array view is not always legal
 *      (it requires 2-byte alignment). We copy instead — at 48 kB/s the
 *      copy is free, and a misaligned view would throw at runtime.
 *
 * captureFrame() applies backpressure once its queue is full, so captures
 * are chained rather than fired in parallel: overlapping them would let
 * frames reach the room out of order and desynchronise the mouth.
 */
const { AudioSource, LocalAudioTrack, Room, TrackPublishOptions, AudioFrame } =
  require("@livekit/rtc-node");
const { TrackSource, RoomEvent, TrackKind } = require("@livekit/rtc-node");

const SAMPLE_RATE = 24000; // Gemini Live output rate — do not change alone
const CHANNELS = 1;

class AvatarPublisher {
  constructor(room) {
    this.roomName = room;
    this.room = new Room();
    this.source = null;
    this.track = null;
    this._tail = Buffer.alloc(0);
    this._chain = Promise.resolve();
    this.closed = false;
    this.framesPushed = 0;

    // False until BEY actually publishes video. The live proxy routes the
    // assistant's voice on this flag, so it decides whether the user hears
    // a lip-synced avatar or plain audio — and, critically, whether they
    // hear ANYTHING. Audio sent to a room where no avatar ever rendered is
    // audio nobody hears, so this must stay false unless video is really
    // there. Only the BEY worker's own video counts.
    this.avatarReady = false;
    this.onReadyChange = null;
  }

  _setReady(v) {
    if (this.avatarReady === v) return;
    this.avatarReady = v;
    console.log(`avatar: ${this.roomName} video ${v ? "LIVE" : "gone"}`);
    try { this.onReadyChange?.(v); } catch (_) {}
  }

  async connect(url, token) {
    // autoSubscribe:false — we publish only. Pulling BEY's video back into
    // the backend would burn bandwidth for a stream nothing here decodes.
    // Watch for BEY's video BEFORE connecting, so a worker that is quick
    // off the mark cannot publish in the gap and go unnoticed.
    const isBeyVideo = (pub, participant) =>
      String(participant?.identity || "").startsWith("bey-") &&
      pub?.kind === TrackKind.KIND_VIDEO;

    this.room
      .on(RoomEvent.TrackPublished, (pub, p) => {
        if (isBeyVideo(pub, p)) this._setReady(true);
      })
      .on(RoomEvent.TrackUnpublished, (pub, p) => {
        if (isBeyVideo(pub, p)) this._setReady(false);
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        if (String(p?.identity || "").startsWith("bey-")) this._setReady(false);
      })
      .on(RoomEvent.Disconnected, () => this._setReady(false));

    await this.room.connect(url, token, { autoSubscribe: false, dynacast: false });
    this.source = new AudioSource(SAMPLE_RATE, CHANNELS);
    this.track = LocalAudioTrack.createAudioTrack("hari-voice", this.source);
    const opts = new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE });
    await this.room.localParticipant.publishTrack(this.track, opts);
  }

  /**
   * Queue one PCM16/24k chunk. Fire-and-forget by design: the live proxy
   * must never block Gemini's socket waiting on the room.
   */
  push(chunk) {
    if (this.closed || !this.source) return;

    const buf = this._tail.length ? Buffer.concat([this._tail, chunk]) : chunk;
    const usable = buf.length - (buf.length % 2);
    this._tail = usable === buf.length ? Buffer.alloc(0) : buf.subarray(usable);
    if (usable === 0) return;

    const samples = new Int16Array(usable / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(i * 2);

    const frame = new AudioFrame(samples, SAMPLE_RATE, CHANNELS, samples.length);
    this._chain = this._chain
      .then(() => (this.closed ? undefined : this.source.captureFrame(frame)))
      .then(() => { this.framesPushed++; })
      .catch((e) => {
        if (!this.closed) console.error(`avatar: capture failed (${e.message})`);
      });
  }

  /**
   * Barge-in. Gemini reports `interrupted` the instant the user talks
   * over the assistant; anything already queued is now stale, and playing
   * it out would leave the avatar mouthing a sentence that was abandoned.
   */
  interrupt() {
    this._tail = Buffer.alloc(0);
    try {
      this.source?.clearQueue();
    } catch (_) {}
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this._setReady(false);
    try { await this.track?.close(true); } catch (_) {}
    try { await this.source?.close(); } catch (_) {}
    try { await this.room.disconnect(); } catch (_) {}
  }
}

module.exports = { AvatarPublisher, SAMPLE_RATE, CHANNELS };
