/**
 * CONNECTED APPS / THE MY ASSISTANT API — `npm run test:platform`.
 *
 * Boots the REAL server (real auth, routes, registry, Postgres) with every
 * outbound call answered locally and the model scripted, and pins:
 *   (a) connecting an app from the main app: the key is shown once, only
 *       its hash is kept, an appfn key cannot manage apps;
 *   (b) the key gate: missing / malformed / revoked keys, a paused app, a
 *       paused account; scopes read on every request;
 *   (c) records and activity: validation, upsert, another app's data is
 *       never visible;
 *   (d) the assistant: app tools come back as requires_action and resume
 *       with tool_results; assistant tools run; tools no app may use are
 *       refused; the turn lands in the user's conversation memory as
 *       app:<slug>; the daily limit;
 *   (e) the main assistant answers from the apps (connected_apps) and is
 *       offered the tool only on turns about them;
 *   (f) voice: the session carries the app's and the assistant's tools,
 *       the tool relay, the transcript;
 *   (g) notifications, the docs page, removing an app removes its data.
 */
"use strict";

process.env.NODE_ENV = process.env.NODE_ENV || "test";
if (process.env.NODE_ENV === "production") {
  console.error("platform-test must never run against production");
  process.exit(2);
}
process.env.DATABASE_URL = process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@127.0.0.1:56432/myassistant";

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "platform-"));
process.env.DATA_DIR = path.join(TMP, "data");
process.env.MEDIA_DIR = path.join(TMP, "media");
process.env.MEDIA_BACKEND = "local";
process.env.LIVE_RECORD_DIR = path.join(TMP, "recordings");
process.env.LIVE_RECORD = "0";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "platform-" + crypto.randomBytes(16).toString("hex");
process.env.PUBLIC_BASE_URL = "https://api.example.test";
process.env.PLATFORM_RATE_PER_MIN = "100000";
for (const k of [
  "OPENAI_API_KEY", "GEMINI_MODEL", "GEMINI_LIVE_MODEL", "GEMINI_TTS_MODEL",
  "AUTH_DISABLED", "ALLOW_APP_KEY", "APP_API_KEY", "METRICS_TOKEN", "PLIVO_AUTH_TOKEN", "PLIVO_AUTH_ID",
  "BOLNA_API_KEY", "TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY", "GOOGLE_CSE_KEY", "HEYGEN_API_KEY",
  "AI_APPROVAL_SECRET", "SHORTCUTS",
]) delete process.env[k];
const BACKEND = path.resolve(__dirname, "..");
process.chdir(TMP); // no .env here

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url && url.url ? url.url : url);
  if (/^http:\/\/127\.0\.0\.1:\d+\//.test(u)) return realFetch(url, opts);
  return new Response(JSON.stringify({ error: "offline in platform-test" }),
    { status: 503, headers: { "content-type": "application/json" } });
};
const push = require(path.join(BACKEND, "src/services/push"));
const pushed = [];
push.send = async (token, title, body, data) => { pushed.push({ token, title, body, data }); return { ok: true, stub: true }; };
push.sendNotification = async () => true;

// THE MODEL, SCRIPTED: each call takes the next step from `script`; a step
// is a function of the request (so it can read the tool results) or a
// fixed answer. Every request is kept for the assertions.
const router = require(path.join(BACKEND, "src/services/ai/router"));
let script = [];
const modelCalls = [];
router.generateWithTools = async (req) => {
  modelCalls.push(req);
  const step = script.shift();
  if (!step) return { text: "(no script)", functionCalls: [] };
  const out = typeof step === "function" ? step(req) : step;
  return { text: out.text || "", functionCalls: out.calls || [] };
};
router.generateWithToolsStream = router.generateWithTools;
const openai = require(path.join(BACKEND, "src/services/ai/openai"));
let realtimeReq = null;
openai.realtimeClientSecret = async (o) => { realtimeReq = o; return { value: "ek_test_secret", expiresAt: 1760440000, model: "gpt-realtime" }; };

