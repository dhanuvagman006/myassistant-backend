/**
 * LIVE CALL RECORDING — hearing what the transcript cannot show.
 * -------------------------------------------------------------
 * A transcript tells you what the recogniser THOUGHT it heard. It does
 * not tell you that the user trailed off, that two people were talking,
 * that the assistant spoke over them, or that "Love illah" was a clear
 * sentence badly recognised. Every hard bug in this product so far has
 * been diagnosed from a transcript that looked fine.
 *
 * So both halves of a live call are written to disk as they pass through
 * the proxy, and the admin panel plays them back.
 *
 * THE TIMELINE IS WALL-CLOCK, NOT ARRIVAL ORDER. Each chunk is written at
 * the byte offset matching the moment it belongs to, so a thirty-second
 * silence is thirty seconds of silence on playback rather than being
 * edited out. The files are sparse: a gap costs no disk at all, because
 * a hole in a file reads back as zeroes, and zeroes in PCM are silence.
 *
 * The two sides stay separate until the end — the user on the left
 * channel, the assistant on the right — which is what makes an interrupt
 * audible as an interrupt instead of a jumble.
 *
 * NOTHING HERE MAY BREAK A CALL. Every path is wrapped and every failure
 * is logged and swallowed. A recording is worth exactly nothing compared
 * to the conversation it is recording. Concretely that means: writes are
 * batched so the call's audio path is not competing with this for libuv's
 * four threads, the in-flight queue is bounded so a stalled disk drops
 * audio instead of growing without limit, and the ffmpeg merge runs one
 * at a time on a single thread because the pod's whole CPU budget is
 * 500m and live calls are sharing it.
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { query, run } = require("../db");

const ENABLED = String(process.env.LIVE_RECORD ?? "1") !== "0";
const ROOT = process.env.LIVE_RECORD_DIR || "/app/data/recordings";

/** The two ends of the call arrive at different rates. */
const USER_RATE = 16000; // mic, PCM16 mono, as the app captures it
const AGENT_RATE = 24000; // Gemini's reply, PCM16 mono
const BYTES_PER_SAMPLE = 2;

/** A runaway session must not fill the disk. */
const MAX_MINUTES = Number(process.env.LIVE_RECORD_MAX_MIN || 90);

/** How long a recording is kept, and the ceiling on all of them together. */
const KEEP_DAYS = Number(process.env.LIVE_RECORD_KEEP_DAYS || 14);
const MAX_TOTAL_MB = Number(process.env.LIVE_RECORD_MAX_MB || 2048);

/**
 * Speech, two channels. The two channels here are the least correlated
 * pair a stereo coder can be handed — two different people — so this is
 * higher than a single-voice recording would need. AAC in .m4a because it
 * is the one format every browser plays without a plugin.
 */
const BITRATE = process.env.LIVE_RECORD_BITRATE || "48k";

/** Batch writes into blocks instead of one syscall per 20 ms of audio. */
const FLUSH_BYTES = 64 * 1024;

