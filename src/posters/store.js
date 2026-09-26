/**
 * PHOTO CARDS — PERSISTENCE.
 * ----------------------------------------------------------------------
 * Three tables, none holding bytes. The photo files live in
 * DATA_DIR/files/<uid>/posters/<photoId>/ — inside the per-user folder
 * the account erase already removes whole (routes/privacy.js
 * removeUserDir), and OUTSIDE the documents vault on purpose: a daughter's
 * old photo picked for a card is not a document he saved, so it never
 * reaches search, memory, the gallery or a vision call. Only the finished
 * card (and a photo he asks to keep) becomes a document.
 *
 *   poster_consent  his yes to keeping family photos for cards, once.
 *   poster_photos   one row per picked photo: size, colour, variants.
 *   posters         the card: its spec (words and look), a 20-step undo
 *                   history, and a version for compare-and-swap edits —
 *                   the phone and the voice tools edit the same card, and
 *                   a stale edit must never silently undo a newer one.
 *
 * Every query is scoped by user_id: another user's id is simply "not
 * found". Created lazily, like studio/store.js; db.js is not touched.
 */
const { query, one, run } = require("../db");

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS poster_consent (
        user_id     INTEGER PRIMARY KEY,
        version     TEXT    NOT NULL,
        accepted_at BIGINT  NOT NULL
      );

      CREATE TABLE IF NOT EXISTS poster_photos (
        id           BIGSERIAL PRIMARY KEY,
        user_id      INTEGER NOT NULL,
        source       TEXT    NOT NULL DEFAULT 'gallery',
        width        INTEGER NOT NULL DEFAULT 0,
        height       INTEGER NOT NULL DEFAULT 0,
        colour       TEXT    NOT NULL DEFAULT 'keep',
        status       TEXT    NOT NULL DEFAULT 'ready',
        reason       TEXT,
        message      TEXT,
        variants     TEXT    NOT NULL DEFAULT 'original',
        orig_ext     TEXT    NOT NULL DEFAULT 'jpg',
        created_at   BIGINT  NOT NULL,
        updated_at   BIGINT  NOT NULL,
        last_used_at BIGINT  NOT NULL
      );
      CREATE INDEX IF NOT EXISTS poster_photos_user ON poster_photos (user_id, created_at DESC);
      -- A see-through picture laid on white (review, 2026-09-26): its
      -- clean-up reads the colours without that white, every time.
      ALTER TABLE poster_photos ADD COLUMN IF NOT EXISTS flattened BOOLEAN NOT NULL DEFAULT false;

      CREATE TABLE IF NOT EXISTS posters (
        id           BIGSERIAL PRIMARY KEY,
        user_id      INTEGER NOT NULL,
        occasion     TEXT    NOT NULL DEFAULT 'birthday',
        spec         JSONB   NOT NULL,
        history      JSONB   NOT NULL DEFAULT '[]'::jsonb,
        version      INTEGER NOT NULL DEFAULT 1,
        photo_id     BIGINT,
        final_doc_id INTEGER,
        created_at   BIGINT  NOT NULL,
        updated_at   BIGINT  NOT NULL
      );
      CREATE INDEX IF NOT EXISTS posters_user ON posters (user_id, updated_at DESC);
    `).catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

/* ---- consent ---- */

async function consentOf(userId) {
  await migrate();
  return one("SELECT version, accepted_at FROM poster_consent WHERE user_id = $1", [userId]);
}

async function setConsent(userId, version) {
  await migrate();
  await run(
    `INSERT INTO poster_consent (user_id, version, accepted_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET version = $2, accepted_at = $3`,
    [userId, version, Date.now()]
  );
}

async function deleteConsent(userId) {
  await migrate();
  return run("DELETE FROM poster_consent WHERE user_id = $1", [userId]);
}

/* ---- photos ---- */

async function insertPhoto(userId, { source, colour, reason = null }) {
  await migrate();
  const now = Date.now();
  return one(
    `INSERT INTO poster_photos (user_id, source, colour, status, reason, created_at, updated_at, last_used_at)
     VALUES ($1, $2, $3, 'ready', $4, $5, $5, $5) RETURNING *`,
    [userId, source, colour, reason, now]
  );
}

async function updatePhoto(userId, id, { width, height, colour, variants, origExt, flattened }) {
  await migrate();
  return one(
    `UPDATE poster_photos SET
       width = COALESCE($3, width), height = COALESCE($4, height),
       colour = COALESCE($5, colour), variants = COALESCE($6, variants),
       orig_ext = COALESCE($7, orig_ext), flattened = COALESCE($9, flattened),
       updated_at = $8, last_used_at = $8
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, width ?? null, height ?? null, colour ?? null,
     variants ? variants.join(",") : null, origExt ?? null, Date.now(),
     typeof flattened === "boolean" ? flattened : null]
  );
}

async function getPhoto(userId, id) {
  await migrate();
  if (!Number.isSafeInteger(Number(id))) return null;
  return one("SELECT * FROM poster_photos WHERE id = $1 AND user_id = $2", [Number(id), userId]);
}

async function touchPhoto(userId, id) {
  await migrate();
  if (!id) return;
  await run("UPDATE poster_photos SET last_used_at = $3 WHERE id = $1 AND user_id = $2",
    [Number(id), userId, Date.now()]);
}

