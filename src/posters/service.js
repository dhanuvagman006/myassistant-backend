/**
 * PHOTO CARDS — WHAT THE ROUTES AND THE VOICE TOOLS BOTH DO.
 * ----------------------------------------------------------------------
 * One place for every rule, so "bigger letters" said out loud and
 * [Bigger words] tapped on the phone are the same edit, checked the same
 * way, landing in the same undo history.
 *
 * No AI anywhere in v1 (owner, 2026-09-26: "build it without AI"). The
 * photo is cleaned up with ffmpeg (enhance.js); the card is drawn on the
 * phone. POSTER_AI_RESTORE is kept as the one switch a later AI repair
 * would sit behind; until that exists, asking for it answers 'off'.
 *
 * Errors are PosterError {http, code, message}: the routes send them as
 * {error: code, message}, the tools turn them into one spoken sentence.
 * No message ever blames the photo.
 */
const fs = require("fs");
const path = require("path");

const store = require("./store");
const S = require("./spec");
const enhance = require("./enhance");
const imageEdit = require("../services/imageEdit");

const CONSENT_VERSION = "family-photo-v1";
/** Truthful for v1: kept privately, drawn on the phone, no AI. */
const CONSENT_TEXT =
  "To make the card, the photo is kept privately in your account and " +
  "gently cleaned up — brighter, clearer colours. Nothing is changed by " +
  "AI. Please use photos of your own family. You can delete it any time.";

const OK_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const SOURCES = new Set(["gallery", "camera", "share", "document"]);
const MAX_PHOTO_BYTES = 18 * 1024 * 1024;
const MAX_FINAL_BYTES = 8 * 1024 * 1024;

class PosterError extends Error {
  constructor(http, code, message, extra = {}) {
    super(message);
    this.http = http;
    this.code = code;
    this.extra = extra;
  }
}

const notFound = (what = "That card") =>
  new PosterError(404, "not_found", `${what} isn't here any more.`);

/** POSTER_AI_RESTORE: 'off' by default; nothing behind 'on' in v1 either. */
const AI_RESTORE_BUILT = false;
function aiRestoreOn() {
  return AI_RESTORE_BUILT && String(process.env.POSTER_AI_RESTORE || "off").toLowerCase() === "on";
}

/* ------------------------------------------------------------------ */
/* FILES                                                               */
/* ------------------------------------------------------------------ */

function filesRoot() {
  return path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "..", "data"), "files");
}
function photoDir(userId, photoId) {
  return path.join(filesRoot(), String(userId), "posters", String(Number(photoId)));
}
function variantsOf(row) {
  return String(row.variants || "original").split(",").filter(Boolean);
}
/**
 * original.<ext>, and one enhanced-<colour>.jpg per colour made — a
 * colour is never written over another (review, 2026-09-26: rewriting
 * one enhanced.jpg in place kept "black and white" out of the card's
 * undo, under an unchanged URL).
 */
function variantFile(row, v, colour = null) {
  if (v === "original") return path.join(photoDir(row.user_id, row.id), `original.${row.orig_ext || "jpg"}`);
  const c = S.PHOTO_COLOURS.includes(colour) ? colour : S.PHOTO_COLOURS.includes(row.colour) ? row.colour : "keep";
  return path.join(photoDir(row.user_id, row.id), `${v}-${c}.jpg`);
}
const MIME_OF = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
const MIME_OF_KIND = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

const unavailableColour = () => new PosterError(503, "unavailable",
  "Changing the photo's colours isn't available just now — the photo on the card stays as it is.");

/**
 * Make sure this photo has its clean copy in `colour`, making it from
 * the stored original when it does not. Deterministic, so a colour made
 * twice (two requests at once) is the same bytes either way.
 */
