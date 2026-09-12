/**
 * STYLE STUDIO — running one recipe, end to end.
 * ----------------------------------------------------------------------
 * The single path both the app's Studio screens and the voice tools take,
 * so "show me in a navy suit" spoken and the same thing tapped cannot
 * behave differently. Order of operations matters and is deliberate:
 *
 *   1. cap check      — before a paid call, not after it
 *   2. resolve inputs — a missing base photo is a question, not an error
 *   3. edit           — the provider chain
 *   4. SAVE FIRST     — the picture exists; the bookkeeping can still fail
 *   5. record         — look row, document metadata, action ledger
 *
 * PROVENANCE. India's IT Amendment Rules 2026 require synthetic media to
 * be labelled, and quite apart from the rule it is simply honest. Every
 * look is stored tagged `ai-generated` with the model that made it named
 * in its summary, and the app shows that on the image. What is NOT done
 * is stamping pixels: a visible watermark across a face would make the
 * feature pointless and would invalidate an ID photograph outright. The
 * one provider that offers an invisible mark (Vertex's SynthID) is left
 * switched on.
 */
const fs = require("fs");

const recipes = require("./recipes");
const store = require("./store");

/** Read the bytes of a document this user owns. */
async function readDocument(userId, documentId) {
  const docs = require("../docs/store");
  const row = await docs.getDocument(userId, Number(documentId));
  if (!row) throw Object.assign(new Error("that photo is not in your files any more"), { code: "missing_photo" });
  if (!row.path || !fs.existsSync(row.path)) {
    throw Object.assign(new Error("that photo's file is missing on the server"), { code: "missing_file" });
  }
  return { buffer: fs.readFileSync(row.path), mime: row.mime || "image/jpeg", row };
}

/** FASHN's garment-region control, inferred from what the user asked for. */
function garmentCategory(recipe, params) {
  if (recipe.id !== "outfit") return null;
  const t = `${params.outfit || ""} ${params.occasion || ""}`.toLowerCase();
  // Order matters: a one-piece wins over the words it contains ("kurta
  // set" is not a top), and a bottom wins over a generic top word.
  // Every noun is written to match its plural — `\btrouser\b` does not
  // match "trousers", which quietly sent every pair of trousers to "auto".
  if (/\b(sarees?|saris?|lehengas?|gowns?|dress(es)?|frocks?|jumpsuits?|sherwanis?|anarkalis?|kurta ?sets?|salwar|churidar kurta)\b/.test(t)) return "one-pieces";
  if (/\b(trousers?|pants?|jeans|chinos?|skirts?|shorts?|churidars?|pyjamas?|pajamas?|dhotis?|palazzos?|leggings?|joggers?)\b/.test(t)) return "bottoms";
  if (/\b(shirts?|t-?shirts?|tees?|blouses?|tops?|jackets?|blazers?|coats?|kurtas?|sweaters?|sweatshirts?|hoodies?|waistcoats?|bandhgalas?|jumpers?|cardigans?)\b/.test(t)) return "tops";
  // A two- or three-piece suit replaces the top AND the bottom, which is
  // not one of the three regions — let the model decide.
  return "auto";
}

/**
 * @param {number} userId
 * @param {object} o
 * @param {string} o.recipeId
 * @param {object} o.params
 * @param {number} [o.photoId]      a saved studio 'model' photo
 * @param {object} [o.photo]        {buffer, mime} uploaded this request
 * @param {number} [o.garmentId]    a saved studio 'garment' photo
 * @param {object} [o.garment]      {buffer, mime} uploaded this request
 * @param {string} [o.surface]      'app' | 'voice'
 */
