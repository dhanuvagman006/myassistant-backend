/**
 * POSTER STUDIO AND PHOTO EDITS BY VOICE (2026-09-30).
 *
 *   create_event_poster  "make a poster for our event tomorrow", "a flyer
 *                        for the Diwali sale", "a banner for the meeting".
 *                        The request becomes poster fields (studio.design,
 *                        only facts the user gave), a text-free background
 *                        starts, and the phone opens the studio:
 *                          deviceAction {type:'open_poster_studio', design,
 *                            backgroundId, background, backgroundJob, request}
 *                        backgroundId/background are set when the picture
 *                        was ready in time; otherwise backgroundJob is the id
 *                        the app polls at GET /posters/ai/background/jobs/:id.
 *   edit_my_photo        "remove the background", "change the colour",
 *                        "make this look professional", "put this person in
 *                        a formal setting" — on the photo they just shared
 *                        (or photo_doc_id). The result is a NEW document,
 *                        shown with the existing show_image action; the
 *                        original is never overwritten.
 *
 * Greeting cards that carry a real person, their words and signature stay
 * with make_greeting_poster (posters/tools.js) — no model draws those.
 *
 * App builds before POSTER_STUDIO_MIN_BUILD (default 135) have no studio
 * screen: create_event_poster is not offered to them and generate_image
 * keeps its old behaviour for a poster.
 */
const fs = require("fs");
const studio = require("./studio");
const { PosterError } = require("./service");

function studioMinBuild() {
  const n = Number(process.env.POSTER_STUDIO_MIN_BUILD);
  return Number.isInteger(n) && n > 0 ? n : 135;
}

function buildOf(ctx) {
  return Number(ctx && ctx.appBuild) || 0;
}

/**
 * "A poster WITH WORDS": a poster, flyer, banner or invitation for an
 * event, a sale, an announcement — not a picture called a poster ("a
 * poster of a tiger") and not a greeting card with a person on it.
 */
const POSTER_WORDS = /\b(poster|flyer|flier|banner|invitation|invite|notice|announcement|pamphlet)\b/i;
const EVENT_HINT =
  /\b(event|meeting|party|sale|offer|opening|launch|workshop|seminar|conference|festival|celebration|concert|match|tournament|class|classes|camp|fest|function|programme|program|ceremony|drive|webinar|puja|pooja|gathering|reunion|exhibition|expo|admissions?|tomorrow|today|tonight|(mon|tues|wednes|thurs|fri|satur|sun)day|\d{1,2}(:\d{2})?\s*(am|pm))\b/i;
const PERSON_CARD = /\b(greeting )?card\b|\b(birthday|anniversary|wedding) (wishes|card)\b/i;

function isWordsPoster(text) {
  const t = String(text || "");
  return POSTER_WORDS.test(t) && EVENT_HINT.test(t) && !PERSON_CARD.test(t);
}

/** What makes a poster the STUDIO's: their own photo, the gallery, or the studio by name. */
const WANTS_STUDIO =
  /\b(my|our|his|her|this|that) (own )?(photo|picture|pic|image|selfie)s?\b|\bfrom (my |the )?gallery\b|\bposter studio\b|\b(image|photo) picker\b|\b(choose|pick|select) a (photo|picture)\b|\bedit the words\b/i;

/**
 * generate_image hands a poster to the studio only when the user wants
 * the studio: their own photo on it, a picture from the gallery, or the
 * studio by name. Since 2026-10-02 the image model (gpt-image-1) sets
 * words correctly itself, so a plain "make a poster for X" is generated
 * outright (the owner: "did I say open the image picker?"). Without the
 * OpenAI image model the old rule stands: the studio sets the words.
 */
function shouldRouteToStudio(args, ctx) {
  if (!studio.aiOn() || buildOf(ctx) < studioMinBuild()) return false;
  const text = String((ctx && ctx.userText) || "");
  const prompt = String((args && args.prompt) || "");
  if (!require("../services/ai/openai").ready()) return isWordsPoster(text) || isWordsPoster(prompt);
  return WANTS_STUDIO.test(text) || WANTS_STUDIO.test(prompt);
}

/** bg: 'ready' | 'running' | 'none' (it failed or was not started). */
function studioNote(design, bg) {
  const said = [design.title, design.dateText, design.timeText, design.location].filter(Boolean);
  const missing = design.missing || [];
  const ask = {
    title: "what the event is called", dateText: "the date", timeText: "the time",
    location: "where it is", contact: "a contact number", price: "the price or entry fee",
    host: "who is hosting it", speaker: "who is speaking", registration: "how to register",
  };
  return "The poster studio is OPENING on the phone with the words laid out " +
    ({ ready: "over the background. ",
      running: "; the background is still being made and will appear by itself. ",
      none: "; the background could not be made just now — the user can make one from the studio. " }[bg]) +
    (said.length ? `Read these back exactly as written: ${said.join(" · ")}. ` : "") +
    (missing.length
      ? `Then ask ONE short question for ${ask[missing[0]] || missing[0]} — the poster does not have it. `
      : "Ask if anything should change. ") +
    "Never invent a venue, a price, a phone number, a name or a time. Never say the poster is " +
    "finished or sent — say it is on the screen to check.";
}