async function ensureColour(row, colour) {
  if (!S.PHOTO_COLOURS.includes(colour)) {
    throw new PosterError(400, "bad_change", `photoColour must be one of ${S.PHOTO_COLOURS.join(", ")}`);
  }
  const file = variantFile(row, "enhanced", colour);
  if (variantsOf(row).includes("enhanced") && fs.existsSync(file)) return file;
  let original;
  try {
    original = fs.readFileSync(variantFile(row, "original"));
  } catch (_) {
    throw notFound("That photo's file");
  }
  const out = await enhance.reenhance(original, colour, { flattened: !!row.flattened });
  if (!out) throw unavailableColour();
  // Written aside, then moved into place: a phone fetching this colour at
  // that moment gets the whole picture or none, never half of one.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, out.buffer);
  fs.renameSync(tmp, file);
  // A photo that arrived while ffmpeg was away gains its clean copy now.
  if (!variantsOf(row).includes("enhanced")) {
    const updated = await store.updatePhoto(row.user_id, row.id, { variants: [...variantsOf(row), "enhanced"] });
    if (updated) row.variants = updated.variants;
  }
  return file;
}

/* ------------------------------------------------------------------ */
/* CLIENT SHAPES — the contract (tests/fixtures/posters/contract.json)  */
/* ------------------------------------------------------------------ */

function photoToClient(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    source: row.source,
    width: Number(row.width) || 0,
    height: Number(row.height) || 0,
    colour: row.colour,
    status: row.status,
    reason: row.reason || null,
    message: row.message || null,
    variants: variantsOf(row),
    updatedAt: Number(row.updated_at),
  };
}

function posterToClient(row, photoRow = null) {
  if (!row) return null;
  const history = Array.isArray(row.history) ? row.history : [];
  return {
    id: Number(row.id),
    occasion: row.occasion,
    version: Number(row.version),
    spec: row.spec,
    photo: photoToClient(photoRow),
    finalDocumentId: row.final_doc_id ? Number(row.final_doc_id) : null,
    canUndo: history.length > 0,
    updatedAt: Number(row.updated_at),
  };
}

async function posterOut(userId, row) {
  const photo = row.photo_id ? await store.getPhoto(userId, row.photo_id) : null;
  return posterToClient(row, photo);
}

/* ------------------------------------------------------------------ */
/* CONSENT                                                             */
/* ------------------------------------------------------------------ */

async function consent(userId) {
  const row = await store.consentOf(userId);
  return {
    accepted: !!row && row.version === CONSENT_VERSION,
    version: CONSENT_VERSION,
    text: CONSENT_TEXT,
    // Lets the app skip an AI-consent step that would describe nothing.
    aiRestore: aiRestoreOn(),
  };
}

async function acceptConsent(userId) {
  await store.setConsent(userId, CONSENT_VERSION);
  return { accepted: true, version: CONSENT_VERSION };
}

/**
 * "You can delete it any time" has to be true (review, 2026-09-26):
 * withdrawing removes every working photo he picked — taken off his
 * cards (their words stay), rows and files gone. The finished cards and
 * any photo he chose to keep are in his documents, deleted from there.
 */
async function withdrawConsent(userId) {
  await store.deleteConsent(userId);
  let photosRemoved = 0;
  for (const id of await store.photoIdsOf(userId)) {
    await deletePhoto(userId, id).then(() => { photosRemoved++; }, (e) => {
      if (!(e instanceof PosterError && e.code === "not_found")) throw e;
    });
  }
  return { accepted: false, photosRemoved };
}

/* ------------------------------------------------------------------ */
/* PHOTOS                                                              */
/* ------------------------------------------------------------------ */

/**
 * A picked photo → stored original + enhanced copy, optionally put on a
 * card. NO documents row, no vision call, no memory fact, no push: this
 * is a working copy for a card, not something he filed.
 */
