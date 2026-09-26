/**
 * SEND MESSAGES AS YOU — the rows behind the identity video and the
 * video notes made from it.
 * ----------------------------------------------------------------------
 * The owner, 2026-09-26: "in the You page there we have send message as
 * you… one record icon he should click and read that text, that text
 * should go like a lyric… once he complete that he should click on save
 * button, that should be saved on my backend". Then: "send a video note
 * for Danush saying he should meet me at twelve PM" — the assistant writes
 * the script, and (no GPU yet) the owner makes the talking clip by hand in
 * Colab from the user's 30 s video, uploads it in the admin panel, and it
 * reaches Danush.
 *
 * Two tables, and neither holds bytes — the media live behind
 * storage/media.js, by key:
 *
 *   avatar_profiles  one row per user: consent (when, which wording), the
 *                    "send as you" switch, and the key of their recorded
 *                    identity video (plus the photo / voice sample that
 *                    builds <= 117 still upload).
 *   avatar_renders   one row per video note: who asked, for whom, the
 *                    script, where it is in the manual pipeline, and how
 *                    it was delivered. The owner's waiting is a STATUS
 *                    here, not a job: the jobs queue retries three times
 *                    and reaps 'running' rows at boot, and a person in
 *                    Colab is neither.
 *
 * Both names were reserved in routes/privacy.js USER_TABLES on 2026-09-05,
 * so the account eraser and the export already cover the rows.
 */
const { query, one, run, tx } = require("../db");

