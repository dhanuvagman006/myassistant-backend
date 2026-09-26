/**
 * PHOTO CARDS — MAKING AN OLD PHOTO NICER, WITHOUT AI.
 * ----------------------------------------------------------------------
 * The client: "I want to put an old picture and ask My assistant to make
 * it nice and beautiful". The owner (2026-09-26): "build it without AI".
 * Gemini image billing is not enabled, and an AI redraw can change a
 * face, so v1 does what a photo lab does, with ffmpeg (already in the
 * runtime image for video):
 *
 *   1. EXIF rotation baked into the pixels, the long edge capped at 2048,
 *      and every tag stripped (a phone photo's GPS never reaches storage);
 *   2. auto levels PER CHANNEL, from a 0.4 % / 99.6 % percentile read of
 *      the photo itself — which is exactly what fading and a yellow or red
 *      colour cast are: each channel squeezed into its own narrow band;
 *   3. a partial grey-world balance in the mid-tones and a gentle
 *      exposure lift for a dark print;
 *   4. a light denoise (hqdn3d) BEFORE a mild unsharp mask, so grain is
 *      not sharpened, and a small saturation lift for faded colour;
 *   5. colour 'keep' | 'bw' | 'sepia'. 'keep' turns a tinted black-and-
 *      white print into clean neutral greys (the tint IS the fading) and
 *      never touches the colours of a colour photo beyond the balance.
 *
 * Deterministic: the same photo always gives the same bytes, and nothing
 * is ever invented — no face, no detail, no scratch "repaired". It cannot
 * mend tears or scratches, and the assistant is told never to call it a
 * repair or a restoration.
 *
 * The numbers are planned in JavaScript (planLevels) from a 192 px read of
 * the photo, so they are unit-tested without ffmpeg; ffmpeg only applies
 * them. Without ffmpeg (a dev box, or a probe that failed a minute ago)
 * the original is kept as uploaded but for its tags, which are cut out in
 * JavaScript (stripMetadata) — the GPS promise holds on that path too —
 * and there is simply no enhanced variant; every caller has that path.
 *
 * Hardened after review (2026-09-26): the type is read from the bytes,
 * never the declared mime (a JPEG named .png is still rotated); nothing
 * over imageEdit.MAX_DECODE_PIXELS is decoded (a big JPEG opens at 1/2,
 * 1/4 or 1/8 size instead); a see-through PNG or WebP is laid on white
 * before anything else, so its transparent part is neither black nor
 * counted in the levels; and bytes ffmpeg cannot open are an
 * 'undecodable' error, not a "try again".
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const imageEdit = require("../services/imageEdit");

const MAX_EDGE = 2048;
const STATS_EDGE = 192;

/* ------------------------------------------------------------------ */
/* EXIF ORIENTATION                                                    */
/* ------------------------------------------------------------------ */

/**
 * The EXIF Orientation tag (1-8) of a JPEG, or 1. Read here rather than
 * left to ffmpeg's autorotate so the stored size is known before encoding
 * and a future ffmpeg that stops (or doubles) the rotation cannot turn a
 * portrait of his daughter on its side.
 */
function exifOrientation(buf) {
  try {
    if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
    let i = 2;
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xff) return 1;
      while (buf[i + 1] === 0xff && i + 2 < buf.length) i++; // fill bytes
      const marker = buf[i + 1];
      if (marker === 0xd9 || marker === 0xda) return 1; // end, or image data
      if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return 1;
      if (marker === 0xe1 && buf.slice(i + 4, i + 10).toString("latin1") === "Exif\0\0") {
        const t = i + 10;
        const order = buf.slice(t, t + 2).toString("latin1");
        if (order !== "II" && order !== "MM") return 1;
        const le = order === "II";
        const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
        const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
        if (u16(t + 2) !== 42) return 1;
        const ifd = t + u32(t + 4);
        const n = u16(ifd);
        for (let k = 0; k < n; k++) {
          const e = ifd + 2 + k * 12;
          if (e + 12 > buf.length) break;
          if (u16(e) === 0x0112) {
            const v = u16(e + 8);
            return v >= 1 && v <= 8 ? v : 1;
          }
        }
        return 1;
      }
      i += 2 + len;
    }
  } catch (_) { /* a malformed header is an unrotated photo */ }
  return 1;
}

