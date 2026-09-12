/**
 * STYLE STUDIO REGRESSION TESTS — `npm run test:studio`.
 *
 * Three kinds of case, and each kind earned its place:
 *
 *  1. PROMPT INVARIANTS. The product is "still me, different clothes", so
 *     the identity-preservation clause and the image-only terminator are
 *     asserted in every recipe. A prompt that quietly loses them produces
 *     a beautiful stranger, which is the one failure a user notices
 *     instantly and the one no type system catches.
 *
 *  2. THE SPEC NUMBERS. India moved the passport photo to 35 x 45 mm on
 *     1 September 2025 and Passport Seva 2.0 auto-rejects on upload. A
 *     stale 51 x 51 mm template costs the user an application, so the
 *     dimensions are pinned here.
 *
 *  3. THE UNDOCUMENTED WIRE FORMAT. Google's docs would not settle which
 *     response shape the image models return, so the harvester walks for
 *     the payload instead of indexing a path — and both documented shapes
 *     are asserted, plus the shapes that must NOT be mistaken for images.
 *
 * Needs Postgres for the store half. Writes only under reserved test user
 * ids and cleans up after itself.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@localhost:5432/myassistant";

const assert = require("assert");
const db = require("../src/db");
const recipes = require("../src/studio/recipes");
const studio = require("../src/studio/store");
const run = require("../src/studio/run");
const edit = require("../src/services/imageEdit");
const registry = require("../src/tools/registry");

const USER = 99031;
const USER2 = 99032;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}
async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

/* ================================================================== */
/* 1 — PROMPT INVARIANTS                                               */
/* ================================================================== */

console.log("\nStyle Studio — prompt invariants");

// Every recipe gets filled-in params of the right kind, both with and
// without a garment reference image.
function fill(rc) {
  const p = {};
  for (const q of rc.params || []) {
    p[q.key] = q.type === "choice" ? (q.options[1] || q.options[0]) : "a test description";
  }
  return p;
}