const assert = require("assert");
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
async function api(method, p, { token, key, body, headers = {} } = {}) {
  const h = { "X-Forwarded-For": `198.51.100.${(ip++ % 250) + 1}`, ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (key) h.Authorization = `Bearer ${key}`;
  if (body !== undefined) h["content-type"] = "application/json";
  const r = await realFetch(BASE + p, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text, headers: r.headers };
}
const ok = (r, status = 200) => assert.strictEqual(r.status, status, `${r.status} ${r.text}`);
const code = (r, status, c) => {
  assert.strictEqual(r.status, status, `${r.status} ${r.text}`);
  assert.strictEqual(r.json && r.json.error && r.json.error.code, c, r.text);
};

const CHESS_TOOLS = [{
  name: "make_move",
  description: "Play your move on the board in UCI notation.",
  parameters: { type: "object", properties: { move: { type: "string" } }, required: ["move"] },
}];

(async () => {
  process.env.PORT = String(await freePort());
  BASE = `http://127.0.0.1:${process.env.PORT}`;
  require(path.join(BACKEND, "src/server"));
  await waitFor(async () => {
    try { return (await api("GET", "/health")).status === 200; } catch (_) { return false; }
  }, 30_000);

  const registry = require(path.join(BACKEND, "src/tools/registry"));
  const platform = require(path.join(BACKEND, "src/platform"));
  const pstore = require(path.join(BACKEND, "src/platform/store"));
  const SECRET = process.env.JWT_SECRET;
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const made = [];
  async function mkUser(tag) {
    const u = await db.createUser({ email: `platform-${tag}-${stamp}@example.test`, name: `Asha ${tag}` });
    made.push(u.id);
    return { id: u.id, session: jwt.sign({ uid: u.id }, SECRET, { expiresIn: "1h" }) };
  }
  const A = await mkUser("a");
  const B = await mkUser("b");

  try {
    /* ------------------------------------------------ (a) connecting */

    await atest("scopes catalogue and docs link for the main app", async () => {
      const r = await api("GET", "/platform/scopes", { token: A.session });
      ok(r);
      assert.ok(r.json.scopes.find((s) => s.id === "assistant"));
      assert.strictEqual(r.json.docsUrl, "https://api.example.test/developers");
      assert.strictEqual(r.json.apiBase, "https://api.example.test/v1");
    });

    await atest("connecting an app returns its key once; only a hash is stored", async () => {
      const r = await api("POST", "/platform/apps", { token: A.session, body: {
        name: "Chess Arena", description: "A chess board where I play my assistant", keywords: "chess, game, match",
        instructions: "Be a friendly opponent.",
      } });
      ok(r, 201);
      assert.match(r.json.key, /^mya_[A-Za-z0-9]{40}$/);
      assert.strictEqual(r.json.app.slug, "chess-arena");
      assert.deepStrictEqual(r.json.app.keywords, ["chess", "game", "match"]);
      assert.ok(r.json.app.scopes.includes("assistant") && !r.json.app.scopes.includes("memory:write"), "default scopes");
      A.app = r.json.app;
      A.key = r.json.key;
      const row = await db.one(`SELECT prefix, hash FROM platform_keys WHERE app_id=$1`, [A.app.id]);
      assert.strictEqual(row.prefix, A.key.slice(0, 12));
      assert.notStrictEqual(row.hash, A.key);
      assert.strictEqual(row.hash, crypto.createHash("sha256").update(A.key).digest("hex"));
      const list = await api("GET", "/platform/apps", { token: A.session });
      ok(list);
      assert.ok(!list.text.includes(A.key), "the key is never listed again");
      assert.strictEqual(list.json.apps.length, 1);
    });

    await atest("a second app of the same name gets its own slug; B sees none of A's", async () => {
      const r = await api("POST", "/platform/apps", { token: A.session, body: { name: "Chess Arena", scopes: ["data"] } });
      ok(r, 201);
      assert.strictEqual(r.json.app.slug, "chess-arena-2");
      assert.deepStrictEqual(r.json.app.scopes, ["data"]);
      A.app2 = r.json.app;
      A.key2 = r.json.key;
      const b = await api("GET", "/platform/apps", { token: B.session });
      ok(b);
      assert.strictEqual(b.json.apps.length, 0);
      ok(await api("GET", `/platform/apps/${A.app.id}`, { token: B.session }), 404);
    });

    await atest("an assistant-functions key or an app key cannot manage apps", async () => {
      const appfn = await api("POST", "/appfunctions/token", { token: A.session });
      ok(appfn);
      const r = await api("GET", "/platform/apps", { token: appfn.json.token });
      assert.ok([401, 403].includes(r.status), r.text);
      const k = await api("GET", "/platform/apps", { key: A.key });
      assert.strictEqual(k.status, 401, k.text);
    });

    /* ------------------------------------------------ (b) the gate */

    await atest("no key, a malformed key and an unknown key are refused", async () => {
      code(await api("GET", "/v1/me"), 401, "missing_key");
      code(await api("GET", "/v1/me", { key: "mya_short" }), 401, "invalid_key");
      code(await api("GET", "/v1/me", { key: "mya_" + "x".repeat(40) }), 401, "invalid_key");
    });

    await atest("GET /v1/me: the app, its scopes, the user and the assistant", async () => {
      const r = await api("GET", "/v1/me", { key: A.key });
      ok(r);
      assert.strictEqual(r.json.app.name, "Chess Arena");
      assert.strictEqual(r.json.user.name, "Asha a");
      assert.ok(r.json.assistant.name);
      const x = await api("GET", "/v1/me", { headers: { "X-Api-Key": A.key } });
      ok(x);
    });

    await atest("scopes are read on every request: unticked → 403, ticked → works at once", async () => {
      code(await api("POST", "/v1/memory", { key: A.key, body: { fact: "Prefers playing chess as black" } }), 403, "missing_scope");
      const p = await api("PATCH", `/platform/apps/${A.app.id}`, { token: A.session, body: { scopes: [...A.app.scopes, "memory:write", "tools"] } });
      ok(p);
      ok(await api("POST", "/v1/memory", { key: A.key, body: { fact: "Prefers playing chess as black" } }));
      const m = await api("GET", "/v1/memory?q=chess", { key: A.key });
      ok(m);
      assert.ok(m.json.memories.some((x) => /black/.test(x.fact)), m.text);
      code(await api("GET", "/v1/memory", { key: A.key2 }), 403, "missing_scope");
    });

    /* ------------------------------------------------ (c) records, activity */

    await atest("records: upsert, read, list, collections, validation", async () => {
      const put = await api("PUT", "/v1/records/matches/m1", { key: A.key, body: {
        summary: "Beat the assistant in 34 moves with the Sicilian", data: { result: "win", moves: 34 } } });
      ok(put, 201);
      const again = await api("PUT", "/v1/records/matches/m1", { key: A.key, body: { summary: "Beat it in 34", data: { result: "win", moves: 34, rated: true } } });
      ok(again, 200);
      assert.strictEqual(again.json.record.data.rated, true);
      const post = await api("POST", "/v1/records/matches", { key: A.key, body: { data: { result: "loss" }, summary: "Lost a blitz game" } });
      ok(post, 201);
      assert.match(post.json.record.id, /^r_[a-f0-9]{16}$/);
      const one = await api("GET", "/v1/records/matches/m1", { key: A.key });
      ok(one);
      assert.strictEqual(one.json.record.summary, "Beat it in 34");
      const list = await api("GET", "/v1/records/matches", { key: A.key });
      ok(list);
      assert.strictEqual(list.json.records.length, 2);
      const cols = await api("GET", "/v1/records", { key: A.key });
      assert.deepStrictEqual(cols.json.collections.map((c) => [c.collection, c.count]), [["matches", 2]]);
      code(await api("PUT", "/v1/records/bad%20name/x", { key: A.key, body: { data: {} } }), 400, "bad_record");
      code(await api("PUT", "/v1/records/matches/x", { key: A.key, body: { data: "a string" } }), 400, "bad_record");
      code(await api("PUT", "/v1/records/matches/big", { key: A.key, body: { data: { s: "x".repeat(70 * 1024) } } }), 400, "bad_record");
    });

    await atest("another app of the same user never sees these records", async () => {
      code(await api("GET", "/v1/records/matches/m1", { key: A.key2 }), 404, "not_found");
      const l = await api("GET", "/v1/records/matches", { key: A.key2 });
      ok(l);
      assert.strictEqual(l.json.records.length, 0);
      code(await api("DELETE", "/v1/records/matches/m1", { key: A.key2 }), 404, "not_found");
    });

    await atest("activity: posted by the app, shown in the main app", async () => {
      code(await api("POST", "/v1/events", { key: A.key, body: { type: "x" } }), 400, "bad_event");
      const e = await api("POST", "/v1/events", { key: A.key, body: {
        type: "match finished", summary: "Lost to the assistant in 41 moves after blundering the queen", data: { result: "loss" } } });
      ok(e, 201);
      assert.strictEqual(e.json.event.type, "match_finished");
      const feed = await api("GET", `/platform/apps/${A.app.id}/activity`, { token: A.session });
      ok(feed);
      assert.strictEqual(feed.json.events[0].summary, "Lost to the assistant in 41 moves after blundering the queen");
      const apps = await api("GET", "/platform/apps", { token: A.session });
      const mine = apps.json.apps.find((x) => x.id === A.app.id);
      assert.ok(mine.lastEvent && /41 moves/.test(mine.lastEvent.summary));
      assert.ok(mine.usage.today.requests > 0, "requests counted");
      const recs = await api("GET", `/platform/apps/${A.app.id}/records/matches`, { token: A.session });
      ok(recs);
      assert.strictEqual(recs.json.records.length, 2);
    });

    /* ------------------------------------------------ (d) the assistant */

    await atest("app tools: requires_action, then tool_results, then the reply", async () => {
      modelCalls.length = 0;
      script = [
        { text: "Classic opening. My answer:", calls: [{ name: "make_move", args: { move: "e7e5" } }] },
        (req) => {
          const last = req.contents[req.contents.length - 1];
          const fr = last.parts[0].functionResponse;
          assert.strictEqual(fr.name, "make_move");
          assert.deepStrictEqual(fr.response, { ok: true, result: JSON.stringify({ ok: true, fen: "after-e5" }) });
          return { text: "Your move!" };
        },
      ];
      const r1 = await api("POST", "/v1/assistant/messages", { key: A.key, body: {
        message: "I played e4, your move", tools: CHESS_TOOLS, context: { fen: "start-e4" },
        instructions: "You are black.",
      } });
      ok(r1);
      assert.strictEqual(r1.json.status, "requires_action");
      assert.match(r1.json.conversation_id, /^conv_[a-f0-9]{24}$/);
      assert.strictEqual(r1.json.tool_calls.length, 1);
      assert.strictEqual(r1.json.tool_calls[0].name, "make_move");
      assert.deepStrictEqual(r1.json.tool_calls[0].arguments, { move: "e7e5" });
      const sys = modelCalls[0].system;
      assert.match(sys, /inside "Chess Arena"/);
      assert.match(sys, /APP POWERS: make_move/);
      assert.match(sys, /Be a friendly opponent/);
      assert.match(sys, /You are black/);
      assert.match(sys, /start-e4/);
      const names = modelCalls[0].declarations.map((d) => d.name);
      assert.ok(names.includes("make_move"));
      for (const n of ["send_agent_message", "place_phone_call", "connected_apps", "get_current_location", "schedule_task"]) {
        assert.ok(!names.includes(n), `${n} is never offered to an app`);
      }

      code(await api("POST", "/v1/assistant/messages", { key: A.key, body: { conversation_id: r1.json.conversation_id, tool_results: [] } }), 400, "missing_results");
      const r2 = await api("POST", "/v1/assistant/messages", { key: A.key, body: {
        conversation_id: r1.json.conversation_id,
        tool_results: [{ call_id: r1.json.tool_calls[0].id, output: { ok: true, fen: "after-e5" } }],
      } });
      ok(r2);
      assert.strictEqual(r2.json.status, "completed");
      assert.strictEqual(r2.json.reply, "Classic opening. My answer: Your move!");
      // The thread remembered its tools: the follow-up still offered make_move.
      assert.ok(modelCalls[1].declarations.some((d) => d.name === "make_move"));
      code(await api("POST", "/v1/assistant/messages", { key: A.key, body: { conversation_id: r1.json.conversation_id, tool_results: [] } }), 409, "nothing_pending");
      A.conv = r1.json.conversation_id;
    });

    await atest("the turn is in the user's conversation memory, marked as the app", async () => {
      const rows = await waitFor(async () => {
        const r = await db.query(`SELECT role, text, source FROM conversation_turns WHERE user_id=$1 ORDER BY id`, [A.id]).catch(() => null);
        return r && r.length >= 2 ? r : null;
      }, 4000);
      assert.ok(rows, "recorded");
      assert.ok(rows.some((r) => r.role === "user" && /I played e4/.test(r.text) && r.source === "app:chess-arena"), JSON.stringify(rows));
      assert.ok(rows.some((r) => r.role === "assistant" && /Your move/.test(r.text)));
    });

    await atest("assistant tools run; a tool no app may use is refused, never run", async () => {
      script = [
        { calls: [
          { name: "create_reminder", args: { text: "Rematch with Ravi", due_at: new Date(Date.now() + 86_400_000).toISOString() } },
          { name: "send_agent_message", args: { to: "Ravi", message: "hi" } },
        ] },
        { text: "Reminder set for the rematch." },
      ];
      const r = await api("POST", "/v1/assistant/messages", { key: A.key, body: { message: "remind me tomorrow to have a rematch with Ravi" } });
      ok(r);
      assert.strictEqual(r.json.status, "completed");
      const rem = r.json.actions.find((a) => a.tool === "create_reminder");
      assert.ok(rem && rem.ok, JSON.stringify(r.json.actions));
      const msg = r.json.actions.find((a) => a.tool === "send_agent_message");
      assert.ok(msg && !msg.ok && /not available/.test(msg.result), JSON.stringify(r.json.actions));
      const saved = await db.one(`SELECT COUNT(*)::int AS n FROM reminders WHERE user_id=$1`, [A.id]);
      assert.strictEqual(saved.n, 1);
    });

    await atest("bad requests: no message, a tool named like an assistant tool, bad tools", async () => {
      code(await api("POST", "/v1/assistant/messages", { key: A.key, body: {} }), 400, "message_required");
      code(await api("POST", "/v1/assistant/messages", { key: A.key, body: { message: "hi", tools: [{ name: "create_reminder" }] } }), 400, "bad_tools");
      code(await api("POST", "/v1/assistant/messages", { key: A.key, body: { message: "hi", tools: [{ name: "9bad" }] } }), 400, "bad_tools");
      code(await api("POST", "/v1/assistant/messages", { key: A.key, body: { message: "hi", tools: "x" } }), 400, "bad_tools");
      code(await api("POST", "/v1/assistant/messages", { key: A.key, body: { message: "hi", conversation_id: "conv_" + "0".repeat(24) } }), 404, "unknown_conversation");
      code(await api("POST", "/v1/assistant/messages", { key: A.key2, body: { message: "hi" } }), 403, "missing_scope");
    });

    await atest("a new message abandons pending app calls without breaking the thread", async () => {
      script = [
        { calls: [{ name: "make_move", args: { move: "d7d5" } }] },
        (req) => {
          const resp = req.contents.find((c) => c.role === "user" && c.parts.some((p) => p.functionResponse && p.functionResponse.response.error === "the app did not run this"));
          assert.ok(resp, "the abandoned call is answered as not done");
          return { text: "No problem, let's start over." };
        },
      ];
      const r1 = await api("POST", "/v1/assistant/messages", { key: A.key, body: { message: "new game", conversation_id: A.conv } });
      assert.strictEqual(r1.json.status, "requires_action");
      const r2 = await api("POST", "/v1/assistant/messages", { key: A.key, body: { message: "actually, reset", conversation_id: A.conv } });
      ok(r2);
      assert.strictEqual(r2.json.reply, "No problem, let's start over.");
    });

    await atest("a model failure is a clear 503, not a server error", async () => {
      class OpenAIError extends Error {}
      script = [() => { throw new OpenAIError("OPENAI_API_KEY is not set"); }];
      code(await api("POST", "/v1/assistant/messages", { key: A.key, body: { message: "hello?" } }), 503, "assistant_unavailable");
    });

    await atest("the daily message limit answers 429 daily_limit", async () => {
      process.env.PLATFORM_DAILY_TURNS = "1";
      try {
        code(await api("POST", "/v1/assistant/messages", { key: A.key, body: { message: "hello again" } }), 429, "daily_limit");
      } finally {
        delete process.env.PLATFORM_DAILY_TURNS;
      }
    });

    /* ------------------------------------------------ (e) the main assistant */

    await atest("the main assistant reads the apps' activity (connected_apps)", async () => {
      const list = await registry.execute("connected_apps", {}, { userId: A.id });
      assert.ok(list.ok, JSON.stringify(list));
      assert.match(list.speak, /Chess Arena: Lost to the assistant in 41 moves/);
      const q = await registry.execute("connected_apps", { app: "chess arena", query: "last match result" }, { userId: A.id });
      assert.ok(q.ok);
      assert.match(q.speak, /41 moves/);
      assert.match(q.speak, /34/, "records are searched too");
      const none = await registry.execute("connected_apps", {}, { userId: B.id });
      assert.match(none.speak, /No apps are connected/);
    });

    await atest("connected_apps is offered only on turns about the user's apps", async () => {
      assert.strictEqual(await platform.wantsApps(A.id, "how did my chess match go?"), true);
      assert.strictEqual(await platform.wantsApps(A.id, "what's on my connected apps"), true);
      assert.strictEqual(await platform.wantsApps(A.id, "what's the weather in Mangalore"), false);
      assert.strictEqual(await platform.wantsApps(B.id, "how did my chess match go?"), false);
    });

    /* ------------------------------------------------ (f) voice */

    await atest("a voice session: client secret, her context, app + assistant tools", async () => {
      const r = await api("POST", "/v1/voice/sessions", { key: A.key, body: { tools: CHESS_TOOLS, context: "board: start" } });
      ok(r, 201);
      assert.strictEqual(r.json.client_secret, "ek_test_secret");
      assert.deepStrictEqual(r.json.app_tools, ["make_move"]);
      assert.ok(r.json.assistant_tools.includes("create_reminder"), r.text);
      assert.ok(!r.json.assistant_tools.includes("send_agent_message"));
      const names = realtimeReq.tools.map((t) => t.name);
      assert.ok(names.includes("make_move") && names.includes("create_reminder"));
      assert.match(realtimeReq.instructions, /inside "Chess Arena"/);
      assert.match(realtimeReq.instructions, /THEY ARE SPEAKING/);
      assert.strictEqual(realtimeReq.user, A.id);
      code(await api("POST", "/v1/voice/sessions", { key: A.key2, body: {} }), 403, "missing_scope");
    });

    await atest("the tool relay runs an allowed assistant tool and refuses the rest", async () => {
      const ok1 = await api("POST", "/v1/tools/call", { key: A.key, body: { name: "list_reminders", arguments: {} } });
      ok(ok1);
      assert.strictEqual(ok1.json.ok, true, ok1.text);
      code(await api("POST", "/v1/tools/call", { key: A.key, body: { name: "place_phone_call", arguments: {} } }), 404, "unknown_tool");
      code(await api("POST", "/v1/tools/call", { key: A.key, body: { name: "send_agent_message", arguments: {} } }), 404, "unknown_tool");
      code(await api("POST", "/v1/tools/call", { key: A.key2, body: { name: "list_reminders" } }), 403, "missing_scope");
      const tl = await api("GET", "/v1/tools", { key: A.key });
      ok(tl);
      assert.ok(tl.json.tools.some((t) => t.name === "create_reminder" && t.parameters.type === "object"));
    });

    await atest("a voice transcript is filed and its minutes counted", async () => {
      const r = await api("POST", "/v1/voice/transcript", { key: A.key, body: {
        session_id: "v1", seconds: 90,
        turns: [{ role: "user", text: "Let's play a quick blitz game" }, { role: "assistant", text: "Gladly, you're white." }, { role: "x", text: "ignored" }],
      } });
      ok(r);
      assert.strictEqual(r.json.kept, 2);
      const u = await pstore.usageToday(A.app.id);
      assert.strictEqual(u.voiceSeconds, 90);
      assert.strictEqual(u.voiceSessions, 1);
    });

    /* ------------------------------------------------ (g) the rest */

    await atest("notify: a push to the user's phone, kept in the feed, daily limit", async () => {
      const r = await api("POST", "/v1/notify", { key: A.key, body: { title: "Your move", body: "The assistant played Nf6." } });
      ok(r);
      assert.strictEqual(r.json.delivered, false, "no phone signed in");
      await db.run(`UPDATE users SET fcm_token='tok-a' WHERE id=$1`, [A.id]);
      const r2 = await api("POST", "/v1/notify", { key: A.key, body: { body: "Rematch?" } });
      assert.strictEqual(r2.json.delivered, true);
      assert.strictEqual(pushed[pushed.length - 1].title, "Chess Arena");
      assert.strictEqual(pushed[pushed.length - 1].data.kind, "connected_app");
      code(await api("POST", "/v1/notify", { key: A.key, body: {} }), 400, "body_required");
      process.env.PLATFORM_DAILY_NOTIFICATIONS = "2";
      try { code(await api("POST", "/v1/notify", { key: A.key, body: { body: "x" } }), 429, "daily_limit"); }
      finally { delete process.env.PLATFORM_DAILY_NOTIFICATIONS; }
    });

    await atest("the developer docs page is served with the API base filled in", async () => {
      const r = await api("GET", "/developers");
      ok(r);
      assert.match(r.headers.get("content-type"), /text\/html/);
      assert.ok(r.text.includes("https://api.example.test/v1/assistant/messages"));
      assert.ok(!r.text.includes("{{API}}"));
      assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
    });

    await atest("pausing the app, revoking a key and removing the app all stop it at once", async () => {
      ok(await api("PATCH", `/platform/apps/${A.app.id}`, { token: A.session, body: { status: "paused" } }));
      code(await api("GET", "/v1/me", { key: A.key }), 403, "app_paused");
      ok(await api("PATCH", `/platform/apps/${A.app.id}`, { token: A.session, body: { status: "active" } }));
      ok(await api("GET", "/v1/me", { key: A.key }));

      const nk = await api("POST", `/platform/apps/${A.app.id}/keys`, { token: A.session, body: { label: "laptop" } });
      ok(nk, 201);
      ok(await api("GET", "/v1/me", { key: nk.json.key }));
      ok(await api("DELETE", `/platform/apps/${A.app.id}/keys/${nk.json.keyInfo.id}`, { token: A.session }));
      code(await api("GET", "/v1/me", { key: nk.json.key }), 401, "invalid_key");
      ok(await api("DELETE", `/platform/apps/${A.app.id}/keys/${nk.json.keyInfo.id}`, { token: B.session }), 404);

      await db.run(`UPDATE users SET status='paused' WHERE id=$1`, [A.id]);
      code(await api("GET", "/v1/me", { key: A.key }), 401, "account_unavailable");
      await db.run(`UPDATE users SET status='active' WHERE id=$1`, [A.id]);

      ok(await api("DELETE", `/platform/apps/${A.app.id}`, { token: A.session }));
      code(await api("GET", "/v1/me", { key: A.key }), 401, "invalid_key");
      for (const t of ["platform_keys", "platform_records", "platform_events", "platform_conversations", "platform_usage"]) {
        const n = await db.one(`SELECT COUNT(*)::int AS n FROM ${t} WHERE app_id=$1`, [A.app.id]);
        assert.strictEqual(n.n, 0, `${t} emptied`);
      }
      assert.strictEqual(await platform.wantsApps(A.id, "how did my chess match go?"), true, "the second app still matches");
    });

    /* ------------------------------------------------ (h) the web console */

    await atest("the console page is served with its base filled in", async () => {
      const r = await api("GET", "/console");
      ok(r);
      assert.match(r.headers.get("content-type"), /text\/html/);
      assert.ok(r.text.includes('"https://api.example.test"') || r.text.includes("https://api.example.test/console/api"));
      assert.ok(!r.text.includes("{{BASE}}"));
      const d = await api("GET", "/developers");
      assert.ok(!d.text.includes("{{CONSOLE}}") && d.text.includes("https://api.example.test/console"));
    });

    await atest("console sign-in: a code pushed to the phone, 5 tries, one use", async () => {
      await db.run(`UPDATE users SET fcm_token='tok-b' WHERE id=$1`, [B.id]);
      const email = `platform-b-${stamp}@example.test`;
      const nobody = await api("POST", "/console/auth/code", { body: { identifier: "nobody-" + stamp + "@example.test" } });
      ok(nobody);
      pushed.length = 0;
      const r = await api("POST", "/console/auth/code", { body: { identifier: email } });
      ok(r);
      assert.strictEqual(r.json.message, nobody.json.message, "the same answer whether or not the account exists");
      assert.strictEqual(pushed.length, 1);
      assert.strictEqual(pushed[0].token, "tok-b");
      const code = (pushed[0].body.match(/\b(\d{6})\b/) || [])[1];
      assert.ok(code, pushed[0].body);
      const wrong = code === "000000" ? "111111" : "000000";
      ok(await api("POST", "/console/auth/verify", { body: { identifier: email, code: wrong } }), 401);
      const v = await api("POST", "/console/auth/verify", { body: { identifier: email.toUpperCase(), code } });
      ok(v);
      const p = jwt.verify(v.json.token, SECRET);
      assert.strictEqual(p.scope, "console");
      assert.strictEqual(p.uid, B.id);
      assert.ok(p.exp - p.iat <= 12 * 3600);
      ok(await api("POST", "/console/auth/verify", { body: { identifier: email, code } }), 401);
      B.console = v.json.token;

      // Five wrong tries end a code even if the sixth is right.
      pushed.length = 0;
      await db.run(`DELETE FROM platform_console_codes WHERE user_id=$1`, [B.id]);
      ok(await api("POST", "/console/auth/code", { body: { identifier: email } }));
      const c2 = pushed[0].body.match(/\b(\d{6})\b/)[1];
      const w2 = c2 === "000000" ? "111111" : "000000";
      for (let i = 0; i < 5; i++) ok(await api("POST", "/console/auth/verify", { body: { identifier: email, code: w2 } }), 401);
      ok(await api("POST", "/console/auth/verify", { body: { identifier: email, code: c2 } }), 401);
    });

    await atest("console sign-in with a password", async () => {
      const bcrypt = require(path.join(BACKEND, "node_modules/bcryptjs"));
      await db.run(`UPDATE users SET password_hash=$2 WHERE id=$1`, [B.id, await bcrypt.hash("correct horse 1", 8)]);
      const email = `platform-b-${stamp}@example.test`;
      ok(await api("POST", "/console/auth/password", { body: { email, password: "wrong" } }), 401);
      const r = await api("POST", "/console/auth/password", { body: { email, password: "correct horse 1" } });
      ok(r);
      assert.strictEqual(jwt.decode(r.json.token).scope, "console");
    });

    await atest("the console token opens only the console; a session does not open the console", async () => {
      ok(await api("GET", "/console/auth/me", { token: B.console }));
      ok(await api("GET", "/console/api/apps", { token: B.console }));
      ok(await api("GET", "/chat/urgent-settings", { token: B.console }), 401);
      ok(await api("GET", "/platform/apps", { token: B.console }), 401);
      ok(await api("GET", "/ai/config", { token: B.console }), 401);
      ok(await api("GET", "/console/api/apps", { token: B.session }), 401);
      ok(await api("GET", "/console/api/apps"), 401);
    });

    await atest("an app created in the console appears in the phone app at once, and the phone is told", async () => {
      pushed.length = 0;
      const r = await api("POST", "/console/api/apps", { token: B.console, body: { name: "Quiz Night", keywords: "quiz" } });
      ok(r, 201);
      assert.match(r.json.key, /^mya_/);
      const phone = await api("GET", "/platform/apps", { token: B.session });
      assert.ok(phone.json.apps.some((a) => a.name === "Quiz Night"));
      const told = await waitFor(async () => pushed.find((x) => /Quiz Night is connected/.test(x.title)), 3000);
      assert.ok(told, JSON.stringify(pushed));
      assert.strictEqual(await platform.wantsApps(B.id, "what was my quiz score?"), true);
      const u = await api("GET", `/console/api/apps/${r.json.app.id}/usage?days=30`, { token: B.console });
      ok(u);
      assert.strictEqual(u.json.days.length, 30);
      assert.strictEqual(u.json.days[29].day, new Date().toISOString().slice(0, 10));
      const other = await api("GET", `/console/api/apps/${r.json.app.id}`, { token: B.console });
      ok(other);
      ok(await api("GET", `/platform/apps/${r.json.app.id}`, { token: A.session }), 404); // another account
    });

    await atest("account erase covers every platform table", async () => {
      const privacy = fs.readFileSync(path.join(BACKEND, "src/routes/privacy.js"), "utf8");
      assert.ok(privacy.includes('require("../platform/store").USER_TABLES'));
      assert.deepStrictEqual(pstore.USER_TABLES.map((t) => t[0]).sort(),
        ["platform_apps", "platform_console_codes", "platform_conversations", "platform_events", "platform_keys", "platform_records", "platform_usage"]);
    });
  } finally {
    for (const id of made) {
      for (const [t, c] of pstore.USER_TABLES) await db.run(`DELETE FROM ${t} WHERE ${c}=$1`, [id]).catch(() => {});
      await db.run(`DELETE FROM reminders WHERE user_id=$1`, [id]).catch(() => {});
      await db.run(`DELETE FROM users WHERE id=$1`, [id]).catch(() => {});
    }
    console.log(`\nplatform: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
