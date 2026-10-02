/**
 * PHOTO CARDS BY VOICE — "make a birthday card for my daughter with her
 * old photo and my signature", "bigger letters", "make it pink", "use
 * the other design", "go back", "send it to her on WhatsApp", "make this
 * old photo nice".
 *
 * The client is an elderly father who mostly speaks to the app; the owner
 * (2026-09-26): "he will share his daughter's old pic and we need to
 * draft a birthday poster that he can share with the contents he asked
 * us to mention", then "build it without AI… like a GIFT CARD".
 *
 * WHAT THESE TOOLS NEVER DO: write, polish or translate his words; call
 * any image model (generate_image invents a stranger's face and misspells
 * names); claim a card was sent. The card is drawn on the phone from the
 * spec; the tools only change the spec and tell the phone what to show.
 *
 * WHAT THE PHONE HEARS, as deviceActions (the app's _onEvent switch):
 *   poster_pick_photo  open the picker for a card (or a photo to clean up)
 *   poster_show        show the card (mode 'poster') or a photo (mode 'photo')
 *   poster_share       export the PNG, save it, open WhatsApp or the share sheet
 *   poster_sign        open the signature pad
 * The app answers the pick, the pad and the share with a [SYSTEM] line.
 *
 * App build 119 ships the card screen (POSTER_MIN_BUILD). Older builds are
 * offered none of this and keep today's behaviour: generate_image for a
 * plain picture card.
 */
const S = require("./spec");

// The card maker is for THEIR photo or a template they asked for by name.
const ASKS_FOR_CARD_MAKER =
  /\b(card maker|poster studio|template|image picker|photo picker|from (my |the )?gallery|signature|(my|our|his|her|their|this|that|the) (own |old )?(photo|picture|pic|image|selfie)s?|with (a |the |my |her |his |their )?(photo|picture|pic))\b/i;
