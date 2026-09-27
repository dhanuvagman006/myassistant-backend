/**
 * "HELP IMPROVE THE ASSISTANT" — `npm run test:improve`.
 *
 * Owner's decision (2026-09-27): ask once, and it stays OFF until the user
 * says yes. These pin:
 *   - GET/PUT /privacy/prefs: the ask, validation, the rate limit, the
 *     consent record;
 *   - turning it OFF: this user's recordings (rows and all three files)
 *     go now, turns are trimmed to 7 days / 100, quietly filed feedback
 *     goes — nobody else's is touched;
 *   - the recorder: nobody undecided or OFF is recorded, a call is dropped
 *     when they switch off, and a late stop is discarded before any merge;
 *   - no retroactive review: only what was said after the latest yes;
 *   - every admin screen that shows words, audio or files hides the rest,
 *     searches included, while counts still count;
 *   - quiet developer feedback needs a yes; asked-for feedback does not;
 *   - hari_reviewable() follows HELP_IMPROVE_DEFAULT; no views exist;
 *   - the daily sweep, account erasure and the export.
 *
 * Files live in a temp folder; nothing leaves this machine.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key-0123456789";
delete process.env.HELP_IMPROVE_DEFAULT;
delete process.env.LIVE_RECORD;

const os = require("os");
const fs = require("fs");
const path = require("path");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "improve-test-"));
process.env.DATA_DIR = path.join(TMP, "data");
process.env.LIVE_RECORD_DIR = path.join(TMP, "recordings");
const RECS = process.env.LIVE_RECORD_DIR;

const assert = require("assert");
const express = require("express");
const db = require("../src/db");

require("../src/services/firebase").deletePhoneUser = async () => "stubbed";

let passed = 0;
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(20); }
  throw new Error(`timed out waiting for ${what}`);
}
const touch = (file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "x"); return file; };
const exists = (p) => fs.existsSync(p);

(async () => {
  await db.init();
  const hi = require("../src/users/helpImprove");
  const recorder = require("../src/live/recorder");
  const recent = require("../src/memory/recent");
  await recorder.migrate();
  await recent.migrate();
  await require("../src/actions/store").migrate();
  await require("../src/outcomes/store").migrate();

  const stamp = String(Date.now()).slice(-7);
  const mk = async (tag) => (await db.createUser({ email: `hi-${tag}-${stamp}@example.test`, name: `Improve ${tag}` })).id;
  const Y = await mk("yes"); // says yes
  const N = await mk("no"); // says no
  const U = await mk("undecided"); // never answers
  const O = await mk("other"); // someone else, says yes: never touched by N's choice
  const USERS = [Y, N, U, O];

  const as = (req, _res, next) => { req.user = { sub: String(req.get("x-test-user") || "") }; next(); };
  const app = express();
  app.use(express.json());
  app.use("/privacy", as, require("../src/routes/privacy"));
  app.use("/admin-panel", require("../src/routes/admin_web"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (uid, p, opts = {}) => fetch(`${base}${p}`, {
    ...opts,
    headers: { ...(opts.json ? { "content-type": "application/json" } : {}), "x-test-user": String(uid) },
    body: opts.json ? JSON.stringify(opts.json) : undefined,
  });
  const put = (uid, body) => call(uid, "/privacy/prefs", { method: "PUT", json: body });
  const yes = { helpImprove: true, source: "ask_card", noticeVersion: "help-improve-v1" };
  const no = { helpImprove: false, source: "settings", noticeVersion: "help-improve-v1" };
  const login = await fetch(`${base}/admin-panel/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: process.env.ADMIN_KEY }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const admin = (p) => fetch(`${base}/admin-panel/api${p}`, { headers: { cookie } });

  const HOUR = 3600_000;
  const now = Date.now();
  let seq = 0;
  async function turn(uid, at, text) {
    const tid = `t-${uid}-${++seq}`;
    await db.run(`INSERT INTO conversation_turns (user_id, role, text, created_at, turn_id) VALUES ($1,'user',$2,$3,$4)`,
      [uid, `q ${text}`, at, tid]);
    await db.run(`INSERT INTO conversation_turns (user_id, role, text, created_at, turn_id) VALUES ($1,'assistant',$2,$3,$4)`,
      [uid, `a ${text}`, at + 1, tid]);
  }
  /** Content of every reviewable kind, at time `at`, tagged with a word. */
  async function content(uid, at, word) {
    await turn(uid, at, word);
    await db.run(`INSERT INTO executed_actions (user_id, tool, created_at, ok, result) VALUES ($1,'web_search',$2,0,$3)`,
      [uid, at, `failed ${word}`]);
    await db.run(`INSERT INTO task_outcomes (user_id, kind, status, created_at, updated_at, target, detail, reason, transcript)
                  VALUES ($1,'call','failed',$2,$2,$3,$3,$3,$3)`, [uid, at, `callee ${word}`]);
    await db.run(`INSERT INTO actions_log (user_id, action, detail, created_at) VALUES ($1,'test.act',$2,$3)`,
      [uid, `detail ${word}`, at]);
    await db.run(`INSERT INTO developer_feedback (user_id, kind, summary, created_at, user_asked) VALUES ($1,'bug',$2,$3,0)`,
      [uid, `quiet ${word}`, at]);
    const f = touch(path.join(TMP, "data", "files", String(uid), `${word}.txt`));
    await db.run(`INSERT INTO documents (user_id, filename, mime, size, path, created_at, title) VALUES ($1,$2,'text/plain',1,$3,$4,$2)`,
      [uid, `doc ${word}`, f, at]);
  }
  async function recording(uid, at, tag) {
    const day = path.join(RECS, "2026-09-20");
    const stem = path.join(day, `rec-${tag}-${stamp}`);
    for (const ext of [".m4a", ".user.pcm", ".agent.pcm"]) touch(stem + ext);
    await db.run(`INSERT INTO live_recordings (user_id, session_id, started_at, file, state, bytes) VALUES ($1,$2,$3,$4,'ready',1)`,
      [uid, `s-${tag}-${stamp}`, at, stem + ".m4a"]);
    return stem;
  }

  console.log("\nasking once");

  await atest("policy ask: nobody has answered, the card is asked for, and it is off", async () => {
    const r = await (await call(U, "/privacy/prefs")).json();
    assert.strictEqual(r.helpImprove, null);
    assert.strictEqual(r.effective, false);
    assert.strictEqual(r.ask, true);
    assert.strictEqual(r.noticeVersion, "help-improve-v1");
    assert.strictEqual(r.keeps.recordingDays, 14);
    assert.strictEqual(r.keeps.privateTurnDays, 7);
    assert.strictEqual(await hi.allowsReview(U), false);
  });

  await atest("policy on: undecided counts as on, and nothing is asked", async () => {
    process.env.HELP_IMPROVE_DEFAULT = "on";
    try {
      const r = await (await call(U, "/privacy/prefs")).json();
      assert.deepStrictEqual([r.effective, r.ask], [true, false]);
    } finally {
      delete process.env.HELP_IMPROVE_DEFAULT;
    }
  });

  await atest("PUT is validated, needs a user, and is rate-limited", async () => {
    assert.strictEqual((await put(U, { ...yes, helpImprove: "yes" })).status, 400);
    assert.strictEqual((await put(U, { ...yes, noticeVersion: "v0" })).status, 400);
    assert.strictEqual((await put(U, { ...yes, source: "admin" })).status, 400);
    assert.strictEqual((await put("", yes)).status, 401);
    const T = await mk("throttle");
    USERS.push(T);
    for (let i = 0; i < 10; i++) assert.strictEqual((await put(T, i % 2 ? no : yes)).status, 200);
    assert.strictEqual((await put(T, yes)).status, 429);
    const events = await db.one(`SELECT count(*)::int AS n FROM consent_events WHERE user_id = $1`, [T]);
    assert.strictEqual(events.n, 10);
  });

  console.log("\nno retroactive review");

  // Y and O have content from before they said yes; O says yes now.
  await content(Y, now - 3 * HOUR, "before");
  await content(O, now - 3 * HOUR, "obefore");
  const recYOld = await recording(Y, now - 3 * HOUR, "yold");
  let yesAt;
  await atest("saying yes starts a consent period; only what comes after it is reviewable", async () => {
    const r = await (await put(Y, yes)).json();
    assert.strictEqual(r.helpImprove, true);
    assert.strictEqual(r.effective, true);
    assert.strictEqual(r.removed, undefined);
    await put(O, yes);
    const pp = await db.one(`SELECT * FROM privacy_prefs WHERE user_id = $1`, [Y]);
    yesAt = Number(pp.on_since);
    assert.ok(yesAt >= now - 5000);
    const ev = await db.one(`SELECT * FROM consent_events WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [Y]);
    assert.deepStrictEqual([ev.kind, ev.value, ev.notice_version, ev.source], ["help_improve", 1, "help-improve-v1", "ask_card"]);
    await content(Y, Date.now() + 1000, "after");
    const words = (await recent.adminConversations({ userId: Y })).map((c) => c.answer);
    assert.deepStrictEqual(words, ["a after"]);
    // A second yes keeps the period it is in.
    await put(Y, yes);
    assert.strictEqual(Number((await db.one(`SELECT on_since FROM privacy_prefs WHERE user_id = $1`, [Y])).on_since), yesAt);
  });

  await atest("hari_reviewable: off and undecided are never reviewable; on only from on_since", async () => {
    const rv = async (uid, ts) => (await db.one(`SELECT hari_reviewable($1, $2) AS ok`, [uid, ts])).ok;
    assert.strictEqual(await rv(U, Date.now()), false);
    assert.strictEqual(await rv(Y, yesAt - 1), false);
    assert.strictEqual(await rv(Y, yesAt), true);
    // HELP_IMPROVE_DEFAULT=on, "rebooted": undecided counts as on.
    process.env.HELP_IMPROVE_DEFAULT = "on";
    try {
      await hi.migrate((sql) => db.query(sql));
      assert.strictEqual(await rv(U, 1), true);
      assert.strictEqual(await rv(Y, yesAt - 1), false);
    } finally {
      delete process.env.HELP_IMPROVE_DEFAULT;
      await hi.migrate((sql) => db.query(sql));
    }
    assert.strictEqual(await rv(U, 1), false);
    const views = await db.one(`SELECT count(*)::int AS n FROM information_schema.views WHERE table_schema = 'public'`);
    assert.strictEqual(views.n, 0);
  });

  console.log("\nthe admin panel");

  await content(U, now - HOUR, "undecidedword");
  await recording(U, now - HOUR, "u");
  const recY = await recording(Y, Date.now() + 1000, "ynew");
  const docOf = async (uid, word) => db.one(`SELECT id FROM documents WHERE user_id = $1 AND title = $2`, [uid, `doc ${word}`]);
  await db.run(`INSERT INTO user_instructions (user_id, instruction, created_at) VALUES ($1, 'call me Sir', $2)`, [U, now]);

  await atest("conversations and the CSV: only reviewable turns", async () => {
    const r = await (await admin("/conversations?limit=200")).json();
    const answers = r.conversations.map((c) => c.answer);
    assert.ok(answers.includes("a after"));
    for (const w of ["a before", "a undecidedword", "a obefore"]) assert.ok(!answers.includes(w), `${w} shown`);
    const csv = await (await admin("/conversations.csv")).text();
    assert.ok(csv.includes("a after") && !csv.includes("undecidedword") && !csv.includes("a before"));
  });

  await atest("user detail: the choice is shown; their rules and hidden details are not", async () => {
    const d = await (await admin(`/users/${U}`)).json();
    assert.strictEqual(d.helpImprove, "not_asked");
    assert.deepStrictEqual(d.instructions, []);
    assert.strictEqual(d.instructionsHidden, true);
    assert.ok(d.recent.every((a) => a.detail === "(hidden)" || a.action !== "test.act"));
    assert.deepStrictEqual(d.conversations, []);
    assert.strictEqual((await (await admin(`/users/${Y}`)).json()).helpImprove, "on");
    const list = await (await admin(`/users?q=${encodeURIComponent(`hi-no-${stamp}`)}`)).json();
    assert.ok("help_improve" in list.users[0]);
  });

  await atest("recordings: hidden ones are neither listed nor playable", async () => {
    const r = await (await admin("/recordings?limit=200")).json();
    const ids = r.recordings.map((x) => x.session_id);
    assert.ok(ids.includes(`s-ynew-${stamp}`));
    assert.ok(!ids.includes(`s-yold-${stamp}`) && !ids.includes(`s-u-${stamp}`));
    const hidden = await db.one(`SELECT id FROM live_recordings WHERE session_id = $1`, [`s-u-${stamp}`]);
    assert.strictEqual((await admin(`/recordings/${hidden.id}/audio`)).status, 404);
    void recY;
  });

  await atest("failures: hidden rows are counted but not shown, and never an example", async () => {
    const r = await (await admin("/failures?hours=24&limit=500")).json();
    const results = r.rows.map((x) => x.result);
    assert.ok(results.includes("failed after"));
    assert.ok(!results.some((x) => /undecidedword|failed before/.test(x)));
    const g = r.groups.find((x) => x.tool === "web_search" && x.decision === "ran");
    assert.ok(g && g.n >= 3, "hidden rows are no longer counted");
    assert.ok(!/undecidedword|before/.test(g.example));
  });

  await atest("the ledger of someone who never said yes is hidden", async () => {
    const r = await (await admin(`/users/${U}/ledger`)).json();
    assert.deepStrictEqual([r.hidden, r.reason], [true, "help_improve_off"]);
    const csv = await (await admin(`/users/${U}/ledger.csv`)).text();
    assert.ok(!csv.includes("undecidedword"));
  });

  await atest("outcomes: status kept, words blank; a search cannot find hidden words", async () => {
    const r = await (await admin(`/outcomes?user_id=${U}`)).json();
    const o = r.outcomes[0];
    assert.strictEqual(o.status, "failed");
    assert.ok(!JSON.stringify(o).includes("undecidedword"));
    const s = await (await admin(`/outcomes?q=undecidedword`)).json();
    assert.strictEqual(s.outcomes.length, 0);
    const y = await (await admin(`/outcomes?q=${encodeURIComponent("callee after")}`)).json();
    assert.ok(y.outcomes.length >= 1);
  });

  await atest("activity: detail hidden; a search cannot find hidden words", async () => {
    const r = await (await admin(`/activity?user_id=${U}`)).json();
    const mine = r.activity.filter((a) => a.action === "test.act");
    assert.ok(mine.length && mine.every((a) => a.detail === "(hidden)"));
    assert.strictEqual((await (await admin(`/activity?q=undecidedword`)).json()).activity.length, 0);
    assert.ok((await (await admin(`/activity?q=${encodeURIComponent("detail after")}`)).json()).activity.length >= 1);
  });

  await atest("feedback: quietly filed rows of people who did not say yes are hidden", async () => {
    await db.run(`INSERT INTO developer_feedback (user_id, kind, summary, created_at, user_asked) VALUES ($1,'bug',$2,$3,1)`,
      [U, `asked undecidedword`, now]);
    const r = await (await admin(`/feedback?limit=200`)).json();
    const sums = r.feedback.map((f) => f.summary);
    assert.ok(sums.includes("quiet after"));
    assert.ok(sums.includes("asked undecidedword"), "feedback they asked to pass on is hidden");
    assert.ok(!sums.includes("quiet undecidedword") && !sums.includes("quiet before"));
  });

  await atest("documents: lists and CSV leave them out; the preview is 403", async () => {
    const r = await (await admin(`/documents?limit=200`)).json();
    const titles = r.documents.map((d) => d.title);
    assert.ok(titles.includes("doc after"));
    assert.ok(!titles.includes("doc undecidedword") && !titles.includes("doc before"));
    assert.strictEqual((await (await admin(`/users/${U}/documents`)).json()).documents.length, 0);
    const csv = await (await admin(`/documents.csv`)).text();
    assert.ok(!csv.includes("undecidedword"));
    const hidden = await docOf(U, "undecidedword");
    assert.strictEqual((await admin(`/documents/${hidden.id}/file`)).status, 403);
    const shown = await docOf(Y, "after");
    assert.strictEqual((await admin(`/documents/${shown.id}/file`)).status, 200);
  });

  console.log("\nthe recorder");

  await atest("nobody undecided is recorded, and no warning is logged for it", async () => {
    const warn = console.warn;
    const warned = [];
    console.warn = (...a) => warned.push(a.join(" "));
    try {
      const h = recorder.begin(U, `live-u-${stamp}`);
      h.user(Buffer.alloc(3200));
      await sleep(150);
      await h.stop();
    } finally {
      console.warn = warn;
    }
    assert.strictEqual(await db.one(`SELECT 1 FROM live_recordings WHERE session_id = $1`, [`live-u-${stamp}`]), null);
    const today = path.join(RECS, new Date().toISOString().slice(0, 10));
    const files = exists(today) ? fs.readdirSync(today).filter((f) => f.includes(`live-u-${stamp}`)) : [];
    assert.deepStrictEqual(files, []);
    assert.ok(!warned.some((w) => /recorder/.test(w)), warned.join("\n"));
  });

  await atest("someone who said yes is recorded; switching off mid-call drops it", async () => {
    const sid = `live-y-${stamp}`;
    const h = recorder.begin(Y, sid);
    await until(async () => db.one(`SELECT 1 FROM live_recordings WHERE session_id = $1`, [sid]), "the row");
    h.user(Buffer.alloc(64000));
    const today = path.join(RECS, new Date().toISOString().slice(0, 10));
    const raw = path.join(today, `${sid}.user.pcm`);
    await until(() => exists(raw), "raw audio");
    await put(Y, no);
    assert.ok(!exists(raw), "the open call's audio survived the switch-off");
    assert.strictEqual(await db.one(`SELECT 1 FROM live_recordings WHERE session_id = $1`, [sid]), null);
    await h.stop();
    assert.ok(!exists(path.join(today, `${sid}.m4a`)));
    await put(Y, yes);
  });

  await atest("a stop after the switch went off discards the call before any merge", async () => {
    const sid = `live-late-${stamp}`;
    const h = recorder.begin(O, sid);
    await until(async () => db.one(`SELECT 1 FROM live_recordings WHERE session_id = $1`, [sid]), "the row");
    h.user(Buffer.alloc(64000));
    // The switch flipped without dropOpen reaching this call (another pod).
    await db.run(`UPDATE privacy_prefs SET help_improve = 0 WHERE user_id = $1`, [O]);
    await h.stop();
    const today = path.join(RECS, new Date().toISOString().slice(0, 10));
    for (const ext of [".m4a", ".user.pcm", ".agent.pcm"]) assert.ok(!exists(path.join(today, sid + ext)), ext);
    assert.strictEqual(await db.one(`SELECT 1 FROM live_recordings WHERE session_id = $1`, [sid]), null);
    await db.run(`UPDATE privacy_prefs SET help_improve = 1 WHERE user_id = $1`, [O]);
  });

  console.log("\nturning it off");

  await atest("OFF: their recordings, old turns and quiet feedback go now — nobody else's", async () => {
    await content(N, now - 10 * 86_400_000, "ancient");
    for (let i = 0; i < 110; i++) await turn(N, now - 60_000 + i, `recent${i}`);
    await db.run(`INSERT INTO developer_feedback (user_id, kind, summary, created_at, user_asked) VALUES ($1,'bug','asked by N',$2,1)`, [N, now]);
    const nStem = await recording(N, now - HOUR, "n");
    const oStem = await recording(O, now - HOUR, "o");
    const escapee = touch(path.join(TMP, "outside", "n-escape.m4a"));
    await db.run(`INSERT INTO live_recordings (user_id, session_id, started_at, file, state) VALUES ($1,$2,$3,$4,'failed')`,
      [N, `esc-${stamp}`, now, [RECS, "2026-09-20", "..", "..", "outside", "n-escape.m4a"].join(path.sep)]);
    const r = await (await put(N, no)).json();
    assert.deepStrictEqual([r.helpImprove, r.effective], [false, false]);
    assert.strictEqual(r.removed.recordings, 2);
    assert.strictEqual(r.removed.feedback, 1);
    assert.ok(r.removed.turns >= 12, JSON.stringify(r.removed));
    for (const ext of [".m4a", ".user.pcm", ".agent.pcm"]) {
      assert.ok(!exists(nStem + ext), `N's ${ext} survived`);
      assert.ok(exists(oStem + ext), `O's ${ext} was deleted`);
    }
    assert.ok(exists(escapee), "a path outside the recordings folder was unlinked");
    const left = await db.one(
      `SELECT count(*)::int AS n, min(created_at) AS oldest FROM conversation_turns WHERE user_id = $1`, [N]);
    assert.ok(left.n <= 100, `${left.n} turns kept`);
    assert.ok(Number(left.oldest) >= now - 7 * 86_400_000);
    const fb = await db.query(`SELECT summary FROM developer_feedback WHERE user_id = $1`, [N]);
    assert.deepStrictEqual(fb.map((f) => f.summary), ["asked by N"]);
    const ev = await db.one(`SELECT value FROM consent_events WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [N]);
    assert.strictEqual(ev.value, 0);
    assert.strictEqual((await db.one(`SELECT count(*)::int AS n FROM live_recordings WHERE user_id = $1`, [O])).n >= 1, true);
  });

  await atest("off, then on again: what was said while off stays hidden", async () => {
    await turn(N, Date.now(), "while-off");
    await sleep(5);
    await put(N, yes);
    await turn(N, Date.now() + 10, "back-on");
    const words = (await recent.adminConversations({ userId: N, limit: 200 })).map((c) => c.answer);
    assert.deepStrictEqual(words, ["a back-on"]);
    await put(N, no);
  });

  await atest("the daily sweep: a stray recording of an OFF user goes; undecided users are untouched", async () => {
    const stray = await recording(N, Date.now(), "stray");
    for (let i = 0; i < 5; i++) await turn(U, now - 30 * 86_400_000 + i, `old-u${i}`);
    const uBefore = (await db.one(`SELECT count(*)::int AS n FROM conversation_turns WHERE user_id = $1`, [U])).n;
    await hi.sweep();
    assert.ok(!exists(stray + ".m4a"));
    assert.strictEqual(await db.one(`SELECT 1 FROM live_recordings WHERE session_id = $1`, [`s-stray-${stamp}`]), null);
    const uAfter = (await db.one(`SELECT count(*)::int AS n FROM conversation_turns WHERE user_id = $1`, [U])).n;
    assert.strictEqual(uAfter, uBefore);
  });

  console.log("\ndeveloper feedback");

  await atest("OFF: nothing is filed quietly; what they asked to pass on still is", async () => {
    const registry = require("../src/tools/registry");
    require("../src/tools/builtins").registerBuiltins();
    const tool = registry.get("send_developer_feedback");
    const quiet = await tool.execute({ summary: `quiet from N ${stamp}` }, { userId: N });
    assert.deepStrictEqual([quiet.ok, quiet.error], [false, "help_improve_off"]);
    assert.strictEqual(await db.one(`SELECT 1 FROM developer_feedback WHERE summary = $1`, [`quiet from N ${stamp}`]), null);
    const asked = await tool.execute({ summary: `asked from N ${stamp}`, user_asked: true }, { userId: N });
    assert.strictEqual(asked.ok, true);
    const row = await db.one(`SELECT user_asked FROM developer_feedback WHERE summary = $1`, [`asked from N ${stamp}`]);
    assert.strictEqual(row.user_asked, 1);
    const cc = require("../src/agents/claimCheck");
    assert.strictEqual(cc.check("I've passed that on to the developer.", [{ tool: "send_developer_feedback", ok: false }]).ok, false);
  });

  console.log("\nthe user's own rights");

  await atest("the export has their choice and consent record; erasure removes both", async () => {
    const ex = await (await call(Y, "/privacy/export")).json();
    assert.strictEqual(ex.privacy_prefs.length, 1);
    assert.ok(ex.consent_events.length >= 2);
    const { deleteUserEverywhere } = require("../src/routes/privacy");
    await deleteUserEverywhere(Y);
    assert.strictEqual(await db.one(`SELECT 1 FROM privacy_prefs WHERE user_id = $1`, [Y]), null);
    assert.strictEqual(await db.one(`SELECT 1 FROM consent_events WHERE user_id = $1`, [Y]), null);
  });

  await atest("the privacy policy says it plainly", async () => {
    const legal = express().use("/legal", require("../src/routes/legal"));
    const s = await new Promise((r) => { const x = legal.listen(0, "127.0.0.1", () => r(x)); });
    try {
      const html = await (await fetch(`http://127.0.0.1:${s.address().port}/legal/privacy`)).text();
      assert.ok(!/do not store your voice as audio recordings/i.test(html));
      assert.ok(!/not kept as recordings/i.test(html));
      assert.match(html, /Help improve the assistant/);
      assert.match(html, /This setting is off unless you turn it on\./);
      assert.match(html, /If you connect Notion/);
    } finally {
      s.close();
    }
  });

  const { deleteUserEverywhere } = require("../src/routes/privacy");
  for (const u of USERS) await deleteUserEverywhere(u).catch(() => {});
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed${process.exitCode ? " — with failures above" : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
