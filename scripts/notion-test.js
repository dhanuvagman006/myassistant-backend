/**
 * CONNECTED APPS: NOTION — `npm run test:notion`.
 *
 * Notion's REST API is replaced by an in-process fake (global.fetch for
 * api.notion.com only): nothing leaves this machine, no real workspace is
 * touched. These pin:
 *   - off without credentials: no card, no start, no tools;
 *   - the OAuth round trip: state stored only as a hash, single use, ten
 *     minutes; the code exchanged on the server with Basic auth; the app
 *     gets a result word, never a code or a token; tokens encrypted;
 *   - tools offered only to a connected user on build 120 (fail closed);
 *   - writes: resolved and PINNED before the card; strict in live voice
 *     (no fuzzy guess is ever written to); ids validated before any URL;
 *   - refresh on 401 (one, shared), 429, and a write that times out is
 *     never retried; a dead grant hides the tools;
 *   - the injection gates, unattended block, disconnect, claim check,
 *     the MCP catalog, and account erasure.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "notion-test-secret-0123456789";
delete process.env.NOTION_API_VERSION;
delete process.env.NOTION_REDIRECT_URI;

const assert = require("assert");
const crypto = require("crypto");
const express = require("express");
const db = require("../src/db");

require("../src/services/firebase").deletePhoneUser = async () => "stubbed";

let passed = 0;
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
}

const CREDS = () => {
  process.env.NOTION_CLIENT_ID = "test-client-id";
  process.env.NOTION_CLIENT_SECRET = "test-client-secret";
  process.env.PUBLIC_BASE_URL = "https://api.example.test";
};
const NO_CREDS = () => {
  delete process.env.NOTION_CLIENT_ID;
  delete process.env.NOTION_CLIENT_SECRET;
};

/* ------------------------------------------------------------------ */
/* The fake Notion                                                     */
/* ------------------------------------------------------------------ */

