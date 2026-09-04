/**
 * AVATAR MESSAGE ORCHESTRATOR — turns "tell John I'll be late" into John
 * seeing Alice's face speak the words in Alice's voice.
 *
 * The pipeline is two independent stages, each with its own fallback
 * chain, so a dead engine degrades the experience instead of killing it:
 *
 *   VOICE  selfhost worker (Chatterbox zero-shot clone)   ← cheapest, cloned
 *          → ElevenLabs IVC (needs profile.voice_ref)     ← managed, cloned
 *          → Gemini TTS (assistant's stock voice)          ← always there
 *
 *   FACE   selfhost worker (MuseTalk)                      ← cheapest
 *          → D-ID (photo lip-sync)                         ← managed
 *          → none (audio-only message)
 *
 * Fallback ladder for the delivered artifact:
 *   video (face+voice) → audio (voice only) → plain text (the row that was
 *   already inserted — delivery is NEVER blocked on generation).
 *
 * The text row is inserted by send_agent_message BEFORE this runs; exactly
 * ONE push goes out, after generation settles (success, fallback or
 * failure), so the recipient is never notified twice and never waits on a
 * GPU to hear their message.
 */
const crypto = require("crypto");
const store = require("./store");
const obs = require("../infra/observability");

const selfhost = require("./providers/selfhost");
const elevenlabs = require("./providers/elevenlabs");
const gemini = require("./providers/gemini");
const did = require("./providers/did");

const DAILY_LIMIT = () => Number(process.env.AVATAR_MSG_DAILY_LIMIT || 50);
const MAX_TEXT = 1200; // matches /tts guard — one message, not an audiobook

const log = (level, msg, extra) =>
  console.log(JSON.stringify({ level, mod: "avatarmsg", msg, ...extra }));

/** Is the personalized-avatar feature usable AT ALL on this deployment? */
function anyEngineConfigured() {
  return (
    selfhost.configured() ||
    did.configured() ||
    elevenlabs.configured() ||
    gemini.configured()
  );
}

/** What the sender's app shows in settings: per-stage availability. */
async function status() {
  const worker = await selfhost.health();
  return {
    enabled: anyEngineConfigured(),
    voice: {
      selfhost: Boolean(worker?.ok && worker?.engines?.tts),
      elevenlabs: elevenlabs.configured(),
      gemini: gemini.configured(),
    },
    face: {
      selfhost: Boolean(worker?.ok && worker?.engines?.face),
      did: did.configured(),
    },
  };
}

/* --------------------------- stage runners --------------------------- */

async function runVoice({ text, profile, language }) {
  const cloned = Boolean(profile?.voice_path);
  // Each entry: [providerName, cloned?, fn]
  const chain = [];
  if (selfhost.configured() && cloned) {
    chain.push([
      "selfhost",
      true,
      () =>
        selfhost.synthesize({
          text,
          voicePath: profile.voice_path,
          voiceMime: profile.voice_mime,
          language,
        }),
    ]);
  }
  if (
    elevenlabs.configured() &&
    profile?.voice_provider === "elevenlabs" &&
    profile?.voice_ref
  ) {
    chain.push([
      "elevenlabs",
      true,
      () => elevenlabs.synthesize({ text, voiceRef: profile.voice_ref }),
    ]);
  }
  if (gemini.configured()) {
    chain.push(["gemini", false, () => gemini.synthesize({ text, language })]);
  }

  for (const [name, isClone, fn] of chain) {
    try {
      const t0 = Date.now();
      const out = await fn();
      obs.observe(`avatarmsg.voice.${name}`, Date.now() - t0);
      return { ...out, provider: name, cloned: isClone };
    } catch (e) {
      obs.count(`avatarmsg.voice.${name}.fail`);
      log("warn", `voice stage ${name} failed`, { error: e.message });
    }
  }
  return null;
}

async function runFace({ profile, audio, quality }) {
  const chain = [];
  if (selfhost.configured()) {
    chain.push([
      "selfhost",
      () =>
        selfhost.animate({
          facePath: profile.face_path,
          faceMime: profile.face_mime,
          audioBuf: audio.buf,
          audioMime: audio.mime,
          quality,
        }),
    ]);
  }
  if (did.configured()) {
    chain.push([
      "did",
      () =>
        did.animate({
          facePath: profile.face_path,
          faceMime: profile.face_mime,
          audioBuf: audio.buf,
          audioMime: audio.mime,
        }),
    ]);
  }

  for (const [name, fn] of chain) {
    try {
      const t0 = Date.now();
      const out = await fn();
      obs.observe(`avatarmsg.face.${name}`, Date.now() - t0);
      return { ...out, provider: name };
    } catch (e) {
      obs.count(`avatarmsg.face.${name}.fail`);
      log("warn", `face stage ${name} failed`, { error: e.message });
    }
  }
  return null;
}

