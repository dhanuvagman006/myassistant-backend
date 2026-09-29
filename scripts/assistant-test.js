/**
 * THE ASSISTANT'S BACKGROUND AGENT — `npm run test:assistant`.
 *
 * The server's own agent (agents/runtime.js) still runs every turn nobody
 * is holding the phone for: scheduled tasks, the home-screen widget, deep
 * research, reminder calls and nudges. These drive it with the model
 * stubbed — no model, no keys.
 *
 * (Until 2026-09-29 this suite also drove the /assistant voice loop over
 * HTTP: the session's clock and place, and its legacy fallback chain. That
 * loop is gone — the app runs its own models — and the clock-and-place
 * checks moved to scripts/ai-toolserver-test.js.)
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

const assert = require("assert");
const express = require("express");

let passed = 0;
async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

/**
 * Swaps runAgentTurn for a stub that records the ctx it was given.
 * `impl(text, ctx, onEvent)` may replace the default behaviour.
 */
function stubRuntime(reply = "Done.", impl = null) {
  const runtime = require("../src/agents/runtime");
  const real = runtime.runAgentTurn;
  const calls = [];
  runtime.runAgentTurn = async (text, ctx, onEvent = () => {}) => {
    calls.push({ text, ctx });
    if (impl) return impl(text, ctx, onEvent);
    return { text: reply, toolResults: [], deviceActions: [] };
  };
  return { calls, restore: () => { runtime.runAgentTurn = real; } };
}