const hex = () => crypto.randomBytes(16).toString("hex");
const dashed = (h) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
const N = {
  pages: new Map(), // id -> {id,title,blocks:[],markdown}
  sources: new Map(), // id -> {id,title,properties,rows:[]}
  valid: new Set(), // live access tokens
  refreshes: new Map(), // refresh token -> true (valid)
  revoked: [],
  calls: [],
  tokenBodies: [],
  queue: [], // one-shot overrides: (req) => Response | undefined
  n: 0,
  workspace: { id: "ws-1", name: "Asha's Notion" },
};
function page(title, extra = {}) {
  const id = dashed(hex());
  N.pages.set(id, { id, title, blocks: [], markdown: `# ${title}\nSome text.`, ...extra });
  return id;
}
function source(title) {
  const id = dashed(hex());
  N.sources.set(id, {
    id, title, rows: [],
    properties: { Task: { type: "title" }, Due: { type: "date" }, Status: { type: "status" } },
  });
  return id;
}
const pageObj = (p) => ({
  object: "page", id: p.id, url: `https://www.notion.so/${p.id.replace(/-/g, "")}`,
  last_edited_time: "2026-09-25T10:00:00.000Z", in_trash: false,
  properties: { Name: { type: "title", title: [{ plain_text: p.title }] } },
});
const srcObj = (s) => ({
  object: "data_source", id: s.id, url: "", title: [{ plain_text: s.title }],
  last_edited_time: "2026-09-24T10:00:00.000Z", properties: s.properties,
});
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith("https://api.notion.com/")) return realFetch(url, opts);
  const path = u.slice("https://api.notion.com/v1".length);
  const req = {
    method: opts.method || "GET", path, headers: opts.headers || {},
    body: opts.body ? JSON.parse(opts.body) : null,
  };
  N.calls.push(req);
  for (let i = 0; i < N.queue.length; i++) {
    const fn = N.queue[i];
    let r;
    try { r = await fn(req); } catch (e) { N.queue.splice(i, 1); throw e; }
    if (r) { N.queue.splice(i, 1); return r; }
  }
  if (path === "/oauth/token") {
    N.tokenBodies.push({ ...req.body, auth: req.headers.Authorization });
    if (req.body.grant_type === "refresh_token" && !N.refreshes.has(req.body.refresh_token)) {
      return json(400, { error: "invalid_grant" });
    }
    if (req.body.grant_type === "refresh_token") N.refreshes.delete(req.body.refresh_token);
    const k = ++N.n;
    N.valid.add(`acc-${k}`);
    N.refreshes.set(`ref-${k}`, true);
    return json(200, {
      access_token: `acc-${k}`, refresh_token: `ref-${k}`, bot_id: `bot-${k}`,
      workspace_id: N.workspace.id, workspace_name: N.workspace.name, workspace_icon: "",
      owner: { type: "user", user: { id: "u1", person: { email: "never-stored@example.test" } } },
    });
  }
  if (path === "/oauth/revoke") {
    N.revoked.push(req.body.token);
    N.valid.delete(req.body.token);
    return json(200, {});
  }
  const token = String(req.headers.Authorization || "").replace(/^Bearer /, "");
  if (!N.valid.has(token)) return json(401, { code: "unauthorized", message: "API token is invalid." });

  if (path === "/search" && req.method === "POST") {
    const q = String(req.body.query || "").toLowerCase();
    const want = req.body.filter && req.body.filter.value;
    const results = [];
    if (want !== "data_source") for (const p of N.pages.values()) if (p.title.toLowerCase().includes(q)) results.push(pageObj(p));
    if (want !== "page") for (const s of N.sources.values()) if (s.title.toLowerCase().includes(q)) results.push(srcObj(s));
    return json(200, { results: results.slice(0, req.body.page_size || 10) });
  }
  let m;
  if ((m = /^\/pages\/([0-9a-f-]{36})\/markdown$/.exec(path))) {
    const p = N.pages.get(m[1]);
    return p ? json(200, { markdown: p.markdown, truncated: false }) : json(404, { code: "object_not_found" });
  }
  if ((m = /^\/pages\/([0-9a-f-]{36})$/.exec(path))) {
    const p = N.pages.get(m[1]);
    return p ? json(200, pageObj(p)) : json(404, { code: "object_not_found" });
  }
  if ((m = /^\/blocks\/([0-9a-f-]{36})\/children$/.exec(path)) && req.method === "PATCH") {
    const p = N.pages.get(m[1]);
    if (!p) return json(404, { code: "object_not_found" });
    p.blocks.push(...req.body.children);
    return json(200, { results: req.body.children });
  }
  if ((m = /^\/data_sources\/([0-9a-f-]{36})\/query$/.exec(path))) {
    const s = N.sources.get(m[1]);
    return s ? json(200, { results: s.rows, has_more: false }) : json(404, { code: "object_not_found" });
  }
  if ((m = /^\/data_sources\/([0-9a-f-]{36})$/.exec(path))) {
    const s = N.sources.get(m[1]);
    return s ? json(200, srcObj(s)) : json(404, { code: "object_not_found" });
  }
  if (/^\/databases\//.test(path)) return json(404, { code: "object_not_found" });
  if (path === "/pages" && req.method === "POST") {
    const parent = req.body.parent;
    if (parent.type === "data_source_id") {
      const s = N.sources.get(parent.data_source_id);
      if (!s) return json(404, { code: "object_not_found" });
      const row = { object: "page", id: dashed(hex()), properties: req.body.properties };
      s.rows.push(row);
      return json(200, row);
    }
    const id = page(req.body.properties.title.title.map((t) => t.text.content).join(""), { parent: parent.page_id });
    return json(200, { ...pageObj(N.pages.get(id)), url: "https://www.notion.so/new" });
  }
  return json(400, { code: "validation_error", message: `fake: ${req.method} ${path}` });
};
const writes = () => N.calls.filter((c) => c.method === "PATCH" || (c.method === "POST" && c.path === "/pages"));
const clearCalls = () => { N.calls.length = 0; };

