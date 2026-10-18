/**
 * THE DAY'S QUOTE AND ITS PICTURES (2026-10-18).
 *
 * His spec: "when user click on [the home quote] we need the pop where
 * need at least 5 generated images on the quote and users can share that
 * … one god theme and much more … generate in server that 5 images and
 * send that copy to all users instead of each and every user generating",
 * then "quotes should be different everyday".
 *
 * So the server owns the day's line: once per India day it writes a NEW
 * motivational line (never one already used — the history is kept), and
 * makes one TEXT-FREE picture per style through the image chain
 * (imagegen.js, purpose 'background'). Every user gets the same line and
 * the same files; nobody's tap costs a generation. The words are set on
 * the phone in real fonts over the picture (the photo cards' rule: image
 * models misspell words), and the phone renders the shared PNG.
 *
 * Tomorrow is prepared today, so at midnight the new day is already
 * ready. Files live on the data volume:
 *   DATA_DIR/quote-cards/<YYYY-MM-DD>/day.json + <style>.jpg
 *   DATA_DIR/quote-cards/history.json — every line used, newest last
 *
 * QUOTE_CARDS=off stops all generation (the route then serves the
 * fallback line with no pictures).
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(
  process.env.DATA_DIR || path.join(__dirname, "..", "..", "data"),
  "quote-cards"
);

/** The app's own list (lib/core/daily_quotes.dart) — used when the model
 *  cannot write a line, picking one not used yet. */
const FALLBACK = [
  "Do the hard one first. The rest of the day gets easier.",
  "Start before you feel ready — readiness comes from starting.",
  "One hour of real work beats a day of getting ready to work.",
  "The task you keep moving down the list is the one to do now.",
  "Finish something today. Anything.",
  "Send it. A good thing shipped beats a perfect thing waiting.",
  "Decide now. A made decision frees the mind a pending one occupies.",
  "You do not need motivation. You need the first five minutes.",
  "Pick the call you are dreading and make it.",
  "Close one open loop before you open another.",
  "Your future self is watching. Give them something to work with.",
  "Show up today whether you feel like it or not — that is the whole trick.",
  "The work you avoid is usually the work that pays.",
  "Say no to one thing today so you can finish another.",
  "Do it badly, then make it better. Nothing improves in your head.",
  "Two hard hours today are worth ten distracted ones tomorrow.",
  "The day is yours until someone else spends it. Spend it first.",
  "Stop planning it. Open it and begin.",
  "Momentum is built, not found. Build some before lunch.",
  "Answer the message you have been avoiding.",
  "Effort compounds quietly, then all at once.",
  "Do today what your excuses are saving for tomorrow.",
  "Small and finished beats big and imagined.",
  "Discipline is choosing what you want most over what you want now.",
  "Every day you delay, the task grows. Take it while it is small.",
];

/** The divine picture rotates through these, one a day. Named so the
 *  image chain's subject notes (imagegen SUBJECT_HINTS) draw each form
 *  correctly. */
const DEITIES = [
  "Lord Ganesha", "Lord Krishna", "Lord Shiva", "Goddess Lakshmi",
  "Lord Hanuman", "Lord Rama", "Goddess Saraswati", "Lord Venkateswara",
  "Goddess Durga", "Lord Murugan",
];

/**
 * The looks. `ink` is the colour the phone sets the words in; `font`
 * 'serif' or 'sans'; `scrim` how much the phone darkens (or, for a light
 * picture, lightens) the middle so the words read. Every prompt asks for
 * a calm, empty centre — that is where the words go.
 */
