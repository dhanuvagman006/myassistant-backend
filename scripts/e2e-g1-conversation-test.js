/**
 * G1 — CONVERSATION, END TO END.
 *
 *   DATABASE_URL=postgres://myassistant:localdev@127.0.0.1:55432/myassistant_e2e_g1 \
 *     node scripts/e2e-g1-conversation-test.js
 *
 * The paths a person uses to TALK to the assistant, driven the way the
 * phone drives them:
 *
 *   - the LIVE VOICE SOCKET: a real HTTP upgrade on /live/ws with a real
 *     session token (JWT through verifySession), the proxy's Google socket
 *     redirected to a fake Google on 127.0.0.1 that plays the model's part
 *     (setupComplete, transcripts, tool calls, turn ends);
 *   - the TYPED / CLASSIC LOOP: POST /assistant/session, the SSE stream and
 *     POST /:sid/message through the REAL agent runtime and REAL tools, with
 *     only the model call scripted;
 *   - memory (remember -> recall -> forget), plans (start_task -> planner ->
 *     driver), finance, Momentum, schedule_task and the widget's /tasks/quick
 *     through the job handler, deep research, the proactive sweep producing
 *     its pushes, and recent-context injection into a new session.
 *
 * Nothing leaves this machine: the model, push, and every non-local fetch
 * are stubbed. The test users are erased at the end with the same routine a
 * real account deletion uses, and the documents folder is a temp dir.
 *
 * Tests named "DEFECT:" pin a real bug and are EXPECTED TO FAIL until it is
 * fixed. Everything else must pass.
 */
"use strict";

process.env.NODE_ENV = process.env.NODE_ENV || "test";
if (process.env.NODE_ENV === "production") {
  console.error("e2e-g1 must never run against production");
  process.exit(2);
}
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@127.0.0.1:55432/myassistant_e2e_g1";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const assert = require("assert");

/* ------------------------------------------------------------------ */
/* An isolated, offline environment                                    */
/* ------------------------------------------------------------------ */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "g1-e2e-data-"));
process.env.DATA_DIR = DATA_DIR;
process.env.LIVE_RECORD = "0";
// The live proxy refuses to start without a key; this one never reaches
// Google (the socket is redirected and fetch is blocked below).
process.env.GEMINI_API_KEY = "g1-e2e-not-a-real-key";
process.env.JWT_SECRET = "g1-e2e-" + crypto.randomBytes(12).toString("hex");
for (const k of [
  "GEMINI_LIVE_MODEL", "GEMINI_LIVE_MODEL_NEXT", "LIVE_BARGE_IN", "LIVE_SILENCE_MS",
  "LIVE_SILENCE_MS_DUPLEX", "LIVE_ACTIVITY_HANDLING", "LIVE_END_SENSITIVITY",
  "LIVE_GOOGLE_SEARCH", "MORNING_BRIEF", "MORNING_BRIEF_HOUR", "MORNING_BRIEF_WINDOW_H",
  "QUIET_HOURS_START", "QUIET_HOURS_END", "BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY",
  "GOOGLE_CSE_KEY", "GOOGLE_CSE_CX", "OPENAI_API_KEY", "AGENT_RUNTIME", "AUTH_DISABLED",
  "ALLOW_APP_KEY",
]) delete process.env[k];

// NOTHING GOES OUT. Every fetch to anything but this machine fails fast.
const BLOCKED = [];
const realFetch = global.fetch;
global.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) return realFetch(input, init);
  BLOCKED.push(url.slice(0, 120));
  throw new Error("g1-e2e: offline (" + url.slice(0, 60) + ")");
};

/* ------------------------------------------------------------------ */
/* The model, scripted. Installed BEFORE anything that destructures it  */
/* ------------------------------------------------------------------ */

const aiRouter = require("../src/services/ai/router");
const AI = {
  stream: [], // runtime rounds: {text, functionCalls:[{name,args}]} or fn(opts)
  plans: [], // submit_plan args, or fn(opts)
  replies: [], // {match: RegExp on system+first message, reply: string|fn}
  seen: { stream: [], plans: [], replies: [] },
};
const asCalls = (list) => (list || []).map((c) => ({ name: c.name, args: c.args || {} }));
async function nextRound(opts) {
  AI.seen.stream.push(opts);
  const next = AI.stream.shift();
  if (!next) throw new Error("g1-e2e: the model was called with nothing scripted");
  return typeof next === "function" ? await next(opts) : next;
}
aiRouter.generateWithToolsStream = async (opts = {}) => {
  const out = await nextRound(opts);
  if (out.text && typeof opts.onDelta === "function") opts.onDelta(out.text);
  return { text: out.text || "", functionCalls: asCalls(out.functionCalls) };
};
aiRouter.generateWithTools = async (opts = {}) => {
  if ((opts.declarations || []).some((d) => d && d.name === "submit_plan")) {
    AI.seen.plans.push(opts);
    const next = AI.plans.shift();
    if (!next) throw new Error("g1-e2e: the planner was called with nothing scripted");
    const args = typeof next === "function" ? await next(opts) : next;
    return { text: "", functionCalls: [{ name: "submit_plan", args }] };
  }
  const out = await nextRound(opts); // the runtime's non-streaming fallback
  return { text: out.text || "", functionCalls: asCalls(out.functionCalls) };
};
aiRouter.generateReply = async (messages = [], opts = {}) => {
  const sys = String(opts.system || "");
  const first = String((messages[0] && messages[0].content) || "");
  AI.seen.replies.push({ system: sys, first });
  const i = AI.replies.findIndex((r) => r.match.test(sys) || r.match.test(first));
  if (i >= 0) {
    const r = AI.replies.splice(i, 1)[0];
    return { reply: typeof r.reply === "function" ? r.reply(messages, opts) : r.reply };
  }
  // Nothing to extract unless a test says so.
  if (/COMMITMENTS/.test(sys)) return { reply: '{"commitments":[]}' };
  return { reply: "[]" };
};
aiRouter.generateReplyStream = async () => { throw new Error("g1-e2e: offline"); };
aiRouter.callGemini = async () => { throw new Error("g1-e2e: offline"); };

/* Push: captured, never sent. */
const push = require("../src/services/push");
const PUSHES = [];
push.sendNotification = async (token, title, body, data) => {
  PUSHES.push({ token, title, body, data: data || {} });
  return true;
};
push.send = async (token, title, body, data) => {
  PUSHES.push({ token, title, body, data: data || {} });
  return { ok: true, stale: false, skipped: false, error: null };
};

/* Web search: scripted results, never the network. */
const webSearch = require("../src/tools/webSearch");
let searchImpl = async (q) => ({
  ok: true,
  data: [{ title: `Result for ${q}`, url: "https://example.test/" + encodeURIComponent(q), snippet: `About ${q}.` }],
});
webSearch.run = (q, opts) => searchImpl(q, opts);

/* ------------------------------------------------------------------ */

const db = require("../src/db");
const jwt = require("jsonwebtoken");
const express = require("express");
const RealWs = require("ws");