async function deletePhotoRow(userId, id) {
  await migrate();
  return run("DELETE FROM poster_photos WHERE id = $1 AND user_id = $2", [Number(id), userId]);
}

/** `[{photoId: id}]`: what a history array containing this photo @> matches. */
const inHistory = (id) => JSON.stringify([{ photoId: Number(id) }]);

/** His cards that show this photo now, or could bring it back with undo. */
async function postersWithPhoto(userId, id) {
  await migrate();
  return query(
    "SELECT * FROM posters WHERE user_id = $1 AND (photo_id = $2 OR history @> $3::jsonb) ORDER BY id",
    [userId, Number(id), inHistory(id)]
  );
}

/** Does any card but `exceptPosterId` show this photo or keep it in its history? */
async function photoReferenced(userId, id, exceptPosterId = 0) {
  await migrate();
  return !!(await one(
    `SELECT 1 FROM posters WHERE user_id = $1 AND id <> $3
        AND (photo_id = $2 OR history @> $4::jsonb) LIMIT 1`,
    [userId, Number(id), Number(exceptPosterId) || 0, inHistory(id)]
  ));
}

/* ---- posters ---- */

async function insertPoster(userId, { spec, photoId = null }) {
  await migrate();
  const now = Date.now();
  return one(
    `INSERT INTO posters (user_id, occasion, spec, history, version, photo_id, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, '[]'::jsonb, 1, $4, $5, $5) RETURNING *`,
    [userId, spec.occasion, JSON.stringify(spec), photoId, now]
  );
}

async function getPoster(userId, id) {
  await migrate();
  if (!Number.isSafeInteger(Number(id))) return null;
  return one("SELECT * FROM posters WHERE id = $1 AND user_id = $2", [Number(id), userId]);
}

async function latestPoster(userId) {
  await migrate();
  return one("SELECT * FROM posters WHERE user_id = $1 ORDER BY updated_at DESC, id DESC LIMIT 1",
    [userId]);
}

/**
 * Compare-and-swap: writes only when the stored version is still
 * `expectVersion`. Returns the new row, or null when someone else won.
 */
async function casPoster(userId, id, expectVersion, { spec, history, photoId }) {
  await migrate();
  return one(
    `UPDATE posters SET spec = $4::jsonb, history = $5::jsonb, photo_id = $6,
       occasion = $7, version = version + 1, updated_at = $8
     WHERE id = $1 AND user_id = $2 AND version = $3 RETURNING *`,
    [Number(id), userId, Number(expectVersion), JSON.stringify(spec), JSON.stringify(history),
     photoId ?? null, spec.occasion, Date.now()]
  );
}

/**
 * Point the card at its new saved picture and hand back the one it
 * pointed at before, in ONE statement (review, 2026-09-26). Read and
 * written separately, two uploads at once (Share, then Save to Photos
 * while the first was still going) both read the same old copy, both
 * deleted it, and the loser's picture stayed in his documents with no
 * card pointing at it. FOR UPDATE makes the second wait, then read the
 * first one's picture as "before" — so exactly one copy is left.
 * @returns {Promise<{row:object, prevDocId:number|null}|null>}
 */
async function swapFinalDoc(userId, id, docId) {
  await migrate();
  const row = await one(
    `WITH old AS (
       SELECT id, final_doc_id FROM posters WHERE id = $1 AND user_id = $2 FOR UPDATE
     )
     UPDATE posters p SET final_doc_id = $3, updated_at = $4
       FROM old WHERE p.id = old.id
     RETURNING p.*, old.final_doc_id AS prev_doc_id`,
    [Number(id), userId, docId, Date.now()]
  );
  if (!row) return null;
  const prevDocId = row.prev_doc_id ? Number(row.prev_doc_id) : null;
  delete row.prev_doc_id;
  return { row, prevDocId };
}

async function deletePosterRow(userId, id) {
  await migrate();
  return one("DELETE FROM posters WHERE id = $1 AND user_id = $2 RETURNING *", [Number(id), userId]);
}

/* ---- retention ---- */

/** Cards nobody has touched since `cutoff` (every user). */
async function stalePosters(cutoff) {
  await migrate();
  return query("SELECT id, user_id, photo_id FROM posters WHERE updated_at < $1", [cutoff]);
}

/** Photos unused since `cutoff` and on no remaining card (every user). */
async function stalePhotos(cutoff) {
  await migrate();
  return query(
    `SELECT p.id, p.user_id FROM poster_photos p
      WHERE p.last_used_at < $1
        AND NOT EXISTS (SELECT 1 FROM posters c WHERE c.user_id = p.user_id AND c.photo_id = p.id)`,
    [cutoff]
  );
}

async function photoIdsOf(userId) {
  await migrate();
  return (await query("SELECT id FROM poster_photos WHERE user_id = $1", [userId])).map((r) => Number(r.id));
}

module.exports = {
  migrate,
  consentOf, setConsent, deleteConsent,
  insertPhoto, updatePhoto, getPhoto, touchPhoto, deletePhotoRow,
  postersWithPhoto, photoReferenced,
  insertPoster, getPoster, latestPoster, casPoster, swapFinalDoc, deletePosterRow,
  stalePosters, stalePhotos, photoIdsOf,
};
