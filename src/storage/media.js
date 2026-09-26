/**
 * MEDIA STORE — the one place large user media lives, addressed by KEY.
 * ----------------------------------------------------------------------
 * "Send messages as you" (owner, 2026-09-26) keeps two kinds of video
 * that are too big for the documents vault's buffer-in, buffer-out API:
 *
 *   identity/<uid>/video-<id>.mp4   the 30 s clip the user recorded in
 *                                   the app, plus the legacy face photo
 *                                   and voice sample of builds <= 117
 *   renders/<renderId>/output.mp4   the talking clip the owner made in
 *                                   Colab and uploaded in the admin panel
 *
 * Callers only ever speak in keys: put / get / stat / stream / delete,
 * plus the prefix helpers the account eraser and the Leftovers sweep
 * need. Nothing outside this file knows there is a disk underneath, so
 * when the PVC stops being enough (his "1-2 lakh users"), an S3/R2
 * backend can be dropped in beside `local` below and chosen with
 * MEDIA_BACKEND — no caller changes, and the keys stay the same.
 *
 * Why not the documents vault: createDocument takes a Buffer and writes
 * it with writeFileSync. A 120 MB clip held in memory inside a 512Mi pod
 * that is also relaying live calls is an OOM kill waiting for a busy
 * afternoon. Everything here streams.
 *
 * Local layout: DATA_DIR/media/<key> (override with MEDIA_DIR). Same
 * persistent volume as documents and recordings.
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");

// Letters, digits, dot, dash and underscore per segment, no leading dot:
// a key can never be "..", absolute, or a Windows drive path, whatever a
// row in the database was made to say.
const KEY_RE = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9._-]*)*$/i;
const PREFIX_RE = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9._-]*)*\/$/i;

class MediaKeyError extends Error {
  constructor(key) {
    super(`bad media key: ${String(key).slice(0, 80)}`);
    this.code = "BAD_MEDIA_KEY";
  }
}

function checkKey(key) {
  const k = String(key || "");
  if (!KEY_RE.test(k) || k.length > 200 || k.split("/").includes("..")) {
    throw new MediaKeyError(k);
  }
  return k;
}

function checkPrefix(prefix) {
  const p = String(prefix || "");
  if (!PREFIX_RE.test(p) || p.length > 200) throw new MediaKeyError(p);
  return p;
}

/** A short random id for new keys ("video-<id>.mp4"). */
function newId() {
  return `${Date.now().toString(36)}${crypto.randomBytes(5).toString("hex")}`;
}

/* ------------------------------------------------------------------ */
/* Local disk backend                                                   */
/* ------------------------------------------------------------------ */

