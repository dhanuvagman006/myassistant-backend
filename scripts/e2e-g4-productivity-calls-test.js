/**
 * E2E — PRODUCTIVITY AND PHONE CALLS (group g4).
 *
 *   DATABASE_URL=postgres://… node scripts/e2e-g4-productivity-calls-test.js
 *
 * Real routers over HTTP (real appAuth with a signed session JWT), real
 * tools through registry.execute (the gates the app actually hits), the
 * real job queue and job handlers, the real Bolna webhook route. What is
 * stubbed, and only that:
 *   - the AI model (generateReply / transcribeAudio)
 *   - every outbound network call (Bolna, Gmail, Google Calendar, Google
 *     OAuth revoke) — global fetch refuses anything else
 *   - the mailbox transports for app-password accounts (IMAP + SMTP)
 *   - Firebase push (recorded, never sent)
 *   - the agent runtime inside scheduled tasks (a model turn)
 * Nothing here dials a phone, sends an email or pays for a token.
 *
 * Tests that expose a real defect are left FAILING on purpose; each says
 * what the user would see.
 *
 * TZ: the production container sets no TZ (Dockerfile), so the server
 * runs in UTC. The test pins the same so date parsing behaves as it does
 * in production, not as it does on a laptop in India.
 */
process.env.TZ = "UTC";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@127.0.0.1:55432/myassistant_e2e_g4";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = "e2e-g4-jwt-secret-not-a-real-one";
process.env.MCP_SECRET_KEY = "e2e-g4-secret-box-key";
// Calling "configured" — against a stubbed provider.
const BOLNA_KEY = "bn-e2e-g4";
Object.assign(process.env, {
  BOLNA_API_KEY: BOLNA_KEY,
  BOLNA_FROM_NUMBER: "+918000000001",
  BOLNA_AGENT_ID: "agent-e2e-g4",
  PUBLIC_BASE_URL: "https://api.example.test",
});
delete process.env.AGENT_CALL_DAILY_LIMIT;

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");

/* ------------------------------------------------------------------ *
 * STUBS THAT MUST BE IN PLACE BEFORE ANY src/ MODULE LOADS            *
 * (several modules destructure these at require time)                 *
 * ------------------------------------------------------------------ */

// --- the model ---
const ai = require("../src/services/ai/router");
const aiLog = [];
let transcribeText = "hello";
const defaultAi = async (messages, opts = {}) => {
  const sys = String(opts.system || "");
  const user = String((messages && messages[0] && messages[0].content) || "");
  aiLog.push(sys.slice(0, 60));
  if (/triage a busy professional's inbox/.test(sys)) {
    // Keep every numbered email, in order.
    const n = (user.match(/^\d+\./gm) || []).length;
    return { reply: JSON.stringify({ keep: [...Array(n).keys()].map((i) => ({ i, why: "addressed to you" })) }) };
  }
  if (/extract structured facts from call transcripts/.test(sys)) return { reply: analysisReply() };
  if (/You extract COMMITMENTS/.test(sys)) {
    return { reply: JSON.stringify({ commitments: [{
      text: "Send the invoice to Manish", owed_to: "Manish", when: "Friday",
      quote: "I'll send the invoice by Friday",
    }] }) };
  }
  if (/draft short follow-up messages/.test(sys)) {
    return { reply: '{"follow_up":"a freshly drafted follow-up"}' };
  }
  return { reply: "{}" };
};
let aiImpl = defaultAi;
ai.generateReply = (...a) => aiImpl(...a);
let transcribeCount = 0;
ai.transcribeAudio = async () => { transcribeCount++; return { text: transcribeText }; };

// --- app-password mailboxes (IMAP + SMTP) ---
const IMAP_PASS = "abcdefghijklmnop";
const imapMsgs = [
  {
    uid: 101, from: { name: "Ramesh Kumar", address: "ramesh@corp.test" },
    replyTo: { address: "ramesh.reply@corp.test" }, subject: "Friday review",
    messageId: "<abc@corp.test>", date: new Date(Date.now() - 3600e3),
    body: "Hi Dhanush, can we meet Friday at 10?",
  },
  {
    uid: 102, from: { name: "Swiggy", address: "offers@swiggy.in" }, replyTo: null,
    subject: "50% off tonight", messageId: "<promo@swiggy.in>",
    date: new Date(Date.now() - 7200e3), body: "Order now",
  },
];
const imapLogins = [];
class FakeImap {
  constructor(opts) { this.opts = opts; this.mailbox = { exists: imapMsgs.length }; }
  async connect() {
    if (this.opts.auth.pass !== IMAP_PASS) {
      const e = new Error("Command failed"); e.responseText = "Invalid credentials (Failure)"; throw e;
    }
    imapLogins.push({ host: this.opts.host, user: this.opts.auth.user });
  }
  async logout() {}
  async getMailboxLock() { return { release() {} }; }
  async search(crit) {
    const q = String(crit.from || "").toLowerCase();
    return imapMsgs.filter((m) => !q || `${m.from.name} ${m.from.address}`.toLowerCase().includes(q))
      .map((m) => m.uid);
  }
  _env(m) {
    return {
      uid: m.uid, flags: new Set(["\\Seen"]),
      envelope: {
        from: [m.from], replyTo: m.replyTo ? [m.replyTo] : [], subject: m.subject,
        date: m.date, messageId: m.messageId,
      },
    };
  }
  fetch(range) {
    const pick = Array.isArray(range) ? imapMsgs.filter((m) => range.includes(m.uid)) : imapMsgs;
    const self = this;
    return (async function* () { for (const m of pick) yield self._env(m); })();
  }
  async fetchOne(uid, query) {
    const m = imapMsgs.find((x) => String(x.uid) === String(uid));
    if (!m) return null;
    if (query && query.source) {
      return { source: Buffer.from(
        `From: ${m.from.name} <${m.from.address}>\r\nTo: dhanush.k@gmail.com\r\n` +
        `Subject: ${m.subject}\r\nMessage-ID: ${m.messageId}\r\n` +
        `Date: ${m.date.toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${m.body}\r\n`) };
    }
    return this._env(m);
  }
}
require("imapflow").ImapFlow = FakeImap;
const smtpSent = [];
const nodemailer = require("nodemailer");
nodemailer.createTransport = (cfg) => ({
  verify: async () => {
    if (cfg.auth.pass !== IMAP_PASS) throw new Error("535 bad credentials");
    return true;
  },
  sendMail: async (m) => { smtpSent.push({ host: cfg.host, ...m }); return { messageId: `<smtp-${smtpSent.length}@test>` }; },
});
// The user-typed host check does a DNS lookup; the hosts here are the
// presets, so the lookup is the only thing skipped.
require("../src/services/safeFetch").assertPublicHost = async () => {};

// --- push ---
const push = require("../src/services/push");
const pushes = [];
push.sendNotification = async (token, title, body, data) => { pushes.push({ token, title, body, data }); return true; };
push.send = async (token, title, body, data) => { pushes.push({ token, title, body, data }); return { ok: true }; };

// --- the network ---
const realFetch = globalThis.fetch;
const bolnaCalls = [];
let bolnaN = 0;
const gmail = { msgs: [], sent: [], drafts: [], sendStatus: 200 };
const gcal = { events: [], posted: [], patched: [], deleted: [] };
const blocked = [];
const J = (x, status = 200) =>
  new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
