/**
 * Avatar identity + render persistence.
 *
 * Files live under DATA_DIR/avatar/ — the same private volume the document
 * store uses. Nothing in here is ever served without appAuth plus an
 * ownership check; there are deliberately NO public or signed URLs for
 * identity assets (§10: no public avatar assets).
 *
 *   avatar/faces/{userId}.{ext}     the user's consented reference photo
 *   avatar/voices/{userId}.{ext}    the user's consented voice sample
 *   avatar/renders/{renderId}.{ext} generated message media (mp4 / wav)
 */
const fs = require("fs");
const path = require("path");
const db = require("../db");

const ROOT = path.join(process.env.DATA_DIR || "data", "avatar");

function dir(kind) {
  const d = path.join(ROOT, kind);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".m4a",
  "video/mp4": ".mp4",
};

/** Write an identity asset, replacing any previous one for this user. */
async function saveAsset(kind /* faces|voices */, userId, buf, mime) {
  const ext = EXT[mime];
  if (!ext) throw new Error(`unsupported ${kind} type: ${mime}`);
  const base = path.join(dir(kind), String(userId));
  // Remove stale files with other extensions so exactly one asset exists.
  for (const e of new Set(Object.values(EXT))) {
    try { fs.unlinkSync(base + e); } catch (_) {}
  }
  const p = base + ext;
  await fs.promises.writeFile(p, buf);
  return p;
}

async function saveRender(renderId, buf, mime) {
  const ext = EXT[mime] || ".bin";
  const p = path.join(dir("renders"), `${renderId}${ext}`);
  await fs.promises.writeFile(p, buf);
  return p;
}

/* ------------------------------ profiles ------------------------------ */

async function getProfile(userId) {
  return db.one(`SELECT * FROM avatar_profiles WHERE user_id = $1`, [
    Number(userId),
  ]);
}

/** Upsert helper — only the columns provided are touched. */
async function upsertProfile(userId, fields) {
  const cur = (await getProfile(userId)) || {};
  const v = (k, dflt) => (fields[k] !== undefined ? fields[k] : cur[k] ?? dflt);
  await db.run(
    `INSERT INTO avatar_profiles
       (user_id, consent_at, consent_version, enabled, face_path, face_mime,
        voice_path, voice_mime, voice_provider, voice_ref, quality, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (user_id) DO UPDATE SET
       consent_at = $2, consent_version = $3, enabled = $4,
       face_path = $5, face_mime = $6, voice_path = $7, voice_mime = $8,
       voice_provider = $9, voice_ref = $10, quality = $11, updated_at = $12`,
    [
      Number(userId),
      v("consent_at", null),
      v("consent_version", ""),
      v("enabled", true),
      v("face_path", ""),
      v("face_mime", ""),
      v("voice_path", ""),
      v("voice_mime", ""),
      v("voice_provider", ""),
      v("voice_ref", ""),
      v("quality", "standard"),
      Date.now(),
    ]
  );
  return getProfile(userId);
}

/** Secure deletion (§10): files first, then the row. */
async function deleteProfile(userId) {
  const p = await getProfile(userId);
  for (const f of [p?.face_path, p?.voice_path]) {
    if (f) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  await db.run(`DELETE FROM avatar_profiles WHERE user_id = $1`, [Number(userId)]);
}

/** Ready to render = consented + enabled + has a face photo. */
function renderable(profile) {
  return Boolean(profile && profile.consent_at && profile.enabled && profile.face_path);
}

/* ------------------------------- renders ------------------------------- */

async function createRender({ requestId, messageId, fromUserId, toPhone, textLen }) {
  const rows = await db.query(
    `INSERT INTO avatar_renders
       (request_id, message_id, from_user_id, to_phone_number, text_len,
        status, created_at)
     VALUES ($1,$2,$3,$4,$5,'pending',$6) RETURNING id`,
    [requestId, messageId ?? null, Number(fromUserId), toPhone || "", textLen | 0, Date.now()]
  );
  return rows[0].id;
}

async function updateRender(id, fields) {
  const cols = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    vals.push(v);
    cols.push(`${k} = $${vals.length}`);
  }
  vals.push(id);
  await db.run(
    `UPDATE avatar_renders SET ${cols.join(", ")} WHERE id = $${vals.length}`,
    vals
  );
}

async function getRender(id) {
  return db.one(`SELECT * FROM avatar_renders WHERE id = $1`, [Number(id)]);
}

/** Renders started by this user since midnight — the daily abuse cap. */
async function rendersToday(userId) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const rows = await db.query(
    `SELECT COUNT(*)::int AS n FROM avatar_renders
      WHERE from_user_id = $1 AND created_at >= $2`,
    [Number(userId), midnight.getTime()]
  );
  return rows[0]?.n || 0;
}

module.exports = {
  ROOT,
  saveAsset,
  saveRender,
  getProfile,
  upsertProfile,
  deleteProfile,
  renderable,
  createRender,
  updateRender,
  getRender,
  rendersToday,
};