async function runCreateEventPoster(args, ctx) {
  if (!ctx.userId) return { ok: false, error: "not signed in" };
  const uid = Number(ctx.userId);
  const request = String(args.request || ctx.userText || "").trim();
  if (!request) {
    return { ok: false, error: "need_request", note: "Ask what the poster is for, in one short question." };
  }
  // THE OWNER, 2026-10-02: generate it directly; the studio only on request.
  const said = String((ctx && ctx.userText) || "");
  if (require("../services/ai/openai").ready() && !WANTS_STUDIO.test(said) && !WANTS_STUDIO.test(request)) {
    const gen = require("../tools/registry").get("generate_image");
    if (gen) {
      const prompt = `An eye-catching, professionally designed poster for this: ${request.replace(/"/g, "'")}. ` +
        "Set the event's name as a bold headline and the date, time and place clearly below it, using only the " +
        "facts given, every word spelled exactly. Vivid, polished, high-end print design. No other text, and no " +
        "people, faces, gods or figures unless the request describes them.";
      return gen.execute({ prompt, aspect: args.format === "story" ? "story" : args.format === "square" ? "square" : "portrait", _raw: true }, ctx);
    }
  }
  try {
    const design = await studio.design(uid, {
      request,
      format: args.format,
      tzOffsetMin: Number.isFinite(ctx.tzOffsetMin) ? ctx.tzOffsetMin : 330,
    });
    let job = null;
    try {
      job = studio.startBackgroundJob(uid, {
        prompt: design.backgroundPrompt, style: design.style, format: design.format,
      });
    } catch (e) {
      if (!(e instanceof PosterError)) throw e;
    }
    const waitMs = Number(process.env.POSTER_TOOL_WAIT_MS);
    const snap = job ? await studio.waitJob(job, Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : 12_000) : null;
    const bg = snap && snap.status === "done" ? snap.background : null;
    return {
      ok: true,
      data: {
        title: design.title, dateText: design.dateText, timeText: design.timeText,
        location: design.location, missing: design.missing, style: design.style,
        backgroundReady: !!bg,
      },
      deviceAction: {
        type: "open_poster_studio",
        request: request.slice(0, 500),
        design,
        backgroundId: bg ? bg.id : null,
        background: bg,
        backgroundJob: !bg && snap && snap.status === "running" ? snap.jobId : null,
      },
      note: studioNote(design, bg ? "ready" : snap && snap.status === "running" ? "running" : "none"),
    };
  } catch (e) {
    if (e instanceof PosterError) {
      return { ok: false, error: e.message, data: { code: e.code } };
    }
    console.error("create_event_poster:", e && (e.stack || e.message));
    return { ok: false, error: "The poster hit a snag — ask me to try that again in a moment." };
  }
}

/* ------------------------------------------------------------------ */

const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

/** The photo to edit: the one named, else the newest image they saved or
 *  shared (never an emailed attachment). */
async function photoDocument(uid, docId) {
  const docs = require("../docs/store");
  if (Number(docId) > 0) {
    const d = await docs.getDocument(uid, Number(docId));
    return d && IMAGE_MIME.has(d.mime) ? d : null;
  }
  const rows = await docs.listDocuments(uid, 30);
  return rows.find((d) => IMAGE_MIME.has(d.mime) && d.source !== "email") || null;
}

