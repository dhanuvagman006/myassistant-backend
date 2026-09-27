/**
 * VOICE LOOP (/assistant) TESTS — `npm run test:assistant`.
 *
 * The SSE voice loop is the app's main path and had no HTTP-level test.
 * These drive the real router over HTTP with the agent runtime stubbed, so
 * they check what the loop hands the agent — no model, no keys.
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

async function mount() {
  const routes = require("../src/assistant/routes");
  const app = express();
  app.get("/assistant/stream/:sid", routes.streamHandler);
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { sub: "0", name: "Test" }; next(); });
  app.use("/assistant", routes);
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/assistant`;
  const post = (path, body = {}, headers = {}) => fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  /** Opens the session's SSE stream and collects its events. */
  const listen = async (s) => {
    const ac = new AbortController();
    const res = await fetch(`${base}/stream/${s.sessionId}?token=${s.streamToken}`, { signal: ac.signal });
    const events = [];
    (async () => {
      const dec = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = block.split("\n").find((l) => l.startsWith("data: "));
            if (data) events.push(JSON.parse(data.slice(6)));
          }
        }
      } catch (_) {}
    })();
    return { events, stop: () => ac.abort() };
  };
  return { post, listen, close: () => new Promise((r) => server.close(r)) };
}

/** Waits until an event matching `pred` arrives (or times out). */
async function waitFor(events, pred, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (events.some(pred)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Waits until the stub has seen `n` turns (turns run after the 202). */
async function turns(calls, n, ms = 3000) {
  const until = Date.now() + ms;
  while (calls.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  assert.ok(calls.length >= n, `expected ${n} agent turn(s), saw ${calls.length}`);
}

(async () => {
  console.log("\nwhere and when the user is");

  await atest("a turn with no headers (an audio upload) keeps the session's timezone and place", async () => {
    const rt = stubRuntime();
    const srv = await mount();
    try {
      const s = await (await srv.post("/session", {}, {
        "X-TZ-Offset": "60", "X-Geo-Lat": "51.5072", "X-Geo-Lng": "-0.1276",
      })).json();
      // The audio upload carries only Authorization — mimic it: no headers.
      await srv.post(`/${s.sessionId}/message`, { text: "remind me at 8 tomorrow to call the bank" });
      await turns(rt.calls, 1);
      const ctx = rt.calls[0].ctx;
      assert.strictEqual(ctx.tzOffsetMin, 60, "the agent was not given the user's timezone");
      assert.strictEqual(ctx.lat, 51.5072);
      assert.strictEqual(ctx.lng, -0.1276);
    } finally {
      rt.restore();
      await srv.close();
    }
  });

  await atest("UTC is a timezone, not a missing one", async () => {
    const rt = stubRuntime();
    const srv = await mount();
    try {
      const s = await (await srv.post("/session", {}, { "X-TZ-Offset": "0" })).json();
      await srv.post(`/${s.sessionId}/message`, { text: "what's on my calendar tomorrow" });
      await turns(rt.calls, 1);
      assert.strictEqual(rt.calls[0].ctx.tzOffsetMin, 0, "a UTC user was treated as IST");
    } finally {
      rt.restore();
      await srv.close();
    }
  });

  await atest("IST is assumed only when the phone never said", async () => {
    const rt = stubRuntime();
    const srv = await mount();
    try {
      const s = await (await srv.post("/session")).json();
      await srv.post(`/${s.sessionId}/message`, { text: "what's the weather" });
      await turns(rt.calls, 1);
      assert.strictEqual(rt.calls[0].ctx.tzOffsetMin, 330);
      assert.strictEqual(rt.calls[0].ctx.lat, undefined, "a location was invented");
    } finally {
      rt.restore();
      await srv.close();
    }
  });

  await atest("the offset helper keeps 0 and rejects nonsense", () => {
    const { offsetOr } = require("../src/services/tz");
    assert.strictEqual(offsetOr("0"), 0);
    assert.strictEqual(offsetOr(-300), -300);
    assert.strictEqual(offsetOr(undefined), 330);
    assert.strictEqual(offsetOr(""), 330);
    assert.strictEqual(offsetOr("abc"), 330);
    assert.strictEqual(offsetOr(99999), 330, "an impossible offset was accepted");
  });

  console.log("\nnothing the agent already did is done twice");

  const CALL = "call mom and tell her I'll be late";

  await atest("a runtime failure AFTER a tool ran is reported, not re-run by the legacy chain", async () => {
    const rt = stubRuntime(null, async (_t, _c, onEvent) => {
      onEvent("tool_start", { name: "place_phone_call" });
      onEvent("tool_done", { name: "place_phone_call", ok: true }); // the call went out
      throw new Error("model timed out on the follow-up round");
    });
    const srv = await mount();
    try {
      const s = await (await srv.post("/session")).json();
      const sse = await srv.listen(s);
      await srv.post(`/${s.sessionId}/message`, { text: CALL });
      await waitFor(sse.events, (e) => e.type === "assistant_message");
      await new Promise((r) => setTimeout(r, 150)); // anything the legacy chain would add
      sse.stop();
      assert.ok(!sse.events.some((e) => e.type === "contact_lookup"),
        "the legacy chain started a second call");
      const said = sse.events.find((e) => e.type === "assistant_message");
      assert.ok(said, "the user was told nothing");
      assert.match(said.text, /may already have gone through/);
    } finally {
      rt.restore();
      await srv.close();
    }
  });

  await atest("a silent reply after a successful tool speaks the tool's result, not the legacy chain", async () => {
    const rt = stubRuntime(null, async (_t, _c, onEvent) => {
      onEvent("tool_done", { name: "send_agent_message", ok: true });
      return {
        text: "",
        toolResults: [{ name: "send_agent_message", ok: true, speak: "Sent to Mom." }],
        deviceActions: [],
      };
    });
    const srv = await mount();
    try {
      const s = await (await srv.post("/session")).json();
      const sse = await srv.listen(s);
      await srv.post(`/${s.sessionId}/message`, { text: CALL });
      await waitFor(sse.events, (e) => e.type === "assistant_message");
      await new Promise((r) => setTimeout(r, 150));
      sse.stop();
      assert.ok(!sse.events.some((e) => e.type === "contact_lookup"),
        "an empty reply handed the turn to the legacy chain, which dialled");
      assert.strictEqual(sse.events.find((e) => e.type === "assistant_message").text, "Sent to Mom.");
    } finally {
      rt.restore();
      await srv.close();
    }
  });

  await atest("when the agent did nothing at all, the legacy chain still catches the turn", async () => {
    // The fallback exists for a runtime that broke before acting; that
    // must keep working.
    const rt = stubRuntime(null, async () => { throw new Error("model unavailable"); });
    const srv = await mount();
    try {
      const s = await (await srv.post("/session")).json();
      const sse = await srv.listen(s);
      await srv.post(`/${s.sessionId}/message`, { text: CALL });
      await waitFor(sse.events, (e) => e.type === "contact_lookup");
      sse.stop();
      assert.ok(sse.events.some((e) => e.type === "contact_lookup"),
        "the fallback no longer handles a turn the agent never started");
    } finally {
      rt.restore();
      await srv.close();
    }
  });

  console.log("\na dropped stream is not a reason to say it twice");

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

  console.log(`\n${passed} passed${process.exitCode ? " — with failures above" : ""}\n`);
  process.exit(process.exitCode || 0);
})();