for (const rc of recipes.RECIPES) {
  for (const hasGarment of [false, true]) {
    const label = `${rc.id}${hasGarment ? " +garment" : ""}`;
    const t = rc.build({ params: fill(rc), hasGarment });

    test(`${label}: builds a substantial instruction`, () => {
      assert.ok(t.length > 300, `only ${t.length} chars`);
    });
    test(`${label}: no string-concatenation leak in the output`, () => {
      assert.ok(!/" \+ "/.test(t), "found a literal \" + \" — a template literal swallowed a concat");
    });
    test(`${label}: no unexpanded template placeholder`, () => {
      assert.ok(!/\$\{/.test(t), "found an unexpanded ${...}");
    });
    test(`${label}: never says undefined/null to the model`, () => {
      assert.ok(!/\b(undefined|null)\b/.test(t), "leaked undefined/null");
    });
    test(`${label}: ends by demanding an image, not prose`, () => {
      assert.ok(/Return ONLY the edited image/i.test(t),
        "missing the image-only terminator — editors answer in words without it");
    });
  }
}

// The face is the product. Every recipe that edits a person must say so.
// `restore` is exempt from the shared clause because it has its own,
// stronger wording about every person in a group photo; `idphoto` is
// exempt because it forbids touching the face outright.
for (const rc of recipes.RECIPES) {
  if (rc.id === "restore" || rc.id === "idphoto") continue;
  test(`${rc.id}: carries the identity-preservation clause`, () => {
    const t = rc.build({ params: fill(rc), hasGarment: false });
    assert.ok(/SAME person/.test(t), "does not assert the output is the same person");
    assert.ok(/jawline/.test(t) && /skin tone/.test(t),
      "identity clause must name specific features — 'keep the face' alone does not hold");
  });
}

test("restore: protects every person in the photo, adds/removes nobody", () => {
  const t = recipes.get("restore").build({ params: fill(recipes.get("restore")) });
  assert.ok(/recognisably themselves/i.test(t));
  assert.ok(/Do not add, remove or rearrange any person/i.test(t));
});

test("idphoto: forbids retouching the face outright", () => {
  const t = recipes.get("idphoto").build({ params: { spec: "India passport" } });
  assert.ok(/must not be altered in any way/i.test(t));
  assert.ok(/do not re-draw, retouch, smooth, slim, lighten, age, beautify or reshape/i.test(t));
  assert.ok(/invalid/i.test(t), "must say why: a retouched face invalidates the document");
});

test("idphoto: is a reframe, not a generated portrait", () => {
  assert.strictEqual(recipes.get("idphoto").mode, "reframe");
});

test("idphoto: carries no visible label (it would invalidate the document)", () => {
  assert.strictEqual(recipes.get("idphoto").label, false);
});

test("no recipe uses the word 'transform' (it triggers full regeneration)", () => {
  for (const rc of recipes.RECIPES) {
    const t = rc.build({ params: fill(rc), hasGarment: false });
    assert.ok(!/\btransform\b/i.test(t), `${rc.id} says "transform"`);
  }
});

test("outfit +garment: demands the SAME garment, not something similar", () => {
  const t = recipes.get("outfit").build({ params: {}, hasGarment: true });
  assert.ok(/SECOND image/.test(t), "must point at the reference image");
  assert.ok(/SAME garment, not something similar/i.test(t));
  assert.ok(/print or pattern and the scale of that pattern/i.test(t));
});

test("hair: changes ONLY the hair and keeps the existing colour by default", () => {
  const rc = recipes.get("hair");
  const t = rc.build({ params: { style: "a blunt bob" } });
  assert.ok(/Change ONLY the hair/.test(t));
  assert.ok(/Keep their existing natural hair colour/.test(t),
    "with no colour asked for it must pin the colour, or the model recolours at will");
  const coloured = rc.build({ params: { style: "a blunt bob", colour: "Burgundy" } });
  assert.ok(/burgundy/i.test(coloured));
});

/* ================================================================== */
/* 2 — THE SPEC NUMBERS                                                */
/* ================================================================== */

console.log("\nStyle Studio — official ID photo specs");

test("India passport is the post-1-Sept-2025 spec: 35x45 mm, 630x810 px", () => {
  const s = recipes.ID_SPECS.find((x) => x.id === "india-passport");
  assert.ok(s, "the India passport spec is missing");
  assert.deepStrictEqual(s.mm, [35, 45], "still on the retired 2x2 inch square");
  assert.deepStrictEqual(s.px, [630, 810], "not the Passport Seva digital upload size");
  assert.ok(/pure white/i.test(s.bg), "the background tolerance narrowed to white only");
  assert.ok(/80-85%/.test(s.rule), "must state the face-height fraction");
});

test("Schengen and UK are 35x45 mm; US visa is square", () => {
  const by = (id) => recipes.ID_SPECS.find((x) => x.id === id);
  assert.deepStrictEqual(by("schengen").mm, [35, 45]);
  assert.deepStrictEqual(by("uk").mm, [35, 45]);
  assert.deepStrictEqual(by("us-visa").mm, [51, 51]);
});

test("every ID spec states a background colour and a rule", () => {
  for (const s of recipes.ID_SPECS) {
    assert.ok(s.bg && s.bg.length > 3, `${s.id} has no background colour`);
    assert.ok(s.rule && s.rule.length > 80, `${s.id} has no usable rule text`);
    assert.ok(Array.isArray(s.px) && s.px[0] > 300 && s.px[1] > 300, `${s.id} pixel size looks wrong`);
  }
});

test("sizeFor pins exact pixels for an ID photo and nothing else", () => {
  assert.deepStrictEqual(
    recipes.sizeFor(recipes.get("idphoto"), { spec: "Schengen visa" }),
    { width: 1050, height: 1350, mm: [35, 45] }
  );
  assert.deepStrictEqual(
    recipes.sizeFor(recipes.get("idphoto"), { spec: "India passport" }),
    { width: 630, height: 810, mm: [35, 45] }
  );
  assert.strictEqual(recipes.sizeFor(recipes.get("outfit"), {}), null);
  assert.strictEqual(recipes.sizeFor(recipes.get("headshot"), {}), null);
});

test("an unknown document name falls back to a real spec, never to undefined", () => {
  const s = recipes.sizeFor(recipes.get("idphoto"), { spec: "Atlantis passport" });
  assert.ok(s && s.width > 0 && s.height > 0);
});

/* ================================================================== */
/* 3 — CATALOGUE AND PRESETS                                           */
/* ================================================================== */

console.log("\nStyle Studio — catalogue, presets, routing");

test("catalogue() is pure JSON — no functions reach the app", () => {
  const c = recipes.catalogue();
  assert.strictEqual(JSON.parse(JSON.stringify(c)).length, c.length);
  for (const r of c) {
    assert.ok(!("build" in r), `${r.id} leaked its build function`);
    assert.ok(r.title && r.blurb && r.group, `${r.id} is missing display text`);
    assert.ok(["no", "optional", "required"].includes(r.garment), `${r.id} garment=${r.garment}`);
  }
});

test("a tapped preset lands in the parameter its recipe actually reads", () => {
  const hair = recipes.get("hair");
  const p = recipes.applyPreset(hair, { preset: "bob" });
  assert.ok(/bob/i.test(p.style), `preset did not reach 'style': ${JSON.stringify(p)}`);
  assert.strictEqual(p.preset, undefined, "the preset id must not travel on to the model");

  const outfit = recipes.applyPreset(recipes.get("outfit"), { preset: "sherwani" });
  assert.ok(/sherwani/i.test(outfit.outfit));

  const bd = recipes.applyPreset(recipes.get("backdrop"), { preset: "office" });
  assert.ok(/office/i.test(bd.scene), "backdrop preset must land in 'scene'");
});

test("a typed description beats a tapped tile — the user typed it second", () => {
  const p = recipes.applyPreset(recipes.get("outfit"), {
    preset: "sherwani",
    outfit: "a linen bandhgala",
  });
  assert.ok(/bandhgala/i.test(p.outfit));
  assert.ok(!/sherwani/i.test(p.outfit));
});

test("an unknown preset id is ignored rather than blanking the request", () => {
  const p = recipes.applyPreset(recipes.get("hair"), { preset: "nonsense", style: "long layers" });
  assert.ok(/long layers/.test(p.style));
});

test("garment region is inferred correctly, plurals included", () => {
  const o = recipes.get("outfit");
  const cases = [
    ["red silk saree", "one-pieces"], ["lehenga", "one-pieces"], ["kurta set", "one-pieces"],
    ["black trousers", "bottoms"], ["blue jeans", "bottoms"], ["pleated skirt", "bottoms"],
    ["a linen shirt", "tops"], ["white tees", "tops"], ["a kurta", "tops"],
    ["navy suit", "auto"], ["", "auto"],
  ];
  for (const [text, want] of cases) {
    assert.strictEqual(run.garmentCategory(o, { outfit: text }), want, `"${text}"`);
  }
  assert.strictEqual(run.garmentCategory(recipes.get("hair"), { style: "bob" }), null,
    "a hairstyle has no garment region");
});

test("describe() never returns a placeholder the user would see", () => {
  for (const rc of recipes.RECIPES) {
    const d = run.describe(rc, {});
    assert.ok(d && d.length > 2, `${rc.id} described as "${d}"`);
    assert.ok(!/undefined|null|as it comes|as described/i.test(d), `${rc.id} → "${d}"`);
  }
  // "Keep my colour" / "Keep what I'm wearing" are non-answers and must
  // not become the title of the saved picture.
  assert.strictEqual(run.describe(recipes.get("hair"), { colour: "Keep my colour" }), "a new hairstyle");
  assert.strictEqual(
    run.describe(recipes.get("headshot"), { attire: "Keep what I'm wearing" }),
    "professional headshot"
  );
});

/* ================================================================== */
/* 4 — THE VOICE TOOL MUST NOT DRIFT FROM THE CATALOGUE                */
/* ================================================================== */

console.log("\nStyle Studio — voice tool");

require("../src/tools/builtins").registerBuiltins(registry);
const lookTool = registry.get("try_a_look");

test("try_a_look is registered as a tool", () => {
  assert.ok(lookTool, "the voice path has no way to make a look without it");
  assert.strictEqual(lookTool.deviceAction, true, "the picture has to reach the phone");
});

test("try_a_look's recipe enum matches the catalogue exactly", () => {
  const enumed = lookTool.inputSchema.properties.recipe.enum.slice().sort();
  const actual = recipes.RECIPES.map((r) => r.id).sort();
  assert.deepStrictEqual(enumed, actual,
    "a recipe was added or renamed without updating the tool's enum — voice would refuse it");
});

test("try_a_look counts as a world action and is guarded against repeats", () => {
  assert.ok(registry.isWorldAction("try_a_look"),
    "a paid render that lands a picture on the phone is a world action");
});

test("the idphoto spec enum matches the real spec labels", () => {
  const enumed = lookTool.inputSchema.properties.spec.enum.slice().sort();
  const actual = recipes.ID_SPECS.map((s) => s.label).sort();
  assert.deepStrictEqual(enumed, actual,
    "the tool offers document types the recipe cannot size");
});

/* ================================================================== */
/* 5 — THE UNDOCUMENTED RESPONSE SHAPE                                 */
/* ================================================================== */

console.log("\nStyle Studio — image plumbing");

const BIG = Buffer.alloc(4096, 7).toString("base64"); // long enough to read as image bytes

test("harvests an image from the classic generateContent shape", () => {
  const got = edit.harvestImage({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: BIG } }] } }],
  });
  assert.ok(got && got.buffer.length > 2048);
  assert.strictEqual(got.mime, "image/png");
});