(async () => {
  console.log("\nwhere and when the user is");


  await atest("the offset helper keeps 0 and rejects nonsense", () => {
    const { offsetOr } = require("../src/services/tz");
    assert.strictEqual(offsetOr("0"), 0);
    assert.strictEqual(offsetOr(-300), -300);
    assert.strictEqual(offsetOr(undefined), 330);
    assert.strictEqual(offsetOr(""), 330);
    assert.strictEqual(offsetOr("abc"), 330);
    assert.strictEqual(offsetOr(99999), 330, "an impossible offset was accepted");
  });


  /** A fresh runtime bound to stubbed model calls (it binds them at load). */
  function runtimeWith(streamImpl, fullImpl) {
    const router = require("../src/services/ai/router");
    const saved = { s: router.generateWithToolsStream, f: router.generateWithTools };
    router.generateWithToolsStream = streamImpl;
    router.generateWithTools = fullImpl;
    delete require.cache[require.resolve("../src/agents/runtime")];
    const rt = require("../src/agents/runtime");
    return {
      rt,
      restore() {
        router.generateWithToolsStream = saved.s;
        router.generateWithTools = saved.f;
        delete require.cache[require.resolve("../src/agents/runtime")];
      },
    };
  }
  async function spokenFor(streamImpl, fullImpl) {
    const { rt, restore } = runtimeWith(streamImpl, fullImpl);
    const said = [];
    try {
      const out = await rt.runAgentTurn("tell me about Paris", { userId: null },
        (ev, p) => { if (ev === "sentence") said.push(p.text); });
      return { said, out };
    } finally {
      restore();
    }
  }
  const dropsAfterOneSentence = async ({ onDelta }) => {
    onDelta("Paris is the capital of France. ");
    onDelta("It has about");
    throw new Error("stream reset by peer");
  };

  await atest("the fallback continues from what was heard", async () => {
    const { said, out } = await spokenFor(dropsAfterOneSentence, async () => ({
      functionCalls: [],
      text: "Paris is the capital of France. It has about two million people.",
    }));
    assert.deepStrictEqual(said,
      ["Paris is the capital of France.", "It has about two million people."],
      `heard: ${JSON.stringify(said)}`);
    assert.match(out.text, /two million/);
  });

  await atest("a reworded fallback is not spoken on top of what was heard", async () => {
    const { said } = await spokenFor(dropsAfterOneSentence, async () => ({
      functionCalls: [],
      text: "The capital of France is Paris, home to about two million people.",
    }));
    assert.deepStrictEqual(said, ["Paris is the capital of France."],
      `the same answer was said twice: ${JSON.stringify(said)}`);
  });

  await atest("a stream that fails before speaking gets the whole fallback", async () => {
    const { said } = await spokenFor(async () => { throw new Error("429"); }, async () => ({
      functionCalls: [], text: "Paris is the capital of France.",
    }));
    assert.deepStrictEqual(said, ["Paris is the capital of France."]);
  });

  console.log("\nreminders that call keep calling — once");

  const db = require("../src/db");
  await db.init();
  const store = require("../src/reminders/store");
  const agent = require("../src/agents/agentCall");
  const realAgent = { enabled: agent.enabled, start: agent.start };
  const placed = [];
  agent.enabled = () => true;
  agent.start = async (a) => { placed.push(a); return { id: "stub" }; };
  const DAY = 24 * 3600_000;
  const pendingCalls = (reminderId) => db.query(
    `SELECT id, run_after FROM jobs WHERE kind='reminder_call' AND status='pending'
       AND (payload->>'reminderId')::int = $1`, [reminderId]);

  try {
    const u = await db.createUser({ email: `rem-${Date.now()}@example.com`, name: "Rema Test", provider: "email" });

    await atest("a daily reminder's call queues tomorrow's call itself", async () => {
      const r = await store.create(u.id, "take the tablets", Date.now() + 60_000, "gentle",
        { repeat: "daily", deliver: "call" });
      assert.ok(r.call_job_id, "precondition: the first call was queued");
      // The time comes: the row is due now, and its job runs.
      const due = Date.now() - 1000;
      await db.run("UPDATE reminders SET due_at=$1 WHERE id=$2", [due, r.id]);
      const before = placed.length;
      await require("../src/infra/handlers").reminderCall(
        { reminderId: r.id, text: r.text }, { user_id: u.id });
      assert.strictEqual(placed.length, before + 1, "the call was not placed");
      const row = await db.one("SELECT due_at, call_job_id FROM reminders WHERE id=$1", [r.id]);
      assert.ok(Number(row.due_at) > Date.now() + DAY / 2, "the series did not move to tomorrow");
      const jobs = await pendingCalls(r.id);
      assert.strictEqual(jobs.length, 1, "tomorrow's call was not queued (only the app opening did that)");
      assert.strictEqual(Number(jobs[0].id), Number(row.call_job_id));
    });

    await atest("two roll-forwards at once queue ONE call, not two", async () => {
      const r = await store.create(u.id, "stand-up call", Date.now() + 60_000, "gentle",
        { repeat: "daily", deliver: "call" });
      await store.cancelCall(r.call_job_id);
      await db.run("UPDATE reminders SET due_at=$1 WHERE id=$2", [Date.now() - 1000, r.id]);
      // The app's list refresh and the call job, racing.
      await Promise.all([store.rollForward(u.id), store.rollForward(u.id), store.rollForward(u.id)]);
      const jobs = await pendingCalls(r.id);
      assert.strictEqual(jobs.length, 1, `${jobs.length} calls queued for one occurrence`);
    });

    await atest("two un-ticks at once re-arm ONE call, not two", async () => {
      // The app commits each toggle as its snackbar closes, without
      // waiting for the last one, so "Moved back to your list" can land
      // twice together.
      const r = await store.create(u.id, "call the bank", Date.now() + 2 * 3600_000, "gentle",
        { deliver: "call" });
      assert.ok(r.call_job_id, "precondition: the call was queued");
      await store.setDone(u.id, r.id, true);
      assert.strictEqual((await pendingCalls(r.id)).length, 0, "precondition: done cancels the call");
      await Promise.all([store.setDone(u.id, r.id, false), store.setDone(u.id, r.id, false)]);
      const jobs = await pendingCalls(r.id);
      assert.strictEqual(jobs.length, 1, `${jobs.length} calls queued for one reminder`);
      const row = await db.one("SELECT done, call_job_id FROM reminders WHERE id=$1", [r.id]);
      assert.strictEqual(Number(row.done), 0);
      assert.strictEqual(Number(jobs[0].id), Number(row.call_job_id));
    });
  } finally {
    agent.enabled = realAgent.enabled;
    agent.start = realAgent.start;
  }

  console.log("\ncommitment nudges: helpful, bounded, in the user's own night");

  const push = require("../src/services/push");
  const scheduler = require("../src/proactive/scheduler");
  const realSend = push.sendNotification;
  const sentTo = [];
  let failTokens = new Set();
  push.sendNotification = async (token, title, body) => {
    if (failTokens.has(token)) throw new Error("registration-token-not-registered");
    sentTo.push({ token, title, body });
  };
  /** An offset (minutes) at which it is currently `hour` o'clock. */
  const offsetForLocalHour = (hour) => {
    let d = (hour - new Date().getUTCHours() + 24) % 24;
    if (d > 14) d -= 24;
    return d * 60;
  };
  const mkUser = async (tag, tzMin) => {
    const u = await db.createUser({ email: `${tag}-${Date.now()}${Math.random()}@example.com`, name: tag, provider: "email" });
    await db.run("UPDATE users SET fcm_token=$1, tz_offset_min=$2 WHERE id=$3", [`tok-${u.id}`, tzMin, u.id]);
    return u;
  };
  const mkPromise = async (userId, dueAt, extra = {}) => (await db.one(
    `INSERT INTO commitments (user_id, text, owed_to, due_at, status, nudged_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'open',$5,$6,$6) RETURNING id`,
    [userId, extra.text || "send Ravi the proposal", "Ravi", dueAt, extra.nudgedAt ?? null, Date.now()])).id;
  const nudgesFor = (u) => sentTo.filter((s) => s.token === `tok-${u.id}`).length;

  try {
    await atest("an overdue promise is nudged a bounded number of times, not forever", async () => {
      const u = await mkUser("overdue", offsetForLocalHour(12));
      const id = await mkPromise(u.id, Date.now() - 3 * 24 * 3600_000);
      for (let day = 0; day < 6; day++) {
        await scheduler.sweepCommitments();
        // a day passes
        await db.run("UPDATE commitments SET nudged_at = nudged_at - $2 WHERE id=$1 AND nudged_at IS NOT NULL",
          [id, 25 * 3600_000]);
      }
      assert.strictEqual(nudgesFor(u), 3, `nudged ${nudgesFor(u)} times over six days`);
    });

    await atest("a pile of undeliverable old promises cannot starve one coming due", async () => {
      const dead = await mkUser("deadtoken", offsetForLocalHour(12));
      failTokens.add(`tok-${dead.id}`);
      for (let i = 0; i < 55; i++) {
        await mkPromise(dead.id, Date.now() - (60 + i) * 24 * 3600_000, { text: `old ${i}` });
      }
      const fresh = await mkUser("fresh", offsetForLocalHour(12));
      await mkPromise(fresh.id, Date.now() + 3600_000, { text: "call the auditor" });
      await scheduler.sweepCommitments(); // first sweep: tries the 50 oldest, all fail
      await scheduler.sweepCommitments();
      assert.strictEqual(nudgesFor(fresh), 1, "the promise coming due was never reached");
    });

    await atest("quiet hours are the user's night, not India's", async () => {
      const night = await mkUser("night", offsetForLocalHour(23));
      const noon = await mkUser("noon", offsetForLocalHour(12));
      await mkPromise(night.id, Date.now() + 3600_000);
      await mkPromise(noon.id, Date.now() + 3600_000);
      await scheduler.sweepCommitments();
      assert.strictEqual(nudgesFor(night), 0, "a user was woken at 11 pm their time");
      assert.strictEqual(nudgesFor(noon), 1, "a user at noon was not nudged");
    });

    await atest("the phone's reported timezone is stored for background work", async () => {
      const u = await db.createUser({ email: `tzrep-${Date.now()}@example.com`, name: "Tz", provider: "email" });
      const jwt = require("jsonwebtoken");
      const token = jwt.sign({ uid: u.id }, process.env.JWT_SECRET || "security-test-secret-security-test-secret-01");
      process.env.JWT_SECRET = process.env.JWT_SECRET || "security-test-secret-security-test-secret-01";
      const { appAuth } = require("../src/middleware/auth");
      const app = express();
      app.get("/p", appAuth, (_q, r) => r.json({ ok: true }));
      const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/p`, {
          headers: { authorization: `Bearer ${token}`, "X-TZ-Offset": "-300" },
        });
        assert.strictEqual(res.status, 200);
        await new Promise((r) => setTimeout(r, 200)); // the write is fire-and-forget
        const row = await db.one("SELECT tz_offset_min FROM users WHERE id=$1", [u.id]);
        assert.strictEqual(Number(row.tz_offset_min), -300);
      } finally {
        await new Promise((r) => server.close(r));
      }
    });
  } finally {
    push.sendNotification = realSend;
  }

  console.log("\na patient is phoned once");

  await atest("two overlapping recall sweeps phone the patient once", async () => {
    const dialled = [];
    agent.enabled = () => true;
    agent.start = async (a) => { dialled.push(a); return { id: `stub-${dialled.length}` }; };
    try {
      const doc = await db.createUser({ email: `clinic-${Date.now()}@example.com`, name: "Dr Test", provider: "email" });
      const client = await db.one(
        `INSERT INTO clients (user_id, name, kind, phone, created_at, updated_at)
         VALUES ($1,'Ramesh Patient','patient','+919812345678',$2,$2) RETURNING id`,
        [doc.id, Date.now()]);
      await require("../src/practice/store").recallsNeedingCall(); // runs its migration
      await db.run(
        `INSERT INTO client_recalls (user_id, client_id, note, due_at, notify_patient, created_at)
         VALUES ($1,$2,'dental cleaning',$3,1,$4)`,
        [doc.id, client.id, Date.now() + 3 * 3600_000, Date.now()]);
      // The query must work at all (it overflowed an INTEGER until now).
      const practice = require("../src/practice/store");
      const found = (await practice.recallsNeedingCall()).filter((r) => Number(r.user_id) === Number(doc.id));
      assert.strictEqual(found.length, 1, "the recall sweep query did not find the due recall");
      // Both sweeps selected it before either stamped it — the race, made
      // deterministic: only the claim in markCalled can stop the second call.
      const realNeeding = practice.recallsNeedingCall;
      practice.recallsNeedingCall = async () => found;
      try {
        await Promise.all([scheduler.sweepPatientRecalls(), scheduler.sweepPatientRecalls()]);
      } finally {
        practice.recallsNeedingCall = realNeeding;
      }
      const toRamesh = dialled.filter((d) => Number(d.userId) === Number(doc.id));
      assert.strictEqual(toRamesh.length, 1, `the patient was phoned ${toRamesh.length} times`);
      // The Calls row is agentCall.start()'s (stubbed here): a second one
      // filed by the sweep was never settled and stayed "in progress".
      await new Promise((r) => setTimeout(r, 200));
      await require("../src/outcomes/store").migrate();
      const rows = await db.query(`SELECT id FROM task_outcomes WHERE user_id=$1`, [doc.id]);
      assert.strictEqual(rows.length, 0, "the recall sweep filed a Calls row of its own");
    } finally {
      agent.enabled = realAgent.enabled;
      agent.start = realAgent.start;
    }
  });

  console.log("\nscheduled work outlasts a busy model");

  // PRODUCTION, 2026-09-25: all seven scheduled tasks that evening ended
  // "Scheduled task failed" — six on a 503 from the chat model, one on a
  // timeout — and nothing was ever tried again.
  const jobs = require("../src/infra/jobs");
  require("../src/infra/handlers").install();
  const sent = [];
  push.sendNotification = async (token, title, body, data) => { sent.push({ token, title, body, data }); };
  const busyErr = () => Object.assign(
    new Error('gemini tools 503 [model=gemini-3.5-flash] {"error":{"code":503,"message":"high demand"}}'), { status: 503 });
  const worker = await db.createUser({ email: `busy-${Date.now()}@example.com`, name: "Busy Test", provider: "email" });
  await db.run("UPDATE users SET fcm_token=$2 WHERE id=$1", [worker.id, `tok-busy-${worker.id}`]);
  const pushesTo = () => sent.filter((p) => p.token === `tok-busy-${worker.id}`);
  const pending = (kind) => db.query(
    "SELECT * FROM jobs WHERE user_id=$1 AND kind=$2 AND status='pending' ORDER BY id", [worker.id, kind]);
  /** What the queue does with a claimed row: run its handler, then mark it done. */
  const runJob = async (row) => {
    await jobs.HANDLERS.get(row.kind)(row.payload, row);
    await db.run("UPDATE jobs SET status='done' WHERE id=$1", [row.id]);
  };
  const queue = async (kind, payload) => db.one("SELECT * FROM jobs WHERE id=$1",
    [await jobs.enqueue(kind, payload, { userId: worker.id, delayMs: -1000 })]);

  try {
    await atest("a scheduled task that meets a busy model runs again in a minute, then three — then says it failed", async () => {
      const rt = stubRuntime("", async () => { throw busyErr(); });
      try {
        const first = await queue("scheduled_task",
          { task: "Call Ravi and tell him the meeting moved", tzOffsetMin: 330, repeat: "daily" });
        const due = Number(first.run_after);
        await runJob(first);
        assert.strictEqual(pushesTo().length, 0, "no failure push while a retry is queued");
        let [retry] = await pending("scheduled_task");
        assert.ok(retry, "the busy run was not queued again");
        assert.deepStrictEqual([retry.payload.retry, retry.payload.dueAt, retry.payload.task],
          [1, due, "Call Ravi and tell him the meeting moved"]);
        assert.ok(Math.abs(Number(retry.run_after) - (Date.now() + 60_000)) < 5000, "a minute later");
        const note = await db.one("SELECT last_error FROM jobs WHERE id=$1", [first.id]);
        assert.match(note.last_error, /^RETRYING in 1 min: I couldn't complete it: gemini tools 503/);

        await runJob(retry);
        [retry] = await pending("scheduled_task");
        assert.deepStrictEqual([retry.payload.retry, retry.payload.dueAt], [2, due]);
        assert.ok(Math.abs(Number(retry.run_after) - (Date.now() + 180_000)) < 5000, "then three minutes");
        assert.strictEqual(pushesTo().length, 0);

        await runJob(retry);
        const p = pushesTo();
        assert.strictEqual(p.length, 1, JSON.stringify(p));
        assert.strictEqual(p[0].title, "Scheduled task failed");
        assert.match(p[0].body, /503/);
        assert.strictEqual(rt.calls.length, 3);
        // Tomorrow is queued from when today's run was DUE, not from the
        // last retry — and starts with a clean slate.
        const [tomorrow] = await pending("scheduled_task");
        assert.ok(Math.abs(Number(tomorrow.run_after) - (due + 24 * 3600_000)) < 5000,
          `tomorrow drifted by ${Number(tomorrow.run_after) - (due + 24 * 3600_000)} ms`);
        assert.strictEqual(tomorrow.payload.retry, undefined);
        assert.strictEqual(tomorrow.payload.dueAt, undefined);
      } finally {
        rt.restore();
        await db.run("UPDATE jobs SET status='cancelled' WHERE user_id=$1 AND status='pending'", [worker.id]);
      }
    });

    await atest("a run that already placed the call is never run again, busy model or not", async () => {
      const sessionState = require("../src/agents/sessionState");
      const rt = stubRuntime("", async (_text, ctx) => {
        sessionState.begin(ctx.userId, ctx.sessionId).executed.push({ tool: "place_phone_call", ok: true, at: Date.now() });
        throw busyErr();
      });
      try {
        const before = pushesTo().length;
        await runJob(await queue("scheduled_task", { task: "Call Ravi and tell him the meeting moved", tzOffsetMin: 330 }));
        assert.strictEqual((await pending("scheduled_task")).length, 0, "a second call could be placed");
        assert.strictEqual(pushesTo().slice(before)[0].title, "Scheduled task failed");
      } finally {
        rt.restore();
      }
    });

    // Review, 2026-09-27: only world actions stopped the retry, and
    // email_send and start_task are not filed as world actions — a busy
    // model after the mail went out would have sent it again a minute later.
    for (const tool of ["email_send", "start_task"]) {
      await atest(`a run that already began ${tool} is never run again either`, async () => {
        const rt = stubRuntime("", async (_text, _ctx, onEvent) => {
          onEvent("tool_start", { name: tool, args: {} });
          onEvent("tool_done", { name: tool, ok: true });
          throw busyErr();
        });
        try {
          const before = pushesTo().length;
          await runJob(await queue("scheduled_task", { task: "Mail Ravi that the meeting moved", tzOffsetMin: 330 }));
          assert.strictEqual((await pending("scheduled_task")).length, 0, `${tool} could run twice`);
          assert.strictEqual(pushesTo().slice(before)[0].title, "Scheduled task failed");
        } finally {
          rt.restore();
        }
      });
    }

    await atest("a refusal or a spent quota is reported at once, not retried", async () => {
      const rt = stubRuntime("", async () => {
        throw Object.assign(new Error("gemini tools 429 [model=gemini-flash-lite-latest] quota exceeded"), { status: 429 });
      });
      try {
        const before = pushesTo().length;
        await runJob(await queue("scheduled_task", { task: "Order my usual biryani", tzOffsetMin: 330 }));
        assert.strictEqual((await pending("scheduled_task")).length, 0);
        assert.strictEqual(pushesTo().slice(before).length, 1);
      } finally {
        rt.restore();
      }
    });

    await atest("deep research that meets a busy model is queued again, and says so only once the retries are spent", async () => {
      const ai = require("../src/services/ai/router");
      const webSearch = require("../src/tools/webSearch");
      const [realReply, realSearch] = [ai.generateReply, webSearch.run];
      ai.generateReply = async () => {
        throw Object.assign(new Error("gemini 503 [model=gemini-3.5-flash] high demand"), { status: 503 });
      };
      webSearch.run = async (q) => ({ ok: true, data: [{ title: q, url: "https://example.test/a", snippet: `About ${q}.` }] });
      try {
        const before = pushesTo().length;
        await runJob(await queue("deep_research", { userId: worker.id, question: "Is an e-scooter worth it for 20 km a day?" }));
        assert.strictEqual(pushesTo().length, before, "no 'didn't finish' while a retry is queued");
        const [retry] = await pending("deep_research");
        assert.strictEqual(retry.payload.retry, 1);
        assert.ok(Math.abs(Number(retry.run_after) - (Date.now() + 60_000)) < 5000);
        await db.run("UPDATE jobs SET status='cancelled' WHERE id=$1", [retry.id]);
        // Out of retries: the user is told.
        await runJob(await queue("deep_research", { ...retry.payload, retry: 2 }));
        assert.strictEqual((await pending("deep_research")).length, 0);
        const p = pushesTo().slice(before);
        assert.strictEqual(p.length, 1);
        assert.strictEqual(p[0].title, "Research didn't finish");
      } finally {
        ai.generateReply = realReply;
        webSearch.run = realSearch;
      }
    });
  } finally {
    push.sendNotification = realSend;
    await db.run("DELETE FROM jobs WHERE user_id=$1", [worker.id]).catch(() => {});
  }

  console.log("\nthe phone's capability report is kept");

  // Production, 2026-09-20 to 27: the table predates its diag column, which
  // only CREATE TABLE named — so every write failed, silently, for a week.
  // The report arrives with each turn of the app's conversation now
  // (POST /ai/context: build, platform, granted, denied).
  await atest("a table from before diag gets the column at boot, and the phone's report is stored", async () => {
    if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL)) {
      console.log("       (not a local database — the column is not dropped; skipped)");
      return;
    }
    const u = await db.createUser({ email: `caps-${Date.now()}@example.com`, name: "Caps Test", provider: "email" });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { sub: String(u.id) }; next(); });
    app.use("/ai", require("../src/ai/routes"));
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/ai/context`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    try {
      await db.run("ALTER TABLE user_devices DROP COLUMN IF EXISTS diag"); // production's table
      await db.init();
      const col = await db.one(
        `SELECT 1 AS ok FROM information_schema.columns WHERE table_name='user_devices' AND column_name='diag'`);
      assert.ok(col, "boot does not add the diag column back");
      const r = await post({ text: "hello", mode: "chat", platform: "android", build: 120,
        caps: { granted: ["microphone"], denied: ["location"] } });
      assert.strictEqual(r.status, 200);
      let row = null;
      for (let i = 0; i < 50 && !row; i++) {
        row = await db.one("SELECT * FROM user_devices WHERE user_id=$1", [u.id]);
        if (!row) await new Promise((res) => setTimeout(res, 20));
      }
      assert.ok(row, "the report was not stored");
      assert.deepStrictEqual([row.platform, row.build, row.granted, row.denied], ["android", 120, "microphone", "location"]);
      const src = require("fs").readFileSync(require.resolve("../src/ai/context.js"), "utf8");
      assert.match(src, /catch\(\(e\) => console\.warn\("user_devices write failed:", e\.message\)\)/,
        "a failed write is said out loud");
    } finally {
      await db.init(); // the column is back whatever happened above
      await db.run("DELETE FROM user_devices WHERE user_id=$1", [u.id]).catch(() => {});
      await require("../src/routes/privacy").deleteUserEverywhere(u.id, { reason: "assistant-test cleanup" }).catch(() => {});
      await new Promise((r) => server.close(r));
    }
  });

  console.log(`\n${passed} passed${process.exitCode ? " — with failures above" : ""}\n`);
  process.exit(process.exitCode || 0);
})();
