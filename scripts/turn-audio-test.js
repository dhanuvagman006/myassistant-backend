/**
 * TURN AUDIO (2026-10-01): a consenting tester's Live turn is stored as
 * one stereo WAV in live_recordings, the admin list carries its words,
 * a non-consenting user's turn is dropped, and "help improve" OFF
 * deletes what was stored. Needs DATABASE_URL (the local test DB).
 */
const assert = require("assert");
const fs = require("fs");
process.env.LIVE_RECORD_DIR = process.env.LIVE_RECORD_DIR ||
  require("path").join(require("os").tmpdir(), "hari-turn-audio-test");

(async () => {
  const db = require("../src/db");
  await db.migrate?.();
  const turnAudio = require("../src/live/turnAudio");
  const recorder = require("../src/live/recorder");
  const helpImprove = require("../src/users/helpImprove");
  const recent = require("../src/memory/recent");
  const u = await db.createUser({ email: `turn-audio-${Date.now()}@example.test`, name: "Turn Audio" });
  const uid = u.id;
  let passed = 0;
  const ok = (what) => { passed++; console.log("  ok ", what); };
  const tone = (rate, secs, k) => {
    const b = Buffer.alloc(rate * 2 * secs);
    for (let i = 0; i < rate * secs; i++) b.writeInt16LE(Math.round(6000 * Math.sin(i / k)), i * 2);
    return b;
  };
  try {
    // 1. not opted in: nothing stored
    const none = await turnAudio.save(uid, { turnId: "t-no", userPcm: tone(16000, 1, 9), agentPcm: tone(24000, 1, 7) });
    assert.strictEqual(none, null);
    ok("no consent: the turn is not kept");

    // 2. opted in: one WAV row, playable, listed with its words
    await helpImprove.set(uid, true, { source: "turn-audio-test" });
    const turnId = "t-" + Date.now();
    await recent.append(uid, "user", "what is the weather", { source: "ai-live", turnId, sessionId: "s1" });
    await recent.append(uid, "assistant", "Sunny, 29 degrees.", { source: "ai-live", turnId, sessionId: "s1", latencyMs: 900 });
    const id = await turnAudio.save(uid, {
      turnId, userPcm: tone(16000, 2, 9), userRate: 16000, agentPcm: tone(24000, 3, 7), agentRate: 24000,
    });
    assert.ok(id > 0, "a row id");
    const row = await recorder.get(id);
    assert.strictEqual(row.format, "wav");
    const head = fs.readFileSync(row.file).subarray(0, 44);
    assert.strictEqual(head.toString("ascii", 0, 4), "RIFF");
    assert.strictEqual(head.readUInt16LE(22), 2, "stereo");
    assert.strictEqual(head.readUInt32LE(24), 24000);
    assert.ok(row.duration_ms >= 5200 && row.duration_ms <= 5400, `2 s + gap + 3 s, got ${row.duration_ms}`);
    ok("consent: one stereo 24 kHz WAV, 5.3 s");
    const listed = (await recorder.list({ userId: uid })).find((r) => r.id === id);
    assert.ok(listed, "listed for the admin");
    assert.strictEqual(listed.question, "what is the weather");
    assert.strictEqual(listed.answer, "Sunny, 29 degrees.");
    ok("the admin list carries the turn's words");
    const conv = (await recent.adminConversations({ userId: uid })).find((c) => c.answer === "Sunny, 29 degrees.");
    assert.strictEqual(Number(conv.audio_id), Number(id));
    ok("the conversations row points at its audio");

    // 3. the same turn again: not duplicated
    const dup = await turnAudio.save(uid, { turnId, userPcm: tone(16000, 1, 9), agentPcm: tone(24000, 1, 7) });
    assert.strictEqual(dup, null);
    ok("a repeated upload of the same turn is ignored");

    // 4. switching "help improve" off deletes it
    await helpImprove.set(uid, false, { source: "turn-audio-test" });
    await helpImprove.applyOptOut(uid);
    assert.strictEqual(await recorder.get(id), null);
    assert.ok(!fs.existsSync(row.file), "the file is gone");
    ok("help improve OFF removes the audio");
  } finally {
    await require("../src/routes/privacy").deleteUserEverywhere(uid, { reason: "turn-audio-test" }).catch(() => {});
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
