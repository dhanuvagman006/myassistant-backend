/**
 * PHOTO CARDS — `npm run test:posters`.
 *
 * The client, an elderly father who mostly speaks to the app: "I want to
 * put an old picture and ask My assistant to make it nice and beautiful",
 * "make a birthday card for my daughter… with my signature". The owner,
 * 2026-09-26: "build it without AI… create it like a GIFT CARD, not just a
 * photo — a photo with some designs like FLOWERS or something, with
 * 'Happy Birthday' and the caption or content the user gives".
 *
 * These pin:
 *   - the spec: his words come back byte-exact (English, Malayalam,
 *     Hindi), never re-cased or cut — over a limit is a `need` question;
 *     the heading table covers every language and occasion; colours,
 *     designs, text size, undo and its 20-step history;
 *   - the clean-up WITHOUT AI: the levels plan from the pixels, EXIF
 *     rotation, and — where ffmpeg exists — a synthetic faded photo made
 *     with ffmpeg comes back with more contrast and less colour cast,
 *     black-and-white and sepia, the 2048 cap, no tags, same bytes twice;
 *   - every /posters route: consent, upload (no document, no memory fact,
 *     no push, no outbound call), from-document, files, colour, restore
 *     (503 'off'), keep, create/latest/get, PATCH with version conflict,
 *     need, bad change and undo, the final PNG to documents (tags, exact
 *     words, replaces only this card's copy), delete — and another user's
 *     ids are 404;
 *   - the account erase and the 30-day sweep leave no rows and no files;
 *   - the voice tools and their gating on app build 119, the prompt lines,
 *     try_a_look's restore redirect, the claim checker;
 *   - the review fixes (2026-09-26): the decode budget (pixels, not bytes;
 *     a big JPEG opened at reduced size), tags cut out without ffmpeg, the
 *     type read from the bytes, see-through pictures laid on white and left
 *     out of the levels, undecodable bytes as 415, photo deletion (and
 *     consent withdrawal) that really deletes, the photo's colour as an
 *     undoable card edit with one URL per colour, one-word answers reaching
 *     the card, lines taken off by voice, keep / card-with-it by photo_id,
 *     the atomic final save, and the claims the app's card lines back;
 *   - tests/fixtures/posters/contract.json matches what the server sends.
 *
 * ffmpeg cases run where ffmpeg exists (the Docker image) and say
 * "skipped" where it does not (a Windows dev box):
 *   docker run --rm -v <worktree>:/w -w /w -e DATABASE_URL=postgres://myassistant:localdev@host.docker.internal:55432/myassistant_poster --entrypoint node hari-backend:node22-check scripts/posters-test.js
 *
 * Nothing leaves this machine: fetch is stubbed for every host but the
 * local test server, pushes and Firebase are stubbed, files live in a
 * temp folder.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
// ON, to prove the switch alone cannot start an AI repair v1 does not have.
process.env.POSTER_AI_RESTORE = "on";
delete process.env.POSTER_RETENTION_DAYS;

const os = require("os");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

// Temp roots BEFORE any module reads them: never a real data folder.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "posters-test-"));
process.env.DATA_DIR = path.join(TMP, "data");
process.env.LIVE_RECORD_DIR = path.join(TMP, "recordings");
const FILES = path.join(TMP, "data", "files");

// Every outbound request is recorded and answered locally.
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (/^http:\/\/127\.0\.0\.1:\d+\//.test(u)) return realFetch(url, opts);
  outbound.push({ url: u, method: opts.method || "GET" });
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

const assert = require("assert");
const express = require("express");
const db = require("../src/db");

const push = require("../src/services/push");
const pushes = [];
push.send = async (token, title, body, data) => {
  pushes.push({ token, title, body, data });
  return { ok: true, stale: false, skipped: false, error: null };
};
require("../src/services/firebase").deletePhoneUser = async () => "stubbed";

let passed = 0;
let skipped = 0;
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
}
function skip(name, why) {
  skipped++;
  console.log(`  --  ${name} (skipped: ${why})`);
}

/* ------------------------------------------------------------------ */
/* SYNTHETIC PHOTOS — no real person's photo anywhere in this suite    */
/* ------------------------------------------------------------------ */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * A PNG from a pixel function, written by hand (no image library). RGB,
 * or RGBA with `alpha` (px returns four values); `extra` chunks go in
 * before the image data (text, EXIF, transparency).
 */
function pngOf(w, h, px, { alpha = false, extra = [] } = {}) {
  const ch = alpha ? 4 : 3;
  const raw = Buffer.alloc((w * ch + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const p = px(x, y);
      for (let c = 0; c < ch; c++) raw[o++] = p[c];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr), ...extra.map(([t, d]) => pngChunk(t, d)),
    pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Only a PNG's header: it SAYS w x h, and carries almost no pixels. */
function pngHeaderOnly(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(Buffer.alloc(4096))), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A JPEG segment: marker, then length and body. */
function jpegSeg(marker, body) {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xff00 | marker, 0);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}
/** A baseline frame header (SOF0) that says w x h. */
function sof0(w, h) {
  const b = Buffer.from([8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  b.writeUInt16BE(h, 1);
  b.writeUInt16BE(w, 3);
  return jpegSeg(0xc0, b);
}
/** Just a JPEG's header, saying w x h, with no image data at all. */
const jpegHeaderOnly = (w, h) => Buffer.concat([Buffer.from([0xff, 0xd8]), sof0(w, h), Buffer.alloc(8)]);

/** A lossless-WebP header (VP8L) that says w x h (and alpha when asked). */
function vp8lHeader(w, h, alpha = false) {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(22, 4);
  b.write("WEBPVP8L", 8, "latin1");
  b.writeUInt32LE(10, 16);
  b[20] = 0x2f;
  b.writeUInt32LE((((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14) | (alpha ? 1 << 28 : 0)) >>> 0, 21);
  return b;
}

/** A drawn scene: sky, grass, a sun, and a cartoon figure (not a person's photo). */
function scene(x, y, w, h) {
  const t = y / h;
  let rgb = t < 0.55 ? [90 + 80 * t, 140 + 60 * t, 225 - 40 * t] : [70, 140 - 50 * (t - 0.55), 55];
  if ((x - w * 0.82) ** 2 + (y - h * 0.15) ** 2 < (w * 0.07) ** 2) rgb = [250, 220, 120];
  const cx = w * 0.5;
  const cy = h * 0.42;
  const d = ((x - cx) / (w * 0.15)) ** 2 + ((y - cy) / (h * 0.2)) ** 2;
  if (d < 1) rgb = y < cy - h * 0.09 ? [45, 32, 26] : [222, 172, 140];
  if (y > h * 0.64 && Math.abs(x - cx) < w * 0.25) rgb = [180, 40, 64];
  return rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))));
}
/** An old colour print: low contrast, lifted blacks, a yellow cast. */
const faded = ([r, g, b]) => [
  Math.round(78 + r * 0.45 + 22), Math.round(78 + g * 0.45 + 12), Math.round(78 + b * 0.45 - 14),
].map((v) => Math.max(0, Math.min(255, v)));
/** A black-and-white print gone brown with age. */
const sepiaPrint = ([r, g, b]) => {
  const y = 0.3 * r + 0.59 * g + 0.11 * b;
  return [Math.round(96 + y * 0.5), Math.round(82 + y * 0.46), Math.round(58 + y * 0.4)];
};

const W = 360;
const H = 480;
const FADED_PNG = pngOf(W, H, (x, y) => faded(scene(x, y, W, H)));
const SEPIA_PNG = pngOf(W, H, (x, y) => sepiaPrint(scene(x, y, W, H)));
function rgbOf(w, h, fn) {
  const b = Buffer.alloc(w * h * 3);
  let o = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = fn(x, y); b[o++] = p[0]; b[o++] = p[1]; b[o++] = p[2]; }
  return b;
}

/** An EXIF APP1 segment carrying one tag: Orientation. */
function exifSegment(orientation, order = "II") {
  const le = order === "II";
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write(order, 0, "latin1");
  const u16 = (v, o) => (le ? tiff.writeUInt16LE(v, o) : tiff.writeUInt16BE(v, o));
  const u32 = (v, o) => (le ? tiff.writeUInt32LE(v, o) : tiff.writeUInt32BE(v, o));
  u16(42, 2); u32(8, 4); u16(1, 8);
  u16(0x0112, 10); u16(3, 12); u32(1, 14); u16(orientation, 18); u32(0, 22);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const seg = Buffer.alloc(4);
  seg.writeUInt16BE(0xffe1, 0);
  seg.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([seg, body]);
}
const withExif = (jpeg, orientation, order) =>
  Buffer.concat([jpeg.slice(0, 2), exifSegment(orientation, order), jpeg.slice(2)]);

