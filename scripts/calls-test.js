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

/**
 * CALLS THE ASSISTANT PLACES, WHEN THE CALLING SERVICE SAYS NO.
 *
 * 2026-09-24: every relayed call failed all day on the service's 400
 * "Calling from_number +91… doesn't exist for plivo", the owner was told
 * nothing useful, and nobody on the developer side knew. These pin:
 *   (a) the saved agent config is the owner's dashboard, and the update
 *       script refuses to undo a dashboard that differs from it;
 *   (b) a refused call says so plainly and falls back to a direct dial;
 *   (c) the refusal is one admin-panel alert an hour, logs carry counts.
 * The service is stubbed at fetch — nothing here dials anyone.
 */
async function agentCallFailures() {
  const { spawnSync } = require("child_process");
  const path = require("path");
  const cfgMod = require("../src/agents/callAgentConfig");
  const agent = require("../src/agents/agentCall");
  const registry = require("../src/tools/registry");
  require("../src/tools/builtins").registerBuiltins();
  const claimCheck = require("../src/agents/claimCheck");

  const FROM = "+918064261411";
  const CONTACT = "+919812345678";
  const REJECTION =
    `Calling from_number ${FROM} doesn't exist for plivo. ` +
    "Please check your agent telephony provider.";
  const OWNER_DASHBOARD = {
    telephony_in: "vobiz", telephony_out: "vobiz",
    voice_provider: "elevenlabs", voice_model: "eleven_v3_conversational",
    voice_id: "NyZqLdjqUb8SpOUKIlWT",
    hearing_provider: "deepgram", hearing_model: "nova-3", hearing_language: "en",
  };

  console.log("\nthe calling agent is the one the owner set up");

  await atest("the saved agent config matches the owner's dashboard choices", async () => {
    const mine = cfgMod.agentConfig({ webhookUrl: "https://x.test/hook" }).agent_config;
    assert.deepStrictEqual(cfgMod.dashboardChoices(mine), OWNER_DASHBOARD);
    assert.strictEqual(cfgMod.TELEPHONY, "vobiz");
    assert.strictEqual(cfgMod.VOICE.model, "eleven_v3_conversational");
    assert.strictEqual(cfgMod.VOICE.id, "NyZqLdjqUb8SpOUKIlWT");
    assert.strictEqual(cfgMod.TRANSCRIBER.language, "en");
    // The dashboard as the owner left it is no drift at all.
    assert.deepStrictEqual(cfgMod.dashboardDrift({ agent_config: mine }), []);
  });

  /** The live agent as the service would return it, with overrides. */
  const liveAgent = (over = {}) => {
    const a = cfgMod.agentConfig({ webhookUrl: "" }).agent_config;
    const tc = a.tasks[0].tools_config;
    if (over.telephony) { tc.input.provider = over.telephony; tc.output.provider = over.telephony; }
    if (over.voiceId) tc.synthesizer.provider_config.voice_id = over.voiceId;
    if (over.voiceLabel) tc.synthesizer.provider_config.voice = over.voiceLabel;
    if (over.language) tc.transcriber.language = over.language;
    return a;
  };
  /** Run scripts/update_bolna_agent.js with the service stubbed out. */
  const runUpdate = (live, args = []) => {
    const stub =
      `const live = ${JSON.stringify(live)};` +
      "globalThis.fetch = async (url, opts = {}) => {" +
      "  if ((opts.method || 'GET') === 'PUT') {" +
      "    const b = JSON.parse(opts.body);" +
      "    console.log('PUT_SENT voice=' + b.agent_config.tasks[0].tools_config.synthesizer.provider_config.voice);" +
      "    return { ok: true, status: 200, text: async () => '{}' };" +
      "  }" +
      "  return { ok: true, status: 200, json: async () => live };" +
      "};" +
      `require(${JSON.stringify(path.join(__dirname, "update_bolna_agent.js"))});`;
    return spawnSync(process.execPath, ["-e", stub, "--", ...args], {
      env: { ...process.env, BOLNA_API_KEY: "bn-test", BOLNA_AGENT_ID: "agent-test", BOLNA_TELEPHONY_PROVIDER: "" },
      encoding: "utf8",
      timeout: 20_000,
    });
  };

  await atest("the update script refuses to undo a dashboard that differs from the file", async () => {
    const r = runUpdate(liveAgent({ telephony: "plivo", language: "hi" }));
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.ok(!/PUT_SENT/.test(r.stdout), "it sent the config anyway");
    assert.match(r.stderr, /REFUSED/);
    assert.match(r.stderr, /telephony_in: dashboard "plivo" → file "vobiz"/);
    assert.match(r.stderr, /hearing_language: dashboard "hi" → file "en"/);
    // Overwriting is a deliberate act, not a default.
    const forced = runUpdate(liveAgent({ telephony: "plivo" }), ["--overwrite-dashboard"]);
    assert.strictEqual(forced.status, 0, forced.stdout + forced.stderr);
    assert.match(forced.stdout, /PUT_SENT/);
  });

  await atest("a matching dashboard is updated, and keeps its own label for the voice", async () => {
    const r = runUpdate(liveAgent({ voiceLabel: "Dashboard Voice Label" }));
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PUT_SENT voice=Dashboard Voice Label/);
  });

  // ---- (b) + (c): the service refuses our caller number ----
  const saved = {};
  for (const k of ["BOLNA_API_KEY", "BOLNA_FROM_NUMBER", "BOLNA_AGENT_ID", "PUBLIC_BASE_URL"]) {
    saved[k] = process.env[k];
  }
  Object.assign(process.env, {
    BOLNA_API_KEY: "bn-test", BOLNA_FROM_NUMBER: FROM,
    BOLNA_AGENT_ID: "agent-test", PUBLIC_BASE_URL: "https://api.example.test",
  });
  const realFetch = globalThis.fetch;
  let bolnaAnswer = () => new Response(JSON.stringify({ message: REJECTION }), { status: 400 });
  let bolnaHits = 0;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith("https://api.bolna.ai")) { bolnaHits++; return bolnaAnswer(); }
    return realFetch(url, opts);
  };
  const logs = [];
  const realErr = console.error;
  const realWarn = console.warn;
  console.error = (...a) => { logs.push(a.join(" ")); };
  console.warn = (...a) => { logs.push(a.join(" ")); };
  const alertRows = () => db.query(
    `SELECT id, kind, summary, source, user_id FROM developer_feedback
      WHERE source='ops' AND summary LIKE 'Calling service rejected the caller number:%'
      ORDER BY id`);
  await db.run(
    `DELETE FROM developer_feedback WHERE source='ops' AND summary LIKE 'Calling service rejected%'`);
  agent._resetTrouble();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { sub: String(UID), name: "Owner Test" }; next(); });
  app.use("/agent-call", require("../src/routes/agentCall").router);
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}/agent-call`;
  const relay = () => realFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toNumber: CONTACT, contactName: "Ravi Kumar", task: "tell him I'll be late" }),
  });

  try {
    console.log("\nwhen the calling service says no");

    await atest("a refused relay says so plainly and falls back to a direct dial", async () => {
      const r = await relay();
      assert.strictEqual(r.status, 502);
      const j = await r.json();
      assert.strictEqual(j.fallback, "direct_dial");
      assert.strictEqual(j.reason, "call_service_rejected");
      assert.match(j.say, /couldn't place the call through my calling service/);
      assert.match(j.say, /dialling Ravi Kumar from your phone/);
      // Nothing of the service's reply reaches the owner.
      assert.ok(!/plivo|from_number|\d{6,}/i.test(JSON.stringify(j)), JSON.stringify(j));
      assert.strictEqual(bolnaHits, 1);
    });

    await atest("not configured carries the same direct-dial fallback", async () => {
      const key = process.env.BOLNA_API_KEY;
      delete process.env.BOLNA_API_KEY;
      try {
        const r = await relay();
        assert.strictEqual(r.status, 503);
        const j = await r.json();
        assert.strictEqual(j.error, "agent calling not configured", "old builds read this");
        assert.strictEqual(j.fallback, "direct_dial");
      } finally {
        process.env.BOLNA_API_KEY = key;
      }
    });

    await atest("the next 'call X and tell him' dials directly and says why", async () => {
      assert.ok(agent.relayDown(), "the rejection was not remembered");
      const res = await registry.get("place_phone_call").execute(
        { name: "Ravi", message: "tell him I'll be late" }, { userId: UID });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.deviceAction.agent_available, false, "the phone would try the relay again");
      assert.strictEqual(res.deviceAction.message, "tell him I'll be late");
      assert.match(res.speak, /calling service couldn't place calls just now, so I'll dial Ravi from your phone/);
      assert.deepStrictEqual(res.data, { call_service: "failed", fallback: "direct_dial" });
      assert.match(res.note, /calling service failed/);
      assert.ok(!/plivo/i.test(res.speak + res.note));
      // The honest line is not itself mistaken for a claim to have dialled.
      assert.strictEqual(claimCheck.classify(res.speak), null);
      // A plain call is untouched: nothing was to be relayed.
      const plain = await registry.get("place_phone_call").execute({ name: "Ravi" }, { userId: UID });
      assert.strictEqual(plain.deviceAction.agent_available, true);
      assert.match(plain.speak, /^Looking up Ravi/);
    });

    await atest("a wake-up call the service refuses is reported plainly, provider unnamed", async () => {
      const u = await db.createUser({ email: `wake-${Date.now()}@example.com`, name: "Wake Test", provider: "email" });
      await db.run("UPDATE users SET phone_number=$1 WHERE id=$2", ["+919800000001", u.id]);
      try {
        const res = await registry.get("place_phone_call").execute(
          { name: "me", message: "wake me up" }, { userId: u.id });
        assert.strictEqual(res.ok, false);
        assert.match(res.error, /calling service failed/);
        assert.match(res.error, /reminder alarm/);
        assert.ok(!/plivo|from_number|bolna|\d{6,}/i.test(res.error), res.error);
      } finally {
        await db.run("DELETE FROM task_outcomes WHERE user_id=$1", [u.id]).catch(() => {});
        await db.run("DELETE FROM users WHERE id=$1", [u.id]).catch(() => {});
      }
    });

    await atest("the developer gets ONE alert an hour, with the service's words", async () => {
      await waitFor(async () => (await alertRows()).length >= 1);
      const rows = await alertRows();
      assert.strictEqual(rows.length, 1, `${rows.length} alerts for one outage`);
      assert.strictEqual(rows[0].kind, "alert");
      assert.strictEqual(Number(rows[0].user_id), 0);
      assert.strictEqual(rows[0].summary,
        `Calling service rejected the caller number: ${REJECTION}`);
      // Three refusals so far (relay, wake-up, and one more now) — still one row.
      await relay();
      await settle();
      assert.strictEqual((await alertRows()).length, 1);
      // An hour on, it is raised again.
      agent._trouble.alertedAt -= 3600_000 + 1;
      await db.run(`UPDATE developer_feedback SET created_at = created_at - 3700000 WHERE id=$1`, [rows[0].id]);
      await relay();
      await waitFor(async () => (await alertRows()).length === 2);
    });

    await atest("the logs carry counts, never a contact's number or the reply", async () => {
      const text = logs.join("\n");
      assert.match(text, /calling service rejected the caller number \(1 in the last hour\)/);
      assert.match(text, /\(4 in the last hour\)/);
      assert.ok(!text.includes(CONTACT.slice(3)), "a contact's number was logged");
      assert.ok(!text.includes("+919800000001".slice(3)), "the owner's number was logged");
      assert.ok(!/doesn't exist for/.test(text), "the reply was logged, not a count");
    });

    await atest("the assistant screen offers the owner's own phone, not a dead end", async () => {
      const { newSession, startAgentCall } = require("../src/assistant/routes")._test;
      const s = newSession(null, "Owner Test");
      await startAgentCall(s, { name: "Ravi Kumar", phone: CONTACT }, "tell him I'll be late", null);
      const events = s.buffer.map((b) => JSON.parse(b.json));
      const said = events.filter((e) => e.type === "assistant_message").map((e) => e.text);
      assert.ok(said.some((t) => /couldn't place the call through my calling service/.test(t) &&
        /dial Ravi Kumar from your phone/.test(t)), JSON.stringify(said));
      assert.ok(!/plivo|from_number/i.test(JSON.stringify(events)));
      // The dial waits for the owner's tap.
      const ask = events.find((e) => e.type === "confirmation_request");
      assert.ok(ask && ask.action === "call", "no direct dial was offered");
      assert.strictEqual(s.pending?.action, "call");
    });

    await atest("other refusals are logged with every number blanked", async () => {
      bolnaAnswer = () => new Response(
        JSON.stringify({ message: `recipient ${CONTACT} is not reachable` }), { status: 400 });
      const r = await relay();
      assert.strictEqual(r.status, 502);
      assert.strictEqual((await r.json()).reason, "call_service_failed");
      const text = logs.join("\n");
      assert.match(text, /recipient \[number\] is not reachable/);
      assert.ok(!text.includes(CONTACT.slice(3)));
    });

    await atest("a call that goes out clears the fallback", async () => {
      bolnaAnswer = () => new Response(JSON.stringify({ execution_id: "exec-1" }), { status: 200 });
      const r = await relay();
      assert.strictEqual(r.status, 202);
      assert.strictEqual(agent.relayDown(), false);
      const res = await registry.get("place_phone_call").execute(
        { name: "Ravi", message: "tell him I'll be late" }, { userId: UID });
      assert.strictEqual(res.deviceAction.agent_available, true);
      assert.match(res.speak, /Let me find Ravi and call them/);
    });
  } finally {
    srv.close();
    globalThis.fetch = realFetch;
    console.error = realErr;
    console.warn = realWarn;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    agent._resetTrouble();
    await db.run(
      `DELETE FROM developer_feedback WHERE source='ops' AND summary LIKE 'Calling service rejected%'`);
    await db.run("DELETE FROM task_outcomes WHERE user_id=$1", [UID]).catch(() => {});
  }
}

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

  await agentCallFailures();

  server.close();
  await db.run(`DELETE FROM call_records WHERE user_id=$1`, [UID]);
  await db.run(`DELETE FROM kv WHERE k=$1`, [`call_analysis:${UID}`]);
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})();
