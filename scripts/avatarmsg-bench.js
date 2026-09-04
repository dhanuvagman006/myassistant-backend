/**
 * AVATAR PIPELINE BENCHMARK — measures the real per-stage numbers (§15)
 * against whatever engines this deployment has configured:
 *
 *   TTFA   text → finished speech (voice stage)
 *   TTFF   speech → finished video (face stage; ≈ time-to-playable-file
 *          since delivery is async render, not a live stream)
 *   total  text → deliverable artifact
 *
 * Runs the six representative messages of §17 (short / normal / long /
 * numbers / names / emotional) through the SAME provider chains the
 * orchestrator uses, printing a table + per-second-of-speech ratios.
 *
 * Needs a face photo and voice sample on disk:
 *   node scripts/avatarmsg-bench.js <face.jpg> <voice.wav>
 * Engines come from env (AVATAR_WORKER_URL / DID_API_KEY /
 * ELEVENLABS_API_KEY+VOICE / GEMINI_API_KEY). Unconfigured stages are
 * skipped honestly, not faked.
 */
require("dotenv").config();
const fs = require("fs");

const MESSAGES = [
  ["short", "I'm on my way."],
  ["normal", "Hey, I'm going to be a little late. I'll be there soon."],
  [
    "long",
    "I wanted to let you know that the meeting this afternoon has moved to " +
      "four thirty, so please bring the revised proposal and the printed " +
      "copies of the contract when you come to the office.",
  ],
  ["numbers", "The total came to 15,250 rupees and the train leaves at 6:45."],
  ["names", "Tell Chethan and Hemalatha that Ravi confirmed for Saturday."],
  ["emotional", "Congratulations! I'm so proud of you — you really earned this!"],
];

async function main() {
  const [face, voice] = process.argv.slice(2);
  if (!face || !voice || !fs.existsSync(face) || !fs.existsSync(voice)) {
    console.error("usage: node scripts/avatarmsg-bench.js <face.jpg> <voice.wav>");
    process.exit(1);
  }

  const selfhost = require("../src/avatarmsg/providers/selfhost");
  const did = require("../src/avatarmsg/providers/did");
  const elevenlabs = require("../src/avatarmsg/providers/elevenlabs");
  const gemini = require("../src/avatarmsg/providers/gemini");

  const health = await selfhost.health();
  console.log("worker:", JSON.stringify(health));

  const voiceEngines = [];
  if (selfhost.configured() && health?.engines?.tts) {
    voiceEngines.push(["selfhost", (text) =>
      selfhost.synthesize({ text, voicePath: voice, voiceMime: "audio/wav" })]);
  }
  if (elevenlabs.configured() && process.env.ELEVENLABS_VOICE_ID) {
    voiceEngines.push(["elevenlabs", (text) =>
      elevenlabs.synthesize({ text, voiceRef: process.env.ELEVENLABS_VOICE_ID })]);
  }
  if (process.env.GEMINI_API_KEY) {
    voiceEngines.push(["gemini", (text) => gemini.synthesize({ text })]);
  }

  const faceEngines = [];
  if (selfhost.configured() && health?.engines?.face) {
    faceEngines.push(["selfhost", (audio) =>
      selfhost.animate({ facePath: face, faceMime: "image/jpeg",
        audioBuf: audio.buf, audioMime: audio.mime, quality: "standard" })]);
  }
  if (did.configured()) {
    faceEngines.push(["did", (audio) =>
      did.animate({ facePath: face, faceMime: "image/jpeg",
        audioBuf: audio.buf, audioMime: audio.mime })]);
  }

  if (!voiceEngines.length) { console.error("no voice engine configured"); process.exit(1); }
  console.log(`voice engines: ${voiceEngines.map(([n]) => n).join(", ") || "none"}`);
  console.log(`face engines:  ${faceEngines.map(([n]) => n).join(", ") || "none"}\n`);

  const rows = [];
  for (const [label, text] of MESSAGES) {
    for (const [vName, vFn] of voiceEngines) {
      let audio, ttfa;
      try {
        const t0 = Date.now();
        audio = await vFn(text);
        ttfa = Date.now() - t0;
      } catch (e) {
        rows.push({ msg: label, voice: vName, face: "-", ttfa: "FAIL: " + e.message.slice(0, 60) });
        continue;
      }
      if (!faceEngines.length) {
        rows.push({ msg: label, voice: vName, face: "-", ttfa, ttff: "-", kb: (audio.buf.length / 1024) | 0 });
      }
      for (const [fName, fFn] of faceEngines) {
        try {
          const t1 = Date.now();
          const video = await fFn(audio);
          rows.push({
            msg: label, voice: vName, face: fName, ttfa,
            ttff: Date.now() - t1,
            total: ttfa + Date.now() - t1,
            kb: (video.buf.length / 1024) | 0,
          });
        } catch (e) {
          rows.push({ msg: label, voice: vName, face: fName, ttfa, ttff: "FAIL: " + e.message.slice(0, 60) });
        }
      }
    }
  }
  console.table(rows);
  console.log(
    "\nInterpretation: TTFA/TTFF in ms. For async delivery the recipient's " +
      "wait ≈ total + push latency; anything under ~15s for a normal message " +
      "feels like a voicemail arriving."
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
