/**
 * HEARING A LIVE TURN (2026-10-01).
 * ---------------------------------
 * Since the AI Logic migration the live voice runs phone ↔ Gemini and
 * this server only ever sees the transcript — which is exactly what the
 * recorder's header warns about: every hard voice bug so far looked fine
 * in text. Owner: "I need to hear their conversation between user and
 * agent, they are our test users."
 *
 * So the PHONE keeps both halves of a turn — the microphone audio it fed
 * to Live and the audio Live spoke back — and, when the user has said yes
 * to "help improve", posts them here when the turn is recorded. One row
 * per turn goes into the same `live_recordings` table the old proxied
 * calls used, so the admin panel's Recordings page, the "help improve"
 * switch-off (deletes them), account erasure and the retention prune all
 * apply without a second code path.
 *
 * THE FILE: one WAV, stereo, 24 kHz — the user on the LEFT channel, then
 * the assistant on the RIGHT, in the order they happened. The microphone
 * is 16 kHz; it is resampled by linear interpolation, which is plenty for
 * a reviewer's ear. A WAV needs no ffmpeg and plays in every browser.
 *
 * CONSENT GATE: nothing is written unless helpImprove.allowsReview(uid) —
 * the same rule as the call recorder. The app checks its own copy of the
 * switch before uploading; this is the server's own check.
 */
const fs = require("fs");
const path = require("path");
const { query } = require("../db");
const recorder = require("./recorder");

const OUT_RATE = 24000;
const GAP_MS = 300;                       // between his words and hers
const MAX_IN_BYTES = 6 * 1024 * 1024;     // per side, after the route's own cap

/** Int16 little-endian PCM → Float32 samples. */
function toSamples(buf) {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

/** Linear-interpolation resample. Identity when the rates match. */
function resample(samples, from, to) {
  if (from === to || samples.length === 0) return samples;
  const n = Math.floor(samples.length * to / from);
  const out = new Float32Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const f = x - i0;
    out[i] = samples[i0] * (1 - f) + samples[i1] * f;
  }
  return out;
}

/**
 * The stereo WAV: user left, then the assistant right.
 * Returns { wav: Buffer, durationMs }.
 */
function buildWav({ userPcm, userRate = 16000, agentPcm, agentRate = 24000 }) {
  const user = resample(toSamples(userPcm || Buffer.alloc(0)), userRate, OUT_RATE);
  const agent = resample(toSamples(agentPcm || Buffer.alloc(0)), agentRate, OUT_RATE);
  const gap = user.length && agent.length ? Math.floor(OUT_RATE * GAP_MS / 1000) : 0;
  const frames = user.length + gap + agent.length;
  const data = Buffer.alloc(frames * 4);
  const put = (frame, ch, v) => {
    const s = Math.max(-1, Math.min(1, v));
    data.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), frame * 4 + ch * 2);
  };
  for (let i = 0; i < user.length; i++) put(i, 0, user[i]);
  const off = user.length + gap;
  for (let i = 0; i < agent.length; i++) put(off + i, 1, agent[i]);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);        // PCM chunk size
  header.writeUInt16LE(1, 20);         // PCM
  header.writeUInt16LE(2, 22);         // stereo
  header.writeUInt32LE(OUT_RATE, 24);
  header.writeUInt32LE(OUT_RATE * 4, 28);
  header.writeUInt16LE(4, 32);         // block align
  header.writeUInt16LE(16, 34);        // bits
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return { wav: Buffer.concat([header, data]), durationMs: Math.round(frames * 1000 / OUT_RATE) };
}

/** The row key: one per Live turn, whatever session it rode on. */
function sessionKey(turnId) {
  return `turn:${String(turnId).replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 80)}`;
}

/**
 * Stores one turn's audio for a consenting user. Returns the row id, or
 * null when the user has not opted in, the audio is empty, or this turn
 * was already stored. Never throws for a caller's sake beyond bad input.
 */
async function save(userId, { turnId, userPcm, userRate, agentPcm, agentRate, startedAt }) {
  const uid = Number(userId);
  if (!(uid > 0) || !turnId) return null;
  if ((userPcm && userPcm.length > MAX_IN_BYTES) || (agentPcm && agentPcm.length > MAX_IN_BYTES)) {
    throw new Error("audio too large");
  }
  if (!(userPcm && userPcm.length >= 3200) && !(agentPcm && agentPcm.length >= 3200)) return null;
  if (!await require("../users/helpImprove").allowsReview(uid)) return null;
  await recorder.migrate();
  const { wav, durationMs } = buildWav({ userPcm, userRate, agentPcm, agentRate });
  const at = Number(startedAt) > 0 ? Number(startedAt) : Date.now();
  const day = new Date(at).toISOString().slice(0, 10);
  const dir = path.join(recorder.ROOT, day);
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `turn-${uid}-${at}-${Math.random().toString(36).slice(2, 8)}.wav`);
  await fs.promises.writeFile(file, wav);
  const rows = await query(
    `INSERT INTO live_recordings (user_id, session_id, started_at, duration_ms, bytes, file, format, turns, state)
     VALUES ($1, $2, $3, $4, $5, $6, 'wav', 1, 'ready')
     ON CONFLICT (session_id) DO NOTHING
     RETURNING id`,
    [uid, sessionKey(turnId), at, durationMs, wav.length, file]
  );
  if (!rows.length) {
    await fs.promises.unlink(file).catch(() => {});
    return null;
  }
  return rows[0].id;
}

module.exports = { save, buildWav, resample, sessionKey, OUT_RATE };