async function addPhoto(userId, { buffer, mime, source = "gallery", colour = "keep", posterId = null, ai = true }) {
  if (!buffer || !buffer.length) throw new PosterError(400, "no_photo", "Please choose a photo.");
  if (buffer.length > MAX_PHOTO_BYTES) {
    throw new PosterError(413, "too_large", "That photo is too large — please pick one under 18 MB.");
  }
  // The bytes decide what the picture is, not the name it arrived with:
  // a JPEG saved as ".png" is still a JPEG (and still needs turning
  // upright). A renamed non-image must not reach ffmpeg or the phone.
  const kind = imageEdit.imageKind(buffer);
  const size = imageEdit.imageSize(buffer);
  if (!kind || !size || !size.width || !size.height) {
    throw OK_MIME.has(mime)
      ? new PosterError(415, "unsupported_type", "That doesn't open as a photo — please pick another one.")
      : new PosterError(415, "unsupported_type", "That kind of picture can't be used — please pick a normal photo.");
  }
  // Bytes alone never bounded the work (review, 2026-09-26): a 746 KB PNG
  // saying 16000x16000 took ffmpeg to about 1 GB in a 512 MiB pod, and the
  // phone would have to open it too. Past the decode budget it is refused.
  if (!imageEdit.decodePlan(buffer, { minEdge: enhance.MAX_EDGE })) {
    throw new PosterError(413, "too_large", "That photo is too big to use — please pick a smaller copy of it.");
  }
  const col = S.PHOTO_COLOURS.includes(colour) ? colour : "keep";
  const src = SOURCES.has(source) ? source : "gallery";

  let poster = null;
  if (posterId !== null && posterId !== undefined && posterId !== "") {
    poster = await store.getPoster(userId, posterId);
    if (!poster) throw notFound();
  }

  const reason = String(ai) === "false" ? "not_requested" : aiRestoreOn() ? null : "off";
  const row = await store.insertPhoto(userId, { source: src, colour: col, reason });
  const dir = photoDir(userId, row.id);
  let updated;
  try {
    const out = await enhance.prepare(buffer, MIME_OF_KIND[kind], { colour: col });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `original.${out.original.ext}`), out.original.buffer);
    const variants = ["original"];
    if (out.enhanced) {
      fs.writeFileSync(path.join(dir, `enhanced-${col}.jpg`), out.enhanced.buffer);
      variants.push("enhanced");
    }
    updated = await store.updatePhoto(userId, row.id, {
      width: out.original.width, height: out.original.height,
      variants, origExt: out.original.ext, flattened: !!out.flattened,
    });
    console.log(`posters: photo ${row.id} ${out.original.width}x${out.original.height} ` +
      `${variants.join("+")}${out.notes.length ? ` (${out.notes.join("; ")})` : ""}`);
  } catch (e) {
    await store.deletePhotoRow(userId, row.id).catch(() => {});
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    // Bytes ffmpeg cannot open fail the same way every time: "try again"
    // would send him round in a circle (review, 2026-09-26). A run that
    // was stopped for taking too long stays a plain error — that one may
    // well work next time.
    if (e && e.code === "undecodable") {
      throw new PosterError(415, "unsupported_type", "That photo doesn't open — please pick another one.");
    }
    if (e && e.code === "too_many_pixels") {
      throw new PosterError(413, "too_large", "That photo is too big to use — please pick a smaller copy of it.");
    }
    throw e;
  }

  const photo = photoToClient(updated);
  if (!poster) return { photo };
  const use = photo.variants.includes("enhanced") ? "enhanced" : "original";
  const res = await patchPoster(userId, poster.id, {
    change: { photoId: photo.id, photoUse: use, photoColour: col },
  });
  return { photo, poster: res.poster };
}

/** A photo he already saved in his documents, used for a card. */
async function addPhotoFromDocument(userId, { documentId, posterId = null, colour = "keep", ai = true }) {
  const docs = require("../docs/store");
  const id = Number(documentId);
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound("That document");
  const doc = await docs.getDocument(userId, id);
  if (!doc) throw notFound("That document");
  if (!OK_MIME.has(doc.mime)) {
    throw new PosterError(415, "unsupported_type", "That document isn't a photo — please pick a photo.");
  }
  let buffer;
  try {
    buffer = fs.readFileSync(doc.path);
  } catch (_) {
    throw notFound("That photo's file");
  }
  return addPhoto(userId, { buffer, mime: doc.mime, source: "document", colour, posterId, ai });
}

async function getPhoto(userId, id) {
  const row = await store.getPhoto(userId, id);
  if (!row) throw notFound("That photo");
  return photoToClient(row);
}

