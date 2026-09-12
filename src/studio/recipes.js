/**
 * STYLE STUDIO — THE RECIPE CATALOGUE.
 * ----------------------------------------------------------------------
 * One place that knows what every "see yourself as ..." feature needs and
 * what to tell the image model. Adding a feature is adding an entry here;
 * the routes, the store, the daily cap, the Flutter screens and the voice
 * tools all read this list and need no change.
 *
 * WHY THE INSTRUCTIONS LOOK LIKE THIS. An instruction-following image
 * editor will happily give you a beautiful stranger. Every recipe below
 * therefore spends its first and loudest sentences on what must NOT
 * change — the face, the bone structure, the skin tone, the body — and
 * only then on what should. "Keep the face" is not enough; the models
 * respond to the specific nouns (eyes, nose, jawline, complexion), and
 * to being told the output is the SAME PERSON rather than a new render.
 *
 * A second recurring failure is the model answering in words. Image
 * models asked to "help someone try on a shirt" sometimes return a
 * paragraph of advice. Every instruction ends by demanding the edited
 * image and nothing else.
 */

/** Shared preamble — identity is the product. Losing it is the only
 *  failure mode users actually notice, and they notice it instantly. */
const KEEP_IDENTITY =
  "This is a photo edit of a REAL person, not a new illustration. The " +
  "output MUST be recognisably the SAME person: keep the face completely " +
  "unchanged — the same eyes, eyebrows, nose, lips, jawline, cheekbones, " +
  "facial hair, skin tone and complexion, the same freckles, moles and " +
  "lines, the same age, the same body shape and height, the same pose and " +
  "the same camera angle. Do not slim, lighten, smooth, westernise or " +
  "beautify the face. Do not swap the head onto another body.";

const PHOTOREAL =
  "Photorealistic result: natural skin texture with visible pores, real " +
  "fabric weave and stitching, physically correct shadows and contact " +
  "shadows, lighting that matches the original photograph's direction and " +
  "colour temperature, correct perspective. No plastic skin, no airbrush, " +
  "no painterly or 3D-render look, no added text, no watermark, no logo, " +
  "no extra limbs or fingers.";

const IMAGE_ONLY =
  "Return ONLY the edited image. Do not reply with text, advice or an " +
  "explanation.";

function q(s, max = 400) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max);
}

/* ------------------------------------------------------------------ */
/* PRESET LISTS — what the app offers as one tap                       */
/* ------------------------------------------------------------------ */

// Chosen for an Indian professional audience first, which is who uses
// this app: the wedding and festival entries are not decoration, they are
// the occasions people actually dress for here.
const OUTFIT_PRESETS = [
  { id: "navy-suit", label: "Navy suit", prompt: "a sharply tailored navy-blue two-piece business suit with a white shirt and a dark silk tie, polished black oxford shoes" },
  { id: "charcoal-suit", label: "Charcoal suit", prompt: "a charcoal-grey slim-fit business suit with a light blue shirt, no tie, open collar" },
  { id: "formal-shirt", label: "Formal shirt", prompt: "a crisp white formal cotton shirt, sleeves buttoned at the cuff, tucked into well-pressed dark grey trousers with a leather belt" },
  { id: "kurta", label: "Kurta", prompt: "an elegant full-sleeve cotton kurta in deep maroon with fine self-tone thread work at the placket, worn over cream churidar pyjama" },
  { id: "sherwani", label: "Sherwani", prompt: "an ivory silk wedding sherwani with gold zardozi embroidery on the collar and placket, a matching churidar, a maroon silk dupatta over one shoulder and a pearl brooch" },
  { id: "saree", label: "Silk saree", prompt: "a Kanjivaram silk saree in deep maroon with a wide gold zari border and temple-motif pallu, draped in the classic Nivi style over a matching gold blouse" },
  { id: "lehenga", label: "Lehenga", prompt: "a bridal lehenga in rose pink with heavy gold zardozi and sequin work, a fitted embroidered choli and a net dupatta draped over one shoulder" },
  { id: "salwar", label: "Salwar kameez", prompt: "a well-fitted cotton salwar kameez in teal with fine chikankari embroidery at the yoke, matching churidar and a light chiffon dupatta" },
  { id: "casual-tee", label: "Casual weekend", prompt: "a plain heather-grey crew-neck cotton t-shirt and dark indigo straight-leg jeans, clean white sneakers" },
  { id: "ethnic-fusion", label: "Indo-western", prompt: "an indo-western look: a bandhgala jacket in bottle green over a white kurta and slim beige trousers, brown leather juttis" },
];

