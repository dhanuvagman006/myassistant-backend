/**
 * ASSISTANT FUNCTIONS — `npm run test:appfunctions`.
 *
 * Android AppFunctions (Android 16+): Gemini and other system agents act
 * on the user's list, reminders, Today's 3 and habits through the app's
 * background service, which holds a narrow "appfn" key (src/appfunctions).
 *
 * Boots the REAL server (real appAuth, real routes, real tools, real
 * Postgres) with every outbound call answered locally, and pins:
 *   (a) the key: minted by a session only, 30 days, scope appfn, the
 *       user's epoch; expired / forged / wrong-epoch keys refused; DELETE
 *       bumps the epoch and every earlier key stops; a deleted account's
 *       key fails as its session does;
 *   (b) the key is refused (403) on every other route, and a session token
 *       works on /appfunctions too;
 *   (c) every route's happy path and bad input (400), the 404 / 409 codes,
 *       the device offset (header, then the saved one, then IST);
 *   (d) another user's data is never visible or touched;
 *   (e) a tool that needs a yes answers 409 needs_confirmation, nothing runs;
 *   (f) the ledger and the audit trail record source "appfunctions";
 *   (g) its own per-user limiter, 60 a minute.
 */
"use strict";

process.env.NODE_ENV = process.env.NODE_ENV || "test";
if (process.env.NODE_ENV === "production") {
  console.error("appfunctions-test must never run against production");
  process.exit(2);
}
process.env.DATABASE_URL = process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@127.0.0.1:56432/myassistant";

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "appfunctions-"));
process.env.DATA_DIR = path.join(TMP, "data");
process.env.MEDIA_DIR = path.join(TMP, "media");
process.env.MEDIA_BACKEND = "local";
process.env.LIVE_RECORD_DIR = path.join(TMP, "recordings");
process.env.LIVE_RECORD = "0";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "appfunctions-" + crypto.randomBytes(16).toString("hex");
// The routes' own limiter is tested on its own at the end; here it must
// not get in the way of a long run for one user.
process.env.APPFUNCTIONS_RATE_PER_MIN = "100000";
for (const k of [
  "OPENAI_API_KEY", "GEMINI_MODEL", "GEMINI_LIVE_MODEL", "GEMINI_TTS_MODEL", "OPENAI_API_KEY",
  "AUTH_DISABLED", "ALLOW_APP_KEY", "APP_API_KEY", "METRICS_TOKEN", "PLIVO_AUTH_TOKEN",
  "BOLNA_API_KEY", "TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY", "GOOGLE_CSE_KEY", "HEYGEN_API_KEY",
  "AI_APPROVAL_SECRET", "SHORTCUTS",
]) delete process.env[k];
const BACKEND = path.resolve(__dirname, "..");
process.chdir(TMP); // no .env here

// Nothing leaves this machine.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url && url.url ? url.url : url);
  if (/^http:\/\/127\.0\.0\.1:\d+\//.test(u)) return realFetch(url, opts);
  return new Response(JSON.stringify({ error: "offline in appfunctions-test" }),
    { status: 503, headers: { "content-type": "application/json" } });
};
const push = require(path.join(BACKEND, "src/services/push"));
push.send = async () => ({ ok: true, stub: true });
push.sendNotification = async () => ({ ok: true, stub: true });

const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const db = require(path.join(BACKEND, "src/db"));
const { freePort } = require("./_free-port");