/* ------------------------------------------------------------------ */

(async () => {
  await db.init();
  const store = require("../src/connectors/notion/store");
  const registry = require("../src/tools/registry");
  require("../src/tools/builtins").registerBuiltins();
  const { decryptSecrets } = require("../src/mcp/schema");

  const stamp = String(Date.now()).slice(-7);
  const mk = async (tag) => (await db.createUser({ email: `nt-${tag}-${stamp}@example.test`, name: `Notion ${tag}` })).id;
  const A = await mk("a"); // connects
  const B = await mk("b"); // never connects
  const C = await mk("c"); // hammers start
  const D = await mk("d"); // failed callbacks
  const E = await mk("e"); // erased
  const USERS = [A, B, C, D, E];

  const as = (req, _res, next) => { req.user = { sub: String(req.get("x-test-user") || "") }; next(); };
  const notion = require("../src/connectors/notion/routes");
  const app = express();
  app.use(express.json());
  app.use("/connect/notion", notion.publicRouter);
  app.use("/connections", as, notion.appRouter);
  app.use("/mcp", as, require("../src/mcp/routes"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (uid, p, opts = {}) => realFetch(`${base}${p}`, {
    ...opts, redirect: "manual",
    headers: { ...(opts.json ? { "content-type": "application/json" } : {}), "x-test-user": String(uid) },
    body: opts.json ? JSON.stringify(opts.json) : undefined,
  });
  const cb = (qs) => realFetch(`${base}/connect/notion/callback?${qs}`, { redirect: "manual" });
  const stateOf = (authUrl) => new URL(authUrl).searchParams.get("state");
  const start = async (uid) => (await call(uid, "/connections/notion/start", { method: "POST" })).json();
  const names = (uid, build) => registry.declarations({ userId: uid, deviceCaps: { build } })
    .map((d) => d.name).filter((n) => n.startsWith("notion_")).sort();
  const ctxOf = (uid, extra = {}) => ({ userId: uid, appBuild: 120, deviceCaps: { build: 120 }, ...extra });

  console.log("\noff until the owner adds credentials");

  await atest("no credentials: no card, no start, no tools, and prime() reads nothing", async () => {
    NO_CREDS();
    const r = await (await call(A, "/connections")).json();
    assert.strictEqual(r.connections[0].id, "notion");
    assert.strictEqual(r.connections[0].available, false);
    assert.strictEqual((await call(A, "/connections/notion/start", { method: "POST" })).status, 503);
    store._cache.clear();
    await store.prime(A);
    assert.strictEqual(store._cache.has(A), false, "prime queried without credentials");
    assert.deepStrictEqual(names(A, 120), []);
  });

  CREDS();
  const groceries = page("Groceries");
  const groceries25 = page("Groceries 2025");
  const travel = page("Travel");
  const tasks = source("Tasks");

  console.log("\nconnecting");

  let firstAccess;
  await atest("start: a consent URL for this user; only the hash of the state is stored", async () => {
    const r = await start(A);
    const u = new URL(r.authUrl);
    assert.strictEqual(u.origin + u.pathname, "https://api.notion.com/v1/oauth/authorize");
    assert.strictEqual(u.searchParams.get("owner"), "user");
    assert.strictEqual(u.searchParams.get("response_type"), "code");
    assert.strictEqual(u.searchParams.get("redirect_uri"), "https://api.example.test/connect/notion/callback");
    assert.strictEqual(r.callbackScheme, "com.myassistant.myassistant");
    const state = stateOf(r.authUrl);
    assert.ok(state && state.length >= 40);
    const rows = await db.query(`SELECT state_hash FROM connector_oauth_states WHERE user_id = $1`, [A]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].state_hash, crypto.createHash("sha256").update(state).digest("hex"));
    assert.notStrictEqual(rows[0].state_hash, state);

    // The callback: code exchanged here, with Basic auth and the redirect URI.
    N.tokenBodies.length = 0;
    const res = await cb(`code=the-code&state=${encodeURIComponent(state)}`);
    assert.strictEqual(res.status, 302);
    const loc = res.headers.get("location");
    assert.strictEqual(loc, "com.myassistant.myassistant://connected?app=notion&result=ok");
    assert.ok(!/code|acc-|ref-/.test(loc));
    assert.strictEqual(res.headers.get("cache-control"), "no-store");
    assert.strictEqual(res.headers.get("referrer-policy"), "no-referrer");
    const tb = N.tokenBodies[0];
    assert.strictEqual(tb.grant_type, "authorization_code");
    assert.strictEqual(tb.code, "the-code");
    assert.strictEqual(tb.redirect_uri, "https://api.example.test/connect/notion/callback");
    assert.strictEqual(tb.auth, "Basic " + Buffer.from("test-client-id:test-client-secret").toString("base64"));

    const row = await db.one(`SELECT * FROM notion_connections WHERE user_id = $1`, [A]);
    assert.strictEqual(row.status, "connected");
    assert.strictEqual(row.workspace_name, "Asha's Notion");
    const sec = decryptSecrets(row.secrets_enc);
    assert.ok(/^acc-\d+$/.test(sec.access_token) && /^ref-\d+$/.test(sec.refresh_token));
    firstAccess = sec.access_token;
    const { secrets_enc: _s, ...rest } = row;
    const flat = JSON.stringify(rest);
    assert.ok(!flat.includes(sec.access_token) && !flat.includes(sec.refresh_token), "a token outside secrets_enc");
    assert.ok(!flat.includes("never-stored"), "the owner's email was stored");
    const card = (await (await call(A, "/connections")).json()).connections[0];
    assert.deepStrictEqual([card.status, card.workspace], ["connected", "Asha's Notion"]);
    assert.ok(!JSON.stringify(card).includes("acc-"));
  });

  await atest("more than 5 starts in ten minutes → 429", async () => {
    for (let i = 0; i < 5; i++) assert.ok((await start(C)).authUrl);
    const r = await call(C, "/connections/notion/start", { method: "POST" });
    assert.strictEqual(r.status, 429);
  });

  await atest("a replayed, expired, unknown or declined state connects nothing", async () => {
    const reason = (loc) => new URL(loc.replace("com.myassistant.myassistant://", "https://x/")).searchParams;
    const s1 = stateOf((await start(D)).authUrl);
    await db.run(`UPDATE connector_oauth_states SET expires_at = $2 WHERE user_id = $1`, [D, Date.now() - 1]);
    let p = reason((await cb(`code=x&state=${s1}`)).headers.get("location"));
    assert.deepStrictEqual([p.get("result"), p.get("reason")], ["error", "expired"]);
    p = reason((await cb(`code=x&state=nonsense`)).headers.get("location"));
    assert.deepStrictEqual([p.get("result"), p.get("reason")], ["error", "expired"]);
    const s2 = stateOf((await start(D)).authUrl);
    p = reason((await cb(`error=access_denied&state=${s2}`)).headers.get("location"));
    assert.strictEqual(p.get("result"), "cancelled");
    // …and that consumed it: a replay is expired.
    p = reason((await cb(`code=x&state=${s2}`)).headers.get("location"));
    assert.deepStrictEqual([p.get("result"), p.get("reason")], ["error", "expired"]);
    const s3 = stateOf((await start(D)).authUrl);
    N.queue.push((req) => (req.path === "/oauth/token" ? json(400, { error: "invalid_grant" }) : undefined));
    p = reason((await cb(`code=bad&state=${s3}`)).headers.get("location"));
    assert.deepStrictEqual([p.get("result"), p.get("reason")], ["error", "exchange_failed"]);
    assert.strictEqual(await db.one(`SELECT 1 FROM notion_connections WHERE user_id = $1`, [D]), null);
  });

  console.log("\nwho is offered the tools");

  await atest("connected on build 120 → 4 tools; 119, not connected, never primed → none", async () => {
    store._cache.clear();
    assert.deepStrictEqual(names(A, 120), [], "offered before prime (must fail closed)");
    await store.prime(A);
    await store.prime(B);
    assert.deepStrictEqual(names(A, 120), ["notion_add", "notion_create_page", "notion_read_page", "notion_search"]);
    assert.deepStrictEqual(names(A, 119), []);
    assert.deepStrictEqual(names(B, 120), [], "user B saw user A's connection");
  });

  console.log("\nreading");

  await atest("search by title; read a page; both mark the turn untrusted", async () => {
    const ctx = ctxOf(A);
    const s = await registry.execute("notion_search", { query: "groceries" }, ctx);
    assert.strictEqual(s.ok, true, JSON.stringify(s));
    assert.deepStrictEqual(s.data.results.map((r) => r.title).sort(), ["Groceries", "Groceries 2025"]);
    const ctx2 = ctxOf(A);
    const r = await registry.execute("notion_read_page", { page: "Travel" }, ctx2);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.match(r.data.text, /Some text/);
    assert.ok(registry.turnIsUntrusted(ctx2));
    assert.strictEqual(registry.requiresConfirmation("send_whatsapp_message", ctx2), true);
    const none = await registry.execute("notion_search", { query: "zzz-nothing" }, ctxOf(A));
    assert.deepStrictEqual(none.data.results, []);
    assert.match(none.note, /Connections/);
  });

  console.log("\nwriting: the card surfaces pin the page");

  await atest("prepare: exact title resolves and pins; nothing is written before a yes", async () => {
    clearCalls();
    const r = await registry.execute("notion_add",
      { target: "groceries", items: ["milk", "eggs", "bread", "rice", "dal"], style: "todo" }, ctxOf(A));
    assert.strictEqual(r.needsConfirmation, true, JSON.stringify(r));
    assert.strictEqual(r.args.target_id, groceries);
    assert.strictEqual(r.args.target_title, "Groceries");
    assert.strictEqual(r.summary, 'Add 5 items to "Groceries" in your Notion: milk, eggs, bread, and 2 more');
    assert.strictEqual(writes().length, 0);
  });

  await atest("two partial matches name both; none gives the share hint", async () => {
    const two = await registry.execute("notion_add", { target: "grocer", items: ["milk"] }, ctxOf(A));
    assert.strictEqual(two.ok, false);
    assert.match(two.error, /"Groceries" and "Groceries 2025"/);
    const none = await registry.execute("notion_add", { target: "Holidays", items: ["milk"] }, ctxOf(A));
    assert.match(none.error, /Connections → Hari Assistant/);
    assert.strictEqual(writes().length, 0);
  });

  await atest("the approved card writes to the pinned page, even if a twin appears", async () => {
    const prep = await registry.execute("notion_add",
      { target: "Groceries", items: ["milk", "x".repeat(4500)], style: "todo" }, ctxOf(A));
    page("Groceries"); // a second page with the same title, shared in between
    clearCalls();
    const r = await registry.execute("notion_add", prep.args, ctxOf(A, { approved: true }));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const w = writes();
    assert.strictEqual(w.length, 1);
    assert.strictEqual(w[0].path, `/blocks/${groceries}/children`);
    assert.deepStrictEqual(w[0].body.position, { type: "end" });
    assert.strictEqual(w[0].headers["Notion-Version"], "2026-03-11");
    assert.strictEqual(w[0].body.children[0].type, "to_do");
    assert.strictEqual(w[0].body.children[1].to_do.rich_text.length, 3, "4500 chars not split in 3");
  });

  await atest("21 items are refused", async () => {
    const r = await registry.execute("notion_add",
      { target: "Travel", items: Array.from({ length: 21 }, (_, i) => `i${i}`) }, ctxOf(A));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /up to 20/);
  });

  await atest("a database row: title property filled, due in the date property", async () => {
    const prep = await registry.execute("notion_add",
      { target: "Tasks", items: ["Call the plumber"], due: "2026-09-28" }, ctxOf(A));
    assert.strictEqual(prep.summary, 'Add "Call the plumber" to "Tasks" in your Notion (due 28 Sep)');
    clearCalls();
    const r = await registry.execute("notion_add", prep.args, ctxOf(A, { approved: true }));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const post = writes()[0];
    assert.deepStrictEqual(post.body.parent, { type: "data_source_id", data_source_id: tasks });
    assert.strictEqual(post.body.properties.Task.title[0].text.content, "Call the plumber");
    assert.deepStrictEqual(post.body.properties.Due, { date: { start: "2026-09-28" } });
  });

  console.log("\nwriting: live voice resolves strictly after the yes");

  await atest("exact title → written; a single fuzzy hit → ambiguous, nothing written", async () => {
    clearCalls();
    const ok = await registry.execute("notion_add", { target: "travel", items: ["passport"] }, ctxOf(A, { approved: true }));
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    assert.strictEqual(writes()[0].path, `/blocks/${travel}/children`);
    clearCalls();
    const fuzzy = await registry.execute("notion_add", { target: "Groceries 20", items: ["salt"] }, ctxOf(A, { approved: true }));
    assert.strictEqual(fuzzy.ok, false);
    assert.strictEqual(fuzzy.error, "ambiguous");
    assert.strictEqual(writes().length, 0);
  });

  await atest("no target: the last page the user heard named; none → refused", async () => {
    await store.prime(A); // the cache the live session filled at start
    store._cache.get(A).lastTitle = "Travel";
    const s = registry.get("notion_add").confirmSummary({ items: ["sunscreen", "hat"] }, { userId: A });
    assert.strictEqual(s, 'Add sunscreen and hat to "Travel" in your Notion');
    clearCalls();
    const ok = await registry.execute("notion_add", { items: ["sunscreen", "hat"] }, ctxOf(A, { approved: true }));
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    assert.strictEqual(writes()[0].path, `/blocks/${travel}/children`);
    await db.run(`UPDATE notion_connections SET defaults = '{}' WHERE user_id = $1`, [A]);
    store._cache.get(A).lastTitle = "";
    assert.match(registry.get("notion_add").confirmSummary({ items: ["x"] }, { userId: A }), /which page\?$/);
    clearCalls();
    const no = await registry.execute("notion_add", { items: ["x"] }, ctxOf(A, { approved: true }));
    assert.strictEqual(no.ok, false);
    assert.strictEqual(writes().length, 0);
  });

  await atest("an id that is not a Notion id never reaches a URL", async () => {
    clearCalls();
    const r = await registry.execute("notion_add",
      { items: ["x"], target_id: "../users", target_kind: "page" }, ctxOf(A, { approved: true }));
    assert.strictEqual(r.ok, false);
    assert.ok(!N.calls.some((c) => /users/.test(c.path)), "the id reached a path");
  });

  await atest("create a page under a parent, confirmed first", async () => {
    const prep = await registry.execute("notion_create_page",
      { title: "Goa trip", parent: "Travel", content: "- flights\n[ ] book hotel" }, ctxOf(A));
    assert.strictEqual(prep.summary, 'Create the page "Goa trip" under "Travel" in your Notion');
    clearCalls();
    const r = await registry.execute("notion_create_page", prep.args, ctxOf(A, { approved: true }));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const post = writes()[0];
    assert.deepStrictEqual(post.body.parent, { type: "page_id", page_id: travel });
    assert.deepStrictEqual(post.body.children.map((b) => b.type), ["bulleted_list_item", "to_do"]);
  });

  console.log("\ngates");

  await atest("after an email, the card carries the warning (the prepare branch too)", async () => {
    const ctx = ctxOf(A);
    registry.markTurnUntrusted(ctx);
    const r = await registry.execute("notion_add", { target: "Travel", items: ["x"] }, ctx);
    assert.strictEqual(r.needsConfirmation, true);
    assert.match(r.summary, /came up after reading an email or web page/);
  });

  await atest("a scheduled task can read Notion but never write to it", async () => {
    const bg = ctxOf(A, { background: true, approved: true });
    const w = await registry.execute("notion_add", { target: "Travel", items: ["x"] }, bg);
    assert.strictEqual(w.ok, false);
    assert.match(w.error, /unattended/);
    const c = await registry.execute("notion_create_page", { title: "x", parent: "Travel" }, bg);
    assert.match(c.error, /unattended/);
    const s = await registry.execute("notion_search", { query: "Travel" }, ctxOf(A, { background: true }));
    assert.strictEqual(s.ok, true);
  });

  await atest("\"Added it to your Notion\" with nothing run is corrected", async () => {
    const cc = require("../src/agents/claimCheck");
    const bad = cc.check("Added milk to your Notion.", []);
    assert.strictEqual(bad.ok, false);
    assert.match(bad.text, /haven't changed anything in your Notion/);
    assert.strictEqual(cc.check("Added milk to your Notion.", [{ tool: "notion_add", ok: true }]).ok, true);
  });

  await atest("the MCP catalog has no Notion card", async () => {
    const r = await (await call(A, "/mcp/catalog")).json();
    assert.ok(!r.catalog.some((c) => c.id === "notion" || /notion\.com/.test(JSON.stringify(c.config))));
  });

  console.log("\ntokens");

  await atest("401 → exactly one refresh (shared by two calls) → retry; the new pair is saved", async () => {
    N.valid.delete(firstAccess); // it expired
    const before = N.tokenBodies.length;
    const [r1, r2] = await Promise.all([
      registry.execute("notion_search", { query: "Travel" }, ctxOf(A)),
      registry.execute("notion_search", { query: "Groceries" }, ctxOf(A)),
    ]);
    assert.strictEqual(r1.ok, true, JSON.stringify(r1));
    assert.strictEqual(r2.ok, true, JSON.stringify(r2));
    const refreshes = N.tokenBodies.slice(before).filter((b) => b.grant_type === "refresh_token");
    assert.strictEqual(refreshes.length, 1);
    const sec = decryptSecrets((await db.one(`SELECT secrets_enc FROM notion_connections WHERE user_id = $1`, [A])).secrets_enc);
    assert.notStrictEqual(sec.access_token, firstAccess);
    assert.ok(N.valid.has(sec.access_token));
  });

  await atest("429 with Retry-After 1 → one retry; a write that times out is never repeated", async () => {
    N.queue.push(() => json(429, { code: "rate_limited" }, { "retry-after": "1" }));
    const r = await registry.execute("notion_search", { query: "Travel" }, ctxOf(A));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    clearCalls();
    N.queue.push((req) => {
      if (req.method === "PATCH") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    });
    const w = await registry.execute("notion_add", { target: "Travel", items: ["late"] }, ctxOf(A, { approved: true }));
    assert.strictEqual(w.error, "uncertain", JSON.stringify(w));
    assert.strictEqual(N.calls.filter((c) => c.method === "PATCH").length, 1);
  });

  await atest("a refused refresh: needs a reconnect, tools hidden next turn", async () => {
    const row = await db.one(`SELECT secrets_enc FROM notion_connections WHERE user_id = $1`, [A]);
    const sec = decryptSecrets(row.secrets_enc);
    N.valid.delete(sec.access_token);
    N.refreshes.delete(sec.refresh_token);
    const r = await registry.execute("notion_search", { query: "Travel" }, ctxOf(A));
    assert.strictEqual(r.error, "notion_reconnect", JSON.stringify(r));
    assert.match(r.note, /quick reconnect/);
    assert.strictEqual((await db.one(`SELECT status FROM notion_connections WHERE user_id = $1`, [A])).status, "needs_reconnect");
    assert.deepStrictEqual(names(A, 120), []);
    const card = (await (await call(A, "/connections")).json()).connections[0];
    assert.strictEqual(card.status, "needs_reconnect");
    assert.match(require("../src/connectors/notion/tools").notionHintFor(A, 120), /needs a quick reconnect/);
  });

  await atest("reconnecting to another workspace revokes the old grant first", async () => {
    const old = decryptSecrets((await db.one(`SELECT secrets_enc FROM notion_connections WHERE user_id = $1`, [A])).secrets_enc);
    N.workspace = { id: "ws-2", name: "Work" };
    N.revoked.length = 0;
    const s = stateOf((await start(A)).authUrl);
    await cb(`code=c2&state=${s}`);
    assert.ok(N.revoked.includes(old.access_token));
    const row = await db.one(`SELECT workspace_name, status FROM notion_connections WHERE user_id = $1`, [A]);
    assert.deepStrictEqual([row.workspace_name, row.status], ["Work", "connected"]);
  });

  await atest("disconnect: revoked at Notion, row gone, tools gone; twice is fine", async () => {
    N.revoked.length = 0;
    const r = await (await call(A, "/connections/notion", { method: "DELETE" })).json();
    assert.deepStrictEqual(r, { ok: true });
    assert.ok(N.revoked.length >= 1);
    assert.strictEqual(await db.one(`SELECT 1 FROM notion_connections WHERE user_id = $1`, [A]), null);
    assert.strictEqual(store.isConnectedSync(A), false);
    assert.deepStrictEqual(await (await call(A, "/connections/notion", { method: "DELETE" })).json(), { ok: true });
  });

  console.log("\nerasure");

  await atest("deleting the account revokes at Notion and removes both tables", async () => {
    const s = stateOf((await start(E)).authUrl);
    await cb(`code=e&state=${s}`);
    await start(E); // a state still in flight
    N.revoked.length = 0;
    const { deleteUserEverywhere } = require("../src/routes/privacy");
    const rep = await deleteUserEverywhere(E);
    assert.strictEqual(rep.revoked.notion, "revoked");
    assert.ok(N.revoked.length >= 1);
    assert.strictEqual(await db.one(`SELECT 1 FROM notion_connections WHERE user_id = $1`, [E]), null);
    assert.strictEqual(await db.one(`SELECT 1 FROM connector_oauth_states WHERE user_id = $1`, [E]), null);
  });

  await atest("a leftover link of a deleted user is revoked and purged", async () => {
    const ghost = 2_000_000_000 - Number(stamp);
    const { encryptSecrets } = require("../src/mcp/schema");
    N.valid.add("ghost-acc");
    await db.run(
      `INSERT INTO notion_connections (user_id, secrets_enc, connected_at, updated_at) VALUES ($1, $2, $3, $3)`,
      [ghost, encryptSecrets({ access_token: "ghost-acc", refresh_token: null }), Date.now()]);
    N.revoked.length = 0;
    await require("../src/routes/privacy").purgeOrphans();
    assert.ok(N.revoked.includes("ghost-acc"));
    assert.strictEqual(await db.one(`SELECT 1 FROM notion_connections WHERE user_id = $1`, [ghost]), null);
  });

  // Tidy up.
  const { deleteUserEverywhere } = require("../src/routes/privacy");
  for (const u of USERS) await deleteUserEverywhere(u).catch(() => {});
  server.close();
  console.log(`\n${passed} passed${process.exitCode ? " — with failures above" : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