async function migrate(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS avatar_profiles (
      user_id           INTEGER PRIMARY KEY,
      -- CONSENT, enforced here and not in the app. A face and a voice are
      -- biometric data under the DPDP Act; "they tapped the feature" is
      -- not informed consent, and an old build or a replayed request would
      -- walk past a consent screen that only lives on the phone.
      consented         INTEGER NOT NULL DEFAULT 0,
      consented_at      BIGINT,
      consent_version   TEXT    NOT NULL DEFAULT '',
      enabled           INTEGER NOT NULL DEFAULT 0,
      -- The one identity video. The app records it live with the front
      -- camera and offers no gallery — but the server cannot tell a live
      -- take from any MP4 a signed-in client posts, so the real check is
      -- the owner watching it read the consent sentence (identity_checked_*
      -- on each note, and the admin Video notes page).
      video_key         TEXT    NOT NULL DEFAULT '',
      video_id          TEXT    NOT NULL DEFAULT '',
      video_mime        TEXT    NOT NULL DEFAULT '',
      video_bytes       BIGINT  NOT NULL DEFAULT 0,
      video_duration_ms INTEGER NOT NULL DEFAULT 0,
      video_created_at  BIGINT,
      -- Which teleprompter wording they read — it carries a spoken consent
      -- sentence, so the version is part of the consent record.
      script_version    INTEGER NOT NULL DEFAULT 0,
      -- Builds <= 117 upload a photo and a voice sample instead.
      face_key          TEXT    NOT NULL DEFAULT '',
      voice_key         TEXT    NOT NULL DEFAULT '',
      updated_at        BIGINT  NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS avatar_renders (
      id                BIGSERIAL PRIMARY KEY,
      user_id           INTEGER NOT NULL,             -- the sender
      recipient_name    TEXT    NOT NULL DEFAULT '',
      recipient_phone   TEXT    NOT NULL DEFAULT '',  -- E.164
      -- Who held that number when the note was asked for. Delivery goes to
      -- an app user only if they STILL hold it, so a number that changed
      -- hands in between never carries someone's face to a stranger.
      recipient_user_id INTEGER,
      script            TEXT    NOT NULL,
      language          TEXT    NOT NULL DEFAULT '',
      -- pending → generated → delivered, or failed / cancelled.
      status            TEXT    NOT NULL DEFAULT 'pending',
      source_video_key  TEXT    NOT NULL DEFAULT '',
      -- What the take was read from and agreed to, copied from the profile
      -- when the note is asked for, so the admin page shows the owner the
      -- exact consent sentence the person in the clip should be saying.
      script_version    INTEGER NOT NULL DEFAULT 0,
      consent_version   TEXT    NOT NULL DEFAULT '',
      -- THE OWNER'S CHECKPOINT. He confirms he watched source_video_key
      -- and it is the account holder reading that sentence; no clip is
      -- stored until he has, for THIS take (a re-record needs a new look).
      identity_checked_at  BIGINT,
      identity_checked_key TEXT NOT NULL DEFAULT '',
      output_key        TEXT    NOT NULL DEFAULT '',
      output_bytes      BIGINT  NOT NULL DEFAULT 0,
      error             TEXT    NOT NULL DEFAULT '',
      -- How it went out, in words the admin page shows as they are.
      note              TEXT    NOT NULL DEFAULT '',
      delivered_to      TEXT    NOT NULL DEFAULT '',  -- 'recipient' | 'sender'
      document_id       BIGINT,                       -- the delivered copy
      message_id        BIGINT,                       -- agent_messages row, app users only
      created_at        BIGINT  NOT NULL,
      updated_at        BIGINT  NOT NULL,
      delivered_at      BIGINT
    );
    -- For a table made before these columns (local databases built while
    -- this feature was written); a no-op everywhere else.
    ALTER TABLE avatar_renders ADD COLUMN IF NOT EXISTS script_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE avatar_renders ADD COLUMN IF NOT EXISTS consent_version TEXT NOT NULL DEFAULT '';
    ALTER TABLE avatar_renders ADD COLUMN IF NOT EXISTS identity_checked_at BIGINT;
    ALTER TABLE avatar_renders ADD COLUMN IF NOT EXISTS identity_checked_key TEXT NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS idx_avatar_renders_status ON avatar_renders (status, id DESC);
    CREATE INDEX IF NOT EXISTS idx_avatar_renders_user ON avatar_renders (user_id, id DESC);
  `);
}

/* ------------------------------------------------------------------ */
/* Constants the routes and the tool share                              */
/* ------------------------------------------------------------------ */

const CONSENT_VERSION = "v1";

/** The teleprompter wording the current app build shows. */
function scriptVersion() {
  const n = Number(process.env.IDENTITY_SCRIPT_VERSION);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/**
 * What the app's teleprompter asked them to read, by script_version: the
 * same words as `identityScript` in the app's
 * lib/screens/identity_record_screen.dart (a new wording there is a new
 * version here). The admin page shows it beside the sender's video.
 *
 * WHY THE SERVER NEEDS IT. POST /avatar-profile/video takes any MP4 a
 * signed-in client sends — curl included — and nothing in the bytes says
 * "recorded live in the app". The one person who sees every clip is the
 * owner, in Colab; the consent sentence said on camera by the account
 * holder is what he checks before any clip is made (review, 2026-09-26).
 */
const TELEPROMPTER = {
  1: {
    consent:
      "I'm recording this so my assistant can make video messages in my voice, only when I ask.",
    text:
      "I'm recording this so my assistant can make video messages in my voice, only when I ask. " +
      "Hello there! It's a bright, breezy morning and I'm feeling really good. Could we meet on " +
      "Thursday at half past four, or maybe at five fifteen, near the old blue bridge? I'll bring " +
      "the three books, some fresh juice and my umbrella, just in case. Thank you so much. See " +
      "you soon, and take care!",
  },
};
const teleprompter = (version) => TELEPROMPTER[Number(version)] || null;

const STATUSES = ["pending", "generated", "delivered", "failed", "cancelled"];
/**
 * Everything not yet out of the door. 'failed' is in it: a failed note
 * can still be uploaded again, so a withdrawal that left it alone let a
 * clip in someone's face reach the recipient after they said no (review,
 * 2026-09-26).
 */
const UNDELIVERED = ["pending", "generated", "failed"];

/**
 * May this sender's face be used right now? 'withdrawn' (no row, or
 * consent taken back — their notes are cancelled), 'off' (they switched
 * "send as you" off; a waiting note waits), or 'ok'. Checked when a clip
 * is stored and again when it is delivered, not only when it was asked
 * for: consent is a present-tense yes.
 */
function senderGate(profile) {
  if (!profile || Number(profile.consented) !== 1) return "withdrawn";
  if (Number(profile.enabled) !== 1) return "off";
  return "ok";
}

const refusal = (reason, row = null) => ({ refused: reason, row });

/* ------------------------------------------------------------------ */
/* avatar_profiles                                                      */
/* ------------------------------------------------------------------ */

async function getProfile(userId) {
  return one(`SELECT * FROM avatar_profiles WHERE user_id = $1`, [userId]);
}

const ms = (v) => (v === null || v === undefined ? null : Number(v));

/** GET /avatar-profile's shape. A user with no row gets all false/null. */
function toClient(row) {
  const r = row || {};
  const hasVideo = Boolean(r.video_key);
  return {
    consented: Number(r.consented) === 1,
    consented_at: Number(r.consented) === 1 ? ms(r.consented_at) : null,
    enabled: Number(r.enabled) === 1,
    has_video: hasVideo,
    video: hasVideo
      ? {
          id: r.video_id,
          duration_ms: Number(r.video_duration_ms) || 0,
          bytes: Number(r.video_bytes) || 0,
          created_at: ms(r.video_created_at),
          script_version: Number(r.script_version) || 0,
        }
      : null,
    has_face: Boolean(r.face_key),
    has_voice: Boolean(r.voice_key),
    script_version: scriptVersion(),
  };
}

async function setConsent(userId, on) {
  const now = Date.now();
  if (on) {
    await run(
      `INSERT INTO avatar_profiles (user_id, consented, consented_at, consent_version, updated_at)
       VALUES ($1, 1, $2, $3, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET consented = 1, consented_at = $2, consent_version = $3, updated_at = $2`,
      [userId, now, CONSENT_VERSION]
    );
  } else {
    // Withdrawn: no more notes in their face, and the switch goes off
    // with it so a later re-consent is a deliberate second step.
    await run(
      `UPDATE avatar_profiles SET consented = 0, enabled = 0, updated_at = $2 WHERE user_id = $1`,
      [userId, now]
    );
  }
}

async function setEnabled(userId, on) {
  return run(
    `UPDATE avatar_profiles SET enabled = $2, updated_at = $3 WHERE user_id = $1`,
    [userId, on ? 1 : 0, Date.now()]
  );
}

/**
 * Records a new identity video and returns the key it replaced, which the
 * caller deletes AFTER this commits. Row-locked, so two uploads racing
 * each other both end with one video on disk and none leaked: each sees
 * the other's key as the one it replaced.
 *
 * Consent is read under the same lock, BEFORE anything changes: checked
 * only after the commit, a withdrawal during a slow upload left the row
 * pointing at a file the route had just deleted and the old take on disk
 * with nothing pointing at it (review, 2026-09-26). Throws a 403-marked
 * error; the caller deletes the file it stored.
 *
 * @returns {{ prevKey: string, first: boolean, row: object }}
 */
async function setVideo(userId, v) {
  return tx(async (c) => {
    const cur = (await c.query(
      `SELECT video_key, consented FROM avatar_profiles WHERE user_id = $1 FOR UPDATE`, [userId]
    )).rows[0];
    if (!cur || Number(cur.consented) !== 1) throw consentRequired();
    const prevKey = cur.video_key || "";
    const now = Date.now();
    const row = (await c.query(
      `UPDATE avatar_profiles
          SET video_key = $2, video_id = $3, video_mime = $4, video_bytes = $5,
              video_duration_ms = $6, video_created_at = $7, script_version = $8,
              -- The first saved video switches "send as you" on; after that
              -- the user's own choice stands.
              enabled = CASE WHEN video_key = '' THEN 1 ELSE enabled END,
              updated_at = $7
        WHERE user_id = $1
        RETURNING *`,
      [userId, v.key, v.id, v.mime, v.bytes, v.durationMs, now, v.scriptVersion]
    )).rows[0];
    // A note still to be made (waiting, or failed and uploadable again)
    // is made from the NEW take — the old file is about to be deleted.
    // Its identity check was for the old take, so it no longer matches.
    await c.query(
      `UPDATE avatar_renders SET source_video_key = $2, script_version = $3, updated_at = $4
        WHERE user_id = $1 AND status IN ('pending', 'failed')`,
      [userId, v.key, v.scriptVersion, now]
    );
    return { prevKey, first: !prevKey, row };
  });
}

const consentRequired = () => Object.assign(new Error("consent_required"), { http: 403 });

/**
 * Face photo / voice sample from builds <= 117. Returns the replaced key.
 * Consent under the row lock, as in setVideo: a photo landing after
 * "Delete everything" or a withdrawal is refused, not stored unreferenced.
 */
async function setAsset(userId, kind, key) {
  const col = kind === "face" ? "face_key" : "voice_key";
  return tx(async (c) => {
    const cur = (await c.query(
      `SELECT ${col} AS k, consented FROM avatar_profiles WHERE user_id = $1 FOR UPDATE`, [userId]
    )).rows[0];
    if (!cur || Number(cur.consented) !== 1) throw consentRequired();
    await c.query(
      `UPDATE avatar_profiles SET ${col} = $2, updated_at = $3 WHERE user_id = $1`,
      [userId, key, Date.now()]
    );
    return cur?.k || "";
  });
}

async function deleteProfile(userId) {
  return one(`DELETE FROM avatar_profiles WHERE user_id = $1 RETURNING *`, [userId]);
}

/* ------------------------------------------------------------------ */
/* avatar_renders                                                       */
/* ------------------------------------------------------------------ */

async function createRender(r) {
  const now = Date.now();
  return one(
    `INSERT INTO avatar_renders
       (user_id, recipient_name, recipient_phone, recipient_user_id, script,
        language, status, source_video_key, script_version, consent_version,
        created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$10) RETURNING *`,
    [r.userId, String(r.recipientName || "").slice(0, 120), r.recipientPhone || "",
     r.recipientUserId || null, r.script, String(r.language || "").slice(0, 40),
     r.sourceKey || "", Number(r.scriptVersion) || 0, String(r.consentVersion || ""), now]
  );
}

/**
 * The note send_video_note queues: made from the profile AS IT IS NOW,
 * under a share lock, or not at all (null). The tool reads the profile
 * earlier to choose its words, and a withdrawal or "Delete everything" in
 * between must not leave a note waiting with no consent behind it.
 */
async function createRenderFromProfile(r) {
  return tx(async (c) => {
    const p = (await c.query(
      `SELECT * FROM avatar_profiles WHERE user_id = $1 FOR SHARE`, [r.userId]
    )).rows[0];
    if (senderGate(p) !== "ok" || !p.video_key) return null;
    const now = Date.now();
    return (await c.query(
      `INSERT INTO avatar_renders
         (user_id, recipient_name, recipient_phone, recipient_user_id, script,
          language, status, source_video_key, script_version, consent_version,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$10) RETURNING *`,
      [r.userId, String(r.recipientName || "").slice(0, 120), r.recipientPhone || "",
       r.recipientUserId || null, r.script, String(r.language || "").slice(0, 40),
       p.video_key, Number(p.script_version) || 0, p.consent_version || "", now]
    )).rows[0];
  });
}

async function getRender(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return one(`SELECT * FROM avatar_renders WHERE id = $1`, [n]);
}

/** Only the columns named here can be patched — never from a request body. */
const PATCHABLE = new Set([
  "status", "output_key", "output_bytes", "error", "note", "delivered_to",
  "document_id", "message_id", "delivered_at", "source_video_key",
]);
async function updateRender(id, patch) {
  const keys = Object.keys(patch).filter((k) => PATCHABLE.has(k));
  if (!keys.length) return getRender(id);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  return one(
    `UPDATE avatar_renders SET ${sets.join(", ")}, updated_at = $${keys.length + 2}
      WHERE id = $1 RETURNING *`,
    [Number(id), ...keys.map((k) => patch[k]), Date.now()]
  );
}

/**
 * Moves a render from one of `from` to `to` — atomically, so an admin
 * upload racing the sender's "delete everything" cannot deliver a note
 * that was cancelled a moment earlier. Null when it was not in `from`.
 */
async function transition(id, from, to, patch = {}) {
  const keys = Object.keys(patch).filter((k) => PATCHABLE.has(k) && k !== "status");
  const sets = [`status = $3`, ...keys.map((k, i) => `${k} = $${i + 4}`)];
  return one(
    `UPDATE avatar_renders SET ${sets.join(", ")}, updated_at = $${keys.length + 4}
      WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
    [Number(id), from, to, ...keys.map((k) => patch[k]), Date.now()]
  );
}

/**
 * Cancels every note of this sender not yet delivered — failed ones too —
 * and returns those rows.
 */
async function cancelOpen(userId, reason) {
  return query(
    `UPDATE avatar_renders SET status = 'cancelled', error = $2, updated_at = $3
      WHERE user_id = $1 AND status = ANY($4::text[]) RETURNING *`,
    [userId, String(reason || "").slice(0, 300), Date.now(), UNDELIVERED]
  );
}

/**
 * The note and its sender's profile, locked for one decision: the profile
 * FOR SHARE (a withdrawal or "Delete everything" waits for this commit, or
 * this sees it), then the note FOR UPDATE (two uploads, or an upload and a
 * cancel, take turns). Profile first, as setVideo does, so the two never
 * wait on each other in opposite order. Returns a refusal, or {row}.
 */
async function lockForChange(c, id, from) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return refusal("missing");
  const who = (await c.query(`SELECT user_id FROM avatar_renders WHERE id = $1`, [n])).rows[0];
  if (!who) return refusal("missing");
  const p = (await c.query(
    `SELECT consented, enabled FROM avatar_profiles WHERE user_id = $1 FOR SHARE`, [who.user_id]
  )).rows[0];
  const r = (await c.query(`SELECT * FROM avatar_renders WHERE id = $1 FOR UPDATE`, [n])).rows[0];
  if (!r) return refusal("missing");
  if (!from.includes(r.status)) return refusal(r.status, r);
  const gate = senderGate(p);
  if (gate !== "ok") return refusal(gate, r);
  return { row: r };
}