const HAIR_PRESETS = [
  { id: "fade", label: "Short fade", prompt: "a short, neat mid-fade haircut with a slightly textured top, tapered clean at the sides and neckline" },
  { id: "side-part", label: "Side part", prompt: "a classic office side-parted haircut, medium-short, combed neatly with a defined parting and a light natural sheen" },
  { id: "crew", label: "Crew cut", prompt: "a very short crew cut, uniform on top, tapered at the sides, low maintenance and clean" },
  { id: "curls", label: "Natural curls", prompt: "medium-length natural curls worn loose and well-defined, with soft volume and no frizz" },
  { id: "long-layers", label: "Long layers", prompt: "long hair with soft face-framing layers falling past the shoulders, a middle parting, healthy natural shine" },
  { id: "bob", label: "Bob", prompt: "a chin-length blunt bob with a slight inward curve at the ends and a subtle side parting" },
  { id: "bun", label: "Low bun", prompt: "hair gathered into a smooth, low bun at the nape with a centre parting and a few soft strands left loose at the temples" },
  { id: "braid", label: "Braid", prompt: "a single thick three-strand braid worn over one shoulder, centre parting, neatly done" },
  { id: "ponytail", label: "High ponytail", prompt: "a sleek high ponytail pulled back tight with no parting and a smooth crown" },
  { id: "buzz", label: "Buzz cut", prompt: "a very short uniform buzz cut, clippers all over, clean and even" },
];

const HAIR_COLOURS = [
  { id: "keep", label: "Keep my colour", prompt: "" },
  { id: "natural-black", label: "Natural black", prompt: "natural soft-black hair colour" },
  { id: "dark-brown", label: "Dark brown", prompt: "rich dark-brown hair colour" },
  { id: "chestnut", label: "Chestnut", prompt: "warm chestnut-brown hair colour with subtle lighter ends" },
  { id: "burgundy", label: "Burgundy", prompt: "deep burgundy-wine hair colour, visible in the light" },
  { id: "caramel-highlights", label: "Caramel highlights", prompt: "the natural base colour with fine caramel balayage highlights through the mid-lengths and ends" },
  { id: "grey", label: "Salt and pepper", prompt: "distinguished salt-and-pepper grey, evenly scattered" },
  { id: "silver", label: "Silver", prompt: "an even cool silver-grey hair colour" },
];

const BEARD_PRESETS = [
  { id: "clean", label: "Clean shaven", prompt: "completely clean-shaven, no stubble, smooth jaw and upper lip" },
  { id: "stubble", label: "Light stubble", prompt: "an even, neatly trimmed short stubble of a few days' growth, sharp cheek line" },
  { id: "full", label: "Full beard", prompt: "a full, well-groomed medium-length beard, evenly dense, with a defined cheek line and a trimmed neckline" },
  { id: "goatee", label: "Goatee", prompt: "a neat goatee — hair on the chin and a connected moustache, cheeks shaved clean" },
  { id: "moustache", label: "Moustache", prompt: "a well-groomed moustache only, with the cheeks, chin and jaw shaved clean" },
  { id: "french", label: "French beard", prompt: "a French beard: a trimmed moustache joined to a narrow chin beard, cheeks and jawline shaved clean" },
];

