/**
 * E2E · GROUP 3 — "do it for me" on the phone, shopping and payments,
 * store hand-offs, WhatsApp / Instagram, third-party apps.
 *
 *   DATABASE_URL=postgres://…/myassistant_e2e_g3 node scripts/e2e-g3-phone-automation-shopping-test.js
 *
 * What runs for real: the /assistant, /automation and /contacts routers
 * behind the real appAuth (a signed session JWT per test user), the tool
 * registry with every builtin, the automation service / guard / prefs /
 * intents, the fulfillment hand-offs, and Postgres.
 *
 * What is stubbed: every model (the tool-calling model and the planner
 * are scripted), web search, places lookup and the social-handle lookup.
 * Any fetch to a host other than 127.0.0.1 throws — nothing here can
 * reach a paid or real service.
 *
 * The app side (Dart + Kotlin) is checked statically against the files in
 * ../myassistant-flutter: the directive fields it parses, the channel
 * methods it calls, the money / messaging lists, the finish reasons.
 *
 * Self-cleaning: every row written for the test users is deleted at the
 * end, whatever happened.
 *
 * Tests named "DEFECT:" pin a real defect and are EXPECTED TO FAIL until
 * the defect is fixed. Do not weaken them.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://myassistant:localdev@127.0.0.1:55432/myassistant_e2e_g3";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "g3-e2e-test-secret-not-real";
delete process.env.AUTH_DISABLED;

const assert = require("assert");
const fs = require("fs");
const path = require("path");

/* ------------------------------------------------------------------ *
 * NO NETWORK. Only this process's own test server may be fetched.
 * ------------------------------------------------------------------ */
const realFetch = globalThis.fetch;
const blocked = [];
globalThis.fetch = async (url, opts) => {
  const u = new URL(typeof url === "string" ? url : url.url || String(url));
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return realFetch(url, opts);
  blocked.push(u.hostname);
  throw new Error(`network blocked in test: ${u.hostname}`);
};

/* ------------------------------------------------------------------ *
 * THE MODELS, SCRIPTED — set before anything binds them at load time
 * (commitments/service and agents/runtime destructure the router).
 * ------------------------------------------------------------------ */
const ai = require("../src/services/ai/router");
let plannerScript = [];
const plannerPrompts = [];
ai.generateReply = async (messages, opts = {}) => {
  if (/^AUTOMATION/.test(String(opts.modelEnv || ""))) {
    plannerPrompts.push(messages?.[0]?.content || "");
    const next = plannerScript.shift();
    if (next === undefined) throw new Error("planner called more times than scripted");
    return { reply: typeof next === "string" ? next : JSON.stringify(next) };
  }
  throw new Error("model stubbed in test");
};
let toolModel = [];
const toolModelCalls = [];
ai.generateWithToolsStream = async (opts = {}) => {
  toolModelCalls.push(opts.contents);
  const n = toolModel.shift() || { text: "" };
  if (n.text && typeof opts.onDelta === "function") opts.onDelta(n.text);
  return { functionCalls: n.functionCalls || [], text: n.text || "" };
};
ai.generateWithTools = async () => ({ functionCalls: [], text: "" });

const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../src/db");

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
    console.error(`  FAIL ${name}\n       ${String(e.stack || e.message).split("\n").slice(0, 6).join("\n       ")}`);
    process.exitCode = 1;
  }
}

const FLUTTER = path.resolve(__dirname, "../../myassistant-flutter");
const KT = path.join(FLUTTER, "android/app/src/main/kotlin/com/myassistant/myassistant");
const readApp = (rel) => fs.readFileSync(path.join(FLUTTER, rel), "utf8");
const readKt = (f) => fs.readFileSync(path.join(KT, f), "utf8");
const haveApp = fs.existsSync(path.join(FLUTTER, "lib/services/automation_runner.dart"));

// Screens as the phone's accessibility service reports them.
const N = (id, o) => ({ id, cls: "View", text: "", desc: "", hint: "", rid: "", label: "",
  click: 0, edit: 0, scroll: 0, check: 0, checked: 0, sel: 0, pwd: 0, en: 1, ...o });
const SW = "in.swiggy.android";
const FK = "com.flipkart.android";
const CHROME = "com.android.chrome";