let passed = 0;
let failed = 0;
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n       ${String(e && (e.stack || e.message) || e).split("\n").slice(0, 6).join("\n       ")}`);
    process.exitCode = 1;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(50); }
  return last;
}

let BASE = "";
let ip = 0;
async function api(method, p, { token, body, tz } = {}) {
  const h = { "X-Forwarded-For": `198.51.100.${(ip++ % 250) + 1}` };
  if (token) h.Authorization = `Bearer ${token}`;
  if (tz !== undefined) h["X-TZ-Offset"] = String(tz);
  if (body !== undefined) h["content-type"] = "application/json";
  const r = await realFetch(BASE + p, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}
const ok = (r, status = 200) => assert.strictEqual(r.status, status, `${r.status} ${r.text}`);
const badInput = (r, rx) => {
  ok(r, 400);
  assert.strictEqual(r.json.error, "bad_input", r.text);
  assert.ok(r.json.message && r.json.message.length > 5, "a clear message");
  if (rx) assert.match(r.json.message, rx);
};

const pad = (n) => String(n).padStart(2, "0");
/** The local calendar date (YYYY-MM-DD) at `ms` for an offset in minutes. */
function localDate(ms, tz) {
  const d = new Date(ms + tz * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
const offText = (tz) => `${tz < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(tz) / 60))}:${pad(Math.abs(tz) % 60)}`;

(async () => {
  process.env.PORT = String(await freePort());
  BASE = `http://127.0.0.1:${process.env.PORT}`;
  require(path.join(BACKEND, "src/server"));
  await waitFor(async () => {
    try { return (await api("GET", "/health")).status === 200; } catch (_) { return false; }
  }, 30_000);

  const registry = require(path.join(BACKEND, "src/tools/registry"));
  const momentum = require(path.join(BACKEND, "src/momentum/service"));
  const privacy = require(path.join(BACKEND, "src/routes/privacy"));
  const SECRET = process.env.JWT_SECRET;

  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const made = [];
  async function mkUser(tag) {
    const u = await db.createUser({ email: `appfn-${tag}-${stamp}@example.test`, name: `AppFn ${tag}` });
    made.push(u.id);
    return { id: u.id, session: jwt.sign({ uid: u.id }, SECRET, { expiresIn: "1h" }) };
  }
  async function mintKey(user) {
    const r = await api("POST", "/appfunctions/token", { token: user.session });
    ok(r);
    return r.json.token;
  }
  const epochOf = async (id) => Number((await db.one(`SELECT appfn_epoch FROM users WHERE id=$1`, [id])).appfn_epoch);

  const A = await mkUser("a");
  const B = await mkUser("b");
  const C = await mkUser("c"); // a saved offset, no header
  const E = await mkUser("e"); // no offset at all → IST

  // An offset that puts the device's clock near noon, so "today" has room
  // on both sides whatever time the suite runs.
  const nowUtcMin = Math.floor(Date.now() / 60_000) % 1440;
  let TZMID = 720 - nowUtcMin;
  if (TZMID > 720) TZMID -= 1440;
  if (TZMID < -720) TZMID += 1440;

  try {
    /* ---------------------------- the key ---------------------------- */

    await atest("a signed-in session mints an appfn key: 30 days, scope appfn, the user's epoch", async () => {
      const r = await api("POST", "/appfunctions/token", { token: A.session });
      ok(r);
      const p = jwt.verify(r.json.token, SECRET, { algorithms: ["HS256"] });
      assert.strictEqual(p.scope, "appfn");
      assert.strictEqual(p.uid, A.id);
      assert.strictEqual(p.ep, 0);
      assert.strictEqual(p.exp - p.iat, 30 * 86_400);
      assert.strictEqual(r.json.expiresAt, p.exp * 1000);
      assert.ok(Math.abs(r.json.expiresAt - (Date.now() + 30 * 86_400_000)) < 120_000, "expiresAt is unix ms, 30 days out");
      A.key = r.json.token;
    });

    await atest("the key is refused everywhere else with 403 (profile, ai/context, shopping, reminders, auth/me, momentum)", async () => {
      const routes = [
        ["GET", "/profile"], ["POST", "/ai/context", {}], ["GET", "/shopping"], ["GET", "/reminders"],
        ["GET", "/auth/me"], ["GET", "/momentum"], ["GET", "/actions"], ["GET", "/privacy/export"],
      ];
      for (const [method, p, body] of routes) {
        const r = await api(method, p, { token: A.key, body });
        assert.strictEqual(r.status, 403, `${method} ${p}: ${r.status} ${r.text}`);
        assert.deepStrictEqual(r.json, { error: "this key only works for assistant functions" }, `${method} ${p}`);
      }
      // …while the session itself still opens them.
      for (const p of ["/shopping", "/reminders", "/auth/me"]) {
        const r = await api("GET", p, { token: A.session });
        assert.strictEqual(r.status, 200, `${p} with a session: ${r.status} ${r.text}`);
      }
    });

    await atest("the key cannot mint or revoke keys", async () => {
      const mint = await api("POST", "/appfunctions/token", { token: A.key });
      assert.strictEqual(mint.status, 403, mint.text);
      assert.strictEqual(mint.json.error, "this key only works for assistant functions");
      const revoke = await api("DELETE", "/appfunctions/token", { token: A.key });
      assert.strictEqual(revoke.status, 403, revoke.text);
      assert.strictEqual(await epochOf(A.id), 0, "the epoch did not move");
      ok(await api("GET", "/appfunctions/shopping", { token: A.key }));
    });

    await atest("a normal session token works on /appfunctions too", async () => {
      ok(await api("GET", "/appfunctions/shopping", { token: A.session }));
      ok(await api("GET", "/appfunctions/my-day", { token: A.session, tz: TZMID }));
    });

    await atest("expired, forged-scope, epoch-less, future-epoch and wrong-secret keys are refused (401)", async () => {
      const now = Math.floor(Date.now() / 1000);
      const bad = {
        expired: jwt.sign({ uid: A.id, scope: "appfn", ep: 0, iat: now - 100, exp: now - 10 }, SECRET),
        forgedScope: jwt.sign({ uid: A.id, scope: "admin", ep: 0 }, SECRET, { expiresIn: "1h" }),
        noEpoch: jwt.sign({ uid: A.id, scope: "appfn" }, SECRET, { expiresIn: "1h" }),
        futureEpoch: jwt.sign({ uid: A.id, scope: "appfn", ep: 7 }, SECRET, { expiresIn: "1h" }),
        wrongSecret: jwt.sign({ uid: A.id, scope: "appfn", ep: 0 }, "not-the-secret-not-the-secret-000", { expiresIn: "1h" }),
      };
      for (const [what, token] of Object.entries(bad)) {
        const r = await api("GET", "/appfunctions/shopping", { token });
        assert.strictEqual(r.status, 401, `${what}: ${r.status} ${r.text}`);
      }
      // A forged scope is not a session anywhere else either.
      assert.strictEqual((await api("GET", "/profile", { token: bad.forgedScope })).status, 401);
      assert.strictEqual((await api("GET", "/appfunctions/shopping")).status, 401, "no token at all");
    });

    await atest("DELETE bumps the epoch: every earlier key stops, a new one works", async () => {
      const second = await mintKey(A); // a second phone's key, same epoch
      ok(await api("GET", "/appfunctions/shopping", { token: second }));
      const r = await api("DELETE", "/appfunctions/token", { token: A.session });
      ok(r);
      assert.deepStrictEqual(r.json, { ok: true });
      assert.strictEqual(await epochOf(A.id), 1);
      for (const old of [A.key, second]) {
        const x = await api("GET", "/appfunctions/shopping", { token: old });
        assert.strictEqual(x.status, 401, x.text);
        assert.match(x.json.error, /turned off/);
      }
      A.key = await mintKey(A);
      assert.strictEqual(jwt.decode(A.key).ep, 1);
      ok(await api("GET", "/appfunctions/shopping", { token: A.key }));
      // The session that revoked is untouched.
      ok(await api("GET", "/shopping", { token: A.session }));
    });

    await atest("a deleted account's key and session fail as before", async () => {
      const D = await mkUser("d");
      D.key = await mintKey(D);
      ok(await api("GET", "/appfunctions/shopping", { token: D.key }));
      await privacy.deleteUserEverywhere(D.id, { reason: "appfunctions-test" });
      for (const token of [D.key, D.session]) {
        const r = await api("GET", "/appfunctions/shopping", { token });
        assert.strictEqual(r.status, 401, r.text);
        assert.strictEqual(r.json.error, "account not found");
      }
    });

    B.key = await mintKey(B);
    C.key = await mintKey(C);
    E.key = await mintKey(E);
    const fn = (method, p, user, body, tz) => api(method, `/appfunctions${p}`, { token: user.key, body, tz });

    /* ---------------------------- shopping --------------------------- */

    await atest("shopping/add adds, merges and reports the list's count", async () => {
      const r = await fn("POST", "/shopping/add", A, { items: [
        { name: "Milk", quantity: 2, unit: "l", details: "Amul" },
        { name: "Phone charger", details: "USB-C 25W", store: "Amazon", link: "https://evil.example/x", note: "ignored" },
      ] });
      ok(r);
      assert.deepStrictEqual(r.json.merged, []);
      const byName = Object.fromEntries(r.json.added.map((i) => [i.name, i]));
      assert.deepStrictEqual(Object.keys(byName).sort(), ["Milk", "Phone charger"]);
      assert.strictEqual(byName.Milk.category, "dairy_eggs");
      assert.match(byName.Milk.amountText, /2/);
      assert.strictEqual(byName["Phone charger"].category, "electronics_accessories");
      assert.deepStrictEqual(Object.keys(byName.Milk).sort(), ["amountText", "category", "name"]);
      assert.strictEqual(r.json.count, 2);

      const again = await fn("POST", "/shopping/add", A, { items: [{ name: "milk", quantity: 1, unit: "l" }] });
      ok(again);
      assert.deepStrictEqual(again.json.added, []);
      assert.strictEqual(again.json.merged.length, 1);
      assert.strictEqual(again.json.merged[0].name, "Milk");
      assert.match(again.json.merged[0].amountText, /3/);
      assert.strictEqual(again.json.count, 2);
      // Only the fields an agent may set were kept.
      const row = await db.one(`SELECT link, note, source FROM shopping_items WHERE user_id=$1 AND name='Phone charger'`, [A.id]);
      assert.ok(!row.link && !row.note, JSON.stringify(row));
    });

    await atest("shopping/add refuses bad input with 400 and a clear message", async () => {
      badInput(await fn("POST", "/shopping/add", A, {}), /items/);
      badInput(await fn("POST", "/shopping/add", A, { items: [] }), /items/);
      badInput(await fn("POST", "/shopping/add", A, { items: "milk" }), /items/);
      badInput(await fn("POST", "/shopping/add", A, { items: ["milk"] }), /object/);
      badInput(await fn("POST", "/shopping/add", A, { items: [{ quantity: 2 }] }), /name/);
      badInput(await fn("POST", "/shopping/add", A, { items: [{ name: "Rice", quantity: -1 }] }), /quantity/);
      badInput(await fn("POST", "/shopping/add", A, { items: [{ name: "x".repeat(81) }] }), /80/);
      badInput(await fn("POST", "/shopping/add", A,
        { items: Array.from({ length: 51 }, (_, i) => ({ name: `thing ${i}` })) }), /50/);
      const list = await fn("GET", "/shopping", A);
      assert.strictEqual(list.json.count, 2, "nothing was added by a refused call");
    });

    await atest("GET shopping: the unticked lines with details and store, a category filter, 400 for a bad one", async () => {
      const r = await fn("GET", "/shopping", A);
      ok(r);
      assert.strictEqual(r.json.count, 2);
      const byName = Object.fromEntries(r.json.items.map((i) => [i.name, i]));
      assert.deepStrictEqual(Object.keys(byName["Phone charger"]).sort(), ["amountText", "category", "details", "name", "store"]);
      assert.strictEqual(byName["Phone charger"].store, "Amazon");
      assert.strictEqual(byName["Phone charger"].details, "USB-C 25W");
      assert.strictEqual(byName.Milk.details, "Amul");
      const dairy = await fn("GET", "/shopping?category=dairy_eggs", A);
      ok(dairy);
      assert.deepStrictEqual(dairy.json.items.map((i) => i.name), ["Milk"]);
      assert.strictEqual(dairy.json.count, 1);
      badInput(await fn("GET", "/shopping?category=unicorns", A), /category must be one of/);
    });

    await atest("shopping/bought ticks, says what is not on the list and what is ambiguous", async () => {
      ok(await fn("POST", "/shopping/add", A, { items: [
        { name: "Kurti", details: "M, blue floral" }, { name: "Kurti", details: "L, red" },
      ] }));
      const r = await fn("POST", "/shopping/bought", A, { names: ["milk", "unicorn horn"] });
      ok(r);
      assert.deepStrictEqual(r.json, { checked: ["Milk"], notFound: ["unicorn horn"], ambiguous: [] });
      const list = await fn("GET", "/shopping", A);
      assert.ok(!list.json.items.some((i) => i.name === "Milk"), "a bought line is not listed");
      assert.strictEqual(list.json.count, 3);

      const which = await fn("POST", "/shopping/bought", A, { names: ["kurti"] });
      ok(which);
      assert.deepStrictEqual(which.json.checked, []);
      assert.deepStrictEqual(which.json.notFound, []);
      assert.strictEqual(which.json.ambiguous.length, 1);
      assert.strictEqual(which.json.ambiguous[0].name, "kurti");
      assert.strictEqual(which.json.ambiguous[0].candidates.length, 2);

      badInput(await fn("POST", "/shopping/bought", A, {}), /names/);
      badInput(await fn("POST", "/shopping/bought", A, { names: "milk" }), /names/);
      badInput(await fn("POST", "/shopping/bought", A, { names: [""] }), /names\[0\]/);
      badInput(await fn("POST", "/shopping/bought", A, { names: [42] }), /names\[0\]/);
    });

    /* ---------------------------- reminders -------------------------- */

    const remByText = async (uid, text) =>
      db.one(`SELECT * FROM reminders WHERE user_id=$1 AND text=$2 ORDER BY id DESC LIMIT 1`, [uid, text]);

    await atest("a reminder is set in the device's local time, answered in its offset, as a notification", async () => {
      const day = localDate(Date.now() + 86_400_000, 330);
      const r = await fn("POST", "/reminders", A, { text: "Call the plumber", dueDateTime: `${day}T09:00:00` }, 330);
      ok(r);
      assert.deepStrictEqual(Object.keys(r.json).sort(), ["dueAt", "dueText", "id", "text"]);
      assert.strictEqual(r.json.text, "Call the plumber");
      assert.strictEqual(r.json.dueAt, `${day}T09:00:00+05:30`);
      assert.strictEqual(r.json.dueText, "tomorrow at 9 am");
      const row = await remByText(A.id, "Call the plumber");
      assert.strictEqual(row.id, r.json.id);
      assert.strictEqual(Number(row.due_at), Date.parse(`${day}T09:00:00+05:30`));
      assert.strictEqual(row.deliver, "notify", "never a paid call from outside the app");
      assert.ok(!row.call_job_id, "no call queued");
    });

    await atest("the X-TZ-Offset header decides local time; an explicit offset is taken as written", async () => {
      const ny = -300;
      const day = localDate(Date.now() + 86_400_000, ny);
      const r = await fn("POST", "/reminders", A, { text: "Stand-up call", dueDateTime: `${day}T09:00` }, ny);
      ok(r);
      assert.strictEqual(r.json.dueAt, `${day}T09:00:00-05:00`);
      assert.strictEqual(r.json.dueText, "tomorrow at 9 am");
      assert.strictEqual(Number((await remByText(A.id, "Stand-up call")).due_at), Date.parse(`${day}T09:00:00-05:00`));

      const ist = localDate(Date.now() + 86_400_000, 330);
      const x = await fn("POST", "/reminders", A, { text: "Berlin call", dueDateTime: `${ist}T09:00:00+01:00` }, 330);
      ok(x);
      const due = Date.parse(`${ist}T09:00:00+01:00`);
      assert.strictEqual(Number((await remByText(A.id, "Berlin call")).due_at), due);
      assert.strictEqual(x.json.dueAt, `${localDate(due, 330)}T13:30:00+05:30`);
      assert.match(x.json.dueText, /at 1:30 pm$/);

      const note = await fn("POST", "/reminders", A, { text: "Renew the passport" }, 330);
      ok(note);
      assert.strictEqual(note.json.dueAt, null);
      assert.strictEqual(note.json.dueText, null);
    });

    await atest("without the header: the user's saved offset, else IST", async () => {
      await db.run(`UPDATE users SET tz_offset_min = -300 WHERE id = $1`, [C.id]);
      const day = localDate(Date.now() + 86_400_000, -300);
      const r = await fn("POST", "/reminders", C, { text: "Water the lawn", dueDateTime: `${day}T08:30:00` });
      ok(r);
      assert.strictEqual(r.json.dueAt, `${day}T08:30:00-05:00`);
      assert.strictEqual(r.json.dueText, "tomorrow at 8:30 am");
      assert.strictEqual(Number((await remByText(C.id, "Water the lawn")).due_at), Date.parse(`${day}T08:30:00-05:00`));

      const istDay = localDate(Date.now() + 86_400_000, 330);
      const e = await fn("POST", "/reminders", E, { text: "Temple visit", dueDateTime: `${istDay}T06:00:00` });
      ok(e);
      assert.strictEqual(e.json.dueAt, `${istDay}T06:00:00+05:30`);
    });

    await atest("reminders refuse bad input with 400", async () => {
      badInput(await fn("POST", "/reminders", A, {}), /text/);
      badInput(await fn("POST", "/reminders", A, { text: "   " }), /text/);
      badInput(await fn("POST", "/reminders", A, { text: "x".repeat(301) }), /300/);
      badInput(await fn("POST", "/reminders", A, { text: "Gym", dueDateTime: "tomorrow 9am" }), /ISO-8601/);
      badInput(await fn("POST", "/reminders", A, { text: "Gym", dueDateTime: "2031-09-30" }), /ISO-8601/);
      badInput(await fn("POST", "/reminders", A, { text: "Gym", dueDateTime: 1790000000000 }), /ISO-8601/);
      badInput(await fn("POST", "/reminders", A, { text: "Gym", dueDateTime: "2031-02-30T09:00:00" }), /real date/);
      badInput(await fn("POST", "/reminders", A, { text: "Gym", dueDateTime: "2031-01-01T25:00:00" }), /real date/);
      badInput(await fn("POST", "/reminders", A, { text: "Gym", dueDateTime: "2020-01-01T09:00:00" }), /past/);
      assert.ok(!(await remByText(A.id, "Gym")), "nothing was saved");
    });

    await atest("GET reminders: the next N days only, soonest first, with ids and spoken times", async () => {
      const far = localDate(Date.now() + 10 * 86_400_000, 330);
      const f = await fn("POST", "/reminders", A, { text: "Car service", dueDateTime: `${far}T10:00:00` }, 330);
      ok(f);
      const week = await fn("GET", "/reminders?days=7", A, undefined, 330);
      ok(week);
      const texts = week.json.reminders.map((r) => r.text);
      assert.ok(texts.includes("Call the plumber") && texts.includes("Stand-up call"), texts.join(", "));
      assert.ok(!texts.includes("Car service"), "ten days out is not in the next seven");
      assert.ok(!texts.includes("Renew the passport"), "an undated note is not upcoming");
      const plumber = week.json.reminders.find((r) => r.text === "Call the plumber");
      assert.deepStrictEqual(Object.keys(plumber).sort(), ["dueAt", "dueText", "id", "text"]);
      assert.strictEqual(plumber.dueText, "tomorrow at 9 am");
      assert.ok(Number.isInteger(plumber.id));
      const times = week.json.reminders.map((r) => Date.parse(r.dueAt));
      assert.deepStrictEqual(times, [...times].sort((a, b) => a - b), "soonest first");

      const byDefault = await fn("GET", "/reminders", A, undefined, 330);
      assert.deepStrictEqual(byDefault.json, week.json, "7 days by default");
      const fortnight = await fn("GET", "/reminders?days=14", A, undefined, 330);
      const car = fortnight.json.reminders.find((r) => r.text === "Car service");
      assert.ok(car, "fourteen days reaches it");
      assert.strictEqual(car.dueAt, `${far}T10:00:00+05:30`);
      assert.match(car.dueText, /^on \d{1,2} [A-Z][a-z]+( \d{4})? at 10 am$/);

      for (const q of ["0", "91", "abc", "1.5", "-3"]) badInput(await fn("GET", `/reminders?days=${q}`, A), /days/);
    });

    /* ---------------------------- momentum --------------------------- */

    await atest("today: adds a priority, says when it is already there, 409 today_full at three", async () => {
      const a = await fn("POST", "/today", A, { title: "Finish the report" }, TZMID);
      ok(a);
      assert.deepStrictEqual(a.json, { added: true, priorities: ["Finish the report"] });
      const again = await fn("POST", "/today", A, { title: "finish the report" }, TZMID);
      ok(again);
      assert.deepStrictEqual(again.json, { added: false, priorities: ["Finish the report"] });
      ok(await fn("POST", "/today", A, { title: "Call the bank" }, TZMID));
      const three = await fn("POST", "/today", A, { title: "go for a walk" }, TZMID);
      ok(three);
      assert.deepStrictEqual(three.json, { added: true, priorities: ["Finish the report", "Call the bank", "Go for a walk"] });
      const full = await fn("POST", "/today", A, { title: "Water the plants" }, TZMID);
      assert.strictEqual(full.status, 409, full.text);
      assert.deepStrictEqual(full.json, { error: "today_full", priorities: ["Finish the report", "Call the bank", "Go for a walk"] });

      badInput(await fn("POST", "/today", A, {}, TZMID), /title/);
      badInput(await fn("POST", "/today", A, { title: 5 }, TZMID), /title/);
      badInput(await fn("POST", "/today", A, { title: "x".repeat(121) }, TZMID), /120/);
    });

    await atest("habits/log ticks a habit with its streak; 404 with the habit names; 400 for no habit", async () => {
      await momentum.addHabit(A.id, { title: "Drink water", emoji: "💧", remindAt: "" });
      await momentum.addHabit(A.id, { title: "Read 10 pages", emoji: "📖", remindAt: "" });
      const r = await fn("POST", "/habits/log", A, { habit: "water" }, TZMID);
      ok(r);
      assert.deepStrictEqual(r.json, { habit: "Drink water", doneToday: true, streak: 1 });
      const nf = await fn("POST", "/habits/log", A, { habit: "guitar practice" }, TZMID);
      assert.strictEqual(nf.status, 404, nf.text);
      assert.strictEqual(nf.json.error, "habit_not_found");
      assert.deepStrictEqual([...nf.json.habits].sort(), ["Drink water", "Read 10 pages"]);
      const none = await fn("POST", "/habits/log", B, { habit: "water" }, TZMID);
      assert.strictEqual(none.status, 404, none.text);
      assert.deepStrictEqual(none.json, { error: "habit_not_found", habits: [] });
      badInput(await fn("POST", "/habits/log", A, {}, TZMID), /habit/);
      badInput(await fn("POST", "/habits/log", A, { habit: "x".repeat(81) }, TZMID), /80/);
    });

    await atest("my-day: priorities, today's reminders, habits due, the list's count and a short summary", async () => {
      const today = localDate(Date.now(), TZMID);
      ok(await fn("POST", "/reminders", A, { text: "Pay the electricity bill", dueDateTime: `${today}T15:00:00` }, TZMID));
      const shop = await fn("GET", "/shopping", A);
      const r = await fn("GET", "/my-day", A, undefined, TZMID);
      ok(r);
      const d = r.json;
      assert.deepStrictEqual(Object.keys(d).sort(),
        ["date", "habitsDue", "priorities", "reminders", "shoppingCount", "summary"]);
      assert.strictEqual(d.date, today);
      assert.deepStrictEqual(d.priorities, [
        { title: "Finish the report", done: false }, { title: "Call the bank", done: false },
        { title: "Go for a walk", done: false },
      ]);
      const bill = d.reminders.find((x) => x.text === "Pay the electricity bill");
      assert.ok(bill, JSON.stringify(d.reminders));
      assert.strictEqual(bill.dueAt, `${today}T15:00:00${offText(TZMID)}`);
      assert.strictEqual(bill.dueText, "today at 3 pm");
      assert.ok(d.reminders.every((x) => x.dueAt.startsWith(today)), "today's only");
      assert.deepStrictEqual(d.habitsDue, ["Read 10 pages"]);
      assert.strictEqual(d.shoppingCount, shop.json.count);
      assert.match(d.summary, /^Still to do today: finish the report, call the bank and go for a walk\. /);
      assert.match(d.summary, /reminders? today: .*pay the electricity bill at 3 pm/);
      assert.match(d.summary, new RegExp(`Habits still to tick: read 10 pages; ${shop.json.count} things on the shopping list\\.$`));
      const sentences = d.summary.split(/(?<=\.)\s+(?=[A-Z])/);
      assert.ok(sentences.length >= 2 && sentences.length <= 3, d.summary);
    });

    await atest("another user's data is never visible, and never touched", async () => {
      const list = await fn("GET", "/shopping", B);
      ok(list);
      assert.deepStrictEqual(list.json, { items: [], count: 0 });
      const bought = await fn("POST", "/shopping/bought", B, { names: ["Phone charger"] });
      ok(bought);
      assert.deepStrictEqual(bought.json, { checked: [], notFound: ["Phone charger"], ambiguous: [] });
      const mine = await fn("GET", "/shopping", A);
      assert.ok(mine.json.items.some((i) => i.name === "Phone charger"), "A's line is still unticked");
      const rem = await fn("GET", "/reminders?days=30", B, undefined, 330);
      assert.deepStrictEqual(rem.json, { reminders: [] });
      const day = await fn("GET", "/my-day", B, undefined, TZMID);
      ok(day);
      assert.deepStrictEqual(
        { priorities: day.json.priorities, reminders: day.json.reminders, habitsDue: day.json.habitsDue, shoppingCount: day.json.shoppingCount },
        { priorities: [], reminders: [], habitsDue: [], shoppingCount: 0 });
      assert.strictEqual(day.json.summary, "No priorities are set for today. No reminders today.");
      // A's key reads A's data only, whatever it asks for.
      const cDay = await fn("GET", "/reminders?days=30", C, undefined, -300);
      assert.deepStrictEqual(cDay.json.reminders.map((x) => x.text), ["Water the lawn"]);
    });

    await atest("a tool that needs the owner's yes answers 409 needs_confirmation, and nothing runs", async () => {
      const tool = registry.get("shopping_list_add");
      const was = tool.risk;
      tool.risk = "high";
      try {
        const r = await fn("POST", "/shopping/add", A, { items: [{ name: "Saffron" }] });
        assert.strictEqual(r.status, 409, r.text);
        assert.strictEqual(r.json.error, "needs_confirmation");
        assert.strictEqual(r.json.message, "Open My Assistant to confirm this.");
        assert.match(r.json.summary, /Saffron/);
      } finally {
        tool.risk = was;
      }
      const list = await fn("GET", "/shopping", A);
      assert.ok(!list.json.items.some((i) => /saffron/i.test(i.name)), "nothing was added");
    });

    await atest("the ledger and the audit trail record source appfunctions", async () => {
      const want = ["shopping_list_add", "shopping_list_show", "shopping_list_check", "create_reminder",
        "list_reminders", "plan_my_day", "check_habit", "momentum_status"];
      const rows = await waitFor(async () => {
        const got = await db.query(
          `SELECT tool, surface, intent, turn_id FROM executed_actions WHERE user_id = $1 AND surface = 'appfunctions'`,
          [A.id]);
        const tools = new Set(got.map((x) => x.tool));
        return want.every((t) => tools.has(t)) ? got : null;
      });
      assert.ok(rows, "every tool the routes ran is in the ledger with surface appfunctions");
      assert.ok(rows.every((x) => /^Phone assistant: /.test(x.intent)), "intent says who asked");
      assert.ok(rows.every((x) => /^appfn-[0-9a-f]{12}$/.test(x.turn_id)), "a turn id per call");
      const other = await db.query(
        `SELECT count(*)::int AS n FROM executed_actions WHERE user_id = $1 AND surface <> 'appfunctions'`, [A.id]);
      assert.strictEqual(other[0].n, 0, "nothing filed under another surface");

      const actions = new Set((await waitFor(async () => {
        const got = await db.query(`SELECT action FROM actions_log WHERE user_id = $1`, [A.id]);
        return got.some((x) => x.action === "tool.create_reminder") ? got : null;
      })).map((x) => x.action));
      for (const a of ["appfunctions.key.issued", "appfunctions.key.revoked", "appfunctions.shopping.added",
        "appfunctions.shopping.bought", "appfunctions.reminder.created", "appfunctions.today.added",
        "appfunctions.habit.logged", "tool.shopping_list_add", "tool.create_reminder"]) {
        assert.ok(actions.has(a), `audit trail has ${a}: ${[...actions].join(", ")}`);
      }
    });

    await atest("its own limiter: 60 a minute per user, then a JSON 429", async () => {
      const idx = require.resolve(path.join(BACKEND, "src/appfunctions"));
      delete require.cache[idx];
      delete process.env.APPFUNCTIONS_RATE_PER_MIN;
      const fresh = require(idx);
      assert.strictEqual(fresh.RATE_PER_MIN, 60);
      const mini = express();
      mini.use((req, _res, next) => { req.user = { sub: req.get("x-uid") }; next(); });
      mini.get("/x", fresh.limiter, (_req, res) => res.json({ ok: true }));
      const srv = mini.listen(0);
      const url = `http://127.0.0.1:${srv.address().port}/x`;
      try {
        const hit = (uid) => realFetch(url, { headers: { "x-uid": uid } });
        for (let i = 0; i < 60; i++) assert.strictEqual((await hit("1")).status, 200, `request ${i + 1}`);
        const over = await hit("1");
        assert.strictEqual(over.status, 429);
        assert.strictEqual((await over.json()).error, "too_many_requests");
        assert.strictEqual((await hit("2")).status, 200, "another user has their own bucket");
      } finally {
        srv.close();
      }
    });
  } finally {
    for (const id of made) {
      try { await privacy.deleteUserEverywhere(id, { reason: "appfunctions-test cleanup" }); }
      catch (e) { if (!/not found/i.test(e.message)) console.error("cleanup failed:", e.message); }
    }
    try { process.chdir(BACKEND); fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error("appfunctions-test crashed:", e);
  process.exit(1);
});