/* ------------------------------------------------------------------ */
/* TAGS AND TRANSPARENCY, READ AND CUT IN JAVASCRIPT                   */
/* ------------------------------------------------------------------ */

/** A one-tag EXIF block: just the Orientation, so nothing else survives. */
function orientationSegment(orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22); // no next IFD
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/**
 * A JPEG without its tags: every APPn but JFIF (APP0), an ICC colour
 * profile and Adobe's colour-transform flag (neither says anything about
 * a person or a place), and no comments. The orientation goes back in as
 * a one-tag EXIF block — without ffmpeg nothing turns the pixels, and a
 * portrait must not end up on its side. null when it cannot be parsed.
 */
function stripJpeg(buf) {
  const orient = exifOrientation(buf);
  const segs = [];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    let m = i;
    while (buf[m + 1] === 0xff && m + 2 < buf.length) m++; // fill bytes
    const marker = buf[m + 1];
    // Image data (or the end): everything from here on is pixels.
    if (marker === 0xda || marker === 0xd9) {
      const head = [buf.slice(0, 2)];
      const app0 = segs.length && segs[0][1] === 0xe0 ? [segs.shift()] : [];
      return Buffer.concat([...head, ...app0, ...(orient !== 1 ? [orientationSegment(orient)] : []),
        ...segs, buf.slice(m)]);
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i = m + 2; continue; }
    if (m + 4 > buf.length) return null;
    const len = buf.readUInt16BE(m + 2);
    if (len < 2 || m + 2 + len > buf.length) return null;
    const seg = buf.slice(m, m + 2 + len);
    const tagged = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    const harmless =
      (marker === 0xe2 && seg.slice(4, 16).toString("latin1") === "ICC_PROFILE\0") ||
      (marker === 0xee && seg.slice(4, 9).toString("latin1") === "Adobe");
    if (!tagged || harmless) segs.push(seg);
    i = m + 2 + len;
  }
  return null;
}

/** A PNG without its text, EXIF and time chunks. null when it cannot be parsed. */
function stripPng(buf) {
  const DROP = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);
  const out = [buf.slice(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.slice(i + 4, i + 8).toString("latin1");
    const end = i + 12 + len;
    if (end > buf.length) return null;
    if (!DROP.has(type)) out.push(buf.slice(i, end));
    if (type === "IEND") return Buffer.concat(out);
    i = end;
  }
  return null;
}

/** A WebP without its EXIF and XMP chunks (and their VP8X flags). */
function stripWebp(buf) {
  const chunks = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const fourcc = buf.slice(i, i + 4).toString("latin1");
    const size = buf.readUInt32LE(i + 4);
    if (i + 8 + size > buf.length) return null;
    const end = Math.min(buf.length, i + 8 + size + (size & 1));
    if (fourcc !== "EXIF" && fourcc !== "XMP ") chunks.push(Buffer.from(buf.slice(i, end)));
    i = end;
  }
  if (!chunks.length) return null;
  for (const c of chunks) {
    if (c.slice(0, 4).toString("latin1") === "VP8X" && c.length > 8) c[8] &= ~0x0c;
  }
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...chunks]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/**
 * The photo's bytes with every tag that could say where or when it was
 * taken cut out — for the path where ffmpeg (which drops them all on
 * re-encode) is not available. null when the bytes cannot be parsed.
 */
function stripMetadata(buf) {
  try {
    const kind = imageEdit.imageKind(buf);
    if (kind === "jpeg") return stripJpeg(buf);
    if (kind === "png") return stripPng(buf);
    if (kind === "webp") return stripWebp(buf);
  } catch (_) { /* unparseable is null */ }
  return null;
}

/** Does this PNG or WebP carry transparency? (A JPEG never does.) */
function hasAlpha(buf) {
  try {
    const kind = imageEdit.imageKind(buf);
    if (kind === "png") {
      const colourType = buf[25];
      if (colourType === 4 || colourType === 6) return true;
      let i = 8;
      while (i + 12 <= buf.length) {
        const len = buf.readUInt32BE(i);
        const type = buf.slice(i + 4, i + 8).toString("latin1");
        if (type === "tRNS") return true;
        if (type === "IDAT" || type === "IEND") return false;
        i += 12 + len;
      }
      return false;
    }
    if (kind === "webp") {
      const k = buf.slice(12, 16).toString("latin1");
      if (k === "VP8X") return (buf[20] & 0x10) !== 0;
      if (k === "VP8L") return buf.length >= 25 && ((buf.readUInt32LE(21) >>> 28) & 1) === 1;
    }
  } catch (_) {}
  return false;
}