const BACKDROP_PRESETS = [
  { id: "studio-grey", label: "Studio grey", prompt: "a seamless neutral mid-grey photographic studio backdrop with a soft vignette" },
  { id: "office", label: "Modern office", prompt: "a bright modern office interior softly out of focus behind them — glass partitions and warm wood, shallow depth of field" },
  { id: "bookshelf", label: "Library", prompt: "a warm wooden bookshelf wall softly out of focus behind them" },
  { id: "outdoor-green", label: "Garden light", prompt: "dappled outdoor greenery softly out of focus behind them in warm late-afternoon light" },
  { id: "city-night", label: "City at night", prompt: "a night city skyline with bokeh lights far out of focus behind them" },
  { id: "white", label: "Pure white", prompt: "a clean pure-white seamless background, evenly lit with no visible shadow behind them" },
];

// Official ID photos. The rules here are not style choices — a photo that
// misses the spec costs the user their appointment, and India moved the
// goalposts on 1 September 2025: the passport photo went from the old
// 2x2 inch square to the ICAO 35 x 45 mm portrait, the background
// tolerance narrowed to plain WHITE only, and the digital upload wants
// exactly 630 x 810 px with the face filling 80-85% of the frame height.
// Passport Seva 2.0 checks this automatically on upload and rejects
// without a correction window, so a stale 51 x 51 mm template is not a
// cosmetic bug — it is a wasted application.
const ID_SPECS = [
  {
    id: "india-passport", label: "India passport", mm: [35, 45], px: [630, 810],
    bg: "pure white",
    rule:
      "Indian passport specification as revised on 1 September 2025 (ICAO " +
      "standard): 35 x 45 mm portrait, plain PURE WHITE background with no " +
      "tint, pattern, gradient or shadow behind the head. Full front view " +
      "with the whole face, both ears and the full hairline visible, head " +
      "centred and level, the face occupying 80-85% of the frame height, " +
      "eyes open and looking straight at the camera, neutral expression with " +
      "the mouth closed, no spectacles, no head covering, no shadow on the " +
      "face or under the chin.",
  },
  {
    id: "pan-aadhaar", label: "PAN / Aadhaar", mm: [25, 35], px: [1000, 1400],
    bg: "pure white",
    rule:
      "Indian PAN card / Aadhaar enrolment photograph: 25 x 35 mm portrait, " +
      "plain white background, full front view of the head and the top of the " +
      "shoulders, head level and centred, neutral expression, even lighting, " +
      "no shadow.",
  },
  {
    id: "us-visa", label: "US visa / DV", mm: [51, 51], px: [1200, 1200],
    bg: "plain white",
    rule:
      "US visa and DV-lottery specification: exactly SQUARE, plain white or " +
      "off-white background, the head measured from the top of the hair to " +
      "the bottom of the chin occupying between 50% and 69% of the image " +
      "height with the eye line between 56% and 69% up from the bottom, full " +
      "front view, neutral expression with both eyes open, no spectacles, no " +
      "head covering.",
  },
  {
    id: "schengen", label: "Schengen visa", mm: [35, 45], px: [1050, 1350],
    bg: "light grey",
    rule:
      "Schengen / ICAO specification: 35 x 45 mm portrait, plain LIGHT GREY " +
      "background, the head from chin to crown occupying 70-80% of the image " +
      "height, full front view, neutral expression with the mouth closed, " +
      "both eyes clearly visible and not covered by hair or frames, even " +
      "diffuse lighting, no shadow on the face or the background.",
  },
  {
    id: "uk", label: "UK passport", mm: [35, 45], px: [1050, 1350],
    bg: "plain light grey or cream",
    rule:
      "UK passport specification: 35 x 45 mm portrait, plain light grey or " +
      "cream background, head and shoulders centred with the head from chin " +
      "to crown between 29 and 34 mm tall, full front view, neutral " +
      "expression, mouth closed, eyes open and clearly visible, no shadow.",
  },
];

/* ------------------------------------------------------------------ */
/* THE RECIPES                                                         */
/* ------------------------------------------------------------------ */