/**
 * Attaches the owner's uploaded clip (already stored under `key`) and
 * marks the note generated — only while the sender still consents and
 * the owner has confirmed THIS take is them.
 *
 * @returns {{ row, prevKey } | { refused, row }} prevKey is the clip it
 *   replaced, for the caller to delete after this commits.
 */
async function attachOutput(id, key, bytes) {
  return tx(async (c) => {
    const got = await lockForChange(c, id, UNDELIVERED);
    if (got.refused) return got;
    const r = got.row;
    if (!r.identity_checked_at || !r.source_video_key || r.identity_checked_key !== r.source_video_key) {
      return refusal("unchecked", r);
    }
    const row = (await c.query(
      `UPDATE avatar_renders
          SET status = 'generated', output_key = $2, output_bytes = $3, error = '', updated_at = $4
        WHERE id = $1 RETURNING *`,
      [r.id, key, bytes, Date.now()]
    )).rows[0];
    return { row, prevKey: r.output_key || "" };
  });
}

/**
 * generated → delivered, with the sender's consent re-read under lock.
 * The copy and the inbox row already exist; on a refusal the caller takes
 * them back.
 */
async function finishDelivery(id, patch) {
  return tx(async (c) => {
    const got = await lockForChange(c, id, ["generated"]);
    if (got.refused) return got;
    const keys = Object.keys(patch).filter((k) => PATCHABLE.has(k) && k !== "status");
    const sets = [`status = 'delivered'`, ...keys.map((k, i) => `${k} = $${i + 2}`)];
    const row = (await c.query(
      `UPDATE avatar_renders SET ${sets.join(", ")}, updated_at = $${keys.length + 2}
        WHERE id = $1 RETURNING *`,
      [got.row.id, ...keys.map((k) => patch[k]), Date.now()]
    )).rows[0];
    return { row };
  });
}

