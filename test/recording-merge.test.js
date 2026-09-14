/**
 * Proves the recording pipeline produces a real, playable, correctly-timed
 * file — without needing anyone to make a call.
 *
 * Two synthetic tracks are laid down on the same wall-clock timeline the
 * recorder uses: the user speaks in the first two seconds, the assistant
 * answers from four to six. If the timeline maths or the ffmpeg filter
 * graph is wrong, the merged file comes out the wrong length, the wrong
 * number of channels, or with the two speakers on top of each other.
 *
 * Run inside the runtime image, which is where ffmpeg lives:
 *   node test/recording-merge.test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, execFileSync } = require("child_process");

const USER_RATE = 16000;
const AGENT_RATE = 24000;
const DURATION_MS = 6000;

let fail = 0;
function check(ok, label, detail) {
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

/** A sine burst, PCM16 mono, as the recorder would have written it. */
function tone(rate, seconds, hz) {
  const n = Math.floor(rate * seconds);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12000), i * 2);
  }
  return buf;
}

/** Byte offset of a moment, the way Track.offsetNow computes it. */
function offsetAt(ms, rate) {
  return Math.floor((ms * rate) / 1000) * 2;
}

function ffprobe(file, field) {
  return String(execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", field, "-of", "default=nw=1:nk=1", file,
  ])).trim();
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
  const userPcm = path.join(dir, "u.pcm");
  const agentPcm = path.join(dir, "a.pcm");
  const out = path.join(dir, "out.m4a");

  // The user speaks 0.0s–2.0s; the assistant answers 4.0s–6.0s. The gap is
  // never written at all — it is a hole in a sparse file.
  const uf = fs.openSync(userPcm, "w");
  fs.writeSync(uf, tone(USER_RATE, 2, 440), 0, USER_RATE * 2 * 2, offsetAt(0, USER_RATE));
  fs.ftruncateSync(uf, offsetAt(DURATION_MS, USER_RATE));
  fs.closeSync(uf);

  const af = fs.openSync(agentPcm, "w");
  fs.writeSync(af, tone(AGENT_RATE, 2, 880), 0, AGENT_RATE * 2 * 2, offsetAt(4000, AGENT_RATE));
  fs.ftruncateSync(af, offsetAt(DURATION_MS, AGENT_RATE));
  fs.closeSync(af);

  check(fs.statSync(userPcm).size === offsetAt(DURATION_MS, USER_RATE),
    "user track is exactly 6s of 16 kHz PCM",
    fs.statSync(userPcm).size + " bytes");
  check(fs.statSync(agentPcm).size === offsetAt(DURATION_MS, AGENT_RATE),
    "assistant track is exactly 6s of 24 kHz PCM",
    fs.statSync(agentPcm).size + " bytes");

  // A hole costs no disk: the 4 seconds of silence before the assistant
  // speaks should occupy far fewer blocks than its apparent length.
  const st = fs.statSync(agentPcm);
  check(st.blocks * 512 < st.size,
    "silence is a hole, not bytes on disk",
    `${st.size} apparent vs ${st.blocks * 512} allocated`);

  await new Promise((resolve, reject) => {
    execFile("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "s16le", "-ar", String(USER_RATE), "-ac", "1", "-i", userPcm,
      "-f", "s16le", "-ar", String(AGENT_RATE), "-ac", "1", "-i", agentPcm,
      "-filter_complex", `[0:a]aresample=${AGENT_RATE}[u];[u][1:a]amerge=inputs=2[a]`,
      "-map", "[a]", "-ac", "2", "-c:a", "aac", "-b:a", "32k",
      "-movflags", "+faststart", out,
    ], { timeout: 120_000 }, (err, _o, stderr) =>
      err ? reject(new Error(String(stderr || err.message))) : resolve());
  }).catch((e) => {
    check(false, "ffmpeg merge succeeds", e.message.slice(0, 200));
    console.log(fail ? `\n${fail} FAILURES` : "");
    process.exit(1);
  });

  check(fs.existsSync(out) && fs.statSync(out).size > 0, "merged file exists",
    fs.statSync(out).size + " bytes");
  check(ffprobe(out, "stream=channels") === "2", "merged file is stereo",
    "channels=" + ffprobe(out, "stream=channels"));
  check(ffprobe(out, "stream=codec_name") === "aac", "codec is AAC",
    ffprobe(out, "stream=codec_name"));

  const dur = parseFloat(ffprobe(out, "format=duration"));
  check(Math.abs(dur - DURATION_MS / 1000) < 0.25,
    "duration matches the wall clock, silence included", dur.toFixed(3) + "s");

  // The whole point of two channels: the user's voice must be on the left
  // in the first half and the assistant's on the right in the second, not
  // both smeared across each other.
  const vols = (side, ch) => {
    const txt = String(execFileSync("ffmpeg", [
      "-hide_banner", "-v", "error", "-i", out,
      "-af", `pan=mono|c0=c${ch},atrim=${side},volumedetect`,
      "-f", "null", "-",
    ], { stdio: ["ignore", "ignore", "pipe"] }));
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(txt);
    return m ? parseFloat(m[1]) : null;
  };
  const leftEarly = vols("0:2", 0), leftLate = vols("4:6", 0);
  const rightEarly = vols("0:2", 1), rightLate = vols("4:6", 1);
  check(leftEarly !== null && leftEarly > (leftLate ?? 0) + 20,
    "the user is on the left, only while speaking",
    `0-2s ${leftEarly} dB vs 4-6s ${leftLate} dB`);
  check(rightLate !== null && rightLate > (rightEarly ?? 0) + 20,
    "the assistant is on the right, only while speaking",
    `4-6s ${rightLate} dB vs 0-2s ${rightEarly} dB`);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILURES` : "\nall pass");
  process.exit(fail ? 1 : 0);
})();