/**
 * {file, mime} for one variant of one of his photos. `colour` picks the
 * enhanced copy's colour (a card asks for its spec.photoColour); without
 * it, the colour last asked for this photo. Each colour is its own URL,
 * so a cached copy of one is never shown for another.
 */
async function photoFile(userId, id, v = "enhanced", colour = null) {
  const row = await store.getPhoto(userId, id);
  if (!row) throw notFound("That photo");
  if (!variantsOf(row).includes(v)) throw notFound("That version of the photo");
  if (colour !== null && colour !== undefined && colour !== "" && !S.PHOTO_COLOURS.includes(colour)) {
    throw notFound("That version of the photo");
  }
  let file = variantFile(row, v, colour);
  if (v === "enhanced" && !fs.existsSync(file)) {
    // Every colour a card uses is made when it is chosen; this only
    // covers a copy lost since (made again, the same bytes).
    try {
      file = await ensureColour(row, S.PHOTO_COLOURS.includes(colour) ? colour : row.colour);
    } catch (_) {
      throw notFound("That version of the photo");
    }
  }
  if (!fs.existsSync(file)) throw notFound("That version of the photo");
  await store.touchPhoto(userId, row.id);
  const ext = path.extname(file).slice(1);
  return { file, mime: MIME_OF[ext] || "image/jpeg" };
}

/**
 * "Make it black and white" / "sepia" / "its own colours" for a photo on
 * its own (the "make this old photo nice" screen): the clean-up in that
 * colour, made once and kept beside the others. A CARD's photo colour is
 * part of the card — PATCH {change:{photoColour}} — so it is undoable.
 */
async function recolourPhoto(userId, id, colour) {
  if (!S.PHOTO_COLOURS.includes(colour)) {
    throw new PosterError(400, "bad_colour", `colour must be one of ${S.PHOTO_COLOURS.join(", ")}`);
  }
  const row = await store.getPhoto(userId, id);
  if (!row) throw notFound("That photo");
  await ensureColour(row, colour);
  return photoToClient(await store.updatePhoto(userId, row.id, { colour }));
}

/**
 * The AI repair: not in v1 (owner, 2026-09-26: "build it without AI").
 * The route exists so the app and a later AI step have one door; until
 * that step is written (AI_RESTORE_BUILT) the switch cannot open it.
 */
