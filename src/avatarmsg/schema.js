/**
 * PERSONALIZED AVATAR MESSAGES — schema.
 *
 * Two tables plus three columns on agent_messages:
 *
 *   avatar_profiles   one row per user: their OWN face photo + voice sample
 *                     and the consent that authorises us to synthesise them.
 *                     A user can only ever create/modify THEIR OWN row — the
 *                     sender's profile is the only identity a render may
 *                     use, which is what makes impersonation structurally
 *                     impossible rather than merely forbidden.
 *
 *   avatar_renders    one row per generation attempt — the traceable record
 *                     (§20-style): request id, provider used at each stage,
 *                     stage timings (TTFA / TTFF), status, failure reason.
 *                     No raw audio/video is ever logged; only file paths.
 *
 *   agent_messages    gains render_id/media_kind so the recipient's inbox
 *                     can say "this message has a face/voice attached".
 */
async function migrate(q) {
  await q(`
    CREATE TABLE IF NOT EXISTS avatar_profiles (
      user_id          INTEGER PRIMARY KEY,
      -- Consent is explicit, versioned and timestamped. NULL means the
      -- feature is OFF for this user no matter what else is set.
      consent_at       BIGINT,
      consent_version  TEXT NOT NULL DEFAULT '',
      enabled          BOOLEAN NOT NULL DEFAULT TRUE,
      -- Identity assets live on disk under DATA_DIR/avatar (never public);
      -- rows carry paths + mimes only.
      face_path        TEXT NOT NULL DEFAULT '',
      face_mime        TEXT NOT NULL DEFAULT '',
      voice_path       TEXT NOT NULL DEFAULT '',
      voice_mime       TEXT NOT NULL DEFAULT '',
      -- Provider-side voice handle (e.g. ElevenLabs voice_id) when a
      -- managed cloner is in use. Self-host cloning is zero-shot per
      -- render, so it needs no stored handle.
      voice_provider   TEXT NOT NULL DEFAULT '',
      voice_ref        TEXT NOT NULL DEFAULT '',
      quality          TEXT NOT NULL DEFAULT 'standard',  -- standard | high
      updated_at       BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS avatar_renders (
      id               BIGSERIAL PRIMARY KEY,
      request_id       TEXT NOT NULL,
      message_id       BIGINT,                -- agent_messages.id
      from_user_id     INTEGER NOT NULL,
      to_phone_number  TEXT NOT NULL DEFAULT '',
      text_len         INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'pending',
                       -- pending | rendering | video | audio | text | failed
      failure_reason   TEXT NOT NULL DEFAULT '',
      voice_provider   TEXT NOT NULL DEFAULT '',
      face_provider    TEXT NOT NULL DEFAULT '',
      created_at       BIGINT NOT NULL,
      tts_started_at   BIGINT,
      first_audio_at   BIGINT,               -- TTS finished (TTFA)
      render_started_at BIGINT,
      first_frame_at   BIGINT,               -- video ready (TTFF proxy)
      completed_at     BIGINT,
      audio_ms         INTEGER,              -- spoken duration
      media_path       TEXT NOT NULL DEFAULT '',
      media_mime       TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_avatar_renders_msg ON avatar_renders(message_id);
    CREATE INDEX IF NOT EXISTS idx_avatar_renders_user
      ON avatar_renders(from_user_id, created_at DESC);

    ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS render_id  BIGINT;
    ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS media_kind TEXT NOT NULL DEFAULT '';
  `);
}

module.exports = { migrate };