/** ffmpeg filters that turn stored pixels the way EXIF says they are seen. */
const ORIENT_VF = {
  1: "",
  2: "hflip",
  3: "hflip,vflip",
  4: "vflip",
  5: "transpose=0", // transpose: mirror across the main diagonal
  6: "transpose=1", // 90° clockwise
  7: "transpose=3", // transverse
  8: "transpose=2", // 90° counter-clockwise
};

/* ------------------------------------------------------------------ */
/* THE PLAN — pure, tested without ffmpeg                              */
/* ------------------------------------------------------------------ */

const LUMA = [0.2126, 0.7152, 0.0722];
const MAX_GAIN = 2.4; // a flat, dark scan is lifted, never blown into noise
const SEPIA = [1.07, 0.95, 0.78];

function percentile(hist, total, p) {
  const want = p * total;
  let cum = 0;
  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (cum >= want) return v;
  }
  return 255;
}

/**
 * The levels, gamma and colour matrix for one photo, from its raw RGB24
 * pixels. `colour` is 'keep' | 'bw' | 'sepia'.
 * @returns {{lo:number[], hi:number[], gamma:number[], matrix:number[],
 *            mono:boolean, saturation:number, stats:object}}
 */
function planLevels(rgb, colour = "keep") {
  const n = Math.floor((rgb ? rgb.length : 0) / 3);
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < n; i++) {
    hist[0][rgb[3 * i]]++;
    hist[1][rgb[3 * i + 1]]++;
    hist[2][rgb[3 * i + 2]]++;
  }
  if (!n) {
    return { lo: [0, 0, 0], hi: [255, 255, 255], gamma: [1, 1, 1], matrix: matrixFor("keep", 1),
      mono: false, saturation: 1, stats: { pixels: 0 } };
  }
  const lo = [0, 1, 2].map((c) => percentile(hist[c], n, 0.004));
  const hi = [0, 1, 2].map((c) => Math.max(percentile(hist[c], n, 0.996), lo[c] + 1));

  // Is it a black-and-white print under a tint? Stretch each channel fully
  // and look at what colour is left: a sepia or yellowed print becomes
  // grey, a colour photo does not. Strict thresholds — turning a colour
  // photo grey would be the one unforgivable mistake here.
  let chromaSum = 0;
  const chromas = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    let mx = 0;
    let mn = 255;
    for (let c = 0; c < 3; c++) {
      const v = Math.round(clamp01((rgb[3 * i + c] - lo[c]) / (hi[c] - lo[c])) * 255);
      if (v > mx) mx = v;
      if (v < mn) mn = v;
    }
    chromaSum += mx - mn;
    chromas[mx - mn]++;
  }
  const chroma = chromaSum / n / 255;
  const chroma95 = percentile(chromas, n, 0.95) / 255;
  const tintedPrint = chroma < 0.025 && chroma95 < 0.06;
  const mono = colour !== "keep" || tintedPrint;

  // Per-channel levels:
  //   • a colour photo — blended 75 % toward independence (removes the
  //     cast, keeps a photo that really is warm a little warm);
  //   • a tinted black-and-white print — fully per channel, which is what
  //     turns its brown or yellow back into a full range of grey;
  //   • black and white (or sepia) asked of a colour photo — one range for
  //     all three, read from the brightness, so the greys span black to white.
  let loAll = Math.min(...lo);
  let hiAll = Math.max(...hi);
  let k = 0.75;
  if (tintedPrint) k = 1;
  else if (mono) {
    k = 0;
    const lum = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      lum[Math.round(LUMA[0] * rgb[3 * i] + LUMA[1] * rgb[3 * i + 1] + LUMA[2] * rgb[3 * i + 2])]++;
    }
    loAll = percentile(lum, n, 0.004);
    hiAll = Math.max(percentile(lum, n, 0.996), loAll + 1);
  }
  const L = [];
  const H = [];
  for (let c = 0; c < 3; c++) {
    let l = loAll + k * (lo[c] - loAll);
    let h = hiAll + k * (hi[c] - hiAll);
    if (h - l < 255 / MAX_GAIN) {
      const mid = (h + l) / 2;
      l = mid - 127.5 / MAX_GAIN;
      h = mid + 127.5 / MAX_GAIN;
      if (l < 0) { h -= l; l = 0; }
      if (h > 255) { l -= h - 255; h = 255; }
    }
    L.push(round1(l));
    H.push(round1(h));
  }

  // Mid-tone means after the levels, per channel (0..1).
  const mean = [0, 1, 2].map((c) => {
    let s = 0;
    for (let v = 0; v < 256; v++) s += hist[c][v] * clamp01((v - L[c]) / (H[c] - L[c]));
    return s / n;
  });
  const mAvg = (mean[0] + mean[1] + mean[2]) / 3;

  // A partial grey-world pull in the mid-tones, colour photos only: 40 %
  // of the way and never more than a small gamma step. The levels above
  // already took the cast out of the shadows and highlights; a photo that
  // really is mostly one colour (a pink saree, a sunset) must keep it.
  const gamma = [1, 1, 1];
  if (!mono) {
    for (let c = 0; c < 3; c++) {
      const m = Math.min(0.97, Math.max(0.03, mean[c]));
      const target = m + 0.4 * (mAvg - m);
      gamma[c] = clamp(Math.log(target) / Math.log(m), 0.88, 1.14);
    }
  }
  // Exposure: a dark print is lifted toward 0.45, a washed-out one eased.
  let g0 = 1;
  const mm = Math.min(0.97, Math.max(0.03, mAvg));
  if (mm < 0.4) g0 = clamp(Math.log(0.45) / Math.log(mm), 0.72, 1);
  else if (mm > 0.62) g0 = clamp(Math.log(0.57) / Math.log(mm), 1, 1.25);

  // Faded colour gets a little more saturation than a healthy photo.
  const saturation = mono ? 0 : chroma < 0.1 ? 1.12 : 1.06;
  const mode = colour === "sepia" ? "sepia" : mono ? "bw" : "keep";
  return {
    lo: L,
    hi: H,
    gamma: gamma.map((g) => round3(g * g0)),
    matrix: matrixFor(mode, saturation),
    mono,
    saturation,
    stats: {
      pixels: n, lo, hi, mean: mean.map(round3), chroma: round3(chroma),
      chroma95: round3(chroma95),
    },
  };
}