test("harvests an image from the Interactions output_image shape", () => {
  const got = edit.harvestImage({
    output_image: { mime_type: "image/jpeg", data: BIG },
  });
  assert.ok(got && got.buffer.length > 2048);
  assert.strictEqual(got.mime, "image/jpeg");
});

test("harvests an image from the Vertex predictions shape", () => {
  const got = edit.harvestImage({
    predictions: [{ mimeType: "image/png", bytesBase64Encoded: BIG }],
  });
  assert.ok(got && got.buffer.length > 2048);
});

test("does not mistake ids, tokens or short fields for image bytes", () => {
  assert.strictEqual(edit.harvestImage({ id: "abc123", data: "ok" }), null);
  assert.strictEqual(edit.harvestImage({ candidates: [{ finishReason: "SAFETY" }] }), null);
  assert.strictEqual(edit.harvestImage({}), null);
  assert.strictEqual(edit.harvestImage(null), null);
  // A long non-image field must not be handed back as a picture.
  assert.strictEqual(
    edit.harvestImage({ signature: { data: BIG, mimeType: "application/json" } }),
    null
  );
});

test("survives a self-referencing response without looping forever", () => {
  const a = { nested: {} };
  a.nested.back = a;
  assert.strictEqual(edit.harvestImage(a), null);
});

