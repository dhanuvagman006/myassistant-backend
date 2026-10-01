/**
 * WHAT A CALL LED TO — `npm run test:calloutcome`.
 *
 * The person called promises something or asks to be called back; the
 * user gets a reminder on that day and the report says so. Pins: the
 * JSON is read strictly, vague words set nothing, a self-call sets
 * nothing, and the finished call's report carries the reminder line.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
const assert = require("assert");
const db = require("../src/db");
const ai = require("../src/services/ai/router");
const O = require("../src/agents/callOutcome");

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); }
}

// Thursday 2026-10-01 10:00 IST
const NOW = Date.UTC(2026, 9, 1, 4, 30);
const IST = 330;

(async () => {
  await db.init();
  const u = await db.createUser({ email: `outcome-${Date.now()}@example.com`, name: "Outcome Test", provider: "email" });
  await db.run("UPDATE users SET tz_offset_min=$1 WHERE id=$2", [IST, u.id]);
  const realGen = ai.generateReply;
  let answer = "{}";
  ai.generateReply = async () => ({ reply: answer });
  const rec = (over = {}) => ({
    id: "c1", userId: u.id, contactName: "Suresh", task: "tell him the EMI is overdue",
    answer: "assistant: Hello, Sir?\nuser: Yes. I will pay by Friday.\nassistant: Thank you.", ...over,
  });
  const reminders = () => db.query("SELECT text, due_at FROM reminders WHERE user_id=$1 ORDER BY id", [u.id]);

  try {
    await check("the model's JSON is read strictly; fences are tolerated", () => {
      const p = O.parse('```json\n{"promise":"pay the EMI","when":"Friday","callback":"","needs_user":false,"line":"He will pay by Friday."}\n```');
      assert.deepStrictEqual(p, { promise: "pay the EMI", when: "Friday", callback: "", needsUser: false, line: "He will pay by Friday." });
      assert.strictEqual(O.parse("sorry, no"), null);
    });

    await check("their words for when become a moment in the user's zone, never in the past", () => {
      const fri = O.whenToMs("Friday", { tzOffsetMin: IST, now: NOW });
      assert.ok(fri > NOW, "Friday is ahead");
      assert.strictEqual(new Date(fri + IST * 60_000).getUTCDay(), 5);
      assert.strictEqual(O.whenToMs("", { tzOffsetMin: IST, now: NOW }), null);
      assert.strictEqual(O.whenToMs("some day maybe", { tzOffsetMin: IST, now: NOW }), null);
    });

    await check("a promise with a day sets a follow-up reminder and the report says so", async () => {
      answer = '{"promise":"pay the EMI","when":"Friday","callback":"","needs_user":false,"line":"He will pay by Friday."}';
      const out = await O.record(rec(), { now: NOW });
      assert.strictEqual(out.reminders.length, 1);
      assert.match(out.reminders[0].text, /^Follow up: Suresh promised to pay the EMI$/);
      assert.match(out.line, /reminder for (tomorrow|Friday)/); // Thursday now: Friday is tomorrow
      const rows = await reminders();
      assert.strictEqual(rows.length, 1);
      assert.match(rows[0].text, /Suresh promised/);
    });

    await check("a callback request sets a 'call back' reminder", async () => {
      answer = '{"promise":"","when":"","callback":"after 6 pm today","needs_user":false,"line":""}';
      const out = await O.record(rec({ id: "c2" }), { now: NOW });
      assert.strictEqual(out.reminders.length, 1);
      assert.match(out.reminders[0].text, /^Call Suresh back — they asked/);
      assert.match(out.line, /reminder for today/);
    });

    await check("vague words set nothing; a self-call and a call nobody answered set nothing", async () => {
      const before = (await reminders()).length;
      answer = '{"promise":"","when":"","callback":"","needs_user":false,"line":"He said he would see."}';
      assert.deepStrictEqual(await O.record(rec({ id: "c3" }), { now: NOW }), { line: "", reminders: [] });
      answer = '{"promise":"pay","when":"Friday","callback":"","needs_user":false,"line":""}';
      assert.deepStrictEqual(await O.record(rec({ id: "c4", selfCall: true }), { now: NOW }), { line: "", reminders: [] });
      assert.deepStrictEqual(await O.record(rec({ id: "c5", answer: "assistant: Hello?" }), { now: NOW }), { line: "", reminders: [] });
      assert.strictEqual((await reminders()).length, before);
    });

    await check("something only the user can answer is said, without a reminder", async () => {
      answer = '{"promise":"","when":"","callback":"","needs_user":true,"line":"He asked whether the rate can be reduced."}';
      const out = await O.record(rec({ id: "c6" }), { now: NOW });
      assert.deepStrictEqual(out, { line: "They need an answer from you.", reminders: [] });
    });

    await check("the finished call's report carries the reminder line", async () => {
      const agent = require("../src/agents/agentCall");
      const store = require("../src/outcomes/store");
      answer = '{"promise":"send the documents","when":"tomorrow","callback":"","needs_user":false,"line":""}';
      const r = { ...rec({ id: `fin-${u.id}` }), state: "in_progress", notes: [], retryPending: false, pushOutcome: false, attempt: 1, maxAttempts: 1 };
      const outcome = await store.create(u.id, { kind: "agent_call", target: "Suresh", detail: "x", status: "dialing", path: "relay", externalId: r.id });
      agent._calls.set(r.id, r);
      agent._finishCompleted(r, "");
      assert.strictEqual(r.state, "summarizing");
      for (let i = 0; i < 50 && r.state !== "completed"; i++) await new Promise((res) => setTimeout(res, 100));
      assert.strictEqual(r.state, "completed");
      assert.match(r.result, /I spoke with Suresh/);
      assert.match(r.result, /reminder for tomorrow/);
      const saved = await db.one("SELECT status, detail FROM task_outcomes WHERE id=$1", [outcome.id]);
      assert.strictEqual(saved.status, "completed");
      assert.match(saved.detail, /reminder for tomorrow/);
    });
  } finally {
    ai.generateReply = realGen;
    await db.run("DELETE FROM reminders WHERE user_id=$1", [u.id]).catch(() => {});
    await db.run("DELETE FROM task_outcomes WHERE user_id=$1", [u.id]).catch(() => {});
    await db.run("DELETE FROM users WHERE id=$1", [u.id]).catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