function localBackend() {
  const ROOT = path.resolve(
    process.env.MEDIA_DIR ||
      path.join(process.env.DATA_DIR || path.join(__dirname, "..", "..", "data"), "media")
  );
  fs.mkdirSync(ROOT, { recursive: true });

  /** The absolute path of a key, and never anything outside ROOT. */
  function fileOf(key) {
    const full = path.resolve(ROOT, ...checkKey(key).split("/"));
    if (!full.startsWith(ROOT + path.sep)) throw new MediaKeyError(key);
    return full;
  }
  function dirOf(prefix) {
    const full = path.resolve(ROOT, ...checkPrefix(prefix).slice(0, -1).split("/"));
    if (!full.startsWith(ROOT + path.sep)) throw new MediaKeyError(prefix);
    return full;
  }

  /** Every file under dir, as absolute paths. */
  async function walk(dir) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return []; }
    const out = [];
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(p)));
      else if (e.isFile()) out.push(p);
    }
    return out;
  }

  /** Removes now-empty parent folders up to (never including) ROOT. */
  async function pruneDirs(from) {
    let dir = from;
    while (dir.startsWith(ROOT + path.sep)) {
      try { await fsp.rmdir(dir); } catch (_) { return; } // not empty, or gone
      dir = path.dirname(dir);
    }
  }

  return {
    name: "local",
    root: ROOT,

    /**
     * src is { path } (a finished temp file, MOVED in — the multer
     * upload case), a Readable stream, or a Buffer (small files, tests).
     * Written to a temp name and renamed, so a reader never sees half a
     * file and a crash mid-write leaves no key behind.
     */
    async put(key, src) {
      const dest = fileOf(key);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.part-${crypto.randomBytes(4).toString("hex")}`;
      try {
        if (src && typeof src.path === "string" && !src.pipe) {
          // The temp upload usually sits on the container overlay while
          // ROOT is the persistent volume: rename cannot cross that
          // boundary (EXDEV), so copy instead (appUpdate.js does the same).
          try {
            await fsp.rename(src.path, tmp);
          } catch (e) {
            if (e.code !== "EXDEV") throw e;
            await fsp.copyFile(src.path, tmp);
            await fsp.rm(src.path, { force: true });
          }
        } else if (Buffer.isBuffer(src)) {
          await fsp.writeFile(tmp, src);
        } else if (src && typeof src.pipe === "function") {
          await pipeline(src, fs.createWriteStream(tmp));
        } else {
          throw new Error("media.put needs a {path}, a stream or a Buffer");
        }
        await fsp.rename(tmp, dest);
      } catch (e) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
      const st = await fsp.stat(dest);
      return { key, bytes: st.size };
    },

    async stat(key) {
      const st = await fsp.stat(fileOf(key)).catch(() => null);
      return st && st.isFile() ? { key, bytes: st.size, modifiedAt: st.mtimeMs } : null;
    },

    /** The whole object in memory. For small files only (tests, photos). */
    async get(key) {
      return fsp.readFile(fileOf(key)).catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
    },

    /** A Readable of the bytes, or of [start, end] inclusive. */
    stream(key, range) {
      const opts = range ? { start: range.start, end: range.end } : {};
      return fs.createReadStream(fileOf(key), opts);
    },

    async delete(key) {
      const f = fileOf(key);
      try {
        await fsp.unlink(f);
      } catch (_) {
        return false;
      }
      await pruneDirs(path.dirname(f));
      return true;
    },

    /** Deletes every object under prefix ("identity/12/"). Returns how many. */
    async deletePrefix(prefix) {
      const dir = dirOf(prefix);
      const files = await walk(dir);
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      await pruneDirs(path.dirname(dir));
      return files.length;
    },

    /** How many objects sit under prefix. */
    async countPrefix(prefix) {
      return (await walk(dirOf(prefix))).length;
    },

    /** The next path segment of every key under prefix ("renders/" → ["7", "9"]). */
    async children(prefix) {
      let entries = [];
      try { entries = await fsp.readdir(dirOf(prefix), { withFileTypes: true }); } catch (_) { return []; }
      return entries.map((e) => e.name).filter((n) => !n.includes(".part-"));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Backend choice                                                       */
/* ------------------------------------------------------------------ */

const BACKENDS = { local: localBackend };

let active = null;
function backend() {
  if (!active) {
    const want = String(process.env.MEDIA_BACKEND || "local").toLowerCase();
    const make = BACKENDS[want];
    // Fail loudly: silently falling back to the local disk would write
    // users' videos somewhere nobody configured, and lose them on the
    // move to object storage.
    if (!make) throw new Error(`MEDIA_BACKEND=${want} is not implemented (have: ${Object.keys(BACKENDS).join(", ")})`);
    active = make();
  }
  return active;
}

/* ------------------------------------------------------------------ */
/* HTTP: one Range-capable sender for every video route                 */
/* ------------------------------------------------------------------ */

/**
 * Streams key to res with byte ranges (206/416), the same three forms the
 * admin Recordings player needs: "bytes=a-b", "bytes=a-" and "bytes=-n".
 * Without Range a <video> can play from the start but cannot seek.
 *
 * @param {object} o  { type, filename, download, cache }
 * @returns {Promise<boolean>} false when the object does not exist (the
 *   caller answers 404/410 itself — nothing has been written yet).
 */
async function send(req, res, key, o = {}) {
  const st = await stat(key);
  if (!st) return false;
  const size = st.bytes;
  const safe = String(o.filename || "video.mp4").replace(/[^\w .\-]+/g, "_").slice(0, 80);
  res.setHeader("Content-Type", o.type || "video/mp4");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", o.cache || "private, max-age=600");
  res.setHeader("Content-Disposition", `${o.download ? "attachment" : "inline"}; filename="${safe}"`);

  const pipeOut = (range) =>
    pipeline(stream(key, range), res).catch(() => {
      // The browser abandoning a seek is ordinary; a vanished file after
      // the stat is not worth a crash either.
      if (!res.headersSent) res.status(410).end();
      else res.destroy();
    });

  const m = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/.exec(String(req.headers.range || ""));
  if (!m) {
    res.setHeader("Content-Length", size);
    await pipeOut(null);
    return true;
  }
  let start, end;
  if (m[3] !== undefined) {
    const n = parseInt(m[3], 10);
    if (!n) {
      res.setHeader("Content-Range", `bytes */${size}`);
      res.status(416).end();
      return true;
    }
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] ? parseInt(m[2], 10) : size - 1;
  }
  if (end >= size) end = size - 1;
  if (!Number.isFinite(start) || start > end || start >= size) {
    res.setHeader("Content-Range", `bytes */${size}`);
    res.status(416).end();
    return true;
  }
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  res.setHeader("Content-Length", end - start + 1);
  await pipeOut({ start, end });
  return true;
}

/* ------------------------------------------------------------------ */

const put = (key, src) => backend().put(checkKey(key), src);
const stat = (key) => backend().stat(checkKey(key));
const get = (key) => backend().get(checkKey(key));
const stream = (key, range) => backend().stream(checkKey(key), range || null);
const del = (key) => backend().delete(checkKey(key));
const deletePrefix = (prefix) => backend().deletePrefix(checkPrefix(prefix));
const countPrefix = (prefix) => backend().countPrefix(checkPrefix(prefix));
const children = (prefix) => backend().children(checkPrefix(prefix));

/** True for a key this module would accept — for values read from rows. */
function isKey(key) {
  try { checkKey(key); return true; } catch (_) { return false; }
}

module.exports = {
  put, get, stat, stream, delete: del, deletePrefix, countPrefix, children,
  send, newId, isKey, MediaKeyError,
  backendName: () => backend().name,
};