test("reads the text a model returned instead of an image", () => {
  const said = edit.harvestText({
    candidates: [{ content: { parts: [{ text: "I can't edit photos of people." }] } }],
  });
  assert.ok(/can't edit photos/.test(said));
});

test("reads real pixel dimensions from PNG, JPEG and WEBP headers", () => {
  const png = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "latin1");
  png.writeUInt32BE(630, 16);
  png.writeUInt32BE(810, 20);
  assert.deepStrictEqual(edit.imageSize(png), { width: 630, height: 810 });

  const webp = Buffer.alloc(40);
  webp.write("RIFF", 0, "latin1");
  webp.write("WEBP", 8, "latin1");
  webp.write("VP8X", 12, "latin1");
  webp.writeUIntLE(1023, 24, 3);
  webp.writeUIntLE(767, 27, 3);
  assert.deepStrictEqual(edit.imageSize(webp), { width: 1024, height: 768 });

  assert.strictEqual(edit.imageSize(Buffer.alloc(40)), null);
  assert.strictEqual(edit.imageSize(null), null);
});

test("people default to a portrait aspect, never a square", () => {
  assert.strictEqual(edit.geminiAspect("portrait"), "3:4");
  assert.strictEqual(edit.geminiAspect("auto"), "3:4");
  assert.strictEqual(edit.geminiAspect(""), "3:4");
  assert.strictEqual(edit.geminiAspect("square"), "1:1");
  assert.strictEqual(edit.geminiAspect("wide"), "16:9");
  assert.strictEqual(edit.geminiAspect("landscape"), "4:3");
});

test("the provider chain puts dedicated try-on models ahead of the editor", () => {
  const names = edit.configured().map((p) => p.name);
  assert.ok(names.includes("gemini"), "the general editor must always be present");
  assert.strictEqual(names[names.length - 1], "gemini",
    "gemini is the fallback; a purpose-built try-on model must be tried first");
  for (const p of edit.configured()) {
    if (p.name !== "gemini") assert.ok(p.vtoOnly, `${p.name} must not be used for non-garment edits`);
  }
});

