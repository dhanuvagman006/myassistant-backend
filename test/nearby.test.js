/**
 * PEOPLE NEARBY WHO SHARE WHAT THEY DO — `npm run test:nearby`.
 *
 * Pins: a profession and its other names match; only people who switched
 * sharing on, within reach, are listed, never the asker; the position is
 * coarse and gone when sharing is off; a message reaches the person
 * through their assistant; the places tool lists people beside places.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
const assert = require("assert");
const db = require("../src/db");
const N = require("../src/people/nearby");

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); }
}

// Kadri, Mangalore; and points about 1.5 km and 40 km away.
const HERE = { lat: 12.8902, lng: 74.8560 };
const NEAR = { lat: 12.9020, lng: 74.8600 };
const FAR = { lat: 13.2, lng: 75.1 };

(async () => {
  await db.init();
  const mk = async (name, fields) => {
    const u = await db.createUser({ email: `nearby-${name.toLowerCase().replace(/\s/g, "")}-${Date.now()}@example.com`, name, provider: "email" });
    await db.run("UPDATE users SET phone_number=$2, fcm_token=$3 WHERE id=$1", [u.id, fields.phone || null, fields.fcm || ""]);
    await N.setProfession(u.id, { profession: fields.profession, shared: fields.shared, lat: fields.at?.lat, lng: fields.at?.lng });
    return u.id;
  };
  const ids = [];
  try {
    const asker = await mk("Dhanush A", { profession: "developer", shared: false });
    const lawyer = await mk("Ravi Shetty", { profession: "Advocate", shared: true, at: NEAR, phone: "+919800000001", fcm: "tok-ravi" });
    const electrician = await mk("Suresh K", { profession: "electrician", shared: true, at: NEAR });
    const hidden = await mk("Priya Rao", { profession: "lawyer", shared: false, at: NEAR });
    const far = await mk("Anil M", { profession: "lawyer", shared: true, at: FAR });
    ids.push(asker, lawyer, electrician, hidden, far);

    await check("a profession and its other names match; unrelated ones do not", () => {
      assert.strictEqual(N.matches("Advocate", "find me nearby lawyers"), true);
      assert.strictEqual(N.matches("lawyer", "any advocate near me"), true);
      assert.strictEqual(N.matches("Chartered Accountant", "need a CA"), true);
      assert.strictEqual(N.matches("electrician", "a doctor near me"), false);
      assert.strictEqual(N.matches("drone pilot", "drone pilots nearby"), true);
      assert.deepStrictEqual(N.canonical("I am a software developer"), ["software engineer"]);
    });

    await check("the position kept is coarse, and gone when sharing is off", async () => {
      const row = await db.one("SELECT geo_lat, geo_lng, profession_shared FROM users WHERE id=$1", [lawyer]);
      assert.strictEqual(Number(row.geo_lat), 12.9);
      assert.strictEqual(Number(row.geo_lng), 74.86);
      assert.strictEqual(Number(row.profession_shared), 1);
      const off = await db.one("SELECT geo_lat, profession_shared FROM users WHERE id=$1", [hidden]);
      assert.strictEqual(off.geo_lat, null);
      assert.strictEqual(Number(off.profession_shared), 0);
      assert.deepStrictEqual(await N.me(hidden), { profession: "lawyer", organisation: "", shared: false, area: "", locatedAt: 0 });
    });

    await check("only people sharing, within reach, are listed — nearest first, never the asker", async () => {
      const list = await N.search({ q: "nearby lawyers", lat: HERE.lat, lng: HERE.lng, excludeUserId: asker });
      assert.deepStrictEqual(list.map((p) => p.name), ["Ravi Shetty"]);
      assert.strictEqual(list[0].profession, "Advocate");
      assert.ok(list[0].distanceKm > 0.5 && list[0].distanceKm < 3, `distance ${list[0].distanceKm}`);
      assert.strictEqual(list[0]._phone, undefined, "no phone number in a result");
      const wide = await N.search({ q: "lawyer", lat: HERE.lat, lng: HERE.lng, radiusKm: 100, excludeUserId: asker });
      assert.deepStrictEqual(wide.map((p) => p.name), ["Ravi Shetty", "Anil M"]);
      const self = await N.search({ q: "electrician", lat: HERE.lat, lng: HERE.lng, excludeUserId: electrician });
      assert.deepStrictEqual(self, []);
      assert.deepStrictEqual(await N.search({ q: "lawyer", lat: null, lng: null }), []);
    });

    await check("'message Ravi' after a search reaches the person found", async () => {
      await N.search({ q: "lawyers", lat: HERE.lat, lng: HERE.lng, excludeUserId: asker });
      const hit = N.recentMatch(asker, "Ravi");
      assert.ok(hit && hit.id === lawyer, "the lawyer found a moment ago");
      assert.strictEqual(N.recentMatch(asker, "Nobody"), null);
    });

    await check("a message goes through their assistant, with a push, never to someone not sharing", async () => {
      const push = require("../src/services/push");
      const pushes = [];
      const real = push.sendNotification;
      push.sendNotification = async (token, title, body, data) => { pushes.push({ token, title, body, data }); return true; };
      try {
        const r = await N.contact(asker, lawyer, "Hello, I need help with a rent agreement.");
        assert.deepStrictEqual(r, { ok: true });
        const row = await db.one("SELECT from_user_id, to_phone_number, message FROM agent_messages WHERE from_user_id=$1 ORDER BY id DESC LIMIT 1", [asker]);
        assert.strictEqual(row.to_phone_number, "+919800000001");
        assert.match(row.message, /^Via Nearby — Dhanush A \(developer\): Hello, I need help/);
        assert.strictEqual(pushes.length, 1);
        assert.match(pushes[0].title, /Dhanush A .*found you on Nearby/);
        assert.deepStrictEqual(await N.contact(asker, hidden, "hi"), { ok: false, error: "not reachable" });
        assert.deepStrictEqual(await N.contact(asker, asker, "hi"), { ok: false, error: "bad request" });
      } finally {
        push.sendNotification = real;
      }
    });

    await check("the places tool lists the people beside the places and says so", async () => {
      const registry = require("../src/tools/registry");
      require("../src/tools/builtins").registerBuiltins();
      const ws = require("../src/tools/webSearch");
      const realRun = ws.run;
      ws.run = async () => ({ ok: true, data: [{ title: "Shetty & Co Advocates - Kadri", snippet: "Lawyers in Mangalore", url: "https://x.in/a" }] });
      try {
        const r = await registry.get("find_places_nearby").execute({ query: "lawyers near me", open_map: false },
          { userId: asker, lat: HERE.lat, lng: HERE.lng, deviceCaps: { granted: ["location"] } });
        assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 200));
        assert.deepStrictEqual(r.data.people.map((p) => p.name), ["Ravi Shetty"]);
        assert.match(r.speak, /People on this app nearby: Ravi Shetty \(Advocate/);
        assert.match(r.speak, /offer to message one/);
      } finally {
        ws.run = realRun;
      }
    });
  } finally {
    for (const id of ids) {
      await db.run("DELETE FROM agent_messages WHERE from_user_id=$1", [id]).catch(() => {});
      await db.run("DELETE FROM users WHERE id=$1", [id]).catch(() => {});
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