const b64url = (s) => Buffer.from(String(s), "utf8").toString("base64url");
function gmailMeta(m) {
  const headers = [
    { name: "From", value: m.from }, { name: "Subject", value: m.subject },
    { name: "Date", value: new Date(m.date).toUTCString() },
    { name: "Message-ID", value: m.messageId },
  ];
  if (m.replyTo) headers.push({ name: "Reply-To", value: m.replyTo });
  if (m.unsub) headers.push({ name: "List-Unsubscribe", value: "<mailto:x@y>" });
  return { id: m.id, threadId: m.threadId, labelIds: m.labels, snippet: m.body.slice(0, 80),
    internalDate: String(m.date), payload: { mimeType: "text/plain", headers, body: { data: b64url(m.body) } } };
}
function googleEvent(e) {
  return { id: e.id, summary: e.title, start: { dateTime: e.start }, end: { dateTime: e.end },
    location: e.location || "", attendees: e.attendees || [] };
}
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1")) return realFetch(url, opts);
  const method = String(opts.method || "GET").toUpperCase();
  if (u === "https://api.bolna.ai/call") {
    const body = JSON.parse(opts.body);
    const execId = `exec-g4-${++bolnaN}`;
    bolnaCalls.push({ execId, body, auth: opts.headers && opts.headers.Authorization });
    return J({ execution_id: execId });
  }
  if (u.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/")) {
    const p = new URL(u);
    const parts = p.pathname.split("/").filter(Boolean); // gmail v1 users me messages [id|send] | drafts
    if (parts[4] === "drafts" && method === "POST") {
      gmail.drafts.push(JSON.parse(opts.body)); return J({ id: `draft-${gmail.drafts.length}` });
    }
    if (parts[4] === "messages" && parts[5] === "send" && method === "POST") {
      if (gmail.sendStatus !== 200) return J({ error: { code: gmail.sendStatus } }, gmail.sendStatus);
      const b = JSON.parse(opts.body);
      gmail.sent.push({ threadId: b.threadId, raw: Buffer.from(b.raw, "base64url").toString("utf8") });
      return J({ id: `sent-${gmail.sent.length}` });
    }
    if (parts[4] === "messages" && !parts[5]) {
      const q = String(p.searchParams.get("q") || "");
      const from = (q.match(/from:(\S+)/) || [])[1];
      const hits = gmail.msgs.filter((m) => !from || m.from.toLowerCase().includes(from.toLowerCase()));
      return J({ messages: hits.map((m) => ({ id: m.id })) });
    }
    if (parts[4] === "messages" && parts[5]) {
      const m = gmail.msgs.find((x) => x.id === parts[5]);
      return m ? J(gmailMeta(m)) : J({ error: "not found" }, 404);
    }
  }
  if (u.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events")) {
    const p = new URL(u);
    const id = decodeURIComponent(p.pathname.split("/events/")[1] || "");
    if (method === "GET") {
      // Google's semantics: timeMin bounds the event's END, timeMax its
      // start — so a meeting already running is returned, first.
      const tMin = Date.parse(p.searchParams.get("timeMin") || "") || -Infinity;
      const tMax = Date.parse(p.searchParams.get("timeMax") || "") || Infinity;
      const items = gcal.events
        .filter((e) => Date.parse(e.end) > tMin && Date.parse(e.start) < tMax)
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      return J({ items: items.map(googleEvent) });
    }
    if (method === "POST") { gcal.posted.push(JSON.parse(opts.body)); return J({ id: `ev-new-${gcal.posted.length}`, htmlLink: "" }); }
    if (method === "PATCH") { gcal.patched.push({ id, body: JSON.parse(opts.body) }); return J({ id }); }
    if (method === "DELETE") { gcal.deleted.push(id); return new Response(null, { status: 204 }); }
  }
  if (u.startsWith("https://oauth2.googleapis.com/revoke")) return J({});
  blocked.push(u);
  throw new Error(`outbound request blocked in the e2e test: ${u.slice(0, 60)}`);
};

/* ------------------------------------------------------------------ */

const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../src/db");

let passed = 0;
const failed = [];
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed.push(name); console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
/** "YYYY-MM-DDTHH:MM:SS+05:30" for an instant, in a user's offset. */
function isoLocal(ms, tz = 330) {
  const d = new Date(ms + tz * 60_000);
  const p = (n) => String(n).padStart(2, "0");
  const a = Math.abs(tz);
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}` +
    `${tz >= 0 ? "+" : "-"}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}
const wholeSec = (ms) => Math.floor(ms / 1000) * 1000;
const webhookSecret = crypto.createHash("sha256").update(BOLNA_KEY).digest("hex").slice(0, 32);
let analysisReply = () => "{}";

