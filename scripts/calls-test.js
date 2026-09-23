/**
 * CALL NOTES COST GUARDS — `npm run test:calls`.
 *
 * Every call analysis is paid for on Gemini. These pin the guards that
 * keep one recording to one analysis: a reinstall re-sending old files,
 * two scans racing on the phone, a toggle switched off while calls wait
 * in the queue, and a restart that orphans half-finished rows. The model
 * is stubbed — a test that paid for tokens would be the bug it guards.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const assert = require("assert");
const express = require("express");
const db = require("../src/db");
const ai = require("../src/services/ai/router");

let passed = 0;
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
}

const UID = 990031;
const AUDIO = Buffer.alloc(40 * 1024, 7); // over the 32 KB "misdial" floor

// Count what would have been paid for, and let a test hold the queue.
let paid = 0;
let gate = null;
ai.transcribeAudio = async () => { paid++; if (gate) await gate; return { text: "hello there" }; };
ai.generateReply = async () => { paid++; return { reply: '{"summary":"ok","facts":[],"items":[]}' }; };

const settle = () => new Promise((r) => setTimeout(r, 150));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await settle(); }
  throw new Error("timed out waiting");
}

(async () => {
  await db.init();
  await db.run(`DELETE FROM call_records WHERE user_id=$1`, [UID]);
  const setToggle = (enabled) => db.run(
    `INSERT INTO kv (k, v) VALUES ($1, $2)
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [`call_analysis:${UID}`, JSON.stringify({ enabled, consentAt: 1 })]);
  await setToggle(true);

  const calls = require("../src/routes/calls");
  const app = express();
  app.use((req, _res, next) => { req.user = { sub: String(UID) }; next(); });
  app.use("/calls", calls.router);
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/calls`;
  const upload = (startedAtMs, peerName = "Amma") => {
    const fd = new FormData();
    fd.append("peerName", peerName);
    fd.append("peerNumber", "");
    fd.append("startedAtMs", String(startedAtMs));
    fd.append("audio", new Blob([AUDIO]), "Call Amma_260923_101010.m4a");
    return fetch(`${base}/upload`, { method: "POST", body: fd });
  };
  const rows = () => db.query(
    `SELECT id, status, started_at FROM call_records WHERE user_id=$1 ORDER BY id`, [UID]);

  console.log("\none recording, one analysis");

  const t1 = Date.now() - 5 * 60_000;
  await atest("a recent call is accepted and analysed", async () => {
    const r = await upload(t1);
    assert.strictEqual(r.status, 202);
    await waitFor(async () => (await rows())[0]?.status === "done");
    assert.strictEqual(paid, 2, "one transcription + one understanding");
  });

  await atest("the same recording sent again is not paid for twice", async () => {
    paid = 0;
    const r = await upload(t1);
    assert.strictEqual(r.status, 200, "under 500 so the app marks it handled");
    assert.strictEqual((await r.json()).skipped, "duplicate");
    await settle();
    assert.strictEqual(paid, 0);
    assert.strictEqual((await rows()).length, 1);
  });

  await atest("two scans racing on the phone make one row, not two", async () => {
    paid = 0;
    const t2 = Date.now() - 4 * 60_000;
    const [a, b] = await Promise.all([upload(t2, "Manish"), upload(t2, "Manish")]);
    assert.deepStrictEqual([a.status, b.status].sort(), [200, 202]);
    await waitFor(async () => (await rows()).filter((x) => x.started_at == t2)
      .every((x) => x.status === "done"));
    assert.strictEqual((await rows()).filter((x) => x.started_at == t2).length, 1);
    assert.strictEqual(paid, 2);
  });

  await atest("a recording over a day old is skipped, not analysed", async () => {
    paid = 0;
    const before = (await rows()).length;
    const r = await upload(Date.now() - 3 * 86400_000, "Old call");
    assert.strictEqual(r.status, 200);
    assert.match((await r.json()).skipped, /older than a day/);
    await settle();
    assert.strictEqual(paid, 0);
    assert.strictEqual((await rows()).length, before);
  });

  console.log("\nswitching it off stops the spending");

  await atest("calls still queued when the toggle goes off are never sent to the model", async () => {
    // Hold the two workers, queue a third, switch off, then let go.
    let release;
    gate = new Promise((r) => { release = r; });
    const now = Date.now();
    for (const [i, who] of ["A", "B", "C"].entries()) {
      assert.strictEqual((await upload(now - 60_000 - i * 1000, who)).status, 202);
    }
    await settle();
    await setToggle(false);
    paid = 0;
    gate = null;
    release();
    await waitFor(async () => (await rows()).every((x) => x.status !== "processing"));
    const queued = (await rows()).find((x) => x.started_at == now - 62_000);
    assert.strictEqual(queued.status, "skipped");
    // The two already running finish their understanding pass (1 each);
    // the queued one costs nothing.
    assert.strictEqual(paid, 2);
    await setToggle(true);
  });

  console.log("\nafter a restart");

  await atest("orphaned rows are marked interrupted and repeats are hidden", async () => {
    const t = Date.now() - 10 * 60_000;
    const ins = (status) => db.one(
      `INSERT INTO call_records (user_id, peer_name, started_at, status)
       VALUES ($1, 'Twice', $2, $3) RETURNING id`, [UID, t, status]);
    const failed = await ins("failed");
    const done = await ins("done");
    const orphan = await db.one(
      `INSERT INTO call_records (user_id, peer_name, started_at, status)
       VALUES ($1, 'Orphan', $2, 'processing') RETURNING id`, [UID, t - 1000]);
    await calls.recoverInterrupted();
    const by = Object.fromEntries((await db.query(
      `SELECT id, status, summary FROM call_records WHERE id = ANY($1::int[])`,
      [[failed.id, done.id, orphan.id]])).map((r) => [r.id, r]));
    assert.strictEqual(by[done.id].status, "done", "the analysed copy is kept");
    assert.strictEqual(by[failed.id].status, "duplicate");
    assert.strictEqual(by[orphan.id].status, "failed");
    assert.match(by[orphan.id].summary, /interrupted/);

    const list = await (await fetch(`${base}/recent`)).json();
    assert.ok(!list.calls.some((c) => c.id === failed.id), "duplicates stay out of the list");
    assert.ok(list.calls.some((c) => c.id === done.id));
  });

  server.close();
  await db.run(`DELETE FROM call_records WHERE user_id=$1`, [UID]);
  await db.run(`DELETE FROM kv WHERE k=$1`, [`call_analysis:${UID}`]);
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})();
