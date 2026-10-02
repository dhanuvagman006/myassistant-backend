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
  // This tester said yes to "Help improve" (quiet filing needs it; the
  // switch itself is pinned by test:improve).
  await db.run(
    `INSERT INTO privacy_prefs (user_id, help_improve, on_since, updated_at) VALUES ($1, 1, 0, $2)
     ON CONFLICT (user_id) DO UPDATE SET help_improve = 1, on_since = 0`, [UID, Date.now()]);
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

  await atest("a request to change the app is filed with where they were, and answered in one line", async () => {
    const r = await tool.execute({
      kind: "improvement", summary: "Make the reminder text bigger", user_asked: true,
    }, { ...ctx, userText: "I want the reminder text bigger", platform: "android", lang: "kn" });
    assert.strictEqual(r.ok, true);
    assert.match(r.note, /with the developer/);
    const row = await db.one(`SELECT * FROM developer_feedback WHERE user_id=$1 AND summary=$2`, [UID, "Make the reminder text bigger"]);
    assert.match(row.details, /Said: "I want the reminder text bigger"/);
    assert.match(row.details, /build 99 · android · lang kn/);
    assert.strictEqual(row.user_asked, 1);
  });

  await atest("done with a build tells the person who asked, once, and shows in their own list", async () => {
    const store = require("../src/feedback/store");
    const push = require("../src/services/push");
    const pushes = [];
    const real = push.sendNotification;
    push.sendNotification = async (token, title, body, data) => { pushes.push({ token, title, body, data }); return true; };
    await db.run(`UPDATE users SET fcm_token='tok-fb' WHERE id=$1`, [UID]).catch(() => {});
    const u = await db.findById(UID).catch(() => null);
    try {
      const row = await db.one(`SELECT id FROM developer_feedback WHERE user_id=$1 AND summary=$2`, [UID, "Make the reminder text bigger"]);
      const inbox = require("../src/feedback/inbox");
      const listed = await inbox.cli(["list"], () => {});
      assert.match(listed, /Make the reminder text bigger/);
      const done = await inbox.cli(["done", String(row.id), "--build", "144", "--note", "Bigger in Reminders"], () => {});
      assert.match(done, /done: #/);
      const after = await db.one(`SELECT * FROM developer_feedback WHERE id=$1`, [row.id]);
      assert.strictEqual(after.status, "done");
      assert.strictEqual(after.resolved_build, 144);
      if (u?.fcm_token) {
        assert.strictEqual(pushes.length, 1);
        assert.match(pushes[0].title, /You asked: Make the reminder text bigger/);
        assert.match(pushes[0].body, /update 144/);
        assert.ok(after.notified_at > 0);
        // Telling them again would be noise.
        await store.notifyResolved(after);
        assert.strictEqual(pushes.length, 1);
      }
      const mine = await registry.get("check_my_requests").execute({}, ctx);
      const hit = mine.data.requests.find((q) => q.id === row.id);
      assert.ok(hit, "listed for the user");
      assert.match(hit.status, /done in update 144 — Bigger in Reminders/);
    } finally {
      push.sendNotification = real;
    }
  });

  await atest("a low calling balance and an image-quota 429 reach the inbox, once a day", async () => {
    const store = require("../src/feedback/store");
    const alerts = require("../src/ops/alerts");
    await db.run(`DELETE FROM developer_feedback WHERE user_id=0 AND source='ops' AND (summary ILIKE 'Calling balance%' OR summary ILIKE 'Pictures are off%')`);
    const saved = { key: process.env.BOLNA_API_KEY, floor: process.env.BOLNA_LOW_BALANCE_USD };
    process.env.BOLNA_API_KEY = "bn-test";
    process.env.BOLNA_LOW_BALANCE_USD = "10";
    const me = (wallet) => async () => ({ ok: true, json: async () => ({ wallet, concurrency: { max: 10, current: 0 } }) });
    try {
      const fine = await alerts.checkBolnaBalance({ fetchImpl: me(42.5) });
      assert.deepStrictEqual(fine, { wallet: 42.5, low: false });
      const low = await alerts.checkBolnaBalance({ fetchImpl: me(6.24) });
      assert.deepStrictEqual(low, { wallet: 6.24, low: true });
      await alerts.checkBolnaBalance({ fetchImpl: me(5.0) }); // same day: one row
      const rows = await store.list({ q: "Calling balance" });
      assert.strictEqual(rows.length, 1);
      assert.match(rows[0].details, /\$6\.24/);
      assert.strictEqual(rows[0].user_id, 0);
      await alerts.imageQuota("gpt-image-1: 429");
      await alerts.imageQuota("gpt-image-1: 429");
      const q = await store.list({ q: "Pictures are off" });
      assert.strictEqual(q.length, 1);
      // The sweep reads the balance at most every six hours.
      alerts._reset();
      const realFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = async () => { calls++; return me(6.24)(); };
      try {
        const t0 = Date.now();
        await alerts.sweep({ now: t0 });
        await alerts.sweep({ now: t0 + 3600_000 });
        assert.strictEqual(calls, 1);
      } finally {
        globalThis.fetch = realFetch;
      }
    } finally {
      if (saved.key === undefined) delete process.env.BOLNA_API_KEY; else process.env.BOLNA_API_KEY = saved.key;
      if (saved.floor === undefined) delete process.env.BOLNA_LOW_BALANCE_USD; else process.env.BOLNA_LOW_BALANCE_USD = saved.floor;
    }
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

  await atest("a server alert is listed from nobody, once an hour, never capped", async () => {
    const store = require("../src/feedback/store");
    const summary = `Test ops alert ${Date.now()}`;
    try {
      const a = await store.alert(summary, { details: "why it matters" });
      assert.strictEqual(a.ok, true);
      assert.strictEqual(a.duplicate, false);
      // The same thing noticed again within the hour is the same row.
      const b = await store.alert(summary);
      assert.strictEqual(b.duplicate, true);
      assert.strictEqual(b.id, a.id);
      // An hour on, it is a new row — an outage that lasts all day shows.
      await db.run(`UPDATE developer_feedback SET created_at = created_at - $1 WHERE id=$2`,
        [store.ALERT_WINDOW + 1000, a.id]);
      const c = await store.alert(summary);
      assert.strictEqual(c.duplicate, false);

      const login = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: process.env.ADMIN_KEY }),
      });
      const cookie = login.headers.get("set-cookie").split(";")[0];
      const d = await fetch(`${base}/feedback?status=new&q=${encodeURIComponent(summary)}`,
        { headers: { cookie } }).then((r) => r.json());
      assert.strictEqual(d.feedback.length, 2);
      for (const f of d.feedback) {
        assert.strictEqual(f.kind, "alert");
        assert.strictEqual(f.source, "ops");
        assert.strictEqual(Number(f.user_id), 0);
      }
      assert.match(src("routes/admin_panel/app.js"), /alert: \["Alert", "danger"\]/);
    } finally {
      await db.run(`DELETE FROM developer_feedback WHERE user_id=0 AND summary=$1`, [summary]);
    }
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
    assert.match(src("ai/voicePrompt.js"), /require\("\.\.\/agents\/owner"\)\.OWNER_RULE/);
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
    assert.match(rule, /NEVER say it — not "Ravi", not "Ravi ji"/, "the name is known, never said");
  });

  await atest("both voices are told how to address the owner", async () => {
    const email = `owner-test-${Date.now()}@example.test`;
    const u = await db.createUser({ email, name: "Dhanush K", gender: "male" });
    try {
      const block = await require("../src/users/context").contextBlock(u.id);
      assert.match(block, /HOW TO ADDRESS THEM — as "Sir"/);
      assert.match(block, /You KNOW their name \(Dhanush\) but NEVER say it/);
    } finally {
      await db.run(`DELETE FROM users WHERE id=$1`, [u.id]);
    }
  });

  // 2026-09-25: a reminder call to the client opened "Hello, hariraj?".
  await atest("a call to the owner themself says Sir or Ma'am, and never carries the name", async () => {
    const { _addressFor } = require("../src/agents/agentCall");
    const stamp = Date.now();
    const him = await db.createUser({ email: `self-m-${stamp}@example.test`, name: "Hariraj Shetty", gender: "male" });
    const her = await db.createUser({ email: `self-f-${stamp}@example.test`, name: "Asha Rao", gender: "female" });
    try {
      const m = await _addressFor({ selfCall: true, userId: him.id, contactName: "Hariraj", userName: "Hariraj" });
      assert.deepStrictEqual(m, { honorific: "Sir", contact_name: "Sir", user_name: "Sir" });
      const f = await _addressFor({ selfCall: true, userId: her.id, contactName: "Asha", userName: "Asha" });
      assert.deepStrictEqual(f, { honorific: "Ma'am", contact_name: "Ma'am", user_name: "Ma'am" });
      // No profile to read: still a title, never an empty "Hello, ?".
      const none = await _addressFor({ selfCall: true, contactName: "Hariraj" });
      assert.strictEqual(none.honorific, "Sir");
      assert.doesNotMatch(JSON.stringify([m, f, none]), /Hariraj|Asha/);
      // A call to someone else still says whose assistant is calling.
      const other = await _addressFor({ selfCall: false, contactName: "Dr Ravi Kumar", userName: "Hariraj" });
      assert.strictEqual(other.contact_name, "Ravi");
      assert.strictEqual(other.user_name, "Hariraj");
      assert.ok(["sir", "ma'am"].includes(other.honorific));
    } finally {
      await db.run(`DELETE FROM users WHERE id = ANY($1)`, [[him.id, her.id]]);
    }
  });

  server.close();
  await db.run(`DELETE FROM developer_feedback WHERE user_id=$1`, [UID]);
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})();