const RECIPES = [
  /* ---------------- 1. OUTFIT TRY-ON ---------------- */
  {
    id: "outfit",
    title: "Try on an outfit",
    blurb: "See yourself in it before you buy it",
    icon: "outfit",
    group: "Try it on",
    needs: { model: true, garment: "optional" },
    // A garment PHOTO can go to a purpose-built virtual-try-on model,
    // which holds a real print and weave far better than a general editor.
    vto: true,
    aspect: "portrait",
    presets: OUTFIT_PRESETS,
    params: [
      { key: "outfit", label: "What to wear", type: "text", hint: "navy suit, red silk saree, denim jacket" },
      { key: "fit", label: "Fit", type: "choice", options: ["as it comes", "slim fit", "relaxed fit", "oversized"] },
      { key: "occasion", label: "Occasion", type: "text", hint: "office, wedding, interview" },
    ],
    build({ params, hasGarment }) {
      const what = q(params.outfit);
      const fit = q(params.fit, 40);
      const occ = q(params.occasion, 80);
      const wear = hasGarment
        ? "Dress the person in the FIRST image in the exact garment shown in " +
          "the SECOND image. Reproduce that garment faithfully: its colour, " +
          "its print or pattern and the scale of that pattern, its texture " +
          "and weave, its neckline, sleeve length, buttons, collar, pleats, " +
          "borders and any embroidery or motif. It must read as the SAME " +
          "garment, not something similar." +
          (what ? ` Additional direction: ${what}.` : "")
        : `Dress the person in the photo in ${what || "a smart, well-fitted outfit"}.`;
      return [
        KEEP_IDENTITY,
        wear,
        fit && fit !== "as it comes" ? `The garment should be a ${fit}.` : "",
        occ ? `The look is for: ${occ}. Choose footwear and accessories that suit it.` : "",
        "Drape it on the body as real cloth behaves: follow the shoulders, " +
          "chest and waist, let it fall with gravity, and put the creases, " +
          "folds and shadows where the pose actually puts them. Replace the " +
          "clothing completely — no part of the original outfit may show " +
          "through at the collar, cuffs or hem. Keep the background exactly " +
          "as it is.",
        PHOTOREAL,
        IMAGE_ONLY,
      ].filter(Boolean).join(" ");
    },
  },

  /* ---------------- 2. HAIRSTYLE ---------------- */
  {
    id: "hair",
    title: "Try a hairstyle",
    blurb: "A new cut or colour, on your own face",
    icon: "hair",
    group: "Try it on",
    aspect: "portrait",
    needs: { model: true },
    presets: HAIR_PRESETS,
    params: [
      { key: "style", label: "Hairstyle", type: "text", hint: "short fade, long layers, low bun" },
      { key: "colour", label: "Colour", type: "choice", options: HAIR_COLOURS.map((c) => c.label) },
      { key: "length", label: "Length", type: "choice", options: ["as described", "shorter", "longer"] },
    ],
    build({ params }) {
      const style = q(params.style) || "a neat, flattering modern haircut that suits their face shape";
      const colour = HAIR_COLOURS.find((c) => c.label === q(params.colour, 60))?.prompt || "";
      const len = q(params.length, 30);
      return [
        KEEP_IDENTITY,
        `Change ONLY the hair. Give this person ${style}.`,
        colour ? `Hair colour: ${colour}.` : "Keep their existing natural hair colour exactly as it is.",
        len === "shorter" ? "Err on the shorter side." : len === "longer" ? "Err on the longer side." : "",
        "Re-draw the hairline and the shape of the head's hair so it grows " +
          "the way real hair grows out of this scalp — correct hairline " +
          "position, correct density at the temples and crown, individual " +
          "strands rather than a helmet, and a natural shadow where the hair " +
          "meets the forehead and ears. The forehead, ears, eyebrows, " +
          "eyelashes and facial hair must stay exactly as they are, and so " +
          "must the clothing, the background and the lighting.",
        PHOTOREAL,
        IMAGE_ONLY,
      ].filter(Boolean).join(" ");
    },
  },

  /* ---------------- 3. BEARD / GROOMING ---------------- */
  {
    id: "beard",
    title: "Try a beard",
    blurb: "Shave it off or grow it out, first",
    icon: "beard",
    group: "Try it on",
    aspect: "portrait",
    needs: { model: true },
    presets: BEARD_PRESETS,
    params: [
      { key: "style", label: "Facial hair", type: "text", hint: "full beard, goatee, clean shaven" },
    ],
    build({ params }) {
      const style = q(params.style) || "a neatly trimmed short beard";
      return [
        KEEP_IDENTITY,
        `Change ONLY the facial hair. Give this person ${style}.`,
        "Match the facial hair's colour and coarseness to the hair on their " +
          "head, follow the real growth pattern of the jaw and upper lip, and " +
          "show the skin underneath correctly where hair is removed — the " +
          "jaw and chin shape must not change. The head hair, eyebrows, " +
          "clothing, background and lighting stay exactly as they are.",
        PHOTOREAL,
        IMAGE_ONLY,
      ].filter(Boolean).join(" ");
    },
  },

  /* ---------------- 4. EYEWEAR ---------------- */
  {
    id: "eyewear",
    title: "Try spectacles",
    blurb: "Frames on your face, not a model's",
    icon: "eyewear",
    group: "Try it on",
    aspect: "portrait",
    needs: { model: true, garment: "optional" },
    params: [
      { key: "frame", label: "Frames", type: "text", hint: "thin gold round frames, black rectangular, aviators" },
    ],
    build({ params, hasGarment }) {
      const f = q(params.frame) || "modern thin-rimmed rectangular spectacles";
      return [
        KEEP_IDENTITY,
        hasGarment
          ? "Put the exact eyewear shown in the SECOND image onto the face in the FIRST image, reproducing its frame shape, colour, material and lens tint faithfully."
          : `Put ${f} onto this person's face.`,
        "Place them correctly: the bridge resting on the nose, the temples " +
          "passing over the ears at the right angle, sized to the real width " +
          "of this face. Add a faint, physically correct shadow under the " +
          "frame and a subtle reflection on the lenses, and keep the eyes " +
          "fully visible through them. Change nothing else.",
        PHOTOREAL,
        IMAGE_ONLY,
      ].filter(Boolean).join(" ");
    },
  },

  /* ---------------- 5. JEWELLERY ---------------- */
  {
    id: "jewellery",
    title: "Try jewellery",
    blurb: "Necklaces, earrings, bangles — on you",
    icon: "jewellery",
    group: "Try it on",
    aspect: "portrait",
    needs: { model: true, garment: "optional" },
    vto: false,
    params: [
      { key: "piece", label: "The piece", type: "text", hint: "temple-gold necklace, jhumkas, diamond studs" },
    ],
    build({ params, hasGarment }) {
      const p = q(params.piece) || "a traditional gold necklace with matching earrings";
      return [
        KEEP_IDENTITY,
        hasGarment
          ? "Put the exact jewellery shown in the SECOND image onto the person in the FIRST image — the same metal colour, the same stones, the same motif and the same size relative to the body."
          : `Put ${p} onto this person.`,
        "It must sit where real jewellery sits and behave like metal and " +
          "stone: follow the curve of the neck or the hang of the earlobe, " +
          "catch the light from the same direction as the rest of the " +
          "photograph, cast a small shadow on the skin or cloth beneath it, " +
          "and keep the correct scale. Do not change the face, the outfit, " +
          "the neckline or the background.",
        PHOTOREAL,
        IMAGE_ONLY,
      ].filter(Boolean).join(" ");
    },
  },

  /* ---------------- 6. PROFESSIONAL HEADSHOT ---------------- */
  {
    id: "headshot",
    title: "Professional headshot",
    blurb: "A LinkedIn-ready portrait from a phone photo",
    icon: "headshot",
    group: "Look your best",
    aspect: "portrait",
    needs: { model: true },
    upscale: true,
    params: [
      { key: "attire", label: "Attire", type: "choice", options: ["Business suit", "Formal shirt", "Smart casual", "Kurta", "Saree", "Doctor's coat", "Keep what I'm wearing"] },
      { key: "backdrop", label: "Background", type: "choice", options: BACKDROP_PRESETS.map((b) => b.label) },
    ],
    build({ params }) {
      const attire = q(params.attire, 60);
      const bd = BACKDROP_PRESETS.find((b) => b.label === q(params.backdrop, 60))?.prompt ||
        "a seamless neutral mid-grey photographic studio backdrop";
      const wear = {
        "Business suit": "a well-tailored dark business suit with a crisp white shirt",
        "Formal shirt": "a crisp light-blue formal shirt, collar open, sleeves buttoned",
        "Smart casual": "a well-fitted plain merino crew-neck over a collared shirt",
        Kurta: "a clean, well-pressed formal kurta in a solid muted colour",
        Saree: "a well-draped formal silk saree in a solid muted colour with a matching blouse",
        "Doctor's coat": "a clean white medical coat over a formal shirt, with a stethoscope at the neck",
      }[attire];
      return [
        KEEP_IDENTITY,
        "Turn this snapshot into a professional corporate headshot of the " +
          "SAME person, of the quality a studio photographer would deliver.",
        wear ? `Dress them in ${wear}.` : "Keep the clothing they are wearing, but make it look clean and well-pressed.",
        `Place them against ${bd}.`,
        "Re-light it properly: a large soft key light from slightly above and " +
          "to one side, a gentle fill on the shadow side, a subtle rim light " +
          "separating the hair from the background, catchlights in both eyes. " +
          "Frame it as a head-and-shoulders portrait, eyes about two-thirds " +
          "up the frame, shot as if on an 85 mm lens at f/2.8 so the " +
          "background falls gently out of focus. Straighten the posture and " +
          "square the shoulders slightly to camera. Keep a natural, " +
          "confident, closed-mouth expression — and keep the skin real: " +
          "pores and texture visible, no smoothing, no reshaping.",
        PHOTOREAL,
        IMAGE_ONLY,
      ].filter(Boolean).join(" ");
    },
  },

  /* ---------------- 7. OFFICIAL ID PHOTO ---------------- */
  {
    id: "idphoto",
    title: "Passport / visa photo",
    blurb: "Spec-correct ID photo from a normal photo of you",
    icon: "id",
    group: "Look your best",
    // NOT a generative portrait. An official photograph must be the real
    // photograph — a re-rendered face is both a worse likeness and, for a
    // document, the wrong thing entirely. So this recipe only ever asks
    // for the BACKGROUND to be replaced and the lighting evened, then the
    // exact millimetre crop is done deterministically afterwards. The
    // model is told, in as many words, not to touch the face.
    mode: "reframe",
    aspect: "portrait",
    needs: { model: true },
    upscale: true,
    label: false, // a visible label would invalidate the document
    specs: ID_SPECS,
    params: [
      { key: "spec", label: "Document", type: "choice", options: ID_SPECS.map((s) => s.label), required: true },
      { key: "attire", label: "Clothing", type: "choice", options: ["Keep what I'm wearing", "Plain dark shirt", "Formal shirt and jacket", "Plain dark top"] },
    ],
    build({ params }) {
      const label = q(params.spec, 60);
      const spec = ID_SPECS.find((s) => s.label === label) || ID_SPECS[0];
      const attire = q(params.attire, 60);
      const wear = {
        "Plain dark shirt": "a plain dark-coloured collared shirt",
        "Formal shirt and jacket": "a plain white shirt under a dark jacket",
        "Plain dark top": "a plain dark-coloured top with a modest neckline",
      }[attire];
      return [
        "This is an OFFICIAL IDENTITY PHOTOGRAPH of a real person. The face " +
          "is evidence and must not be altered in any way: do not re-draw, " +
          "retouch, smooth, slim, lighten, age, beautify or reshape any part " +
          "of the face, the head or the hair, and do not change the " +
          "expression. A retouched face makes the document invalid. Keep the " +
          "person's own face pixel-for-pixel as it is.",
        `Replace the background with a ${spec.bg} background — seamless, ` +
          "completely even, with no shadow, gradient, texture or object " +
          "behind the head.",
        "Cut around the hair, ears and shoulders precisely — no halo, no " +
          "leftover fringe of the old background, no clipped strands.",
        wear ? `Change only the clothing, to ${wear}. Leave the neck, jaw and hairline untouched.` : "",
        "Even out the lighting so there is no shadow on the face, under the " +
          "chin or on the background and no hotspot on the forehead or nose, " +
          "and straighten the head so it is level and square to the camera. " +
          "Keep natural skin tone and texture.",
        `The photograph must satisfy: ${spec.rule}`,
        `Target output: ${spec.mm[0]} x ${spec.mm[1]} mm at ${spec.px[0]} x ${spec.px[1]} pixels.`,
        IMAGE_ONLY,
      ].filter(Boolean).join(" ");
    },
  },

  /* ---------------- 8. RESTORE AN OLD PHOTO ---------------- */
  {
    id: "restore",
    title: "Restore an old photo",
    blurb: "Repair, sharpen and colourise family photos",
    icon: "restore",
    group: "Look your best",
    aspect: "auto",
    needs: { model: true },
    upscale: true,
    params: [
      { key: "colourise", label: "Colour", type: "choice", options: ["Add natural colour", "Keep it black and white"] },
      { key: "notes", label: "Anything to fix", type: "text", hint: "the tear across the corner, my father's face is faded" },
    ],
    build({ params }) {
      const col = /colour/i.test(q(params.colourise, 60));
      const notes = q(params.notes, 300);
      return [
        "Restore this damaged old photograph. Keep every person in it " +
          "recognisably themselves — the same faces, the same expressions, " +
          "the same clothing, the same composition and the same era. Do not " +
          "add, remove or rearrange any person or object, and do not " +
          "modernise anything.",
        "Repair the physical damage: close the tears, creases and scratches, " +
          "fill the missing corners in keeping with what surrounds them, " +
          "remove the dust, spots, mould and stains, correct the fading and " +
          "the yellow or magenta colour cast, and recover contrast in the " +
          "blown highlights and blocked shadows. Bring back real detail in " +
          "the faces, hair, eyes and fabric — sharpen what is soft without " +
          "inventing features that were not there.",
        col
          ? "Add natural, believable colour: accurate skin tones for South " +
            "Asian complexions, period-appropriate clothing colours, and " +
            "restrained, realistic saturation. Never garish."
          : "Keep it black and white, but with clean neutral tones and a full range from true black to clean white.",
        notes ? `The owner specifically asks about: ${notes}.` : "",
        "Keep the grain of a real photograph — do not render it as a smooth digital illustration.",
        IMAGE_ONLY,
      ].filter(Boolean).join(" ");
    },
  },

  /* ---------------- 9. BACKGROUND / BACKDROP ---------------- */
  {
    id: "backdrop",
    title: "Change the background",
    blurb: "Same you, better setting",
    icon: "backdrop",
    group: "Look your best",
    aspect: "auto",
    needs: { model: true },
    presets: BACKDROP_PRESETS,
    params: [
      { key: "scene", label: "New background", type: "text", hint: "a modern office, a beach at sunset, plain white" },
    ],
    build({ params }) {
      const scene = q(params.scene) || "a clean neutral studio backdrop";
      return [
        KEEP_IDENTITY,
        `Replace ONLY the background with ${scene}.`,
        "Cut the person out precisely — including individual strands of hair, " +
          "the gaps between the arm and the body, and anything they are " +
          "holding — with no halo and no leftover fringe of the old " +
          "background. Then make them belong in the new scene: relight the " +
          "subject so the direction, hardness and colour temperature of the " +
          "light match the new surroundings, match the depth of field, and " +
          "ground them with a correct contact shadow. Their face, hair, " +
          "clothing and pose do not change.",
        PHOTOREAL,
        IMAGE_ONLY,
      ].filter(Boolean).join(" ");
    },
  },

  /* ---------------- 10. FULL OCCASION LOOK ---------------- */
  {
    id: "occasion",
    title: "Dress me for an occasion",
    blurb: "A complete look — outfit, hair, setting",
    icon: "occasion",
    group: "Look your best",
    aspect: "portrait",
    needs: { model: true },
    params: [
      { key: "occasion", label: "The occasion", type: "text", required: true, hint: "my cousin's wedding reception, a job interview, Diwali" },
      { key: "style", label: "Style", type: "choice", options: ["Traditional", "Western formal", "Indo-western", "Smart casual"] },
      { key: "notes", label: "Notes", type: "text", hint: "it's outdoors, in the evening, the theme is pastel" },
    ],
    build({ params }) {
      const occ = q(params.occasion) || "a formal evening event";
      const style = q(params.style, 40);
      const notes = q(params.notes, 300);
      return [
        KEEP_IDENTITY,
        `Style this person completely for: ${occ}.` +
          (style ? ` Style direction: ${style}.` : ""),
        notes ? `Additional context: ${notes}.` : "",
        "Choose and render a complete, coherent look: the outfit with real " +
          "fabric and fit, footwear, the accessories that occasion calls " +
          "for, and hair groomed to match. Put them in a setting that suits " +
          "the occasion, lit the way that setting would actually be lit. " +
          "Everything must be appropriate and dignified for the event named. " +
          "Keep the face and body exactly as they are.",
        PHOTOREAL,
        IMAGE_ONLY,
      ].filter(Boolean).join(" ");
    },
  },
];