/** A stalled disk drops audio rather than growing a queue without limit. */
const MAX_INFLIGHT = 4 * 1024 * 1024;

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS live_recordings (
        id          BIGSERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        session_id  TEXT NOT NULL,
        started_at  BIGINT NOT NULL,
        duration_ms BIGINT NOT NULL DEFAULT 0,
        bytes       BIGINT NOT NULL DEFAULT 0,
        file        TEXT NOT NULL DEFAULT '',
        format      TEXT NOT NULL DEFAULT 'm4a',
        turns       INTEGER NOT NULL DEFAULT 0,
        state       TEXT NOT NULL DEFAULT 'recording'
      );
      CREATE INDEX IF NOT EXISTS idx_liverec_user ON live_recordings(user_id, id DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_liverec_session ON live_recordings(session_id);
    `).catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

/* ------------------------------------------------------------------ *
 * One stream — the user's half or the assistant's half
 * ------------------------------------------------------------------ */

/**
 * A single mono PCM track written on a wall-clock timeline.
 *
 * `pos` is how far the track has been filled. A chunk goes at whichever
 * is LATER: where the clock says it belongs, or the end of what is
 * already there. That second case is the one that matters — Gemini
 * streams a whole spoken sentence down in a burst far faster than real
 * time, and placing each chunk by its arrival instant would stack a
 * three-second reply into a quarter-second of garbage. Appending keeps
 * the sentence intact; the clock only decides where the NEXT sentence,
 * after a pause, begins.
 *
 * Because appending runs AHEAD of the clock, `pos` has to be brought back
 * whenever the audio it represents stops being real — see rollbackTo(),
 * which is what a barge-in needs.
 */
class Track {
  constructor(file, rate) {
    this.file = file;
    this.rate = rate;
    this.pos = 0;
    this.fh = null;
    this.queue = Promise.resolve();
    this.inflight = 0;
    this.failed = false;
    // The unflushed run: contiguous chunks, and where the run starts.
    this.buf = [];
    this.bufBytes = 0;
    this.bufAt = 0;
  }

  get bytesPerSecond() {
    return this.rate * BYTES_PER_SAMPLE;
  }

  async open() {
    this.fh = await fsp.open(this.file, "w");
  }

  /** Byte offset of a moment, rounded down to a whole sample. */
  offsetAt(elapsedMs) {
    const ms = Math.max(0, elapsedMs);
    return Math.floor((ms * this.rate) / 1000) * BYTES_PER_SAMPLE;
  }

  /**
   * @param buf        PCM16 bytes
   * @param elapsedMs  how long into the call they belong, taken when the
   *                   frame ARRIVED, not when it reached this queue
   */
  write(buf, elapsedMs) {
    if (!this.fh || this.failed || !buf || !buf.length) return;
    // Half a sample is not a sample. One odd-length frame would shift
    // every byte after it by one and turn the rest of the track into
    // noise, so the stray byte is dropped rather than carried.
    if (buf.length % BYTES_PER_SAMPLE) buf = buf.subarray(0, buf.length - 1);
    if (!buf.length) return;

    const at = Math.max(this.offsetAt(elapsedMs), this.pos);
    // A chunk that does not continue the buffered run starts a new one.
    if (this.bufBytes && this.bufAt + this.bufBytes !== at) this.flush();
    if (!this.bufBytes) this.bufAt = at;
    this.buf.push(buf);
    this.bufBytes += buf.length;
    this.pos = at + buf.length;
    if (this.bufBytes >= FLUSH_BYTES) this.flush();
  }

  /** Hands the buffered run to the filesystem, at its own offset. */
  flush() {
    if (!this.bufBytes || !this.fh || this.failed) {
      this.buf = [];
      this.bufBytes = 0;
      return;
    }
    const block = this.buf.length === 1 ? this.buf[0] : Buffer.concat(this.buf, this.bufBytes);
    const at = this.bufAt;
    this.buf = [];
    this.bufBytes = 0;

    if (this.inflight + block.length > MAX_INFLIGHT) {
      // The disk is not keeping up. Losing the rest of this recording is
      // the correct outcome; queueing until the pod is OOM-killed is not.
      this.failed = true;
      console.warn(`recorder: ${path.basename(this.file)} dropped — write queue full`);
      return;
    }
    this.inflight += block.length;
    this.queue = this.queue
      .then(() => this.fh.write(block, 0, block.length, at))
      .catch((e) => {
        if (!this.failed) {
          this.failed = true;
          console.warn("recorder: write failed —", e.message);
        }
      })
      .finally(() => { this.inflight -= block.length; });
  }

  /**
   * Throws away everything after a moment — the reply the user talked
   * over, which nobody ever heard.
   *
   * Without this the unplayed tail stays in the file AND `pos` stays past
   * the clock, so every later sentence is pushed further out of step and
   * the two channels drift apart for the rest of the call.
   */
  async rollbackTo(elapsedMs) {
    if (!this.fh || this.failed) return;
    this.buf = [];
    this.bufBytes = 0;
    const at = this.offsetAt(elapsedMs);
    if (at >= this.pos) return;
    this.pos = at;
    try {
      await this.queue;
      await this.fh.truncate(at);
    } catch (e) {
      console.warn("recorder: rollback failed —", e.message);
    }
  }

  /** Fix the track to an exact length so both sides line up for merging. */
  async close(durationMs) {
    if (!this.fh) return;
    this.flush();
    try {
      await this.queue;
      // Authoritative in BOTH directions. Padding alone left the agent
      // track longer than the call, because appending runs ahead of the
      // clock — and merge() assumes the two files are the same duration.
      const want = this.offsetAt(durationMs);
      if (want !== this.pos) await this.fh.truncate(want);
      this.pos = want;
    } catch (e) {
      console.warn("recorder: close failed —", e.message);
    }
    try { await this.fh.close(); } catch (_) {}
    this.fh = null;
  }
}

/* ------------------------------------------------------------------ *
 * One recording
 * ------------------------------------------------------------------ */

/** Every recording currently open, so a deploy can finish them. */
const live = new Set();

class Recording {
  constructor(userId, sessionId) {
    this.userId = Number(userId) || 0;
    this.sessionId = String(sessionId || "");
    this.startedAt = Date.now();
    this.turns = 0;
    this.stopped = false;
    this.dir = "";
    this.out = "";
    this.user = null;
    this.agent = null;
  }

  elapsed(nowMs) {
    return (nowMs || Date.now()) - this.startedAt;
  }

  get expired() {
    return this.elapsed() > MAX_MINUTES * 60_000;
  }

  async start() {
    const day = new Date(this.startedAt).toISOString().slice(0, 10);
    this.dir = path.join(ROOT, day);
    await fsp.mkdir(this.dir, { recursive: true });
    const stem = path.join(this.dir, safeName(this.sessionId));
    this.user = new Track(stem + ".user.pcm", USER_RATE);
    this.agent = new Track(stem + ".agent.pcm", AGENT_RATE);
    this.out = stem + ".m4a";
    await Promise.all([this.user.open(), this.agent.open()]);
    try {
      await migrate();
      await run(
        `INSERT INTO live_recordings (user_id, session_id, started_at, file, state)
              VALUES ($1, $2, $3, $4, 'recording')`,
        [this.userId, this.sessionId, this.startedAt, this.out]
      );
    } catch (e) {
      // The handles are already open; leaving them dangling would leak a
      // file descriptor and two files for the life of the process.
      await this.user.close(0).catch(() => {});
      await this.agent.close(0).catch(() => {});
      await this.cleanupRaw();
      throw e;
    }
    live.add(this);
  }

  addUser(buf, atMs) {
    if (this.stopped || this.expired) return;
    this.user.write(buf, this.elapsed(atMs));
  }

  addAgent(buf, atMs) {
    if (this.stopped || this.expired) return;
    this.agent.write(buf, this.elapsed(atMs));
  }

  /** The user talked over the reply: drop what was never spoken aloud. */
  interrupted(atMs) {
    if (this.stopped) return Promise.resolve();
    return this.agent.rollbackTo(this.elapsed(atMs)).catch(() => {});
  }

  countTurn() {
    this.turns++;
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    live.delete(this);
    // Capture stops at MAX_MINUTES, so the output must stop there too —
    // otherwise a socket left open overnight pads both tracks to twelve
    // hours of silence and hands ffmpeg a day's work.
    const durationMs = Math.min(this.elapsed(), MAX_MINUTES * 60_000);
    await this.user.close(durationMs);
    await this.agent.close(durationMs);

    // A socket that opened and closed with nobody speaking is not a
    // conversation; leaving those around buries the real ones.
    if (this.user.pos < this.user.bytesPerSecond &&
        this.agent.pos < this.agent.bytesPerSecond) {
      await this.discard();
      return;
    }

    try {
      await merge(this.user.file, this.agent.file, this.out);
      const st = await fsp.stat(this.out);
      await run(
        `UPDATE live_recordings
            SET duration_ms = $2, bytes = $3, turns = $4, state = 'ready'
          WHERE session_id = $1`,
        [this.sessionId, durationMs, st.size, this.turns]
      );
      await this.cleanupRaw();
    } catch (e) {
      console.warn("recorder: merge failed —", e.message);
      await run(
        `UPDATE live_recordings SET state = 'failed', duration_ms = $2
          WHERE session_id = $1`, [this.sessionId, durationMs]
      ).catch(() => {});
      // ffmpeg runs with -y, so a mid-encode failure leaves a partial
      // file that nothing else would ever remove.
      await fsp.unlink(this.out).catch(() => {});
      await this.cleanupRaw();
    }
    prune().catch(() => {});
  }

  async cleanupRaw() {
    await Promise.all([
      this.user && fsp.unlink(this.user.file).catch(() => {}),
      this.agent && fsp.unlink(this.agent.file).catch(() => {}),
    ]);
  }

  async discard() {
    await this.cleanupRaw();
    await run(`DELETE FROM live_recordings WHERE session_id = $1`, [this.sessionId])
      .catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * Merge: two mono tracks at different rates -> one stereo file
 * ------------------------------------------------------------------ */

/**
 * ONE AT A TIME, ON ONE THREAD.
 *
 * This pod's CPU limit is 500m and it is relaying live audio for everyone
 * else while it encodes. Two people hanging up together must not turn
 * into two unbounded ffmpeg processes competing with the calls still in
 * progress, so every merge queues behind the last one.
 */
let mergeQueue = Promise.resolve();
function merge(userPcm, agentPcm, out) {
  const run = () => new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y", "-threads", "1",
        "-f", "s16le", "-ar", String(USER_RATE), "-ac", "1", "-i", userPcm,
        "-f", "s16le", "-ar", String(AGENT_RATE), "-ac", "1", "-i", agentPcm,
        // The user on the left, the assistant on the right. Both tracks
        // were fixed to the same DURATION before this ran, so amerge has
        // nothing to guess about once the 16 kHz side is resampled up.
        "-filter_complex",
        `[0:a]aresample=${AGENT_RATE}[u];[u][1:a]amerge=inputs=2[a]`,
        "-map", "[a]", "-ac", "2",
        "-c:a", "aac", "-b:a", BITRATE,
        "-movflags", "+faststart",
        out,
      ],
      { timeout: 180_000, maxBuffer: 1 << 20 },
      (err, _stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).slice(0, 300)));
        resolve(out);
      }
    );
  });
  const next = mergeQueue.then(run, run);
  // The queue must survive a failed merge, or one bad file blocks the rest.
  mergeQueue = next.catch(() => {});
  return next;
}

/* ------------------------------------------------------------------ *
 * Retention
 * ------------------------------------------------------------------ */

/**
 * Drops recordings past their keep-window, then the oldest survivors
 * until the total is back under the ceiling, then reclaims anything a
 * crashed or redeployed process left behind.
 *
 * The disk this lives on also holds the database and the published APK,
 * so "we ran out of space" would take the product down, not just the
 * recordings. The ceiling is not advisory.
 */
async function prune() {
  await migrate();
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  const old = await query(
    `SELECT id, file FROM live_recordings WHERE started_at < $1`, [cutoff]);
  for (const r of old) await remove(r.id, r.file);

  const rows = await query(
    `SELECT id, file, bytes FROM live_recordings
      WHERE state = 'ready' ORDER BY started_at ASC`, []);
  let total = rows.reduce((n, r) => n + Number(r.bytes || 0), 0);
  const ceiling = MAX_TOTAL_MB * 1024 * 1024;
  for (const r of rows) {
    if (total <= ceiling) break;
    await remove(r.id, r.file);
    total -= Number(r.bytes || 0);
  }

  await reclaimOrphans();
  await sweepEmptyDays();
}

/**
 * THE ROW IS NOT THE ONLY THING ON DISK.
 *
 * A row's `file` is the merged .m4a; the raw PCM either side of it is
 * deleted by the session that wrote it. A pod killed mid-call — which is
 * every deploy — never gets there, and nothing else was ever going to
 * look. The PCM is the big half: uncompressed, and about eighty times the
 * size of what it merges down to.
 *
 * No live session can own a .pcm older than the longest allowed call, so
 * age alone is a safe test.
 */
async function reclaimOrphans() {
  const staleBefore = Date.now() - (MAX_MINUTES + 10) * 60_000;
  let days = [];
  try { days = await fsp.readdir(ROOT); } catch (_) { return; }
  for (const day of days) {
    const dir = path.join(ROOT, day);
    let files = [];
    try { files = await fsp.readdir(dir); } catch (_) { continue; }
    for (const f of files) {
      if (!f.endsWith(".pcm")) continue;
      const full = path.join(dir, f);
      const st = await fsp.stat(full).catch(() => null);
      if (st && st.mtimeMs < staleBefore) {
        await fsp.unlink(full).catch(() => {});
        console.warn("recorder: reclaimed orphaned", f);
      }
    }
  }
  // Rows whose session never finished would otherwise sit in 'recording'
  // forever, invisible in the panel and never cleaned up.
  await run(
    `UPDATE live_recordings SET state = 'failed'
      WHERE state = 'recording' AND started_at < $1`, [staleBefore]
  ).catch(() => {});
}

/** Deletes one recording — the row AND the bytes. */
async function remove(id, file) {
  if (file) {
    await fsp.unlink(file).catch(() => {});
    // Belt and braces for a row that failed before its raw halves went.
    await fsp.unlink(file.replace(/\.m4a$/, ".user.pcm")).catch(() => {});
    await fsp.unlink(file.replace(/\.m4a$/, ".agent.pcm")).catch(() => {});
  }
  await run(`DELETE FROM live_recordings WHERE id = $1`, [id]).catch(() => {});
}

/** Day folders left behind once their recordings are gone. */
async function sweepEmptyDays() {
  try {
    for (const day of await fsp.readdir(ROOT)) {
      const dir = path.join(ROOT, day);
      const left = await fsp.readdir(dir).catch(() => null);
      if (left && !left.length) await fsp.rmdir(dir).catch(() => {});
    }
  } catch (_) { /* no directory yet */ }
}

/* ------------------------------------------------------------------ *
 * Reading, for the admin panel
 * ------------------------------------------------------------------ */

async function list({ userId, limit = 50, offset = 0 } = {}) {
  await migrate();
  const params = [];
  let where = "r.state = 'ready'";
  if (Number.isFinite(userId) && userId > 0) {
    params.push(userId);
    where += ` AND r.user_id = $${params.length}`;
  }
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  return query(
    `SELECT r.id, r.user_id, u.name AS user_name, r.session_id, r.started_at,
            r.duration_ms, r.bytes, r.turns, r.format
       FROM live_recordings r LEFT JOIN users u ON u.id = r.user_id
      WHERE ${where}
      ORDER BY r.started_at DESC LIMIT ${lim} OFFSET ${off}`,
    params
  );
}

async function get(id) {
  await migrate();
  const rows = await query(
    `SELECT id, user_id, session_id, file, bytes, duration_ms, started_at
       FROM live_recordings WHERE id = $1 AND state = 'ready'`, [Number(id) || 0]);
  return rows[0] || null;
}

/**
 * Deletes one recording on request — the bytes go too, not just the row.
 * Only a finished one: deleting a row mid-call would orphan the audio the
 * session is still about to write.
 */
async function destroy(id) {
  await migrate();
  const rows = await query(
    `SELECT id, file FROM live_recordings WHERE id = $1 AND state <> 'recording'`,
    [Number(id) || 0]);
  if (!rows.length) return false;
  await remove(rows[0].id, rows[0].file);
  await sweepEmptyDays();
  return true;
}

/** Everything on disk, in one number, for the panel's header. */
async function usage() {
  await migrate();
  const rows = await query(
    `SELECT count(*) FILTER (WHERE state = 'ready')::int AS n,
            COALESCE(sum(bytes) FILTER (WHERE state = 'ready'), 0)::bigint AS bytes,
            COALESCE(sum(duration_ms) FILTER (WHERE state = 'ready'), 0)::bigint AS ms,
            count(*) FILTER (WHERE state = 'failed')::int AS failed
       FROM live_recordings`, []);
  const u = rows[0] || { n: 0, bytes: 0, ms: 0, failed: 0 };
  return {
    count: Number(u.n || 0),
    bytes: Number(u.bytes || 0),
    ms: Number(u.ms || 0),
    failed: Number(u.failed || 0),
    keepDays: KEEP_DAYS,
    maxMb: MAX_TOTAL_MB,
    enabled: ENABLED,
  };
}

/* ------------------------------------------------------------------ *
 * Entry point used by the live proxy
 * ------------------------------------------------------------------ */

/**
 * Begins recording a live session, or returns null when recording is off
 * or the session is anonymous. Never throws: the caller is mid-call.
 *
 * Every timestamp is taken at the CALL SITE, the instant the frame
 * arrived — not inside the callback below, which may not run until the
 * directory has been made and the row inserted. Timing the audio by when
 * the bookkeeping finished would push the opening seconds of every call
 * out of step.
 */
function begin(userId, sessionId) {
  if (!ENABLED) return null;
  if (!(Number(userId) > 0) || !sessionId) return null;
  const rec = new Recording(userId, sessionId);
  const ready = rec.start().catch((e) => {
    console.warn("recorder: start failed —", e.message);
    rec.stopped = true;
    live.delete(rec);
  });
  return {
    user: (b) => { const t = Date.now(); ready.then(() => rec.addUser(b, t)).catch(() => {}); },
    agent: (b) => { const t = Date.now(); ready.then(() => rec.addAgent(b, t)).catch(() => {}); },
    interrupt: () => { const t = Date.now(); ready.then(() => rec.interrupted(t)).catch(() => {}); },
    turn: () => rec.countTurn(),
    stop: () => ready.then(() => rec.stop()).catch(() => {}),
  };
}

/**
 * Finishes every open recording. Called on SIGTERM, because a deploy is
 * the one thing guaranteed to interrupt calls: server.close() does not
 * close WebSockets, so without this every recording in flight during a
 * rollout is left as raw PCM with a row stuck on 'recording'.
 */
async function stopAll() {
  const open = [...live];
  if (!open.length) return;
  console.log(`recorder: finishing ${open.length} recording(s) before shutdown`);
  await Promise.allSettled(open.map((r) => r.stop()));
}

function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 90);
}

module.exports = {
  begin, stopAll, list, get, destroy, usage, prune, ENABLED, KEEP_DAYS,
};