/* ----------------------------- the pipeline ----------------------------- */

/**
 * Generate media for an already-queued agent message, then send the ONE
 * push. Never throws; always ends in a push attempt (plain text at worst).
 *
 * @param {object} p
 *   messageId       agent_messages.id of the inserted text row
 *   fromUserId      sender (whose identity assets are used — nobody else's)
 *   fromUserName    for the push title
 *   toPhone         recipient's E.164 (ownership check for media fetch)
 *   text            the generated message
 *   fcmToken        recipient's device (may be empty → inbox-only delivery)
 *   language        optional 2-letter hint for TTS
 */
async function generateForMessage(p) {
  const push = require("../services/push");
  const db = require("../db");
  const requestId = crypto.randomUUID();

  const finishPlain = async () => {
    if (!p.fcmToken) return;
    await push.sendNotification(
      p.fcmToken,
      p.fromUserName ? `${p.fromUserName} sent you a message` : "You have a new message",
      "Open the app and your assistant will read it to you.",
      { kind: "agent_message" }
    );
  };

  let renderId = null;
  try {
    const profile = await store.getProfile(p.fromUserId);

    // Gate: consent + enabled + face on file + engines + sane text + cap.
    // No consent (or no profile) = the feature silently does not exist for
    // this sender; the message still arrives as text, exactly as before.
    if (!store.renderable(profile) || !anyEngineConfigured()) return finishPlain();
    if (!p.text || p.text.length > MAX_TEXT) return finishPlain();
    if ((await store.rendersToday(p.fromUserId)) >= DAILY_LIMIT()) {
      log("warn", "daily render cap hit", { user: p.fromUserId });
      return finishPlain();
    }

    renderId = await store.createRender({
      requestId,
      messageId: p.messageId,
      fromUserId: p.fromUserId,
      toPhone: p.toPhone,
      textLen: p.text.length,
    });
    obs.count("avatarmsg.requested");
    const t0 = Date.now();
    await store.updateRender(renderId, { status: "rendering", tts_started_at: t0 });

    // VOICE stage.
    const audio = await runVoice({ text: p.text, profile, language: p.language });
    if (!audio) {
      await store.updateRender(renderId, {
        status: "text",
        failure_reason: "no voice engine available",
        completed_at: Date.now(),
      });
      return finishPlain();
    }
    const firstAudioAt = Date.now();
    await store.updateRender(renderId, {
      first_audio_at: firstAudioAt,
      voice_provider: audio.provider,
      render_started_at: firstAudioAt,
    });

    // FACE stage.
    const video = await runFace({ profile, audio, quality: profile.quality });

    const media = video || audio;
    const mediaPath = await store.saveRender(renderId, media.buf, media.mime);
    const completedAt = Date.now();
    await store.updateRender(renderId, {
      status: video ? "video" : "audio",
      face_provider: video ? video.provider : "",
      first_frame_at: video ? completedAt : null,
      completed_at: completedAt,
      media_path: mediaPath,
      media_mime: media.mime,
    });
    await db.run(
      `UPDATE agent_messages SET render_id = $1, media_kind = $2 WHERE id = $3`,
      [renderId, video ? "video" : "audio", p.messageId]
    );
    obs.observe("avatarmsg.total", completedAt - t0);
    obs.count(`avatarmsg.delivered.${video ? "video" : "audio"}`);
    log("info", "render complete", {
      requestId,
      renderId,
      status: video ? "video" : "audio",
      voice: audio.provider,
      cloned: audio.cloned,
      face: video?.provider || null,
      ttfaMs: firstAudioAt - t0,
      totalMs: completedAt - t0,
    });

    if (p.fcmToken) {
      await push.sendNotification(
        p.fcmToken,
        p.fromUserName
          ? `${p.fromUserName} sent you a ${video ? "video" : "voice"} message`
          : `You have a new ${video ? "video" : "voice"} message`,
        "Tap to see it.",
        { kind: "agent_message", avatar: "1", media: video ? "video" : "audio" }
      );
    }
  } catch (e) {
    obs.count("avatarmsg.failed");
    log("error", "render failed", { requestId, error: e.message });
    if (renderId) {
      await store
        .updateRender(renderId, {
          status: "failed",
          failure_reason: String(e.message).slice(0, 300),
          completed_at: Date.now(),
        })
        .catch(() => {});
    }
    await finishPlain().catch(() => {});
  }
}

module.exports = { generateForMessage, status, anyEngineConfigured };