const BY_ID = new Map(RECIPES.map((r) => [r.id, r]));

function get(id) {
  return BY_ID.get(String(id || "").toLowerCase()) || null;
}

/** The catalogue as the app and the voice tools see it — no functions. */
function catalogue() {
  return RECIPES.map((r) => ({
    id: r.id,
    title: r.title,
    blurb: r.blurb,
    icon: r.icon,
    group: r.group,
    needsModel: r.needs.model === true,
    garment: r.needs.garment === "optional" ? "optional" : r.needs.garment === true ? "required" : "no",
    aspect: r.aspect,
    params: r.params || [],
    presets: (r.presets || []).map((p) => ({ id: p.id, label: p.label })),
    specs: (r.specs || []).map((s) => ({ id: s.id, label: s.label, mm: s.mm, px: s.px })),
  }));
}

/**
 * Resolve a preset id into the param it stands for, so "the Sherwani tile"
 * and a typed description arrive at the same place.
 */
function applyPreset(recipe, params = {}) {
  const out = { ...params };
  const presetId = String(params.preset || "").trim();
  if (!presetId || !recipe.presets?.length) return out;
  const p = recipe.presets.find((x) => x.id === presetId);
  if (!p) return out;
  const target = recipe.id === "hair" ? "style" : recipe.id === "beard" ? "style"
    : recipe.id === "backdrop" ? "scene" : recipe.id === "outfit" ? "outfit" : "style";
  // A typed instruction WINS over a tapped tile: the user typed it second.
  out[target] = q(out[target]) || p.prompt;
  delete out.preset;
  return out;
}

/** Pixel target for a recipe+params, when it dictates one (ID photos do). */
function sizeFor(recipe, params = {}) {
  if (recipe.id === "idphoto") {
    const spec = ID_SPECS.find((s) => s.label === q(params.spec, 60)) || ID_SPECS[0];
    return { width: spec.px[0], height: spec.px[1], mm: spec.mm };
  }
  return null;
}

module.exports = {
  RECIPES, get, catalogue, applyPreset, sizeFor,
  OUTFIT_PRESETS, HAIR_PRESETS, HAIR_COLOURS, BEARD_PRESETS, BACKDROP_PRESETS, ID_SPECS,
  KEEP_IDENTITY, PHOTOREAL, IMAGE_ONLY,
};