async function runEditMyPhoto(args, ctx) {
  if (!ctx.userId) return { ok: false, error: "not signed in" };
  const uid = Number(ctx.userId);
  const instruction = String(args.instruction || "").trim().slice(0, 600);
  if (!instruction) return { ok: false, error: "need_instruction", note: "Ask what to change in the photo." };
  const photoEdit = require("../services/photoEdit");
  const doc = await photoDocument(uid, args.photo_doc_id);
  if (!doc) {
    return {
      ok: false,
      error: "no_photo",
      note: "There is no photo to edit yet. Ask them to share or save the photo first, in one short line.",
    };
  }
  let buffer;
  try {
    buffer = fs.readFileSync(doc.path);
  } catch (_) {
    return { ok: false, error: "no_photo", note: "That photo's file isn't here any more. Ask them to share it again." };
  }
  let out;
  try {
    out = await photoEdit.editPhoto({ buffer, mime: doc.mime, instruction });
  } catch (e) {
    if (e instanceof photoEdit.PhotoEditError) {
      return {
        ok: false,
        error: e.message,
        data: { code: e.code, photo_doc_id: doc.id },
        note: e.code === "identity"
          ? "Say this kindly in one or two lines and offer the edits you can do. Nothing was changed."
          : "Say this in one short line. Nothing was changed, the original is untouched, and it is " +
            "not the photo's fault.",
      };
    }
    console.error("edit_my_photo:", e && (e.stack || e.message));
    return { ok: false, error: "That edit didn't come back this time — ask me to try again in a moment." };
  }

  const docs = require("../docs/store");
  const ext = out.mime === "image/png" ? "png" : "jpg";
  const row = await docs.createDocument(uid, {
    buffer: out.buffer,
    filename: `photo-edit-${Date.now()}.${ext}`,
    mime: out.mime,
    note: `edited: ${instruction}`,
  });
  const title = out.op === "remove_background"
    ? `Photo, background removed${out.transparent ? "" : " (white)"}`
    : `Edited photo - ${instruction.slice(0, 60)}`;
  const updated = await docs.setMetadata(uid, row.id, {
    title,
    category: "other",
    docDate: new Date().toISOString().slice(0, 10),
    summary: `An AI edit of "${doc.title || doc.filename}": ${instruction}. The original is kept unchanged.`,
    tags: ["edited", "ai-edit", ...(out.transparent ? ["transparent"] : [])],
    fullText: `AI photo edit of document ${doc.id}. Instruction: ${instruction}`,
  }).catch(() => null);
  return {
    ok: true,
    data: {
      edited: true,
      documentId: row.id,
      from_document_id: doc.id,
      title,
      transparent: out.transparent,
      note:
        "The edited photo EXISTS, is saved as a new document and is on the screen now; the " +
        "original is unchanged." +
        (out.op === "remove_background" && !out.transparent
          ? " The background is plain white, not transparent — say so if they need a cut-out."
          : ""),
    },
    deviceAction: {
      type: "show_image",
      doc_id: row.id,
      prompt: instruction,
      title,
      document: docs.toClient(updated || row),
    },
    speak: "Here it is — the edited photo is on the screen, and your original is kept as it was.",
  };
}

function registerStudioTools(registry) {
  registry.register({
    name: "create_event_poster",
    minAppBuild: studioMinBuild(),
    deviceAction: true,
    risk: "low",
    timeoutMs: 35_000,
    description:
      "THE POSTER STUDIO — only when the user wants it: THEIR OWN PHOTO on the poster, a picture " +
      "from their gallery, the words laid out to edit by hand, or 'open the poster studio'. A plain " +
      "'make a poster for our event tomorrow' is generate_image, which sets the words itself. " +
      "Pass the user's request in their own words. The poster studio " +
      "opens on the phone: the words are set in real fonts over an AI background, so nothing is " +
      "misspelt. Only facts the user said go on it — anything missing (the place, the time) comes " +
      "back in `missing`; ask for it, never invent it. NOT for a greeting card with a real person's " +
      "name, photo or signature (make_greeting_poster), and NOT for a picture with no words " +
      "(generate_image).",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string", description: "What the poster is for, in the user's own words — every fact they gave." },
        format: { type: "string", enum: Object.keys(studio.FORMATS), description: "portrait (4:5, default), story (9:16, for a status), square." },
      },
      required: ["request"],
    },
    execute: runCreateEventPoster,
  });

  registry.register({
    name: "edit_my_photo",
    deviceAction: true,
    risk: "low",
    timeoutMs: 60_000,
    description:
      "EDIT A PHOTO THEY SHARED OR SAVED — 'remove the background', 'make the background " +
      "transparent', 'change the shirt colour to blue', 'make this look professional', 'put this " +
      "person in a formal setting', 'brighten it'. Uses the newest photo they shared unless " +
      "photo_doc_id names one. The edit is saved as a NEW document and shown; the original is kept. " +
      "It never changes anyone's face or body (no face swaps, no 'make me fairer / younger / " +
      "slimmer'). For their OWN saved Style Studio selfie (outfits, hairstyles, passport photos) use " +
      "try_a_look; for cleaning up an OLD family photo use improve_old_photo.",
    inputSchema: {
      type: "object",
      properties: {
        instruction: { type: "string", description: "What to change, in the user's words." },
        photo_doc_id: { type: "integer", description: "The photo's document id. Omit for the photo they just shared." },
      },
      required: ["instruction"],
    },
    execute: runEditMyPhoto,
  });
}

module.exports = {
  registerStudioTools, runCreateEventPoster, runEditMyPhoto, shouldRouteToStudio, isWordsPoster,
  studioMinBuild,
};