const STYLES = [
  {
    id: "divine", label: "Divine", ink: "#FFF6E0", font: "serif", scrim: "dark",
    look: (d) =>
      `${d.deity}, serene and benevolent, soft divine golden light, glowing brass diyas, ` +
      `lotus flowers, temple atmosphere, warm saffron and gold tones, devotional painting, ` +
      `the figure in the upper part of the frame, calm uncluttered lower half`,
  },
  {
    id: "sunrise", label: "Sunrise", ink: "#FFFFFF", font: "sans", scrim: "dark",
    look: () =>
      "misty mountain ridges at sunrise, layered silhouettes, sun just above the horizon, " +
      "soft orange, rose and violet sky, hopeful and calm, wide open sky in the centre",
  },
  {
    id: "nature", label: "Nature", ink: "#FFFFFF", font: "serif", scrim: "dark",
    look: () =>
      "sunlit forest path in early morning, tall trees, rays of light through mist, fresh " +
      "green and gold, peaceful, soft depth of field, open bright centre",
  },
  {
    id: "ocean", label: "Ocean", ink: "#FFFFFF", font: "sans", scrim: "dark",
    look: () =>
      "calm ocean at golden hour, gentle waves, wide horizon, warm reflections on the water, " +
      "deep teal and amber, minimal and spacious, empty sky in the centre",
  },
  {
    id: "neon", label: "Neon", ink: "#FFFFFF", font: "sans", scrim: "dark",
    look: () =>
      "dark city street at night after rain, glowing neon reflections in magenta and cyan, " +
      "soft bokeh, cinematic, high contrast, dark empty space in the centre",
  },
  {
    id: "watercolor", label: "Watercolour", ink: "#2A2433", font: "serif", scrim: "light",
    look: () =>
      "delicate watercolour flowers in soft pastel pink, peach and sage on textured off-white " +
      "paper, blooms only around the edges, a large clean empty paper centre",
  },
  {
    id: "cosmic", label: "Cosmic", ink: "#FFFFFF", font: "sans", scrim: "dark",
    look: () =>
      "deep space nebula in violet, blue and rose, scattered stars, soft glow, dreamy and vast, " +
      "darker calm area in the centre",
  },
];

const FORMAT = { aspect: "poster", width: 1080, height: 1350 };

function on() {
  return String(process.env.QUOTE_CARDS || "on").toLowerCase() !== "off";
}