(async () => {
  await db.init();
  const registry = require("../src/tools/registry");
  require("../src/tools/builtins").registerBuiltins();
  const svc = require("../src/automation/service");
  const guard = require("../src/automation/guard");
  const prefs = require("../src/automation/prefs");
  const say = require("../src/automation/say");
  const webSearch = require("../src/tools/webSearch");
  const socialHandles = require("../src/tools/socialHandles");
  const places = require("../src/services/tools/places");
  const { appAuth } = require("../src/middleware/auth");
  const assistantRoutes = require("../src/assistant/routes");

  // Stubs for the lookups (no network, fixed answers).
  webSearch.run = async (q) => ({
    ok: true, provider: "stub",
    data: /virat/i.test(q)
      ? [{ title: "Virat Kohli (@virat.kohli) • Instagram photos and videos",
          url: "https://www.instagram.com/virat.kohli/", snippet: "Verified account" }]
      : [],
  });
  socialHandles.resolveVerified = async (person) => (/virat/i.test(person) ? "virat.kohli" : null);
  socialHandles.inspectionBlocked = () => true; // what production sees (Instagram 429s the server)
  places.searchPlaces = async ({ q }) => (/airport/i.test(q)
    ? [{ name: "Kempegowda International Airport", lat: 13.1986, lng: 77.7066, phone: "" }] : []);

  /* ---------------- users, sessions, server ---------------- */
  // Leftovers of an earlier run that died before its own clean-up.
  async function purge(ids) {
    if (!ids.length) return;
    const tables = await db.query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema='public' AND column_name='user_id' AND table_name <> 'users'`);
    for (const { table_name: t } of tables) {
      await db.run(`DELETE FROM "${t}" WHERE user_id::text = ANY($1::text[])`, [ids.map(String)]).catch(() => 0);
    }
    await db.run(`DELETE FROM users WHERE id = ANY($1::int[])`, [ids]);
  }
  await purge((await db.query(`SELECT id FROM users WHERE email LIKE 'g3-%@example.test'`)).map((r) => Number(r.id)));
  const stamp = Date.now();
  const mk = async (tag, extra = {}) => {
    const u = await db.createUser({ email: `g3-${tag}-${stamp}@example.test`, name: extra.name || `G3 ${tag}` });
    await db.run(`UPDATE users SET phone_number=COALESCE($2, phone_number), location=COALESCE($3, location) WHERE id=$1`,
      [u.id, extra.phone || null, extra.city || null]);
    return { id: u.id, token: jwt.sign({ uid: u.id }, process.env.JWT_SECRET, { expiresIn: "1h" }) };
  };
  const A = await mk("a", { name: "Ravi Kumar", phone: "+919812345678", city: "Bengaluru" });
  const B = await mk("b");
  const C = await mk("c"); // daily limit
  const D = await mk("d"); // classic-path note
  const E = await mk("e"); // money
  const USERS = [A, B, C, D, E];

  const app = express();
  app.use(express.json());
  app.get("/assistant/stream/:sid", assistantRoutes.streamHandler);
  app.use("/assistant", appAuth, assistantRoutes);
  app.use("/automation", appAuth, require("../src/automation/routes"));
  app.use("/contacts", appAuth, require("../src/routes/contacts"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (method, p, { token, body, headers = {} } = {}) => {
    const res = await realFetch(base + p, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { status: res.status, body: json };
  };
  /** Reads the assistant session's SSE stream until pred(event) or the timeout. */
  async function sseUntil(sid, token, pred, ms = 10000) {
    const ac = new AbortController();
    const events = [];
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      const res = await realFetch(`${base}/assistant/stream/${sid}?token=${token}`, { signal: ac.signal });
      const reader = res.body.getReader();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += Buffer.from(value).toString("utf8");
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const e = JSON.parse(line.slice(6));
          events.push(e);
          if (pred(e)) { ac.abort(); return events; }
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") throw e;
    } finally {
      clearTimeout(timer);
    }
    return events;
  }
  /** One typed turn on the classic (SSE) path, as the app sends it. */
  async function typedTurn(user, text, pred) {
    const s = await http("POST", "/assistant/session", { token: user.token, headers: { "X-App-Build": "118" } });
    assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    const { sessionId, streamToken } = s.body;
    const reading = sseUntil(sessionId, streamToken, pred);
    const m = await http("POST", `/assistant/${sessionId}/message`,
      { token: user.token, body: { text }, headers: { "X-App-Build": "118" } });
    assert.strictEqual(m.status, 202);
    return reading;
  }
  const tool = (n) => registry.get(n);
  const ctxFor = (u, extra = {}) => ({ userId: u.id, platform: "android", appBuild: 118, source: "text", ...extra });
  const runRow = async (id) => db.one(`SELECT * FROM automation_runs WHERE id=$1`, [id]);

  try {
    /* ============================================================== *
     * 1 · THE RUN OVER HTTP, BEHIND THE REAL SESSION CHECK
     * ============================================================== */
    console.log("\nweb & computer use · the run lifecycle over HTTP (real JWT auth)");

    await atest("the automation routes refuse a request with no session or a forged one", async () => {
      assert.strictEqual((await http("GET", "/automation/recent")).status, 401);
      const forged = jwt.sign({ uid: A.id }, "someone-elses-secret");
      assert.strictEqual((await http("GET", "/automation/recent", { token: forged })).status, 401);
      assert.strictEqual((await http("GET", "/automation/recent", { token: A.token })).status, 200);
    });

    let typedRunId = null;
    await atest("typed 'order veg biryani on swiggy' reaches the phone as an 'automate' event carrying every field the app parses", async () => {
      const events = await typedTurn(A, "order veg biryani on swiggy", (e) => e.type === "automate");
      const d = events.find((e) => e.type === "automate");
      assert.ok(d, `no automate event; saw ${events.map((e) => e.type).join(",")}`);
      typedRunId = d.run_id;
      assert.ok(Number.isInteger(d.run_id) && d.run_id > 0);
      assert.strictEqual(d.app_name, "swiggy");
      assert.strictEqual(d.pkg, "in.swiggy.android");
      assert.strictEqual(d.category, "food");
      assert.strictEqual(d.named, true, "the owner named Swiggy");
      assert.strictEqual(d.no_install, false);
      assert.strictEqual(d.web, false);
      assert.strictEqual(d.any, true);
      assert.deepStrictEqual(d.allowed, ["in.swiggy.android"]);
      assert.strictEqual(d.max_steps, svc.MAX_STEPS);
      assert.strictEqual(d.resume, false);
      assert.strictEqual(d.may_install, false, "'order' is not an install");
      assert.strictEqual(d.seq, 0);
      assert.match(d.start_url, /^https:\/\/www\.swiggy\.com\/search\?query=veg%20biryani$/,
        "intent first: the run opens on Swiggy's own results");
      const said = events.filter((e) => e.type === "assistant_sentence").map((e) => e.text).join(" ");
      assert.match(said, /On it, doing this in Swiggy/);
      assert.doesNotMatch(said, /ordered|placed/i, "never claims the order");
      if (haveApp) {
        const dart = readApp("lib/services/automation_runner.dart");
        const body = dart.slice(dart.indexOf("static AutomationDirective? fromEvent"), dart.indexOf("class AutomationOutcome"));
        const keys = [...body.matchAll(/e\['(\w+)'\]/g)].map((m) => m[1]);
        for (const k of keys) assert.ok(k in d, `the app reads e['${k}'] but the event has no ${k}`);
      }
      const row = await runRow(d.run_id);
      assert.strictEqual(Number(row.user_id), A.id);
      assert.strictEqual(row.status, "running");
    });

    await atest("an app older than build 104 is never handed a task on the typed route", () => {
      const intent = require("../src/automation/intent");
      assert.strictEqual(intent.matchFor("order veg biryani on swiggy", 103), null);
      assert.ok(intent.matchFor("order veg biryani on swiggy", 104));
      const has = (b) => registry.declarations({ deviceCaps: { build: b, platform: "android", granted: [], denied: [] } })
        .some((x) => x.name === "do_task_in_app");
      assert.strictEqual(has(103), false);
      assert.strictEqual(has(118), true);
    });

    await atest("another user can neither read, drive nor end this run", async () => {
      assert.ok(typedRunId, "needs the run from the typed turn");
      assert.strictEqual((await http("GET", `/automation/${typedRunId}`, { token: B.token })).status, 404);
      const st = await http("POST", `/automation/${typedRunId}/step`,
        { token: B.token, body: { seq: 0, screen: { pkg: SW, nodes: [] }, last: null } });
      assert.strictEqual(st.body.status, "failed");
      assert.match(st.body.report, /no longer exists/);
      const fin = await http("POST", `/automation/${typedRunId}/finish`, { token: B.token, body: { reason: "stopped" } });
      assert.match(fin.body.report || "", /no longer exists/);
      const od = await http("POST", `/automation/${typedRunId}/owner_done`, { token: B.token });
      assert.strictEqual(od.body.ok, false);
      const mine = await http("GET", `/automation/${typedRunId}`, { token: A.token });
      assert.strictEqual(mine.status, 200);
      assert.strictEqual(mine.body.run.status, "running", "B's calls changed nothing");
      // End it cleanly as the owner.
      const stop = await http("POST", `/automation/${typedRunId}/finish`, { token: A.token, body: { reason: "stopped" } });
      assert.strictEqual(stop.body.status, "stopped");
    });

    let shopRunId = null;
    await atest("shopping up to the cart: ADD TO CART is tapped, the payment screen hands over, and the report says so", async () => {
      const out = await tool("do_task_in_app").execute(
        { goal: "add boAt Airdopes 141 to my cart", category: "shopping", query: "boAt Airdopes 141" },
        ctxFor(A, { userText: "add boAt Airdopes 141 to my cart on Flipkart" }));
      assert.strictEqual(out.ok, true, JSON.stringify(out));
      const d = out.deviceAction;
      shopRunId = d.run_id;
      assert.strictEqual(d.app_name, "flipkart", "the app the owner named wins");
      assert.strictEqual(d.named, true);
      assert.strictEqual(d.start_url, "https://www.flipkart.com/search?q=boAt%20Airdopes%20141");
      assert.match(out.speak, /I'll stop before any payment/);
      const results = { pkg: FK, nodes: [
        N(1, { text: "boAt Airdopes 141 Bluetooth Headset", click: 1 }),
        N(2, { cls: "Button", text: "ADD TO CART", click: 1 }),
      ] };
      plannerScript = [{ status: "continue", action: { type: "tap", id: 2 }, expect: "the item in the cart" }];
      const s0 = await http("POST", `/automation/${d.run_id}/step`, { token: A.token, body: { seq: 0, screen: results, last: null } });
      assert.strictEqual(s0.body.status, "continue", JSON.stringify(s0.body));
      assert.strictEqual(s0.body.action.what, "ADD TO CART");
      // The checkout: payment methods on screen → the owner's step, no model call.
      const checkout = { pkg: FK, nodes: ["UPI", "Credit / Debit / ATM Card", "Net Banking", "Cash on Delivery"]
        .map((t, i) => N(10 + i, { text: t, click: 1 })) };
      const s1 = await http("POST", `/automation/${d.run_id}/step`,
        { token: A.token, body: { seq: 1, screen: checkout, last: { ok: true } } });
      assert.strictEqual(s1.body.status, "handoff", JSON.stringify(s1.body));
      assert.match(s1.body.report, /ready for payment in Flipkart/);
      assert.strictEqual(plannerScript.length, 0);
      const got = await http("GET", `/automation/${d.run_id}`, { token: A.token });
      assert.strictEqual(got.body.run.handoff_kind, "payment");
      assert.strictEqual(got.body.run.steps.length, 1);
      assert.deepStrictEqual(got.body.run.steps[0].result, { ok: true, changed: true });
      const recent = await http("GET", "/automation/recent", { token: A.token });
      assert.ok(recent.body.runs.some((r) => r.id === d.run_id && r.status === "handoff"));
    });

    await atest("the finished shopping run is remembered: the next shopping task defaults to 'the one you used last time'", async () => {
      assert.ok(shopRunId);
      const t = await db.one(
        `SELECT kind, provider, status, path FROM fulfillment_tasks WHERE user_id=$1 AND path='automation' ORDER BY id DESC LIMIT 1`, [A.id]);
      assert.deepStrictEqual({ ...t }, { kind: "shop", provider: "flipkart", status: "handed_off", path: "automation" });
      const pick = await prefs.pickApp(A.id, "shopping", "");
      assert.strictEqual(pick.name, "flipkart");
      assert.match(pick.reason, /you used Flipkart last time/);
    });

    await atest("sign-in mid-run is the owner's turn: owner_step, Continue, then done only with proof on screen", async () => {
      const out = await svc.start(A.id, { goal: "add veg biryani to my cart", app: "swiggy", category: "food" });
      const id = out.run.id;
      const login = { pkg: SW, nodes: [N(1, { text: "Login" }), N(2, { cls: "EditText", edit: 1, hint: "Enter mobile number" })] };
      const s0 = await http("POST", `/automation/${id}/step`, { token: A.token, body: { seq: 0, screen: login, last: null } });
      assert.strictEqual(s0.body.status, "owner_step");
      assert.strictEqual(s0.body.kind, "credential");
      assert.strictEqual((await runRow(id)).status, "waiting_owner");
      // Asked again while the owner is signing in: still their turn, nothing planned.
      const again = await http("POST", `/automation/${id}/step`, { token: A.token, body: { seq: 0, screen: login, last: null } });
      assert.strictEqual(again.body.status, "owner_step");
      const od = await http("POST", `/automation/${id}/owner_done`, { token: A.token });
      assert.deepStrictEqual(od.body, { ok: true });
      const cartBar = { pkg: SW, nodes: [N(12, { cls: "Button", click: 1, label: "1 item | ₹249 View Cart" })] };
      plannerScript = [{ status: "done", report: "Veg biryani is in your cart — ₹249.", evidence: "1 item" }];
      const s1 = await http("POST", `/automation/${id}/step`, { token: A.token, body: { seq: 0, screen: cartBar, last: null } });
      assert.strictEqual(s1.body.status, "done", JSON.stringify(s1.body));
      assert.match(s1.body.report, /in your cart/);
    });

    await atest("a 'done' the screen does not show is 'please check' (unconfirmed); a build-104 phone hears 'failed'", async () => {
      const menu = { pkg: SW, nodes: [N(10, { text: "Veg Biryani ₹249" }), N(11, { cls: "Button", text: "ADD", click: 1 })] };
      const a = await svc.start(A.id, { goal: "add a veg biryani", app: "swiggy", category: "food" });
      plannerScript = [{ status: "done", report: "Added to your cart.", evidence: "Added to cart" }];
      const r1 = await http("POST", `/automation/${a.run.id}/step`, { token: A.token, body: { seq: 0, screen: menu, last: null } });
      assert.strictEqual(r1.body.status, "unconfirmed");
      assert.strictEqual((await runRow(a.run.id)).status, "unconfirmed");
      const b = await svc.start(A.id, { goal: "add one more veg biryani", app: "swiggy", category: "food" });
      plannerScript = [{ status: "done", report: "Added.", evidence: "Added to cart" }];
      const r2 = await http("POST", `/automation/${b.run.id}/step`, { token: A.token, body: { screen: menu, last: null } });
      assert.strictEqual(r2.body.status, "failed", "a build-104 phone has no case for unconfirmed");
    });

    await atest("a phone that went silent: the run is closed as failed, while a run not yet begun gets its 15 minutes", async () => {
      const dead = await svc.start(A.id, { goal: "find my last order", app: "amazon", category: "shopping" });
      const fresh = await svc.start(A.id, { goal: "find my last return", app: "amazon", category: "shopping" });
      const ago = Date.now() - 3 * 60_000;
      await db.run(`UPDATE automation_runs SET updated_at=$2, steps=$3 WHERE id=$1`,
        [dead.run.id, ago, JSON.stringify([{ action: { type: "wait" }, expect: "x", result: { ok: true, changed: true } }])]);
      await db.run(`UPDATE automation_runs SET updated_at=$2 WHERE id=$1`, [fresh.run.id, ago]);
      const recent = await http("GET", "/automation/recent?limit=30", { token: A.token });
      const d = recent.body.runs.find((r) => r.id === dead.run.id);
      const f = recent.body.runs.find((r) => r.id === fresh.run.id);
      assert.strictEqual(d.status, "failed");
      assert.strictEqual(d.report, say.stale());
      assert.strictEqual(f.status, "running", "the owner may still be switching on the permission");
      await svc.finish(A.id, fresh.run.id, { reason: "stopped" });
    });

    await atest("every finish reason the phone sends is one the server files correctly", async () => {
      const want = { stopped: "stopped", not_installed: "failed", blocked_by_app: "blocked", blocked: "handoff",
        left_app: "handoff", returned: "stopped", error: "failed" };
      if (haveApp) {
        const dart = readApp("lib/services/automation_runner.dart");
        const sent = new Set([...dart.matchAll(/_finish\(\s*d\.runId,\s*'(\w+)'/g)].map((m) => m[1]));
        sent.add("not_installed"); // the install switch's reason variable
        for (const r of sent) assert.ok(r in want, `the phone sends finish reason '${r}' the test does not know`);
        const src = fs.readFileSync(path.join(__dirname, "../src/automation/service.js"), "utf8");
        const table = src.slice(src.indexOf("const DEVICE_REASONS = {"), src.indexOf("};", src.indexOf("const DEVICE_REASONS = {")));
        for (const r of sent) assert.match(table, new RegExp(`\\b${r}:`), `server has no DEVICE_REASONS entry for '${r}'`);
      }
      for (const [reason, status] of Object.entries(want)) {
        const s = await svc.start(A.id, { goal: `finish test ${reason}`, app: "zomato", category: "food" });
        const f = await http("POST", `/automation/${s.run.id}/finish`, { token: A.token, body: { reason, kind: "", detail: "" } });
        assert.strictEqual(f.status, 200);
        assert.strictEqual((await runRow(s.run.id)).status, status, reason);
        assert.ok(String(f.body.report || "").length > 0, `${reason}: the owner hears a sentence`);
      }
    });

    await atest("forty tasks a day, then a plain refusal", async () => {
      const now = Date.now();
      for (let i = 0; i < svc.DAILY_RUNS; i++) {
        await db.run(`INSERT INTO automation_runs (user_id, goal, status, created_at, updated_at) VALUES ($1,$2,'done',$3,$3)`,
          [C.id, `g${i}`, now]);
      }
      const r = await tool("do_task_in_app").execute({ goal: "order idli", app: "swiggy", category: "food" }, ctxFor(C, { userText: "order idli" }));
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /limit of hands-on tasks for today/);
    });

    /* ============================================================== *
     * 2 · THE LINES THE HANDS NEVER CROSS
     * ============================================================== */
    console.log("\nshopping & payments · purchase approval controls and payment protections");

    await atest("pay / order / OTP / password / card / UPI PIN / consent / CAPTCHA / sending / posting are each handed over", () => {
      const tap = (pkg, n) => guard.checkAction({ type: "tap", id: n.id }, { pkg, nodes: [n] })?.kind || null;
      const type = (pkg, n, text) => guard.checkAction({ type: "type", id: n.id, text }, { pkg, nodes: [n] })?.kind || null;
      assert.strictEqual(tap(FK, N(1, { text: "Place Order", click: 1 })), "payment");
      assert.strictEqual(tap(FK, N(1, { text: "Proceed to Buy", click: 1 })), "payment");
      assert.strictEqual(tap(FK, N(1, { text: "Buy Now", click: 1 })), "payment");
      assert.strictEqual(tap("com.practo.fabric", N(1, { text: "Book now", click: 1 })), "payment", "a booking");
      assert.strictEqual(tap(FK, N(1, { text: "ADD TO CART", click: 1 })), null);
      assert.strictEqual(tap("net.one97.paytm", N(1, { text: "Anything", click: 1 })), "blocked_app");
      assert.strictEqual(tap(FK, N(1, { text: "Send money", click: 1 })), "money");
      assert.strictEqual(type(FK, N(1, { cls: "EditText", edit: 1, hint: "Enter OTP" }), "123456"), "credential");
      assert.strictEqual(type(FK, N(1, { cls: "EditText", edit: 1, pwd: 1 }), "hunter2"), "credential");
      assert.strictEqual(type(FK, N(1, { cls: "EditText", edit: 1, hint: "Name on card" }), "4111 1111 1111 1111"), "credential");
      assert.strictEqual(type(FK, N(1, { cls: "EditText", edit: 1, hint: "Enter UPI PIN" }), "1234"), "credential");
      assert.strictEqual(type(FK, N(1, { cls: "EditText", edit: 1, hint: "CVV" }), "123"), "credential");
      assert.strictEqual(type(FK, N(1, { cls: "EditText", edit: 1, hint: "Pincode" }), "560001"), null, "an address pincode is fillable");
      assert.strictEqual(tap(CHROME, N(1, { text: "Accept all cookies", click: 1 })), "consent");
      assert.strictEqual(tap(CHROME, N(1, { text: "Reject all", click: 1 })), null, "rejecting cookies is the private choice");
      assert.strictEqual(tap(CHROME, N(1, { check: 1, click: 1, label: "I hereby declare that the information given is true" })), "consent");
      assert.strictEqual(guard.checkScreen({ pkg: CHROME, nodes: [N(1, { text: "I'm not a robot", check: 1 })] })?.kind, "captcha");
      assert.strictEqual(guard.checkScreen({ pkg: FK, nodes: [N(1, { text: "Enter the OTP sent to +91 98xxxxxx12" }),
        N(2, { cls: "EditText", edit: 1 })] })?.kind, "credential");
      assert.strictEqual(tap("com.whatsapp", N(1, { desc: "Send", click: 1 })), "message_send");
      assert.strictEqual(tap("com.instagram.android", N(1, { text: "Post", click: 1 })), "publish");
      assert.strictEqual(tap("com.instagram.android", N(1, { text: "Follow", click: 1 })), null, "following is allowed");
      assert.strictEqual(guard.checkAction({ type: "open_app", name: "PhonePe" }, { pkg: FK, nodes: [] })?.kind, "money");
      assert.strictEqual(guard.checkPackage("com.google.android.apps.nbu.paisa.user")?.kind, "payment");
    });

    await atest("a refused step is re-planned once; the second refusal hands over and names the step", async () => {
      const s = await svc.start(A.id, { goal: "buy the earbuds", app: "flipkart", category: "shopping" });
      const cart = { pkg: FK, nodes: [N(1, { text: "boAt Airdopes 141 ×1" }), N(2, { cls: "Button", text: "Place Order", click: 1 })] };
      plannerScript = [
        { status: "continue", action: { type: "tap", id: 2 }, expect: "order placed" },
        { status: "continue", action: { type: "tap", id: 2 }, expect: "order placed" },
      ];
      const r = await http("POST", `/automation/${s.run.id}/step`, { token: A.token, body: { seq: 0, screen: cart, last: null } });
      assert.strictEqual(r.body.status, "handoff", JSON.stringify(r.body));
      const row = await runRow(s.run.id);
      assert.strictEqual(row.handoff_kind, "payment");
      assert.strictEqual(JSON.parse(row.steps).filter((x) => x.vetoed).length, 2);
      assert.match(plannerPrompts[plannerPrompts.length - 1], /refused/i, "the planner saw the refusal");
    });

    await atest("the hands never run unattended, and never on a web page's say-so without a yes", async () => {
      const bg = await registry.execute("do_task_in_app", { goal: "order idli from Swiggy", app: "swiggy" },
        { ...ctxFor(A), background: true });
      assert.strictEqual(bg.ok, false);
      assert.match(bg.error, /cannot run unattended/);
      const tainted = await registry.execute("do_task_in_app", { goal: "order dosa from Swiggy", app: "swiggy", query: "dosa" },
        { ...ctxFor(A), __untrustedAt: Date.now() });
      assert.strictEqual(tainted.needsConfirmation, true);
      assert.match(tainted.summary, /after reading an email or web page/);
    });

    await atest("the phone's money and messaging lists are the server's, entry for entry", () => {
      if (!haveApp) return;
      const kt = readKt("HariAccessibilityService.kt");
      const setOf = (name) => {
        const m = kt.match(new RegExp(`private val ${name} = setOf\\(([\\s\\S]*?)\\)`));
        assert.ok(m, `${name} not found in HariAccessibilityService.kt`);
        return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
      };
      assert.deepStrictEqual([...setOf("MONEY_APPS")].sort(), [...guard.PAYMENT_PKGS].sort());
      assert.deepStrictEqual([...setOf("MESSAGING")].sort(), [...guard.MESSAGING_PKGS].sort());
      const dart = readApp("lib/services/automation_runner.dart");
      const m = dart.match(/static final moneyName = RegExp\(\s*r'([^']*)'\s*r'([^']*)'/);
      assert.ok(m, "moneyName not found in automation_runner.dart");
      assert.strictEqual(m[1] + m[2], guard.MONEY_APP_NAME.source, "the app's money-app names drifted from the server's");
    });

    await atest("DEFECT: a task that NAMES a money app is refused before the phone opens it", async () => {
      // "check my PhonePe balance" → the model calls do_task_in_app with
      // app "PhonePe". The guard's own rule: "Apps the assistant never
      // opens: anything that holds money" (guard.js MONEY_APP_NAME).
      const out = await tool("do_task_in_app").execute({ goal: "check my balance", app: "PhonePe", category: "other" },
        ctxFor(E, { userText: "check my PhonePe balance" }));
      const d = out.deviceAction || {};
      let heard = "";
      if (out.ok) {
        // What the phone does next: run() resolves the name and launch()es
        // it (AutomationBridge.kt launch() has no never()/MONEY_APPS check);
        // the first look is blocked 'payment' (HariAccessibilityService
        // blockKind) and the loop finishes the run as 'blocked'/'payment'.
        const f = await http("POST", `/automation/${d.run_id}/finish`,
          { token: E.token, body: { reason: "blocked", kind: "payment" } });
        heard = f.body.report;
      }
      assert.strictEqual(out.ok, false,
        `the run was started and the phone was told to open it: app_name=${d.app_name} pkg="${d.pkg}" ` +
        `no_install=${d.no_install}; PhonePe opens and the owner then hears: "${heard}" — nothing was ready for payment.`);
    });

    /* ============================================================== *
     * 3 · WEB TASKS AND FORMS
     * ============================================================== */
    console.log("\nweb & computer use · browser, official sites, forms");

    await atest("'file my income tax return' opens the official site in the browser as a web run", async () => {
      const out = await tool("do_task_in_app").execute({ goal: "file my income tax return" },
        ctxFor(A, { userText: "file my income tax return" }));
      assert.strictEqual(out.ok, true, JSON.stringify(out));
      const d = out.deviceAction;
      assert.strictEqual(d.web, true);
      assert.strictEqual(d.start_url, "https://www.incometax.gov.in/iec/foportal/");
      assert.strictEqual(d.category, "web");
      assert.deepStrictEqual(d.allowed, guard.BROWSERS);
      assert.strictEqual(d.app, "the browser");
      assert.match(out.speak, /opening the income tax e-filing site/);
      await svc.finish(A.id, d.run_id, { reason: "stopped" });
    });

    await atest("open_webpage opens only real web addresses, and a search when unsure", async () => {
      const t = tool("open_webpage");
      assert.strictEqual((await t.execute({ url: "intent://x#Intent;action=android.intent.action.DELETE;end" })).ok, false);
      const s = await t.execute({ search: "district court documents download Karnataka" });
      assert.strictEqual(s.deviceAction.url, "https://www.google.com/search?q=district%20court%20documents%20download%20Karnataka");
      const ok = await t.execute({ url: "eportal.incometax.gov.in", label: "the income tax portal" });
      assert.strictEqual(ok.deviceAction.type, "open_url");
      assert.match(ok.deviceAction.url, /^https:\/\/eportal\.incometax\.gov\.in/);
    });

    await atest("DEFECT: a web form's question, once answered, resumes in the browser — the phone is given something it can open", async () => {
      const url = "https://scholarships.gov.in/fresh/newstdRegfrmInstruction";
      const out = await tool("do_task_in_app").execute(
        { goal: "apply for the NSP scholarship with my details", category: "web", url },
        ctxFor(A, { userText: "apply for the NSP scholarship with my details" }));
      assert.strictEqual(out.ok, true, JSON.stringify(out));
      const runId = out.deviceAction.run_id;
      assert.strictEqual(out.deviceAction.web, true);
      const form = { pkg: CHROME, nodes: [
        N(1, { cls: "EditText", edit: 1, hint: "Father's name" }),
        N(2, { cls: "EditText", edit: 1, hint: "Date of birth" }),
        N(3, { cls: "Button", text: "Save and continue", click: 1 }),
      ] };
      plannerScript = [{ status: "ask_user", question: "What is your father's name?" }];
      const s0 = await http("POST", `/automation/${runId}/step`, { token: A.token, body: { seq: 0, screen: form, last: null } });
      assert.strictEqual(s0.body.status, "waiting", JSON.stringify(s0.body));
      assert.strictEqual((await svc.waitingRun(A.id))?.id, runId, "the owner's next words resume this run");
      const res = await tool("do_task_in_app").execute({ run_id: runId, answer: "Ramesh Kumar" },
        ctxFor(A, { userText: "Ramesh Kumar" }));
      assert.strictEqual(res.ok, true, JSON.stringify(res));
      // The answer is kept for every later form…
      const mem = await db.one(`SELECT fact FROM agent_memories WHERE user_id=$1 AND source='form_answer' ORDER BY id DESC LIMIT 1`, [A.id]);
      assert.match(mem?.fact || "", /father's name: Ramesh Kumar/i);
      const info = await prefs.ownerInfo(A.id);
      assert.ok((info.also_known || []).some((f) => /Ramesh Kumar/.test(f)), "the next form finds it");
      // …but the run must be able to carry on. The phone (automation_runner.dart
      // run()) calls launch(pkg: d.pkg, url: d.resume ? '' : d.startUrl); with
      // both empty AutomationBridge.kt launch() returns {ok:false, error:"no_app"}
      // and the run ends "Something went wrong in the browser, so I stopped."
      const d = res.deviceAction;
      assert.strictEqual(d.resume, true);
      assert.ok(d.pkg || d.start_url,
        `resume directive gives the phone nothing to open: web=${d.web} pkg="${d.pkg}" start_url="${d.start_url}"`);
    });

    await atest("a form answer that is a secret, or not about the owner, is never remembered", async () => {
      assert.strictEqual(await prefs.rememberAnswer(A.id, "What is your Aadhaar number?", "1234 5678 9012"), false);
      assert.strictEqual(await prefs.rememberAnswer(A.id, "How many people?", "4"), false);
      const info = await prefs.ownerInfo(A.id);
      assert.strictEqual(info.name, "Ravi Kumar");
      assert.strictEqual(info.phone, "+919812345678");
      assert.ok(!JSON.stringify(info).includes("1234 5678 9012"));
    });

    /* ============================================================== *
     * 4 · STORES: SEARCH LINKS AND NAMED APPS
     * ============================================================== */
    console.log("\nstore connectors · Amazon/Flipkart, Blinkit/Zepto, travel, named stores");

    await atest("Walmart → Amazon/Flipkart: the app's own search link, pinned to the app with a browser fallback the phone can read", async () => {
      for (const [service, pkg, host, q] of [
        ["amazon", "in.amazon.mShop.android.shopping", "www.amazon.in/s?k=", "phone cover"],
        ["flipkart", "com.flipkart.android", "www.flipkart.com/search?q=", "phone cover"],
        ["blinkit", "com.grofers.customerapp", "blinkit.com/s/?q=", "milk"],
        ["zepto", "com.zeptoconsumerapp", "www.zeptonow.com/search?query=", "milk"],
      ]) {
        const r = await tool("open_service_app").execute({ service, query: q }, { platform: "android" });
        const url = r.deviceAction.url;
        assert.ok(url.startsWith(`intent://${host}${encodeURIComponent(q)}#Intent;scheme=https;package=${pkg};`), url);
        // The phone's own fallback (assistant_engine.dart _openExternalUrl).
        const fb = url.match(/S\.browser_fallback_url=([^;]+);/);
        assert.strictEqual(decodeURIComponent(fb[1]), `https://${host}${encodeURIComponent(q)}`);
        assert.match(r.speak, /pick the one you want/);
      }
      if (haveApp) {
        const eng = readApp("lib/features/assistant/state/assistant_engine.dart");
        assert.match(eng, /url\.startsWith\('intent:'\)/);
        assert.match(eng, /S\\\.browser_fallback_url=\(\[\^;\]\+\);/);
      }
    });

    await atest("Instacart → Blinkit/Zepto: a grocery task starts on the results in the usual app, or the one they prefer", async () => {
      const r1 = await tool("do_task_in_app").execute({ goal: "add milk to my cart", category: "grocery", query: "milk" },
        ctxFor(B, { userText: "add milk to my cart" }));
      assert.strictEqual(r1.deviceAction.app_name, "blinkit");
      assert.strictEqual(r1.deviceAction.named, false, "the usual pick is not installed for a task when another grocery app is there");
      assert.strictEqual(r1.deviceAction.start_url, "https://blinkit.com/s/?q=milk");
      assert.match(r1.speak, /Blinkit is the usual choice/);
      await svc.finish(B.id, r1.deviceAction.run_id, { reason: "stopped" });
      await db.run(`INSERT INTO agent_memories (user_id, fact, importance, created_at, kind, subject_type, valid, updated_at)
                    VALUES ($1,'I prefer Zepto for groceries',3,$2,'semantic','',1,$2)`, [B.id, Date.now()]);
      const r2 = await tool("do_task_in_app").execute({ goal: "add bread to my cart", category: "grocery", query: "bread" },
        ctxFor(B, { userText: "add bread to my cart" }));
      assert.strictEqual(r2.deviceAction.app_name, "zepto");
      assert.strictEqual(r2.deviceAction.start_url, "https://www.zeptonow.com/search?query=bread");
      assert.match(r2.speak, /you told me you prefer Zepto/);
      await svc.finish(B.id, r2.deviceAction.run_id, { reason: "stopped" });
    });

    await atest("Best Buy / fashion / beauty → Croma, Myntra, Nykaa: a store the owner names is used by name", async () => {
      const croma = await tool("do_task_in_app").execute({ goal: "find a 55 inch TV under 40000", app: "Croma", category: "shopping" },
        ctxFor(B, { userText: "find a 55 inch TV under 40000 on Croma" }));
      assert.strictEqual(croma.deviceAction.app_name, "croma");
      assert.strictEqual(croma.deviceAction.app, "Croma");
      assert.strictEqual(croma.deviceAction.pkg, "", "the phone finds it by name");
      assert.strictEqual(croma.deviceAction.named, true, "a missing named store may be installed (build 117)");
      assert.strictEqual(croma.deviceAction.no_install, false);
      await svc.finish(B.id, croma.deviceAction.run_id, { reason: "stopped" });
      const myntra = await tool("do_task_in_app").execute({ goal: "find white sneakers size 9", category: "shopping" },
        ctxFor(B, { userText: "find white sneakers size 9 on myntra" }));
      assert.strictEqual(myntra.deviceAction.pkg, "com.myntra.android");
      assert.strictEqual(myntra.deviceAction.start_url, "", "Myntra has no search link: the hands search in the app");
      await svc.finish(B.id, myntra.deviceAction.run_id, { reason: "stopped" });
      const nykaa = await tool("open_named_app").execute({ app: "Nykaa" }, ctxFor(B));
      assert.deepStrictEqual(nykaa.deviceAction, { type: "open_any_app", name: "Nykaa", pkg: "", store_if_missing: true, install: false });
    });

    await atest("Expedia → travel apps: a travel task defaults to MakeMyTrip in the app", async () => {
      const r = await tool("do_task_in_app").execute({ goal: "find flights from Bengaluru to Goa on Friday", category: "travel" },
        ctxFor(B, { userText: "find flights from Bengaluru to Goa on Friday" }));
      assert.strictEqual(r.deviceAction.app_name, "makemytrip");
      assert.strictEqual(r.deviceAction.pkg, "com.makemytrip");
      await svc.finish(B.id, r.deviceAction.run_id, { reason: "stopped" });
    });

    await atest("DEFECT: open_service_app makemytrip with a search does not promise results it cannot open", async () => {
      const r = await tool("open_service_app").execute({ service: "makemytrip", query: "flights to Goa" }, { platform: "android" });
      const landsOnSearch = /goa/i.test(decodeURIComponent(r.deviceAction.url));
      const promisesSearch = /for flights to Goa — pick the one you want/.test(r.speak);
      assert.ok(landsOnSearch || !promisesSearch,
        `the link opens MakeMyTrip's HOME page (${r.deviceAction.url}) while the assistant says "${r.speak}" — ` +
        "deeplinks.js shop() marks precision 'search' whenever a query is given, even for makemytrip whose path ignores it");
    });

    await atest("PayPal → UPI: no saved ID asks once; a saved ID pre-fills the UPI app; the PIN is the owner's", async () => {
      const ask = await registry.execute("pay_by_upi", { payee: "Suresh", amount: 500 }, ctxFor(A));
      assert.strictEqual(ask.ok, false);
      assert.strictEqual(ask.error, "need_upi_id");
      assert.ok(!ask.deviceAction);
      const saved = await registry.execute("save_upi_id", { person: "Amma", upi_id: "98450 12345@YBL" }, ctxFor(A));
      assert.strictEqual(saved.ok, true, JSON.stringify(saved));
      assert.strictEqual(saved.data.upi_id, "9845012345@ybl");
      const pay = await registry.execute("pay_by_upi", { payee: "amma", amount: 1500, note: "groceries & milk" }, ctxFor(A));
      assert.strictEqual(pay.ok, true, JSON.stringify(pay));
      assert.strictEqual(pay.deviceAction.url, "upi://pay?pa=9845012345@ybl&pn=amma&am=1500.00&cu=INR&tn=groceries%20%26%20milk");
      assert.match(pay.speak, /approve with your PIN/);
      assert.doesNotMatch(pay.speak, /\bpaid\b|\bsent\b/i);
      const row = await db.one(`SELECT upi_id FROM clients WHERE user_id=$1 AND lower(name)='amma'`, [A.id]);
      assert.strictEqual(row.upi_id, "9845012345@ybl");
      assert.match((await registry.execute("pay_by_upi", { payee: "Amma", amount: 150000 }, ctxFor(A))).error, /between/);
      const bad = await registry.execute("save_upi_id", { person: "X", upi_id: "not-an-id" }, ctxFor(A));
      assert.strictEqual(bad.ok, false);
    });

    await atest("PayPal → UPI: after reading a web page the payment needs a yes, and a scheduled task can never pay", async () => {
      const t = await registry.execute("pay_by_upi", { payee: "Amma", amount: 700 }, { ...ctxFor(A), __untrustedAt: Date.now() });
      assert.strictEqual(t.needsConfirmation, true);
      assert.match(t.summary, /Pay ₹700 to Amma by UPI/);
      const bg = await registry.execute("pay_by_upi", { payee: "Amma", amount: 700 }, { ...ctxFor(A), background: true });
      assert.strictEqual(bg.ok, false);
      assert.match(bg.error, /cannot run unattended/);
      if (haveApp) {
        const man = readApp("android/app/src/main/AndroidManifest.xml");
        assert.match(man, /<data android:scheme="upi"\/>/, "Android 11+ must be able to see a UPI app");
      }
    });

    await atest("payment connectors that need a partner stay hidden: collect_payment, calling a business, one-time cards", () => {
      const names = new Set(registry.declarations({}).map((x) => x.name));
      for (const n of ["collect_payment", "book_by_calling_business", "arrange_meeting_with"]) {
        assert.ok(!names.has(n), `${n} must not be offered`);
      }
      assert.ok(names.has("pay_by_upi") && names.has("do_task_in_app") && names.has("open_service_app"));
    });

    /* ============================================================== *
     * 5 · META: WHATSAPP AND INSTAGRAM
     * ============================================================== */
    console.log("\nmeta · WhatsApp and Instagram");

    await atest("WhatsApp: a contact synced from the phone gets a pre-written chat, the owner taps Send", async () => {
      const sync = await http("POST", "/contacts/sync", { token: A.token,
        body: { contacts: [{ name: "Ravi Shankar", phone: "+91 98450 12345" }, { name: "", phone: "123" }] } });
      assert.strictEqual(sync.status, 200);
      assert.strictEqual(sync.body.stored, 1);
      const r = await registry.execute("send_whatsapp_message", { to: "Ravi Shankar", message: "Running 10 minutes late" }, ctxFor(A));
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.deviceAction.type, "open_url");
      assert.match(r.deviceAction.url, /^whatsapp:\/\/send\?phone=\+?919845012345&text=Running%2010%20minutes%20late$/);
      assert.match(r.speak, /just tap send/);
      assert.doesNotMatch(r.speak, /\bsent\b/i);
      const g = await registry.execute("send_whatsapp_message", { to: "Family", is_group: true, message: "Dinner at 8" }, ctxFor(A));
      assert.strictEqual(g.deviceAction.url, "whatsapp://send?text=Dinner%20at%208");
      if (haveApp) {
        assert.match(readApp("android/app/src/main/AndroidManifest.xml"), /<data android:scheme="whatsapp"\/>/);
      }
    });

    await atest("WhatsApp calls: 'call Ravi on WhatsApp' goes to the phone with via=whatsapp, and the phone has the handler", async () => {
      const r = await registry.execute("place_phone_call", { name: "Ravi", via: "whatsapp" }, { ...ctxFor(A), approved: true });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.deviceAction.type, "resolve_and_call");
      assert.strictEqual(r.deviceAction.via, "whatsapp");
      if (haveApp) {
        const eng = readApp("lib/features/assistant/state/assistant_engine.dart");
        assert.match(eng, /case 'resolve_and_call':/);
        assert.match(eng, /CallService\.instance\.whatsappCall\(/);
        const main = readKt("MainActivity.kt");
        assert.match(main, /"whatsappCall" ->/);
        assert.match(main, /vnd\.android\.cursor\.item\/vnd\.com\.whatsapp\.voip\.call/);
      }
    });

    await atest("Instagram: 'follow Virat Kohli on Instagram' starts on the looked-up official handle", async () => {
      const out = await tool("do_task_in_app").execute({ goal: "follow Virat Kohli on Instagram", category: "other" },
        ctxFor(A, { userText: "follow Virat Kohli on Instagram" }));
      assert.strictEqual(out.ok, true, JSON.stringify(out));
      const d = out.deviceAction;
      assert.strictEqual(d.app_name, "instagram");
      assert.strictEqual(d.pkg, "com.instagram.android");
      assert.strictEqual(d.named, true);
      assert.strictEqual(d.start_url, "", "Instagram profile links open blank from outside: the hands search the handle");
      const row = await runRow(d.run_id);
      const notes = JSON.parse(row.notes);
      assert.ok(notes.some((n) => n.handle === "virat.kohli" && n.confident === true && n.owner === false));
      assert.ok(notes.some((n) => n.owner === true && /@virat\.kohli/.test(n.text)));
      await svc.finish(A.id, d.run_id, { reason: "stopped" });
    });

    await atest("Instagram: opening a person's profile says plainly when the handle could not be confirmed", async () => {
      const r = await tool("open_app").execute({ app: "instagram", person: "Virat Kohli" }, ctxFor(A));
      assert.strictEqual(r.deviceAction.url, "https://www.instagram.com/virat.kohli/");
      assert.match(r.speak, /couldn't confirm it's the right one/);
      const none = await tool("open_app").execute({ app: "instagram", person: "Some Unknown Person" }, ctxFor(A));
      assert.match(none.deviceAction.url, /^https:\/\/www\.google\.com\/search\?tbm=isch&q=/);
    });

    await atest("connected apps: 'open X' lets the phone decide; install only on the owner's word; an old app is told to update", async () => {
      const t = tool("open_named_app");
      const sw = await t.execute({ app: "the Swiggy app" }, ctxFor(A));
      assert.deepStrictEqual(sw.deviceAction, { type: "open_any_app", name: "Swiggy", pkg: "in.swiggy.android", store_if_missing: true, install: false });
      const inst = await t.execute({ app: "Zomato", install: true }, ctxFor(A));
      assert.strictEqual(inst.deviceAction.install, true);
      const old = await t.execute({ app: "Swiggy" }, { ...ctxFor(A), appBuild: 20 });
      assert.strictEqual(old.deviceAction.type, "open_url", "a very old app still gets the deep link");
      const oldUnknown = await t.execute({ app: "Croma" }, { ...ctxFor(A), appBuild: 20 });
      assert.strictEqual(oldUnknown.error, "app_too_old");
      if (haveApp) assert.match(readApp("lib/features/assistant/state/assistant_engine.dart"), /case 'open_any_app':/);
    });

    /* ============================================================== *
     * 6 · THIRD-PARTY COORDINATION (hand-offs)
     * ============================================================== */
    console.log("\nproductivity · third-party service coordination");

    await atest("food, ride and cinema hand off to the app at the right place and file a task; nothing claims it was booked", async () => {
      const food = await registry.execute("order_food", { dish: "chicken biryani" }, ctxFor(B));
      assert.strictEqual(food.ok, true, JSON.stringify(food));
      assert.match(food.deviceAction.url, /^intent:\/\/www\.swiggy\.com\/search\?query=chicken%20biryani#Intent;scheme=https;package=in\.swiggy\.android;/);
      const ride = await registry.execute("book_ride", { destination: "the airport" }, { ...ctxFor(B), lat: 12.9716, lng: 77.5946 });
      assert.strictEqual(ride.ok, true, JSON.stringify(ride));
      assert.match(ride.deviceAction.url, /dropoff\[latitude\]=13\.1986&dropoff\[longitude\]=77\.7066/);
      assert.match(ride.deviceAction.url, /pickup\[latitude\]=12\.9716/);
      assert.match(ride.deviceAction.url, /package=com\.ubercab;/);
      assert.match(ride.speak, /already set — confirm it/);
      const movie = await registry.execute("book_movie_tickets", { title: "Kantara", city: "Bengaluru" }, ctxFor(B));
      assert.match(movie.deviceAction.url, /in\.bookmyshow\.com\/explore\/search\?q=Kantara/);
      for (const r of [food, ride, movie]) assert.doesNotMatch(r.speak, /\b(?:ordered|booked|placed|confirmed)\b/i);
      const rows = await db.query(`SELECT kind, provider, status, deep_link FROM fulfillment_tasks WHERE user_id=$1 AND path='handoff' ORDER BY id`, [B.id]);
      assert.deepStrictEqual(rows.map((x) => [x.kind, x.provider, x.status]),
        [["food", "swiggy", "handed_off"], ["ride", "uber", "handed_off"], ["movie", "bookmyshow", "handed_off"]]);
      assert.strictEqual(rows[0].deep_link, food.deviceAction.url);
      // …and the hand-off feeds the next pick.
      const pick = await prefs.pickApp(B.id, "food", "");
      assert.match(pick.reason, /you used Swiggy last time/);
    });

    /* ============================================================== *
     * 7 · THE APP SIDE, READ STATICALLY
     * ============================================================== */
    console.log("\nthe app side (Dart + Kotlin), statically");

    await atest("every server directive field is one the app reads, and the app reads nothing the server leaves out", () => {
      if (!haveApp) return;
      const fake = { id: 7, goal: "g", app_label: "Swiggy", app_name: "swiggy", category: "food", app_reason: "you asked for Swiggy",
        app_pkg: SW, start_url: "", web: false, steps: [], notes: [] };
      const keys = Object.keys(svc.directive(fake)).filter((k) => k !== "type");
      const dart = readApp("lib/services/automation_runner.dart");
      const body = dart.slice(dart.indexOf("static AutomationDirective? fromEvent"), dart.indexOf("class AutomationOutcome"));
      const read = new Set([...body.matchAll(/e\['(\w+)'\]/g)].map((m) => m[1]));
      assert.deepStrictEqual(keys.filter((k) => !read.has(k)), [], "sent but never read by the app");
      assert.deepStrictEqual([...read].filter((k) => !keys.includes(k)), [], "read by the app but never sent");
      const eng = readApp("lib/features/assistant/state/assistant_engine.dart");
      // (The app's sources use CRLF line endings.)
      assert.match(eng, /case 'automate':\s*(?:\/\/[^\n]*\n\s*)*unawaited\(_runAutomation\(e\)\)/);
    });

    await atest("every channel method the Dart loop calls is handled by AutomationBridge.kt", () => {
      if (!haveApp) return;
      const dart = readApp("lib/services/automation_runner.dart");
      const dev = dart.slice(dart.indexOf("class ChannelAutomationDevice"), dart.indexOf("class HttpAutomationApi"));
      const called = new Set([...dev.matchAll(/invokeMethod\('(\w+)'/g)].map((m) => m[1]));
      const eng = readApp("lib/features/assistant/state/assistant_engine.dart");
      for (const m of eng.matchAll(/MethodChannel\('hari\/automation'\)\s*\.invokeMethod<\w+>\('(\w+)'/g)) called.add(m[1]);
      const kt = readKt("AutomationBridge.kt");
      const handled = new Set([...kt.matchAll(/^\s*"(\w+)" ->/gm)].map((m) => m[1]));
      assert.ok(called.size >= 15, `found only ${called.size} calls`);
      assert.deepStrictEqual([...called].filter((c) => !handled.has(c)), []);
      // …and the HTTP paths the loop posts to are the server's routes.
      assert.match(dart, /'\/automation\/\$runId\/step'/);
      assert.match(dart, /'\/automation\/\$runId\/finish'/);
      assert.match(dart, /'\/automation\/\$runId\/owner_done'/);
    });

    await atest("install-for-task (build 117): only a named app, never a money app, and the install outcomes line up", () => {
      if (!haveApp) return;
      const dart = readApp("lib/services/automation_runner.dart");
      assert.match(dart, /if \(_money\(d\)\) \{\s*await _finish\(d\.runId, 'not_installed'\);\s*return \(kind: 'money'/);
      assert.match(dart, /if \(!d\.named\) \{/);
      const bridge = readKt("AutomationBridge.kt");
      assert.match(bridge, /HariAccessibilityService\.never\(pkg\)/, "the phone refuses a money app's install too");
      const kt = readKt("HariAccessibilityService.kt");
      // done(<text or an if-expression>, "<outcome>") — the outcome is the last argument.
      const outcomes = new Set([...kt.matchAll(/\bdone\([^\n]*?,\s*"(\w+)"\)\s*$/gm),
        ...kt.matchAll(/installOutcome = "(\w+)"/g)].map((m) => m[1]));
      for (const o of ["installed", "already", "paid", "sign_in", "stopped", "timeout"]) {
        assert.ok(outcomes.has(o), `Kotlin never reports '${o}'`);
        assert.match(dart, new RegExp(`'${o}'`), `Dart does not handle '${o}'`);
      }
      // Server side of the same rule.
      const named = svc.directive({ id: 1, goal: "g", app_label: "Zomato", app_name: "zomato", app_reason: "you asked for Zomato", steps: [] });
      const usual = svc.directive({ id: 1, goal: "g", app_label: "Swiggy", app_name: "swiggy", app_reason: "Swiggy is the usual choice for this", steps: [] });
      const money = svc.directive({ id: 1, goal: "g", app_label: "Google Pay", app_name: "google pay", app_reason: "you asked for Google Pay", steps: [] });
      assert.strictEqual(named.named, true);
      assert.strictEqual(usual.named, false);
      assert.strictEqual(money.no_install, true);
    });

    await atest("DEFECT: the 'use Zomato instead' retry (build 117) actually starts a run — it is not swallowed as a repeat", async () => {
      // Live voice, one socket session: "order veg biryani" → do_task_in_app
      // picks Swiggy (the usual choice, not named). The phone finds Swiggy
      // missing and Zomato installed (automation_runner.dart appPlan →
      // 'other'), closes that run and sends useInsteadNote, which tells the
      // model to call do_task_in_app "again now with app Zomato, the same
      // goal and the same query" — seconds later, in the same session.
      const sessionState = require("../src/agents/sessionState");
      const sid = `live:g3-${Date.now()}`;
      const st = sessionState.begin(E.id, sid, { surface: "live", appBuild: 118 });
      const liveCtx = (turnId) => ({ session: st, sessionId: sid, turnId, source: "live", userId: E.id,
        platform: "android", appBuild: 118, userText: "order veg biryani", inputQuality: { quality: "clear" } });
      const first = await registry.execute("do_task_in_app",
        { goal: "order veg biryani", category: "food", query: "veg biryani" }, liveCtx("t1"));
      assert.strictEqual(first.ok, true, JSON.stringify(first));
      assert.strictEqual(first.deviceAction.app_name, "swiggy");
      assert.strictEqual(first.deviceAction.named, false);
      // The phone: Swiggy is not installed, Zomato is → the run is closed.
      await http("POST", `/automation/${first.deviceAction.run_id}/finish`, { token: E.token, body: { reason: "not_installed" } });
      const retry = await registry.execute("do_task_in_app",
        { goal: "order veg biryani", app: "Zomato", category: "food", query: "veg biryani" }, liveCtx("t2"));
      assert.ok(retry.deviceAction && retry.deviceAction.app_name === "zomato",
        `the retry in Zomato never reaches the phone: ${JSON.stringify({ ok: retry.ok, repeated: retry.repeated, note: retry.note })}. ` +
        "registry.js GATE 2 TIER 2 matches it to the first call by actions.targetOf() = the query \"veg biryani\" " +
        "(do_task_in_app is in SEED_REPEAT, window 20 s), so the model is told it is \"already under way\" and nothing runs.");
    });

    await atest("DEFECT: on the typed (non-Live) path the phone's 'use Zomato instead' note starts the task in Zomato, not the missing app it names", async () => {
      // The exact line AssistantEngine.useInsteadNote(d, 'Zomato') sends
      // with _tellModel when Swiggy (the usual pick, not named) is missing
      // and Zomato is installed. Off Live, _tellModel posts it to
      // /assistant/:sid/message, so it becomes ctx.userText.
      if (haveApp) {
        assert.match(readApp("lib/features/assistant/state/assistant_engine.dart"),
          /is not installed on this phone, but \$alt \(the same '\s*\n\s*'kind of app\) is, and the user did not name \$app\. Call do_task_in_app '\s*\n\s*'again now with app "\$alt"/);
      }
      const note = '[SYSTEM] Swiggy is not installed on this phone, but Zomato (the same kind of app) is, and the user ' +
        'did not name Swiggy. Call do_task_in_app again now with app "Zomato", the same goal and the same query. ' +
        "Do not ask anything first.";
      toolModel = [
        { functionCalls: [{ name: "do_task_in_app", args: { goal: "order veg biryani", app: "Zomato", category: "food", query: "veg biryani" } }] },
        { text: "On it." },
      ];
      const events = await typedTurn(D, note, (e) => e.type === "automate");
      const d = events.find((e) => e.type === "automate");
      assert.ok(d, `no automate event; saw ${events.map((e) => e.type + (e.text ? `:${e.text}` : "")).join(" | ")}`);
      assert.strictEqual(d.app_name, "zomato",
        `the model asked for Zomato but do_task_in_app took prefs.appNamedIn(ctx.userText) = "${d.app_name}" from the ` +
        `[SYSTEM] note (builtins.js do_task_in_app: const named = appNamedIn(ctx.userText); app = named || args.app). ` +
        `The directive says named=${d.named}, so automation_runner.dart appPlan() returns 'install' and the phone ` +
        "installs Swiggy — an app the owner never named — while Zomato is on the phone.");
    });
  } finally {
    server.close();
    // Self-cleaning: every row of every table keyed by these users, then the users.
    try {
      await purge(USERS.map((u) => u.id));
    } catch (e) {
      console.error("cleanup failed:", e.message);
    }
  }

  if (blocked.length) console.log(`\n(network blocked ${blocked.length}x: ${[...new Set(blocked)].join(", ")})`);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log(`failed: ${failures.join(" | ")}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