/** A 3x3 colour matrix (row-major) for colorchannelmixer. */
function matrixFor(mode, s = 1) {
  if (mode === "bw" || mode === "sepia") {
    const tint = mode === "sepia" ? SEPIA : [1, 1, 1];
    return [0, 1, 2].flatMap((row) => LUMA.map((w) => round4(tint[row] * w)));
  }
  // Saturation around Rec.709 luma: s = 1 is the identity.
  const m = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      m.push(round4(LUMA[col] * (1 - s) + (row === col ? s : 0)));
    }
  }
  return m;
}

/** The ffmpeg filter chain that applies a plan to an already-rotated photo. */
function filterFor(plan, { longEdge = MAX_EDGE } = {}) {
  const lut = (c) =>
    `clip(pow(clip((val-${fx(plan.lo[c])})/${fx(plan.hi[c] - plan.lo[c])},0,1),${fx(plan.gamma[c])})*255,0,255)`;
  const m = plan.matrix.map(fx);
  const mixer =
    `colorchannelmixer=rr=${m[0]}:rg=${m[1]}:rb=${m[2]}` +
    `:gr=${m[3]}:gg=${m[4]}:gb=${m[5]}:br=${m[6]}:bg=${m[7]}:bb=${m[8]}`;
  const sharpen = longEdge >= 1200 ? "unsharp=5:5:0.6:5:5:0" : "unsharp=3:3:0.5:3:3:0";
  return [
    "hqdn3d=1.5:1.5:6:6",
    "format=rgb24",
    `lutrgb=r='${lut(0)}':g='${lut(1)}':b='${lut(2)}'`,
    mixer,
    "format=yuvj444p",
    sharpen,
  ].join(",");
}

/* ------------------------------------------------------------------ */
/* FFMPEG                                                              */
/* ------------------------------------------------------------------ */

