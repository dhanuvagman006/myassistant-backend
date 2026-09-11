/**
 * VIDEO GENERATION.
 *
 * Two paths, and the honest difference between them matters:
 *
 *   1. VEO — real synthesised video, motion and all. Paid tier only on
 *      this key. Tried first; the day billing is enabled it just starts
 *      working and nothing else changes.
 *
 *   2. KEYFRAMES + ffmpeg — free, and real MP4 output. Several frames are
 *      generated from one seed so the subject stays itself, then they are
 *      crossfaded together under a slow push in. It is a moving picture,
 *      not synthesised motion, and the caller is told which it got so the
 *      assistant can say so. Passing this off as Veo would be the same
 *      class of lie as claiming an alarm was set.
 *
 * Before this, "make me a video" answered "video isn't enabled on the
 * current plan" — a capability the product listed and did not have.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const { generateImage, tryVeoVideo } = require("./imagegen");

/** Does this container actually have ffmpeg? Probed once. */
let ffmpegOk = null;
function haveFfmpeg() {
  if (ffmpegOk !== null) return Promise.resolve(ffmpegOk);
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-version"], { timeout: 8000 }, (err) => {
      ffmpegOk = !err;
      if (err) console.warn("videogen: ffmpeg not available —", err.message);
      resolve(ffmpegOk);
    });
  });
}

function run(args, { timeout = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).slice(-400)));
      else resolve();
    });
  });
}

/**
 * A shot list from one description. Each frame is the SAME scene a moment
 * later, which is what makes the crossfade read as movement rather than as
 * a slideshow of unrelated pictures.
 */
function shotList(prompt, frames) {
  const beats = [
    "establishing wide shot, early light",
    "the same scene a moment later, slightly closer",
    "the same scene, mid-action, warmer light",
    "the same scene, closer still, late light",
    "the same scene, final moment, golden light",
  ];
  return Array.from({ length: frames }, (_, i) =>
    `${prompt}. Cinematic film still, ${beats[i % beats.length]}. ` +
    `Consistent subject, consistent style and palette across the sequence. ` +
    `Sharp focus, natural lighting, high detail, no text, no watermark.`
  );
}

/**
 * @returns {{ buffer, mime, kind: "veo"|"keyframes", frames?: number, seconds?: number }}
 * @throws when neither path can produce anything
 */
async function generateVideo(prompt, { seconds = 8, frames = 4, aspect = "wide" } = {}) {
  const p = String(prompt || "").trim();
  if (!p) throw new Error("empty prompt");

  const veo = await tryVeoVideo(p).catch(() => null);
  if (veo) return { ...veo, kind: "veo" };

  if (!(await haveFfmpeg())) {
    throw new Error("no video encoder available on the server");
  }

  // One seed for every frame: without it each frame is a different
  // Mercedes on a different road and the crossfade looks like a fault.
  const seed = Math.floor(Math.random() * 1e9);
  const shots = shotList(p, Math.min(Math.max(frames, 2), 5));
  const images = [];
  for (const shot of shots) {
    // Sequential, not parallel: the free provider rate-limits hard, and a
    // burst of five costs more failures than the extra seconds save.
    try {
      images.push(await generateImage(shot, { aspect, seed }));
    } catch (e) {
      console.warn("videogen frame failed:", e.message);
    }
  }
  if (images.length < 2) throw new Error("could not generate enough frames");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hari-vid-"));
  try {
    const per = Math.max(seconds / images.length, 1.6); // seconds per frame
    const fade = Math.min(per / 2.5, 1.0);
    const inputs = [];
    images.forEach((img, i) => {
      const f = path.join(dir, `f${i}.jpg`);
      fs.writeFileSync(f, img.buffer);
      inputs.push("-loop", "1", "-t", per.toFixed(2), "-i", f);
    });

    // Each frame gets a slow push in (Ken Burns), then they are crossfaded
    // in sequence. scale+crop first so every input is the same size — xfade
    // refuses mismatched frames, and the provider can return a pixel or two
    // off the size asked for.
    const W = 1280, H = 720;
    const parts = [];
    images.forEach((_, i) => {
      parts.push(
        `[${i}:v]scale=${W * 1.12}:${H * 1.12}:force_original_aspect_ratio=increase,` +
        `crop=${Math.round(W * 1.12)}:${Math.round(H * 1.12)},` +
        `zoompan=z='min(zoom+0.0009,1.12)':d=${Math.round(per * 25)}:` +
        `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=25,` +
        `setsar=1,format=yuv420p[v${i}]`
      );
    });
    let last = "v0";
    for (let i = 1; i < images.length; i++) {
      const out = i === images.length - 1 ? "vout" : `x${i}`;
      const offset = (per - fade) * i;
      parts.push(
        `[${last}][v${i}]xfade=transition=fade:duration=${fade.toFixed(2)}:` +
        `offset=${offset.toFixed(2)}[${out}]`
      );
      last = out;
    }
    const map = images.length > 1 ? "[vout]" : "[v0]";

    const out = path.join(dir, "out.mp4");
    await run([
      "-y", ...inputs,
      "-filter_complex", parts.join(";"),
      "-map", map,
      "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-pix_fmt", "yuv420p",
      // faststart so the app can begin playing before the whole file lands.
      "-movflags", "+faststart",
      out,
    ]);
    const buffer = fs.readFileSync(out);
    if (buffer.length < 10 * 1024) throw new Error("encoder produced an empty file");
    return {
      buffer,
      mime: "video/mp4",
      kind: "keyframes",
      frames: images.length,
      seconds: Math.round(per * images.length),
    };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { generateVideo, haveFfmpeg };
