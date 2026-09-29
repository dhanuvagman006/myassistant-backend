/**
 * SEND MESSAGES AS YOU + VIDEO NOTES — `npm run test:videonotes`.
 *
 * The owner, 2026-09-26: the user reads a scrolling script to the front
 * camera for about 30 s and taps Save — "that should be saved on my
 * backend" — and later "send a video note for Danush saying he should
 * meet me at twelve PM" is made from it. No GPU yet: HE makes the clip in
 * Colab and uploads it in the admin panel, and it reaches Danush.
 *
 * These pin:
 *   - /avatar-profile: a user with nothing stored reads all false (never a
 *     404 — the app's screen spun forever on one); consent is enforced by
 *     the server before a byte is written; a new take replaces and deletes
 *     the old; length, type and size are checked; the switch cannot go on
 *     without consent and a video; Delete everything leaves nothing;
 *   - send_video_note: no video → one line saying to record it (and the
 *     screen on build 118+); read back before anything is queued; queued,
 *     never claimed as sent; never from a scheduled task;
 *   - the admin panel: the queue, the sender's video with byte ranges, and
 *     an upload that DELIVERS — to an app user's inbox (media fields the
 *     popup reads, avatar:'1' push, their own document) or, for someone
 *     not on the app, to the sender's documents;
 *   - withdrawing consent cancels what is waiting; kept clips go after 30
 *     days; deleting the account takes rows and files.
 *
 * And the review of 2026-09-26: consent is read again when a clip is
 * stored and when it is delivered (a failed note uploaded after a
 * withdrawal reached the recipient); nothing is uploaded until the owner
 * confirms the video is the account holder reading the consent sentence;
 * each upload has its own key; a queued note never backs "sent"; ten old
 * texts cannot hide a video note from the popup; an erased account's
 * face leaves the recipients' documents too.
 *
 * Pushes are stubbed and files live in a temp folder: nothing leaves this
 * machine.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key-0123456789";
// The 413 is reached with 1.5 MB instead of 121 (the default is pinned below).
process.env.AVATAR_VIDEO_MAX_MB = "1";

const os = require("os");
const fs = require("fs");
const path = require("path");

// Temp roots BEFORE any module reads them: never a real data folder.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "videonotes-test-"));
process.env.DATA_DIR = path.join(TMP, "data");
process.env.LIVE_RECORD_DIR = path.join(TMP, "recordings");
delete process.env.MEDIA_DIR;
delete process.env.MEDIA_BACKEND;
const MEDIA = path.join(TMP, "data", "media");

const assert = require("assert");
const express = require("express");
const db = require("../src/db");

// Every push is recorded, none is sent.
const push = require("../src/services/push");
const pushes = [];
push.send = async (token, title, body, data) => {
  pushes.push({ token, title, body, data });
  return { ok: true, stale: false, skipped: false, error: null };
};

// The account deletes at the end would tell Firebase about the numbers.
require("../src/services/firebase").deletePhoneUser = async () => "stubbed";

let passed = 0;
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
}

/** The smallest thing that passes for an MP4: an ftyp box, then padding. */
function mp4(bytes = 4096, fill = 0) {
  const b = Buffer.alloc(bytes, fill);
  b.writeUInt32BE(24, 0);
  b.write("ftyp", 4, "latin1");
  b.write("isom", 8, "latin1");
  return b;
}
const exists = (p) => fs.existsSync(p);
const filesIn = (dir) => {
  try { return fs.readdirSync(dir); } catch (_) { return []; }
};
const tmpUploads = () => filesIn(os.tmpdir()).filter((f) => /^(avatar|note)-\d+-.*\.upload$/.test(f));