/** YYYY-MM-DD for India, offset by `plusDays`. */
function indiaDate(plusDays = 0, now = Date.now()) {
  const d = new Date(now + 5.5 * 3600_000 + plusDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

function dayDir(date) {
  return path.join(ROOT, date);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function history() {
  const h = readJson(path.join(ROOT, "history.json"), []);
  return Array.isArray(h) ? h : [];
}

/** Lower-cased letters only — "Start now." and "start now" are one line. */
function norm(s) {
  return String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** A stable small number from a date, for the deity and the seeds. */
function dayNumber(date) {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86400_000);
}

const SYSTEM =
  "You write one motivational line for the home screen of a personal assistant used by busy " +
  "professionals in India. A motivational line asks for action — start, finish, decide, send, " +
  "do the hard thing first — it is read at 8 a.m. by someone putting their day off. Rules: " +
  "one or two short sentences, 6 to 18 words, plain English, original (not a famous quote, no " +
  "author), no hashtags, no emoji, no exclamation marks, no quotation marks, nothing religious, " +
  "political or about money. Never repeat or closely paraphrase a line in `used`. " +
  'Answer JSON only: {"line": "..."}';

async function writeLine(date, used) {
  try {
    if (!require("../services/ai/openai").ready()) throw new Error("no key");
    const router = require("../services/ai/router");
    const model = router.envModel("QUOTE_MODEL", require("../services/ai/openai").models.fast());
    const { reply } = await router.generateReply(
      [{ role: "user", content: JSON.stringify({ date, used: used.slice(-120) }) }],
      { system: SYSTEM, json: true, model, modelEnv: "QUOTE_MODEL", timeoutMs: 30_000, noRetry: true }
    );
    let line = "";
    try {
      line = String(JSON.parse(String(reply).replace(/^```(json)?|```$/g, "").trim()).line || "");
    } catch (_) {
      line = String(reply || "");
    }
    line = line.replace(/["“”]/g, "").replace(/!/g, ".").replace(/\s+/g, " ").trim();
    const words = line.split(" ").length;
    const seen = new Set(used.map(norm));
    if (words >= 5 && words <= 24 && line.length <= 160 && !seen.has(norm(line))) return line;
    console.warn("quote cards: model line rejected —", line.slice(0, 80));
  } catch (e) {
    console.warn("quote cards: model line failed —", String(e.message).slice(0, 120));
  }
  const seen = new Set(used.map(norm));
  const fresh = FALLBACK.filter((l) => !seen.has(norm(l)));
  const pool = fresh.length ? fresh : FALLBACK;
  return pool[dayNumber(date) % pool.length];
}

/** The day's record, writing the line if the day has none yet. */
async function ensureDay(date) {
  const file = path.join(dayDir(date), "day.json");
  const have = readJson(file, null);
  if (have && have.text) return have;
  const h = history();
  const text = await writeLine(date, h.map((e) => e.text));
  const day = {
    date,
    text,
    deity: DEITIES[dayNumber(date) % DEITIES.length],
    createdAt: new Date().toISOString(),
  };
  writeJson(file, day);
  writeJson(path.join(ROOT, "history.json"), [...h, { date, text }].slice(-1000));
  return day;
}

function imageFile(date, style) {
  return path.join(dayDir(date), `${style}.jpg`);
}

/** style id → epoch ms of the last failure, so a dead provider is not hammered. */
const failedAt = new Map();
const RETRY_AFTER_MS = 30 * 60_000;
/** date → the running generation, so two requests never generate twice. */
const running = new Map();

async function makeImage(day, style) {
  const look = style.look(day);
  const img = await require("../services/imagegen").generateImage(look, {
    aspect: FORMAT.aspect,
    target: { width: FORMAT.width, height: FORMAT.height },
    purpose: "background",
    enhance: true,
    style: style.id,
    seed: dayNumber(day.date) * 10 + STYLES.indexOf(style),
  });
  const file = imageFile(day.date, style.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, img.buffer);
  fs.renameSync(tmp, file);
  console.log(`quote cards: ${day.date} ${style.id} via ${img.provider}`);
}

/** Make every picture the day is missing, two at a time. */
function generate(date) {
  if (!on()) return Promise.resolve();
  if (running.has(date)) return running.get(date);
  const job = (async () => {
    const day = await ensureDay(date);
    const todo = STYLES.filter((s) => {
      if (fs.existsSync(imageFile(date, s.id))) return false;
      const f = failedAt.get(`${date}/${s.id}`);
      return !f || Date.now() - f > RETRY_AFTER_MS;
    });
    const queue = todo.slice();
    const worker = async () => {
      while (queue.length) {
        const s = queue.shift();
        try {
          await makeImage(day, s);
          failedAt.delete(`${date}/${s.id}`);
        } catch (e) {
          failedAt.set(`${date}/${s.id}`, Date.now());
          console.warn(`quote cards: ${date} ${s.id} failed —`, String(e.message).slice(0, 120));
        }
      }
    };
    await Promise.all([worker(), worker()]);
  })()
    .catch((e) => console.warn("quote cards: generate failed —", String(e.message).slice(0, 160)))
    .finally(() => running.delete(date));
  running.set(date, job);
  return job;
}

/** What the phone shows: the line, and every picture that exists. */
async function today() {
  const date = indiaDate();
  let day = readJson(path.join(dayDir(date), "day.json"), null);
  if (!day && on()) {
    try {
      day = await ensureDay(date);
    } catch (e) {
      console.warn("quote cards: no day record —", String(e.message).slice(0, 120));
    }
  }
  if (!day) {
    return { date, text: FALLBACK[dayNumber(date) % FALLBACK.length], status: "off", cards: [] };
  }
  const cards = [];
  for (const s of STYLES) {
    const file = imageFile(date, s.id);
    let st;
    try {
      st = fs.statSync(file);
    } catch (_) {
      continue;
    }
    cards.push({
      style: s.id, label: s.label, ink: s.ink, font: s.font, scrim: s.scrim,
      url: `/quote-cards/img/${date}/${s.id}.jpg?v=${Math.round(st.mtimeMs)}`,
      width: FORMAT.width, height: FORMAT.height,
    });
  }
  const pending = cards.length < STYLES.length && on() &&
    STYLES.some((s) => !cards.find((c) => c.style === s.id) &&
      (!failedAt.get(`${date}/${s.id}`) || Date.now() - failedAt.get(`${date}/${s.id}`) > RETRY_AFTER_MS));
  if (pending) generate(date);
  return {
    date, text: day.text,
    status: pending || running.has(date) ? "generating" : "ready",
    total: STYLES.length, cards,
  };
}

/** A picture's path, or null for anything that is not one of ours. */
function imagePath(date, file) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return null;
  const m = /^([a-z]+)\.jpg$/.exec(String(file));
  if (!m || !STYLES.find((s) => s.id === m[1])) return null;
  const p = imageFile(date, m[1]);
  return fs.existsSync(p) ? p : null;
}

/** Today and tomorrow, so midnight never waits on a generation. */
async function prepare() {
  if (!on()) return;
  await generate(indiaDate());
  await generate(indiaDate(1));
}

let timer = null;
function start() {
  if (timer || !on() || process.env.NODE_ENV === "test") return;
  setTimeout(() => prepare().catch(() => null), 60_000).unref();
  timer = setInterval(() => prepare().catch(() => null), 30 * 60_000);
  timer.unref();
}

module.exports = {
  today, imagePath, prepare, start, generate, ensureDay, indiaDate, STYLES, FALLBACK,
  _test: { norm, writeLine, dayNumber },
};