function wantsCardMaker(args, ctx) {
  if (Number(args.photo_id) > 0 || Number(args.document_id) > 0 || Number(args.poster_id) > 0) return true;
  const said = String((ctx && ctx.userText) || "");
  // A live turn may not carry their words; then the model's own "pick" stands.
  return said ? ASKS_FOR_CARD_MAKER.test(said) : args.photo === "pick";
}
/** The card as an image prompt: their words quoted, nothing invented. */
function greetingPrompt(args) {
  const occasion = String(args.occasion || "birthday").replace(/_/g, " ").toLowerCase();
  const head = String(args.headline || (occasion === "birthday" ? "Happy Birthday" : `Happy ${occasion.replace(/\b\w/g, (c) => c.toUpperCase())}`)).trim();
  const q = (v) => String(v || "").replace(/"/g, "'").trim();
  const words = [`a large elegant headline "${q(head)}"`];
  if (args.name) words.push(`the name "${q(args.name)}" prominently below it`);
  if (Number(args.age) > 0) words.push(`the number "${Number(args.age)}" as a decorative accent`);
  if (args.message) words.push(`the message "${q(args.message)}" in smaller graceful lettering`);
  if (args.from) words.push(`signed "— ${q(args.from)}" at the bottom`);
  if (args.date) words.push(`the date "${q(args.date)}"`);
  const colour = args.colour ? ` in ${q(args.colour)} tones` : "";
  return `A beautiful, festive ${occasion} greeting card poster${colour}, portrait, rich colours, ` +
    "an ornate decorative frame, soft glowing bokeh light, flowers and celebratory details, polished " +
    `professional print design. Print exactly these words, spelled exactly as written: ${words.join(", ")}. ` +
    "No other text anywhere.";
}
const svc = require("./service");

const POSTER_MIN_BUILD = 119;

function buildOf(ctx) {
  return Number(ctx && ctx.appBuild) || 0;
}
function tooOld(ctx) {
  const b = buildOf(ctx);
  return b > 0 && b < POSTER_MIN_BUILD;
}
const TOO_OLD = {
  ok: false,
  error: "app_too_old",
  data: { needsBuild: POSTER_MIN_BUILD },
  note: "This phone's app is too old for photo cards. Say an app update is needed, in one line.",
};

/** The card's lines and how to read them back. */
function readBack(poster) {
  const spec = poster.spec;
  return { words: S.words(spec), spell: spec.name ? S.spell(spec.name) : null };
}

const SHOW_NOTE = (spell) =>
  "The card is ON THE SCREEN. Read the words back exactly as they are written, " +
  (spell ? `spell the name letter by letter (${spell}), ` : "say the name slowly, ") +
  "and ask if it is right. Do not describe the photo. Never say the card is made, " +
  "ready or created — say it is on the screen.";

const PICK_NOTE =
  "NOTHING is made yet. The photo picker is opening on the phone. Say one short line " +
  "(for example 'Let's choose the photo') and wait for the [SYSTEM] line — ask nothing else now.";

/** A PosterError, or anything else, as one sentence the model can say. */
function fromError(e) {
  if (e instanceof svc.PosterError) {
    if (e.code === "need") {
      const n = (e.extra.need || [])[0] || {};
      return {
        ok: false,
        error: n.reason === "too_long" ? "too_long" : "check_value",
        data: { field: n.field, max: n.max, words: S.FIELD_WORDS[n.field] || n.field },
        note: n.reason === "too_long"
          ? `Nothing was made. ${S.FIELD_WORDS[n.field] || n.field} is too long for the card ` +
            `(up to ${n.max} letters). Ask the user to shorten it — never cut it yourself.`
          : `Nothing was changed. Ask the user to check ${S.FIELD_WORDS[n.field] || n.field}.`,
      };
    }
    return { ok: false, error: e.message, data: { code: e.code } };
  }
  console.error("posters tool:", e && (e.stack || e.message));
  return { ok: false, error: "The card hit a snag — ask me to try that again in a moment." };
}

/** The lines an empty string takes off a card being changed. Never the name. */
const CLEARABLE = new Set(["message", "from", "headline", "date", "forWhom"]);

/**
 * Tool args (snake_case) → a partial spec (REST camelCase). `editing`
 * (a card being changed, not started): an empty string takes that line
 * off — for the heading, back to the card's own — and age 0 takes the
 * age off (registry.coerceArgs turns a null age into 0). Dropped, they
 * made "take the date off" and "put the normal heading back" impossible
 * by voice, and "remove the age" came back as "check the age" (review,
 * 2026-09-26). A new card has nothing to take off, so they are ignored.
 */
function partialFrom(args, { editing = false } = {}) {
  const p = {};
  for (const [from, to] of [["name", "name"], ["message", "message"], ["from", "from"],
    ["headline", "headline"], ["date", "date"], ["for_whom", "forWhom"]]) {
    if (args[from] === undefined || args[from] === null) continue;
    if (String(args[from]).trim() !== "") p[to] = args[from];
    else if (editing && CLEARABLE.has(to)) p[to] = "";
  }
  if (args.age !== undefined && args.age !== null && args.age !== "") {
    if (Number(args.age) === 0) {
      if (editing) p.age = null;
    } else {
      p.age = args.age;
    }
  }
  if (args.occasion) p.occasion = args.occasion;
  if (args.language) p.language = args.language;
  if (args.design) p.design = args.design;
  if (args.format) p.format = args.format;
  if (args.signature !== undefined) p.signature = args.signature === true || args.signature === "true";
  return p;
}

/** An unknown colour word is asked about, never guessed. */
function colourArg(args) {
  if (args.colour === undefined || args.colour === null || String(args.colour).trim() === "") return { ok: true };
  const c = S.resolveColour(args.colour);
  if (!c) {
    return {
      ok: false,
      res: {
        ok: false,
        error: "unknown_colour",
        data: { colours: S.COLOURS },
        note: `The cards come in ${S.COLOURS.join(", ")}. Ask which one — nothing was changed.`,
      },
    };
  }
  return { ok: true, colour: c };
}

function designArg(args) {
  if (!args.design) return { ok: true };
  const d = args.design === "next" ? "next" : S.resolveDesign(args.design);
  if (!d) {
    return {
      ok: false,
      res: {
        ok: false,
        error: "unknown_design",
        data: { designs: S.DESIGNS.map((x) => x.label) },
        note: `The designs are ${S.DESIGNS.map((x) => x.label).join(", ")}. Ask which one — nothing was changed.`,
      },
    };
  }
  return { ok: true, design: d };
}

function showAction(poster) {
  return { type: "poster_show", mode: "poster", poster };
}

function pickAction(posterId, { purpose = "poster", source = "ask", colour = "keep" } = {}) {
  return { type: "poster_pick_photo", purpose, poster_id: posterId, source, colour };
}

async function posterFor(userId, posterId) {
  // 0 or empty is "no card named": coerceArgs turns "" into 0.
  if (Number(posterId) > 0) return svc.getPoster(userId, posterId);
  return svc.latestPoster(userId);
}

const NO_POSTER = {
  ok: false,
  error: "no_poster",
  note: "There is no card yet — offer to make one (make_greeting_poster). Nothing was changed.",
};

/** The designs, as the model reads them. */
const DESIGN_LIST = S.DESIGNS.map((d) => `${d.id} (${d.label})`).join(", ");

function registerPosterTools(registry) {
  registry.register({
    name: "make_greeting_poster",
    minAppBuild: POSTER_MIN_BUILD,
    deviceAction: true,
    risk: "low",
    // Continuing a card (poster_id) only edits the undoable draft on his
    // screen, which is read back to him: a one-word answer to the question
    // just asked ("Ananya") may drive it, and it is never a stutter of
    // the call that started the card (registry GATE 1 and GATE 2).
    draftEdit: (args) => Number(args && args.poster_id) > 0,
    description:
      "Birthday/anniversary/greeting POSTER or CARD with the user's exact words, a REAL photo " +
      "and/or their signature. Use this, NEVER generate_image, whenever a card carries a name, " +
      "dictated wishes or a real person's photo — 'make a birthday card for my daughter with her " +
      "old photo', 'a wedding anniversary card from us', 'put my signature on it', 'Happy 60th " +
      "birthday Appa'. A gift card: the photo in a flower or festive frame, the heading, the name, " +
      "the wishes, who it is from.\n" +
      "Put names and wishes in EXACTLY as said, in the script they want — never write, polish or " +
      "translate them unless the user asks you to write them (then read your draft back first). " +
      "ONLY WHEN THEY ASK FOR THE CARD MAKER OR WANT THEIR OWN PHOTO ON IT — a plain 'make a birthday " +
      "card for Ravi' is generate_image. The photo is picked on the phone (photo 'pick'), taken from a saved " +
      "document (document_id), or is a photo just cleaned up with improve_old_photo " +
      "(photo_id — 'make a card with it'); 'without a photo' is photo 'none'. Ask ONE question " +
      "at a time. Continue a card already started by passing poster_id. Nothing here is AI: " +
      `the card is drawn on the phone. Designs: ${DESIGN_LIST}.`,
    inputSchema: {
      type: "object",
      properties: {
        occasion: { type: "string", enum: S.OCCASIONS, description: "Default birthday." },
        for_whom: { type: "string", description: "Who it is for, in their words ('my daughter') — never printed." },
        name: { type: "string", description: "The name exactly as it should be printed, in the script they want." },
        age: { type: "integer", description: "1-120, when said (the age turning, or the anniversary year)." },
        message: { type: "string", description: "Their wishes WORD FOR WORD; never write, polish or translate." },
        from: { type: "string", description: "Who it is from, as they said it ('Appa', 'Amma and Appa')." },
        headline: { type: "string", description: "Only if they dictated a heading; otherwise the card's own." },
        date: { type: "string", description: "A date to print, only if they asked for one." },
        language: { type: "string", enum: S.LANGUAGES, description: "Only if they asked; otherwise from the words." },
        colour: { type: "string", description: `One of ${S.COLOURS.join(", ")} (or a colour word).` },
        design: { type: "string", description: `One of: ${S.DESIGN_IDS.join(", ")}.` },
        format: { type: "string", enum: Object.keys(S.FORMATS), description: "story = tall, for a WhatsApp status. Default portrait." },
        signature: { type: "boolean", description: "True when they want their own signature on it." },
        photo: { type: "string", enum: ["pick", "none"], description: "pick opens the photo picker — only when they said they want their photo on it; none = no photo." },
        photo_id: { type: "integer", description: "A photo already picked and cleaned up (the photo_id improve_old_photo gave) — put on the card, no picker." },
        document_id: { type: "integer", description: "A photo already in their documents, to use on the card." },
        poster_id: { type: "integer", description: "Continue this card instead of starting a new one." },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      // THE OWNER, 2026-10-02: "directly generate the image when the user
      // asks for it. Remove that poster thing until he asks us." The card
      // maker (photo picker, phone-drawn template) only when they asked
      // for it or for their own photo; otherwise OpenAI's image model makes
      // the card with their exact words.
      if (!wantsCardMaker(args, ctx)) {
        const gen = registry.get("generate_image");
        if (gen) return gen.execute({ prompt: greetingPrompt(args), aspect: args.format === "story" ? "story" : "portrait", _raw: true }, ctx);
      }
      if (tooOld(ctx)) return TOO_OLD;
      const uid = Number(ctx.userId);
      const col = colourArg(args);
      if (!col.ok) return col.res;
      const des = designArg(args);
      if (!des.ok) return des.res;
      try {
        const continuing = Number(args.poster_id) > 0;
        const partial = partialFrom(args, { editing: continuing });
        if (col.colour) partial.colour = col.colour;
        if (des.design) partial.design = des.design;
        if (args.photo === "none") partial.photoUse = "none";
        // "Make a card with it" after improve_old_photo: that photo, not the
        // picker again (review, 2026-09-26: he had to find the same photo
        // twice, and it was cleaned up twice).
        const photoId = Number(args.photo_id) > 0 && args.photo !== "none" ? Number(args.photo_id) : null;

        let poster;
        if (continuing) {
          const { set, change } = splitChange(partial);
          if (Object.keys(set).length) change.set = set;
          if (photoId) change.photoId = photoId;
          poster = (await svc.patchPoster(uid, args.poster_id, { change })).poster;
        } else {
          poster = await svc.createPoster(uid, { spec: partial, photoId });
        }
        if (args.document_id && !poster.photo) {
          const out = await svc.addPhotoFromDocument(uid, { documentId: args.document_id, posterId: poster.id });
          poster = out.poster;
        }

        // The picker opens for a NEW card unless they said "no photo". A
        // card being continued already had its chance (a closed picker is
        // answered by its own [SYSTEM] line), so only an explicit 'pick'
        // reopens it — "without a photo" must never be asked twice.
        const missing = S.missing(poster.spec);
        const pick = !poster.photo && (continuing ? args.photo === "pick" : args.photo !== "none");
        if (pick) {
          return {
            ok: true,
            data: { poster_id: poster.id, missing, next: "waiting for the photo" },
            deviceAction: pickAction(poster.id, { purpose: "poster" }),
            note: PICK_NOTE,
          };
        }
        if (!poster.spec.name) {
          return {
            ok: true,
            data: { poster_id: poster.id, missing },
            note:
              "The card is not on the screen yet. Ask ONE short question for what is missing: " +
              "the name exactly as it should be written, the age, the wishes, and who it is from.",
          };
        }
        const rb = readBack(poster);
        return {
          ok: true,
          data: {
            poster_id: poster.id,
            words: rb.words,
            spell: rb.spell,
            design: S.designById(poster.spec.design).label,
            missing,
          },
          deviceAction: showAction(poster),
          note: SHOW_NOTE(rb.spell),
        };
      } catch (e) {
        return fromError(e);
      }
    },
  });

  registry.register({
    name: "change_poster",
    minAppBuild: POSTER_MIN_BUILD,
    deviceAction: true,
    risk: "low",
    description:
      "CHANGE THE CARD that is on the screen (or the latest one): 'bigger letters', 'smaller', " +
      "'make it pink', 'use the other design', 'the flowers one', 'change the name to…', 'add " +
      "love from Amma', 'make the photo black and white', 'use the original photo', 'choose " +
      "another photo', 'remove my signature', 'sign it again', 'make it tall for my status', " +
      "'take the date off', 'go back' / 'undo'. With no arguments it just shows the latest card " +
      "again. Words go in EXACTLY as said; an empty string takes that line off the card. " +
      "text_size bigger/smaller steps the letters; design 'next' is the other design. " +
      `Designs: ${DESIGN_LIST}.`,
    inputSchema: {
      type: "object",
      properties: {
        poster_id: { type: "integer", description: "Default: the latest card." },
        name: { type: "string", description: "New name, exactly as it should be printed." },
        age: { type: "integer", description: "1-120; 0 takes the age off the card." },
        message: { type: "string", description: "New wishes, WORD FOR WORD; empty string takes them off." },
        from: { type: "string", description: "Who it is from; empty string takes the line off." },
        headline: { type: "string", description: "A dictated heading; empty string = the card's own heading." },
        date: { type: "string", description: "A date to print; empty string takes it off." },
        colour: { type: "string", description: `${S.COLOURS.join(", ")} (or a colour word).` },
        design: { type: "string", description: `next, or one of: ${S.DESIGN_IDS.join(", ")}.` },
        format: { type: "string", enum: Object.keys(S.FORMATS), description: "story = tall for a WhatsApp status; portrait = the normal card." },
        text_size: { type: "string", enum: ["bigger", "smaller", "reset"] },
        photo: { type: "string", enum: ["enhanced", "original", "pick", "none"],
          description: "enhanced = the cleaned-up photo, original = as picked, pick = choose another, none = remove it." },
        photo_id: { type: "integer", description: "Put this already-picked photo (improve_old_photo's photo_id) on the card." },
        photo_colour: { type: "string", enum: S.PHOTO_COLOURS, description: "The photo in its own colours, black and white, or sepia." },
        signature: { type: "string", enum: ["on", "off", "redo"] },
        undo: { type: "boolean", description: "Go back one change." },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      if (tooOld(ctx)) return TOO_OLD;
      const uid = Number(ctx.userId);
      const col = colourArg(args);
      if (!col.ok) return col.res;
      const des = designArg(args);
      if (!des.ok) return des.res;
      try {
        const current = await posterFor(uid, args.poster_id);
        if (!current) return NO_POSTER;

        if (args.photo === "pick") {
          return {
            ok: true,
            data: { poster_id: current.id },
            deviceAction: pickAction(current.id, { purpose: "poster" }),
            note: PICK_NOTE,
          };
        }
        if (args.signature === "redo") {
          return {
            ok: true,
            data: { poster_id: current.id },
            deviceAction: { type: "poster_sign", poster_id: current.id },
            note: "The signature pad is opening on the phone. Say one short line and wait for the [SYSTEM] line.",
          };
        }

        const photoId = Number(args.photo_id) > 0 ? Number(args.photo_id) : null;
        if (args.photo_colour && !current.photo && !photoId) {
          return { ok: false, error: "the card has no photo yet", note: "Offer to choose a photo (photo 'pick')." };
        }

        let poster = current;
        let limitReached = false;
        let changed = false;
        if (args.undo) {
          const out = await svc.patchPoster(uid, current.id, { change: { undo: true } });
          poster = out.poster;
          changed = true;
        } else {
          const partial = partialFrom(args, { editing: true });
          delete partial.signature;
          if (col.colour) partial.colour = col.colour;
          if (des.design) partial.design = des.design;
          const { set, change } = splitChange(partial);
          if (Object.keys(set).length) change.set = set;
          if (args.text_size) change.textSize = args.text_size;
          if (photoId) change.photoId = photoId;
          // The photo's colour is part of the card (review, 2026-09-26):
          // one versioned edit, in the undo history like any other, never
          // a file rewritten behind the card's back.
          if (args.photo_colour) change.photoColour = args.photo_colour;
          if (args.photo === "enhanced" || args.photo === "original" || args.photo === "none") {
            change.photoUse = args.photo;
          } else if (args.photo_colour) {
            change.photoUse = "enhanced";
          }
          if (args.signature === "on") change.signature = true;
          if (args.signature === "off") change.signature = false;
          if (Object.keys(change).length) {
            const out = await svc.patchPoster(uid, current.id, { change });
            poster = out.poster;
            limitReached = !!out.limitReached;
            changed = out.changed;
          }
        }

        const rb = readBack(poster);
        const wordsChanged = ["name", "message", "from", "headline", "age", "date"].some((k) => args[k] !== undefined);
        let note = changed
          ? "The change is on the screen. Say it in a few words" +
            (wordsChanged ? " and read the changed words back exactly" + (rb.spell ? `, spelling the name (${rb.spell})` : "") : "") +
            ". Never say the card is made or ready."
          : "The card is on the screen again, unchanged. Ask what they would like to change.";
        if (limitReached) {
          note = args.text_size === "bigger"
            ? "The letters are already as big as the card allows — say so honestly, in one line."
            : "The letters are already as small as they go — say so honestly, in one line.";
        }
        return {
          ok: true,
          data: {
            poster_id: poster.id,
            words: rb.words,
            spell: rb.spell,
            design: S.designById(poster.spec.design).label,
            colour: poster.spec.colour,
            photo_colour: poster.spec.photoColour,
            text_scale: poster.spec.textScale,
            ...(limitReached ? { limit_reached: true } : {}),
          },
          deviceAction: showAction(poster),
          note,
        };
      } catch (e) {
        if (e instanceof svc.PosterError && e.code === "nothing_to_undo") {
          return {
            ok: false,
            error: "nothing_to_undo",
            note: "There is nothing to undo — the card is as it started. Say so in one line.",
          };
        }
        return fromError(e);
      }
    },
  });

  registry.register({
    name: "share_poster",
    minAppBuild: POSTER_MIN_BUILD,
    deviceAction: true,
    risk: "low",
    description:
      "SEND / SHARE THE CARD: 'send it to her on WhatsApp', 'share the card', 'put it on my " +
      "status', 'save it to my photos'. WhatsApp (or the share menu) opens WITH the card; the " +
      "user picks the person and presses Send themselves. The card is also saved to their " +
      "documents. Never say it was sent.",
    inputSchema: {
      type: "object",
      properties: {
        poster_id: { type: "integer", description: "Default: the latest card." },
        app: { type: "string", enum: ["whatsapp", "any"], description: "Default whatsapp; any = the phone's share menu." },
        save_to_photos: { type: "boolean", description: "Also save it in the phone's photos." },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      if (tooOld(ctx)) return TOO_OLD;
      try {
        const poster = await posterFor(Number(ctx.userId), args.poster_id);
        if (!poster) return NO_POSTER;
        const app = args.app === "any" ? "any" : "whatsapp";
        return {
          ok: true,
          data: { poster_id: poster.id, app },
          deviceAction: {
            type: "poster_share",
            poster_id: poster.id,
            app,
            save_to_photos: args.save_to_photos === true,
          },
          note: app === "whatsapp"
            ? "WhatsApp is opening with the card; the user picks the person and presses Send. " +
              "Never say it was sent."
            : "The share menu is opening with the card; the user picks where it goes and presses " +
              "Send. Never say it was sent.",
        };
      } catch (e) {
        return fromError(e);
      }
    },
  });

  registry.register({
    name: "improve_old_photo",
    minAppBuild: POSTER_MIN_BUILD,
    deviceAction: true,
    risk: "low",
    description:
      "MAKE AN OLD PHOTO NICER — 'make this old photo clear', 'make my mother's old picture " +
      "nice and beautiful', 'brighten this faded photo', 'make it black and white'. The user " +
      "picks the photo on the phone (or it is a saved document: document_id); it is gently " +
      "cleaned up — brighter, clearer colours, less fading, a little sharper — and shown next " +
      "to the original. It is NOT a repair: it cannot mend tears or scratches, and no AI " +
      "changes anyone's face. Never call it restored or repaired.\n" +
      "Once a photo is shown (it has a photo_id): 'keep the clearer one' → photo_id with keep " +
      "'enhanced' (the original: keep 'original') saves it to their documents; 'make it black " +
      "and white' → photo_id with colour. To put it on a card ('make a card with it') use " +
      "make_greeting_poster with photo_id.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "integer", description: "A photo already in their documents." },
        photo_id: { type: "integer", description: "The photo already shown (from the [SYSTEM] line or an earlier call)." },
        keep: { type: "string", enum: ["enhanced", "original"], description: "With photo_id: save that version to their documents." },
        colour: { type: "string", enum: S.PHOTO_COLOURS, description: "keep (default) = its own colours; bw = black and white; sepia." },
        source: { type: "string", enum: ["ask", "gallery", "camera"], description: "camera = photograph a printed photo. Default ask." },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      if (tooOld(ctx)) return TOO_OLD;
      const uid = Number(ctx.userId);
      const colour = S.PHOTO_COLOURS.includes(args.colour) ? args.colour : "keep";

      // THE PHOTO ALREADY ON THE SCREEN (review, 2026-09-26): the note
      // asks "keep the clearer one, or make a card with it?", and neither
      // answer had a voice path — "keep" is this, "a card" is
      // make_greeting_poster {photo_id}.
      if (Number(args.photo_id) > 0) {
        try {
          if (args.keep === "enhanced" || args.keep === "original") {
            const doc = await svc.keepPhoto(uid, args.photo_id, args.keep);
            return {
              ok: true,
              data: { photo_id: Number(args.photo_id), document_id: doc.id, title: doc.title },
              note: `Saved to their documents as "${doc.title}". Say so in one short line, and ` +
                "offer to make a card with it (make_greeting_poster with this photo_id).",
            };
          }
          const photo = args.colour
            ? await svc.recolourPhoto(uid, args.photo_id, colour)
            : await svc.getPhoto(uid, args.photo_id);
          return {
            ok: true,
            data: { photo_id: photo.id, colour: photo.colour, cleaned: photo.variants.includes("enhanced") },
            deviceAction: { type: "poster_show", mode: "photo", photo },
            note: "The photo is on the screen again" + (args.colour ? " in the colours asked for" : "") +
              ". Say it in a few words — never say it was restored or repaired. Ask ONE question: " +
              "keep the clearer one, or make a card with it?",
          };
        } catch (e) {
          return fromError(e);
        }
      }

      if (!args.document_id) {
        const source = ["gallery", "camera"].includes(args.source) ? args.source : "ask";
        return {
          ok: true,
          data: { next: "waiting for the photo" },
          deviceAction: pickAction(null, { purpose: "photo", source, colour }),
          note:
            "NOTHING is done yet. The photo picker is opening on the phone. Say one short line " +
            "and wait for the [SYSTEM] line.",
        };
      }
      try {
        const { photo } = await svc.addPhotoFromDocument(uid, { documentId: args.document_id, colour });
        const cleaned = photo.variants.includes("enhanced");
        return {
          ok: true,
          data: { photo_id: photo.id, cleaned },
          deviceAction: { type: "poster_show", mode: "photo", photo },
          note: cleaned
            ? `The cleaned-up photo (photo_id ${photo.id}) is on the screen next to the original. ` +
              "It is a gentle clean-up of colour, brightness and sharpness — never say it was " +
              "restored or repaired, and never comment on the photo's quality. Ask ONE question: " +
              "keep the clearer one (improve_old_photo with this photo_id and keep 'enhanced'), or " +
              "make a card with it (make_greeting_poster with this photo_id)?"
            : "The clean-up is not available right now; the photo is on the screen as it was. " +
              "Say so in one short line — never blame the photo.",
        };
      } catch (e) {
        return fromError(e);
      }
    },
  });
}

/** A partial spec split into PATCH's {set} words and its top-level looks. */
function splitChange(partial) {
  const set = {};
  const change = {};
  for (const [k, v] of Object.entries(partial)) {
    if (["headline", "name", "message", "from", "date", "forWhom", "age"].includes(k)) set[k] = v;
    else change[k] = v;
  }
  return { set, change };
}

/**
 * The prompt rule, before "CREATE IMAGES" in both prompts — only for app
 * builds that have the card screen; older builds keep today's words.
 * `voice` 'user' is the classic prompt ("the user"), 'me' the live one.
 */
function posterRule(appBuild, { voice = "user" } = {}) {
  if (!(Number(appBuild) >= POSTER_MIN_BUILD)) return "";
  return cardRule(voice) + studioRule(appBuild, voice);
}

/**
 * The AI Poster Studio (2026-09-30), only for builds with its screen: an
 * EVENT poster's words are facts set in real fonts, so it never goes to
 * generate_image; photo edits go to edit_my_photo.
 */
function studioRule(appBuild, voice) {
  if (!(Number(appBuild) >= require("./studioTools").studioMinBuild())) return "";
  if (voice === "me") {
    return "EVENT POSTERS WITH WORDS — 'make a poster for our event tomorrow', 'a flyer for our " +
      "sale on Saturday', 'a banner for the meeting' — go to create_event_poster with my own " +
      "words, NEVER generate_image (it misspells words): the studio opens with the words in real " +
      "fonts; read back what is on it and ask for what is missing — never invent a venue, a " +
      "price, a number or a time. 'Remove the background', 'change the colour', 'make this photo " +
      "look professional' on a photo I shared go to edit_my_photo. ";
  }
  return "- EVENT POSTERS WITH WORDS — 'make a poster for our event tomorrow', 'a flyer for our " +
    "sale on Saturday', 'a banner for the meeting' → create_event_poster with the user's own " +
    "words, NEVER generate_image (it misspells words): the studio opens with the words in real " +
    "fonts; read back what is on it and ask for what is missing — never invent a venue, a price, " +
    "a number or a time. 'Remove the background', 'change the colour', 'make this photo look " +
    "professional' on a photo they shared → edit_my_photo.\n";
}

function cardRule(voice) {
  if (voice === "me") {
    return "GREETING CARDS WITH A REAL PHOTO, MY OWN WORDS OR MY SIGNATURE — 'make a birthday " +
      "card for my daughter with her old photo', 'an anniversary card from us', 'put my " +
      "signature on it' — go to make_greeting_poster, NEVER generate_image (it would invent a " +
      "stranger's face and misspell the names). Put names and wishes in EXACTLY as I said them; " +
      "never write, polish or translate them unless I ask you to write them — then read your " +
      "draft back first. I pick the photo on the phone. Ask ONE question at a time. When the " +
      "card appears, read the words back and spell the name letter by letter. Changes — 'bigger " +
      "letters', 'pink', 'use the other design', 'go back', 'remove my signature', 'make it " +
      "tall for my status' — go to change_poster. 'Send it / share it' goes to share_poster: " +
      "WhatsApp opens and I press Send myself — never say it was sent. 'Make this old photo " +
      "clear / nice / beautiful' goes to improve_old_photo, a gentle clean-up — never call it a " +
      "repair; then 'keep it' or 'make a card with it' use that photo's photo_id. Never say the " +
      "card is made or ready — say it is on the screen. ";
  }
  return "- GREETING CARDS WITH A REAL PHOTO, THEIR OWN WORDS OR THEIR SIGNATURE — 'make a " +
    "birthday card for my daughter with her old photo', 'an anniversary card from us', 'put my " +
    "signature on it' → make_greeting_poster, NEVER generate_image (it would invent a " +
    "stranger's face and misspell the names). Put names and wishes in EXACTLY as said; never " +
    "write, polish or translate them unless the user asks you to write them — then read your " +
    "draft back first. The user picks the photo on the phone. Ask ONE question at a time. When " +
    "the card appears, read the words back and spell the name letter by letter. Changes " +
    "('bigger letters', 'pink', 'use the other design', 'go back', 'remove my signature', 'make " +
    "it tall for my status') → change_poster. 'Send it / share it' → share_poster: WhatsApp " +
    "opens and THEY press Send — never say it was sent. 'Make this old photo clear / nice / " +
    "beautiful' → improve_old_photo, a gentle clean-up — never call it a repair; then 'keep it' " +
    "or 'make a card with it' use that photo's photo_id. Never say the card is made or ready — " +
    "say it is on the screen.\n";
}

module.exports = {
  registerPosterTools, posterRule, POSTER_MIN_BUILD,
  _test: { partialFrom, splitChange, readBack },
};
