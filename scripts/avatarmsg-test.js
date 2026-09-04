/**
 * AVATAR MESSAGES TEST — boots the real server and proves the
 * personalized-avatar pipeline's contract without any external provider:
 *
 *   security   unauthenticated access refused; asset upload refused
 *              before consent; cross-user media access refused
 *   profile    consent → upload face/voice → profile reflects it → erase
 *   pipeline   generateForMessage degrades to plain text when no engine
 *              works, and records the attempt in avatar_renders
 *   inbox      unread rows carry media fields; recipient (and ONLY the
 *              addressed recipient) can stream the media
 *
 * Run inside the backend container (needs Postgres):
 *   docker compose exec backend node scripts/avatarmsg-test.js
 */
// Fixed port, deliberately NOT inherited: a dev server on the .env PORT
// would otherwise answer these requests with its older code.
process.env.PORT = "3998";
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "ci-avatar-secret-0123456789abcdefghijklmnopqr";
process.env.NODE_ENV = "test";
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "ci-dummy-key";
// The auth checks below are the point — never run them with auth disabled,
// whatever the local .env says.
process.env.AUTH_DISABLED = "false";
process.env.ALLOW_APP_KEY = "false";
// Point the voice floor at nothing real: the ladder must end in 'text'.
delete process.env.AVATAR_WORKER_URL;
delete process.env.DID_API_KEY;
delete process.env.ELEVENLABS_API_KEY;

const jwt = require("jsonwebtoken");
const BASE = `http://localhost:${process.env.PORT}`;

let passed = 0;
function ok(cond, name) {
  if (!cond) throw new Error(`FAIL: ${name}`);
  passed++;
  console.log(`✓ ${name}`);
}

async function req(path, { method = "GET", token, body, form, raw } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const r = await fetch(BASE + path, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(15000),
  });
  if (raw) return r;
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, json };
}

// A 1x1 white JPEG and a minimal WAV header — tiny but genuinely typed.
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64"
);
const WAV = Buffer.concat([
  Buffer.from("RIFF"), Buffer.from([36, 0, 0, 0]), Buffer.from("WAVEfmt "),
  Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x80, 0x3e, 0, 0, 2, 0, 16, 0]),
  Buffer.from("data"), Buffer.from([0, 0, 0, 0]),
]);

function multipart(field, filename, mime, buf) {
  const form = new FormData();
  form.append(field, new Blob([buf], { type: mime }), filename);
  return form;
}

async function waitForBoot() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) return;
    } catch (_) {}
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error("server did not become healthy within 20s");
}

