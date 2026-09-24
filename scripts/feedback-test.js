/**
 * DEVELOPER FEEDBACK + OWNER RULE — `npm run test:feedback`.
 *
 * The assistant can tell the developer what to improve (it lands in the
 * admin panel's Feedback page), and every prompt it speaks through carries
 * the same rule: the user is its owner and comes first. These pin both.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key-0123456789";

const assert = require("assert");
const fs = require("fs");
const express = require("express");
const db = require("../src/db");

let passed = 0;
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
}

const UID = 990041;
const src = (f) => fs.readFileSync(__dirname + "/../src/" + f, "utf8");

(async () => {
  await db.init();
  await db.run(`DELETE FROM developer_feedback WHERE user_id=$1`, [UID]);
  const registry = require("../src/tools/registry");
  require("../src/tools/builtins").registerBuiltins();
  const tool = registry.get("send_developer_feedback");
  const ctx = { userId: UID, source: "live", appBuild: 99 };

  console.log("\nthe assistant can reach the developer");

  await atest("the tool files a report the admin panel can read", async () => {
    const r = await tool.execute({
      kind: "bug",
      summary: "'Open Swiggy' opened the website instead of the app",
      details: "Swiggy is not installed; expected the Play Store.",
      user_words: "it should open the app",
    }, ctx);
    assert.strictEqual(r.ok, true);
    const row = await db.one(
      `SELECT * FROM developer_feedback WHERE user_id=$1`, [UID]);
    assert.strictEqual(row.kind, "bug");
    assert.strictEqual(row.status, "new");
    assert.strictEqual(row.source, "live");
    assert.strictEqual(row.app_build, 99);
  });

  await atest("the same report twice in a day is one row", async () => {
    const r = await tool.execute(
      { summary: "'OPEN SWIGGY' opened the website instead of the app" }, ctx);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.duplicate, true);
    const n = await db.one(
      `SELECT count(*)::int AS n FROM developer_feedback WHERE user_id=$1`, [UID]);
    assert.strictEqual(n.n, 1);
  });

  await atest("a model in a loop cannot bury the real reports", async () => {
    const store = require("../src/feedback/store");
    for (let i = 0; i < store.DAILY_CAP + 5; i++) {
      await store.add(UID, { summary: `loop ${i}` });
    }
    const n = await db.one(
      `SELECT count(*)::int AS n FROM developer_feedback WHERE user_id=$1`, [UID]);
    assert.strictEqual(n.n, store.DAILY_CAP);
  });

  await atest("an unknown kind is filed as an improvement, never refused", async () => {
    await db.run(`DELETE FROM developer_feedback WHERE user_id=$1`, [UID]);
    await tool.execute({ kind: "rant", summary: "Replies are too long" }, ctx);
    const row = await db.one(
      `SELECT kind FROM developer_feedback WHERE user_id=$1`, [UID]);
    assert.strictEqual(row.kind, "improvement");
  });

  await atest("it is always offered, and 'I've passed it on' counts as done", () => {
    assert.ok(/"send_developer_feedback"/.test(src("tools/relevance.js")),
      "disappointment rarely names the tool — it must be in CORE");
    const cc = require("../src/agents/claimCheck");
    const v = cc.check("I've passed that on to the developer.",
      [{ tool: "send_developer_feedback", ok: true }]);
    assert.strictEqual(v.ok, true, "a backed claim must not be rewritten");
    assert.strictEqual(cc.check("I've passed that on to the developer.", []).ok,
      false, "and an unbacked one still is");
  });

  await atest("deleting an account deletes its feedback", () => {
    assert.match(src("routes/privacy.js"), /\["developer_feedback", "user_id"\]/);
  });

  console.log("\nthe admin panel");

  const app = express();
  app.use("/admin-panel", require("../src/routes/admin_web"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/admin-panel/api`;

  await atest("feedback is behind the admin login", async () => {
    const r = await fetch(`${base}/feedback`);
    assert.strictEqual(r.status, 401);
  });

  await atest("lists new feedback with who sent it, and can be marked done", async () => {
    const login = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: process.env.ADMIN_KEY }),
    });
    assert.strictEqual(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const get = (q) => fetch(`${base}/feedback${q}`, { headers: { cookie } }).then((r) => r.json());

    const d = await get("?status=new");
    const mine = d.feedback.find((f) => f.user_id === UID);
    assert.ok(mine, "the report is listed");
    assert.strictEqual(mine.summary, "Replies are too long");
    assert.ok(d.counts.new >= 1);

    const set = await fetch(`${base}/feedback/${mine.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ status: "done" }),
    });
    assert.strictEqual(set.status, 200);
    const after = await get("?status=new");
    assert.ok(!after.feedback.some((f) => f.id === mine.id), "done leaves New");

    const bad = await fetch(`${base}/feedback/${mine.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ status: "deleted" }),
    });
    assert.strictEqual(bad.status, 400);
  });

  await atest("the panel has a Feedback page", () => {
    const js = src("routes/admin_panel/app.js");
    assert.match(js, /\["#\/feedback", "Feedback"\]/);
    assert.match(js, /viewFeedback\(\)/);
  });

  console.log("\nthe owner comes first");

  await atest("every voice carries the same owner rule", () => {
    const owner = require("../src/agents/owner");
    assert.match(owner.RESPECT, /OWNER/);
    assert.match(owner.FEEDBACK, /send_developer_feedback/);
    assert.match(src("agents/runtime.js"), /require\("\.\/owner"\)\.OWNER_RULE/);
    assert.match(src("live/proxy.js"), /require\("\.\.\/agents\/owner"\)\.OWNER_RULE/);
    // The plain fallback may have no tools: respect, but no feedback order.
    const router = src("services/ai/router.js");
    assert.match(router, /require\("\.\.\/\.\.\/agents\/owner"\)\.RESPECT/);
    assert.doesNotMatch(router, /owner"\)\.(OWNER_RULE|FEEDBACK)/);
  });

  await atest("courtesy stays short — it must not undo the no-lecture rules", () => {
    const { RESPECT } = require("../src/agents/owner");
    assert.match(RESPECT, /Courtesy is brief/);
    assert.doesNotMatch(RESPECT, /understand your frustration/i);
  });

  await atest("Ma'am when the profile says female, Sir otherwise — never '<name> ji'", () => {
    const { honorific, addressRule } = require("../src/agents/owner");
    assert.strictEqual(honorific({ name: "Dhanush K", gender: "male" }), "Sir");
    assert.strictEqual(honorific({ name: "Asha", gender: "female" }), "Ma'am");
    assert.strictEqual(honorific({ name: "Ravi Kumar", gender: null }), "Sir");
    assert.strictEqual(honorific({ name: "Ravi", gender: "other" }), "Sir");
    assert.strictEqual(honorific({}), "Sir");
    const rule = addressRule({ name: "Ravi Kumar" });
    assert.match(rule, /as "Sir"/);
    assert.ok(!/Ravi ji/.test(rule), "never '<name> ji'");
  });

  await atest("both voices are told how to address the owner", async () => {
    const email = `owner-test-${Date.now()}@example.test`;
    const u = await db.createUser({ email, name: "Dhanush K", gender: "male" });
    try {
      const block = await require("../src/users/context").contextBlock(u.id);
      assert.match(block, /HOW TO ADDRESS THEM — as "Sir"/);
      assert.match(block, /Never by their bare first name \("Dhanush"\)/);
    } finally {
      await db.run(`DELETE FROM users WHERE id=$1`, [u.id]);
    }
  });

  server.close();
  await db.run(`DELETE FROM developer_feedback WHERE user_id=$1`, [UID]);
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})();