function ffmpeg(args, { timeout = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr || err.message).split("\n").slice(-3).join(" ").slice(0, 300);
          // A run we stopped (the timeout, under load) may well work next
          // time; one that failed on its own will fail the same way again.
          return reject(Object.assign(new Error(tail), { timedOut: !!err.killed }));
        }
        resolve(stdout);
      });
  });
}

/** An error the caller turns into "that photo doesn't open" (or "too big"). */
function photoError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * At most two photos are worked on at once: each run is three short
 * ffmpeg processes, and a burst of uploads must not starve the voice
 * turns running in the same pod.
 */
const MAX_JOBS = 2;
let running = 0;
const waiting = [];
async function withSlot(fn) {
  if (running >= MAX_JOBS) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    const next = waiting.shift();
    if (next) next();
  }
}

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const EXT_OF_KIND = { jpeg: "jpg", png: "png", webp: "webp" };

/** Raw RGB24 pixels of a small copy, for planLevels. */
async function readStats(file) {
  return ffmpeg([
    "-v", "error", "-i", file,
    "-vf", `scale=w=${STATS_EDGE}:h=${STATS_EDGE}:force_original_aspect_ratio=decrease:flags=area,format=rgb24`,
    "-frames:v", "1", "-f", "rawvideo", "pipe:1",
  ]);
}

/**
 * The stats without the white a see-through picture was laid on: counted,
 * a cut-out that is one-third clear read as an over-bright photo and its
 * real part was darkened. Only pixels white in all three channels go, and
 * only when enough of the picture is left to plan from.
 */
function dropWhite(rgb) {
  const n = Math.floor(rgb.length / 3);
  const keep = [];
  for (let i = 0; i < n; i++) {
    if (Math.min(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]) < 250) keep.push(i);
  }
  if (keep.length < n * 0.1) return rgb;
  const out = Buffer.alloc(keep.length * 3);
  keep.forEach((p, j) => rgb.copy(out, 3 * j, 3 * p, 3 * p + 3));
  return out;
}

async function enhanceFile(inFile, outFile, colour, longEdge, { flattened = false } = {}) {
  const stats = await readStats(inFile);
  const plan = planLevels(flattened ? dropWhite(stats) : stats, colour);
  await ffmpeg(["-y", "-v", "error", "-i", inFile, "-vf", filterFor(plan, { longEdge }),
    "-frames:v", "1", "-q:v", "2", outFile]);
  return plan;
}

/**
 * The stored original (rotated, capped, tags stripped) and the enhanced
 * copy, from an uploaded photo. `mime` is only a hint: the type is read
 * from the bytes. Throws an Error with code 'too_many_pixels' or
 * 'undecodable' for a picture that cannot be used — never a "try again".
 * @returns {Promise<{original:{buffer,ext,width,height}, enhanced:{buffer,width,height}|null,
 *                    plan:object|null, notes:string[]}>}
 */