/**
 * The owner watched the sender's video: it is the account holder, reading
 * the consent sentence. Recorded against the take he watched, so a
 * re-record (setVideo repoints the note) needs a fresh look.
 */
async function markIdentityChecked(id) {
  return tx(async (c) => {
    const got = await lockForChange(c, id, ["pending", "failed"]);
    if (got.refused) return got;
    if (!got.row.source_video_key) return refusal("no_video", got.row);
    const row = (await c.query(
      `UPDATE avatar_renders
          SET identity_checked_at = $2, identity_checked_key = source_video_key, updated_at = $2
        WHERE id = $1 RETURNING *`,
      [got.row.id, Date.now()]
    )).rows[0];
    return { row };
  });
}

/** The admin queue, newest first, with who sent each one. */
async function listRenders({ status = "", limit = 50, offset = 0 } = {}) {
  const params = [];
  let where = "";
  if (STATUSES.includes(status)) {
    params.push(status);
    where = `WHERE r.status = $1`;
  }
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  params.push(Math.max(Number(offset) || 0, 0));
  return query(
    `SELECT r.*, u.name AS sender_name, u.phone_number AS sender_phone,
            ru.id AS recipient_now_id,
            p.consented AS sender_consented, p.enabled AS sender_enabled
       FROM avatar_renders r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN avatar_profiles p ON p.user_id = r.user_id
       LEFT JOIN users ru ON ru.phone_number = NULLIF(r.recipient_phone, '')
                         AND ru.phone_verified_at IS NOT NULL
       ${where}
      ORDER BY r.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
}

async function countByStatus() {
  const rows = await query(`SELECT status, count(*)::int AS n FROM avatar_renders GROUP BY status`);
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of rows) out[r.status] = r.n;
  return out;
}

module.exports = {
  migrate,
  CONSENT_VERSION, STATUSES, UNDELIVERED, scriptVersion, teleprompter, senderGate,
  getProfile, toClient, setConsent, setEnabled, setVideo, setAsset, deleteProfile,
  createRender, createRenderFromProfile, getRender, updateRender, transition, cancelOpen,
  attachOutput, finishDelivery, markIdentityChecked, listRenders, countByStatus,
};