(async () => {
  require("../src/server");
  await waitForBoot();
  const db = require("../src/db");

  // Three fresh users: Alice (sender), Bob (recipient), Carol (stranger).
  const mk = async (name, phone) => {
    const rows = await db.query(
      `INSERT INTO users (email, name, created_at, phone_number, phone_verified_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [`${name}-${Date.now()}@avatartest.local`, name, Date.now(),
       phone, phone ? Date.now() : null]
    );
    const id = rows[0].id;
    return { id, token: jwt.sign({ uid: id }, process.env.JWT_SECRET) };
  };
  const suffix = String(Date.now()).slice(-7);
  const alice = await mk("Alice", `+9111${suffix}`);
  const bob = await mk("Bob", `+9122${suffix}`);
  const carol = await mk("Carol", `+9133${suffix}`);

  /* ------------------------------ security ------------------------------ */
  ok((await req("/avatar-profile")).status === 401, "profile refused unauthenticated");
  ok(
    (await req("/avatar-profile/face", {
      method: "POST", token: alice.token,
      form: multipart("file", "f.jpg", "image/jpeg", JPEG),
    })).status === 403,
    "face upload refused before consent"
  );

  /* ------------------------------ profile ------------------------------ */
  let r = await req("/avatar-profile/consent", { method: "POST", token: alice.token });
  ok(r.status === 200, "consent recorded");
  r = await req("/avatar-profile/face", {
    method: "POST", token: alice.token,
    form: multipart("file", "f.jpg", "image/jpeg", JPEG),
  });
  ok(r.status === 200, "face uploaded after consent");
  r = await req("/avatar-profile/voice", {
    method: "POST", token: alice.token,
    form: multipart("file", "v.wav", "audio/wav", WAV),
  });
  ok(r.status === 200, "voice sample uploaded");
  r = await req("/avatar-profile", { token: alice.token });
  ok(
    r.json?.consented === true && r.json?.has_face === true && r.json?.has_voice === true,
    "profile reflects consent + assets"
  );
  ok(
    (await req("/avatar-profile/face", {
      method: "POST", token: alice.token,
      form: multipart("file", "evil.txt", "text/plain", Buffer.from("x")),
    })).status === 400,
    "non-image face rejected"
  );

  /* ------------------------------ pipeline ------------------------------ */
  // No engine can actually work (dummy Gemini key, no worker/D-ID/11labs):
  // the orchestrator must end in a plain-text delivery and say so in the
  // render record — the message row is never blocked.
  const msg = await db.query(
    `INSERT INTO agent_messages (from_user_id, to_phone_number, message, created_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [alice.id, `+9122${suffix}`, "I'll be ten minutes late.", Date.now()]
  );
  const service = require("../src/avatarmsg/service");
  await service.generateForMessage({
    messageId: msg[0].id,
    fromUserId: alice.id,
    fromUserName: "Alice",
    toPhone: `+9122${suffix}`,
    text: "I'll be ten minutes late.",
    fcmToken: "",
  });
  const rend = await db.one(
    `SELECT * FROM avatar_renders WHERE message_id = $1`, [msg[0].id]
  );
  // With a dummy Gemini key the ladder must land on text/failed; with a
  // real one it lands on 'audio' (the Level-3 voice floor) and the message
  // row must carry the media. Both are correct — 'video' can't happen here
  // because no face engine is configured.
  ok(rend && ["text", "failed", "audio"].includes(rend.status),
    `ladder degrades gracefully (got '${rend?.status}')`);
  if (rend?.status === "audio") {
    const mrow = await db.one(`SELECT media_kind FROM agent_messages WHERE id = $1`, [msg[0].id]);
    ok(mrow?.media_kind === "audio" && rend.media_path && rend.first_audio_at > 0,
      "audio delivery wired to the message row with TTFA recorded");
  }
  ok(rend.request_id?.length > 10, "render carries a traceable request id");

  /* ------------------------------- inbox -------------------------------- */
  // Simulate a successful render so the media path can be exercised.
  const store = require("../src/avatarmsg/store");
  const fakeVideo = Buffer.concat([Buffer.from("\0\0\0 ftypisom"), Buffer.alloc(64)]);
  const rid = await store.createRender({
    requestId: "test-req", messageId: msg[0].id, fromUserId: alice.id,
    toPhone: `+9122${suffix}`, textLen: 10,
  });
  const mediaPath = await store.saveRender(rid, fakeVideo, "video/mp4");
  await store.updateRender(rid, {
    status: "video", media_path: mediaPath, media_mime: "video/mp4",
    completed_at: Date.now(),
  });
  await db.run(
    `UPDATE agent_messages SET render_id = $1, media_kind = 'video' WHERE id = $2`,
    [rid, msg[0].id]
  );

  r = await req("/messages/unread", { token: bob.token });
  const row = r.json?.messages?.find((m) => m.id === msg[0].id);
  ok(row?.media === "video" && row?.media_url === `/messages/${msg[0].id}/media`,
    "unread row carries media kind + url");

  const media = await req(`/messages/${msg[0].id}/media`, { token: bob.token, raw: true });
  ok(media.status === 200 &&
     media.headers.get("content-type") === "video/mp4" &&
     (await media.arrayBuffer()).byteLength === fakeVideo.length,
    "addressed recipient streams the media");
  ok((await req(`/messages/${msg[0].id}/media`, { token: carol.token })).status === 404,
    "stranger gets 404, not the media");
  ok((await req(`/messages/${msg[0].id}/media`, { token: alice.token })).status === 404,
    "even the sender cannot fetch via the recipient inbox route");
  const ranged = await req(`/messages/${msg[0].id}/media`, { token: bob.token, raw: true, });
  ok(ranged.status === 200, "range-less fetch OK");

  /* ------------------------------- erase -------------------------------- */
  ok((await req("/avatar-profile", { method: "DELETE", token: alice.token })).status === 200,
    "identity erased");
  r = await req("/avatar-profile", { token: alice.token });
  ok(r.json?.consented === false && r.json?.has_face === false,
    "profile empty after erase");

  // Cleanup.
  await db.run(`DELETE FROM agent_messages WHERE id = $1`, [msg[0].id]);
  await db.run(`DELETE FROM avatar_renders WHERE message_id = $1 OR id = $2`, [msg[0].id, rid]);
  for (const u of [alice, bob, carol]) {
    await db.run(`DELETE FROM users WHERE id = $1`, [u.id]);
  }

  console.log(`\nALL ${passed} CHECKS PASSED`);
  process.exit(0);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