let passed = 0;
let failed = 0;
const failures = [];
async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    failures.push(name);
    console.error(`  FAIL ${name}\n       ${String((e && e.stack) || e).split("\n").slice(0, 6).join("\n       ")}`);
    process.exitCode = 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(15);
  }
}

/** YYYY-MM-DDTHH:MM:00+05:30 for an instant, in the given offset. */
function isoLocal(ms, tz = 330) {
  const d = new Date(ms + tz * 60_000).toISOString().slice(0, 16);
  const sign = tz < 0 ? "-" : "+";
  const a = Math.abs(tz);
  return `${d}:00${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

(async () => {
  await db.init();
  const registry = require("../src/tools/registry");
  require("../src/tools/builtins").registerBuiltins();
  require("../src/agents/taskTools").registerTaskTools();
  require("../src/infra/handlers").install();
  const jobs = require("../src/infra/jobs");
  const tasks = require("../src/agents/tasks");
  await tasks.migrate();

  /* ---------------- the live proxy, with Google on this machine ---------------- */
  let GOOGLE_PORT = 0;
  class ToLocalGoogle extends RealWs {
    constructor(address, protocols, options) {
      const s = String(address);
      if (s.startsWith("wss://generativelanguage.googleapis.com/")) {
        address = `ws://127.0.0.1:${GOOGLE_PORT}/google${new URL(s).search}`;
      }
      super(address, protocols, options);
    }
  }
  const wsPath = require.resolve("ws");
  const proxyPath = require.resolve("../src/live/proxy");
  const wsExports = require.cache[wsPath].exports;
  delete require.cache[proxyPath];
  require.cache[wsPath].exports = ToLocalGoogle;
  let proxy;
  try {
    proxy = require("../src/live/proxy");
  } finally {
    require.cache[wsPath].exports = wsExports;
  }

  const GOOGLE = { conns: [] };
  const googleWss = new RealWs.Server({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => googleWss.once("listening", r));
  GOOGLE_PORT = googleWss.address().port;
  googleWss.on("connection", (ws, req) => {
    const c = { ws, url: req.url, msgs: [], closed: false };
    c.send = (o) => ws.send(JSON.stringify(o));
    ws.on("message", (d) => { try { c.msgs.push(JSON.parse(String(d))); } catch (_) {} });
    ws.on("close", () => { c.closed = true; });
    ws.on("error", () => {});
    GOOGLE.conns.push(c);
  });

  /* ---------------- the real routers, behind the real appAuth ---------------- */
  const { appAuth } = require("../src/middleware/auth");
  const assistantRoutes = require("../src/assistant/routes");
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.get("/assistant/stream/:sid", assistantRoutes.streamHandler);
  app.use("/assistant", appAuth, assistantRoutes);
  app.use("/tasks", appAuth, require("../src/routes/tasks"));
  app.use("/finance", appAuth, require("../src/routes/finance").router);
  app.use("/momentum", appAuth, require("../src/momentum/routes"));
  app.use("/live", proxy.probeRouter());
  const server = http.createServer(app);
  proxy.attachWs(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const PORT = server.address().port;
  const BASE = `http://127.0.0.1:${PORT}`;

  /* ---------------- a real account ---------------- */
  const stamp = Date.now();
  const user = await db.createUser({
    email: `g1-e2e-${stamp}@example.test`, name: "Dhanush K", gender: "male",
  });
  const UID = user.id;
  const FCM = `g1-e2e-fcm-${stamp}`;
  const PHONE = "+91" + String(7000000000 + Math.floor(Math.random() * 999999999));
  await db.run(
    `UPDATE users SET tz_offset_min=330, fcm_token=$2, fcm_token_at=$3,
            phone_number=$4, phone_verified_at=$3 WHERE id=$1`,
    [UID, FCM, Date.now() - 3600_000, PHONE]
  );
  const JWT = jwt.sign({ uid: UID }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const mine = () => PUSHES.filter((p) => p.token === FCM);

  const headers = (extra = {}) => ({
    "content-type": "application/json",
    authorization: `Bearer ${JWT}`,
    "X-TZ-Offset": "330",
    "X-App-Build": "118",
    ...extra,
  });
  async function api(method, p, body, extra) {
    const r = await fetch(BASE + p, {
      method, headers: headers(extra),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await r.json(); } catch (_) {}
    return { status: r.status, body: json };
  }

  const facts = async () => db.query(
    `SELECT fact, valid FROM agent_memories WHERE user_id=$1 ORDER BY id`, [UID]);
  const validFacts = async () => (await facts()).filter((f) => Number(f.valid) === 1).map((f) => f.fact);

  /* ---------------- the phone's side of a live call ---------------- */
  async function openLive({ build = 118, tz = 330, token = JWT } = {}) {
    const before = GOOGLE.conns.length;
    const qs = new URLSearchParams({
      token, tz: String(tz), platform: "android", build: String(build),
      granted: "microphone,contacts,location,camera,phone,notifications,calendar",
      denied: "",
    });
    const ws = new RealWs(`ws://127.0.0.1:${PORT}/live/ws?${qs}`);
    const frames = [];
    let closedCode = null;
    ws.on("message", (d, isBinary) => {
      if (isBinary) { frames.push({ type: "__audio", bytes: d.length }); return; }
      try { frames.push(JSON.parse(String(d))); } catch (_) {}
    });
    ws.on("close", (code) => { closedCode = code; });
    ws.on("error", () => {});
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("unexpected-response", (_q, r) => rej(new Error(`upgrade refused: ${r.statusCode}`)));
      ws.once("error", rej);
    });
    await until(() => GOOGLE.conns.length > before, "the proxy to dial Google");
    const up = GOOGLE.conns[GOOGLE.conns.length - 1];
    await until(() => up.msgs.some((m) => m.setup), "the setup message", 10000);
    up.send({ setupComplete: {} });
    await until(() => frames.some((f) => f.type === "ready"), "ready on the phone");
    const s = {
      ws, frames, up,
      setup: up.msgs.find((m) => m.setup).setup,
      closedCode: () => closedCode,
      fromApp: (o) => ws.send(JSON.stringify(o)),
      heard: (text) => up.send({ serverContent: { inputTranscription: { text } } }),
      says: (text) => up.send({ serverContent: { outputTranscription: { text } } }),
      turnDone: async () => {
        const n = frames.filter((f) => f.type === "turn_complete").length;
        up.send({ serverContent: { turnComplete: true } });
        await until(() => frames.filter((f) => f.type === "turn_complete").length > n, "turn_complete on the phone");
        await sleep(150); // anything the proxy sends Google after it
      },
      toolAnswer: (id) => up.msgs.filter((m) => m.toolResponse)
        .flatMap((m) => m.toolResponse.functionResponses).find((r) => r.id === id),
      call: async (id, name, args) => {
        up.send({ toolCall: { functionCalls: [{ id, name, args }] } });
        await until(() => s.toolAnswer(id), `the tool answer for ${name}`, 15000);
        return s.toolAnswer(id);
      },
      notes: () => up.msgs.filter((m) => m.clientContent)
        .map((m) => (m.clientContent.turns || []).map((t) => (t.parts || []).map((p) => p.text).join(" | ")).join(" ")),
      close: async () => {
        try { ws.close(); } catch (_) {}
        await until(() => up.closed, "the Google side to close");
      },
    };
    return s;
  }
  const corrections = (s, from = 0) => s.notes().slice(from).filter((t) => /\[SYSTEM\] (CORRECTION|STOP)/.test(t));

  /* ---------------- the classic loop's SSE stream ---------------- */
  async function classicSession() {
    const r = await api("POST", "/assistant/session", {});
    assert.strictEqual(r.status, 200, "session: " + JSON.stringify(r.body));
    const s = r.body;
    const ac = new AbortController();
    const res = await fetch(`${BASE}/assistant/stream/${s.sessionId}?token=${s.streamToken}`, { signal: ac.signal });
    assert.strictEqual(res.status, 200);
    const events = [];
    (async () => {
      const dec = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block.split("\n").find((l) => l.startsWith("data: "));
            if (data) events.push(JSON.parse(data.slice(6)));
          }
        }
      } catch (_) {}
    })();
    return {
      sid: s.sessionId, events, stop: () => ac.abort(),
      say: (text) => api("POST", `/assistant/${s.sessionId}/message`, { text }),
      confirm: (approved) => api("POST", `/assistant/${s.sessionId}/confirm`, { approved }),
      last: (type) => [...events].reverse().find((e) => e.type === type),
    };
  }

  try {
    /* ================================================================ */
    console.log("\nlive voice: what a new session is told");
    /* ================================================================ */

    await atest("session start carries the profile, remembered facts and the earlier conversation — not its failures or titles", async () => {
      await registry.execute("remember_fact", { fact: "User is vegetarian" }, { userId: UID });
      const recent = require("../src/memory/recent");
      const old = { source: "live", sessionId: "live:g1-earlier", appBuild: 118 };
      recent.append(UID, "user", "What's on my calendar tomorrow?", { ...old, turnId: "e1" });
      recent.append(UID, "assistant", "You have a meeting with Allen at 4 pm, Sir.", { ...old, turnId: "e1" });
      recent.append(UID, "user", "Set a timer for five minutes", { ...old, turnId: "e2" });
      recent.append(UID, "assistant", "Sorry, I couldn't set the timer.", { ...old, turnId: "e2" });
      await until(async () => (await db.one(
        `SELECT count(*)::int AS n FROM conversation_turns WHERE user_id=$1 AND session_id='live:g1-earlier'`,
        [UID])).n === 4, "the earlier turns to be written");

      const s = await openLive();
      try {
        const sys = s.setup.systemInstruction.parts[0].text;
        assert.match(sys, /name: Dhanush K/, "the profile");
        assert.match(sys, /WHAT YOU REMEMBER ABOUT THIS USER[\s\S]*User is vegetarian/, "the remembered fact");
        assert.match(sys, /User said: What's on my calendar tomorrow\?/);
        assert.ok(sys.includes("You said: You have a meeting with Allen at 4 pm."),
          "the earlier answer, title removed");
        assert.ok(!/4 pm, Sir/.test(sys), "past replies do not teach the title");
        assert.ok(!/couldn't set the timer/.test(sys), "a past failure is not carried as a lesson");
        assert.match(sys, /This is a NEW conversation/, "the do-not-re-execute guard");
        assert.match(sys, /Current date and time for the user: .* \(UTC\+05:30\)/);
        const ready = s.frames.find((f) => f.type === "ready");
        assert.strictEqual(ready.bargeIn, true, "build 118 may be interrupted");
        assert.strictEqual(s.setup.realtimeInputConfig.automaticActivityDetection.silenceDurationMs, 600);
        const names = s.setup.tools[0].functionDeclarations.map((d) => d.name);
        for (const n of ["remember_fact", "recall_memory", "forget_memory", "remember_person_date",
          "start_task", "schedule_task", "web_search", "deep_research", "add_finance_item",
          "get_finance_plan", "plan_my_day", "start_focus", "momentum_status", "recall_conversation",
          "check_recent_actions", "end_conversation", "stay_silent", "do_task_in_app"]) {
          assert.ok(names.includes(n), `live model is offered ${n}`);
        }
        assert.ok(!names.includes("make_greeting_poster"), "build 119 cards are not offered to 118");
      } finally {
        await s.close();
      }
    });

    await atest("an older build (110) keeps the half-duplex session and is not offered newer tools", async () => {
      const s = await openLive({ build: 110 });
      try {
        assert.strictEqual(s.frames.find((f) => f.type === "ready").bargeIn, false);
        assert.strictEqual(s.setup.realtimeInputConfig.activityHandling, "NO_INTERRUPTION");
        const names = s.setup.tools[0].functionDeclarations.map((d) => d.name);
        assert.ok(!names.includes("start_focus"), "start_focus needs build 111");
        assert.ok(names.includes("do_task_in_app"), "do_task_in_app is build 104");
      } finally {
        await s.close();
      }
    });

    await atest("on the production live model (3.1): no googleSearch in setup, web_search is the live-data path", async () => {
      process.env.GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
      let s;
      try {
        s = await openLive();
      } finally {
        delete process.env.GEMINI_LIVE_MODEL;
      }
      try {
        assert.match(s.setup.model, /^models\/gemini-3\.1-flash-live-preview/);
        assert.ok(!s.setup.tools.some((t) => t.googleSearch), "the 3.x live models reject googleSearch");
        const decls = s.setup.tools[0].functionDeclarations;
        assert.ok(decls.some((d) => d.name === "web_search"));
        assert.ok(!decls.some((d) => d.behavior === "BLOCKING"), "3.1 is not a blocking-tools model");
        assert.strictEqual(s.frames.find((f) => f.type === "ready").model, "gemini-3.1-flash-live-preview");
      } finally {
        await s.close();
      }
    });

    await atest("a bad or missing token never opens a live session", async () => {
      await assert.rejects(openLive({ token: "not-a-token" }), /upgrade refused: 401/);
      const probe = await (await fetch(`${BASE}/live`)).json();
      assert.strictEqual(probe.available, true);
    });

    /* ================================================================ */
    console.log("\nlive voice: memory round trip (remember -> recall -> forget)");
    /* ================================================================ */

    await atest("remember, recall, then forget only after a spoken yes — and the next session no longer knows it", async () => {
      const s = await openLive();
      try {
        s.heard("remember that my sister's name is Priya");
        const a1 = await s.call("m1", "remember_fact", { fact: "User's sister is named Priya" });
        assert.strictEqual(a1.response.ok, true, JSON.stringify(a1.response));
        assert.ok(s.frames.some((f) => f.type === "tool_started" && f.tool === "remember_fact"));
        assert.ok(s.frames.some((f) => f.type === "tool_completed" && f.tool === "remember_fact"));
        assert.ok((await validFacts()).includes("User's sister is named Priya"));
        const n0 = s.notes().length;
        s.says("Got it, I'll remember that.");
        await s.turnDone();
        assert.deepStrictEqual(corrections(s, n0), [], "a true reply is not corrected");
        assert.ok(s.frames.some((f) => f.type === "output_transcript" && /remember that/.test(f.text)),
          "the caption reaches the phone");

        s.heard("what is my sister's name?");
        const a2 = await s.call("m2", "recall_memory", { query: "sister name" });
        assert.strictEqual(a2.response.ok, true);
        assert.ok(a2.response.data.facts.some((f) => /Priya/.test(f.fact)), JSON.stringify(a2.response.data));
        s.says("Your sister's name is Priya.");
        await s.turnDone();

        s.heard("forget my sister's details");
        const a3 = await s.call("m3", "forget_memory", { what: "sister Priya" });
        assert.strictEqual(a3.response.ok, false);
        assert.strictEqual(a3.response.needs_confirmation, true, "forgetting asks first");
        assert.match(a3.response.result, /Forget: sister Priya/);
        assert.ok((await validFacts()).includes("User's sister is named Priya"), "nothing forgotten yet");
        // The model may not approve for them by calling again at once.
        const a3b = await s.call("m3b", "forget_memory", { what: "sister Priya" });
        assert.strictEqual(a3b.response.needs_confirmation, true, "no yes was spoken in between");
        s.says("Shall I forget your sister's name?");
        await s.turnDone();

        s.heard("yes please");
        const a4 = await s.call("m4", "forget_memory", { what: "sister Priya" });
        assert.strictEqual(a4.response.ok, true, JSON.stringify(a4.response));
        assert.ok(!(await validFacts()).includes("User's sister is named Priya"), "forgotten");
        assert.ok((await validFacts()).includes("User is vegetarian"), "nothing else went with it");
        s.says("Done, I've forgotten it.");
        await s.turnDone();
      } finally {
        await s.close();
      }
      const block = await require("../src/agents/memory").memoryBlock(UID);
      assert.ok(!/Priya/.test(block), "the next session's memory block no longer has it");
      assert.match(block, /User is vegetarian/);
    });

    await atest("said out loud: a self-description becomes a memory and a promise becomes a commitment", async () => {
      AI.replies.push(
        { match: /durable personal facts/, reply: '[{"fact":"User works as a civil engineer","importance":2}]' },
        { match: /COMMITMENTS/, reply: JSON.stringify({ commitments: [{
          text: "Send Ravi the site report", owed_to: "Ravi", when: "tomorrow 5 pm",
          quote: "I'll send Ravi the site report by tomorrow 5 pm" }] }) },
      );
      const s = await openLive();
      try {
        s.heard("I'm a civil engineer, and I'll send Ravi the site report by tomorrow 5 pm");
        s.says("Nice, noted.");
        await s.turnDone();
        await until(async () => (await validFacts()).includes("User works as a civil engineer"), "the extracted fact");
        await until(async () => (await db.query(
          `SELECT 1 FROM commitments WHERE user_id=$1 AND text='Send Ravi the site report' AND status='open'`,
          [UID])).length === 1, "the commitment");
        const c = await db.one(`SELECT owed_to, due_at, source FROM commitments WHERE user_id=$1 AND text='Send Ravi the site report'`, [UID]);
        assert.strictEqual(c.owed_to, "Ravi");
        assert.strictEqual(c.source, "voice");
        assert.ok(Number(c.due_at) > Date.now(), "a deadline in the future");
      } finally {
        await s.close();
      }
    });

    /* ================================================================ */
    console.log("\nlive voice: the claim check");
    /* ================================================================ */

    await atest("saying 'opening YouTube' with no tool behind it is corrected in the model's ear", async () => {
      const s = await openLive();
      try {
        s.heard("open youtube");
        const n0 = s.notes().length;
        s.says("Opening YouTube for you now.");
        await s.turnDone();
        const c = corrections(s, n0);
        assert.strictEqual(c.length, 1, JSON.stringify(s.notes().slice(n0)));
        assert.match(c[0], /no such action ran/);
      } finally {
        await s.close();
      }
    });

    await atest("DEFECT: a birthday that WAS saved is not called a failure (remember_person_date's own words)", async () => {
      const s = await openLive();
      try {
        s.heard("Amma's birthday is on the 14th of March");
        const a = await s.call("pd1", "remember_person_date", { person: "Amma", date: "03-14", label: "birthday" });
        assert.strictEqual(a.response.ok, true, JSON.stringify(a.response));
        const row = await db.one(
          `SELECT pd.month, pd.day FROM person_dates pd JOIN clients c ON c.id=pd.person_id
            WHERE pd.user_id=$1 AND lower(c.name)='amma'`, [UID]);
        assert.deepStrictEqual([row.month, row.day], [3, 14], "the date is saved");
        const n0 = s.notes().length;
        // The model repeats the tool's own confirmation, word for word.
        s.says(a.response.speak);
        await s.turnDone();
        assert.deepStrictEqual(corrections(s, n0), [],
          `the tool's own line "${a.response.speak}" was answered with a CORRECTION ` +
          "(claimCheck 'remind' family has no remember_person_date, and the tool is neither a " +
          "world action nor a family tool, so it is never recorded as having run)");
      } finally {
        await s.close();
      }
    });

    await atest("DEFECT: an EMI that WAS saved is not called a failure ('I've saved your bike EMI')", async () => {
      const s = await openLive();
      try {
        s.heard("I have a bike EMI of 3500 at 11 percent, it comes on the 5th");
        const a = await s.call("fi1", "add_finance_item",
          { kind: "emi", name: "Bike EMI", amount: 3500, interest_rate: 11, due_day: 5 });
        assert.strictEqual(a.response.ok, true, JSON.stringify(a.response));
        const n0 = s.notes().length;
        s.says("I've saved your bike EMI of 3500 at 11 percent in your finance section.");
        await s.turnDone();
        const c = corrections(s, n0);
        assert.deepStrictEqual(c, [],
          "a true save was contradicted, and the correction tells the model to 'do it properly " +
          "now with the right tool' — i.e. add the EMI a second time");
      } finally {
        await s.close();
      }
    });

    /* ================================================================ */
    console.log("\nlive voice: finance, Momentum and plans reach the app's screens");
    /* ================================================================ */

    await atest("finance: a voice-added EMI and an app-added salary make one plan, highest interest first", async () => {
      // (The bike EMI above came in by voice.)
      await registry.execute("add_finance_item",
        { kind: "emi", name: "Gold loan", amount: 2000, interest_rate: 18, outstanding: 40000 }, { userId: UID });
      const add = await api("POST", "/finance", { kind: "income", name: "Salary", amount: 60000, due_day: 1 });
      assert.strictEqual(add.status, 200, JSON.stringify(add.body));
      const g = await api("GET", "/finance");
      assert.strictEqual(g.status, 200);
      const names = g.body.items.map((i) => i.name);
      for (const n of ["Bike EMI", "Gold loan", "Salary"]) assert.ok(names.includes(n), `${n} on the Finance screen`);
      assert.strictEqual(g.body.summary.monthly_income, 60000);
      assert.strictEqual(g.body.summary.monthly_emi, 5500);
      assert.strictEqual(g.body.summary.surplus, 54500);
      const plan = await registry.execute("get_finance_plan", {}, { userId: UID });
      const text = plan.data.result;
      assert.ok(text.indexOf("Gold loan") < text.indexOf("Bike EMI"), "18% is listed before 11%");
      assert.match(text, /surplus ₹54500\/mo/);
      assert.match(text, /total debt outstanding ₹40000/);
    });

    await atest("Momentum: today's three said by voice are on the Momentum screen", async () => {
      const s = await openLive();
      try {
        s.heard("my top three today are finish the report, call the bank and go for a walk");
        const a = await s.call("mo1", "plan_my_day",
          { priorities: ["Finish the report", "Call the bank", "Go for a walk"] });
        assert.strictEqual(a.response.ok, true, JSON.stringify(a.response));
        s.says(a.response.speak || "Done.");
        await s.turnDone();
      } finally {
        await s.close();
      }
      const m = await api("GET", "/momentum");
      assert.strictEqual(m.status, 200, JSON.stringify(m.body));
      const titles = (m.body.priorities || []).map((p) => p.title);
      assert.deepStrictEqual(titles, ["Finish the report", "Call the bank", "Go for a walk"], JSON.stringify(m.body).slice(0, 300));
    });

    await atest("start_task over live: planned without high-risk tools, run to completion, reported as it ran", async () => {
      AI.plans.push((opts) => {
        const sys = opts.system;
        assert.ok(!/- forget_memory\(/.test(sys), "no high-risk tool in a live plan's catalogue");
        assert.ok(!/- open_named_app\(/.test(sys), "no phone-side tool in a plan's catalogue");
        assert.match(sys, /- web_search\(/);
        return {
          steps: [
            { tool: "web_search", args_json: JSON.stringify({ query: "best filter coffee Indiranagar" }), why: "find places" },
            { tool: "remember_fact", args_json: JSON.stringify({ fact: "User's favourite cafe in Indiranagar is Third Wave" }),
              why: "keep the pick", dependsOn: [0] },
          ],
        };
      });
      const s = await openLive();
      try {
        s.heard("find the best filter coffee in Indiranagar and remember it as my favourite cafe");
        const a = await s.call("st1", "start_task", { goal: "Find the best filter coffee in Indiranagar and remember it as my favourite cafe" });
        assert.strictEqual(a.response.ok, true, JSON.stringify(a.response));
        assert.match(a.response.speak, /Done — all 2 steps finished/);
        assert.strictEqual(a.response.data.status, "done");
        const row = await db.one(`SELECT status, steps FROM agent_tasks WHERE id=$1`, [a.response.data.task_id]);
        assert.strictEqual(row.status, "done");
        assert.ok((await validFacts()).includes("User's favourite cafe in Indiranagar is Third Wave"));
        const n0 = s.notes().length;
        s.says("Done — I found it and I've saved Third Wave as your favourite.");
        await s.turnDone();
        assert.deepStrictEqual(corrections(s, n0), [], "steps that ran back the reply");
      } finally {
        await s.close();
      }
    });

    /* ================================================================ */
    console.log("\nlive voice: typed words, silence, farewell, a dropped session");
    /* ================================================================ */

    await atest("typed words go to the model as the owner's turn; the app's own notes stay notes", async () => {
      const s = await openLive();
      try {
        const n0 = s.notes().length;
        s.fromApp({ type: "text", text: "what's on my plate today?" });
        await until(() => s.notes().length > n0, "the typed turn upstream");
        assert.strictEqual(s.notes()[n0], "what's on my plate today?");
        const turn = s.up.msgs.filter((m) => m.clientContent).slice(-1)[0];
        assert.strictEqual(turn.clientContent.turnComplete, true);
        const greeting = 'Say this greeting to me now, in my language: "Good morning Sir!"';
        s.fromApp({ type: "text", text: greeting });
        await until(() => s.notes().length > n0 + 1, "the greeting upstream");
        assert.strictEqual(s.notes()[n0 + 1], greeting);
      } finally {
        await s.close();
      }
    });

    await atest("voice both ways: mic PCM goes up as 16 kHz audio, her PCM comes down as binary, a barge-in stops it", async () => {
      const s = await openLive();
      try {
        const mic = Buffer.alloc(640, 7);
        s.ws.send(mic, { binary: true });
        await until(() => s.up.msgs.some((m) => m.realtimeInput && m.realtimeInput.audio), "mic audio upstream");
        const a = s.up.msgs.find((m) => m.realtimeInput && m.realtimeInput.audio).realtimeInput.audio;
        assert.strictEqual(a.mimeType, "audio/pcm;rate=16000");
        assert.ok(Buffer.from(a.data, "base64").equals(mic), "the same bytes");
        s.fromApp({ type: "audio_pause" });
        await until(() => s.up.msgs.some((m) => m.realtimeInput && m.realtimeInput.audioStreamEnd), "audioStreamEnd");
        const reply = Buffer.alloc(960, 3);
        s.up.send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: reply.toString("base64") } }] } } });
        await until(() => s.frames.some((f) => f.type === "__audio" && f.bytes === 960), "her audio on the phone");
        s.up.send({ serverContent: { interrupted: true } });
        await until(() => s.frames.some((f) => f.type === "interrupted"), "interrupted on the phone");
      } finally {
        await s.close();
      }
    });

    await atest("web research over live: web_search answers the model with the provider's results", async () => {
      const s = await openLive();
      try {
        s.heard("what's the petrol price in Bengaluru today");
        const a = await s.call("ws1", "web_search", { query: "petrol price Bengaluru today" });
        assert.strictEqual(a.response.ok, true, JSON.stringify(a.response));
        assert.ok(JSON.stringify(a.response).includes("Result for petrol price Bengaluru today"),
          JSON.stringify(a.response).slice(0, 300));
        assert.ok(s.frames.some((f) => f.type === "tool_started" && f.tool === "web_search"),
          "the phone can show 'Searching…'");
      } finally {
        await s.close();
      }
    });

    await atest("what's pending: promises heard earlier and today's list come back when asked", async () => {
      const s = await openLive();
      try {
        s.heard("what did I promise people?");
        const c = await s.call("lp1", "list_my_commitments", {});
        assert.strictEqual(c.response.ok, true);
        assert.match(c.response.speak, /Send Ravi the site report to Ravi — due/, c.response.speak);
        s.heard("how am I doing today?");
        const m = await s.call("ms1", "momentum_status", {});
        assert.strictEqual(m.response.ok, true);
        assert.deepStrictEqual(m.response.data.today.left, ["Finish the report", "Call the bank", "Go for a walk"]);
      } finally {
        await s.close();
      }
    });

    await atest("stay_silent drops the rest of the turn; end_conversation reaches the phone", async () => {
      const s = await openLive();
      try {
        s.heard("haan, main kal aa jaunga, tum chinta mat karo");
        const a = await s.call("ss1", "stay_silent", {});
        assert.match(a.response.result, /Stay silent/);
        const before = s.frames.filter((f) => f.type === "output_transcript").length;
        s.says("Okay.");
        await s.turnDone();
        assert.strictEqual(s.frames.filter((f) => f.type === "output_transcript").length, before,
          "nothing of a silent turn is captioned");
        s.heard("okay bye");
        await s.call("ec1", "end_conversation", {});
        await until(() => s.frames.some((f) => f.type === "end_conversation"), "end_conversation on the phone");
      } finally {
        await s.close();
      }
    });

    await atest("a typed request is never silenced by stay_silent (a video playing near the phone)", async () => {
      const s = await openLive();
      try {
        s.fromApp({ type: "text", text: "make a one page PDF with tips to save electricity", typed: true });
        const a = await s.call("ts1", "stay_silent", {});
        assert.strictEqual(a.response.ok, false);
        assert.match(a.response.result, /TYPED/);
        const before = s.frames.filter((f) => f.type === "output_transcript").length;
        s.says("Sure, making that PDF now.");
        await s.turnDone();
        assert.ok(s.frames.filter((f) => f.type === "output_transcript").length > before,
          "the answer to the typed request is captioned");
        // Answered: room speech after it may be silenced again.
        s.heard("that's why you're next year");
        const b = await s.call("ts2", "stay_silent", {});
        assert.match(b.response.result, /Stay silent/);
      } finally {
        await s.close();
      }
    });

    await atest("Google ends the session: the phone's socket closes (so the app reconnects) and the new session remembers", async () => {
      const s = await openLive();
      s.heard("book me a table at Truffles for Friday night");
      s.says("Friday night at Truffles — how many people?");
      await s.turnDone();
      await until(async () => (await db.query(
        `SELECT 1 FROM conversation_turns WHERE user_id=$1 AND text ILIKE '%Truffles%'`, [UID])).length >= 2,
      "both halves written");
      s.up.ws.close(1000, "session limit");
      await until(() => s.closedCode() !== null, "the phone's socket to close");
      const s2 = await openLive();
      try {
        const sys = s2.setup.systemInstruction.parts[0].text;
        assert.ok(sys.includes("User said: book me a table at Truffles for Friday night"), "the question");
        assert.ok(sys.includes("You said: Friday night at Truffles — how many people?"), "the answer");
      } finally {
        await s2.close();
      }
    });

    /* ================================================================ */
    console.log("\ntyped / classic loop (POST /assistant, SSE, real runtime)");
    /* ================================================================ */

    await atest("a typed 'remember…' runs the real tool and the model is handed memory, history and the clock", async () => {
      let system = "";
      AI.stream.push(
        (opts) => {
          system = opts.system;
          return { functionCalls: [{ name: "remember_fact", args: { fact: "User is allergic to peanuts" } }] };
        },
        { text: "Got it — I'll remember that you're allergic to peanuts." },
      );
      const c = await classicSession();
      try {
        const r = await c.say("remember that I'm allergic to peanuts");
        assert.strictEqual(r.status, 202);
        await until(() => c.last("assistant_message"), "the reply");
        assert.strictEqual(c.last("assistant_message").text, "Got it — I'll remember that you're allergic to peanuts.");
        assert.ok(c.events.some((e) => e.type === "tool_started" && e.tool === "remember_fact"));
        assert.ok(c.events.some((e) => e.type === "tool_completed" && e.tool === "remember_fact" && e.ok === true));
        assert.ok((await validFacts()).includes("User is allergic to peanuts"));
        assert.match(system, /name: Dhanush K/);
        assert.match(system, /WHAT YOU REMEMBER ABOUT THIS USER[\s\S]*User is vegetarian/);
        assert.match(system, /EARLIER CONVERSATION[\s\S]*Truffles/, "turns from the live sessions");
        assert.match(system, /Current date and time for the user: .* \(UTC\+05:30\)/);
      } finally {
        c.stop();
      }
    });

    await atest("DEFECT: typed 'Appa's birthday…' — the saved date is not replaced with 'That reminder wasn't saved'", async () => {
      AI.stream.push(
        { functionCalls: [{ name: "remember_person_date", args: { person: "Appa", date: "07-21", label: "birthday" } }] },
        { text: "Saved — I'll remind you the day before Appa's birthday." },
      );
      const c = await classicSession();
      try {
        await c.say("Appa's birthday is on 21st July");
        await until(() => c.last("assistant_message"), "the reply");
        const said = c.last("assistant_message").text;
        const row = await db.one(
          `SELECT pd.month, pd.day FROM person_dates pd JOIN clients cl ON cl.id=pd.person_id
            WHERE pd.user_id=$1 AND lower(cl.name)='appa'`, [UID]);
        assert.deepStrictEqual([row.month, row.day], [7, 21], "the date IS saved");
        assert.ok(!/wasn't saved/.test(said), `the user was told: "${said}"`);
      } finally {
        c.stop();
      }
    });

    await atest("typed 'forget…' raises the confirmation card; approving it forgets exactly that", async () => {
      AI.stream.push({ functionCalls: [{ name: "forget_memory", args: { what: "allergic to peanuts" } }] });
      const c = await classicSession();
      try {
        await c.say("forget that I'm allergic to peanuts");
        await until(() => c.last("confirmation_request"), "the card");
        assert.match(c.last("confirmation_request").question, /Forget: allergic to peanuts/);
        assert.ok((await validFacts()).includes("User is allergic to peanuts"), "not before the tap");
        const r = await c.confirm(true);
        assert.strictEqual(r.status, 200);
        await until(() => c.last("assistant_message"), "the result");
        assert.strictEqual(c.last("assistant_message").text, "Forgotten.");
        assert.ok(!(await validFacts()).includes("User is allergic to peanuts"));
        assert.ok((await validFacts()).includes("User is vegetarian"));
      } finally {
        c.stop();
      }
    });

    await atest("typed multi-step request: start_task plans, runs every step, and the reply follows", async () => {
      AI.stream.push(
        { functionCalls: [{ name: "start_task", args: { goal: "Research monsoon trekking in Coorg and remember the best month" } }] },
        { text: "Done — both steps finished; I noted that July is best." },
      );
      AI.plans.push({
        steps: [
          { tool: "web_search", args_json: JSON.stringify({ query: "Coorg monsoon trekking best month" }), why: "research" },
          { tool: "remember_fact", args_json: JSON.stringify({ fact: "User plans a Coorg monsoon trek in July" }),
            why: "keep it", dependsOn: [0] },
        ],
      });
      const c = await classicSession();
      try {
        await c.say("research monsoon trekking in Coorg and remember the best month");
        await until(() => c.last("assistant_message"), "the reply", 10000);
        assert.ok(c.events.some((e) => e.type === "tool_completed" && e.tool === "start_task" && e.ok === true),
          JSON.stringify(c.events.filter((e) => /tool/.test(e.type))));
        const t = await db.one(
          `SELECT status FROM agent_tasks WHERE user_id=$1 AND goal LIKE 'Research monsoon trekking%' ORDER BY id DESC LIMIT 1`, [UID]);
        assert.strictEqual(t.status, "done");
        assert.ok((await validFacts()).includes("User plans a Coorg monsoon trek in July"));
      } finally {
        c.stop();
      }
    });

    /* ================================================================ */
    console.log("\nmemory and plans, tool level");
    /* ================================================================ */

    await atest("DEFECT: 'forget my sister's name' forgets only that — not the user's own name, not every fact containing 'the'", async () => {
      await registry.execute("remember_fact", { fact: "User's name is Dhanush" }, { userId: UID });
      await registry.execute("remember_fact", { fact: "User's sister's name is Kavya" }, { userId: UID });
      await registry.execute("remember_fact", { fact: "User's mother lives in Mysuru" }, { userId: UID });
      const problems = [];
      const r = await registry.execute("forget_memory", { what: "sister's name" }, { userId: UID, approved: true });
      assert.strictEqual(r.ok, true);
      const left = await validFacts();
      assert.ok(!left.includes("User's sister's name is Kavya"), "the sister's name is gone");
      if (r.data.forgotten !== 1) {
        problems.push(`{what:"sister's name"} forgot ${r.data.forgotten} facts, also: ` +
          JSON.stringify(["User's name is Dhanush"].filter((f) => !left.includes(f))));
      }
      // Nothing about a gym was ever stored.
      const r2 = await registry.execute("forget_memory", { what: "the gym timing" }, { userId: UID, approved: true });
      const left2 = await validFacts();
      if (r2.ok) {
        problems.push(`{what:"the gym timing"} forgot ${r2.data.forgotten} fact(s): ` +
          JSON.stringify(left.filter((f) => !left2.includes(f))));
      }
      assert.deepStrictEqual(problems, [],
        "forget_memory matches ANY word of 3+ letters as a substring (memory/service.js forget: " +
        "'name' hits every '…name is…' fact, 'the' hits 'mother'/'father'/'weather')");
    });

    await atest("DEFECT: a plan cut short by the turn's time budget is finished later, not abandoned as 'still working'", async () => {
      const prev = searchImpl;
      searchImpl = async (q) => { await sleep(120); return { ok: true, data: [{ title: q, url: "https://example.test/x", snippet: q }] }; };
      AI.plans.push({
        steps: [
          { tool: "web_search", args_json: JSON.stringify({ query: "Hampi weather October" }), why: "weather" },
          { tool: "web_search", args_json: JSON.stringify({ query: "Hampi homestays" }), why: "stays" },
          { tool: "web_search", args_json: JSON.stringify({ query: "Bangalore to Hampi train" }), why: "travel" },
        ],
      });
      try {
        const r = await registry.execute("start_task", { goal: "Plan a Hampi weekend: weather, stays and trains" },
          { userId: UID, source: "voice", sessionId: "g1-budget", turnId: "b1", taskBudgetMs: 150 });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.match(r.speak, /still working on the rest/, "the user is told the work continues");
        const id = r.data.task_id;
        // Give anything that resumes open plans a fair chance to act.
        const end = Date.now() + 2500;
        let row;
        while (Date.now() < end) {
          row = await db.one(`SELECT status, steps FROM agent_tasks WHERE id=$1`, [id]);
          if (row.status === "done") break;
          await sleep(100);
        }
        const queued = await db.query(
          `SELECT id FROM jobs WHERE user_id=$1 AND status='pending' AND payload::text LIKE $2`, [UID, `%${id}%`]);
        const steps = typeof row.steps === "string" ? JSON.parse(row.steps) : row.steps;
        assert.ok(row.status === "done" || queued.length > 0,
          `task ${id} is left '${row.status}' with ${steps.filter((x) => x.status === "pending").length} ` +
          "pending step(s) and nothing queued to resume it (only start_task, approve and ack call " +
          "taskDriver.runWithin; no job, sweep or app screen continues a RUNNING plan)");
      } finally {
        searchImpl = prev;
      }
    });

    /* ================================================================ */
    console.log("\nbackground work: schedule_task, the widget, deep research");
    /* ================================================================ */

    await atest("schedule_task (daily) queues a job; at its time the real runtime runs it, the outcome is pushed and tomorrow is queued", async () => {
      const when = isoLocal(Date.now() + 10 * 60_000, 330);
      const r = await registry.execute("schedule_task",
        { task: "Tell me the weather in Mysuru", when, repeat: "daily" },
        { userId: UID, tzOffsetMin: 330, source: "live", sessionId: "g1-sched", turnId: "s1" });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.match(r.speak, /Scheduled daily/);
      const job = await db.one(`SELECT * FROM jobs WHERE id=$1`, [r.data.id]);
      assert.strictEqual(job.kind, "scheduled_task");
      assert.strictEqual(job.status, "pending");
      assert.strictEqual(job.payload.repeat, "daily");
      assert.strictEqual(job.payload.tzOffsetMin, 330);
      assert.ok(Math.abs(Number(job.run_after) - (Date.now() + 10 * 60_000)) < 90_000, "due in ten minutes");
      const listed = await registry.execute("list_scheduled_tasks", {}, { userId: UID });
      assert.ok(listed.data.some((t) => t.id === Number(job.id) && t.repeat === "daily"));

      // Its time comes.
      await db.run(`UPDATE jobs SET run_after=$2 WHERE id=$1`, [job.id, Date.now() - 1000]);
      const due = await db.one(`SELECT * FROM jobs WHERE id=$1`, [job.id]);
      let seen = null;
      AI.stream.push((opts) => { seen = opts; return { text: "Mysuru today: 29°C and partly cloudy." }; });
      const before = mine().length;
      await jobs.HANDLERS.get("scheduled_task")(due.payload, due);
      await db.run(`UPDATE jobs SET status='done' WHERE id=$1`, [job.id]); // what the queue does next
      assert.match(seen.contents.slice(-1)[0].parts[0].text, /\[SCHEDULED TASK\][\s\S]*Tell me the weather in Mysuru/);
      const offered = seen.declarations.map((d) => d.name);
      assert.ok(!offered.includes("open_named_app"), "nothing that needs the phone in hand");
      assert.ok(offered.includes("web_search"));
      const p = mine().slice(before);
      assert.strictEqual(p.length, 1, JSON.stringify(p));
      assert.match(p[0].title, /^Done: Tell me the weather in Mysuru/);
      assert.match(p[0].body, /29°C/);
      assert.strictEqual(p[0].data.kind, "scheduled_task");
      const after = await db.one(`SELECT last_error FROM jobs WHERE id=$1`, [job.id]);
      assert.match(after.last_error, /^OK: Mysuru today/);
      const next = await db.query(
        `SELECT run_after FROM jobs WHERE user_id=$1 AND kind='scheduled_task' AND status='pending'
           AND payload->>'task'='Tell me the weather in Mysuru'`, [UID]);
      assert.strictEqual(next.length, 1, "tomorrow's run is queued");
      assert.ok(Math.abs(Number(next[0].run_after) - (Number(due.run_after) + 86_400_000)) < 120_000);
    });

    await atest("the home-screen widget: POST /tasks/quick answers 202, runs in the background and pushes the result", async () => {
      assert.strictEqual((await api("POST", "/tasks/quick", {})).status, 400);
      const noAuth = await fetch(BASE + "/tasks/quick", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.strictEqual(noAuth.status, 401);
      const r = await api("POST", "/tasks/quick", { task: "Find out when the Mysuru Dasara procession starts this year" });
      assert.strictEqual(r.status, 202, JSON.stringify(r.body));
      assert.strictEqual(r.body.queued, true);
      const job = await db.one(`SELECT * FROM jobs WHERE id=$1`, [r.body.id]);
      assert.strictEqual(job.kind, "scheduled_task");
      assert.strictEqual(job.payload.source, "widget");
      assert.strictEqual(job.payload.tzOffsetMin, 330);
      AI.stream.push({ text: "The Jamboo Savari starts at 2:30 pm on Vijayadashami." });
      const before = mine().length;
      await jobs.HANDLERS.get("scheduled_task")(job.payload, job);
      await db.run(`UPDATE jobs SET status='done' WHERE id=$1`, [job.id]);
      const p = mine().slice(before);
      assert.strictEqual(p.length, 1);
      assert.match(p[0].title, /^Done: Find out when the Mysuru Dasara/);
      assert.match(p[0].body, /Jamboo Savari/);
    });

    await atest("deep research: the tool queues it; the job searches several angles, files a sourced brief and pushes 'ready'", async () => {
      const r = await registry.execute("deep_research",
        { question: "Is an electric scooter worth it for a 20 km daily commute in Bengaluru?" }, { userId: UID });
      assert.strictEqual(r.ok, true);
      assert.match(r.note, /STARTED, not finished/);
      const job = await db.one(
        `SELECT * FROM jobs WHERE user_id=$1 AND kind='deep_research' ORDER BY id DESC LIMIT 1`, [UID]);
      const asked = [];
      const prev = searchImpl;
      searchImpl = async (q) => { asked.push(q); return { ok: true, data: [{ title: `On ${q}`, url: `https://example.test/${asked.length}`, snippet: `Findings about ${q}.` }] }; };
      AI.replies.push(
        { match: /You plan web research/, reply: '{"queries":["e-scooter running cost per km India","e-scooter battery life Bengaluru traffic","petrol scooter vs electric total cost"]}' },
        { match: /sourced research briefs/, reply:
          "Yes for most riders [1][3]. Running costs are far lower per km [1], and batteries last several years in city use [2].\n\nSources\n[1] https://example.test/1\n[2] https://example.test/2\n[3] https://example.test/3" },
      );
      const before = mine().length;
      try {
        await jobs.HANDLERS.get("deep_research")(job.payload, job);
      } finally {
        searchImpl = prev;
      }
      await db.run(`UPDATE jobs SET status='done' WHERE id=$1`, [job.id]);
      assert.strictEqual(asked.length, 3, "three angles searched");
      const doc = await db.one(
        `SELECT id, title, path, tags FROM documents WHERE user_id=$1 AND title LIKE 'Research:%' ORDER BY id DESC LIMIT 1`, [UID]);
      assert.ok(doc, "the brief is in their documents");
      assert.strictEqual(doc.tags, "research");
      assert.ok(doc.path.startsWith(DATA_DIR) && fs.existsSync(doc.path), "the file is on disk");
      assert.match(fs.readFileSync(doc.path, "utf8"), /\[1\]/, "the brief is cited");
      const p = mine().slice(before);
      assert.strictEqual(p.length, 1);
      assert.strictEqual(p[0].title, "Your research is ready");
    });

    /* ================================================================ */
    console.log("\nproactive: the sweep that runs every ten minutes");
    /* ================================================================ */

    await atest("at 9:30 their time: a morning brief, tomorrow's birthday and a promise coming due — each once", async () => {
      // An offset that puts the user at 09:30 right now.
      const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
      let tz = 9 * 60 + 30 - nowMin;
      while (tz > 840) tz -= 1440;
      while (tz < -720) tz += 1440;
      await db.run(`UPDATE users SET tz_offset_min=$2 WHERE id=$1`, [UID, tz]);
      const tomorrow = new Date(Date.now() + tz * 60_000 + 86_400_000);
      const mmdd = `${String(tomorrow.getUTCMonth() + 1).padStart(2, "0")}-${String(tomorrow.getUTCDate()).padStart(2, "0")}`;
      const pd = await registry.execute("remember_person_date", { person: "Chetan", date: mmdd, label: "birthday" }, { userId: UID });
      assert.strictEqual(pd.ok, true, JSON.stringify(pd));
      AI.replies.push({ match: /COMMITMENTS/, reply: JSON.stringify({ commitments: [{
        text: "Send the GST papers to the auditor", owed_to: "", when: "in 2 hours",
        quote: "I'll send the GST papers to the auditor in 2 hours" }] }) });
      const saved = await require("../src/commitments/service").extract(UID,
        "I'll send the GST papers to the auditor in 2 hours", { source: "voice", tzOffsetMin: tz });
      assert.strictEqual(saved.length, 1);

      const scheduler = require("../src/proactive/scheduler");
      const before = mine().length;
      await scheduler.sweep();
      const got = mine().slice(before);
      const titles = got.map((p) => p.title);
      assert.ok(titles.some((t) => /^Good morning, Dhanush/.test(t)), JSON.stringify(titles));
      const morning = got.find((p) => p.data.kind === "morning_brief");
      assert.ok(morning.body && morning.body.length > 5, "the brief says something");
      assert.match(morning.body, /You owe: Send the GST papers/, morning.body);
      const bday = got.find((p) => p.data.kind === "person_date");
      assert.ok(bday, JSON.stringify(titles));
      assert.match(bday.title, /Tomorrow: Chetan's birthday/);
      const nudge = got.find((p) => p.data.kind === "commitment");
      assert.ok(nudge, JSON.stringify(titles));
      assert.strictEqual(nudge.title, "Due soon");
      assert.match(nudge.body, /send the GST papers to the auditor/);

      const n = mine().length;
      await scheduler.sweep();
      const again = mine().slice(n).filter((p) => ["morning_brief", "person_date", "commitment"].includes(p.data.kind));
      assert.deepStrictEqual(again, [], "never twice for the same thing");
      await db.run(`UPDATE users SET tz_offset_min=330 WHERE id=$1`, [UID]);
    });

    await atest("nothing tried to reach the internet", () => {
      // Blocked calls are fine (weather, headlines and embeddings degrade
      // by design); a call to Google's model endpoints would mean a stub
      // was bypassed.
      const model = BLOCKED.filter((u) => /:(generateContent|streamGenerateContent)|BidiGenerateContent/.test(u));
      assert.deepStrictEqual(model, [], "a model call escaped the stub");
    });
  } finally {
    /* ---------------- clean up everything this run made ---------------- */
    try {
      await require("../src/routes/privacy").deleteUserEverywhere(UID, { reason: "g1-e2e cleanup" });
    } catch (e) {
      console.error("cleanup (account delete) failed:", e.message);
    }
    await db.run(`DELETE FROM jobs WHERE user_id=$1`, [UID]).catch(() => {});
    await db.run(`DELETE FROM kv WHERE k LIKE $1 OR k LIKE $2 OR k LIKE $3`,
      [`morning:${UID}:%`, `pdate:${UID}:%`, `brief:${UID}:%`]).catch(() => {});
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
    for (const c of GOOGLE.conns) { try { c.ws.terminate(); } catch (_) {} }
    await new Promise((r) => googleWss.close(r));
    await new Promise((r) => server.close(r));
    global.fetch = realFetch;
  }

  console.log(`\n${passed} passed, ${failed} failed${failed ? `:\n  - ${failures.join("\n  - ")}` : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error("e2e-g1 crashed:", e);
  process.exit(1);
});