async function runRecipe(userId, o = {}) {
  const recipe = recipes.get(o.recipeId);
  if (!recipe) throw Object.assign(new Error("unknown studio recipe"), { code: "unknown_recipe" });

  // 1 — the brake, before anything is spent.
  const over = await store.overCap(userId);
  if (over) throw Object.assign(new Error(over), { code: "daily_cap" });

  // 2 — inputs.
  let photoId = Number(o.photoId) || null;
  let person = o.photo || null;
  if (!person) {
    let row = photoId ? await store.getPhoto(userId, photoId) : await store.defaultModel(userId);
    if (!row) {
      throw Object.assign(
        new Error("I need a photo of you first — add one in Style Studio and I'll use it for every look."),
        { code: "no_model_photo" }
      );
    }
    photoId = Number(row.id);
    person = await readDocument(userId, row.document_id);
  }

  let garmentId = Number(o.garmentId) || null;
  let garment = o.garment || null;
  if (!garment && garmentId) {
    const row = await store.getPhoto(userId, garmentId);
    if (row) garment = await readDocument(userId, row.document_id);
    else garmentId = null;
  }

  const params = recipes.applyPreset(recipe, o.params || {});
  const hasGarment = !!garment && recipe.needs.garment !== undefined && recipe.needs.garment !== "no";
  const instruction = recipe.build({ params, hasGarment });
  const exact = recipes.sizeFor(recipe, params);

  // 3 — the edit.
  const { editImage } = require("../services/imageEdit");
  const out = await editImage({
    instruction,
    images: hasGarment ? [person, garment] : [person],
    aspect: recipe.aspect === "auto" ? "auto" : recipe.aspect,
    exact,
    vto: !!recipe.vto && hasGarment,
    vtoCategory: garmentCategory(recipe, params),
    hiQuality: true,
    // Printable without pretending to have recovered detail: an ID photo
    // is already forced to its exact size above, so this only lifts the
    // looks a user might want on a large screen or on paper.
    minLongEdge: exact ? 0 : 1536,
  });

  // 4 — save the picture before any bookkeeping can fail.
  const docs = require("../docs/store");
  const ext = out.mime === "image/png" ? "png" : "jpg";
  const shortDesc = describe(recipe, params);
  const row = await docs.createDocument(userId, {
    buffer: out.buffer,
    filename: `hari-studio-${recipe.id}-${Date.now()}.${ext}`,
    mime: out.mime,
    note: shortDesc,
  });

  const title = `${recipe.title} — ${shortDesc}`.slice(0, 120);
  const updated = await docs
    .setMetadata(userId, row.id, {
      title,
      category: recipe.id === "idphoto" ? "id" : "other",
      docDate: new Date().toISOString().slice(0, 10),
      summary:
        `Style Studio: ${recipe.title.toLowerCase()} — ${shortDesc}. ` +
        `AI-generated from the user's own photo by ${out.provider}. ` +
        `${out.width}x${out.height}px.`,
      tags: ["studio", recipe.id, "ai-generated"],
      fullText: `Style Studio ${recipe.id} result. ${shortDesc}. Instruction: ${instruction.slice(0, 900)}`,
    })
    .catch(() => null);

  // 5 — records.
  const look = await store.addLook(userId, {
    recipe: recipe.id,
    documentId: row.id,
    photoId,
    garmentId,
    prompt: shortDesc,
    params,
    provider: out.provider,
    ms: out.ms,
  });

  try {
    require("../actions/store").record(userId, {
      tool: "style_studio", args: { recipe: recipe.id, ...params }, ok: true, world: false,
      intent: shortDesc, surface: o.surface || "app", decision: "ran", ms: out.ms,
      result: `${recipe.id} via ${out.provider} → ${out.width}x${out.height} document ${row.id}`,
    });
  } catch (_) {}

  console.log(
    `studio: ${recipe.id} for user ${userId} via ${out.provider} in ${out.ms}ms ` +
    `→ ${out.width}x${out.height} (${Math.round(out.buffer.length / 1024)} kB)` +
    (out.notes.length ? ` | ${out.notes.join(" | ")}` : "")
  );

  return {
    look,
    document: docs.toClient(updated || row),
    provider: out.provider,
    ms: out.ms,
    width: out.width,
    height: out.height,
    spec: exact ? { width: exact.width, height: exact.height, mm: exact.mm } : null,
    aiGenerated: true,
  };
}

/** A short human line naming what this look actually is. */
function describe(recipe, params) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = String(params[k] || "").trim();
      if (v && !/^as (it comes|described)$/i.test(v) && !/^keep/i.test(v)) return v;
    }
    return "";
  };
  switch (recipe.id) {
    case "outfit": return pick("outfit", "occasion") || "a new outfit";
    case "hair": {
      const s = pick("style"), c = pick("colour");
      return [s, c].filter(Boolean).join(", ") || "a new hairstyle";
    }
    case "beard": return pick("style") || "new facial hair";
    case "eyewear": return pick("frame") || "new spectacles";
    case "jewellery": return pick("piece") || "jewellery";
    case "headshot": return pick("attire", "backdrop") || "professional headshot";
    case "idphoto": return pick("spec") || "ID photo";
    case "restore": return "restored";
    case "backdrop": return pick("scene") || "a new background";
    case "occasion": return pick("occasion") || "an occasion look";
    default: return recipe.title;
  }
}

/** Add a photo to the studio: store the bytes, then remember the role. */
async function addPhoto(userId, { buffer, mime, role = "model", label = "", makeDefault = false }) {
  const docs = require("../docs/store");
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const row = await docs.createDocument(userId, {
    buffer,
    filename: `hari-studio-${role}-${Date.now()}.${ext}`,
    mime,
    note: label || (role === "model" ? "Style Studio photo of me" : "Style Studio wardrobe item"),
  });
  await docs
    .setMetadata(userId, row.id, {
      title: label || (role === "model" ? "My Style Studio photo" : "Wardrobe item"),
      category: "other",
      docDate: new Date().toISOString().slice(0, 10),
      summary: role === "model"
        ? "The user's own photo, used as the base for Style Studio looks."
        : `A clothing or accessory item the user photographed for Style Studio${label ? `: ${label}` : ""}.`,
      tags: ["studio", role],
      // No vision call needed — we know exactly what this is, and spending
      // one on every wardrobe photo would be pure waste.
      fullText: role === "model" ? "Style Studio base photo." : `Style Studio wardrobe item. ${label}`,
    })
    .catch(() => null);
  return store.addPhoto(userId, {
    role, documentId: row.id, label, makeDefault,
  });
}

module.exports = { runRecipe, addPhoto, readDocument, describe, garmentCategory };
