/**
 * STYLE STUDIO — persistence for "show me how I'd look".
 * ----------------------------------------------------------------------
 * Two tables, and neither of them holds bytes. Every image the studio
 * touches — the user's own photo, a garment they photographed, a
 * generated look — is a row in the existing `documents` vault, so it
 * inherits the things that were already solved there: per-user disk
 * layout, the authenticated /docs/:id/file reader, the gallery, sharing,
 * deletion, and the storage cap. These tables only say what each one
 * MEANS to the studio.
 *
 *   studio_photos  the inputs the user keeps — 'model' (a photo of
 *                  themselves) and 'garment' (their wardrobe). A studio
 *                  where you re-upload your face every single time is a
 *                  studio nobody opens twice.
 *   studio_looks   the outputs, with the recipe and provider that made
 *                  them, so a bad result can be explained rather than
 *                  guessed at, and so "the good one" can be found again.
 *
 * COST IS REAL HERE. Unlike search or weather, one tap spends money at a
 * paid image model. `spentToday` is the brake: a per-user daily cap that
 * fails closed with a plain sentence instead of a silent bill.
 */
const { query, one, run } = require("../db");

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS studio_photos (
        id          BIGSERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        role        TEXT    NOT NULL DEFAULT 'model',
        document_id INTEGER NOT NULL,
        label       TEXT    NOT NULL DEFAULT '',
        meta        TEXT    NOT NULL DEFAULT '{}',
        is_default  INTEGER NOT NULL DEFAULT 0,
        created_at  BIGINT  NOT NULL
      );
      CREATE INDEX IF NOT EXISTS studio_photos_user ON studio_photos (user_id, role, created_at DESC);

      CREATE TABLE IF NOT EXISTS studio_looks (
        id          BIGSERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        recipe      TEXT    NOT NULL,
        document_id INTEGER NOT NULL,
        photo_id    BIGINT,
        garment_id  BIGINT,
        prompt      TEXT    NOT NULL DEFAULT '',
        params      TEXT    NOT NULL DEFAULT '{}',
        provider    TEXT    NOT NULL DEFAULT '',
        ms          INTEGER NOT NULL DEFAULT 0,
        favorite    INTEGER NOT NULL DEFAULT 0,
        created_at  BIGINT  NOT NULL
      );
      CREATE INDEX IF NOT EXISTS studio_looks_user ON studio_looks (user_id, created_at DESC);

      -- CONSENT, recorded once per user. A photograph of a face is
      -- sensitive personal data under the DPDP Act, and tapping a feature
      -- is not informed consent to store someone's biometrics. The app
      -- shows what will be stored and why, and the acceptance lands here
      -- with a timestamp so it can be shown, audited and withdrawn.
      CREATE TABLE IF NOT EXISTS studio_consent (
        user_id     INTEGER PRIMARY KEY,
        accepted_at BIGINT NOT NULL,
        version     TEXT   NOT NULL DEFAULT 'v1'
      );
    `).catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

function parse(s, fallback) {
  try { return JSON.parse(s || ""); } catch (_) { return fallback; }
}

/* ------------------------------------------------------------------ */
/* INPUTS — the user's own photos and wardrobe                         */
/* ------------------------------------------------------------------ */

const ROLES = new Set(["model", "garment"]);

async function addPhoto(userId, { role, documentId, label = "", meta = {}, makeDefault = false }) {
  await migrate();
  const r = ROLES.has(role) ? role : "model";
  const row = await one(
    `INSERT INTO studio_photos (user_id, role, document_id, label, meta, is_default, created_at)
     VALUES ($1,$2,$3,$4,$5,0,$6) RETURNING *`,
    [userId, r, documentId, String(label || "").slice(0, 120), JSON.stringify(meta || {}), Date.now()]
  );
  // The FIRST model photo becomes the default automatically — asking a
  // user to pick a default out of a list of one is a pointless tap.
  if (r === "model" && (makeDefault || (await countPhotos(userId, "model")) === 1)) {
    await setDefaultModel(userId, row.id);
    row.is_default = 1;
  }
  return toClientPhoto(row);
}

async function countPhotos(userId, role) {
  await migrate();
  return (
    await one(
      "SELECT COUNT(*)::int AS n FROM studio_photos WHERE user_id = $1 AND role = $2",
      [userId, role]
    )
  ).n;
}

async function setDefaultModel(userId, id) {
  await migrate();
  await run("UPDATE studio_photos SET is_default = 0 WHERE user_id = $1 AND role = 'model'", [userId]);
  await run(
    "UPDATE studio_photos SET is_default = 1 WHERE id = $1 AND user_id = $2 AND role = 'model'",
    [id, userId]
  );
  return true;
}

async function listPhotos(userId, role = null, limit = 60) {
  await migrate();
  const rows = await query(
    `SELECT * FROM studio_photos
      WHERE user_id = $1 ${role ? "AND role = $3" : ""}
      ORDER BY is_default DESC, created_at DESC LIMIT $2`,
    role ? [userId, limit, role] : [userId, limit]
  );
  return rows.map(toClientPhoto);
}

async function getPhoto(userId, id) {
  await migrate();
  const row = await one("SELECT * FROM studio_photos WHERE id = $1 AND user_id = $2", [id, userId]);
  return row || null;
}

/** The photo a voice request means when the user says "me" and picks nothing. */
async function defaultModel(userId) {
  await migrate();
  return (
    (await one(
      `SELECT * FROM studio_photos WHERE user_id = $1 AND role = 'model'
        ORDER BY is_default DESC, created_at DESC LIMIT 1`,
      [userId]
    )) || null
  );
}

async function deletePhoto(userId, id, { alsoDocument = true } = {}) {
  await migrate();
  const row = await getPhoto(userId, id);
  if (!row) return false;
  await run("DELETE FROM studio_photos WHERE id = $1 AND user_id = $2", [id, userId]);
  if (alsoDocument) {
    // A face photo the user removed from the studio must not stay in the
    // vault as a surprise. Looks made FROM it are left alone — they are
    // the user's own pictures, and deleting them silently would be theft.
    await require("../docs/store").deleteDocument(userId, row.document_id).catch(() => {});
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* OUTPUTS — generated looks                                           */
/* ------------------------------------------------------------------ */

async function addLook(userId, look) {
  await migrate();
  const row = await one(
    `INSERT INTO studio_looks
       (user_id, recipe, document_id, photo_id, garment_id, prompt, params, provider, ms, favorite, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10) RETURNING *`,
    [
      userId,
      String(look.recipe || "").slice(0, 60),
      look.documentId,
      look.photoId || null,
      look.garmentId || null,
      String(look.prompt || "").slice(0, 2000),
      JSON.stringify(look.params || {}),
      String(look.provider || "").slice(0, 60),
      Math.max(0, Math.round(Number(look.ms) || 0)),
      Date.now(),
    ]
  );
  return toClientLook(row);
}

async function listLooks(userId, { recipe = null, limit = 120 } = {}) {
  await migrate();
  const rows = await query(
    `SELECT * FROM studio_looks WHERE user_id = $1 ${recipe ? "AND recipe = $3" : ""}
      ORDER BY created_at DESC LIMIT $2`,
    recipe ? [userId, limit, recipe] : [userId, limit]
  );
  return rows.map(toClientLook);
}

async function getLook(userId, id) {
  await migrate();
  return (await one("SELECT * FROM studio_looks WHERE id = $1 AND user_id = $2", [id, userId])) || null;
}

async function favorite(userId, id, on) {
  await migrate();
  await run("UPDATE studio_looks SET favorite = $1 WHERE id = $2 AND user_id = $3", [
    on ? 1 : 0, id, userId,
  ]);
  return true;
}

async function deleteLook(userId, id) {
  await migrate();
  const row = await getLook(userId, id);
  if (!row) return false;
  await run("DELETE FROM studio_looks WHERE id = $1 AND user_id = $2", [id, userId]);
  await require("../docs/store").deleteDocument(userId, row.document_id).catch(() => {});
  return true;
}

/* ------------------------------------------------------------------ */
/* CONSENT                                                             */
/* ------------------------------------------------------------------ */

const CONSENT_VERSION = "v1";

async function setConsent(userId) {
  await migrate();
  await run(
    `INSERT INTO studio_consent (user_id, accepted_at, version) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET accepted_at = $2, version = $3`,
    [userId, Date.now(), CONSENT_VERSION]
  );
  return true;
}

async function consentAt(userId) {
  await migrate();
  const row = await one("SELECT accepted_at FROM studio_consent WHERE user_id = $1", [userId]);
  return row ? Number(row.accepted_at) : 0;
}

/** Withdrawing consent removes the stored face photos with it — leaving
 *  them behind would make the withdrawal meaningless. */
async function withdrawConsent(userId) {
  await migrate();
  const photos = await listPhotos(userId, "model");
  for (const p of photos) await deletePhoto(userId, p.id).catch(() => {});
  await run("DELETE FROM studio_consent WHERE user_id = $1", [userId]);
  return photos.length;
}

/* ------------------------------------------------------------------ */
/* THE BRAKE — every render costs money                                */
/* ------------------------------------------------------------------ */

/** Renders this user has spent in the last 24 h. */
async function spentToday(userId) {
  await migrate();
  return (
    await one(
      "SELECT COUNT(*)::int AS n FROM studio_looks WHERE user_id = $1 AND created_at > $2",
      [userId, Date.now() - 86_400_000]
    )
  ).n;
}

function dailyCap() {
  const n = Number(process.env.STUDIO_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 40;
}

/** null when allowed, otherwise a sentence to say to the user. */
async function overCap(userId) {
  const cap = dailyCap();
  const used = await spentToday(userId);
  if (used < cap) return null;
  return `You've made ${used} looks today, which is the daily limit. It resets over the next few hours.`;
}

/* ------------------------------------------------------------------ */

function toClientPhoto(r) {
  return {
    id: Number(r.id),
    role: r.role,
    documentId: Number(r.document_id),
    label: r.label || "",
    meta: parse(r.meta, {}),
    isDefault: !!Number(r.is_default),
    createdAt: Number(r.created_at),
  };
}

function toClientLook(r) {
  return {
    id: Number(r.id),
    recipe: r.recipe,
    documentId: Number(r.document_id),
    photoId: r.photo_id == null ? null : Number(r.photo_id),
    garmentId: r.garment_id == null ? null : Number(r.garment_id),
    prompt: r.prompt || "",
    params: parse(r.params, {}),
    provider: r.provider || "",
    ms: Number(r.ms) || 0,
    favorite: !!Number(r.favorite),
    createdAt: Number(r.created_at),
  };
}

module.exports = {
  migrate,
  addPhoto, listPhotos, getPhoto, deletePhoto, setDefaultModel, defaultModel, countPhotos,
  addLook, listLooks, getLook, deleteLook, favorite,
  spentToday, dailyCap, overCap,
  setConsent, consentAt, withdrawConsent, CONSENT_VERSION,
  toClientPhoto, toClientLook,
};
