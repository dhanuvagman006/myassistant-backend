/**
 * PHONE NUMBER VERIFICATION (services/pnv.js, routes/phone.js).
 *
 * Tokens are signed here with a key of our own and served from a local
 * key set standing in for https://fpnv.googleapis.com/v1beta/jwks, so every
 * rule Google's docs give is checked: ES256 only, typ JWT, the project's
 * issuer and audience, expiry, the number in `sub` — plus ours: one use per
 * token, one number per account, a clear word when Google is out of reach,
 * and old builds (the SMS code) told to update.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
delete process.env.FIREBASE_PROJECT_NUMBER;
delete process.env.ALLOW_DEV_PHONE_VERIFY;

const assert = require("assert");
const http = require("http");
const express = require("express");
const { generateKeyPair, exportJWK, SignJWT } = require("jose");
const db = require("../src/db");

let passed = 0;
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
}

(async () => {
  await db.init();

  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const stranger = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  let jwksStatus = 200;
  const jwksServer = http.createServer((_req, res) => {
    res.writeHead(jwksStatus, { "Content-Type": "application/json" });
    res.end(jwksStatus === 200 ? JSON.stringify({ keys: [jwk] }) : "{}");
  });
  await new Promise((r) => jwksServer.listen(0, "127.0.0.1", r));
  const JWKS = `http://127.0.0.1:${jwksServer.address().port}/v1beta/jwks`;
  process.env.PNV_JWKS_URL = JWKS;

  const pnv = require("../src/services/pnv");
  const phoneRoutes = require("../src/routes/phone");
  const ISS = `https://fpnv.googleapis.com/projects/${pnv.DEFAULT_PROJECT_NUMBER}`;
  const AUD = [ISS, "https://fpnv.googleapis.com/projects/hari-62ec0"];

  // A fresh number per run: the dev database keeps numbers between runs.
  const tail = String(Date.now()).slice(-8);
  const NUM_A = `+9198${tail}`;
  const NUM_A2 = `+9197${tail}`;

  let seq = 0;
  const token = (over = {}, { key = privateKey, alg = "ES256", typ = "JWT", kid = "k1" } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: ISS, aud: AUD, sub: NUM_A, iat: now, exp: now + 300, jti: `t${++seq}`, ...over };
    for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
    return new SignJWT(claims).setProtectedHeader({ alg, typ, kid }).sign(key);
  };

  const A = await db.createUser({ email: `pnv-a-${tail}@test.local`, name: "Pnv A" });
  const B = await db.createUser({ email: `pnv-b-${tail}@test.local`, name: "Pnv B" });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { sub: String(req.headers["x-uid"]) }; next(); });
  app.use("/phone", phoneRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/phone`;
  const call = async (uid, method, path, body) => {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", "x-uid": String(uid) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const row = (id) => db.one("SELECT phone_number, phone_verified_at FROM users WHERE id = $1", [id]);

  console.log("pnv: the token");

  await atest("a token signed by Google's key for this project is the number in its subject", async () => {
    const v = await pnv.verify(await token());
    assert.strictEqual(v.ok, true, JSON.stringify(v));
    assert.strictEqual(v.phone, NUM_A);
    assert.match(v.hash, /^[0-9a-f]{64}$/);
    assert.ok(v.expiresAt > Date.now());
  });

  await atest("another project's issuer or audience is refused", async () => {
    assert.deepStrictEqual(await pnv.verify(await token({ iss: "https://fpnv.googleapis.com/projects/999" })), { ok: false, error: "invalid" });
    assert.deepStrictEqual(await pnv.verify(await token({ aud: ["https://fpnv.googleapis.com/projects/999"] })), { ok: false, error: "invalid" });
  });

  await atest("a token signed by any other key, or not with ES256, is refused", async () => {
    assert.strictEqual((await pnv.verify(await token({}, { key: stranger.privateKey }))).error, "invalid");
    const hs = await token({}, { alg: "HS256", key: new TextEncoder().encode("x".repeat(32)) });
    assert.strictEqual((await pnv.verify(hs)).error, "invalid");
  });

  await atest("the header must say typ JWT", async () => {
    assert.strictEqual((await pnv.verify(await token({}, { typ: "at+jwt" }))).error, "invalid");
  });

  await atest("an expired token says expired; one with no number is refused", async () => {
    const now = Math.floor(Date.now() / 1000);
    assert.deepStrictEqual(await pnv.verify(await token({ exp: now - 120, iat: now - 600 })), { ok: false, error: "expired" });
    assert.strictEqual((await pnv.verify(await token({ sub: undefined }))).error, "invalid");
  });

  await atest("nothing, or something that is not a JWT, never reaches the key set", async () => {
    assert.deepStrictEqual(await pnv.verify(""), { ok: false, error: "missing" });
    assert.deepStrictEqual(await pnv.verify(undefined), { ok: false, error: "missing" });
    assert.deepStrictEqual(await pnv.verify("not a token"), { ok: false, error: "malformed" });
    assert.deepStrictEqual(await pnv.verify("a.b.c".repeat(3000)), { ok: false, error: "malformed" });
  });

  await atest("Google's keys out of reach is 'unavailable', never a bad token", async () => {
    const t = await token();
    try {
      process.env.PNV_JWKS_URL = "http://127.0.0.1:1/v1beta/jwks"; // nothing listens there
      assert.deepStrictEqual(await pnv.verify(t), { ok: false, error: "unavailable" });
      jwksStatus = 500;
      process.env.PNV_JWKS_URL = JWKS + "?fresh=1"; // a key set that must be fetched now
      assert.deepStrictEqual(await pnv.verify(t), { ok: false, error: "unavailable" });
    } finally {
      jwksStatus = 200;
      process.env.PNV_JWKS_URL = JWKS;
    }
  });

  await atest("a token counts once; expired entries are cleared", async () => {
    const now = Date.now();
    assert.strictEqual(await pnv.claimOnce(`h1-${tail}`, now + 60_000, now), true);
    assert.strictEqual(await pnv.claimOnce(`h1-${tail}`, now + 60_000, now), false);
    // Twenty minutes on, h1 has lapsed: the next claim clears it away.
    const later = now + 20 * 60_000;
    assert.strictEqual(await pnv.claimOnce(`h2-${tail}`, later + 60_000, later), true);
    assert.strictEqual(await pnv.claimOnce(`h1-${tail}`, later + 60_000, later), true);
  });

  console.log("pnv: the routes");

  await atest("GET /phone/methods says what the screen may offer", async () => {
    assert.deepStrictEqual((await call(A.id, "GET", "/methods")).body, { sim: true, typed: false });
    process.env.ALLOW_DEV_PHONE_VERIFY = "true";
    try {
      assert.deepStrictEqual((await call(A.id, "GET", "/methods")).body, { sim: true, typed: true });
    } finally {
      delete process.env.ALLOW_DEV_PHONE_VERIFY;
    }
  });

  const first = await token();
  await atest("POST /phone/verify stores the token's number as verified", async () => {
    const r = await call(A.id, "POST", "/verify", { pnvToken: first });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.phone, NUM_A);
    assert.strictEqual(r.body.user.phoneVerified, true);
    const u = await row(A.id);
    assert.strictEqual(u.phone_number, NUM_A);
    assert.ok(Number(u.phone_verified_at) > 0);
  });

  await atest("the same token again from the same account is 'done' (a retry after a lost reply)", async () => {
    const r = await call(A.id, "POST", "/verify", { pnvToken: first });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.phone, NUM_A);
  });

  await atest("the same token from another account is refused as already used", async () => {
    const r = await call(B.id, "POST", "/verify", { pnvToken: first });
    assert.strictEqual(r.status, 401);
    assert.match(r.body.error, /already used/);
    assert.strictEqual((await row(B.id)).phone_number, null);
  });

  await atest("a fresh token for a number another account holds is 409, never a move", async () => {
    const r = await call(B.id, "POST", "/verify", { pnvToken: await token() });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, "This number is already registered to another account.");
    assert.strictEqual((await row(A.id)).phone_number, NUM_A);
  });

  await atest("a new SIM's token replaces the account's number", async () => {
    const r = await call(A.id, "POST", "/verify", { pnvToken: await token({ sub: NUM_A2 }) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual((await row(A.id)).phone_number, NUM_A2);
  });

  await atest("bad and expired tokens are 401 with words the app can show", async () => {
    const bad = await call(B.id, "POST", "/verify", { pnvToken: await token({}, { key: stranger.privateKey }) });
    assert.deepStrictEqual([bad.status, bad.body.error], [401, "invalid verification token"]);
    const now = Math.floor(Date.now() / 1000);
    const old = await call(B.id, "POST", "/verify", { pnvToken: await token({ exp: now - 120, iat: now - 600 }) });
    assert.strictEqual(old.status, 401);
    assert.match(old.body.error, /expired/);
    const none = await call(B.id, "POST", "/verify", {});
    assert.strictEqual(none.status, 401);
  });

  await atest("an app still sending the SMS code's Firebase token is told to update (426)", async () => {
    const r = await call(B.id, "POST", "/verify", { firebaseIdToken: "eyJhbGciOi.x.y" });
    assert.deepStrictEqual([r.status, r.body.error], [426, "Update the app to verify your number."]);
  });

  await atest("a deleted account is told to sign in again, before any token is looked at", async () => {
    const r = await call(987654321, "POST", "/verify", { pnvToken: await token() });
    assert.deepStrictEqual([r.status, r.body.error], [401, phoneRoutes.ACCOUNT_GONE]);
  });

  await atest("with no project number the server says verification is unavailable", async () => {
    process.env.FIREBASE_PROJECT_NUMBER = "not-a-number";
    try {
      assert.strictEqual((await call(B.id, "GET", "/methods")).body.sim, false);
      assert.strictEqual((await call(B.id, "POST", "/verify", { pnvToken: await token() })).status, 503);
    } finally {
      delete process.env.FIREBASE_PROJECT_NUMBER;
    }
  });

  await atest("the typed testing path shares the one-number-one-account rule", async () => {
    assert.strictEqual((await call(B.id, "POST", "/dev-verify", { phone: NUM_A2 })).status, 403);
    process.env.ALLOW_DEV_PHONE_VERIFY = "true";
    try {
      const taken = await call(B.id, "POST", "/dev-verify", { phone: NUM_A2 });
      assert.strictEqual(taken.status, 409);
      const ok = await call(B.id, "POST", "/dev-verify", { phone: NUM_A });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.strictEqual((await row(B.id)).phone_number, NUM_A);
    } finally {
      delete process.env.ALLOW_DEV_PHONE_VERIFY;
    }
  });

  await atest("no route in the app's phone verification talks about a code any more", () => {
    const src = require("fs").readFileSync(require.resolve("../src/routes/phone"), "utf8");
    assert.doesNotMatch(src, /verifyIdToken|\bOTP\b/);
    assert.strictEqual(typeof require("../src/services/firebase").verifyIdToken, "undefined");
  });

  server.close();
  jwksServer.close();
  await db.run("DELETE FROM users WHERE id = ANY($1)", [[A.id, B.id]]).catch((e) => console.warn("cleanup:", e.message));
  await db.run("DELETE FROM phone_pnv_used WHERE token_hash LIKE $1", [`%-${tail}`]).catch(() => {});
  await db.close();
  console.log(`\n${passed} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