/** Luminance spread and channel means of raw RGB24. */
function measure(rgb) {
  const n = rgb.length / 3;
  const lum = new Uint32Array(256);
  const sum = [0, 0, 0];
  let chroma = 0;
  for (let i = 0; i < n; i++) {
    const r = rgb[3 * i]; const g = rgb[3 * i + 1]; const b = rgb[3 * i + 2];
    sum[0] += r; sum[1] += g; sum[2] += b;
    lum[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
    chroma += Math.max(r, g, b) - Math.min(r, g, b);
  }
  const pct = (p) => { let c = 0; for (let v = 0; v < 256; v++) { c += lum[v]; if (c >= p * n) return v; } return 255; };
  const mean = sum.map((s) => s / n);
  return { spread: pct(0.99) - pct(0.01), mean, cast: Math.max(...mean) - Math.min(...mean), chroma: chroma / n / 255 };
}

(async () => {
  await db.init();
  await require("../src/services/pendingPush").migrate?.();
  const S = require("../src/posters/spec");
  const enhance = require("../src/posters/enhance");
  const svc = require("../src/posters/service");
  const store = require("../src/posters/store");
  await store.migrate();
  const imageEdit = require("../src/services/imageEdit");
  const HAVE_FFMPEG = await imageEdit.haveFfmpeg();
  const docs = require("../src/docs/store");

  const stamp = String(Date.now()).slice(-7);
  const mk = async (tag) => (await db.createUser({ email: `poster-${tag}-${stamp}@example.test`, name: `Poster ${tag}` })).id;
  const U = await mk("u");   // the father
  const V = await mk("v");   // somebody else
  const E = await mk("e");   // deletes his account
  const T = await mk("t");   // speaks to the assistant
  const USERS = [U, V, E, T];

  const as = (req, _res, next) => { req.user = { sub: String(req.get("x-test-user") || "") }; next(); };
  const app = express();
  app.use(express.json());
  app.use("/posters", as, require("../src/routes/posters"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (uid, p, opts = {}) => fetch(`${base}${p}`, {
    ...opts,
    headers: { ...(opts.json ? { "content-type": "application/json" } : {}), ...(opts.headers || {}), "x-test-user": String(uid) },
    body: opts.json ? JSON.stringify(opts.json) : opts.body,
  });
  const json = async (res) => ({ status: res.status, body: await res.json() });
  async function upload(uid, buf, { type = "image/png", name = "photo.png", fields = {} } = {}) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
    form.append("photo", new Blob([buf], { type }), name);
    return call(uid, "/posters/photos", { method: "POST", body: form });
  }
  async function finalCard(uid, id, buf, version, type = "image/png") {
    const form = new FormData();
    form.append("version", String(version));
    form.append("image", new Blob([buf], { type }), "card.png");
    return call(uid, `/posters/${id}/final`, { method: "POST", body: form });
  }
  const count = async (table, uid) => {
    try { return (await db.one(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [uid])).n; }
    catch (_) { return 0; }
  };

  /* ================================================================ */
  console.log("\nthe card's words: spec.js");

  await atest("English, Malayalam and Hindi words come back byte-exact, never re-cased", () => {
    const out = S.normalize({
      name: "anJALi mcDonald", message: "Happy   birthday,\r\n  my dear!  ", from: "  Appa ",
    }).spec;
    assert.strictEqual(out.name, "anJALi mcDonald");
    assert.strictEqual(out.message, "Happy birthday,\nmy dear!");
    assert.strictEqual(out.from, "Appa");
    const ml = "അഞ്ജലി";
    const mlMsg = "ജന്മദിനാശംസകൾ, എന്റെ പൊന്നുമോളെ";
    const outMl = S.normalize({ name: ml, message: mlMsg }).spec;
    assert.strictEqual(Buffer.from(outMl.name).toString("hex"), Buffer.from(ml.normalize("NFC")).toString("hex"));
    assert.strictEqual(outMl.message, mlMsg.normalize("NFC"));
    assert.strictEqual(outMl.language, "ml");
    assert.strictEqual(outMl.headline, "ജന്മദിനാശംസകൾ");
    // ZWJ/ZWNJ are letters here, not spaces: a chillu must survive.
    const zw = "ക്‍ഷ ന്‌റ";
    assert.strictEqual(S.normalize({ name: zw }).spec.name, zw);
    const hi = S.normalize({ name: "अंजलि", message: "जन्मदिन मुबारक हो" }).spec;
    assert.strictEqual(hi.name, "अंजलि");
    assert.strictEqual(hi.language, "hi");
    assert.strictEqual(hi.headline, "जन्मदिन की शुभकामनाएँ");
    // A decomposed string is composed, not changed.
    assert.strictEqual(S.normalize({ name: "Café" }).spec.name, "Café");
  });

  await atest("a mixed card stays in the language most of its words are in", () => {
    const s = S.normalize({ name: "അഞ്ജലി", message: "Happy Birthday my dear daughter" }).spec;
    assert.strictEqual(s.language, "en");
    assert.strictEqual(s.headline, "Happy Birthday");
    assert.strictEqual(S.normalize({ language: "ml", name: "Anjali" }).spec.headline, "ജന്മദിനാശംസകൾ");
  });

  await atest("over a limit is a `need` question — never a truncation", () => {
    const long = "a".repeat(301);
    const r = S.normalize({ message: long });
    assert.deepStrictEqual(r.need, [{ field: "message", reason: "too_long", max: 300, length: 301 }]);
    assert.ok(!r.spec);
    assert.ok(S.normalize({ message: "a".repeat(300) }).spec, "exactly the limit fits");
    // Code points, not bytes: 60 Malayalam letters is 60, not 180.
    assert.ok(S.normalize({ name: "അ".repeat(60) }).spec);
    assert.strictEqual(S.normalize({ name: "അ".repeat(61) }).need[0].field, "name");
    assert.strictEqual(S.normalize({ age: 0 }).need[0].reason, "out_of_range");
    assert.strictEqual(S.normalize({ age: 121 }).need[0].field, "age");
    // A sixth line joins the fifth: every word stays.
    const six = S.normalize({ message: "one\ntwo\n\nthree\nfour\nfive\nsix" }).spec.message;
    assert.strictEqual(six, "one\ntwo\nthree\nfour\nfive six");
  });

  await atest("the heading table covers every language and occasion; English ordinals", () => {
    for (const lang of S.LANGUAGES) {
      for (const occ of S.OCCASIONS) {
        const h = S.HEADLINES[lang][occ];
        assert.ok(typeof h === "string" && h.length > 2, `${lang}.${occ}`);
        assert.strictEqual(S.autoHeadline({ language: lang, occasion: occ }), h);
      }
    }
    const ords = [1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(S.ordinalEn);
    assert.deepStrictEqual(ords, ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th"]);
    assert.strictEqual(S.autoHeadline({ language: "en", occasion: "birthday", age: 25 }), "Happy 25th Birthday");
    assert.strictEqual(S.autoHeadline({ language: "en", occasion: "anniversary", age: 40 }), "Happy 40th Anniversary");
    assert.strictEqual(S.autoHeadline({ language: "ml", occasion: "birthday", age: 25 }), "ജന്മദിനാശംസകൾ");
    // A dictated heading wins, and an empty one gives the table's back.
    const s = S.normalize({ headline: "Many Happy Returns", age: 30 }).spec;
    assert.strictEqual(s.headline, "Many Happy Returns");
    assert.strictEqual(s.headlineCustom, true);
    const back = S.applyChange(s, { set: { headline: "" } }).spec;
    assert.strictEqual(back.headline, "Happy 30th Birthday");
    assert.strictEqual(back.headlineCustom, false);
  });

  await atest("colours and designs by the words people use; the colour follows the design until chosen", () => {
    assert.strictEqual(S.resolveColour("red"), "pink");
    assert.strictEqual(S.resolveColour("Pink"), "pink");
    assert.strictEqual(S.resolveColour("navy"), "purple");
    assert.strictEqual(S.resolveColour("classic"), "white");
    assert.strictEqual(S.resolveColour("chartreuse"), null);
    assert.strictEqual(S.normalize({ colour: "chartreuse" }).error, "bad_change");
    assert.strictEqual(S.resolveDesign("flowers"), "floral_blush");
    assert.strictEqual(S.resolveDesign("Royal Mandala"), "royal_mandala");
    assert.strictEqual(S.resolveDesign("Balloons & Confetti"), "balloons_confetti");
    assert.strictEqual(S.resolveDesign("the rangoli one"), "royal_mandala");
    assert.strictEqual(S.resolveDesign("zebra"), null);
    assert.ok(S.DESIGNS.length >= 6);
    let s = S.defaultSpec("birthday");
    assert.strictEqual(s.design, "floral_blush", "flowers for a birthday, as asked");
    assert.strictEqual(s.colour, "pink");
    s = S.applyChange(s, { design: "next" }).spec;
    assert.strictEqual(s.design, "golden_celebration");
    assert.strictEqual(s.colour, "gold", "an unchosen colour follows the design");
    s = S.applyChange(s, { colour: "red" }).spec;
    assert.strictEqual(s.colour, "pink");
    s = S.applyChange(s, { design: "garden" }).spec;
    assert.strictEqual(s.colour, "pink", "a colour he chose stays");
    for (let i = 0; i < S.DESIGNS.length; i++) s = S.applyChange(s, { design: "next" }).spec;
    assert.strictEqual(s.design, "garden_green", "next goes round the list");
  });

  await atest("text size steps and clamps; set changes only what it names; a no-op is not a change", () => {
    let s = S.defaultSpec();
    const scales = [];
    for (let i = 0; i < 6; i++) {
      const r = S.applyChange(s, { textSize: "bigger" });
      s = r.spec;
      scales.push(s.textScale);
      if (i === 5) assert.strictEqual(r.limitReached, true);
    }
    assert.deepStrictEqual(scales, [1.15, 1.3, 1.45, 1.6, 1.6, 1.6]);
    for (let i = 0; i < 8; i++) s = S.applyChange(s, { textSize: "smaller" }).spec;
    assert.strictEqual(s.textScale, 0.8);
    assert.strictEqual(S.applyChange(s, { textSize: "reset" }).spec.textScale, 1);
    const a = S.normalize({ name: "Ananya", message: "Hi", from: "Appa" }).spec;
    const b = S.applyChange(a, { set: { from: "Amma" } });
    assert.strictEqual(b.changed, true);
    assert.deepStrictEqual({ ...b.spec, from: "Appa" }, a);
    assert.strictEqual(S.applyChange(a, { set: { from: "Appa" } }).changed, false);
    assert.strictEqual(S.applyChange(a, { bogus: 1 }).error, "bad_change");
    assert.strictEqual(S.applyChange(a, { set: { design: "x" } }).error, "bad_change");
    assert.strictEqual(S.applyChange(a, { textSize: "huge" }).error, "bad_change");
  });

  await atest("spell() for a Latin name, null otherwise; words() are the printed lines", () => {
    assert.strictEqual(S.spell("Anjali"), "A-N-J-A-L-I");
    assert.strictEqual(S.spell("Anna Maria"), "A-N-N-A M-A-R-I-A");
    assert.strictEqual(S.spell("അഞ്ജലി"), null);
    assert.strictEqual(S.spell(""), null);
    const s = S.normalize({ name: "Ananya", age: 25, message: "Line one\nLine two", from: "Appa", date: "26 Sep 2026" }).spec;
    assert.deepStrictEqual(S.words(s), ["Happy 25th Birthday", "Ananya", "Line one", "Line two", "Appa", "26 Sep 2026"]);
    const ml = S.normalize({ name: "അഞ്ജലി", age: 25, message: "ആശംസകൾ", from: "അച്ഛൻ" }).spec;
    assert.deepStrictEqual(S.words(ml), ["ജന്മദിനാശംസകൾ", "25", "അഞ്ജലി", "ആശംസകൾ", "അച്ഛൻ"]);
    assert.deepStrictEqual(S.missing(S.defaultSpec()), ["name", "age", "message", "from"]);
  });

  /* ================================================================ */
  console.log("\nthe clean-up, without AI: the plan");

  await atest("EXIF orientation is read in both byte orders; anything odd is 1", () => {
    const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xdb, 0x00, 0x04, 0, 0]),
      Buffer.from([0xff, 0xd9])]);
    assert.strictEqual(enhance.exifOrientation(withExif(fakeJpeg, 6, "II")), 6);
    assert.strictEqual(enhance.exifOrientation(withExif(fakeJpeg, 8, "MM")), 8);
    assert.strictEqual(enhance.exifOrientation(withExif(fakeJpeg, 3)), 3);
    assert.strictEqual(enhance.exifOrientation(fakeJpeg), 1);
    assert.strictEqual(enhance.exifOrientation(withExif(fakeJpeg, 9)), 1);
    assert.strictEqual(enhance.exifOrientation(FADED_PNG), 1);
    assert.strictEqual(enhance.exifOrientation(withExif(fakeJpeg, 6).slice(0, 20)), 1, "truncated");
    assert.strictEqual(enhance.exifOrientation(Buffer.from("not an image")), 1);
    assert.strictEqual(enhance.ORIENT_VF[6], "transpose=1");
    assert.strictEqual(enhance.ORIENT_VF[8], "transpose=2");
  });

  // Review, 2026-09-26: a 746 KB PNG saying 16000x16000 took ffmpeg to ~1 GB.
  await atest("the decode budget: pixels, not bytes — a big JPEG opens at 1/2-1/8 size, a PNG bomb is refused", async () => {
    const plan = (b) => imageEdit.decodePlan(b, { minEdge: enhance.MAX_EDGE });
    assert.deepStrictEqual(
      (({ lowres, width, height }) => ({ lowres, width, height }))(plan(jpegHeaderOnly(9000, 12000))),
      { lowres: 2, width: 2250, height: 3000 }, "a 108 MP phone photo opens at a quarter, still over 2048");
    assert.strictEqual(plan(jpegHeaderOnly(4000, 3000)).lowres, 0, "halved it would be under 2048: opened whole");
    assert.strictEqual(plan(jpegHeaderOnly(60000, 60000)), null, "even at 1/8 too many pixels");
    assert.strictEqual(plan(pngHeaderOnly(16000, 16000)), null, "the review's bomb");
    assert.ok(plan(pngHeaderOnly(4000, 6000)), "24 MP exactly is inside the budget");
    assert.strictEqual(plan(pngHeaderOnly(5000, 5000)), null);
    assert.strictEqual(imageEdit.MAX_DECODE_PIXELS, 24_000_000);
    // Style Studio's input path keeps the same budget: never handed to ffmpeg.
    const bomb = pngHeaderOnly(16000, 16000);
    const n = await imageEdit.normalizeInput(bomb, "image/png");
    assert.strictEqual(n.buffer, bomb);
  });

  await atest("a lossless WebP is read (it was refused as 'not a photo'); the type comes from the bytes", () => {
    assert.deepStrictEqual(imageEdit.imageSize(vp8lHeader(640, 480)), { width: 640, height: 480 });
    assert.deepStrictEqual(imageEdit.imageSize(vp8lHeader(1, 16384)), { width: 1, height: 16384 });
    assert.strictEqual(imageEdit.imageKind(vp8lHeader(640, 480)), "webp");
    assert.strictEqual(imageEdit.imageKind(FADED_PNG), "png");
    assert.strictEqual(imageEdit.imageKind(jpegHeaderOnly(10, 10)), "jpeg");
    assert.strictEqual(imageEdit.imageKind(Buffer.from("GIF89a......")), null);
  });

  await atest("tags are cut out in JavaScript (the no-ffmpeg path): JPEG keeps only its orientation, PNG, WebP", () => {
    const tiff = exifSegment(6).slice(4);
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegSeg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
      jpegSeg(0xe1, Buffer.concat([tiff, Buffer.from("GPSLatitude=12.975;GPSLongitude=77.586", "latin1")])),
      jpegSeg(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPS home</x:xmpmeta>", "latin1")),
      jpegSeg(0xe2, Buffer.from("ICC_PROFILE\0\x01\x01colour-profile", "latin1")),
      jpegSeg(0xfe, Buffer.from("taken at 12 Rose Street", "latin1")),
      jpegSeg(0xdb, Buffer.alloc(65, 1)),
      sof0(640, 480),
      jpegSeg(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])),
      Buffer.from([1, 2, 3, 4, 5, 0xff, 0xd9]),
    ]);
    const s = enhance.stripMetadata(jpeg);
    for (const bad of ["GPS", "Rose Street", "xmpmeta"]) assert.strictEqual(s.indexOf(bad), -1, bad);
    assert.ok(s.indexOf("ICC_PROFILE") > 0, "the colour profile says nothing about anyone: kept");
    assert.strictEqual(enhance.exifOrientation(s), 6, "without ffmpeg nothing turns the pixels: the tag stays");
    assert.deepStrictEqual(imageEdit.imageSize(s), { width: 640, height: 480 });
    assert.deepStrictEqual([s[2], s[3]], [0xff, 0xe0], "JFIF stays first");
    assert.ok(s.slice(-7).equals(Buffer.from([1, 2, 3, 4, 5, 0xff, 0xd9])), "the image data is untouched");
    const plain = Buffer.concat([Buffer.from([0xff, 0xd8]), jpegSeg(0xdb, Buffer.alloc(65, 1)), sof0(8, 8),
      jpegSeg(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])), Buffer.from([9, 0xff, 0xd9])]);
    assert.ok(enhance.stripMetadata(plain).equals(plain), "nothing to cut: the same bytes");
    assert.strictEqual(enhance.stripMetadata(jpegHeaderOnly(640, 480)), null, "no image data: unreadable");

    const tagged = pngOf(8, 8, () => [10, 20, 30], { extra: [
      ["tEXt", Buffer.from("Location\0Kochi", "latin1")], ["eXIf", Buffer.from("MM\0*GPS", "latin1")],
      ["iTXt", Buffer.from("Comment\0\0\0\0\0home", "latin1")], ["tIME", Buffer.from([7, 234, 9, 26, 10, 0, 0])],
    ] });
    const p = enhance.stripMetadata(tagged);
    for (const bad of ["Kochi", "eXIf", "iTXt", "tIME", "GPS"]) assert.strictEqual(p.indexOf(bad), -1, bad);
    assert.ok(p.equals(pngOf(8, 8, () => [10, 20, 30])), "exactly the untagged picture");
    assert.ok(enhance.stripMetadata(FADED_PNG).equals(FADED_PNG));

    const riffChunk = (fourcc, data) => {
      const h = Buffer.alloc(8);
      h.write(fourcc, 0, "latin1");
      h.writeUInt32LE(data.length, 4);
      return Buffer.concat([h, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x10 | 0x08 | 0x04; // alpha, EXIF, XMP
    vp8x.writeUIntLE(639, 4, 3);
    vp8x.writeUIntLE(479, 7, 3);
    const body = Buffer.concat([Buffer.from("WEBP", "latin1"), riffChunk("VP8X", vp8x),
      riffChunk("VP8L", vp8lHeader(640, 480, true).slice(20)),
      riffChunk("EXIF", Buffer.from("MM\0*GPSLatitude", "latin1")), riffChunk("XMP ", Buffer.from("<x:xmpmeta>home</x:xmpmeta>", "latin1"))]);
    const head = Buffer.alloc(8);
    head.write("RIFF", 0, "latin1");
    head.writeUInt32LE(body.length, 4);
    const webp = Buffer.concat([head, body]);
    const w = enhance.stripMetadata(webp);
    for (const bad of ["EXIF", "XMP ", "GPS", "xmpmeta"]) assert.strictEqual(w.indexOf(bad), -1, bad);
    assert.strictEqual(w.readUInt32LE(4), w.length - 8, "RIFF size");
    assert.strictEqual(w[20] & 0x0c, 0, "the EXIF and XMP flags are cleared");
    assert.strictEqual(w[20] & 0x10, 0x10, "the alpha flag stays");
    assert.deepStrictEqual(imageEdit.imageSize(w), { width: 640, height: 480 });
  });

  await atest("transparency is found in RGBA and tRNS PNGs and in WebP; a JPEG never has it", () => {
    assert.strictEqual(enhance.hasAlpha(pngOf(4, 4, () => [1, 2, 3, 0], { alpha: true })), true);
    assert.strictEqual(enhance.hasAlpha(pngOf(4, 4, () => [1, 2, 3])), false);
    assert.strictEqual(enhance.hasAlpha(pngOf(4, 4, () => [1, 2, 3], { extra: [["tRNS", Buffer.from([0, 1, 0, 2, 0, 3])]] })), true);
    assert.strictEqual(enhance.hasAlpha(vp8lHeader(8, 8, true)), true);
    assert.strictEqual(enhance.hasAlpha(vp8lHeader(8, 8, false)), false);
    assert.strictEqual(enhance.hasAlpha(jpegHeaderOnly(8, 8)), false);
    // The white it is laid on is left out of the levels plan.
    const rgb = Buffer.alloc(300);
    for (let i = 0; i < 100; i++) rgb.fill(i < 40 ? 255 : 90 + i, 3 * i, 3 * i + 3);
    assert.strictEqual(enhance.dropWhite(rgb).length, 60 * 3);
    assert.strictEqual(enhance.dropWhite(Buffer.alloc(30, 255)).length, 30, "all white: nothing left out");
  });

  await atest("without ffmpeg the stored photo has no tags, is read by its bytes, and keeps its orientation", async () => {
    const real = imageEdit.haveFfmpeg;
    imageEdit.haveFfmpeg = async () => false;
    try {
      const jpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        jpegSeg(0xe1, Buffer.concat([exifSegment(6).slice(4), Buffer.from("GPSLatitude=12.975", "latin1")])),
        jpegSeg(0xdb, Buffer.alloc(65, 1)), sof0(640, 480),
        jpegSeg(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])), Buffer.from([7, 0xff, 0xd9]),
      ]);
      const out = await enhance.prepare(jpeg, "image/png");
      assert.strictEqual(out.original.ext, "jpg", "a JPEG named .png is stored as the JPEG it is");
      assert.strictEqual(out.original.buffer.indexOf("GPS"), -1, "no GPS reaches storage");
      assert.strictEqual(enhance.exifOrientation(out.original.buffer), 6);
      assert.deepStrictEqual([out.original.width, out.original.height], [480, 640], "the size it is seen at");
      assert.strictEqual(out.enhanced, null);
      await assert.rejects(enhance.prepare(jpegHeaderOnly(640, 480), "image/jpeg"), (e) => e.code === "undecodable");
    } finally {
      imageEdit.haveFfmpeg = real;
    }
  });

  await atest("a faded, yellowed colour print gets its range and balance back, in the plan", () => {
    const rgb = rgbOf(160, 213, (x, y) => faded(scene(x, y, 160, 213)));
    const p = enhance.planLevels(rgb, "keep");
    assert.strictEqual(p.mono, false, "a colour photo must never be turned grey");
    for (let c = 0; c < 3; c++) {
      assert.ok(p.lo[c] > 60, `lifted blacks are pulled down (lo ${p.lo[c]})`);
      assert.ok(p.hi[c] < 230, `dull whites are pushed up (hi ${p.hi[c]})`);
      assert.ok(p.gamma[c] >= 0.7 && p.gamma[c] <= 1.3);
    }
    // The yellow cast: blue's range starts lower than red's, and the
    // per-channel levels follow each channel.
    assert.ok(p.lo[0] > p.lo[2], "red and blue are levelled separately");
    assert.ok(p.saturation > 1 && p.saturation <= 1.12);
    const f = enhance.filterFor(p);
    assert.match(f, /^hqdn3d=1\.5:1\.5:6:6,format=rgb24,lutrgb=r='clip\(pow\(clip\(\(val-/);
    assert.match(f, /colorchannelmixer=rr=/);
    assert.match(f, /format=yuvj444p,unsharp=/);
    assert.ok(!/e-|e\+|NaN|Infinity/.test(f), "every number is fixed-point");
  });

  await atest("a black-and-white print gone brown is read as mono and made neutral; bw and sepia on request", () => {
    const rgb = rgbOf(160, 213, (x, y) => sepiaPrint(scene(x, y, 160, 213)));
    const p = enhance.planLevels(rgb, "keep");
    assert.strictEqual(p.mono, true);
    assert.deepStrictEqual(p.matrix, enhance.matrixFor("bw"));
    assert.ok(p.lo[0] > p.lo[2] + 20, "the brown is undone channel by channel");
    const bw = enhance.planLevels(rgbOf(160, 120, (x, y) => scene(x, y, 160, 120)), "bw");
    assert.strictEqual(bw.mono, true);
    assert.strictEqual(bw.lo[0], bw.lo[2], "black and white of a colour photo: one range for all three");
    const sep = enhance.planLevels(rgbOf(160, 120, (x, y) => scene(x, y, 160, 120)), "sepia");
    const m = sep.matrix;
    assert.ok(m[0] + m[1] + m[2] > m[3] + m[4] + m[5] && m[3] + m[4] + m[5] > m[6] + m[7] + m[8], "warm: r > g > b");
    const keepIdentity = enhance.matrixFor("keep", 1);
    assert.deepStrictEqual(keepIdentity, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    assert.deepStrictEqual(enhance.planLevels(Buffer.alloc(0)).lo, [0, 0, 0], "nothing read, nothing changed");
  });

  /* ================================================================ */
  console.log("\nthe clean-up, without AI: ffmpeg");

  let FADED_JPEG = null;
  if (HAVE_FFMPEG) {
    const dir = fs.mkdtempSync(path.join(TMP, "ff-"));
    const out = path.join(dir, "faded.jpg");
    // A synthetic photo made WITH FFMPEG, then faded like an old print.
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x480:rate=1",
      "-vf", "eq=saturation=0.7,lutrgb=r='val*0.55+95':g='val*0.55+80':b='val*0.5+45'",
      "-frames:v", "1", "-q:v", "3", out]);
    FADED_JPEG = fs.readFileSync(out);
  }
  const statsOf = async (buf) => {
    const f = path.join(TMP, `m-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
    fs.writeFileSync(f, buf);
    return measure(await enhance.readStats(f));
  };

  if (!HAVE_FFMPEG) {
    for (const n of ["a faded photo made with ffmpeg gets more contrast and less colour cast",
      "EXIF orientation is baked in and every tag is stripped",
      "the long edge is capped at 2048", "black and white, and sepia", "the same photo gives the same bytes"]) {
      skip(n, "no ffmpeg on this machine — run in the Docker image");
    }
  } else {
    await atest("a faded photo made with ffmpeg gets more contrast and less colour cast", async () => {
      const out = await enhance.prepare(FADED_JPEG, "image/jpeg", { colour: "keep" });
      assert.ok(out.enhanced, out.notes.join("; "));
      const before = await statsOf(out.original.buffer);
      const after = await statsOf(out.enhanced.buffer);
      assert.ok(after.spread > before.spread * 1.3, `spread ${before.spread} → ${after.spread}`);
      assert.ok(after.cast < before.cast * 0.75, `cast ${before.cast.toFixed(1)} → ${after.cast.toFixed(1)}`);
      assert.ok(after.chroma > 0.05, "a colour photo keeps its colour");
      assert.deepStrictEqual([out.enhanced.width, out.enhanced.height], [640, 480]);
    });

    await atest("EXIF orientation is baked in and every tag is stripped", async () => {
      const rotated = withExif(FADED_JPEG, 6);
      const out = await enhance.prepare(rotated, "image/jpeg");
      assert.deepStrictEqual([out.original.width, out.original.height], [480, 640], "turned upright");
      assert.deepStrictEqual([out.enhanced.width, out.enhanced.height], [480, 640]);
      for (const b of [out.original.buffer, out.enhanced.buffer]) {
        assert.strictEqual(b.indexOf(Buffer.from("Exif\0\0", "latin1")), -1, "no EXIF (and so no GPS) kept");
        assert.strictEqual(enhance.exifOrientation(b), 1);
      }
      const eight = await enhance.prepare(withExif(FADED_JPEG, 8, "MM"), "image/jpeg");
      assert.deepStrictEqual([eight.original.width, eight.original.height], [480, 640]);
    });

    await atest("the long edge is capped at 2048", async () => {
      const big = path.join(TMP, "big.jpg");
      execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=3000x2000:rate=1",
        "-frames:v", "1", "-q:v", "5", big]);
      const out = await enhance.prepare(fs.readFileSync(big), "image/jpeg");
      assert.strictEqual(Math.max(out.original.width, out.original.height), 2048);
      assert.ok(Math.abs(out.original.height - 1365) <= 1);
      assert.strictEqual(Math.max(out.enhanced.width, out.enhanced.height), 2048);
    });

    await atest("black and white, and sepia", async () => {
      const bw = await enhance.prepare(FADED_JPEG, "image/jpeg", { colour: "bw" });
      assert.ok((await statsOf(bw.enhanced.buffer)).chroma < 0.02, "black and white has no colour");
      const sep = await enhance.prepare(FADED_JPEG, "image/jpeg", { colour: "sepia" });
      const m = (await statsOf(sep.enhanced.buffer)).mean;
      assert.ok(m[0] > m[1] && m[1] > m[2], `sepia is warm: ${m.map((v) => v.toFixed(0))}`);
      const brown = await enhance.prepare(SEPIA_PNG, "image/png", { colour: "keep" });
      assert.ok((await statsOf(brown.enhanced.buffer)).chroma < 0.03, "a browned b&w print comes back neutral");
      const again = await enhance.reenhance(bw.original.buffer, "sepia");
      assert.ok(again && again.buffer.length > 2048);
    });

    await atest("the same photo gives the same bytes", async () => {
      const a = await enhance.prepare(FADED_JPEG, "image/jpeg");
      const b = await enhance.prepare(FADED_JPEG, "image/jpeg");
      assert.ok(a.enhanced.buffer.equals(b.enhanced.buffer));
      assert.ok(a.original.buffer.equals(b.original.buffer));
    });
  }

  /* ================================================================ */
  console.log("\n/posters: consent and photos");

  await atest("consent: GET, POST, DELETE — and it never mentions an AI v1 does not have", async () => {
    let r = await json(await call(U, "/posters/consent"));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, {
      accepted: false, version: "family-photo-v1", text: svc.CONSENT_TEXT, aiRestore: false,
    });
    assert.match(r.body.text, /Nothing is changed by AI/);
    r = await json(await call(U, "/posters/consent", { method: "POST" }));
    assert.deepStrictEqual(r.body, { accepted: true, version: "family-photo-v1" });
    assert.strictEqual((await json(await call(U, "/posters/consent"))).body.accepted, true);
    r = await json(await call(U, "/posters/consent", { method: "DELETE" }));
    assert.deepStrictEqual(r.body, { accepted: false, photosRemoved: 0 });
    assert.strictEqual((await json(await call(U, "/posters/consent"))).body.accepted, false);
    assert.strictEqual((await call(0, "/posters/consent")).status, 400, "no account, no card");
  });

  let photo1;
  await atest("an upload stores the original (and the clean copy) — no document, no memory, no push, no outbound call", async () => {
    const docsBefore = await count("documents", U);
    const factsBefore = await count("agent_memories", U);
    const pushesBefore = pushes.length;
    const outBefore = outbound.length;
    const r = await json(await upload(U, FADED_PNG, { fields: { source: "gallery", colour: "keep" } }));
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    photo1 = r.body.photo;
    assert.ok(!r.body.poster);
    assert.strictEqual(photo1.status, "ready");
    assert.strictEqual(photo1.reason, "off", "the AI switch alone starts nothing");
    assert.strictEqual(photo1.source, "gallery");
    assert.deepStrictEqual([photo1.width, photo1.height], [W, H]);
    const dir = path.join(FILES, String(U), "posters", String(photo1.id));
    if (HAVE_FFMPEG) {
      assert.deepStrictEqual(photo1.variants, ["original", "enhanced"]);
      assert.ok(fs.existsSync(path.join(dir, "original.jpg")));
      assert.ok(fs.existsSync(path.join(dir, "enhanced-keep.jpg")), "one file per colour");
    } else {
      assert.deepStrictEqual(photo1.variants, ["original"], "no ffmpeg: no clean copy, never a fake one");
      assert.ok(fs.readFileSync(path.join(dir, "original.png")).equals(FADED_PNG));
    }
    assert.strictEqual(await count("documents", U), docsBefore, "a working photo is not a document");
    assert.strictEqual(await count("agent_memories", U), factsBefore);
    assert.strictEqual(pushes.length, pushesBefore);
    assert.strictEqual(outbound.length, outBefore, "no vision or model call for a card's photo");
    const ai = await json(await upload(U, FADED_PNG, { fields: { ai: "false" } }));
    assert.strictEqual(ai.body.photo.reason, "not_requested");
  });

  await atest("wrong type is 415, too large is 413, bytes that are not a photo are 415 — nothing stored", async () => {
    const before = (await store.photoIdsOf(U)).length;
    assert.strictEqual((await upload(U, Buffer.from("heic-bytes"), { type: "image/heic", name: "a.heic" })).status, 415);
    assert.strictEqual((await upload(U, Buffer.from("not really a jpeg at all"), { type: "image/jpeg", name: "a.jpg" })).status, 415);
    const big = await json(await upload(U, Buffer.alloc(18 * 1024 * 1024 + 1, 1), { type: "image/jpeg", name: "big.jpg" }));
    assert.strictEqual(big.status, 413);
    assert.strictEqual(big.body.error, "too_large");
    assert.strictEqual((await call(U, "/posters/photos", { method: "POST", body: new FormData() })).status, 400);
    assert.strictEqual((await store.photoIdsOf(U)).length, before);
  });

  await atest("the photo and its files: GET, ?v=, cache header, 404 for a missing version and for another user", async () => {
    const r = await json(await call(U, `/posters/photos/${photo1.id}?wait=25`));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.photo.variants, photo1.variants);
    const orig = await call(U, `/posters/photos/${photo1.id}/file?v=original`);
    assert.strictEqual(orig.status, 200);
    assert.strictEqual(orig.headers.get("cache-control"), "private, max-age=86400");
    assert.strictEqual(orig.headers.get("content-type"), HAVE_FFMPEG ? "image/jpeg" : "image/png");
    assert.ok((await orig.arrayBuffer()).byteLength > 1000);
    const enh = await call(U, `/posters/photos/${photo1.id}/file?v=enhanced`);
    assert.strictEqual(enh.status, HAVE_FFMPEG ? 200 : 404);
    assert.strictEqual((await call(U, `/posters/photos/${photo1.id}/file?v=restored`)).status, 404);
    assert.strictEqual((await call(V, `/posters/photos/${photo1.id}`)).status, 404);
    assert.strictEqual((await call(V, `/posters/photos/${photo1.id}/file?v=original`)).status, 404);
    assert.strictEqual((await call(U, "/posters/photos/99999999999")).status, 404);
    assert.strictEqual((await call(U, "/posters/photos/abc")).status, 404);
  });

  await atest("restore answers 503 'off' — no AI in v1, even with the switch on", async () => {
    const r = await json(await call(U, `/posters/photos/${photo1.id}/restore`, { method: "POST", json: {} }));
    assert.strictEqual(r.status, 503);
    assert.deepStrictEqual(r.body, { error: "off", message: "Photo repair is not switched on yet." });
    assert.strictEqual((await call(V, `/posters/photos/${photo1.id}/restore`, { method: "POST", json: {} })).status, 404);
  });

  await atest("colour: black and white / sepia re-run the clean-up (503 honestly where ffmpeg is missing)", async () => {
    const r = await json(await call(U, `/posters/photos/${photo1.id}/colour`, { method: "POST", json: { colour: "bw" } }));
    if (HAVE_FFMPEG) {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.photo.colour, "bw");
      const f = await call(U, `/posters/photos/${photo1.id}/file?v=enhanced`);
      const buf = Buffer.from(await f.arrayBuffer());
      assert.ok((await statsOf(buf)).chroma < 0.02);
      // Each colour is its own file and its own URL: the colour copy is
      // still there, unchanged, beside the black-and-white one.
      const keep = Buffer.from(await (await call(U, `/posters/photos/${photo1.id}/file?v=enhanced&colour=keep`)).arrayBuffer());
      assert.ok((await statsOf(keep)).chroma > 0.05);
      const bw = Buffer.from(await (await call(U, `/posters/photos/${photo1.id}/file?v=enhanced&colour=bw`)).arrayBuffer());
      assert.ok(bw.equals(buf));
      await call(U, `/posters/photos/${photo1.id}/colour`, { method: "POST", json: { colour: "keep" } });
    } else {
      assert.strictEqual(r.status, 503);
      assert.strictEqual(r.body.error, "unavailable");
      assert.doesNotMatch(r.body.message, /photo (is|was) (bad|poor|unclear)/i);
    }
    assert.strictEqual((await call(U, `/posters/photos/${photo1.id}/colour`, { method: "POST", json: { colour: "rainbow" } })).status, 400);
    assert.strictEqual((await call(U, `/posters/photos/${photo1.id}/file?v=enhanced&colour=rainbow`)).status, 404);
  });

  await atest("keep: the chosen version becomes a document with an honest title and summary", async () => {
    const v = HAVE_FFMPEG ? "enhanced" : "original";
    const before = await count("documents", U);
    const r = await json(await call(U, `/posters/photos/${photo1.id}/keep`, { method: "POST", json: { v } }));
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(await count("documents", U), before + 1);
    const d = r.body.document;
    assert.match(d.title, HAVE_FFMPEG ? /^Photo made clearer - \d{1,2} \w{3} \d{4}$/ : /^Photo - /);
    assert.doesNotMatch(`${d.title} ${d.summary}`, /restor|repair/i);
    if (HAVE_FFMPEG) assert.match(d.summary, /No AI/);
    assert.strictEqual((await call(U, `/posters/photos/${photo1.id}/keep`, { method: "POST", json: { v: "restored" } })).status, 404);
    assert.strictEqual((await call(V, `/posters/photos/${photo1.id}/keep`, { method: "POST", json: { v } })).status, 404);
  });

  await atest("from-document: his saved photo is used; a PDF is 415; somebody else's document is 404", async () => {
    const img = await docs.createDocument(U, { buffer: FADED_PNG, filename: "old.png", mime: "image/png" });
    const pdf = await docs.createDocument(U, { buffer: Buffer.from("%PDF-1.4\n%fake\n"), filename: "a.pdf", mime: "application/pdf" });
    const theirs = await docs.createDocument(V, { buffer: FADED_PNG, filename: "v.png", mime: "image/png" });
    const r = await json(await call(U, "/posters/photos/from-document", { method: "POST", json: { documentId: img.id } }));
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.photo.source, "document");
    assert.strictEqual((await call(U, "/posters/photos/from-document", { method: "POST", json: { documentId: pdf.id } })).status, 415);
    assert.strictEqual((await call(U, "/posters/photos/from-document", { method: "POST", json: { documentId: theirs.id } })).status, 404);
    assert.strictEqual((await call(U, "/posters/photos/from-document", { method: "POST", json: { documentId: "x" } })).status, 404);
  });

  /* ================================================================ */
  console.log("\n/posters: the card");

  let card;
  await atest("create, latest, get — and another user's card is 404", async () => {
    assert.strictEqual((await call(V, "/posters/latest")).status, 404, "no card yet is a plain 404");
    const r = await json(await call(U, "/posters", { method: "POST", json: {
      occasion: "birthday", photoId: photo1.id,
      spec: { forWhom: "my daughter", name: "Ananya", age: 25, message: "Wishing you joy.\nWe are proud of you.", from: "Appa", signature: true },
    } }));
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    card = r.body.poster;
    assert.strictEqual(card.version, 1);
    assert.strictEqual(card.canUndo, false);
    assert.strictEqual(card.spec.headline, "Happy 25th Birthday");
    assert.strictEqual(card.spec.design, "floral_blush");
    assert.strictEqual(card.spec.photoUse, HAVE_FFMPEG ? "enhanced" : "original");
    assert.strictEqual(card.photo.id, photo1.id);
    assert.strictEqual(card.finalDocumentId, null);
    const latest = await json(await call(U, "/posters/latest"));
    assert.strictEqual(latest.body.poster.id, card.id);
    assert.deepStrictEqual((await json(await call(U, `/posters/${card.id}`))).body.poster, latest.body.poster);
    assert.strictEqual((await call(V, `/posters/${card.id}`)).status, 404);
    assert.strictEqual((await call(U, "/posters/abc")).status, 404);
    const bad = await json(await call(U, "/posters", { method: "POST", json: { photoId: 99999999 } }));
    assert.strictEqual(bad.status, 404);
    const theirPhoto = await json(await call(V, "/posters", { method: "POST", json: { photoId: photo1.id } }));
    assert.strictEqual(theirPhoto.status, 404, "his photo cannot go on somebody else's card");
  });

  await atest("a too-long name or message is 422 need — nothing created, nothing cut", async () => {
    const before = await count("posters", U);
    const r = await json(await call(U, "/posters", { method: "POST", json: { spec: { name: "N".repeat(61) } } }));
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.error, "need");
    assert.deepStrictEqual(r.body.need, [{ field: "name", reason: "too_long", max: 60, length: 61 }]);
    assert.match(r.body.message, /shorter/);
    assert.strictEqual(await count("posters", U), before);
    const p = await json(await call(U, `/posters/${card.id}`, { method: "PATCH",
      json: { version: card.version, change: { set: { message: "m".repeat(301) } } } }));
    assert.strictEqual(p.status, 422);
    assert.strictEqual(p.body.need[0].field, "message");
    const now = (await json(await call(U, `/posters/${card.id}`))).body.poster;
    assert.strictEqual(now.version, card.version, "a refused edit changes nothing");
    assert.strictEqual(now.spec.message, card.spec.message);
  });

  await atest("PATCH: a change bumps the version; a stale version is 409 carrying the server's copy", async () => {
    const r = await json(await call(U, `/posters/${card.id}`, { method: "PATCH", json: {
      version: 1, change: { set: { message: "Happy birthday, my dear!" }, textSize: "bigger", colour: "gold", format: "story" },
    } }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.poster.version, 2);
    assert.strictEqual(r.body.poster.spec.message, "Happy birthday, my dear!");
    assert.strictEqual(r.body.poster.spec.textScale, 1.15);
    assert.strictEqual(r.body.poster.spec.colour, "gold");
    assert.strictEqual(r.body.poster.spec.format, "story");
    assert.strictEqual(r.body.poster.canUndo, true);
    const stale = await json(await call(U, `/posters/${card.id}`, { method: "PATCH", json: { version: 1, change: { colour: "blue" } } }));
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.body.error, "version_conflict");
    assert.strictEqual(stale.body.poster.version, 2);
    assert.strictEqual(stale.body.poster.spec.colour, "gold", "the stale edit did not land");
    assert.strictEqual((await call(U, `/posters/${card.id}`, { method: "PATCH", json: { change: {} } })).status, 400);
    const bad = await json(await call(U, `/posters/${card.id}`, { method: "PATCH", json: { version: 2, change: { colour: "rainbow" } } }));
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.error, "bad_change");
    assert.strictEqual((await call(V, `/posters/${card.id}`, { method: "PATCH", json: { version: 2, change: { colour: "blue" } } })).status, 404);
    card = r.body.poster;
  });

  await atest("undo restores the exact previous card; history keeps 20; empty undo is 422", async () => {
    const before = (await json(await call(U, `/posters/${card.id}`))).body.poster;
    const r = await json(await call(U, `/posters/${card.id}`, { method: "PATCH", json: { version: before.version, change: { textSize: "bigger" } } }));
    const u = await json(await call(U, `/posters/${card.id}`, { method: "PATCH", json: { version: r.body.poster.version, change: { undo: true } } }));
    assert.strictEqual(u.status, 200);
    assert.deepStrictEqual(u.body.poster.spec, before.spec);
    assert.strictEqual(u.body.poster.version, before.version + 2, "undo is a change too — the phone's copy must refresh");
    assert.strictEqual((await call(U, `/posters/${card.id}`, { method: "PATCH", json: { version: u.body.poster.version, change: { undo: true, colour: "pink" } } })).status, 400);
    // 25 edits, then undo until empty: 20 steps back and no more.
    let v = u.body.poster.version;
    for (let i = 0; i < 25; i++) {
      const x = await json(await call(U, `/posters/${card.id}`, { method: "PATCH", json: { version: v, change: { set: { date: `day ${i}` } } } }));
      v = x.body.poster.version;
    }
    let undone = 0;
    for (;;) {
      const x = await json(await call(U, `/posters/${card.id}`, { method: "PATCH", json: { version: v, change: { undo: true } } }));
      if (x.status !== 200) {
        assert.strictEqual(x.status, 422);
        assert.strictEqual(x.body.error, "nothing_to_undo");
        assert.strictEqual(x.body.poster.canUndo, false);
        break;
      }
      v = x.body.poster.version;
      undone++;
      assert.ok(undone <= 20);
    }
    assert.strictEqual(undone, 20);
    card = (await json(await call(U, `/posters/${card.id}`))).body.poster;
    assert.strictEqual(card.spec.date, "day 4", "twenty steps back from day 24");
  });

  await atest("the photo can be swapped, switched off and back, and moved", async () => {
    const other = (await json(await upload(U, SEPIA_PNG))).body.photo;
    let r = await json(await call(U, `/posters/${card.id}`, { method: "PATCH", json: { version: card.version, change: { photoId: other.id } } }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.poster.photo.id, other.id);
    r = await json(await call(U, `/posters/${card.id}`, { method: "PATCH", json: { version: r.body.poster.version, change: { photoUse: "none" } } }));
    assert.strictEqual(r.body.poster.spec.photoUse, "none");
    r = await json(await call(U, `/posters/${card.id}`, { method: "PATCH", json: { version: r.body.poster.version,
      change: { photoUse: "original", photoFocus: { x: 0.4, y: 0.3, zoom: 5 } } } }));
    assert.strictEqual(r.body.poster.spec.photoUse, "original");
    assert.deepStrictEqual(r.body.poster.spec.photoFocus, { x: 0.4, y: 0.3, zoom: 3 }, "zoom is clamped");
    const u = await json(await call(U, `/posters/${card.id}`, { method: "PATCH", json: { version: r.body.poster.version, change: { undo: true } } }));
    assert.strictEqual(u.body.poster.spec.photoUse, "none");
    const theirs = (await json(await upload(V, FADED_PNG))).body.photo;
    const x = await json(await call(U, `/posters/${card.id}`, { method: "PATCH", json: { version: u.body.poster.version, change: { photoId: theirs.id } } }));
    assert.strictEqual(x.status, 404, "somebody else's photo cannot go on his card");
    r = await json(await call(U, `/posters/${card.id}`, { method: "PATCH", json: { version: u.body.poster.version, change: { photoId: photo1.id } } }));
    card = r.body.poster;
    assert.strictEqual(card.photo.id, photo1.id);
  });

  await atest("the photo arrives for a card: posterId puts it on and bumps the version", async () => {
    const empty = (await json(await call(U, "/posters", { method: "POST", json: { spec: { name: "Meera" } } }))).body.poster;
    assert.strictEqual(empty.photo, null);
    assert.strictEqual(empty.spec.photoUse, "none");
    const r = await json(await upload(U, FADED_PNG, { fields: { posterId: empty.id, source: "camera" } }));
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.poster.id, empty.id);
    assert.strictEqual(r.body.poster.version, 2);
    assert.strictEqual(r.body.poster.photo.id, r.body.photo.id);
    assert.strictEqual(r.body.poster.spec.photoUse, HAVE_FFMPEG ? "enhanced" : "original");
    assert.strictEqual(r.body.photo.source, "camera");
    assert.strictEqual((await upload(U, FADED_PNG, { fields: { posterId: 99999999 } })).status, 404);
    assert.strictEqual((await call(U, `/posters/${empty.id}`, { method: "DELETE" })).status, 200);
  });

  await atest("the final PNG: saved as 'Birthday card - Ananya', tags, exact words; replaces only this card's copy", async () => {
    const png = pngOf(1080, 1350, () => [250, 230, 235]);
    const other = (await json(await call(U, "/posters", { method: "POST", json: { spec: { name: "Ravi" } } }))).body.poster;
    const otherFinal = await json(await finalCard(U, other.id, png, other.version));
    assert.strictEqual(otherFinal.status, 201, JSON.stringify(otherFinal.body));

    const docsBefore = await count("documents", U);
    const r = await json(await finalCard(U, card.id, png, card.version));
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const d = r.body.document;
    assert.strictEqual(d.title, "Birthday card - Ananya");
    assert.strictEqual(d.tags, "poster, birthday");
    assert.doesNotMatch(d.tags, /ai-edited/);
    assert.strictEqual(d.mime, "image/png");
    assert.strictEqual(r.body.poster.finalDocumentId, d.id);
    const row = await docs.getDocument(U, d.id);
    assert.strictEqual(row.full_text, S.words(card.spec).join("\n"), "the document's text is the card's exact words");
    assert.ok(row.full_text.includes("Ananya"));
    assert.strictEqual(await count("documents", U), docsBefore + 1);

    // Again: the new copy replaces this card's old one, and only that one.
    const again = await json(await finalCard(U, card.id, png, card.version));
    assert.strictEqual(again.status, 201);
    assert.strictEqual(await docs.getDocument(U, d.id), null, "the earlier copy of THIS card is gone");
    assert.ok(await docs.getDocument(U, otherFinal.body.document.id), "another card's copy is untouched");
    assert.strictEqual(await count("documents", U), docsBefore + 1);

    const stale = await json(await finalCard(U, card.id, png, card.version - 1));
    assert.strictEqual(stale.status, 409, "a picture of older words is never saved as this card");
    assert.strictEqual(stale.body.poster.version, card.version);
    assert.strictEqual((await finalCard(U, card.id, FADED_PNG.slice(0, 40), card.version, "image/png")).status, 415);
    assert.strictEqual((await finalCard(U, card.id, Buffer.from("GIF89a...."), card.version, "image/png")).status, 415);
    assert.strictEqual((await finalCard(U, card.id, Buffer.alloc(8 * 1024 * 1024 + 1, 1), card.version)).status, 413);
    assert.strictEqual((await finalCard(V, card.id, png, card.version)).status, 404);
    card = (await json(await call(U, `/posters/${card.id}`))).body.poster;
    assert.strictEqual(card.finalDocumentId, again.body.document.id);
  });

  await atest("delete: the card goes, and its photo with it when no other card uses it", async () => {
    const ph = (await json(await upload(U, FADED_PNG))).body.photo;
    const c = (await json(await call(U, "/posters", { method: "POST", json: { photoId: ph.id, spec: { name: "Tara" } } }))).body.poster;
    assert.strictEqual((await call(V, `/posters/${c.id}`, { method: "DELETE" })).status, 404);
    const r = await json(await call(U, `/posters/${c.id}`, { method: "DELETE" }));
    assert.deepStrictEqual(r.body, { ok: true });
    assert.strictEqual((await call(U, `/posters/${c.id}`)).status, 404);
    assert.strictEqual(await store.getPhoto(U, ph.id), null);
    assert.ok(!fs.existsSync(path.join(FILES, String(U), "posters", String(ph.id))));
    assert.strictEqual((await call(U, `/posters/${c.id}`, { method: "DELETE" })).status, 404);
  });

  /* ---- review fixes, 2026-09-26 ---- */

  const TOO_BIG = "That photo is too big to use — please pick a smaller copy of it.";
  const DOESNT_OPEN = "That photo doesn't open — please pick another one.";
  /** A PNG whose header and checksums are right and whose pixels cannot be inflated. */
  function scrambledPng() {
    const good = pngOf(64, 64, () => [120, 130, 140]);
    const at = 8 + 25;
    const len = good.readUInt32BE(at);
    const bad = Buffer.from(good);
    for (let i = at + 8; i < at + 8 + len; i++) bad[i] = (bad[i] * 7 + 13) & 0xff;
    bad.writeUInt32BE(crc32(bad.slice(at + 4, at + 8 + len)), at + 8 + len);
    return bad;
  }

  await atest("a picture that SAYS 16000x16000 is refused before anything opens it; one that won't decode is 415", async () => {
    const before = (await store.photoIdsOf(U)).length;
    const bomb = await json(await upload(U, pngHeaderOnly(16000, 16000)));
    assert.strictEqual(bomb.status, 413);
    assert.deepStrictEqual(bomb.body, { error: "too_large", message: TOO_BIG });
    const bigJpeg = await json(await upload(U, jpegHeaderOnly(60000, 60000), { type: "image/jpeg", name: "a.jpg" }));
    assert.strictEqual(bigJpeg.status, 413, "even at 1/8 size too many pixels");
    const saved = await docs.createDocument(U, { buffer: pngHeaderOnly(16000, 16000), filename: "b.png", mime: "image/png" });
    assert.strictEqual((await call(U, "/posters/photos/from-document", { method: "POST", json: { documentId: saved.id } })).status, 413,
      "the voice path (a saved document) has the same budget");
    const broken = await json(await upload(U, jpegHeaderOnly(640, 480), { type: "image/jpeg", name: "a.jpg" }));
    assert.strictEqual(broken.status, 415);
    assert.deepStrictEqual(broken.body, { error: "unsupported_type", message: DOESNT_OPEN },
      "never 'try again' for bytes that will fail the same way every time");
    if (HAVE_FFMPEG) {
      const scrambled = await json(await upload(U, scrambledPng()));
      assert.strictEqual(scrambled.status, 415);
      assert.strictEqual(scrambled.body.message, DOESNT_OPEN);
    }
    assert.strictEqual((await store.photoIdsOf(U)).length, before, "nothing stored");
    const owned = new Set((await store.photoIdsOf(U)).map(String));
    const stray = fs.readdirSync(path.join(FILES, String(U), "posters")).filter((d) => !owned.has(d));
    assert.deepStrictEqual(stray, [], "no folder left behind");
  });

  await atest("the type is read from the bytes: a lossless WebP is a photo; a JPEG named .png is turned upright", async () => {
    if (!HAVE_FFMPEG) {
      // Header-only on a dev box: accepted and stored with its size read.
      const r = await json(await upload(U, vp8lHeader(640, 480), { type: "image/webp", name: "a.webp" }));
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      assert.deepStrictEqual([r.body.photo.width, r.body.photo.height], [640, 480]);
      const j = await json(await upload(U, withExif(Buffer.concat([Buffer.from([0xff, 0xd8]), jpegSeg(0xdb, Buffer.alloc(65, 1)),
        sof0(640, 480), jpegSeg(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])), Buffer.from([7, 0xff, 0xd9])]), 6),
      { type: "image/png", name: "old.png" }));
      assert.strictEqual(j.status, 201);
      assert.deepStrictEqual([j.body.photo.width, j.body.photo.height], [480, 640]);
      assert.ok(fs.existsSync(path.join(FILES, String(U), "posters", String(j.body.photo.id), "original.jpg")));
      return;
    }
    const dir = fs.mkdtempSync(path.join(TMP, "webp-"));
    const src = path.join(dir, "s.png");
    fs.writeFileSync(src, pngOf(120, 90, (x, y) => scene(x, y, 120, 90)));
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", src, "-c:v", "libwebp", "-lossless", "1", path.join(dir, "s.webp")]);
    const webp = fs.readFileSync(path.join(dir, "s.webp"));
    assert.strictEqual(webp.slice(12, 16).toString("latin1"), "VP8L");
    const r = await json(await upload(U, webp, { type: "image/webp", name: "s.webp" }));
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.photo.variants, ["original", "enhanced"]);
    const j = await json(await upload(U, withExif(FADED_JPEG, 6), { type: "image/png", name: "old.png" }));
    assert.strictEqual(j.status, 201);
    assert.deepStrictEqual([j.body.photo.width, j.body.photo.height], [480, 640], "upright, whatever it was called");
  });

  if (HAVE_FFMPEG) {
    await atest("a see-through cut-out is laid on white, and its clear part is left out of the clean-up", async () => {
      const w = 300;
      const h = 400;
      const cut = pngOf(w, h, (x, y) => (x < 100 ? [0, 0, 0, 0] : [...scene(x, y, w, h), 255]), { alpha: true });
      const opaque = pngOf(w, h, (x, y) => scene(x, y, w, h));
      const a = await enhance.prepare(cut, "image/png");
      const o = await enhance.prepare(opaque, "image/png");
      assert.strictEqual(a.flattened, true);
      const rgbOfJpeg = async (buf) => {
        const f = path.join(TMP, `a-${Math.random().toString(36).slice(2)}.jpg`);
        fs.writeFileSync(f, buf);
        return execFileSync("ffmpeg", ["-v", "error", "-i", f, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
      };
      const orig = await rgbOfJpeg(a.original.buffer);
      const px = (raw, x, y) => [0, 1, 2].map((c) => raw[3 * (y * w + x) + c]);
      assert.ok(px(orig, 20, 200).every((v) => v >= 250), `the clear part is white, not black: ${px(orig, 20, 200)}`);
      const meanRight = (raw) => [0, 1, 2].map((c) => {
        let s = 0; let n = 0;
        for (let y = 0; y < h; y++) for (let x = 100; x < w; x++) { s += raw[3 * (y * w + x) + c]; n++; }
        return s / n;
      });
      const ea = meanRight(await rgbOfJpeg(a.enhanced.buffer));
      const eo = meanRight(await rgbOfJpeg(o.enhanced.buffer));
      for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs(ea[c] - eo[c]) < 12, `the real part is cleaned up like the opaque photo: ${ea.map(Math.round)} vs ${eo.map(Math.round)}`);
      }
      // Made again later (another colour, then back), the same bytes.
      const again = await enhance.reenhance(a.original.buffer, "keep", { flattened: true });
      assert.ok(again.buffer.equals(a.enhanced.buffer));
    });

    await atest("a 54 MP JPEG is opened at a quarter of its size, never whole", async () => {
      const big = path.join(TMP, "huge.jpg");
      execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=9000x6000:rate=1",
        "-frames:v", "1", "-q:v", "6", big]);
      const out = await enhance.prepare(fs.readFileSync(big), "image/jpeg");
      assert.ok(out.notes.includes("decoded at 1/4 size"), out.notes.join("; "));
      assert.deepStrictEqual([out.original.width, out.original.height], [2048, 1366]);
    });
  }

  await atest("DELETE a photo: off every card that shows it and out of their undo — rows and files gone", async () => {
    const A = (await json(await upload(U, FADED_PNG))).body.photo;
    const B = (await json(await upload(U, SEPIA_PNG))).body.photo;
    const c1 = (await json(await call(U, "/posters", { method: "POST", json: { photoId: A.id, spec: { name: "One" } } }))).body.poster;
    const c1b = (await json(await call(U, `/posters/${c1.id}`, { method: "PATCH", json: { version: c1.version, change: { photoId: B.id } } }))).body.poster;
    const c2 = (await json(await call(U, "/posters", { method: "POST", json: { photoId: A.id, spec: { name: "Two" } } }))).body.poster;
    assert.strictEqual((await call(V, `/posters/photos/${A.id}`, { method: "DELETE" })).status, 404, "not somebody else's");
    const r = await json(await call(U, `/posters/photos/${A.id}`, { method: "DELETE" }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.ok, true);
    assert.deepStrictEqual([...r.body.posterIds].sort((x, y) => x - y), [c1.id, c2.id].sort((x, y) => x - y));
    assert.strictEqual(await store.getPhoto(U, A.id), null);
    assert.ok(!fs.existsSync(path.join(FILES, String(U), "posters", String(A.id))));
    assert.strictEqual((await call(U, `/posters/photos/${A.id}/file?v=original`)).status, 404);
    const two = (await json(await call(U, `/posters/${c2.id}`))).body.poster;
    assert.strictEqual(two.photo, null);
    assert.strictEqual(two.spec.photoUse, "none");
    assert.strictEqual(two.spec.name, "Two", "the card's words stay");
    const one = (await json(await call(U, `/posters/${c1.id}`))).body.poster;
    assert.strictEqual(one.photo.id, B.id, "a card showing another photo keeps it");
    assert.ok(one.version > c1b.version, "the phone's copy must refresh");
    const back = await json(await call(U, `/posters/${c1.id}`, { method: "PATCH", json: { version: one.version, change: { undo: true } } }));
    assert.strictEqual(back.body.poster.photo, null, "undo can never bring the deleted photo back");
    assert.strictEqual((await call(U, `/posters/photos/${A.id}`, { method: "DELETE" })).status, 404);
    // A loose photo (the improve-old-photo screen) goes the same way.
    const loose = (await json(await upload(U, FADED_PNG))).body.photo;
    assert.deepStrictEqual((await json(await call(U, `/posters/photos/${loose.id}`, { method: "DELETE" }))).body, { ok: true, posterIds: [] });
    assert.strictEqual(await store.getPhoto(U, loose.id), null);
    for (const id of [c1.id, c2.id]) await call(U, `/posters/${id}`, { method: "DELETE" });
  });

  await atest("deleting a card takes the photos in its undo history too — unless another card still holds them", async () => {
    const C = (await json(await upload(U, FADED_PNG))).body.photo;
    const D = (await json(await upload(U, SEPIA_PNG))).body.photo;
    const E = (await json(await upload(U, FADED_PNG))).body.photo;
    const c = (await json(await call(U, "/posters", { method: "POST", json: { photoId: C.id, spec: { name: "Three" } } }))).body.poster;
    await json(await call(U, `/posters/${c.id}`, { method: "PATCH", json: { version: c.version, change: { photoId: D.id } } }));
    const keeper = (await json(await call(U, "/posters", { method: "POST", json: { photoId: E.id, spec: { name: "Four" } } }))).body.poster;
    await json(await call(U, `/posters/${keeper.id}`, { method: "PATCH", json: { version: keeper.version, change: { photoId: D.id } } }));
    // C: only in the deleted card's history. D: on it, and on the keeper.
    // E: only in the keeper's history.
    assert.strictEqual((await call(U, `/posters/${c.id}`, { method: "DELETE" })).status, 200);
    assert.strictEqual(await store.getPhoto(U, C.id), null, "the first photo, swapped out, goes with the card");
    assert.ok(!fs.existsSync(path.join(FILES, String(U), "posters", String(C.id))));
    assert.ok(await store.getPhoto(U, D.id), "another card still shows it");
    assert.ok(await store.getPhoto(U, E.id), "another card's undo can still bring it back");
    await call(U, `/posters/${keeper.id}`, { method: "DELETE" });
    assert.strictEqual(await store.getPhoto(U, D.id), null);
    assert.strictEqual(await store.getPhoto(U, E.id), null);
  });

  await atest("withdrawing consent removes every working photo — the cards keep their words", async () => {
    const W = await mk("w");
    USERS.push(W);
    await call(W, "/posters/consent", { method: "POST" });
    const onCard = (await json(await upload(W, FADED_PNG))).body.photo;
    await json(await upload(W, SEPIA_PNG));
    const c = (await json(await call(W, "/posters", { method: "POST", json: { photoId: onCard.id, spec: { name: "Five", message: "Love you" } } }))).body.poster;
    const r = await json(await call(W, "/posters/consent", { method: "DELETE" }));
    assert.deepStrictEqual(r.body, { accepted: false, photosRemoved: 2 });
    assert.deepStrictEqual(await store.photoIdsOf(W), []);
    const dir = path.join(FILES, String(W), "posters");
    assert.deepStrictEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], "no photo files left");
    const after = (await json(await call(W, `/posters/${c.id}`))).body.poster;
    assert.strictEqual(after.photo, null);
    assert.strictEqual(after.spec.message, "Love you");
  });

  await atest("the card's photo colour is ONE versioned edit, undone like any other; each colour its own URL", async () => {
    // Stand-in clean-up (the colour written into the bytes), so this runs
    // the same on a box without ffmpeg.
    const realRe = enhance.reenhance;
    enhance.reenhance = async (_buf, colour) => ({ buffer: Buffer.from(`clean-${colour}`), width: 1, height: 1 });
    try {
      const P = (await json(await upload(U, FADED_PNG))).body.photo;
      let card = (await json(await call(U, "/posters", { method: "POST", json: { photoId: P.id, spec: { name: "Six" } } }))).body.poster;
      assert.strictEqual(card.spec.photoColour, "keep");
      const patch = async (change) => {
        const r = await json(await call(U, `/posters/${card.id}`, { method: "PATCH", json: { version: card.version, change } }));
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        card = r.body.poster;
        return card;
      };
      await patch({ colour: "blue" });
      const v = card.version;
      await patch({ photoColour: "bw", photoUse: "enhanced" });
      assert.strictEqual(card.version, v + 1, "a colour change is a versioned edit");
      assert.strictEqual(card.spec.photoColour, "bw");
      assert.strictEqual(card.photo.colour, "keep", "the photo is not rewritten behind the card");
      const bw = Buffer.from(await (await call(U, `/posters/photos/${P.id}/file?v=enhanced&colour=bw`)).arrayBuffer());
      assert.strictEqual(bw.toString(), "clean-bw");
      const keep = await call(U, `/posters/photos/${P.id}/file?v=enhanced&colour=keep`);
      assert.strictEqual(keep.status, 200);
      assert.notStrictEqual(Buffer.from(await keep.arrayBuffer()).toString(), "clean-bw", "each colour is its own file");
      // A final picture drawn before the colour change is stale now.
      assert.strictEqual((await finalCard(U, card.id, pngOf(1080, 1350, () => [240, 240, 240]), v)).status, 409);
      await patch({ undo: true });
      assert.strictEqual(card.spec.photoColour, "keep", "undo takes the colour back — not the step before it");
      assert.strictEqual(card.spec.colour, "blue");
      await patch({ undo: true });
      assert.strictEqual(card.spec.colour, "pink");
      const bad = await json(await call(U, `/posters/${card.id}`, { method: "PATCH", json: { version: card.version, change: { photoColour: "rainbow" } } }));
      assert.strictEqual(bad.status, 400);
      await call(U, `/posters/${card.id}`, { method: "DELETE" });
    } finally {
      enhance.reenhance = realRe;
    }
  });

  await atest("two final saves at once leave exactly one copy of the card in his documents", async () => {
    const c = (await json(await call(U, "/posters", { method: "POST", json: { spec: { name: "Seven" } } }))).body.poster;
    const png = pngOf(1080, 1350, () => [250, 230, 235]);
    const before = await count("documents", U);
    for (let round = 0; round < 3; round++) {
      const rs = await Promise.all([0, 1, 2].map(() => finalCard(U, c.id, png, c.version).then(json)));
      for (const r of rs) assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      assert.strictEqual(await count("documents", U), before + 1, `round ${round}: no orphaned copy`);
      const now = (await json(await call(U, `/posters/${c.id}`))).body.poster;
      assert.ok(await docs.getDocument(U, now.finalDocumentId), "the card points at the copy that is left");
    }
    await call(U, `/posters/${c.id}`, { method: "DELETE" });
  });

  await atest("the routes are mounted with their OWN limiter, never the shared voice bucket", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
    assert.match(src, /app\.use\("\/posters", appAuth, posterLimit, require\("\.\/routes\/posters"\)\)/);
    assert.match(src, /const posterLimit = rateLimit\(\{\s*windowMs: 60_000,\s*max: 120,/);
    assert.match(src, /require\("\.\/posters\/service"\)\.sweep\(\)/, "the daily sweep runs");
  });

  /* ================================================================ */
  console.log("\nerase and the 30-day sweep");

  await atest("deleting the account takes the cards, photos, consent and the files", async () => {
    await call(E, "/posters/consent", { method: "POST" });
    const ph = (await json(await upload(E, FADED_PNG))).body.photo;
    const c = (await json(await call(E, "/posters", { method: "POST", json: { photoId: ph.id, spec: { name: "Esha" } } }))).body.poster;
    await finalCard(E, c.id, pngOf(1080, 1350, () => [240, 240, 240]), c.version);
    assert.ok(fs.existsSync(path.join(FILES, String(E), "posters", String(ph.id))));
    for (const t of ["posters", "poster_photos", "poster_consent"]) assert.ok((await count(t, E)) > 0, t);
    const priv = require("../src/routes/privacy");
    for (const t of ["posters", "poster_photos", "poster_consent"]) {
      assert.ok(priv.USER_TABLES.some(([n, col]) => n === t && col === "user_id"), `${t} is not erased`);
    }
    await priv.deleteUserEverywhere(E, { reason: "test" });
    for (const t of ["posters", "poster_photos", "poster_consent", "documents"]) {
      assert.strictEqual(await count(t, E), 0, `${t} kept rows`);
    }
    assert.ok(!fs.existsSync(path.join(FILES, String(E))), "files/<uid> (and posters/ inside it) is gone");
  });

  await atest("the sweep removes cards and photos untouched for 30 days, and stray folders — nothing fresh", async () => {
    const oldPh = (await json(await upload(V, FADED_PNG))).body.photo;
    const oldCard = (await json(await call(V, "/posters", { method: "POST", json: { photoId: oldPh.id, spec: { name: "Old" } } }))).body.poster;
    const loosePh = (await json(await upload(V, FADED_PNG))).body.photo;
    const freshPh = (await json(await upload(V, FADED_PNG))).body.photo;
    const freshCard = (await json(await call(V, "/posters", { method: "POST", json: { photoId: freshPh.id, spec: { name: "New" } } }))).body.poster;
    const old = Date.now() - 31 * 24 * 3600_000;
    await db.run("UPDATE posters SET updated_at = $1 WHERE id = $2", [old, oldCard.id]);
    await db.run("UPDATE poster_photos SET last_used_at = $1 WHERE id = ANY($2::bigint[])", [old, [oldPh.id, loosePh.id]]);
    const stray = path.join(FILES, String(V), "posters", "987654321");
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, "original.jpg"), "x");
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(stray, twoHoursAgo, twoHoursAgo);
    const newStray = path.join(FILES, String(V), "posters", "987654322");
    fs.mkdirSync(newStray, { recursive: true });

    const r = await svc.sweep();
    assert.ok(r.posters >= 1 && r.photos >= 2 && r.folders >= 1, JSON.stringify(r));
    assert.strictEqual(await store.getPoster(V, oldCard.id), null);
    assert.strictEqual(await store.getPhoto(V, oldPh.id), null, "the old card's photo went with it");
    assert.strictEqual(await store.getPhoto(V, loosePh.id), null);
    assert.ok(!fs.existsSync(path.join(FILES, String(V), "posters", String(oldPh.id))));
    assert.ok(!fs.existsSync(stray), "a folder no row owns is removed");
    assert.ok(fs.existsSync(newStray), "one written this hour may be an upload in progress");
    assert.ok(await store.getPoster(V, freshCard.id), "a card in use stays");
    assert.ok(fs.existsSync(path.join(FILES, String(V), "posters", String(freshPh.id))));
    assert.strictEqual(svc.retentionDays(), 30);
  });

  /* ================================================================ */
  console.log("\nby voice: the tools, gated on app build 119");

  const registry = require("../src/tools/registry");
  require("../src/tools/builtins").registerBuiltins();
  const tools = require("../src/posters/tools");
  const NAMES = ["make_greeting_poster", "change_poster", "share_poster", "improve_old_photo"];
  // These cases are the card maker itself, so the user asks for it (2026-10-02:
  // without that, a card goes straight to the image model — tested below).
  const ctx = { userId: T, appBuild: 119, source: "live", userText: "make it in the card maker" };
  const tool = (n) => registry.get(n);

  await atest("a plain card request goes straight to the image model with the exact words (2026-10-02)", async () => {
    const gen = tool("generate_image");
    const real = gen.execute;
    let seen = null;
    gen.execute = async (args) => { seen = args; return { ok: true, data: { generated: true } }; };
    try {
      const r = await tool("make_greeting_poster").execute(
        { occasion: "birthday", name: "Ravi", message: "Have a wonderful year", from: "Amma" },
        { ...ctx, userText: "make a birthday card for Ravi" });
      assert.ok(r.ok && r.data.generated, JSON.stringify(r));
      assert.match(seen.prompt, /"Happy Birthday"[\s\S]*"Ravi"[\s\S]*"Have a wonderful year"[\s\S]*"— Amma"/);
      assert.strictEqual(seen._raw, true, "the quoted words are not rewritten by the prompt writer");
      seen = null;
      await tool("make_greeting_poster").execute({ name: "Ravi" }, { ...ctx, userText: "make a card for Ravi with his photo" });
      assert.strictEqual(seen, null, "their own photo: the card maker, not the image model");
    } finally {
      gen.execute = real;
    }
  });

  await atest("the four tools exist, need build 119, and an older app is offered none of them", () => {
    assert.strictEqual(tools.POSTER_MIN_BUILD, 119);
    for (const n of NAMES) {
      assert.ok(tool(n), n);
      assert.strictEqual(tool(n).minAppBuild, 119, n);
      assert.strictEqual(tool(n).deviceAction, true, n);
      // change_poster only edits the undoable draft on his screen: not a
      // world action, so one-word answers reach it (review, 2026-09-26).
      assert.strictEqual(registry.isWorldAction(n), n !== "change_poster", `${n} world action`);
    }
    assert.strictEqual(registry.isDraftEdit(tool("make_greeting_poster"), { poster_id: 5 }), true);
    assert.strictEqual(registry.isDraftEdit(tool("make_greeting_poster"), { name: "Ananya" }), false, "a NEW card is not a draft edit");
    assert.strictEqual(registry.isDraftEdit(tool("share_poster"), { poster_id: 5 }), false);
    const offered = (build) => registry.declarations({ userId: T, deviceCaps: { build, granted: [], denied: [] } })
      .map((d) => d.name);
    for (const n of NAMES) {
      assert.ok(!offered(118).includes(n), `${n} offered to build 118`);
      assert.ok(offered(119).includes(n), `${n} missing on build 119`);
    }
    assert.ok(offered(118).includes("generate_image"), "an older app keeps today's generate_image");
  });

  await atest("an older app that calls one anyway is told to update — nothing made", async () => {
    const before = await count("posters", T);
    for (const n of NAMES) {
      const r = await tool(n).execute({ name: "Ananya" }, { ...ctx, appBuild: 118 });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, "app_too_old");
      assert.ok(!r.deviceAction);
    }
    assert.strictEqual(await count("posters", T), before);
  });

  let tcard;
  await atest("make_greeting_poster, new card: the picker opens first and NOTHING is claimed", async () => {
    const r = await tool("make_greeting_poster").execute(
      { occasion: "birthday", for_whom: "my daughter", signature: true }, ctx);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.deviceAction.type, "poster_pick_photo");
    assert.strictEqual(r.deviceAction.purpose, "poster");
    assert.strictEqual(r.deviceAction.source, "ask");
    assert.ok(Number.isInteger(r.deviceAction.poster_id));
    assert.deepStrictEqual(r.data.missing, ["name", "age", "message", "from"]);
    assert.match(r.note, /NOTHING is made yet/);
    assert.ok(!r.speak, "speak would hide data from the classic path");
    tcard = r.deviceAction.poster_id;
    const row = await store.getPoster(T, tcard);
    assert.strictEqual(row.spec.forWhom, "my daughter");
    assert.strictEqual(row.spec.signature, true);
  });

  await atest("the photo arrives, then the words: the card is shown, read back and spelled", async () => {
    const up = await json(await upload(T, FADED_PNG, { fields: { posterId: tcard, source: "gallery" } }));
    assert.strictEqual(up.status, 201);
    const r = await tool("make_greeting_poster").execute({
      poster_id: tcard, name: "Ananya", age: 25,
      message: "Wishing you a year full of joy.\nWe are so proud of you.", from: "Appa",
    }, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.deviceAction.type, "poster_show");
    assert.strictEqual(r.deviceAction.mode, "poster");
    assert.strictEqual(r.deviceAction.poster.id, tcard);
    assert.ok(r.deviceAction.poster.photo, "the photo stays on the card");
    assert.deepStrictEqual(r.data.words, ["Happy 25th Birthday", "Ananya", "Wishing you a year full of joy.",
      "We are so proud of you.", "Appa"]);
    assert.strictEqual(r.data.spell, "A-N-A-N-Y-A");
    assert.match(r.note, /ON THE SCREEN/);
    assert.match(r.note, /A-N-A-N-Y-A/);
    assert.match(r.note, /Never say the card is made/);
  });

  await atest("photo 'none' with a name shows the card at once; no name asks ONE question and shows nothing", async () => {
    const r = await tool("make_greeting_poster").execute(
      { occasion: "anniversary", name: "അമ്മയും അച്ഛനും", photo: "none", colour: "red" }, ctx);
    assert.strictEqual(r.deviceAction.type, "poster_show");
    assert.strictEqual(r.data.spell, null, "a Malayalam name is read slowly, not spelled");
    assert.strictEqual(r.deviceAction.poster.spec.colour, "pink");
    assert.strictEqual(r.deviceAction.poster.photo, null);
    const ask = await tool("make_greeting_poster").execute({ occasion: "birthday", photo: "none" }, ctx);
    assert.strictEqual(ask.ok, true);
    assert.ok(!ask.deviceAction);
    assert.match(ask.note, /Ask ONE short question/);
    // Continuing a card they said should have no photo never reopens the picker.
    const cont = await tool("make_greeting_poster").execute({ poster_id: ask.data.poster_id, name: "Kiran" }, ctx);
    assert.strictEqual(cont.deviceAction.type, "poster_show");
  });

  await atest("too long is refused with a question and no card is made; an unknown colour is asked about", async () => {
    const before = await count("posters", T);
    const r = await tool("make_greeting_poster").execute({ name: "Ananya", message: "x".repeat(301), photo: "none" }, ctx);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "too_long");
    assert.deepStrictEqual({ field: r.data.field, max: r.data.max }, { field: "message", max: 300 });
    assert.match(r.note, /Nothing was made/);
    assert.match(r.note, /never cut it yourself/);
    assert.strictEqual(await count("posters", T), before);
    const c = await tool("make_greeting_poster").execute({ name: "Ananya", colour: "turquoise sparkle", photo: "none" }, ctx);
    assert.strictEqual(c.error, "unknown_colour");
    assert.strictEqual(await count("posters", T), before);
  });

  await atest("make_greeting_poster with a saved photo (document_id) puts it straight on the card", async () => {
    const d = await docs.createDocument(T, { buffer: FADED_PNG, filename: "old.png", mime: "image/png" });
    const r = await tool("make_greeting_poster").execute({ name: "Devi", document_id: d.id }, ctx);
    assert.strictEqual(r.deviceAction.type, "poster_show");
    assert.ok(r.deviceAction.poster.photo);
    assert.strictEqual(r.deviceAction.poster.photo.source, "document");
  });

  await atest("change_poster: no arguments reopens the latest; bigger/pink/next design/undo edit it", async () => {
    // The Ananya card was edited last among these? Make it the latest.
    await svc.patchPoster(T, tcard, { change: { set: { date: "" } } });
    await db.run("UPDATE posters SET updated_at = $1 WHERE id = $2", [Date.now() + 1000, tcard]);
    let r = await tool("change_poster").execute({}, ctx);
    assert.strictEqual(r.deviceAction.type, "poster_show");
    assert.strictEqual(r.deviceAction.poster.id, tcard);
    const v0 = r.deviceAction.poster.version;
    r = await tool("change_poster").execute({ text_size: "bigger" }, ctx);
    assert.strictEqual(r.data.text_scale, 1.15);
    assert.strictEqual(r.deviceAction.poster.version, v0 + 1);
    r = await tool("change_poster").execute({ colour: "rose" }, ctx);
    assert.strictEqual(r.data.colour, "pink");
    const d0 = r.deviceAction.poster.spec.design;
    r = await tool("change_poster").execute({ design: "next" }, ctx);
    assert.notStrictEqual(r.deviceAction.poster.spec.design, d0);
    assert.strictEqual(r.deviceAction.poster.spec.colour, "pink", "his colour stays with the new design");
    r = await tool("change_poster").execute({ design: "the mandala one" }, ctx);
    assert.strictEqual(r.deviceAction.poster.spec.design, "royal_mandala");
    r = await tool("change_poster").execute({ undo: true }, ctx);
    assert.strictEqual(r.deviceAction.poster.spec.design, S.nextDesign(d0));
    r = await tool("change_poster").execute({ name: "Ananyaa" }, ctx);
    assert.strictEqual(r.data.spell, "A-N-A-N-Y-A-A");
    assert.match(r.note, /read the changed words back exactly/);
    r = await tool("change_poster").execute({ format: "story" }, ctx);
    assert.strictEqual(r.deviceAction.poster.spec.format, "story");
    const bad = await tool("change_poster").execute({ design: "zebra stripes" }, ctx);
    assert.strictEqual(bad.error, "unknown_design");
  });

  await atest("change_poster: bigger at the top says so honestly; signature on/off/redo; another photo", async () => {
    let r;
    for (let i = 0; i < 6; i++) r = await tool("change_poster").execute({ text_size: "bigger" }, ctx);
    assert.strictEqual(r.data.limit_reached, true);
    assert.strictEqual(r.data.text_scale, 1.6);
    assert.match(r.note, /already as big/);
    r = await tool("change_poster").execute({ signature: "off" }, ctx);
    assert.strictEqual(r.deviceAction.poster.spec.signature, false);
    r = await tool("change_poster").execute({ signature: "on" }, ctx);
    assert.strictEqual(r.deviceAction.poster.spec.signature, true);
    r = await tool("change_poster").execute({ signature: "redo" }, ctx);
    assert.deepStrictEqual(r.deviceAction, { type: "poster_sign", poster_id: tcard });
    r = await tool("change_poster").execute({ photo: "pick" }, ctx);
    assert.strictEqual(r.deviceAction.type, "poster_pick_photo");
    assert.strictEqual(r.deviceAction.poster_id, tcard);
    r = await tool("change_poster").execute({ photo: "original" }, ctx);
    assert.strictEqual(r.deviceAction.poster.spec.photoUse, "original");
    const before = r.deviceAction.poster;
    r = await tool("change_poster").execute({ photo_colour: "bw" }, ctx);
    if (HAVE_FFMPEG) {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.deviceAction.poster.spec.photoColour, "bw", "the colour is part of the card");
      assert.strictEqual(r.deviceAction.poster.photo.colour, "keep", "the photo itself is not rewritten");
      assert.strictEqual(r.deviceAction.poster.spec.photoUse, "enhanced");
      assert.strictEqual(r.deviceAction.poster.version, before.version + 1, "a versioned edit");
      assert.strictEqual(r.data.photo_colour, "bw");
      const u = await tool("change_poster").execute({ undo: true }, ctx);
      assert.strictEqual(u.deviceAction.poster.spec.photoColour, before.spec.photoColour, "undo takes it back");
      assert.strictEqual(u.deviceAction.poster.spec.photoUse, "original");
    } else {
      assert.strictEqual(r.ok, false, "no ffmpeg: said honestly, nothing claimed");
      assert.strictEqual(r.data.code, "unavailable");
      assert.strictEqual((await svc.getPoster(T, tcard)).version, before.version, "nothing changed");
    }
  });

  await atest("change_poster with no card, and undo with nothing left, are said honestly", async () => {
    const lonely = await mk("lonely");
    USERS.push(lonely);
    const r = await tool("change_poster").execute({ colour: "pink" }, { ...ctx, userId: lonely });
    assert.strictEqual(r.error, "no_poster");
    const s = await tool("share_poster").execute({}, { ...ctx, userId: lonely });
    assert.strictEqual(s.error, "no_poster");
    const made = await tool("make_greeting_poster").execute({ name: "Solo", photo: "none" }, { ...ctx, userId: lonely });
    assert.strictEqual(made.deviceAction.type, "poster_show");
    const u = await tool("change_poster").execute({ undo: true }, { ...ctx, userId: lonely });
    assert.strictEqual(u.error, "nothing_to_undo");
  });

  await atest("share_poster opens WhatsApp WITH the card — and never says it was sent", async () => {
    const r = await tool("share_poster").execute({}, ctx);
    assert.deepStrictEqual(r.deviceAction, { type: "poster_share", poster_id: tcard, app: "whatsapp", save_to_photos: false });
    assert.match(r.note, /presses Send/);
    assert.match(r.note, /Never say it was sent/);
    const any = await tool("share_poster").execute({ app: "any", save_to_photos: true }, ctx);
    assert.strictEqual(any.deviceAction.app, "any");
    assert.strictEqual(any.deviceAction.save_to_photos, true);
  });

  await atest("improve_old_photo: the picker without a document; a saved photo is cleaned and shown beside the original", async () => {
    const r = await tool("improve_old_photo").execute({ source: "camera" }, ctx);
    assert.deepStrictEqual(r.deviceAction, { type: "poster_pick_photo", purpose: "photo", poster_id: null, source: "camera", colour: "keep" });
    assert.match(r.note, /NOTHING is done yet/);
    const d = await docs.createDocument(T, { buffer: FADED_PNG, filename: "grandpa.png", mime: "image/png" });
    const s = await tool("improve_old_photo").execute({ document_id: d.id }, ctx);
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.deviceAction.type, "poster_show");
    assert.strictEqual(s.deviceAction.mode, "photo");
    assert.strictEqual(s.deviceAction.photo.source, "document");
    assert.strictEqual(s.data.cleaned, HAVE_FFMPEG);
    assert.match(s.note, /never (say it was restored|blame the photo)/);
    const pdf = await docs.createDocument(T, { buffer: Buffer.from("%PDF-1.4"), filename: "x.pdf", mime: "application/pdf" });
    const no = await tool("improve_old_photo").execute({ document_id: pdf.id }, ctx);
    assert.strictEqual(no.ok, false);
    assert.strictEqual(no.data.code, "unsupported_type");
  });

  await atest("try_a_look(restore) on build 119 points at improve_old_photo and never edits his selfie", async () => {
    const run = require("../src/studio/run");
    const real = run.runRecipe;
    let calls = 0;
    run.runRecipe = async () => { calls++; throw Object.assign(new Error("add a photo first"), { code: "no_model_photo" }); };
    try {
      const r = await tool("try_a_look").execute({ recipe: "restore" }, ctx);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, "use_improve_old_photo");
      assert.strictEqual(calls, 0, "runRecipe ran on the user's own saved photo");
      const old = await tool("try_a_look").execute({ recipe: "restore" }, { ...ctx, appBuild: 118 });
      assert.strictEqual(calls, 1, "an older app keeps today's behaviour");
      assert.strictEqual(old.data.code, "no_model_photo");
      await tool("try_a_look").execute({ recipe: "hair", style: "a bob" }, ctx);
      assert.strictEqual(calls, 2, "other looks are untouched");
    } finally {
      run.runRecipe = real;
    }
  });

  await atest("descriptions route a card with a real photo away from generate_image", () => {
    const gi = tool("generate_image").description;
    assert.match(gi, /make_greeting_poster whenever that tool is offered/);
    assert.match(gi, /invent a stranger's\s+face/);
    const tl = tool("try_a_look").description;
    assert.match(tl, /improve_old_photo/);
    assert.doesNotMatch(tl, /restore this old photo of my father/);
    assert.match(tool("make_greeting_poster").description, /NEVER generate_image/);
    for (const d of S.DESIGNS) assert.ok(tool("make_greeting_poster").description.includes(d.id));
    assert.match(tool("improve_old_photo").description, /NOT a repair/);
    const picked = require("../src/tools/relevance").selectForTurn(registry.list(),
      "make a birthday card for my daughter with her old photo and my signature", { sessionId: `rel-${stamp}` });
    assert.ok(picked === null || picked.includes("make_greeting_poster"), "the relevance filter keeps the card tool");
  });

  await atest("a stutter does not start two cards; 'bigger' twice is two steps", async () => {
    const session = { executed: [] };
    const c = { ...ctx, session, turnId: `t-${stamp}` };
    const a = await registry.execute("make_greeting_poster", { name: "Twin", photo: "none" }, c);
    const b = await registry.execute("make_greeting_poster", { name: "Twin", photo: "none" }, c);
    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.repeated, true, "the second identical call was run again");
    const x = await registry.execute("change_poster", { text_size: "bigger" }, c);
    const y = await registry.execute("change_poster", { text_size: "bigger" }, c);
    assert.ok(!y.repeated);
    assert.strictEqual(y.data.text_scale, round2(x.data.text_scale + 0.15));
  });

  /* ---- review fixes, 2026-09-26 ---- */

  const iq = require("../src/agents/inputQuality");
  await atest("one-word answers reach the card on a weak turn — 'Ananya', 'അനന്യ', 'Bigger', '25' — never a new card, a share, or noise", async () => {
    const session = { executed: [] };
    const base = { ...ctx, session, turnId: `g-${stamp}`, approved: false };
    const started = await registry.execute("make_greeting_poster", { name: "Gate", photo: "none" },
      { ...base, inputQuality: iq.assess("make a birthday card for my daughter") });
    assert.strictEqual(started.ok, true, JSON.stringify(started));
    const pid = started.data.poster_id;
    for (const word of ["അനന്യ", "Ananya"]) {
      const q = { ...iq.assess(word), heard: word };
      assert.strictEqual(q.quality, "weak", word);
      const r = await registry.execute("make_greeting_poster", { poster_id: pid, name: word }, { ...base, inputQuality: q });
      assert.strictEqual(r.ok, true, `${word}: ${JSON.stringify(r)}`);
      assert.strictEqual(r.deviceAction.poster.spec.name, word);
    }
    for (const [word, args] of [["Bigger", { text_size: "bigger" }], ["Smaller", { text_size: "smaller" }], ["balloons", { design: "balloons" }]]) {
      const q = iq.assess(word);
      assert.strictEqual(q.quality, "weak", word);
      const r = await registry.execute("change_poster", { poster_id: pid, ...args }, { ...base, inputQuality: q });
      assert.strictEqual(r.ok, true, `${word}: ${JSON.stringify(r)}`);
    }
    // "How old is she turning?" — "25" is an answer, not noise.
    const age = iq.assess("25", iq.expectationsFrom("How old is she turning?"));
    assert.strictEqual(age.quality, "clear");
    const aged = await registry.execute("make_greeting_poster", { poster_id: pid, age: 25 }, { ...base, inputQuality: age });
    assert.strictEqual(aged.deviceAction.poster.spec.headline, "Happy 25th Birthday");
    // Still refused on a weak turn: a NEW card and a share; anything garbled.
    const weak = iq.assess("Ananya");
    assert.strictEqual((await registry.execute("make_greeting_poster", { name: "Ananya", photo: "none" },
      { ...base, inputQuality: weak })).error, "unclear_request", "a new card is not an answer");
    assert.strictEqual((await registry.execute("share_poster", { poster_id: pid },
      { ...base, inputQuality: iq.assess("WhatsApp") })).error, "unclear_request", "opening WhatsApp is an act on the world");
    assert.strictEqual((await registry.execute("make_greeting_poster", { poster_id: pid, name: "Con" },
      { ...base, inputQuality: iq.assess("con") })).error, "unclear_request", "noise never edits the card");
  });

  await atest("'make it without a photo' right after the picker opened is the card's next step, not a stutter", async () => {
    const session = { executed: [] };
    const c = { ...ctx, session, turnId: `r1-${stamp}` };
    const first = await registry.execute("make_greeting_poster", { name: "Ananya" }, c);
    assert.strictEqual(first.deviceAction.type, "poster_pick_photo");
    const next = await registry.execute("make_greeting_poster",
      { poster_id: first.data.poster_id, name: "Ananya", photo: "none" }, { ...c, turnId: `r2-${stamp}` });
    assert.ok(!next.repeated, JSON.stringify(next));
    assert.strictEqual(next.deviceAction.type, "poster_show", "the card is shown");
    const twin = await registry.execute("make_greeting_poster", { name: "Ananya" }, c);
    assert.strictEqual(twin.repeated, true, "a stutter of the call that STARTED a card is still caught");
  });

  await atest("lines come off by voice: the heading back to the card's own, the date, the 'from', the age — never the name", async () => {
    const made = await tool("make_greeting_poster").execute(
      { name: "Lines", age: 30, headline: "Many happy returns", date: "26 Sep 2026", from: "Appa", message: "", photo: "none" }, ctx);
    const pid = made.data.poster_id;
    assert.strictEqual(made.deviceAction.poster.spec.headline, "Many happy returns");
    let r = await tool("change_poster").execute({ poster_id: pid, headline: "" }, ctx);
    assert.strictEqual(r.deviceAction.poster.spec.headline, "Happy 30th Birthday", "the card's own heading again");
    assert.match(r.note, /The change is on the screen/);
    r = await tool("change_poster").execute({ poster_id: pid, date: "" }, ctx);
    assert.strictEqual(r.deviceAction.poster.spec.date, "");
    r = await tool("change_poster").execute({ poster_id: pid, from: "  " }, ctx);
    assert.strictEqual(r.deviceAction.poster.spec.from, "");
    // Through the registry: coerceArgs turns a null age into 0.
    r = await registry.execute("change_poster", { poster_id: pid, age: null }, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.deviceAction.poster.spec.age, null, "the age is taken off, not 'check the age'");
    assert.strictEqual(r.deviceAction.poster.spec.headline, "Happy Birthday");
    r = await tool("change_poster").execute({ poster_id: pid, name: "" }, ctx);
    assert.strictEqual(r.deviceAction.poster.spec.name, "Lines", "the name is never blanked");
    await tool("make_greeting_poster").execute({ poster_id: pid, headline: "Hello" }, ctx);
    r = await tool("make_greeting_poster").execute({ poster_id: pid, headline: "" }, ctx);
    assert.strictEqual(r.deviceAction.poster.spec.headline, "Happy Birthday", "continuing a card takes lines off too");
    const fresh = await tool("make_greeting_poster").execute({ name: "Fresh", date: "", age: 0, photo: "none" }, ctx);
    assert.strictEqual(fresh.ok, true, "a new card has nothing to take off: empty words are ignored");
    assert.strictEqual(fresh.deviceAction.poster.spec.age, null);
  });

  await atest("'keep the clearer one' and 'make a card with it' work by voice, by photo_id — no second picker", async () => {
    const d = await docs.createDocument(T, { buffer: FADED_PNG, filename: "nani.png", mime: "image/png" });
    const shown = await tool("improve_old_photo").execute({ document_id: d.id }, ctx);
    const pid = shown.data.photo_id;
    if (HAVE_FFMPEG) {
      assert.match(shown.note, new RegExp(`photo_id ${pid}`), "the model has the id");
      assert.match(shown.note, /make_greeting_poster with this photo_id/);
    }
    const again = await tool("improve_old_photo").execute({ photo_id: pid }, ctx);
    assert.deepStrictEqual(again.deviceAction && again.deviceAction.mode, "photo");
    const v = HAVE_FFMPEG ? "enhanced" : "original";
    const before = await count("documents", T);
    const kept = await tool("improve_old_photo").execute({ photo_id: pid, keep: v }, ctx);
    assert.strictEqual(kept.ok, true, JSON.stringify(kept));
    assert.strictEqual(await count("documents", T), before + 1);
    assert.strictEqual(kept.data.document_id > 0, true);
    assert.ok(!kept.deviceAction);
    assert.strictEqual(require("../src/agents/claimCheck").check("I've saved the clearer photo to your documents.",
      [{ tool: "improve_old_photo", ok: true }]).ok, true, "the keep is backed");
    const card = await tool("make_greeting_poster").execute({ name: "Nani", photo_id: pid }, ctx);
    assert.strictEqual(card.deviceAction.type, "poster_show", "no picker: the photo is already on the card");
    assert.strictEqual(card.deviceAction.poster.photo.id, pid);
    const other = (await json(await upload(T, SEPIA_PNG))).body.photo;
    const swapped = await tool("change_poster").execute({ poster_id: card.data.poster_id, photo_id: other.id }, ctx);
    assert.strictEqual(swapped.deviceAction.poster.photo.id, other.id);
    const theirs = (await json(await upload(V, FADED_PNG))).body.photo;
    const no = await tool("make_greeting_poster").execute({ name: "X", photo_id: theirs.id }, ctx);
    assert.strictEqual(no.ok, false, "somebody else's photo never goes on his card");
    assert.strictEqual(no.data.code, "not_found");
    const schema = (n) => Object.keys(tool(n).inputSchema.properties);
    assert.ok(schema("make_greeting_poster").includes("photo_id"));
    assert.ok(schema("change_poster").includes("photo_id"));
    assert.ok(schema("improve_old_photo").includes("keep"));
  });

  await atest("the tool contract seals with no drift, and every tool sits in a claim family", () => {
    const sealed = registry.seal();
    assert.deepStrictEqual(sealed.phantoms, []);
    const { FAMILIES } = require("../src/agents/claimCheck");
    for (const n of NAMES) {
      assert.ok(FAMILIES.some((f) => f.tools.includes(n)), `${n} is in no claim family`);
    }
    assert.ok(FAMILIES.find((f) => f.id === "open").tools.includes("share_poster"));
    assert.ok(FAMILIES.find((f) => f.id === "create").tools.includes("make_greeting_poster"));
  });

  /* ================================================================ */
  console.log("\nwhat the assistant may say");

  const claimCheck = require("../src/agents/claimCheck");
  await atest("the [SYSTEM]-led sentences are never rewritten; 'I've made the card' with no tool IS", () => {
    for (const s of [
      "It's on your screen now. It says Happy 25th Birthday, Ananya — A-N-A-N-Y-A. Is that right?",
      "The card is on the screen with her photo. Shall I read the words?",
      "The clearer photo is on your screen next to the original. Keep the clearer one?",
      "Let's choose the photo.",
      "Signature saved — it's on the card now.",
    ]) {
      const v = claimCheck.check(s, []);
      assert.strictEqual(v.ok, true, `${s} → ${v.text}`);
    }
    for (const s of ["I've made the poster for Ananya.", "I've made the card for Ananya.", "Your card is ready."]) {
      const v = claimCheck.check(s, []);
      assert.strictEqual(v.ok, false, s);
    }
    assert.strictEqual(claimCheck.check("I've made the card for Ananya.", [{ tool: "make_greeting_poster", ok: true }]).ok, true);
    // A business card is not a greeting card.
    assert.strictEqual(claimCheck.check("Done — the business card details are in your contacts.", [{ tool: "scan_business_card", ok: true }]).ok, true);
  });

  await atest("'sent' after share_poster becomes the truth: the card is open to share, he presses Send", () => {
    const v = claimCheck.check("Sent! The card is on its way to Ananya.", [{ tool: "share_poster", ok: true }]);
    assert.strictEqual(v.ok, false);
    assert.match(v.text, /open to share — pick the person and press Send/);
    assert.strictEqual(claimCheck.check("Opening WhatsApp with the card.", [{ tool: "share_poster", ok: true }]).ok, true);
    // Nothing shared and nothing run: the old honest line.
    assert.match(claimCheck.check("I've sent it.", []).text, /haven't sent anything/);
  });

  // Review, 2026-09-26: true sentences about the card were rewritten into
  // "I couldn't create that file — nothing was saved".
  await atest("a card saved and shared, and the app's own card lines, are never turned into 'nothing was saved'", () => {
    const shared = [{ tool: "share_poster", ok: true }];
    for (const s of [
      "The card is saved in your documents, and WhatsApp is open for you to pick the person.",
      "Your card is ready in WhatsApp. Just pick her name and press Send.",
      "The card is saved to your documents.",
    ]) {
      const v = claimCheck.check(s, shared);
      assert.strictEqual(v.ok, true, `${s} → ${v.text}`);
    }
    const lines = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "tests", "fixtures", "posters", "contract.json"), "utf8")).systemLines;
    const fill = (l) => l.replace("{poster_id}", "12").replace("{photo_id}", "41").replace("{missing}", "age")
      .replace(/\{field_words\}/g, "the wishes");
    const vouch = (k) => claimCheck.appNoteVouches(fill(lines[k]));
    assert.deepStrictEqual(vouch("signature_saved"), ["change_poster"]);
    assert.deepStrictEqual(vouch("photo_added_missing"), ["change_poster"]);
    assert.deepStrictEqual(vouch("photo_added_complete"), ["change_poster"]);
    assert.deepStrictEqual(vouch("photo_shown"), ["improve_old_photo"]);
    assert.deepStrictEqual(vouch("shared"), ["share_poster"]);
    assert.deepStrictEqual(vouch("share_fallback"), ["share_poster"]);
    assert.deepStrictEqual(vouch("picker_closed"), [], "nothing was made: it vouches for nothing");
    assert.deepStrictEqual(vouch("too_long_on_card"), []);
    assert.deepStrictEqual(claimCheck.appNoteVouches("Put it on the card now"), [], "only the app's [SYSTEM] lines");
    // The app's own failure lines (build 119's PosterLines) vouch for
    // nothing, even the one that names the card (integration check,
    // 2026-09-26).
    for (const l of [
      "[SYSTEM] ERROR: the photo on the card has not arrived on this phone yet, so nothing was sent. " +
        "Say so plainly and offer to try again in a moment.",
      "[SYSTEM] ERROR: that card could not be opened on this phone just now, so nothing was sent or " +
        "changed. Say so plainly and offer to try again.",
      "[SYSTEM] ERROR: the card could not be shared just now. Nothing was sent. Say so plainly and offer to try again.",
      "[SYSTEM] ERROR: that photo could not be used. Nothing was made. Ask him to pick another photo; " +
        "never say the photo was bad.",
    ]) {
      assert.deepStrictEqual(claimCheck.appNoteVouches(l), [], l);
    }

    // Through the session, as runtime.js and the live proxy file them.
    const sessionState = require("../src/agents/sessionState");
    const sid = `vouch-${stamp}`;
    const st = sessionState.begin(T, sid, { surface: "voice" });
    sessionState.beginTurn(st, { turnId: "v1", text: lines.signature_saved });
    for (const t of claimCheck.appNoteVouches(lines.signature_saved)) sessionState.noteVouched(st, { turnId: "v1", tool: t });
    for (const s of ["Done, your signature is on the card now.", "The photo is ready on the card."]) {
      const v = claimCheck.check(s, sessionState.executedThisTurn(st));
      assert.strictEqual(v.ok, true, `${s} → ${v.text}`);
    }
    assert.strictEqual(claimCheck.check("Done, your signature is on the card now.", []).ok, false,
      "with no app line behind it, the same words are still a false claim");
    sessionState.end(T, sid);
    const src = (f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
    assert.match(src("agents/runtime.js"), /claimCheck\.appNoteVouches\(userText\)/);
    assert.match(src("ai/context.js"), /claimCheck\.appNoteVouches\(text\)/);
    assert.match(src("agents/runtime.js"), /inputQuality\.expectationsFrom\(/);
    assert.match(src("ai/context.js"), /inputQuality\.expectationsFrom\(s\.lastReply\)/);
  });

  await atest("the prompt rule sits BEFORE 'CREATE IMAGES' on build 119, and is absent on 118", () => {
    const runtime = require("../src/agents/runtime");
    const p119 = runtime.systemPrompt("", { appBuild: 119 });
    const p118 = runtime.systemPrompt("", { appBuild: 118 });
    const i = p119.indexOf("make_greeting_poster");
    assert.ok(i > 0 && i < p119.indexOf("You can CREATE IMAGES"));
    assert.match(p119, /never say it was sent/);
    assert.match(p119, /spell the name letter by letter/);
    assert.ok(!p118.includes("make_greeting_poster"));
    assert.ok(!runtime.systemPrompt("").includes("make_greeting_poster"));
    const live = require("../src/ai/voicePrompt").voiceSystemPrompt;
    const l119 = live("Assistant", [], "", 330, "", "", 119);
    const l118 = live("Assistant", [], "", 330, "", "", 118);
    const j = l119.indexOf("make_greeting_poster");
    assert.ok(j > 0 && j < l119.indexOf("You can CREATE IMAGES"));
    assert.match(l119, /I press Send myself/);
    assert.ok(!l118.includes("make_greeting_poster"));
  });

  /* ================================================================ */
  console.log("\nthe shared contract: tests/fixtures/posters/contract.json");

  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "tests", "fixtures", "posters", "contract.json"), "utf8"));
  const keys = (o) => Object.keys(o).sort();

  await atest("the fixture's enums, limits, designs and headings are the server's", () => {
    assert.strictEqual(fixture.minAppBuild, tools.POSTER_MIN_BUILD);
    assert.deepStrictEqual(fixture.enums.occasion, S.OCCASIONS);
    assert.deepStrictEqual(fixture.enums.language, S.LANGUAGES);
    assert.deepStrictEqual(fixture.enums.colour, S.COLOURS);
    assert.deepStrictEqual(fixture.enums.design, S.DESIGN_IDS);
    assert.deepStrictEqual(fixture.enums.format, Object.keys(S.FORMATS));
    assert.deepStrictEqual(fixture.enums.photoUse, S.PHOTO_USES);
    assert.deepStrictEqual(fixture.enums.photoColour, S.PHOTO_COLOURS);
    assert.deepStrictEqual(fixture.headlines, S.HEADLINES);
    assert.deepStrictEqual(fixture.formats, S.FORMATS);
    assert.deepStrictEqual(fixture.textScale, S.TEXT_SCALE);
    assert.deepStrictEqual(fixture.designs, S.DESIGNS.map((d) => ({ id: d.id, label: d.label, defaultColour: d.colour })));
    for (const [k, v] of Object.entries(S.LIMITS)) assert.strictEqual(fixture.limits[k], v);
    for (const [word, c] of Object.entries(fixture.colourAliases)) assert.strictEqual(S.resolveColour(word), c, word);
    assert.strictEqual(fixture.examples.consent.text, svc.CONSENT_TEXT);
    assert.strictEqual(fixture.examples.consent.version, svc.CONSENT_VERSION);
  });

  await atest("every example object has exactly the keys the server sends", async () => {
    const live = (await json(await call(U, `/posters/${card.id}`))).body.poster;
    assert.deepStrictEqual(keys(fixture.examples.poster), keys(live));
    assert.deepStrictEqual(keys(fixture.examples.poster.spec), keys(live.spec));
    assert.deepStrictEqual(keys(fixture.examples.spec), keys(S.defaultSpec()));
    assert.deepStrictEqual(keys(fixture.examples.photo), keys(live.photo));
    assert.deepStrictEqual(keys(fixture.examples.poster_no_photo), keys(live));
    assert.strictEqual(fixture.examples.poster_no_photo.photo, null);
    assert.deepStrictEqual(keys(fixture.examples.consent), keys((await json(await call(U, "/posters/consent"))).body));
    const doc = docs.toClient(await docs.getDocument(U, card.finalDocumentId));
    assert.deepStrictEqual(keys(fixture.examples.final_response.document), keys(doc));
    assert.deepStrictEqual(keys(fixture.examples.keep_response.document), keys(doc));
    // The example words are what words() prints for the example specs.
    assert.deepStrictEqual(fixture.examples.words, S.words(fixture.examples.spec));
    assert.deepStrictEqual(fixture.examples.words_ml, S.words(fixture.examples.spec_ml));
    assert.strictEqual(fixture.examples.spell, S.spell(fixture.examples.spec.name));
    // Every example spec is a spec the server itself would produce.
    for (const k of ["spec", "spec_ml"]) {
      const s = fixture.examples[k];
      assert.deepStrictEqual(S.normalize({}, s).spec, s, `${k} is not normalised`);
    }
    // The error examples are the server's shapes.
    const need = await json(await call(U, `/posters/${card.id}`, { method: "PATCH",
      json: { version: card.version, change: { set: { message: "m".repeat(342) } } } }));
    assert.deepStrictEqual(need.body, fixture.examples.error_need);
    const conflict = await json(await call(U, `/posters/${card.id}`, { method: "PATCH", json: { version: 0, change: { colour: "pink" } } }));
    assert.deepStrictEqual(keys(conflict.body), keys(fixture.examples.error_version_conflict));
    assert.strictEqual(conflict.body.message, fixture.examples.error_version_conflict.message);
    const off = await json(await call(U, `/posters/photos/${photo1.id}/restore`, { method: "POST", json: {} }));
    assert.deepStrictEqual(off.body, fixture.examples.error_restore_off);
    // The example PATCH bodies are accepted by the server.
    const fresh = (await json(await call(U, "/posters", { method: "POST", json: {
      ...fixture.examples.create_request, photoId: photo1.id } }))).body.poster;
    const ok = await json(await call(U, `/posters/${fresh.id}`, { method: "PATCH", json: {
      ...fixture.examples.patch_request, version: fresh.version,
      change: { ...fixture.examples.patch_request.change, photoUse: HAVE_FFMPEG ? "enhanced" : "original" } } }));
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const undo = await json(await call(U, `/posters/${fresh.id}`, { method: "PATCH", json: { ...fixture.examples.patch_undo, version: ok.body.poster.version } }));
    assert.strictEqual(undo.status, 200);
    // The colour of the card's photo (stand-in clean-up, so no ffmpeg needed).
    const realRe = enhance.reenhance;
    enhance.reenhance = async (_b, colour) => ({ buffer: Buffer.from(`clean-${colour}`), width: 1, height: 1 });
    try {
      const pc = await json(await call(U, `/posters/${fresh.id}`, { method: "PATCH", json: {
        ...fixture.examples.patch_photo_colour, version: undo.body.poster.version } }));
      assert.strictEqual(pc.status, 200, JSON.stringify(pc.body));
      assert.strictEqual(pc.body.poster.spec.photoColour, fixture.examples.patch_photo_colour.change.photoColour);
    } finally {
      enhance.reenhance = realRe;
    }
    // Withdrawing, deleting a photo, and the two upload refusals.
    const X = await mk("x");
    USERS.push(X);
    const xp = (await json(await upload(X, FADED_PNG))).body.photo;
    const del = await json(await call(X, `/posters/photos/${xp.id}`, { method: "DELETE" }));
    assert.deepStrictEqual(keys(del.body), keys(fixture.examples.delete_photo_response));
    await upload(X, FADED_PNG);
    const wd = await json(await call(X, "/posters/consent", { method: "DELETE" }));
    assert.deepStrictEqual(keys(wd.body), keys(fixture.examples.consent_withdrawn));
    assert.deepStrictEqual((await json(await upload(X, pngHeaderOnly(16000, 16000)))).body, fixture.examples.error_too_many_pixels);
    assert.deepStrictEqual((await json(await upload(X, jpegHeaderOnly(640, 480), { type: "image/jpeg", name: "a.jpg" }))).body,
      fixture.examples.error_undecodable);
  });

  await atest("every deviceAction the tools send has exactly the fixture's keys", async () => {
    const acts = fixture.deviceActions;
    const pick = await tool("make_greeting_poster").execute({ occasion: "birthday" }, ctx);
    assert.deepStrictEqual(keys(pick.deviceAction), keys(acts.poster_pick_photo));
    const pickPhoto = await tool("improve_old_photo").execute({}, ctx);
    assert.deepStrictEqual(keys(pickPhoto.deviceAction), keys(acts.poster_pick_photo_for_photo));
    const show = await tool("change_poster").execute({ poster_id: tcard }, ctx);
    assert.deepStrictEqual(keys(show.deviceAction), keys(acts.poster_show));
    assert.deepStrictEqual(keys(show.deviceAction.poster), keys(acts.poster_show.poster));
    const d = await docs.createDocument(T, { buffer: FADED_PNG, filename: "p.png", mime: "image/png" });
    const showPhoto = await tool("improve_old_photo").execute({ document_id: d.id }, ctx);
    assert.deepStrictEqual(keys(showPhoto.deviceAction), keys(acts.poster_show_photo));
    assert.deepStrictEqual(keys(showPhoto.deviceAction.photo), keys(acts.poster_show_photo.photo));
    const share = await tool("share_poster").execute({ poster_id: tcard }, ctx);
    assert.deepStrictEqual(keys(share.deviceAction), keys(acts.poster_share));
    const sign = await tool("change_poster").execute({ poster_id: tcard, signature: "redo" }, ctx);
    assert.deepStrictEqual(keys(sign.deviceAction), keys(acts.poster_sign));
    for (const a of Object.values(acts)) {
      assert.ok(fixture.enums.showMode.includes(a.mode ?? "poster"));
      if (a.purpose) assert.ok(fixture.enums.pickPurpose.includes(a.purpose));
    }
    // The model needs the id to keep the photo or put it on a card.
    assert.match(fixture.systemLines.photo_shown, /\(photo \{photo_id\}\)/);
    for (const line of Object.values(fixture.systemLines)) {
      assert.match(line, /^\[SYSTEM\] /);
      // "made/ready" appears only to forbid it: a [SYSTEM] turn runs no
      // tool, so a reply claiming it would be rewritten into a denial.
      const claims = line.replace(/(Do not|never) say[^.]*\./gi, "");
      assert.doesNotMatch(claims, /\b(is|are) (made|ready|created)\b/i, line);
    }
  });

  /* ================================================================ */
  server.close();
  const priv = require("../src/routes/privacy");
  for (const u of USERS) {
    if (u === E) continue;
    await priv.deleteUserEverywhere(u, { reason: "test cleanup" }).catch((e) => console.warn("cleanup:", e.message));
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${passed} passed${skipped ? `, ${skipped} skipped (no ffmpeg)` : ""}`);
  await db.close();
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

function round2(v) { return Math.round(v * 100) / 100; }