(async () => {
  await db.init();
  const registry = require("../src/tools/registry");
  require("../src/tools/builtins").registerBuiltins();
  const jobs = require("../src/infra/jobs");
  require("../src/infra/handlers").install();
  const agentCall = require("../src/agents/agentCall");
  agentCall._resetTrouble();
  const runtime = require("../src/agents/runtime");
  const realRunAgentTurn = runtime.runAgentTurn;
  const scheduler = require("../src/proactive/scheduler");

  const rnd = () => String(Math.floor(1e7 + Math.random() * 9e7));
  const stamp = Date.now();
  const mkUser = async (tag, name, gender) => {
    const u = await db.createUser({ email: `${tag}-${stamp}@e2e-g4.test`, name, gender });
    await db.run(
      `UPDATE users SET phone_number=$2, fcm_token=$3, tz_offset_min=330 WHERE id=$1`,
      [u.id, `+9198${rnd()}`, `tok-g4-${tag}-${u.id}`]);
    return db.findById(u.id);
  };
  const me = await mkUser("owner", "Dhanush K", "male");
  const other = await mkUser("other", "Priya S", "female");
  const U1 = me.id, U2 = other.id;
  const tok = (uid) => jwt.sign({ uid }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
  const T1 = tok(U1), T2 = tok(U2);
  // PARK every job this test did not create, so the queue runs only ours.
  // (jobs.runOne claims the lowest due id; a leftover row from another
  // suite would otherwise run under these stubs.) Restored in finally.
  const PARK = 1e13;
  const parked = (await db.query(
    `UPDATE jobs SET run_after = run_after + ${PARK}
      WHERE status='pending' AND (user_id IS NULL OR NOT (user_id = ANY($1::int[])))
      RETURNING id`, [[U1, U2]])).map((r) => Number(r.id));
  const ctx = () => ({ userId: U1, tzOffsetMin: 330, source: "text" });
  const pushesTo = (u) => pushes.filter((p) => p.token === u.fcm_token);

  // The real routers, behind the real session check.
  const { appAuth } = require("../src/middleware/auth");
  const acRoutes = require("../src/routes/agentCall");
  const app = express();
  app.use(express.json());
  app.use("/agent-call/bolna", acRoutes.bolnaWebhooks);
  app.use("/agent-call", appAuth, acRoutes.router);
  app.use("/reminders", appAuth, require("../src/reminders/routes"));
  app.use("/email", appAuth, require("../src/routes/email"));
  app.use("/google", appAuth, require("../src/google/routes"));
  app.use("/calls", appAuth, require("../src/routes/calls").router);
  app.use("/tasks", appAuth, require("../src/routes/tasks"));
  app.use("/outcomes", appAuth, require("../src/routes/outcomes"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(method, path, { token = T1, body, headers = {}, form } = {}) {
    const h = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers };
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { h["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    const r = await realFetch(base + path, { method, headers: h, body: payload });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: r.status, json, text };
  }
  const webhook = (body, secret = webhookSecret) =>
    api("POST", `/agent-call/bolna/webhook/${secret}`, { token: null, body });
  // agentCall.start() files the Calls row without awaiting it. With the
  // provider stubbed the webhook could otherwise beat that INSERT, which
  // cannot happen against the real service (answers take seconds).
  const callRow = (externalId) => waitFor(() => db.one(
    `SELECT * FROM task_outcomes WHERE external_id=$1`, [externalId]), 3000, "the Calls row");

  /** Run one queued job through the real queue (claim → handler → status). */
  async function runJob(id, { at } = {}) {
    await db.run(`UPDATE jobs SET run_after=$2 WHERE id=$1 AND status='pending'`,
      [id, at != null ? at : Date.now() - 1]);
    for (let i = 0; i < 60; i++) {
      const j = await db.one(`SELECT status, last_error FROM jobs WHERE id=$1`, [id]);
      if (!["pending", "running"].includes(j.status)) return j;
      if (!(await jobs.runOne())) await sleep(50);
    }
    throw new Error(`job ${id} never ran`);
  }
  const reminderJobs = (rid, status = "pending") => db.query(
    `SELECT id, run_after, status FROM jobs WHERE kind='reminder_call' AND status=$2
       AND (payload->>'reminderId')::int = $1 ORDER BY id`, [rid, status]);

  try {
    /* ================================================================ */
    console.log("\nreminders: a spoken reminder is a phone call at its time");
    /* ================================================================ */

    let r1;
    await atest("create_reminder: saved as a call, the call queued for its time, and said so", async () => {
      const due = wholeSec(Date.now() + 2 * 3600e3);
      const res = await registry.execute("create_reminder",
        { text: "call the bank about the loan", due_at: isoLocal(due) }, ctx());
      assert.strictEqual(res.ok, true, JSON.stringify(res));
      r1 = res.data;
      assert.strictEqual(Number(r1.due_at), due);
      assert.strictEqual(r1.deliver, "call");
      assert.strictEqual(r1.ring, "gentle");
      assert.match(res.speak, /I'll call you then/);
      const q = await reminderJobs(r1.id);
      assert.strictEqual(q.length, 1, "one reminder_call job");
      assert.strictEqual(Number(q[0].id), Number(r1.call_job_id));
      assert.ok(Math.abs(Number(q[0].run_after) - due) < 1500, "the call is queued for the reminder's time");
    });

    await atest("'just remind me' is a notification: no call is queued", async () => {
      const res = await registry.execute("create_reminder",
        { text: "water the plants", due_at: isoLocal(Date.now() + 3 * 3600e3), quiet: true }, ctx());
      assert.strictEqual(res.data.deliver, "notify");
      assert.strictEqual(res.speak, "Saved.");
      assert.strictEqual((await reminderJobs(res.data.id)).length, 0);
    });

    await atest("'wake me' rings like an alarm AND calls", async () => {
      const res = await registry.execute("create_reminder",
        { text: "flight to Delhi", due_at: isoLocal(Date.now() + 5 * 3600e3), wake_me: true }, ctx());
      assert.strictEqual(res.data.ring, "alarm");
      assert.strictEqual(res.data.deliver, "call");
      assert.strictEqual((await reminderJobs(res.data.id)).length, 1);
    });

    await atest("an unreadable time or a timeless repeat is refused, nothing saved", async () => {
      const before = (await db.query(`SELECT id FROM reminders WHERE user_id=$1`, [U1])).length;
      const a = await registry.execute("create_reminder", { text: "gym", due_at: "tomorrow 9am" }, ctx());
      assert.strictEqual(a.ok, false);
      assert.match(a.error, /not a datetime I can read/);
      const b = await registry.execute("create_reminder", { text: "gym", repeat: "daily" }, ctx());
      assert.strictEqual(b.ok, false);
      assert.strictEqual((await db.query(`SELECT id FROM reminders WHERE user_id=$1`, [U1])).length, before);
    });

    await atest("calling not configured: the reminder is a notification and no call is promised", async () => {
      const key = process.env.BOLNA_API_KEY;
      delete process.env.BOLNA_API_KEY;
      try {
        const res = await registry.execute("create_reminder",
          { text: "pay the electricity bill", due_at: isoLocal(Date.now() + 4 * 3600e3) }, ctx());
        assert.strictEqual(res.data.deliver, "notify");
        assert.doesNotMatch(res.speak, /call/i);
        assert.strictEqual((await reminderJobs(res.data.id)).length, 0);
      } finally { process.env.BOLNA_API_KEY = key; }
    });

    await atest("GET /reminders (the app's sync) shows which ones call; the + button never calls", async () => {
      const g = await api("GET", "/reminders");
      assert.strictEqual(g.status, 200);
      const mine = g.json.reminders.find((x) => x.id === r1.id);
      assert.deepStrictEqual(
        { text: mine.text, deliver: mine.deliver, ring: mine.ring, done: mine.done, dueAt: mine.dueAt },
        { text: "call the bank about the loan", deliver: "call", ring: "gentle", done: false, dueAt: Number(r1.due_at) });
      const p = await api("POST", "/reminders", { body: { text: "buy milk", dueAt: Date.now() + 3600e3 } });
      assert.strictEqual(p.status, 200);
      assert.strictEqual(p.json.reminder.deliver, "notify");
      assert.strictEqual((await reminderJobs(p.json.reminder.id)).length, 0);
      const other = await api("GET", "/reminders", { token: T2 });
      assert.ok(!other.json.reminders.some((x) => x.id === r1.id), "another user sees my reminder");
      assert.strictEqual((await api("GET", "/reminders", { token: null })).status, 401);
    });

    await atest("PATCH dueAt moves the call with the reminder", async () => {
      const oldJob = Number(r1.call_job_id);
      const next = wholeSec(Date.now() + 6 * 3600e3);
      const p = await api("PATCH", `/reminders/${r1.id}`, { body: { dueAt: next } });
      assert.strictEqual(p.status, 200);
      assert.strictEqual(p.json.reminder.dueAt, next);
      const old = await db.one(`SELECT status FROM jobs WHERE id=$1`, [oldJob]);
      assert.strictEqual(old.status, "cancelled", "the old call would still ring at the old time");
      const q = await reminderJobs(r1.id);
      assert.strictEqual(q.length, 1);
      assert.ok(Math.abs(Number(q[0].run_after) - next) < 1500);
    });

    await atest("DELETE /reminders/:id cancels its call", async () => {
      const res = await registry.execute("create_reminder",
        { text: "renew the passport", due_at: isoLocal(Date.now() + 7 * 3600e3) }, ctx());
      const job = Number(res.data.call_job_id);
      assert.strictEqual((await api("DELETE", `/reminders/${res.data.id}`)).status, 200);
      assert.strictEqual((await db.one(`SELECT status FROM jobs WHERE id=$1`, [job])).status, "cancelled");
      assert.strictEqual((await api("DELETE", `/reminders/${res.data.id}`)).status, 404);
    });

    await atest("ticking a calling reminder done cancels the call", async () => {
      const p = await api("PATCH", `/reminders/${r1.id}`, { body: { done: true } });
      assert.strictEqual(p.json.reminder.done, true);
      assert.strictEqual((await reminderJobs(r1.id)).length, 0, "done means don't ring me");
    });

    // DEFECT: reminders/store.js setDone(done=false) only flips the flag.
    // The Reminders screen offers "Moved back to your list" (reminders_screen
    // .dart:86-94 → PATCH {done:false}); the row still says deliver:'call'
    // (the app shows the call badge) but no call is ever queued again.
    await atest("un-ticking a calling reminder (Moved back to your list) re-arms its call", async () => {
      const p = await api("PATCH", `/reminders/${r1.id}`, { body: { done: false } });
      assert.strictEqual(p.json.reminder.done, false);
      assert.strictEqual(p.json.reminder.deliver, "call", "the app shows it will call");
      const q = await reminderJobs(r1.id);
      assert.strictEqual(q.length, 1,
        "the reminder still says it will call at its time, but no reminder_call job exists — the phone never rings");
    });

    let dailyExec;
    await atest("the due call runs through the queue: the user's own number, 'Sir' not the name, and a daily series rolls to tomorrow with its next call", async () => {
      const res = await registry.execute("create_reminder",
        { text: "take the tablets", due_at: isoLocal(Date.now() + 120e3), repeat: "daily" }, ctx());
      assert.strictEqual(res.data.repeat, "daily");
      assert.match(res.speak, /I'll call you every day/);
      const rid = res.data.id, jobId = Number(res.data.call_job_id);
      const due = Date.now() - 1000;
      await db.run(`UPDATE reminders SET due_at=$1 WHERE id=$2`, [due, rid]);
      const n = bolnaCalls.length;
      const j = await runJob(jobId, { at: due });
      assert.strictEqual(j.status, "done");
      assert.strictEqual(bolnaCalls.length, n + 1, "the call was not placed");
      const call = bolnaCalls[bolnaCalls.length - 1];
      dailyExec = call.execId;
      assert.strictEqual(call.body.recipient_phone_number, me.phone_number);
      assert.strictEqual(call.body.from_phone_number, process.env.BOLNA_FROM_NUMBER);
      assert.strictEqual(call.body.agent_id, "agent-e2e-g4");
      assert.strictEqual(call.body.user_data.mode, "self");
      assert.match(call.body.user_data.task, /take the tablets/);
      assert.strictEqual(call.body.user_data.contact_name, "Sir");
      assert.ok(!JSON.stringify(call.body.user_data).includes("Dhanush"), "the owner's name was sent on a self-call");
      const row = await db.one(`SELECT due_at FROM reminders WHERE id=$1`, [rid]);
      assert.strictEqual(Number(row.due_at), due + 86_400_000, "the series did not move to tomorrow");
      const q = await reminderJobs(rid);
      assert.strictEqual(q.length, 1, "tomorrow's call is queued");
      assert.ok(Math.abs(Number(q[0].run_after) - (due + 86_400_000)) < 1500);
    });

    await atest("the reminder call's answer lands: outcome completed, one push 'I called you'", async () => {
      await waitFor(() => db.one(
        `SELECT 1 FROM task_outcomes WHERE user_id=$1 AND detail LIKE 'Remind them: take the tablets%'`, [U1]),
        3000, "the Calls row");
      const w = await webhook({ id: dailyExec, status: "completed", conversation_duration: 14,
        transcript: "assistant: Good morning Sir, time for your tablets.\nuser: Yes, taking them now, thanks." });
      assert.strictEqual(w.status, 200);
      const row = await waitFor(() => db.one(
        `SELECT status, transcript FROM task_outcomes WHERE user_id=$1 AND status='completed' AND detail LIKE 'I called you%'`,
        [U1]), 3000, "the outcome row");
      assert.match(row.transcript, /user: Yes, taking them now/);
      await waitFor(() => pushesTo(me).some((p) => p.title === "I called you"), 3000, "the push");
      await webhook({ id: dailyExec, status: "completed", conversation_duration: 14,
        transcript: "user: Yes, taking them now, thanks." });
      await sleep(100);
      assert.strictEqual(pushesTo(me).filter((p) => p.title === "I called you").length, 1, "pushed twice");
    });

    await atest("birthdays: remembered once, one push the day before, never twice", async () => {
      const hourNow = new Date().getUTCHours();
      let d = (12 - hourNow + 24) % 24; if (d > 14) d -= 24;
      const tz = d * 60; // an offset at which it is noon for this user
      await db.run(`UPDATE users SET tz_offset_min=$2 WHERE id=$1`, [U2, tz]);
      const tomorrow = new Date(Date.now() + tz * 60_000 + 86_400_000);
      const md = `${String(tomorrow.getUTCMonth() + 1).padStart(2, "0")}-${String(tomorrow.getUTCDate()).padStart(2, "0")}`;
      const res = await registry.execute("remember_person_date",
        { person: "Chetan", date: md }, { userId: U2, tzOffsetMin: tz });
      assert.strictEqual(res.ok, true, JSON.stringify(res));
      await scheduler.sweepPersonDates();
      const mine = pushesTo(other).filter((p) => /Chetan's birthday/.test(p.title));
      assert.strictEqual(mine.length, 1);
      assert.strictEqual(mine[0].title, "🎂 Tomorrow: Chetan's birthday");
      await scheduler.sweepPersonDates();
      assert.strictEqual(pushesTo(other).filter((p) => /Chetan's birthday/.test(p.title)).length, 1);
    });

    await atest("set_alarm puts a real alarm in the phone's clock app (clock_intent)", async () => {
      const res = await registry.execute("set_alarm", { hour: 5, minute: 30, label: "Gym" }, ctx());
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.deviceAction.type, "clock_intent");
      assert.strictEqual(res.deviceAction.action, "android.intent.action.SET_ALARM");
      assert.strictEqual(res.deviceAction.extras["android.intent.extra.alarm.HOUR"], 5);
      assert.strictEqual(res.deviceAction.extras["android.intent.extra.alarm.MINUTES"], 30);
      assert.strictEqual(res.deviceAction.extras["android.intent.extra.alarm.SKIP_UI"], true);
    });

    /* ================================================================ */
    console.log("\nscheduled tasks and the widget: work that finishes without the phone");
    /* ================================================================ */

    const turns = [];
    let turnReply = { text: "Done.", deviceActions: [] };
    runtime.runAgentTurn = async (text, c) => { turns.push({ text, ctx: c }); return typeof turnReply === "function" ? turnReply(text, c) : turnReply; };

    let daily;
    await atest("schedule_task daily: queued at its time with the series in the payload", async () => {
      const at = wholeSec(Date.now() + 2 * 3600e3);
      const res = await registry.execute("schedule_task",
        { task: "Check the gold rate and tell me", when: isoLocal(at), repeat: "daily" }, ctx());
      assert.strictEqual(res.ok, true, JSON.stringify(res));
      assert.match(res.speak, /Scheduled daily/);
      daily = await db.one(`SELECT * FROM jobs WHERE id=$1`, [res.data.id]);
      assert.strictEqual(daily.kind, "scheduled_task");
      assert.strictEqual(daily.payload.repeat, "daily");
      assert.strictEqual(daily.payload.tzOffsetMin, 330);
      assert.ok(Math.abs(Number(daily.run_after) - at) < 1500);
      // Past the 3-minute grace: a minute ago is "in one minute" written
      // with a minute-old clock, and now runs a minute from now (2026-09-27).
      const past = await registry.execute("schedule_task", { task: "x", when: isoLocal(Date.now() - 10 * 60e3) }, ctx());
      assert.strictEqual(past.ok, false);
    });

    await atest("it runs pre-approved in its own session, pushes the outcome, keeps it, and queues tomorrow", async () => {
      turnReply = { text: "Gold is ₹7,100 a gram today.", deviceActions: [] };
      const at = Date.now() - 60_000;
      const j = await runJob(Number(daily.id), { at });
      assert.strictEqual(j.status, "done");
      assert.strictEqual(j.last_error, "OK: Gold is ₹7,100 a gram today.");
      const t = turns[turns.length - 1];
      assert.match(t.text, /Check the gold rate and tell me/);
      assert.strictEqual(t.ctx.approved, true);
      assert.strictEqual(t.ctx.background, true);
      assert.strictEqual(t.ctx.sessionId, `job:${daily.id}`);
      const p = pushesTo(me).pop();
      assert.deepStrictEqual([p.title, p.body], ["Done: Check the gold rate and tell me", "Gold is ₹7,100 a gram today."]);
      const next = await db.query(
        `SELECT run_after FROM jobs WHERE user_id=$1 AND kind='scheduled_task' AND status='pending'
           AND payload->>'task'='Check the gold rate and tell me'`, [U1]);
      assert.strictEqual(next.length, 1, "the series stopped after one run");
      assert.strictEqual(Number(next[0].run_after), at + 86_400_000);
      const list = await registry.execute("list_scheduled_tasks", {}, ctx());
      assert.ok(list.data.some((x) => x.outcome === "OK: Gold is ₹7,100 a gram today."));
    });

    await atest("a task that needed the phone in hand is reported as failed, never 'done'", async () => {
      turnReply = { text: "Opened Swiggy for you.", deviceActions: [{ type: "open_url", url: "swiggy://" }] };
      const id = await jobs.enqueue("scheduled_task", { task: "Order biryani from Swiggy", tzOffsetMin: 330 },
        { userId: U1, delayMs: 0 });
      const j = await runJob(id);
      assert.match(j.last_error, /^FAILED: /);
      const p = pushesTo(me).pop();
      assert.strictEqual(p.title, "Scheduled task failed");
      assert.match(p.body, /needed your phone in hand/);
    });

    await atest("a task the server missed by hours is skipped and said so, not run late", async () => {
      const n = turns.length;
      const id = await jobs.enqueue("scheduled_task", { task: "Order dinner", tzOffsetMin: 330 },
        { userId: U1, delayMs: 0 });
      await runJob(id, { at: Date.now() - 2 * 3600e3 });
      assert.strictEqual(turns.length, n, "a stale task ran anyway");
      const p = pushesTo(me).pop();
      assert.strictEqual(p.title, "Missed scheduled task");
      assert.match(p.body, /Ask me again/);
    });

    await atest("cancel_scheduled_task stops it; another user cannot", async () => {
      const res = await registry.execute("schedule_task",
        { task: "Message Manish happy birthday", when: isoLocal(Date.now() + 3 * 3600e3) }, ctx());
      const id = res.data.id;
      const theirs = await registry.execute("cancel_scheduled_task", { id }, { userId: U2 });
      assert.strictEqual(theirs.ok, false);
      const mine = await registry.execute("cancel_scheduled_task", { id }, ctx());
      assert.strictEqual(mine.ok, true);
      assert.strictEqual((await db.one(`SELECT status FROM jobs WHERE id=$1`, [id])).status, "cancelled");
    });

    await atest("POST /tasks/quick (the home-screen widget): 202 at once, runs in the background, outcome pushed", async () => {
      turnReply = { text: "Your PNR 1234567890 is confirmed, coach B2.", deviceActions: [] };
      assert.strictEqual((await api("POST", "/tasks/quick", { body: { task: "  " } })).status, 400);
      const r = await api("POST", "/tasks/quick", { body: { task: "Check my PNR status" }, headers: { "X-TZ-Offset": "330" } });
      assert.strictEqual(r.status, 202);
      assert.strictEqual(r.json.queued, true);
      const row = await db.one(`SELECT payload, user_id FROM jobs WHERE id=$1`, [r.json.id]);
      assert.strictEqual(row.user_id, U1);
      assert.strictEqual(row.payload.source, "widget");
      assert.strictEqual(row.payload.tzOffsetMin, 330);
      await runJob(r.json.id);
      const p = pushesTo(me).pop();
      assert.deepStrictEqual([p.title, p.body], ["Done: Check my PNR status", "Your PNR 1234567890 is confirmed, coach B2."]);
    });

    await atest("a scheduled 'call X and tell them Y' is placed by the assistant and the answer is pushed", async () => {
      turnReply = { text: "Calling them now.", deviceActions: [{ type: "resolve_and_call",
        name: "98450 12345", message: "The meeting moved to 5 pm", agent_available: true }] };
      const id = await jobs.enqueue("scheduled_task",
        { task: "Call 98450 12345 and tell them the meeting moved to 5 pm", tzOffsetMin: 330 },
        { userId: U1, delayMs: 0 });
      const n = bolnaCalls.length;
      const running = runJob(id);
      await waitFor(() => bolnaCalls.length > n, 5000, "the relayed call");
      const call = bolnaCalls[bolnaCalls.length - 1];
      assert.strictEqual(call.body.recipient_phone_number, "+919845012345");
      assert.match(call.body.user_data.task, /meeting moved to 5 pm/);
      await webhook({ id: call.execId, status: "completed", conversation_duration: 20,
        transcript: "assistant: Hello, the meeting moved to 5 pm.\nuser: Okay, 5 pm works for me." });
      const j = await running;
      assert.match(j.last_error, /^OK: /);
      const p = pushesTo(me).pop();
      assert.match(p.title, /^Done: Call 98450 12345/);
      assert.match(p.body, /Okay, 5 pm works for me\./);
    });

    runtime.runAgentTurn = realRunAgentTurn;

    /* ================================================================ */
    console.log("\nemail: Google-linked mailbox (Gmail API stubbed)");
    /* ================================================================ */

    await atest("nothing linked: the tools say so and the Email screen shows not connected", async () => {
      const r = await registry.execute("email_read", {}, ctx());
      assert.strictEqual(r.ok, false);
      assert.match(r.speak, /isn't connected yet/);
      assert.deepStrictEqual((await api("GET", "/email/account")).json, { connected: false });
      assert.deepStrictEqual((await api("GET", "/google/status")).json, { connected: false });
    });

    await db.run(
      `INSERT INTO google_tokens (user_id, refresh_token, access_token, expires_at, scopes, updated_at)
       VALUES ($1,'1//refresh-test','ya29.test-token',$2,'gmail.send calendar.events',$3)`,
      [U1, Date.now() + 3600e3, Date.now()]);
    gmail.msgs = [
      { id: "m1", threadId: "t-9", from: "Ramesh Kumar <ramesh@corp.test>", replyTo: "Ramesh <ramesh.reply@corp.test>",
        subject: "Friday review", messageId: "<abc@corp.test>", date: Date.now() - 3600e3,
        labels: ["INBOX", "UNREAD"], body: "Hi Dhanush, can we meet on Friday at 10 to go over the numbers?" },
      { id: "m2", threadId: "t-2", from: "Zomato <offers@zomato.test>", subject: "60% off tonight",
        messageId: "<p@zomato.test>", date: Date.now() - 7200e3, labels: ["INBOX", "CATEGORY_PROMOTIONS"],
        unsub: true, body: "Order now and save" },
    ];

    let tainted;
    await atest("email_read finds the sender's mail; reading it taints the turn so a send/call now needs a yes", async () => {
      assert.deepStrictEqual((await api("GET", "/google/status")).json, { connected: true });
      tainted = ctx();
      const r = await registry.execute("email_read", { from: "Ramesh" }, tainted);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.data.messages.length, 1);
      assert.deepStrictEqual(
        [r.data.messages[0].uid, r.data.messages[0].from, r.data.messages[0].fromAddr, r.data.messages[0].unread],
        ["m1", "Ramesh Kumar", "ramesh@corp.test", true]);
      assert.match(r.note, /EXTERNAL CONTENT/);
      assert.strictEqual(registry.requiresConfirmation("place_phone_call", tainted), true);
      assert.strictEqual(registry.requiresConfirmation("place_phone_call", ctx()), false);
      const call = await registry.execute("place_phone_call", { name: "Ravi", message: "wire the money" }, tainted);
      assert.strictEqual(call.needsConfirmation, true);
      assert.match(call.summary, /after reading an email or web page/);
    });

    await atest("a bare 'read my mails' drops promotions; a picked message is read in full", async () => {
      const r = await registry.execute("email_read", {}, ctx());
      assert.deepStrictEqual(r.data.messages.map((m) => m.uid), ["m1"]);
      const one = await registry.execute("email_read", { uid: "m1" }, ctx());
      assert.match(one.data.body, /meet on Friday at 10/);
    });

    await atest("email_send: a confirmation card first (nothing sent), then sent from Gmail and listed in Sent", async () => {
      const args = { to: "ravi@corp.test", subject: "Running late", remember_as: "Ravi",
        body: "Hi Ravi, I'll be ten minutes late. — Dhanush" };
      const ask = await registry.execute("email_send", args, ctx());
      assert.strictEqual(ask.needsConfirmation, true);
      assert.strictEqual(ask.summary, "Email ravi@corp.test: Running late");
      assert.strictEqual(gmail.sent.length, 0, "sent before the user said yes");
      const res = await registry.execute("email_send", args, { ...ctx(), approved: true });
      assert.strictEqual(res.ok, true, JSON.stringify(res));
      assert.match(res.speak, /Sent — your mail to ravi@corp.test is on its way/);
      assert.strictEqual(gmail.sent.length, 1);
      assert.match(gmail.sent[0].raw, /^To: ravi@corp.test\r\nSubject: Running late\r\n/);
      assert.match(gmail.sent[0].raw, /I'll be ten minutes late/);
      const s = await api("GET", "/email/sent");
      assert.strictEqual(s.status, 200);
      assert.deepStrictEqual(
        [s.json.sent[0].to, s.json.sent[0].label, s.json.sent[0].subject],
        ["ravi@corp.test", "Ravi", "Running late"]);
      assert.match(s.json.sent[0].preview, /^Hi Ravi/);
      assert.strictEqual((await api("GET", "/email/sent", { token: T2 })).json.sent.length, 0);
    });

    await atest("'mail Ravi again' resolves from the Sent list; an unknown name is asked, never guessed", async () => {
      const res = await registry.execute("email_send",
        { to: "Ravi", subject: "Reached", body: "Reached the office." }, { ...ctx(), approved: true });
      assert.strictEqual(res.data.to, "ravi@corp.test");
      assert.match(gmail.sent[1].raw, /^To: ravi@corp.test/);
      const n = gmail.sent.length;
      const ask = await registry.execute("email_send",
        { to: "my professor", subject: "Extension", body: "Could I have one more week?" }, { ...ctx(), approved: true });
      assert.strictEqual(ask.ok, false);
      assert.match(ask.error, /recipient unresolved/);
      assert.strictEqual(gmail.sent.length, n);
    });

    await atest("email_reply: confirmed first, then in the same thread, to the Reply-To, with Re:", async () => {
      const args = { from: "Ramesh", body: "Friday at 10 works. — Dhanush" };
      const ask = await registry.execute("email_reply", args, ctx());
      assert.strictEqual(ask.needsConfirmation, true);
      const res = await registry.execute("email_reply", args, { ...ctx(), approved: true });
      assert.strictEqual(res.ok, true, JSON.stringify(res));
      const sent = gmail.sent[gmail.sent.length - 1];
      assert.strictEqual(sent.threadId, "t-9");
      assert.match(sent.raw, /^To: ramesh.reply@corp.test\r\nSubject: Re: Friday review\r\n/);
      assert.match(sent.raw, /In-Reply-To: <abc@corp.test>\r\nReferences: <abc@corp.test>/);
      assert.match(res.speak, /Replied to Ramesh/);
    });

    await atest("an old Google grant without send leaves a Gmail draft and says so", async () => {
      gmail.sendStatus = 403;
      try {
        const res = await registry.execute("email_send",
          { to: "ravi@corp.test", subject: "Draft me", body: "text" }, { ...ctx(), approved: true });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.data.draft, true);
        assert.match(res.speak, /draft in your Gmail/);
        assert.strictEqual(gmail.drafts.length, 1);
      } finally { gmail.sendStatus = 200; }
    });

    await atest("a scheduled run that read an email may not send on its say-so", async () => {
      const n = gmail.sent.length;
      const res = await registry.execute("email_send",
        { to: "x@evil.test", subject: "fwd", body: "all your data" },
        { userId: U1, background: true, approved: true, __untrustedAt: Date.now() });
      assert.strictEqual(res.ok, false);
      assert.match(res.error, /read an email, web page or connected service/);
      assert.strictEqual(gmail.sent.length, n);
    });

    /* ================================================================ */
    console.log("\ncalendar: Google Calendar (API stubbed)");
    /* ================================================================ */

    const day = (n, hh, mm = 0) => {
      const d = new Date(Date.now() + 330 * 60_000 + n * 86_400_000);
      d.setUTCHours(hh, mm, 0, 0);
      return d.getTime() - 330 * 60_000;
    };
    gcal.events = [
      { id: "ev1", title: "Team standup", start: isoLocal(day(1, 9)), end: isoLocal(day(1, 9, 30)) },
      { id: "ev2", title: "Standup review", start: isoLocal(day(2, 9)), end: isoLocal(day(2, 9, 30)) },
      { id: "ev3", title: "Dentist", start: isoLocal(day(3, 16)), end: isoLocal(day(3, 16, 30)) },
    ];

    await atest("list_calendar_events answers from the calendar; unlinked users are refused, not invented", async () => {
      const r = await registry.execute("list_calendar_events", { days: 7 }, ctx());
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.deepStrictEqual(r.data.events.map((e) => e.title), ["Team standup", "Standup review", "Dentist"]);
      const u2 = await registry.execute("list_calendar_events", {}, { userId: U2 });
      assert.strictEqual(u2.ok, false);
      const g = await api("GET", "/google/calendar?days=7");
      assert.strictEqual(g.json.events.length, 3);
      assert.strictEqual((await api("GET", "/google/calendar", { token: T2 })).status, 409);
    });

    await atest("create_calendar_event with an offset lands at that instant, an hour long", async () => {
      const res = await registry.execute("create_calendar_event",
        { title: "Lunch with Asha", start: isoLocal(day(4, 13)) }, ctx());
      assert.strictEqual(res.ok, true, JSON.stringify(res));
      const posted = gcal.posted[gcal.posted.length - 1];
      assert.strictEqual(posted.summary, "Lunch with Asha");
      assert.strictEqual(posted.start.dateTime, new Date(day(4, 13)).toISOString());
      assert.strictEqual(posted.end.dateTime, new Date(day(4, 14)).toISOString());
    });

    // DEFECT: create_calendar_event (builtins.js ~5925) and
    // update_calendar_event (~5985) use Date.parse() on the model's time.
    // Every other time tool goes through parseUserTime(), which reads an
    // ISO time without an offset as the USER's local time. On the server
    // (UTC) "16:00" becomes 16:00 UTC = 9:30 pm IST.
    await atest("a time without an offset means the user's local time, as it does for reminders", async () => {
      const d = new Date(day(5, 16) + 330 * 60_000).toISOString().slice(0, 10);
      const naive = `${d}T16:00:00`;
      const rem = await registry.execute("create_reminder",
        { text: "naive-time probe", due_at: naive, quiet: true }, ctx());
      assert.strictEqual(Number(rem.data.due_at), day(5, 16), "precondition: reminders read it as 4 pm IST");
      await registry.execute("create_calendar_event", { title: "Dentist check-up", start: naive }, ctx());
      const posted = gcal.posted[gcal.posted.length - 1];
      assert.strictEqual(posted.start.dateTime, new Date(day(5, 16)).toISOString(),
        `"${naive}" was booked at ${posted.start.dateTime} — 5 h 30 m late for an IST user`);
    });

    await atest("update_calendar_event: an ambiguous title changes nothing; a unique one moves and keeps its length", async () => {
      const amb = await registry.execute("update_calendar_event",
        { title: "standup", new_start: isoLocal(day(1, 10)) }, ctx());
      assert.strictEqual(amb.ok, false);
      assert.strictEqual(amb.error, "ambiguous_event");
      assert.strictEqual(gcal.patched.length, 0);
      const res = await registry.execute("update_calendar_event",
        { title: "Dentist", new_start: isoLocal(day(3, 17)) }, ctx());
      assert.strictEqual(res.ok, true, JSON.stringify(res));
      assert.deepStrictEqual(gcal.patched[0], { id: "ev3", body: {
        start: { dateTime: new Date(day(3, 17)).toISOString() },
        end: { dateTime: new Date(day(3, 17, 30)).toISOString() } } });
    });

    await atest("delete_calendar_event asks first; only the yes deletes, and only that event", async () => {
      const ask = await registry.execute("delete_calendar_event", { title: "Dentist" }, ctx());
      assert.strictEqual(ask.needsConfirmation, true);
      assert.strictEqual(gcal.deleted.length, 0);
      const amb = await registry.execute("delete_calendar_event", { title: "standup" }, { ...ctx(), approved: true });
      assert.strictEqual(amb.error, "ambiguous_event");
      assert.strictEqual(gcal.deleted.length, 0);
      const res = await registry.execute("delete_calendar_event", { title: "Dentist" }, { ...ctx(), approved: true });
      assert.strictEqual(res.ok, true);
      assert.deepStrictEqual(gcal.deleted, ["ev3"]);
      assert.strictEqual(res.speak, "Cancelled Dentist.");
    });

    await atest("the pre-meeting brief is pushed ~25 min before, once", async () => {
      const saved = gcal.events;
      gcal.events = [{ id: "evM", title: "Client review", start: isoLocal(Date.now() + 20 * 60e3),
        end: isoLocal(Date.now() + 50 * 60e3), attendees: [{ email: "priya@acme.test", displayName: "Priya" }] }];
      try {
        await scheduler.sweepMeetings();
        const b = pushesTo(me).filter((p) => /^Client review in/.test(p.title));
        assert.strictEqual(b.length, 1);
        assert.match(b[0].title, /^Client review in (19|20) min with Priya$/);
        await scheduler.sweepMeetings();
        assert.strictEqual(pushesTo(me).filter((p) => /^Client review in/.test(p.title)).length, 1);
      } finally { gcal.events = saved; }
    });

    // DEFECT: google/api.js meetingPrep asks for events with timeMin=now,
    // which Google applies to an event's END — so a meeting in progress is
    // items[0], sweepMeetings sees startsIn <= 0 and skips the user, and
    // the next (back-to-back) meeting never gets its brief.
    await atest("back-to-back meetings: the next one is still briefed while the current one runs", async () => {
      const saved = gcal.events;
      gcal.events = [
        { id: "evNow", title: "Design sync", start: isoLocal(Date.now() - 40 * 60e3), end: isoLocal(Date.now() + 15 * 60e3) },
        { id: "evNext", title: "Budget review", start: isoLocal(Date.now() + 20 * 60e3),
          end: isoLocal(Date.now() + 50 * 60e3), attendees: [{ email: "kiran@acme.test", displayName: "Kiran" }] },
      ];
      try {
        await scheduler.sweepMeetings();
        const b = pushesTo(me).filter((p) => /^Budget review in/.test(p.title));
        assert.strictEqual(b.length, 1,
          "no brief for 'Budget review' starting in 20 min — the meeting already running was picked and skipped");
      } finally { gcal.events = saved; }
    });

    /* ================================================================ */
    console.log("\nemail: app-password mailbox (IMAP + SMTP stubbed)");
    /* ================================================================ */

    await atest("DELETE /google unlinks (revoked at Google) and the tools stop using it", async () => {
      assert.strictEqual((await api("DELETE", "/google")).status, 200);
      assert.deepStrictEqual((await api("GET", "/google/status")).json, { connected: false });
    });

    await atest("POST /email/account tests both logins, stores the password encrypted, never returns it", async () => {
      const bad = await api("POST", "/email/account", { body: { address: "Dhanush.K@gmail.com", password: "wrong-password" } });
      assert.strictEqual(bad.status, 400);
      assert.match(bad.json.error, /IMAP login failed at imap\.gmail\.com/);
      const ok = await api("POST", "/email/account",
        { body: { address: "Dhanush.K@gmail.com", password: "abcd efgh ijkl mnop" } });
      assert.strictEqual(ok.status, 200, ok.text);
      assert.deepStrictEqual(ok.json, { connected: true, address: "dhanush.k@gmail.com" });
      const row = await db.one(`SELECT imap_host, smtp_host, secrets_enc FROM email_accounts WHERE user_id=$1`, [U1]);
      assert.deepStrictEqual([row.imap_host, row.smtp_host], ["imap.gmail.com", "smtp.gmail.com"]);
      assert.ok(!row.secrets_enc.includes(IMAP_PASS));
      const g = await api("GET", "/email/account");
      assert.deepStrictEqual(g.json, { connected: true, address: "dhanush.k@gmail.com" });
      assert.ok(!g.text.includes(IMAP_PASS));
    });

    await atest("IMAP: read by sender, read one in full, reply in-thread over SMTP", async () => {
      const r = await registry.execute("email_read", { from: "ramesh" }, ctx());
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.deepStrictEqual(r.data.messages.map((m) => [m.uid, m.from]), [[101, "Ramesh Kumar"]]);
      const one = await registry.execute("email_read", { uid: "101" }, ctx());
      assert.match(one.data.body, /can we meet Friday at 10/);
      const res = await registry.execute("email_reply",
        { from: "Ramesh", body: "Friday works." }, { ...ctx(), approved: true });
      assert.strictEqual(res.ok, true, JSON.stringify(res));
      const m = smtpSent[smtpSent.length - 1];
      assert.deepStrictEqual(
        [m.host, m.from, m.to, m.subject, m.inReplyTo, m.references, m.text],
        ["smtp.gmail.com", "dhanush.k@gmail.com", "ramesh.reply@corp.test", "Re: Friday review",
          "<abc@corp.test>", "<abc@corp.test>", "Friday works."]);
    });

    // DEFECT (low): services/email.js listImportant keeps a per-user
    // 180 s cache (_impCache) that disconnecting never clears, so a bare
    // "read my mails" keeps reading the unlinked Gmail inbox for up to
    // three minutes (and after switching accounts, the OLD mailbox's list).
    await atest("DELETE /email/account disconnects; reading then says to connect", async () => {
      assert.deepStrictEqual((await api("DELETE", "/email/account")).json, { connected: false });
      const byName = await registry.execute("email_read", { from: "ramesh" }, ctx());
      assert.strictEqual(byName.error, "no mailbox connected");
      const r = await registry.execute("email_read", {}, ctx());
      assert.strictEqual(r.error, "no mailbox connected",
        `both mailboxes are unlinked, yet "read my mails" answered ok with ` +
        `${JSON.stringify((r.data && r.data.messages || []).map((m) => m.subject))} from the unlinked Gmail`);
    });

    /* ================================================================ */
    console.log("\ncalls the assistant places (Bolna stubbed, real webhook route)");
    /* ================================================================ */

    await atest("'call Ravi' just dials: no card, the phone resolves the contact", async () => {
      const res = await registry.execute("place_phone_call", { name: "Ravi" }, ctx());
      assert.strictEqual(res.ok, true);
      assert.ok(!res.needsConfirmation);
      assert.deepStrictEqual(
        [res.deviceAction.type, res.deviceAction.name, res.deviceAction.message, res.deviceAction.agent_available, res.deviceAction.via],
        ["resolve_and_call", "Ravi", null, true, "phone"]);
      assert.match(res.speak, /^Looking up Ravi/);
    });

    await atest("'call Ravi and tell him…' is read back first; only a new 'yes' sends it", async () => {
      const args = { name: "Ravi", message: "I will be late by ten minutes" };
      const a = await registry.execute("place_phone_call", args,
        { ...ctx(), userText: "call Ravi and tell him I will be late by ten minutes" });
      assert.strictEqual(a.needs_confirmation, true);
      assert.strictEqual(a.deviceAction, undefined, "dialled before the read-back");
      assert.strictEqual(a.data.read_back, "I will be late by ten minutes");
      const same = await registry.execute("place_phone_call", { ...args, confirmed: true },
        { ...ctx(), userText: "call Ravi and tell him I will be late by ten minutes" });
      assert.strictEqual(same.needs_confirmation, true, "confirmed without the user saying anything new");
      const yes = await registry.execute("place_phone_call", { ...args, confirmed: true }, { ...ctx(), userText: "haan" });
      assert.strictEqual(yes.ok, true);
      assert.strictEqual(yes.deviceAction.message, "I will be late by ten minutes");
      assert.strictEqual(yes.deviceAction.agent_available, true);
    });

    let callId, execId;
    await atest("POST /agent-call (the app's relay): 202, the provider gets the task, one Calls row 'dialing'", async () => {
      const n = bolnaCalls.length;
      const r = await api("POST", "/agent-call",
        { body: { toNumber: "98450 12345", contactName: "Ravi Kumar", task: "tell him I'll be late by ten minutes" } });
      assert.strictEqual(r.status, 202, r.text);
      callId = r.json.id;
      assert.strictEqual(bolnaCalls.length, n + 1);
      const c = bolnaCalls[bolnaCalls.length - 1];
      execId = c.execId;
      assert.strictEqual(c.auth, `Bearer ${BOLNA_KEY}`);
      assert.deepStrictEqual(
        [c.body.recipient_phone_number, c.body.user_data.contact_name, c.body.user_data.user_name,
          c.body.user_data.honorific, c.body.user_data.mode, c.body.user_data.task],
        ["+919845012345", "Ravi", "Dhanush", "sir", "inform", "tell him I'll be late by ten minutes"]);
      const rows = await waitFor(async () => {
        const x = await db.query(`SELECT * FROM task_outcomes WHERE external_id=$1`, [callId]);
        return x.length ? x : null;
      }, 3000, "the Calls row");
      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual([rows[0].kind, rows[0].target, rows[0].status], ["agent_call", "Ravi Kumar", "dialing"]);
      const st = await api("GET", `/agent-call/${callId}`);
      assert.deepStrictEqual(st.json, { state: "dialing", result: null, answer: null });
      assert.strictEqual((await api("POST", "/agent-call", { body: { contactName: "x" } })).status, 400);
    });

    await atest("the provider webhook: wrong secret 404, progress, then completed with their words", async () => {
      assert.strictEqual((await webhook({ id: execId, status: "completed" }, "0".repeat(32))).status, 404);
      assert.strictEqual((await api("GET", `/agent-call/${callId}`)).json.state, "dialing");
      await webhook({ id: execId, status: "in-progress" });
      assert.strictEqual((await api("GET", `/agent-call/${callId}`)).json.state, "in_progress");
      await webhook({ id: execId, status: "completed", conversation_duration: 22, summary: null,
        transcript: "assistant: Hello sir, I'm calling for Dhanush. He will be ten minutes late.\nuser: Okay, no problem, I'll wait." });
      const st = (await api("GET", `/agent-call/${callId}`)).json;
      assert.strictEqual(st.state, "completed");
      assert.strictEqual(st.result, 'I spoke with Ravi Kumar. They said: "Okay, no problem, I\'ll wait."');
      assert.match(st.answer, /user: Okay, no problem/);
      await webhook({ id: execId, status: "completed", conversation_duration: 22, transcript: "user: again" });
      const row = await waitFor(() => db.one(
        `SELECT * FROM task_outcomes WHERE external_id=$1 AND status='completed'`, [callId]), 3000, "completed row");
      assert.match(row.transcript, /user: Okay, no problem, I'll wait\./);
      const out = await api("GET", "/outcomes?kind=agent_call");
      const mine = out.json.outcomes.filter((o) => o.target === "Ravi Kumar");
      assert.strictEqual(mine.length, 1);
      assert.strictEqual(mine[0].ok, true);
    });

    await atest("another user cannot read the call", async () => {
      assert.strictEqual((await api("GET", `/agent-call/${callId}`, { token: T2 })).status, 404);
      assert.strictEqual((await api("GET", `/agent-call/${callId}`, { token: null })).status, 401);
    });

    await atest("a voicemail 'completed' is not a delivery: no answer, one attempt, no invented retry", async () => {
      const r = await api("POST", "/agent-call",
        { body: { toNumber: "+919845000001", contactName: "Suresh", task: "tell him the parcel came" } });
      const id = r.json.id;
      const ex = bolnaCalls[bolnaCalls.length - 1].execId;
      await callRow(id);
      await webhook({ id: ex, status: "completed", conversation_duration: 12, answered_by_voice_mail: true,
        transcript: "assistant: Hello?\nuser: The person you are calling is not available." });
      const st = (await api("GET", `/agent-call/${id}`)).json;
      assert.strictEqual(st.state, "no_answer");
      assert.match(st.result, /Suresh didn't pick up/);
      assert.strictEqual((await db.query(
        `SELECT id FROM jobs WHERE kind='agent_call_retry' AND payload->>'id'=$1`, [id])).length, 0);
      await waitFor(() => db.one(`SELECT 1 FROM task_outcomes WHERE external_id=$1 AND status='no_answer'`, [id]),
        3000, "no_answer row");
    });

    await atest("retry only when asked: busy → retry job at the user's gap → second attempt lands → one push", async () => {
      const r = await api("POST", "/agent-call", { body: { toNumber: "+919845000002", contactName: "Anil Rao",
        task: "ask him if the car is ready", retryTimes: 1, retryGapMinutes: 2 } });
      const id = r.json.id;
      const first = bolnaCalls[bolnaCalls.length - 1].execId;
      await callRow(id);
      const t0 = Date.now();
      await webhook({ id: first, status: "busy" });
      const st = (await api("GET", `/agent-call/${id}`)).json;
      assert.strictEqual(st.state, "no_answer");
      assert.match(st.result, /I'll call again in 2 minutes/);
      const job = await waitFor(() => db.one(
        `SELECT id, run_after FROM jobs WHERE kind='agent_call_retry' AND status='pending' AND payload->>'id'=$1`, [id]),
        3000, "the retry job");
      assert.ok(Math.abs(Number(job.run_after) - (t0 + 120_000)) < 3000);
      const row = await db.one(`SELECT status FROM task_outcomes WHERE external_id=$1`, [id]);
      assert.strictEqual(row.status, "dialing", "the Calls row went terminal while a retry was pending");
      const n = bolnaCalls.length;
      await runJob(Number(job.id));
      assert.strictEqual(bolnaCalls.length, n + 1, "the retry was not dialled");
      const second = bolnaCalls[bolnaCalls.length - 1];
      assert.strictEqual(second.body.recipient_phone_number, "+919845000002");
      await webhook({ id: first, status: "completed", conversation_duration: 9, transcript: "user: stale attempt" });
      assert.strictEqual((await api("GET", `/agent-call/${id}`)).json.state, "dialing", "a stale attempt settled the call");
      await webhook({ id: second.execId, status: "completed", conversation_duration: 18,
        transcript: "assistant: Is the car ready?\nuser: Yes, it is ready, he can pick it up at six." });
      assert.strictEqual((await api("GET", `/agent-call/${id}`)).json.state, "completed");
      await waitFor(() => pushesTo(me).some((p) => p.title === "Call to Anil Rao done"), 3000, "the outcome push");
      await waitFor(() => db.one(`SELECT 1 FROM task_outcomes WHERE external_id=$1 AND status='completed'`, [id]),
        3000, "completed row");
    });

    await atest("the daily cap: over the limit the app gets 402 quota, nothing dialled", async () => {
      process.env.AGENT_CALL_DAILY_LIMIT = "1";
      try {
        const a = await api("POST", "/agent-call", { token: T2,
          body: { toNumber: "+919845000003", contactName: "Meena", task: "tell her I'm on the way" } });
        assert.strictEqual(a.status, 202);
        const n = bolnaCalls.length;
        const b = await api("POST", "/agent-call", { token: T2,
          body: { toNumber: "+919845000003", contactName: "Meena", task: "tell her again" } });
        assert.strictEqual(b.status, 402);
        assert.strictEqual(b.json.error, "quota");
        assert.strictEqual(bolnaCalls.length, n);
      } finally { delete process.env.AGENT_CALL_DAILY_LIMIT; }
    });

    // ("a relayed call on the voice (SSE) path leaves ONE Calls row" drove the
    // classic /assistant loop's own call starter, which went with that loop on
    // 2026-09-29; calls are placed by the place_phone_call tool, below.)

    // DEFECT: place_phone_call('me') says "if you don't pick up, I'll try
    // again in five minutes" (builtins.js ~2660) but agentCall.start makes
    // ONE attempt unless retry_times was passed (agentCall.js ~800-808).
    await atest("a wake-up call keeps what it promised: 'I'll try again' means a retry is queued", async () => {
      const res = await registry.execute("place_phone_call", { name: "me", message: "Wake up, it's 5 am" }, ctx());
      assert.strictEqual(res.ok, true, JSON.stringify(res));
      const c = bolnaCalls[bolnaCalls.length - 1];
      assert.strictEqual(c.body.recipient_phone_number, me.phone_number);
      assert.strictEqual(c.body.user_data.mode, "self");
      await callRow(res.data.call_id);
      await webhook({ id: c.execId, status: "no-answer" });
      const st = agentCall.status(res.data.call_id);
      const retries = await db.query(
        `SELECT id FROM jobs WHERE kind='agent_call_retry' AND status='pending' AND payload->>'id'=$1`, [res.data.call_id]);
      const promised = /try again/i.test(res.speak);
      assert.ok(!promised || retries.length === 1,
        `told the user "${res.speak}" — after no answer the call ended as "${st.state}: ${st.result}" with no retry queued`);
    });

    // A scheduled call to a spoken NUMBER (no saved contact name) reports
    // "I spoke with there." (handlers.js placeScheduledAgentCall sets
    // resolvedName = "there" and agentCall.finishCompleted prints it).
    await atest("a scheduled call to a spoken number reports who it reached, not 'there'", async () => {
      const p = pushes.filter((x) => /^Done: Call 98450 12345/.test(x.title)).pop();
      assert.ok(p, "precondition: the scheduled call ran");
      assert.doesNotMatch(p.body, /\bwith there\b/, `push body: "${p.body}"`);
    });

    /* ================================================================ */
    console.log("\ncall recordings: upload → transcript → summary → agenda → push");
    /* ================================================================ */

    const wav = () => {
      const pcm = Buffer.alloc(40 * 1024, 1);
      const h = Buffer.alloc(44);
      h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
      h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
      h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
      h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
      return Buffer.concat([h, pcm]);
    };
    const meetAt = day(1, 10);
    analysisReply = () => JSON.stringify({
      summary: "Manish and Dhanush agreed to meet tomorrow at 10 am. Dhanush will send the invoice by Friday.",
      facts: ["Meeting tomorrow at 10 am at the office", "Invoice due by Friday"],
      items: [
        { kind: "meeting", text: "Meet Manish at the office", whenIso: isoLocal(meetAt) },
        { kind: "task", text: "Book the conference room", whenIso: "" },
        { kind: "promise", text: "Send the invoice to Manish", whenIso: "" },
      ],
      follow_up: "Thanks Manish — see you tomorrow at 10.",
    });
    transcribeText = "Dhanush: shall we meet tomorrow at ten? Manish: yes. Dhanush: I'll send the invoice by Friday.";
    const startedAt = Date.now() - 5 * 60e3;
    const upload = (token = T1) => {
      const fd = new FormData();
      fd.append("peerNumber", "+919812300000");
      fd.append("peerName", "Manish");
      fd.append("direction", "outgoing");
      fd.append("startedAtMs", String(startedAt));
      fd.append("durationSec", "0");
      fd.append("source", "system_recorder");
      fd.append("audio", new Blob([wav()], { type: "audio/wav" }), "Call Manish_260927_101500.wav");
      return api("POST", "/calls/upload", { token, form: fd });
    };

    let recId;
    await atest("consent: the toggle records when analysis was first agreed to", async () => {
      const before = (await api("GET", "/calls/analysis")).json;
      assert.deepStrictEqual(before, { enabled: true, consentAt: 0 });
      const on = await api("POST", "/calls/analysis", { body: { enabled: true } });
      assert.strictEqual(on.json.enabled, true);
      assert.ok(on.json.consentAt > 0);
    });

    await atest("a recording is analysed: summary, facts, follow-up; its meeting and task join the agenda, its promise the promises", async () => {
      const n = transcribeCount;
      const r = await upload();
      assert.strictEqual(r.status, 202, r.text);
      recId = r.json.id;
      const call = await waitFor(async () => {
        const x = (await api("GET", `/calls/${recId}`)).json.call;
        return x.status !== "processing" ? x : null;
      }, 8000, "the analysis");
      assert.strictEqual(call.status, "done");
      assert.ok(transcribeCount > n);
      assert.match(call.summary, /agreed to meet tomorrow at 10 am/);
      assert.deepStrictEqual(JSON.parse(call.facts), ["Meeting tomorrow at 10 am at the office", "Invoice due by Friday"]);
      assert.strictEqual(call.follow_up, "Thanks Manish — see you tomorrow at 10.");
      assert.strictEqual(JSON.parse(call.actions).length, 3);
      const meet = await db.one(`SELECT * FROM reminders WHERE user_id=$1 AND text LIKE 'Meeting: Meet Manish%'`, [U1]);
      assert.strictEqual(meet.text, "Meeting: Meet Manish at the office at 10:00 am");
      assert.strictEqual(Number(meet.due_at), meetAt - 5 * 60e3, "rings five minutes early");
      assert.strictEqual(meet.deliver, "notify", "a call transcript must not arm phone calls nobody asked for");
      assert.strictEqual((await reminderJobs(meet.id)).length, 0);
      const task = await db.one(`SELECT due_at FROM reminders WHERE user_id=$1 AND text='Book the conference room'`, [U1]);
      assert.strictEqual(task.due_at, null);
      const promise = await db.one(`SELECT owed_to, source FROM commitments WHERE user_id=$1 AND text='Send the invoice to Manish'`, [U1]);
      assert.deepStrictEqual([promise.owed_to, promise.source], ["Manish", "call"]);
      const p = await waitFor(() => pushesTo(me).find((x) => x.title === "Call notes ready"), 3000, "the push");
      assert.strictEqual(p.body, "3 items from your call with Manish added to your agenda.");
    });

    await atest("the same recording again is not analysed (or paid for) twice", async () => {
      const n = transcribeCount;
      const r = await upload();
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json, { id: recId, skipped: "duplicate" });
      await sleep(200);
      assert.strictEqual(transcribeCount, n);
    });

    await atest("the call list, call_recall and the follow-up read the stored analysis; other users see nothing", async () => {
      const recent = (await api("GET", "/calls/recent")).json.calls;
      assert.ok(recent.some((c) => c.id === recId && c.peer_name === "Manish"));
      assert.ok(!(await api("GET", "/calls/recent", { token: T2 })).json.calls.some((c) => c.id === recId));
      assert.strictEqual((await api("GET", `/calls/${recId}`, { token: T2 })).status, 404);
      const rc = await registry.execute("call_recall", { person: "Manish" }, ctx());
      assert.strictEqual(rc.ok, true);
      assert.match(rc.data.calls[0].facts, /Invoice due by Friday/);
      const before = aiLog.length;
      const f = await api("POST", `/calls/${recId}/follow-up`);
      assert.deepStrictEqual(f.json, { followUp: "Thanks Manish — see you tomorrow at 10." });
      assert.strictEqual(aiLog.length, before, "the stored follow-up was paid for again");
    });

    await atest("with analysis switched off, uploads are refused", async () => {
      await api("POST", "/calls/analysis", { body: { enabled: false } });
      assert.strictEqual((await upload()).status, 403);
    });

    /* ================================================================ */
    console.log("\nthe confirmation gate, one table");
    /* ================================================================ */

    await atest("send, reply and cancel-an-event always ask; a plain call or a reminder never does; after an email everything outbound asks", () => {
      const clean = { userId: U1 };
      const dirty = { userId: U1, __untrustedAt: Date.now() };
      const table = (c) => Object.fromEntries([
        "email_send", "email_reply", "delete_calendar_event", "update_calendar_event",
        "place_phone_call", "create_reminder", "schedule_task", "cancel_scheduled_task",
      ].map((t) => [t, registry.requiresConfirmation(t, c)]));
      assert.deepStrictEqual(table(clean), {
        email_send: true, email_reply: true, delete_calendar_event: true, update_calendar_event: false,
        place_phone_call: false, create_reminder: false, schedule_task: false, cancel_scheduled_task: false });
      assert.deepStrictEqual(table(dirty), {
        email_send: true, email_reply: true, delete_calendar_event: true, update_calendar_event: true,
        // schedule_task asks after outside content (Bills by email review,
        // 2026-09-27): an unattended job would otherwise launder the taint.
        place_phone_call: true, create_reminder: false, schedule_task: true, cancel_scheduled_task: false });
    });

    await atest("no request left the machine except to the stubs", () => {
      assert.deepStrictEqual(blocked, []);
    });
  } finally {
    runtime.runAgentTurn = realRunAgentTurn;
    server.close();
    if (parked.length) {
      await db.run(`UPDATE jobs SET run_after = run_after - ${PARK} WHERE id = ANY($1::bigint[])`, [parked]);
    }
    // SELF-CLEANING: every row these two users own, in every table.
    const ids = [U1, U2];
    const tables = await db.query(
      `SELECT DISTINCT table_name FROM information_schema.columns
        WHERE table_schema='public' AND column_name='user_id'`);
    for (const t of tables) {
      await db.run(`DELETE FROM "${t.table_name}" WHERE user_id = ANY($1::int[])`, [ids]).catch(() => {});
    }
    for (const id of ids) {
      await db.run(`DELETE FROM kv WHERE k LIKE $1 OR k LIKE $2`, [`%:${id}`, `%:${id}:%`]).catch(() => {});
    }
    await db.run(`DELETE FROM users WHERE id = ANY($1::int[])`, [ids]);
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) console.log("FAILED:\n  - " + failed.join("\n  - "));
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