async function restorePhoto(userId, id) {
  const row = await store.getPhoto(userId, id);
  if (!row) throw notFound("That photo");
  throw new PosterError(503, "off", "Photo repair is not switched on yet.");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "26 Sep 2026", in India time, spelled the same on every ICU build
 *  (en-GB says "Sept" on some and "Sep" on others). */
function dayLabel(ms = Date.now()) {
  const d = new Date(ms + 330 * 60_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "Keep the clearer photo" — one variant, in the colour last shown, saved to his documents. */
async function keepPhoto(userId, id, v = "enhanced") {
  const row = await store.getPhoto(userId, id);
  if (!row) throw notFound("That photo");
  if (!["original", "enhanced"].includes(v) || !variantsOf(row).includes(v)) {
    throw notFound("That version of the photo");
  }
  let file = variantFile(row, v);
  if (v === "enhanced" && !fs.existsSync(file)) {
    file = await ensureColour(row, row.colour).catch(() => file);
  }
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (_) {
    throw notFound("That version of the photo");
  }
  const docs = require("../docs/store");
  const ext = path.extname(file).slice(1);
  const mime = MIME_OF[ext] || "image/jpeg";
  const doc = await docs.createDocument(userId, {
    buffer,
    filename: `photo-${v}-${Date.now()}.${ext}`,
    mime,
    note: v === "enhanced" ? "old photo, cleaned up" : "old photo",
  });
  const colourWords = { keep: "its own colours", bw: "black and white", sepia: "sepia" }[row.colour] || "its own colours";
  const title = v === "enhanced" ? `Photo made clearer - ${dayLabel()}` : `Photo - ${dayLabel()}`;
  // fullText set, so the documents' self-heal pass never spends a vision
  // call on a photo whose story is already known.
  const updated = await docs.setMetadata(userId, doc.id, {
    title,
    category: "other",
    docDate: new Date().toISOString().slice(0, 10),
    summary: v === "enhanced"
      ? `An old photo, gently cleaned up in the app (brightness, contrast, ${colourWords}). No AI was used.`
      : "An old photo, kept as it was picked.",
    tags: v === "enhanced" ? ["old-photo", "cleaned-up"] : ["old-photo"],
    fullText: v === "enhanced"
      ? `Old photo, cleaned up without AI: auto levels, colour balance, gentle denoise and sharpening, ${colourWords}.`
      : "Old photo, as picked.",
  }).catch(() => null);
  await store.touchPhoto(userId, row.id);
  return docs.toClient(updated || doc);
}

/* ------------------------------------------------------------------ */
/* POSTERS                                                             */
/* ------------------------------------------------------------------ */

function needError(need) {
  const first = need[0];
  const what = S.FIELD_WORDS[first.field] || first.field;
  const message = first.reason === "too_long"
    ? `That's a little long for the card — can ${what} be shorter? (up to ${first.max} letters)`
    : `Please check ${what}.`;
  return new PosterError(422, "need", message, { need });
}

async function createPoster(userId, { occasion, spec = {}, photoId = null } = {}) {
  const partial = { ...(spec || {}) };
  if (occasion !== undefined) partial.occasion = occasion;
  let photo = null;
  if (photoId !== null && photoId !== undefined && photoId !== "") {
    photo = await store.getPhoto(userId, photoId);
    if (!photo) throw notFound("That photo");
    if (partial.photoUse === undefined ||
        (partial.photoUse !== "none" && !variantsOf(photo).includes(partial.photoUse))) {
      partial.photoUse = variantsOf(photo).includes("enhanced") ? "enhanced" : "original";
    }
    // The photo comes onto the card in the colours it was last shown in
    // ("make it black and white", then "make a card with it").
    if (partial.photoColour === undefined && S.PHOTO_COLOURS.includes(photo.colour)) {
      partial.photoColour = photo.colour;
    }
  }
  const out = S.normalize(partial, null);
  if (out.need) throw needError(out.need);
  if (out.error) throw new PosterError(400, out.error, out.message);
  if (!photo) out.spec.photoUse = "none";
  if (photo && out.spec.photoUse === "enhanced") await ensureColour(photo, out.spec.photoColour);
  const row = await store.insertPoster(userId, { spec: out.spec, photoId: photo ? Number(photo.id) : null });
  if (photo) await store.touchPhoto(userId, photo.id);
  return posterToClient(row, photo);
}

async function getPoster(userId, id) {
  const row = await store.getPoster(userId, id);
  if (!row) throw notFound();
  if (row.photo_id) await store.touchPhoto(userId, row.photo_id);
  return posterOut(userId, row);
}

async function latestPoster(userId) {
  const row = await store.latestPoster(userId);
  if (!row) return null;
  if (row.photo_id) await store.touchPhoto(userId, row.photo_id);
  return posterOut(userId, row);
}

/**
 * One edit. `version` given (the phone) → compare-and-swap, 409 with the
 * server's copy when stale. No version (a voice tool, or a photo arriving
 * for the card) → applied to whatever is current.
 * @returns {{poster, changed:boolean, limitReached?:boolean}}
 */
async function patchPoster(userId, id, { version, change = {} } = {}) {
  if (!change || typeof change !== "object" || Array.isArray(change)) {
    throw new PosterError(400, "bad_change", "change must be an object");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await store.getPoster(userId, id);
    if (!row) throw notFound();
    const cur = Number(row.version);
    if (version !== undefined && version !== null && Number(version) !== cur) {
      throw new PosterError(409, "version_conflict",
        "The card was changed somewhere else — here is the latest one.",
        { poster: await posterOut(userId, row) });
    }
    const history = Array.isArray(row.history) ? row.history : [];
    let spec;
    let photoId = row.photo_id ? Number(row.photo_id) : null;
    let nextHistory;
    let limitReached = false;

    if (change.undo) {
      if (Object.keys(change).some((k) => k !== "undo")) {
        throw new PosterError(400, "bad_change", "undo is its own change");
      }
      if (!history.length) {
        throw new PosterError(422, "nothing_to_undo", "There's nothing to undo — this is how the card started.",
          { poster: await posterOut(userId, row) });
      }
      const prev = history[history.length - 1];
      spec = prev.spec;
      photoId = prev.photoId ?? null;
      nextHistory = history.slice(0, -1);
      // A photo the 30-day sweep has since removed cannot come back.
      if (photoId && !(await store.getPhoto(userId, photoId))) {
        photoId = null;
        spec = { ...spec, photoUse: "none" };
      }
    } else {
      const { photoId: newPhotoId, ...rest } = change;
      if (newPhotoId !== undefined && newPhotoId !== null) {
        const photo = await store.getPhoto(userId, newPhotoId);
        if (!photo) throw notFound("That photo");
        photoId = Number(photo.id);
        if (rest.photoUse === undefined) {
          rest.photoUse = variantsOf(photo).includes("enhanced") ? "enhanced" : "original";
        }
        // A photo arrives in the colours it was last shown in, unless the
        // same change names one.
        if (rest.photoColour === undefined && photoId !== Number(row.photo_id) &&
            S.PHOTO_COLOURS.includes(photo.colour)) {
          rest.photoColour = photo.colour;
        }
      }
      const photo = photoId ? await store.getPhoto(userId, photoId) : null;
      // "Black and white" asked of the card's photo needs the clean copy:
      // without ffmpeg there is none, and that is said plainly rather than
      // as a bad request. (A new photo just carries its colour along.)
      if (rest.photoColour !== undefined && (newPhotoId === undefined || newPhotoId === null) &&
          rest.photoColour !== (row.spec.photoColour || "keep")) {
        if (!photo) throw new PosterError(400, "bad_change", "the card has no photo yet");
        await ensureColour(photo, rest.photoColour);
      }
      if (rest.photoUse && rest.photoUse !== "none") {
        if (!photoId) throw new PosterError(400, "bad_change", "the card has no photo yet");
        if (!photo || !variantsOf(photo).includes(rest.photoUse)) {
          throw new PosterError(400, "bad_change", `the photo has no ${rest.photoUse} version`);
        }
      }
      const out = S.applyChange(row.spec, rest);
      if (out.need) throw needError(out.need);
      if (out.error) throw new PosterError(400, out.error, out.message);
      limitReached = !!out.limitReached;
      const photoChanged = photoId !== (row.photo_id ? Number(row.photo_id) : null);
      if (!out.changed && !photoChanged) {
        return { poster: await posterOut(userId, row), changed: false, limitReached };
      }
      // The copy the card will show exists before the card says so.
      if (photo && out.spec.photoUse === "enhanced") await ensureColour(photo, out.spec.photoColour);
      spec = out.spec;
      nextHistory = [...history, { spec: row.spec, photoId: row.photo_id ? Number(row.photo_id) : null }]
        .slice(-S.HISTORY_MAX);
    }

    const saved = await store.casPoster(userId, row.id, cur, { spec, history: nextHistory, photoId });
    if (saved) {
      if (photoId) await store.touchPhoto(userId, photoId);
      return { poster: await posterOut(userId, saved), changed: true, limitReached };
    }
    // Someone else won the race. The phone (with a version) is told so;
    // a voice edit simply reapplies on top of the newer card.
    if (version !== undefined && version !== null) {
      const now = await store.getPoster(userId, id);
      if (!now) throw notFound();
      throw new PosterError(409, "version_conflict",
        "The card was changed somewhere else — here is the latest one.",
        { poster: await posterOut(userId, now) });
    }
  }
  throw new PosterError(409, "version_conflict", "The card is being changed — try that again.");
}

/** A whole PNG: the signature at the front and the IEND chunk at the end. */
function isPng(buf) {
  if (!buf || buf.length < 45) return false;
  const sig = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const iend = buf.slice(-12).equals(Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]));
  return sig && iend;
}

const OCCASION_TITLE = {
  birthday: "Birthday", anniversary: "Anniversary", wedding: "Wedding",
  festival: "Festival", other: "Greeting",
};

/**
 * The finished card, as the phone drew it, saved to his documents. The
 * document's text is the card's exact words, and it replaces this card's
 * previous saved copy only — never another card's.
 */
async function saveFinal(userId, id, { buffer, version }) {
  const row = await store.getPoster(userId, id);
  if (!row) throw notFound();
  if (!buffer || !buffer.length) throw new PosterError(400, "no_image", "The card picture is missing.");
  if (buffer.length > MAX_FINAL_BYTES) throw new PosterError(413, "too_large", "The card picture is too large.");
  if (!isPng(buffer)) throw new PosterError(415, "unsupported_type", "The card must be a PNG picture.");
  const size = imageEdit.imageSize(buffer);
  if (!size || size.width < 200 || size.height < 200 || size.width > 4096 || size.height > 4096) {
    throw new PosterError(415, "unsupported_type", "The card picture has an unexpected size.");
  }
  if (version === undefined || version === null || version === "" || Number(version) !== Number(row.version)) {
    throw new PosterError(409, "version_conflict",
      "The card was changed after this picture was drawn — here is the latest one.",
      { poster: await posterOut(userId, row) });
  }

  const docs = require("../docs/store");
  const spec = row.spec;
  const kind = OCCASION_TITLE[spec.occasion] || "Greeting";
  const title = spec.name ? `${kind} card - ${spec.name}` : `${kind} card`;
  const photo = row.photo_id ? await store.getPhoto(userId, row.photo_id) : null;
  const design = S.designById(spec.design);
  const photoWords = !photo || spec.photoUse === "none"
    ? "no photo"
    : spec.photoUse === "enhanced"
      ? "a photo gently cleaned up in the app (no AI)" +
        ({ bw: ", in black and white", sepia: ", in sepia" }[spec.photoColour] || "")
      : "the photo as picked";
  const doc = await docs.createDocument(userId, {
    buffer,
    filename: `card-${Number(row.id)}-${Date.now()}.png`,
    mime: "image/png",
    note: `${kind.toLowerCase()} card`,
  });
  const updated = await docs.setMetadata(userId, doc.id, {
    title,
    category: "other",
    docDate: new Date().toISOString().slice(0, 10),
    summary: `A ${kind.toLowerCase()} card made in the app — ${design.label} design, ${photoWords}` +
      `${spec.signature ? ", signed" : ""}.`,
    tags: ["poster", spec.occasion],
    fullText: S.words(spec).join("\n"),
  }).catch(() => null);

  // The swap and the "before" are one statement: two saves at once leave
  // exactly one copy of this card in his documents, never an orphan.
  const swapped = await store.swapFinalDoc(userId, row.id, doc.id);
  if (!swapped) {
    // The card was deleted while its picture was being saved.
    await docs.deleteDocument(userId, doc.id).catch(() => {});
    throw notFound();
  }
  const prev = swapped.prevDocId;
  if (prev && prev !== Number(doc.id)) await docs.deleteDocument(userId, prev).catch(() => {});
  return { document: docs.toClient(updated || doc), poster: await posterOut(userId, swapped.row) };
}

/** Every photo id a card holds: the one on it and the ones undo could bring back. */
function photoIdsOfPoster(row) {
  const ids = new Set();
  if (row.photo_id) ids.add(Number(row.photo_id));
  for (const h of Array.isArray(row.history) ? row.history : []) {
    if (h && h.photoId) ids.add(Number(h.photoId));
  }
  return [...ids];
}

/**
 * Removes the card, and every photo it held — the one on it and the ones
 * in its undo history — that no other card still shows or could bring
 * back (review, 2026-09-26: a first photo swapped for a second lived on
 * in the history, and on disk, after the card was gone).
 */
async function deletePoster(userId, id) {
  const row = await store.deletePosterRow(userId, id);
  if (!row) throw notFound();
  for (const photoId of photoIdsOfPoster(row)) {
    if (!(await store.photoReferenced(userId, photoId, row.id))) await removePhoto(userId, photoId);
  }
  return { ok: true };
}

/**
 * "Delete that photo" — one working photo, gone for good: taken off every
 * card that shows it (the card's words stay, it shows no photo), wiped
 * from their undo so it cannot come back, then the row and its files.
 * @returns {{ok:true, posterIds:number[]}} the cards that changed.
 */
async function deletePhoto(userId, photoId) {
  const photo = await store.getPhoto(userId, photoId);
  if (!photo) throw notFound("That photo");
  const pid = Number(photo.id);
  const posterIds = [];
  const clear = (h) => (h && Number(h.photoId) === pid
    ? { ...h, photoId: null, spec: { ...(h.spec || {}), photoUse: "none" } } : h);
  for (const found of await store.postersWithPhoto(userId, pid)) {
    let row = found;
    for (let attempt = 0; attempt < 3 && row; attempt++) {
      const onCard = Number(row.photo_id) === pid;
      const saved = await store.casPoster(userId, row.id, Number(row.version), {
        spec: onCard ? { ...row.spec, photoUse: "none" } : row.spec,
        history: (Array.isArray(row.history) ? row.history : []).map(clear),
        photoId: onCard ? null : row.photo_id,
      });
      if (saved) { posterIds.push(Number(row.id)); break; }
      row = await store.getPoster(userId, row.id); // an edit landed first: again, on top of it
    }
  }
  await removePhoto(userId, pid);
  return { ok: true, posterIds };
}

async function removePhoto(userId, photoId) {
  await store.deletePhotoRow(userId, photoId);
  try { fs.rmSync(photoDir(userId, photoId), { recursive: true, force: true }); } catch (_) {}
}

/* ------------------------------------------------------------------ */
/* RETENTION                                                           */
/* ------------------------------------------------------------------ */

function retentionDays() {
  const d = Number(process.env.POSTER_RETENTION_DAYS);
  return Number.isFinite(d) && d >= 1 ? d : 30;
}

/**
 * The daily sweep: a card untouched for 30 days goes (the finished card
 * is already in his documents), then every photo on no card and unused
 * for 30 days — rows and files — then any photo folder no row owns. A
 * family member's face is not kept longer than the card needs it.
 */
async function sweep(now = Date.now()) {
  const cutoff = now - retentionDays() * 24 * 3600_000;
  let posters = 0;
  let photos = 0;
  let folders = 0;
  for (const p of await store.stalePosters(cutoff)) {
    if (await store.deletePosterRow(p.user_id, p.id)) posters++;
  }
  for (const p of await store.stalePhotos(cutoff)) {
    await removePhoto(p.user_id, p.id);
    photos++;
  }
  // Folders no row owns (a crash between the row and the files).
  const root = filesRoot();
  let users = [];
  try { users = fs.readdirSync(root); } catch (_) { users = []; }
  for (const u of users) {
    if (!/^[1-9][0-9]*$/.test(u)) continue;
    const base = path.join(root, u, "posters");
    let entries = [];
    try { entries = fs.readdirSync(base); } catch (_) { continue; }
    if (!entries.length) continue;
    const owned = new Set((await store.photoIdsOf(Number(u))).map(String));
    for (const e of entries) {
      if (owned.has(e)) continue;
      const dir = path.join(base, e);
      try {
        // An hour's grace: a photo being written right now has its row.
        if (now - fs.statSync(dir).mtimeMs < 3600_000) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        folders++;
      } catch (_) {}
    }
  }
  if (posters || photos || folders) {
    console.log(`posters: swept ${posters} card(s), ${photos} photo(s), ${folders} stray folder(s)`);
  }
  return { posters, photos, folders };
}

module.exports = {
  PosterError, CONSENT_VERSION, CONSENT_TEXT, OK_MIME, MAX_PHOTO_BYTES, MAX_FINAL_BYTES,
  aiRestoreOn, photoDir, photoToClient, posterToClient,
  consent, acceptConsent, withdrawConsent,
  addPhoto, addPhotoFromDocument, getPhoto, photoFile, recolourPhoto, restorePhoto, keepPhoto,
  deletePhoto,
  createPoster, getPoster, latestPoster, patchPoster, saveFinal, deletePoster,
  sweep, retentionDays,
};