(async () => {
  await db.init();
  await require("../src/routes/contacts").migrate();
  await require("../src/outcomes/store").migrate();

  const stamp = String(Date.now()).slice(-7);
  const PHONE = { S: `+91981${stamp}`, R: `+91982${stamp}`, N: `+91983${stamp}` };
  const mk = async (tag, name, phone) => {
    const u = await db.createUser({ email: `vn-${tag}-${stamp}@example.test`, name });
    if (phone) {
      await db.run(
        `UPDATE users SET phone_number = $2, phone_verified_at = $3, fcm_token = $4 WHERE id = $1`,
        [u.id, phone, Date.now(), `tok-${tag}-${stamp}`]);
    }
    return u.id;
  };
  const S = await mk("s", "Sita Test", PHONE.S); // the sender
  const R = await mk("r", "Danush Test", PHONE.R); // on the app
  const T = await mk("t", "Tara Test", null); // never records a video
  const E = await mk("e", "Erase Test", null); // deletes their account
  const USERS = [S, R, T, E];
  // S's address book: Danush is on the app, Nila is not.
  for (const [name, phone] of [["Danush", PHONE.R], ["Nila", PHONE.N]]) {
    await db.run(
      `INSERT INTO contacts (user_id, name, phone, updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, phone) DO NOTHING`, [S, name, phone, Date.now()]);
  }

  const as = (req, _res, next) => { req.user = { sub: String(req.get("x-test-user") || "") }; next(); };
  const app = express();
  app.use(express.json());
  app.use("/avatar-profile", as, require("../src/routes/avatarProfile"));
  app.use("/messages", as, require("../src/routes/messages"));
  app.use("/docs", as, require("../src/routes/docs"));
  app.use("/chat", as, require("../src/routes/chat"));
  app.use("/admin-panel", require("../src/routes/admin_web"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (uid, p, opts = {}) => fetch(`${base}${p}`, {
    ...opts,
    headers: {
      ...(opts.json ? { "content-type": "application/json" } : {}),
      ...(opts.headers || {}),
      "x-test-user": String(uid),
    },
    body: opts.json ? JSON.stringify(opts.json) : opts.body,
  });
  const profile = async (uid) => (await call(uid, "/avatar-profile")).json();
  async function uploadVideo(uid, { buf = mp4(), type = "video/mp4", duration = 30000, scriptVersion = 1 } = {}) {
    const form = new FormData();
    form.append("duration_ms", String(duration));
    form.append("script_version", String(scriptVersion));
    form.append("file", new Blob([buf], { type }), "identity.mp4");
    return call(uid, "/avatar-profile/video", { method: "POST", body: form });
  }
  async function uploadLegacy(uid, kind, buf, type) {
    const form = new FormData();
    form.append("file", new Blob([buf], { type }), kind === "face" ? "face.jpg" : "voice.m4a");
    return call(uid, `/avatar-profile/${kind}`, { method: "POST", body: form });
  }

  const store = require("../src/videonotes/store");
  const service = require("../src/videonotes/service");
  const media = require("../src/storage/media");
  const registry = require("../src/tools/registry");
  require("../src/tools/builtins").registerBuiltins();
  const rb = require("../src/agents/readBack");
  const tool = registry.get("send_video_note");
  const ctxS = { userId: S, userName: "Sita Test", appBuild: 118, source: "live" };

  /* ================================================================ */
  console.log("\nyour identity: /avatar-profile");

  await atest("a user with nothing stored gets all false and null — 200, never 404", async () => {
    const res = await call(T, "/avatar-profile");
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), {
      consented: false, consented_at: null, enabled: false, has_video: false, video: null,
      has_face: false, has_voice: false, script_version: 1,
    });
  });

  await atest("without consent the video, the photo and the voice are refused (403), nothing written", async () => {
    const before = tmpUploads().length;
    for (const res of [
      await uploadVideo(S),
      await uploadLegacy(S, "face", Buffer.from("jpeg"), "image/jpeg"),
      await uploadLegacy(S, "voice", Buffer.from("m4a"), "audio/mp4"),
    ]) {
      assert.strictEqual(res.status, 403);
      assert.deepStrictEqual(await res.json(), { error: "consent_required" });
    }
    assert.ok(!exists(path.join(MEDIA, "identity", String(S))), "a file was stored without consent");
    assert.strictEqual(tmpUploads().length, before, "an upload was spooled to disk anyway");
  });

  await atest("the switch cannot go on without consent and a video (409); off always can", async () => {
    let res = await call(S, "/avatar-profile/prefs", { method: "PUT", json: { enabled: true } });
    assert.strictEqual(res.status, 409);
    assert.ok((await res.json()).error);
    assert.strictEqual((await call(S, "/avatar-profile/consent", { method: "POST" })).status, 200);
    res = await call(S, "/avatar-profile/prefs", { method: "PUT", json: { enabled: true } });
    assert.strictEqual(res.status, 409, "consent alone is not enough — there is no video yet");
    res = await call(S, "/avatar-profile/prefs", { method: "PUT", json: { enabled: false } });
    assert.strictEqual(res.status, 200);
    res = await call(S, "/avatar-profile/prefs", { method: "PUT", json: { enabled: "maybe" } });
    assert.strictEqual(res.status, 400);
    const p = await profile(S);
    assert.strictEqual(p.consented, true);
    assert.ok(Number.isFinite(p.consented_at) && p.consented_at > 0);
    assert.strictEqual(p.enabled, false);
  });

  await atest("length, type and size are checked, and a refused upload leaves nothing", async () => {
    const before = tmpUploads().length;
    for (const [over, want] of [
      [{ duration: 14999 }, 400],
      [{ duration: 90001 }, 400],
      [{ duration: "abc" }, 400],
      [{ type: "image/png" }, 400],
      [{ buf: Buffer.alloc(4096, 7) }, 400], // says video/mp4, is not one
      [{ buf: mp4(1.5 * 1024 * 1024) }, 413],
    ]) {
      const res = await uploadVideo(S, over);
      assert.strictEqual(res.status, want, JSON.stringify(Object.keys(over)));
      assert.ok((await res.json()).error);
    }
    assert.strictEqual((await profile(S)).has_video, false);
    assert.ok(!exists(path.join(MEDIA, "identity", String(S))));
    assert.strictEqual(tmpUploads().length, before, "a refused upload's temp file was left behind");
    // The real ceiling, when AVATAR_VIDEO_MAX_MB is not set.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "avatarProfile.js"), "utf8");
    assert.match(src, /: 120\) \* MB/);
  });

  let firstVideo;
  await atest("a video is saved, switches notes on the first time, and reports what it stored", async () => {
    const res = await uploadVideo(S, { buf: mp4(4096), duration: 31000, scriptVersion: 1 });
    assert.strictEqual(res.status, 200);
    const d = await res.json();
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.video.duration_ms, 31000);
    assert.strictEqual(d.video.bytes, 4096);
    assert.strictEqual(d.video.script_version, 1);
    assert.ok(d.video.id && d.video.created_at > 0);
    firstVideo = d.video;
    const p = await profile(S);
    assert.strictEqual(p.has_video, true);
    assert.strictEqual(p.enabled, true, "the first saved video switches video notes on");
    assert.deepStrictEqual(p.video, d.video);
    assert.ok(exists(path.join(MEDIA, "identity", String(S), `video-${d.video.id}.mp4`)));
  });

  await atest("a new take replaces the old one, deletes its file, and leaves the switch alone", async () => {
    await call(S, "/avatar-profile/prefs", { method: "PUT", json: { enabled: false } });
    const res = await uploadVideo(S, { buf: mp4(5000), duration: 29000 });
    assert.strictEqual(res.status, 200);
    const d = await res.json();
    assert.notStrictEqual(d.video.id, firstVideo.id);
    assert.ok(!exists(path.join(MEDIA, "identity", String(S), `video-${firstVideo.id}.mp4`)),
      "the old take is still on disk");
    assert.ok(exists(path.join(MEDIA, "identity", String(S), `video-${d.video.id}.mp4`)));
    assert.deepStrictEqual(filesIn(path.join(MEDIA, "identity", String(S))), [`video-${d.video.id}.mp4`]);
    assert.strictEqual((await profile(S)).enabled, false, "only the FIRST video switches it on");
    const on = await call(S, "/avatar-profile/prefs", { method: "PUT", json: { enabled: true } });
    assert.strictEqual(on.status, 200);
    assert.strictEqual((await profile(S)).enabled, true);
  });

  await atest("builds <= 117 still save a photo and a voice sample", async () => {
    assert.strictEqual((await uploadLegacy(S, "face", Buffer.from("jpeg-bytes"), "image/jpeg")).status, 200);
    assert.strictEqual((await uploadLegacy(S, "voice", Buffer.from("m4a-bytes"), "audio/mp4")).status, 200);
    const p = await profile(S);
    assert.strictEqual(p.has_face, true);
    assert.strictEqual(p.has_voice, true);
    assert.strictEqual(filesIn(path.join(MEDIA, "identity", String(S))).length, 3);
  });

  /* ================================================================ */
  console.log("\nsend_video_note");

  await atest("no video yet: one line saying to record it, and the screen opens on build 118+", async () => {
    const r = await tool.execute({ to: "Danush", script: "Meet me at twelve." }, { userId: T, appBuild: 118 });
    assert.strictEqual(r.ok, false);
    assert.match(r.speak, /30-second video/);
    assert.match(r.speak, /Send messages as you/);
    assert.deepStrictEqual(r.deviceAction, { type: "open_app_screen", screen: "avatar_identity" });
    const old = await tool.execute({ to: "Danush", script: "Meet me at twelve." }, { userId: T, appBuild: 117 });
    assert.strictEqual(old.ok, false);
    assert.ok(!old.deviceAction, "an older app has no such screen to open");
    assert.match(old.speak, /update/);
  });

  await atest("switched off: it says where to turn it on, and queues nothing", async () => {
    await call(S, "/avatar-profile/prefs", { method: "PUT", json: { enabled: false } });
    const r = await tool.execute({ to: "Danush", script: "Meet me at twelve." }, { ...ctxS, userText: "yes" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "video_notes_off");
    assert.match(r.speak, /switched off/);
    await call(S, "/avatar-profile/prefs", { method: "PUT", json: { enabled: true } });
    assert.strictEqual((await db.one(
      `SELECT count(*)::int AS n FROM avatar_renders WHERE user_id = $1`, [S])).n, 0);
  });

  await atest("a script longer than one breath is sent back to be shortened", async () => {
    const long = Array.from({ length: 61 }, (_, i) => `word${i}`).join(" ");
    const r = await tool.execute({ to: "Danush", script: long }, ctxS);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /60 words/);
  });

  await atest("never from a scheduled task", async () => {
    const r = await registry.execute("send_video_note",
      { to: "Danush", script: "Meet me at twelve." }, { ...ctxS, background: true });
    assert.strictEqual(r.ok, false);
    assert.match(String(r.error), /unattended|scheduled/);
    const direct = await tool.execute({ to: "Danush", script: "Meet me at twelve." }, { ...ctxS, background: true });
    assert.strictEqual(direct.ok, false);
    assert.ok(registry.isWorldAction("send_video_note"));
  });

  const SCRIPT = "Danush, meet me at twelve PM today, near the college gate.";
  let noteR;
  await atest("read back first: nothing is queued until the user hears the words and says yes", async () => {
    rb._forget();
    const ask = await tool.execute({ to: "Danush", script: SCRIPT },
      { ...ctxS, userText: "send a video note to Danush saying he should meet me at twelve PM" });
    assert.strictEqual(ask.ok, false);
    assert.strictEqual(ask.needs_confirmation, true);
    assert.strictEqual(ask.data.read_back, SCRIPT);
    assert.match(ask.note, /NOTHING HAS BEEN MADE OR SENT/);
    assert.strictEqual((await db.one(
      `SELECT count(*)::int AS n FROM avatar_renders WHERE user_id = $1`, [S])).n, 0);
    // Confirmed in the same breath, with nothing new said: still a read-back.
    const again = await tool.execute({ to: "Danush", script: SCRIPT, confirmed: true },
      { ...ctxS, userText: "send a video note to Danush saying he should meet me at twelve PM" });
    assert.strictEqual(again.needs_confirmation, true);

    const yes = await tool.execute({ to: "Danush", script: SCRIPT, confirmed: true, language: "English" },
      { ...ctxS, userText: "yes" });
    assert.strictEqual(yes.ok, true, JSON.stringify(yes));
    assert.strictEqual(yes.data.status, "pending");
    assert.strictEqual(yes.data.on_app, true);
    noteR = await store.getRender(yes.data.video_note_id);
    assert.strictEqual(noteR.status, "pending");
    assert.strictEqual(noteR.user_id, S);
    assert.strictEqual(noteR.recipient_phone, PHONE.R);
    assert.strictEqual(noteR.recipient_user_id, R);
    assert.strictEqual(noteR.script, SCRIPT);
    assert.strictEqual(noteR.language, "English");
    assert.strictEqual(noteR.source_video_key, (await store.getProfile(S)).video_key);
    // What the take was read from and agreed to travels with the note.
    assert.strictEqual(noteR.script_version, 1);
    assert.strictEqual(noteR.consent_version, store.CONSENT_VERSION);
    assert.strictEqual(noteR.identity_checked_at, null);
    const out = await db.one(`SELECT * FROM task_outcomes WHERE external_id = $1`, [`video_note:${noteR.id}`]);
    assert.strictEqual(out.status, "requested");
    assert.strictEqual(out.kind, "message");
  });

  await atest("it says the note is being made — never that it was sent", async () => {
    rb._forget();
    const script = "Please call me when you are free.";
    await tool.execute({ to: "Danush", script }, { ...ctxS, userText: "video note to danush" });
    const yes = await tool.execute({ to: "Danush", script, confirmed: true }, { ...ctxS, userText: "haan" });
    assert.strictEqual(yes.ok, true);
    assert.match(yes.speak, /being made/);
    assert.doesNotMatch(yes.speak, /\bsent\b|\bdelivered\b/i);
    const cc = require("../src/agents/claimCheck");
    assert.strictEqual(cc.check("It will be delivered to Danush once it's made.",
      [{ tool: "send_video_note", ok: true }]).ok, true, "the queued note backs the claim");
    // The tool's own words pass through untouched.
    assert.strictEqual(cc.check(yes.speak, [{ tool: "send_video_note", ok: true }]).ok, true, yes.speak);
    // Leave the queue with just the notes the admin tests below expect.
    await db.run(`DELETE FROM avatar_renders WHERE id = $1`, [yes.data.video_note_id]);
  });

  await atest("a queued note never backs 'sent' or 'delivered' — the correction says it's being made", () => {
    const cc = require("../src/agents/claimCheck");
    const queued = [{ tool: "send_video_note", ok: true }];
    for (const said of [
      "Done, I've sent Danush your video note.",
      "Your video note has been delivered to Danush.",
      "Sending your video note to Danush now.",
      "Your video note is on its way to Danush.",
      "Sent! Danush will get your video note.",
      "Danush ko video note भेज दिया।",
    ]) {
      const v = cc.check(said, queued);
      assert.strictEqual(v.ok, false, `"${said}" passed as true`);
      assert.match(v.text, /hasn't gone yet — it's being made/, v.text);
      assert.doesNotMatch(v.text, /I haven't sent anything/, "a queued note is not 'nothing'");
    }
    // The stream gate reads the same verdict, sentence by sentence.
    const s = "Done, I've sent Danush your video note.";
    assert.strictEqual(cc.classify(s), "videonote");
    assert.strictEqual(cc.satisfied("videonote", queued, s), false);
    assert.match(cc.honestFor("videonote", s, queued), /being made/);
    assert.strictEqual(cc.satisfied("videonote", queued, "It will reach Danush once it's made."), true);
    // Nothing queued: "being made" is itself the false claim.
    const none = cc.check("Your video note for Danush is being made.", []);
    assert.strictEqual(none.ok, false);
    assert.match(none.text, /nothing is being made/);
    // Neighbours keep their verdicts: a text message, a generated video,
    // and the tool's own refusals.
    assert.strictEqual(cc.check("I've sent your message to Ravi.",
      [{ tool: "send_agent_message", ok: true }]).ok, true);
    assert.strictEqual(cc.check("I've sent your message to Ravi.", []).text,
      "I haven't sent anything — that didn't go through.");
    assert.strictEqual(cc.check("Your video is being made, I'll show it when it's ready.",
      [{ tool: "generate_video", ok: true }]).ok, true, "generate_video's wording is not a video note");
    for (const refusal of [
      "Video notes are switched off. Turn on Send as you in You, Send messages as you, then ask me again.",
      "Video notes need your OK first — agree again in You, Send messages as you.",
    ]) {
      assert.strictEqual(cc.check(refusal, [{ tool: "send_video_note", ok: false }]).ok, true, refusal);
    }
    assert.ok(cc.FAMILY_TOOLS.has("send_video_note"), "the registry must still file it for the checker");
  });

  let noteN;
  await atest("someone not on the app: queued, and the sender hears they'll get it to share", async () => {
    rb._forget();
    const script = "Nila, happy birthday! See you on Sunday.";
    await tool.execute({ to: "Nila", script }, { ...ctxS, userText: "video message to nila" });
    const yes = await tool.execute({ to: "Nila", script, confirmed: true }, { ...ctxS, userText: "yes" });
    assert.strictEqual(yes.ok, true, JSON.stringify(yes));
    assert.strictEqual(yes.data.on_app, false);
    assert.match(yes.speak, /documents/);
    noteN = await store.getRender(yes.data.video_note_id);
    assert.strictEqual(noteN.recipient_phone, PHONE.N);
    assert.strictEqual(noteN.recipient_user_id, null);
  });

  await atest("a name nobody matches is said plainly, and nothing is queued", async () => {
    rb._forget();
    const r = await tool.execute({ to: "Zzyzx Qq", script: "Hello." }, { ...ctxS, userText: "yes" });
    assert.strictEqual(r.ok, false);
    assert.match(r.speak, /couldn't find/);
  });

  /* ================================================================ */
  console.log("\nthe admin panel");

  const login = await fetch(`${base}/admin-panel/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: process.env.ADMIN_KEY }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const admin = (p, opts = {}) => fetch(`${base}/admin-panel/api${p}`,
    { ...opts, headers: { ...(opts.headers || {}), cookie } });
  async function uploadResult(id, buf, type = "video/mp4", name = "result.mp4") {
    const form = new FormData();
    form.append("file", new Blob([buf], { type }), name);
    return admin(`/video-notes/${id}/result`, { method: "POST", body: form });
  }
  const verify = (id) => admin(`/video-notes/${id}/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: true }) });
  const keptClips = (id) => filesIn(path.join(MEDIA, "renders", String(id)));
  const CLIP_EARLY = mp4(3000, 5);

  await atest("the queue is behind the admin login", async () => {
    assert.strictEqual((await fetch(`${base}/admin-panel/api/video-notes`)).status, 401);
    assert.strictEqual((await fetch(`${base}/admin-panel/api/video-notes/${noteR.id}/source`)).status, 401);
    const form = new FormData();
    form.append("file", new Blob([mp4()], { type: "video/mp4" }), "x.mp4");
    assert.strictEqual((await fetch(`${base}/admin-panel/api/video-notes/${noteR.id}/result`,
      { method: "POST", body: form })).status, 401);
  });

  await atest("it lists the note: who asked, for whom, the script, and a video to download", async () => {
    const d = await (await admin(`/video-notes?status=pending`)).json();
    const r = d.renders.find((x) => x.id === Number(noteR.id));
    assert.ok(r, "the note is listed");
    assert.strictEqual(r.status, "pending");
    assert.strictEqual(r.sender.id, S);
    assert.strictEqual(r.sender.name, "Sita Test");
    assert.strictEqual(r.sender.phone, PHONE.S);
    assert.strictEqual(r.recipient.phone, PHONE.R);
    assert.strictEqual(r.recipient.onApp, true);
    assert.strictEqual(r.script, SCRIPT);
    assert.strictEqual(r.hasSource, true);
    assert.strictEqual(r.sourceBytes, 5000);
    assert.ok(d.counts.pending >= 2);
    // The owner's checkpoint: the sender consents now, and the page shows
    // the exact consent sentence the person in the video should be saying.
    assert.strictEqual(r.sender.consent, "ok");
    assert.strictEqual(r.workable, true);
    assert.strictEqual(r.scriptVersion, 1);
    assert.strictEqual(r.consentVersion, store.CONSENT_VERSION);
    assert.match(r.teleprompter.consent, /^I'm recording this so my assistant can make video messages/);
    assert.ok(r.teleprompter.text.startsWith(r.teleprompter.consent));
    assert.strictEqual(r.identityChecked, false);
    const n = d.renders.find((x) => x.id === Number(noteN.id));
    assert.strictEqual(n.recipient.onApp, false);
  });

  await atest("the teleprompter words the server shows are the app's own", () => {
    const { APP_ROOT } = require("./app-root");
    const file = path.join(APP_ROOT, "lib", "screens", "identity_record_screen.dart");
    if (!fs.existsSync(file)) {
      console.log("       (app checkout not found — skipped)");
      return;
    }
    const m = fs.readFileSync(file, "utf8").match(/const String identityScript = '''([\s\S]*?)''';/);
    assert.ok(m, "identityScript not found in the app");
    const lines = m[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const v = fs.readFileSync(file, "utf8").match(/const int identityScriptVersion = (\d+);/);
    const tp = store.teleprompter(Number(v[1]));
    assert.ok(tp, `the server has no wording for script v${v[1]}`);
    assert.strictEqual(tp.text, lines.join(" "), "the app's script changed — add it here as a new version");
    assert.ok(tp.text.startsWith(tp.consent));
    assert.match(tp.consent, /only when I ask\.$/);
  });

  await atest("no clip can be uploaded until the owner confirms the video is them", async () => {
    let res = await uploadResult(noteR.id, CLIP_EARLY);
    assert.strictEqual(res.status, 409);
    assert.match((await res.json()).error, /confirm it is them reading the consent sentence/);
    assert.strictEqual((await store.getRender(noteR.id)).status, "pending");
    assert.ok(!exists(path.join(MEDIA, "renders", String(noteR.id))), "a clip was kept");
    // Straight at the service too: the route is not the only way in.
    const tmp = path.join(TMP, "early.mp4");
    fs.writeFileSync(tmp, CLIP_EARLY);
    await assert.rejects(service.storeOutput(noteR.id, tmp), /confirm it is them/);
    // A bare POST is not a confirmation.
    res = await admin(`/video-notes/${noteR.id}/verify`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.strictEqual(res.status, 400);
    for (const id of [noteR.id, noteN.id]) {
      res = await admin(`/video-notes/${id}/verify`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }) });
      assert.strictEqual(res.status, 200);
    }
    const row = await store.getRender(noteR.id);
    assert.ok(row.identity_checked_at > 0);
    assert.strictEqual(row.identity_checked_key, row.source_video_key);
    // In the sender's own activity log, where they can see it.
    const logged = await db.one(
      `SELECT detail FROM actions_log WHERE user_id = $1 AND action = 'video_note.identity_checked'
        ORDER BY id DESC LIMIT 1`, [S]);
    assert.ok(logged && /consent sentence/.test(logged.detail));
    const d = await (await admin(`/video-notes?status=pending`)).json();
    assert.strictEqual(d.renders.find((x) => x.id === Number(noteR.id)).identityChecked, true);
  });

  await atest("the sender's video streams with byte ranges, and downloads as a file", async () => {
    let res = await admin(`/video-notes/${noteR.id}/source`, { headers: { range: "bytes=0-99" } });
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get("content-range"), "bytes 0-99/5000");
    assert.strictEqual(res.headers.get("content-type"), "video/mp4");
    assert.strictEqual(res.headers.get("x-content-type-options"), "nosniff");
    assert.strictEqual((await res.arrayBuffer()).byteLength, 100);
    res = await admin(`/video-notes/${noteR.id}/source`, { headers: { range: "bytes=-10" } });
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get("content-range"), "bytes 4990-4999/5000");
    res = await admin(`/video-notes/${noteR.id}/source`, { headers: { range: "bytes=9000-" } });
    assert.strictEqual(res.status, 416);
    res = await admin(`/video-notes/${noteR.id}/source?download=1`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get("content-disposition"), /^attachment;/);
    const body = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(body.length, 5000);
    assert.strictEqual(body.toString("latin1", 4, 8), "ftyp");
  });

  await atest("a file that is not an MP4 is refused, and nothing is delivered", async () => {
    const res = await uploadResult(noteR.id, Buffer.from("definitely not a video"), "video/mp4");
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await store.getRender(noteR.id)).status, "pending");
    assert.strictEqual((await db.one(
      `SELECT count(*)::int AS n FROM agent_messages WHERE to_phone_number = $1`, [PHONE.R])).n, 0);
  });

  const CLIP = mp4(8192, 3);
  let delivered;
  await atest("uploading the clip delivers it to the recipient's app at once", async () => {
    pushes.length = 0;
    const res = await uploadResult(noteR.id, CLIP);
    assert.strictEqual(res.status, 200);
    const d = await res.json();
    assert.deepStrictEqual([d.ok, d.status, d.deliveredTo], [true, "delivered", "recipient"]);
    delivered = await store.getRender(noteR.id);
    assert.strictEqual(delivered.status, "delivered");
    assert.ok(delivered.delivered_at > 0 && delivered.message_id && delivered.document_id);
    // The inbox row, from the sender, labelled, carrying the clip.
    const m = await db.one(`SELECT * FROM agent_messages WHERE id = $1`, [delivered.message_id]);
    assert.strictEqual(m.from_user_id, S);
    assert.strictEqual(m.to_phone_number, PHONE.R);
    assert.strictEqual(m.media, "video");
    assert.strictEqual(Number(m.document_id), Number(delivered.document_id));
    assert.strictEqual(m.message, `AI video note from Sita Test: ${SCRIPT}`);
    // The recipient's OWN document, titled and indexed so /docs never
    // reads it back into memory to analyse it.
    const doc = await db.one(`SELECT * FROM documents WHERE id = $1`, [delivered.document_id]);
    assert.strictEqual(doc.user_id, R);
    assert.strictEqual(doc.mime, "video/mp4");
    assert.strictEqual(doc.title, "AI video note from Sita Test");
    assert.ok(doc.full_text.includes(SCRIPT));
    assert.strictEqual(Number(doc.size), CLIP.length);
    assert.ok(doc.path.endsWith(".mp4"));
    assert.ok(fs.readFileSync(doc.path).equals(CLIP));
    // The push the popup keys on, and the sender told it arrived.
    const toR = pushes.find((p) => p.token === `tok-r-${stamp}`);
    assert.ok(toR, "the recipient got no push");
    assert.deepStrictEqual(toR.data, { kind: "agent_message", avatar: "1" });
    assert.match(toR.body, /AI/);
    const toS = pushes.find((p) => p.token === `tok-s-${stamp}`);
    assert.ok(toS && /reached/.test(toS.body), "the sender was not told");
    const out = await db.one(`SELECT * FROM task_outcomes WHERE external_id = $1`, [`video_note:${noteR.id}`]);
    assert.strictEqual(out.status, "completed");
    // The kept copy for the admin page, under this upload's own key.
    assert.match(delivered.output_key, new RegExp(`^renders/${noteR.id}/output-[^/]+\\.mp4$`));
    assert.deepStrictEqual(keptClips(noteR.id), [path.basename(delivered.output_key)]);
  });

  await atest("the recipient's inbox hands the app a video it can download — and only them", async () => {
    const d = await (await call(R, "/messages/unread")).json();
    const m = d.messages.find((x) => Number(x.id) === Number(delivered.message_id));
    assert.ok(m, "the note is not in the inbox");
    assert.strictEqual(m.media, "video");
    assert.strictEqual(m.media_url, `/docs/${delivered.document_id}/file`);
    assert.strictEqual(m.from, "Sita Test");
    let res = await call(R, m.media_url);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "video/mp4");
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(CLIP));
    res = await call(S, m.media_url);
    assert.strictEqual(res.status, 404, "somebody else's copy must not be served");
    // A plain message keeps its old shape.
    await db.run(`INSERT INTO agent_messages (from_user_id, to_phone_number, message, created_at)
                  VALUES ($1,$2,'plain words',$3)`, [S, PHONE.R, Date.now()]);
    const d2 = await (await call(R, "/messages/unread")).json();
    const plain = d2.messages.find((x) => x.message === "plain words");
    assert.ok(plain && !("media" in plain) && !("media_url" in plain));
  });

  await atest("ten older unread texts never push a video note out of the inbox — nor it them", async () => {
    const old = Date.now() - 3_600_000;
    for (let i = 0; i < 12; i++) {
      await db.run(`INSERT INTO agent_messages (from_user_id, to_phone_number, message, created_at)
                    VALUES ($1,$2,$3,$4)`, [S, PHONE.R, `backlog ${i}`, old + i]);
    }
    const d = await (await call(R, "/messages/unread")).json();
    const video = d.messages.filter((x) => x.media === "video");
    assert.deepStrictEqual(video.map((x) => Number(x.id)), [Number(delivered.message_id)],
      "the popup would find no video note to show");
    const texts = d.messages.filter((x) => !x.media);
    assert.strictEqual(texts.length, 10, "the voice path still gets its ten oldest");
    assert.strictEqual(texts[0].message, "backlog 0");
    const at = d.messages.map((x) => x.at);
    assert.deepStrictEqual(at, [...at].sort((a, b) => a - b), "oldest first, as before");
    await db.run(`DELETE FROM agent_messages WHERE to_phone_number = $1 AND message LIKE 'backlog %'`,
      [PHONE.R]);
  });

  await atest("the chat thread marks it as a video, and the conversation leaves it for the popup", async () => {
    const d = await (await call(R, `/chat/thread/${encodeURIComponent(PHONE.S)}`)).json();
    const item = d.items.find((x) => x.id === Number(delivered.message_id));
    assert.strictEqual(item.media, "video");
    assert.strictEqual(item.documentId, Number(delivered.document_id));
    // The app's conversation (src/ai/, since 2026-09-29) passes unread
    // messages on at a session's start — never a video note.
    const ctx = fs.readFileSync(path.join(__dirname, "..", "src", "ai", "context.js"), "utf8");
    assert.match(ctx, /m\.status = 'unread' AND m\.to_phone_number = \$1\s+AND m\.media = ''/,
      "the conversation would read the note aloud and mark it read before the popup sees it");
    const voice = fs.readFileSync(path.join(__dirname, "..", "src", "ai", "voicePrompt.js"), "utf8");
    assert.match(voice, /send_video_note/, "the spoken prompt never routes video notes to the tool");
  });

  await atest("the chat thread says what an attachment IS (type, title), so a clip or PDF is not opened as a photo", async () => {
    const d = await (await call(R, `/chat/thread/${encodeURIComponent(PHONE.S)}`)).json();
    const item = d.items.find((x) => x.id === Number(delivered.message_id));
    const doc = await db.one(`SELECT user_id, mime, title FROM documents WHERE id = $1`, [item.documentId]);
    assert.strictEqual(doc.user_id, R, "the recipient's own copy");
    assert.strictEqual(item.documentMime, "video/mp4");
    assert.strictEqual(item.documentMime, doc.mime);
    assert.strictEqual(item.documentTitle, doc.title || null);
    const plain = d.items.find((x) => !x.documentId);
    if (plain) assert.strictEqual(plain.documentMime, null);
  });

  await atest("a delivered note cannot be delivered twice", async () => {
    const res = await uploadResult(noteR.id, CLIP);
    assert.strictEqual(res.status, 409);
    assert.match((await res.json()).error, /already delivered/);
    assert.strictEqual((await db.one(
      `SELECT count(*)::int AS n FROM agent_messages WHERE to_phone_number = $1 AND media = 'video'`,
      [PHONE.R])).n, 1);
    const again = await admin(`/video-notes/${noteR.id}/deliver`, { method: "POST" });
    assert.strictEqual(again.status, 409);
    assert.match((await again.json()).error, /already delivered/);
    // The sender's face is not served for a note that is out.
    assert.strictEqual((await admin(`/video-notes/${noteR.id}/source`)).status, 410);
  });

  await atest("someone not on the app: the clip goes to the sender's documents to share", async () => {
    pushes.length = 0;
    const res = await uploadResult(noteN.id, mp4(6000, 9));
    assert.strictEqual(res.status, 200);
    const d = await res.json();
    assert.strictEqual(d.deliveredTo, "sender");
    const r = await store.getRender(noteN.id);
    assert.strictEqual(r.status, "delivered");
    assert.strictEqual(r.message_id, null);
    const doc = await db.one(`SELECT * FROM documents WHERE id = $1`, [r.document_id]);
    assert.strictEqual(doc.user_id, S);
    assert.strictEqual(doc.title, "Video note for Nila");
    assert.strictEqual(Number(doc.size), 6000);
    assert.strictEqual((await db.one(
      `SELECT count(*)::int AS n FROM agent_messages WHERE to_phone_number = $1`, [PHONE.N])).n, 0);
    const toS = pushes.find((p) => p.token === `tok-s-${stamp}`);
    assert.ok(toS && /ready to share/.test(toS.body));
    assert.deepStrictEqual(toS.data, { kind: "video_note" });
  });

  /** A note from S to Danush, checked by the owner, ready for a clip. */
  async function checkedNote(script, status = "pending") {
    const r = await store.createRender({ userId: S, recipientName: "Danush", recipientPhone: PHONE.R,
      recipientUserId: R, script, sourceKey: (await store.getProfile(S)).video_key,
      scriptVersion: 1, consentVersion: store.CONSENT_VERSION });
    assert.strictEqual((await verify(r.id)).status, 200);
    if (status !== "pending") await store.updateRender(r.id, { status, error: "Colab crashed" });
    return store.getRender(r.id);
  }
  const tmpClip = (name, buf) => {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, buf);
    return p;
  };
  const videoMessagesTo = async (phone) => (await db.one(
    `SELECT count(*)::int AS n FROM agent_messages WHERE to_phone_number = $1 AND media = 'video'`,
    [phone])).n;

  await atest("each upload keeps its own clip: a second replaces the first, and a loser deletes only its own", async () => {
    const r = await checkedNote("Two uploads.");
    const first = await service.storeOutput(r.id, tmpClip("one.mp4", mp4(1000, 1)));
    const second = await service.storeOutput(r.id, tmpClip("two.mp4", mp4(1200, 2)));
    assert.notStrictEqual(first.output_key, second.output_key);
    assert.deepStrictEqual(keptClips(r.id), [path.basename(second.output_key)], "the replaced clip stayed");
    // A third upload loses to a delivery that lands while it is being
    // stored (two tabs, or a retry after a proxy timeout).
    const realPut = media.put;
    media.put = async (...a) => {
      const out = await realPut(...a);
      await service.deliver(r.id);
      return out;
    };
    try {
      await assert.rejects(service.storeOutput(r.id, tmpClip("three.mp4", mp4(1300, 3))),
        (e) => e.http === 409 && /already delivered/.test(e.message));
    } finally {
      media.put = realPut;
    }
    const row = await store.getRender(r.id);
    assert.strictEqual(row.status, "delivered");
    assert.strictEqual(row.output_key, second.output_key, "the delivered clip's key moved");
    assert.deepStrictEqual(keptClips(r.id), [path.basename(second.output_key)],
      "the losing upload deleted the delivered clip, or kept its own");
  });

  await atest("two deliveries of one note: one goes, the other hears 'already delivered'", async () => {
    const r = await checkedNote("Twice at once.");
    await service.storeOutput(r.id, tmpClip("race.mp4", mp4(900, 4)));
    const before = await videoMessagesTo(PHONE.R);
    const docsBefore = (await db.one(`SELECT count(*)::int AS n FROM documents WHERE user_id = $1`, [R])).n;
    const out = await Promise.allSettled([service.deliver(r.id), service.deliver(r.id)]);
    const ok = out.filter((o) => o.status === "fulfilled");
    const no = out.filter((o) => o.status === "rejected");
    assert.strictEqual(ok.length, 1);
    assert.strictEqual(no.length, 1);
    assert.match(no[0].reason.message, /already delivered/);
    assert.doesNotMatch(no[0].reason.message, /cancel/);
    assert.strictEqual(await videoMessagesTo(PHONE.R), before + 1, "a second inbox row stayed");
    assert.strictEqual((await db.one(`SELECT count(*)::int AS n FROM documents WHERE user_id = $1`, [R])).n,
      docsBefore + 1, "a second copy stayed in their documents");
  });

  await atest("mark failed: it leaves the queue and the sender is told", async () => {
    pushes.length = 0;
    const r = await store.createRender({ userId: S, recipientName: "Danush", recipientPhone: PHONE.R,
      recipientUserId: R, script: "Running late.", sourceKey: (await store.getProfile(S)).video_key });
    await require("../src/outcomes/store").create(S, { kind: "message", target: "Danush",
      status: "requested", path: "video_note", externalId: `video_note:${r.id}` });
    const res = await admin(`/video-notes/${r.id}/fail`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "the face was too dark to use" }),
    });
    assert.strictEqual(res.status, 200);
    const row = await store.getRender(r.id);
    assert.strictEqual(row.status, "failed");
    assert.strictEqual(row.error, "the face was too dark to use");
    assert.ok(pushes.some((p) => p.token === `tok-s-${stamp}` && /couldn't be made/.test(p.body)));
    assert.strictEqual((await db.one(`SELECT status FROM task_outcomes WHERE external_id = $1`,
      [`video_note:${r.id}`])).status, "failed");
    const again = await admin(`/video-notes/${r.id}/fail`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.strictEqual(again.status, 409);
  });

  /* ================================================================ */
  console.log("\nconsent withdrawn, and delete everything");

  await atest("switched off: a clip can't be stored and the note waits, uncancelled", async () => {
    const r = await checkedNote("Switched off.");
    await call(S, "/avatar-profile/prefs", { method: "PUT", json: { enabled: false } });
    try {
      const up = await uploadResult(r.id, CLIP);
      assert.strictEqual(up.status, 409);
      assert.match((await up.json()).error, /switched video notes off/);
      assert.strictEqual((await admin(`/video-notes/${r.id}/source`)).status, 410);
      assert.strictEqual((await store.getRender(r.id)).status, "pending");
      assert.deepStrictEqual(keptClips(r.id), []);
      const d = await (await admin(`/video-notes?status=pending`)).json();
      const row = d.renders.find((x) => x.id === Number(r.id));
      assert.deepStrictEqual([row.sender.consent, row.workable], ["off", false]);
    } finally {
      await call(S, "/avatar-profile/prefs", { method: "PUT", json: { enabled: true } });
      await db.run(`DELETE FROM avatar_renders WHERE id = $1`, [r.id]);
    }
  });

  await atest("consent taken back after the clip was stored: nothing is delivered", async () => {
    // The cancel that should have followed never ran (a DB blip): delivery
    // still reads consent for itself.
    pushes.length = 0;
    const r = await checkedNote("Stored, then withdrawn.");
    await service.storeOutput(r.id, tmpClip("stored.mp4", mp4(800, 6)));
    await store.setConsent(S, false);
    const before = await videoMessagesTo(PHONE.R);
    const docsBefore = (await db.one(`SELECT count(*)::int AS n FROM documents WHERE user_id = ANY($1)`, [[S, R]])).n;
    const res = await admin(`/video-notes/${r.id}/deliver`, { method: "POST" });
    assert.strictEqual(res.status, 409);
    assert.match((await res.json()).error, /withdrew consent/);
    assert.strictEqual(await videoMessagesTo(PHONE.R), before);
    assert.strictEqual((await db.one(`SELECT count(*)::int AS n FROM documents WHERE user_id = ANY($1)`,
      [[S, R]])).n, docsBefore);
    assert.strictEqual(pushes.length, 0, "somebody was told about a note that must not go");
    const row = await store.getRender(r.id);
    assert.strictEqual(row.status, "cancelled", "the refused note stayed in the queue");
    assert.deepStrictEqual(keptClips(r.id), [], "its clip was kept");
    await store.setConsent(S, true);
    await call(S, "/avatar-profile/prefs", { method: "PUT", json: { enabled: true } });
  });

  await atest("consent withdrawn mid-store or mid-delivery: refused under lock, nothing kept or sent", async () => {
    // While the clip is being moved into place…
    const a = await checkedNote("Withdrawn while storing.");
    const realPut = media.put;
    media.put = async (...args) => {
      const out = await realPut(...args);
      await store.setConsent(S, false);
      return out;
    };
    try {
      await assert.rejects(service.storeOutput(a.id, tmpClip("mid-store.mp4", mp4(600, 7))),
        (e) => e.http === 409 && /withdrew consent/.test(e.message));
    } finally {
      media.put = realPut;
    }
    assert.strictEqual((await store.getRender(a.id)).status, "cancelled");
    assert.deepStrictEqual(keptClips(a.id), []);
    await store.setConsent(S, true);
    await call(S, "/avatar-profile/prefs", { method: "PUT", json: { enabled: true } });

    // …and after the recipient's copy and inbox row exist, before the
    // note is marked delivered: both are taken back, nobody is told.
    const b = await checkedNote("Withdrawn while delivering.");
    await service.storeOutput(b.id, tmpClip("mid-deliver.mp4", mp4(650, 8)));
    const before = await videoMessagesTo(PHONE.R);
    const docsBefore = (await db.one(`SELECT count(*)::int AS n FROM documents WHERE user_id = $1`, [R])).n;
    pushes.length = 0;
    const chat = require("../src/routes/chat");
    const realMuted = chat.mutedBy;
    chat.mutedBy = async () => {
      await store.setConsent(S, false);
      return false;
    };
    try {
      await assert.rejects(service.deliver(b.id), (e) => e.http === 409 && /withdrew consent/.test(e.message));
    } finally {
      chat.mutedBy = realMuted;
    }
    assert.strictEqual(await videoMessagesTo(PHONE.R), before, "the inbox row stayed");
    assert.strictEqual((await db.one(`SELECT count(*)::int AS n FROM documents WHERE user_id = $1`, [R])).n,
      docsBefore, "the recipient's copy stayed");
    assert.strictEqual(pushes.length, 0);
    assert.strictEqual((await store.getRender(b.id)).status, "cancelled");
    assert.deepStrictEqual(keptClips(b.id), []);
    await store.setConsent(S, true);
    await call(S, "/avatar-profile/prefs", { method: "PUT", json: { enabled: true } });
  });

  await atest("a new note can't be queued once consent is gone", async () => {
    const mk = () => store.createRenderFromProfile({ userId: S, recipientName: "Danush",
      recipientPhone: PHONE.R, recipientUserId: R, script: "Hi." });
    const ok = await mk();
    assert.ok(ok && ok.source_video_key && ok.script_version === 1);
    await db.run(`DELETE FROM avatar_renders WHERE id = $1`, [ok.id]);
    await store.setConsent(S, false);
    assert.strictEqual(await mk(), null);
    await store.setConsent(S, true);
    assert.strictEqual(await mk(), null, "consent alone: the switch went off with the withdrawal");
    await call(S, "/avatar-profile/prefs", { method: "PUT", json: { enabled: true } });
    const back = await mk();
    assert.ok(back, "agreeing again and switching on makes notes possible again");
    await db.run(`DELETE FROM avatar_renders WHERE id = $1`, [back.id]);
    await store.deleteProfile(T); // T has none; a missing row is simply no
    const none = await store.createRenderFromProfile({ userId: T, recipientName: "Danush",
      recipientPhone: PHONE.R, script: "Hi." });
    assert.strictEqual(none, null);
  });

  await atest("withdrawing consent cancels what is waiting, switches notes off, and stops the tool", async () => {
    const r = await store.createRender({ userId: S, recipientName: "Danush", recipientPhone: PHONE.R,
      recipientUserId: R, script: "See you tomorrow.", sourceKey: (await store.getProfile(S)).video_key });
    // A FAILED note too: it can be uploaded again, so it must not outlive
    // the withdrawal (review, 2026-09-26).
    const failed = await checkedNote("Colab crashed on this one.", "failed");
    const res = await call(S, "/avatar-profile/consent", { method: "DELETE" });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
    assert.strictEqual((await store.getRender(r.id)).status, "cancelled");
    assert.strictEqual((await store.getRender(failed.id)).status, "cancelled", "the failed note survived");
    const p = await profile(S);
    assert.deepStrictEqual([p.consented, p.consented_at, p.enabled], [false, null, false]);
    // A cancelled note is never delivered, whatever the owner uploads —
    // and the sender's face is no longer served for it.
    const docsBefore = (await db.one(`SELECT count(*)::int AS n FROM documents WHERE user_id = ANY($1)`, [[S, R]])).n;
    const msgsBefore = await videoMessagesTo(PHONE.R);
    pushes.length = 0;
    for (const id of [r.id, failed.id]) {
      const up = await uploadResult(id, CLIP);
      assert.strictEqual(up.status, 409);
      assert.match((await up.json()).error, /cancelled/);
      assert.strictEqual((await admin(`/video-notes/${id}/source`)).status, 410);
      assert.strictEqual((await admin(`/video-notes/${id}/source?download=1`)).status, 410);
      assert.strictEqual((await admin(`/video-notes/${id}/verify`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }) })).status, 409);
    }
    const tmp = tmpClip("late.mp4", CLIP);
    await assert.rejects(service.storeOutput(failed.id, tmp), (e) => e.http === 409);
    assert.strictEqual((await db.one(`SELECT count(*)::int AS n FROM documents WHERE user_id = ANY($1)`,
      [[S, R]])).n, docsBefore);
    assert.strictEqual(await videoMessagesTo(PHONE.R), msgsBefore);
    assert.strictEqual(pushes.length, 0);
    assert.ok(!exists(path.join(MEDIA, "renders", String(r.id))), "the refused clip was kept");
    assert.ok(!exists(path.join(MEDIA, "renders", String(failed.id))), "the refused clip was kept");
    // The page shows why, and offers nothing that uses their face.
    const d = await (await admin(`/video-notes?status=cancelled`)).json();
    const row = d.renders.find((x) => x.id === Number(failed.id));
    assert.deepStrictEqual([row.sender.consent, row.workable], ["withdrawn", false]);
    // And no new note can be asked for — the video is still there, so the
    // user is asked to agree again, not to record again.
    const t = await tool.execute({ to: "Danush", script: "Hi." }, { ...ctxS, userText: "yes" });
    assert.strictEqual(t.ok, false);
    assert.strictEqual(t.error, "consent_required");
    assert.match(t.speak, /agree again/);
    assert.doesNotMatch(t.speak, /record/);
  });

  await atest("a withdrawal whose cancel fails says so — and consent is off regardless", async () => {
    await call(S, "/avatar-profile/consent", { method: "POST" });
    const real = service.cancelForUser;
    service.cancelForUser = async () => { throw new Error("db blip"); };
    try {
      const res = await call(S, "/avatar-profile/consent", { method: "DELETE" });
      assert.strictEqual(res.status, 500, "a failed cancel was answered ok:true");
      assert.ok((await res.json()).error);
    } finally {
      service.cancelForUser = real;
    }
    assert.strictEqual((await profile(S)).consented, false);
  });

  await atest("a take or a photo that lands after consent went is refused and leaves nothing", async () => {
    await call(S, "/avatar-profile/consent", { method: "POST" });
    await call(S, "/avatar-profile/prefs", { method: "PUT", json: { enabled: true } });
    const before = await store.getProfile(S);
    const dir = path.join(MEDIA, "identity", String(S));
    const filesBefore = filesIn(dir).sort();
    // Withdrawn from another device while the bytes were still arriving.
    const realPut = media.put;
    media.put = async (...a) => {
      const out = await realPut(...a);
      await store.setConsent(S, false);
      return out;
    };
    try {
      for (const res of [
        await uploadVideo(S, { buf: mp4(4500) }),
        await uploadLegacy(S, "face", Buffer.from("late-jpeg"), "image/jpeg"),
      ]) {
        assert.strictEqual(res.status, 403);
        assert.deepStrictEqual(await res.json(), { error: "consent_required" });
        await store.setConsent(S, true);
      }
    } finally {
      media.put = realPut;
    }
    const after = await store.getProfile(S);
    assert.strictEqual(after.video_key, before.video_key, "the row points at a take that was refused");
    assert.strictEqual(after.face_key, before.face_key);
    assert.deepStrictEqual(filesIn(dir).sort(), filesBefore, "a refused file stayed, or the old take went");
    assert.ok(exists(path.join(MEDIA, before.video_key)), "the take in use was deleted");
    // Straight at the store: no row, or no consent, and nothing changes.
    await assert.rejects(store.setVideo(T, { key: "identity/x/video-y.mp4", id: "y", mime: "video/mp4",
      bytes: 1, durationMs: 30000, scriptVersion: 1 }), (e) => e.http === 403);
    await assert.rejects(store.setAsset(T, "face", "identity/x/face-y.jpg"), (e) => e.http === 403);
  });

  await atest("Delete everything removes every file and the row, and cancels what is waiting", async () => {
    await call(S, "/avatar-profile/consent", { method: "POST" });
    await call(S, "/avatar-profile/prefs", { method: "PUT", json: { enabled: true } });
    const pend = await checkedNote("Bye.");
    // A made-but-not-delivered clip of theirs, waiting in the kept store.
    await service.storeOutput(pend.id, tmpClip("made.mp4", mp4(2048)));
    assert.strictEqual(keptClips(pend.id).length, 1);
    // And one the owner marked failed, which could be uploaded again.
    const failed = await checkedNote("Failed before the delete.", "failed");
    const res = await call(S, "/avatar-profile", { method: "DELETE" });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
    assert.ok(!exists(path.join(MEDIA, "identity", String(S))), "identity files survived");
    assert.ok(!exists(path.join(MEDIA, "renders", String(pend.id))), "a kept clip survived");
    assert.ok(!exists(path.join(MEDIA, "renders", String(noteR.id))), "the delivered note's kept clip survived");
    assert.strictEqual(await store.getProfile(S), null);
    assert.strictEqual((await store.getRender(pend.id)).status, "cancelled");
    assert.strictEqual((await store.getRender(failed.id)).status, "cancelled", "the failed note survived");
    // A clip made earlier from the downloaded video can't bring it back.
    const up = await uploadResult(failed.id, CLIP);
    assert.strictEqual(up.status, 409);
    await assert.rejects(service.storeOutput(failed.id, tmpClip("old.mp4", CLIP)), (e) => e.http === 409);
    assert.ok(!exists(path.join(MEDIA, "renders", String(failed.id))));
    // A note created in the gap (the tool read the profile before the
    // delete) is refused when its clip comes, and cancelled.
    const gap = await store.createRender({ userId: S, recipientName: "Danush", recipientPhone: PHONE.R,
      recipientUserId: R, script: "In the gap.", sourceKey: "identity/0/gone.mp4" });
    const late = await uploadResult(gap.id, CLIP);
    assert.strictEqual(late.status, 409);
    assert.match((await late.json()).error, /withdrew consent/);
    assert.strictEqual((await store.getRender(gap.id)).status, "cancelled");
    const p = await profile(S);
    assert.deepStrictEqual([p.consented, p.has_video, p.has_face, p.has_voice, p.enabled],
      [false, false, false, false, false]);
    // What Danush received is his: the delivered copy stays in his documents.
    const doc = await db.one(`SELECT path FROM documents WHERE id = $1`, [delivered.document_id]);
    assert.ok(doc && exists(doc.path));
  });

  /* ================================================================ */
  console.log("\nretention and account erasure");

  await atest("a kept clip goes 30 days after delivery; a recent one and the recipient's copy stay", async () => {
    const old = await store.createRender({ userId: R, recipientName: "Sita", recipientPhone: PHONE.S,
      recipientUserId: S, script: "Old one." });
    const fresh = await store.createRender({ userId: R, recipientName: "Sita", recipientPhone: PHONE.S,
      recipientUserId: S, script: "New one." });
    for (const r of [old, fresh]) {
      const key = service.outputKey(r.id);
      await media.put(key, mp4(1024));
      await store.updateRender(r.id, { status: "delivered", output_key: key,
        delivered_at: Date.now() - (r === old ? 31 : 2) * 86_400_000 });
    }
    await service.sweep();
    assert.ok(!exists(path.join(MEDIA, "renders", String(old.id))), "a 31-day-old clip was kept");
    assert.strictEqual((await store.getRender(old.id)).output_key, "");
    assert.strictEqual(keptClips(fresh.id).length, 1);
    assert.strictEqual(service.KEEP_DAYS, 30);
    const doc = await db.one(`SELECT path FROM documents WHERE id = $1`, [delivered.document_id]);
    assert.ok(exists(doc.path));
  });

  await atest("deleting the account erases the rows and every file — their clips others received too", async () => {
    const privacy = require("../src/routes/privacy");
    await call(E, "/avatar-profile/consent", { method: "POST" });
    assert.strictEqual((await uploadVideo(E)).status, 200);
    const r = await store.createRender({ userId: E, recipientName: "Danush", recipientPhone: PHONE.R,
      recipientUserId: R, script: "Hello.", sourceKey: (await store.getProfile(E)).video_key });
    const key = service.outputKey(r.id);
    await media.put(key, mp4(512));
    await store.updateRender(r.id, { output_key: key });
    // One that reached Danush: an AI clip of E's face in HIS documents.
    const sent = await store.createRender({ userId: E, recipientName: "Danush", recipientPhone: PHONE.R,
      recipientUserId: R, script: "Delivered, then erased.", sourceKey: (await store.getProfile(E)).video_key });
    assert.strictEqual((await verify(sent.id)).status, 200);
    await service.storeOutput(sent.id, tmpClip("erase.mp4", mp4(700, 8)));
    const out = await service.deliver(sent.id);
    const copy = await db.one(`SELECT * FROM documents WHERE id = $1`, [out.document_id]);
    assert.strictEqual(copy.user_id, R);
    assert.ok(exists(copy.path));
    const report = await privacy.deleteUserEverywhere(E, { reason: "test" });
    assert.strictEqual(report.rows.avatar_profiles, 1);
    assert.strictEqual(report.rows.avatar_renders, 2);
    assert.strictEqual(report.rows.delivered_video_notes, 1);
    // Their video, two kept clips, and Danush's copy.
    assert.strictEqual(report.files.media, 4);
    assert.ok(report.totalFiles >= 4);
    assert.ok(!exists(path.join(MEDIA, "identity", String(E))));
    assert.ok(!exists(path.join(MEDIA, "renders", String(r.id))));
    assert.ok(!exists(path.join(MEDIA, "renders", String(sent.id))));
    assert.strictEqual(await db.one(`SELECT id FROM documents WHERE id = $1`, [out.document_id]), null,
      "the recipient's copy of an erased user's face stayed");
    assert.ok(!exists(copy.path));
    // Danush's other documents are his and stay.
    const theirs = await db.one(`SELECT path FROM documents WHERE id = $1`, [delivered.document_id]);
    assert.ok(theirs && exists(theirs.path));
    assert.strictEqual(await store.getProfile(E), null);
    assert.strictEqual(await store.getRender(r.id), null);
    // An identity folder whose account is gone is a Leftover.
    await media.put(`identity/${E}/video-ghost.mp4`, mp4(256));
    const found = await privacy.findOrphans();
    assert.ok(found.files.mediaFolders >= 1 && found.files.mediaFiles >= 1, JSON.stringify(found.files));
    await media.deletePrefix(`identity/${E}/`);
  });

  await atest("a media key can never point outside its folder", () => {
    for (const bad of ["../x", "identity/../../etc", "/abs/path", "C:\\x", "identity//x", "", ".hidden"]) {
      assert.throws(() => media.stream(bad), /bad media key/, bad);
      assert.strictEqual(media.isKey(bad), false, bad);
    }
    assert.strictEqual(media.isKey("identity/12/video-abc.mp4"), true);
  });

  /* ================================================================ */
  server.close();
  for (const uid of USERS) {
    if (uid === E) continue;
    await require("../src/routes/privacy").deleteUserEverywhere(uid, { reason: "test cleanup" }).catch(() => {});
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