async function prepare(buffer, mime, { colour = "keep", maxEdge = MAX_EDGE } = {}) {
  const size = imageEdit.imageSize(buffer) || { width: 0, height: 0 };
  const kind = imageEdit.imageKind(buffer);
  const ext = EXT_OF_KIND[kind] || EXT[mime] || "jpg";
  // Read from the bytes, whatever the upload called itself: a JPEG sent as
  // image/png was decoded fine and left on its side (review, 2026-09-26).
  const orient = exifOrientation(buffer);
  const swap = orient >= 5;
  const notes = [];
  if (!(await imageEdit.haveFfmpeg())) {
    const clean = stripMetadata(buffer);
    if (!clean) throw photoError("undecodable", "the photo's header could not be read");
    notes.push("ffmpeg unavailable — original kept as uploaded (tags removed), no enhanced copy");
    return {
      original: {
        buffer: clean, ext,
        width: swap ? size.height : size.width, height: swap ? size.width : size.height,
      },
      enhanced: null, plan: null, notes,
    };
  }
  // Never more than MAX_DECODE_PIXELS decoded at once in this pod.
  const decode = imageEdit.decodePlan(buffer, { minEdge: maxEdge });
  if (!decode) throw photoError("too_many_pixels", `${size.width}x${size.height} is too many pixels to open`);
  return withSlot(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hari-poster-"));
    try {
      const inFile = path.join(dir, `in.${ext}`);
      fs.writeFileSync(inFile, buffer);
      const w = swap ? decode.height : decode.width;
      const h = swap ? decode.width : decode.height;
      const vf = [];
      if (ORIENT_VF[orient]) vf.push(ORIENT_VF[orient]);
      if (Math.max(w, h) > maxEdge) {
        vf.push(w >= h ? `scale=${maxEdge}:-2:flags=lanczos` : `scale=-2:${maxEdge}:flags=lanczos`);
      }
      const origFile = path.join(dir, "original.jpg");
      const args = ["-y", "-v", "error", "-noautorotate"];
      if (decode.lowres) args.push("-lowres", String(decode.lowres));
      args.push("-i", inFile);
      const tail = vf.length ? vf.join(",") : "null";
      const flattened = hasAlpha(buffer);
      if (flattened) {
        // A see-through cut-out or sticker: laid on white first. Left to
        // the JPEG encoder its clear part came out black, and those black
        // pixels then dragged the levels plan into a washed-out pastel.
        args.push("-filter_complex",
          `color=white:s=${decode.width}x${decode.height},format=rgb24[bg];` +
          `[bg][0:v]overlay=shortest=1:format=rgb,${tail}`);
        notes.push("transparency laid on white");
      } else {
        args.push("-vf", tail);
      }
      args.push("-frames:v", "1", "-q:v", "2", origFile);
      try {
        await ffmpeg(args);
      } catch (e) {
        if (e.timedOut) throw e;
        throw photoError("undecodable", e.message);
      }
      if (decode.lowres) notes.push(`decoded at 1/${2 ** decode.lowres} size`);
      const original = fs.readFileSync(origFile);
      const osize = imageEdit.imageSize(original) || { width: w, height: h };
      if (orient !== 1) notes.push(`rotated from EXIF orientation ${orient}`);

      let enhanced = null;
      let plan = null;
      try {
        const outFile = path.join(dir, "enhanced.jpg");
        plan = await enhanceFile(origFile, outFile, colour, Math.max(osize.width, osize.height), { flattened });
        const buf = fs.readFileSync(outFile);
        const esize = imageEdit.imageSize(buf) || osize;
        enhanced = { buffer: buf, width: esize.width, height: esize.height };
      } catch (e) {
        notes.push(`enhance failed: ${e.message}`);
        console.warn("posters: enhance failed —", e.message);
      }
      return {
        original: { buffer: original, ext: "jpg", width: osize.width, height: osize.height },
        enhanced, plan, notes, flattened,
      };
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });
}

/**
 * The enhanced copy again from a stored original, in another colour
 * ("make it black and white"). null when ffmpeg is unavailable or fails.
 * `flattened`: the original was a see-through picture laid on white (the
 * photo row remembers), so its stats are read the way prepare read them —
 * the same photo and colour always give the same bytes.
 */
async function reenhance(originalBuffer, colour = "keep", { flattened = false } = {}) {
  if (!(await imageEdit.haveFfmpeg())) return null;
  return withSlot(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hari-poster-"));
    try {
      const inFile = path.join(dir, "original.jpg");
      const outFile = path.join(dir, "enhanced.jpg");
      fs.writeFileSync(inFile, originalBuffer);
      const size = imageEdit.imageSize(originalBuffer) || { width: MAX_EDGE, height: MAX_EDGE };
      const plan = await enhanceFile(inFile, outFile, colour, Math.max(size.width, size.height), { flattened });
      const buf = fs.readFileSync(outFile);
      const esize = imageEdit.imageSize(buf) || size;
      return { buffer: buf, width: esize.width, height: esize.height, plan };
    } catch (e) {
      console.warn("posters: re-enhance failed —", e.message);
      return null;
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function round1(v) { return Math.round(v * 10) / 10; }
function round3(v) { return Math.round(v * 1000) / 1000; }
function round4(v) { return Math.round(v * 10000) / 10000; }
/** A number ffmpeg's expression parser reads: fixed point, never 1e-5. */
function fx(v) {
  const s = Number(v).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

module.exports = {
  prepare, reenhance, planLevels, filterFor, matrixFor, exifOrientation, readStats,
  stripMetadata, hasAlpha, dropWhite,
  ORIENT_VF, MAX_EDGE, EXT,
};