/* ================================================================== */
/* 6 — THE STORE                                                       */
/* ================================================================== */

(async () => {
  console.log("\nStyle Studio — store");
  await db.init();
  await studio.migrate();
  await cleanup();

  let modelPhoto;
  await atest("the first photo of yourself becomes the default automatically", async () => {
    modelPhoto = await studio.addPhoto(USER, { role: "model", documentId: 900001, label: "me" });
    assert.strictEqual(modelPhoto.isDefault, true, "asking a user to pick from a list of one is a wasted tap");
    const d = await studio.defaultModel(USER);
    assert.strictEqual(Number(d.id), modelPhoto.id);
  });

  await atest("a second photo does not steal the default until it is chosen", async () => {
    const second = await studio.addPhoto(USER, { role: "model", documentId: 900002 });
    assert.strictEqual(second.isDefault, false);
    assert.strictEqual(Number((await studio.defaultModel(USER)).id), modelPhoto.id);
    await studio.setDefaultModel(USER, second.id);
    assert.strictEqual(Number((await studio.defaultModel(USER)).id), second.id);
    // Exactly one default, always.
    const defaults = (await studio.listPhotos(USER, "model")).filter((p) => p.isDefault);
    assert.strictEqual(defaults.length, 1);
  });

  await atest("a garment photo is not a photo of you and never becomes the default", async () => {
    const g = await studio.addPhoto(USER, { role: "garment", documentId: 900003, label: "blue shirt" });
    assert.strictEqual(g.role, "garment");
    assert.strictEqual(g.isDefault, false);
    assert.strictEqual((await studio.listPhotos(USER, "garment")).length, 1);
    assert.strictEqual((await studio.listPhotos(USER, "model")).length, 2);
  });

  await atest("one user cannot see or touch another's photos", async () => {
    await studio.addPhoto(USER2, { role: "model", documentId: 900101 });
    assert.strictEqual((await studio.listPhotos(USER2)).length, 1);
    assert.strictEqual(await studio.getPhoto(USER2, modelPhoto.id), null);
    assert.strictEqual(await studio.deletePhoto(USER2, modelPhoto.id), false);
    assert.ok(await studio.getPhoto(USER, modelPhoto.id), "USER's photo must survive USER2's attempt");
  });

  let look;
  await atest("a look records the recipe, provider and inputs that made it", async () => {
    look = await studio.addLook(USER, {
      recipe: "outfit", documentId: 900201, photoId: modelPhoto.id,
      garmentId: null, prompt: "navy suit", params: { fit: "slim fit" },
      provider: "gemini:gemini-3-pro-image", ms: 8400,
    });
    assert.strictEqual(look.recipe, "outfit");
    assert.strictEqual(look.provider, "gemini:gemini-3-pro-image");
    assert.deepStrictEqual(look.params, { fit: "slim fit" });
    assert.strictEqual(look.ms, 8400);
    assert.strictEqual(look.favorite, false);
  });

  await atest("looks filter by recipe and come back newest first", async () => {
    await studio.addLook(USER, { recipe: "hair", documentId: 900202, prompt: "bob" });
    const all = await studio.listLooks(USER);
    assert.strictEqual(all.length, 2);
    assert.strictEqual(all[0].recipe, "hair", "newest first");
    assert.strictEqual((await studio.listLooks(USER, { recipe: "outfit" })).length, 1);
  });

  await atest("a look can be kept as a favourite", async () => {
    await studio.favorite(USER, look.id, true);
    assert.strictEqual((await studio.getLook(USER, look.id)).favorite, 1);
    await studio.favorite(USER, look.id, false);
    assert.strictEqual((await studio.getLook(USER, look.id)).favorite, 0);
  });

  await atest("the daily cap counts renders and refuses over the limit", async () => {
    const before = await studio.spentToday(USER);
    assert.strictEqual(before, 2);
    assert.strictEqual(await studio.overCap(USER), null, "2 renders must not be capped");

    process.env.STUDIO_DAILY_CAP = "2";
    const msg = await studio.overCap(USER);
    assert.ok(msg && /daily limit/i.test(msg), `expected a sentence, got ${msg}`);
    assert.ok(!/error|null|undefined/i.test(msg), "the cap message is said out loud — keep it human");
    delete process.env.STUDIO_DAILY_CAP;
    assert.strictEqual(await studio.overCap(USER), null);
  });

  await atest("the cap default is sane and env-overridable", async () => {
    assert.strictEqual(studio.dailyCap(), 40);
    process.env.STUDIO_DAILY_CAP = "7";
    assert.strictEqual(studio.dailyCap(), 7);
    process.env.STUDIO_DAILY_CAP = "nonsense";
    assert.strictEqual(studio.dailyCap(), 40, "junk env must not disable the brake");
    process.env.STUDIO_DAILY_CAP = "-3";
    assert.strictEqual(studio.dailyCap(), 40, "a negative cap must not mean 'no renders ever'");
    delete process.env.STUDIO_DAILY_CAP;
  });

  await atest("consent is recorded once, with a timestamp", async () => {
    assert.strictEqual(await studio.consentAt(USER), 0, "nobody is consented by default");
    await studio.setConsent(USER);
    const at = await studio.consentAt(USER);
    assert.ok(at > 0 && Math.abs(Date.now() - at) < 60_000);
    await studio.setConsent(USER); // idempotent, no duplicate-key blow-up
    assert.ok(await studio.consentAt(USER) >= at);
  });

  await atest("withdrawing consent deletes the stored photos of the person", async () => {
    const before = (await studio.listPhotos(USER, "model")).length;
    assert.ok(before >= 2);
    const removed = await studio.withdrawConsent(USER);
    assert.strictEqual(removed, before);
    assert.strictEqual((await studio.listPhotos(USER, "model")).length, 0,
      "leaving the face photos behind would make the withdrawal meaningless");
    assert.strictEqual(await studio.consentAt(USER), 0);
    // Wardrobe items are not photos of a person and are left alone.
    assert.strictEqual((await studio.listPhotos(USER, "garment")).length, 1);
  });

  await atest("deleting a look removes the row", async () => {
    assert.strictEqual(await studio.deleteLook(USER, look.id), true);
    assert.strictEqual(await studio.getLook(USER, look.id), null);
    assert.strictEqual(await studio.deleteLook(USER, look.id), false, "a second delete is not an error");
  });

  await atest("runRecipe refuses an unknown recipe before spending anything", async () => {
    await assert.rejects(
      () => run.runRecipe(USER, { recipeId: "hovercraft", params: {} }),
      (e) => e.code === "unknown_recipe"
    );
  });

  await atest("runRecipe asks for a photo instead of failing obscurely", async () => {
    await assert.rejects(
      () => run.runRecipe(USER, { recipeId: "hair", params: { style: "bob" } }),
      (e) => {
        assert.strictEqual(e.code, "no_model_photo");
        assert.ok(/photo of you/i.test(e.message), `message was: ${e.message}`);
        return true;
      }
    );
  });

  await atest("runRecipe refuses at the cap BEFORE any provider is called", async () => {
    process.env.STUDIO_DAILY_CAP = "1";
    await studio.addLook(USER, { recipe: "hair", documentId: 900301, prompt: "x" });
    await assert.rejects(
      () => run.runRecipe(USER, { recipeId: "hair", params: {} }),
      (e) => e.code === "daily_cap"
    );
    delete process.env.STUDIO_DAILY_CAP;
  });

  await atest("with no provider configured the error names the fix, not the user", async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      await edit.editImage({
        instruction: "x",
        images: [{ buffer: Buffer.alloc(5000, 1), mime: "image/jpeg" }],
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.strictEqual(e.code, "no_provider");
      assert.ok(/not configured/i.test(e.message));
      assert.ok(/GEMINI_API_KEY/.test(e.message), "an operator error must name the env var");
      assert.ok(!/your photo/i.test(e.message), "must not blame the user's photo for a missing key");
    } finally {
      if (saved) process.env.GEMINI_API_KEY = saved;
    }
  });

  await cleanup();
  await db.close();
  console.log(`\n${passed} checks passed`);
})();

async function cleanup() {
  for (const u of [USER, USER2]) {
    await db.run("DELETE FROM studio_looks WHERE user_id = $1", [u]).catch(() => {});
    await db.run("DELETE FROM studio_photos WHERE user_id = $1", [u]).catch(() => {});
    await db.run("DELETE FROM studio_consent WHERE user_id = $1", [u]).catch(() => {});
  }
}
