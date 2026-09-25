/**
 * ACCOUNT ERASURE — `npm run test:erase`.
 *
 * Owner, 2026-09-25: "delete old user accounts and data's from the
 * database", and then "i ran but db files have not yet deleted". The
 * admin panel's Delete user removed the rows it knew about and nothing
 * else: call recordings (rows AND audio), conversation turns, mail
 * logins, document files and a dozen newer tables all outlived the
 * account, and the Recordings page kept listing the calls.
 *
 * These pin:
 *   (a) both delete doors — the panel's and the app's — leave the account
 *       with zero rows in every user table, no files, no Google grant, and
 *       leave everybody else exactly as they were;
 *   (b) a SCHEMA GUARD: every table with a user column is either erased,
 *       handled as shared, or explicitly declared not personal — so the
 *       next new table cannot be forgotten the way these were;
 *   (c) the panel's Leftovers: it counts exactly what older deletes left,
 *       removes exactly that, and nothing that still belongs to someone.
 *
 * Nothing leaves this machine: fetch is stubbed for every host but the
 * local test server, and Firebase is stubbed. The files live in a temp
 * folder. The Leftovers purge is database-wide, so this refuses to run
 * against anything that is not a local database.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key-0123456789";

if (process.env.NODE_ENV === "production" ||
    !/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(process.env.DATABASE_URL)) {
  console.error("erase-test purges orphans database-wide: it only runs against a local test database.");
  process.exit(1);
}

const os = require("os");
const fs = require("fs");
const path = require("path");

// Temp roots BEFORE any module reads them. Always overridden: a test must
// never unlink anything in a real data folder.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "erase-test-"));
process.env.DATA_DIR = path.join(TMP, "data");
process.env.LIVE_RECORD_DIR = path.join(TMP, "recordings");
process.env.LIVE_RECORD = "1";
const FILES = path.join(TMP, "data", "files");
const RECS = path.join(TMP, "recordings");
const OUTSIDE = path.join(TMP, "outside");
fs.mkdirSync(OUTSIDE, { recursive: true });

// Every outbound request is recorded and answered locally.
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (/^http:\/\/127\.0\.0\.1:\d+\//.test(u)) return realFetch(url, opts);
  outbound.push({ url: u, method: opts.method || "GET" });
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

const assert = require("assert");
const express = require("express");
const db = require("../src/db");

const firebase = require("../src/services/firebase");
const firebaseCalls = [];
firebase.deletePhoneUser = async (phone) => { firebaseCalls.push(phone); return "deleted"; };

const privacy = require("../src/routes/privacy");
const recorder = require("../src/live/recorder");

let passed = 0;
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
}

/** Every lazily-created table too: the guard cannot judge what it cannot see. */
async function ensureEveryTable() {
  await db.init();
  for (const m of [
    "actions/store", "agents/tasks", "live/recorder", "memory/recent",
    "outcomes/store", "practice/store", "records/store", "routes/contacts",
    "routes/finance", "routes/usage", "services/email", "services/pendingPush",
    "studio/store", "tools/searchCache",
  ]) {
    await require("../src/" + m).migrate();
  }
}

/* ------------------------------------------------------------------ *
 * Seeding: one row per user table, whatever its columns are
 * ------------------------------------------------------------------ */

const colCache = new Map();
async function columnsOf(table) {
  if (!colCache.has(table)) {
    colCache.set(table, await db.query(
      `SELECT column_name, data_type, is_nullable, column_default, is_generated, is_identity
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`, [table]));
  }
  return colCache.get(table);
}

let seq = 0;
function filler(c, uid) {
  seq++;
  switch (c.data_type) {
    case "integer": case "bigint": case "smallint": return seq;
    case "numeric": case "real": case "double precision": return 1;
    case "boolean": return false;
    case "json": case "jsonb": return "{}";
    case "timestamp with time zone": case "timestamp without time zone": return new Date();
    default: return `seed-${uid}-${c.column_name}-${seq}`;
  }
}

/**
 * Inserts one row owned by `uid`, filling every required column. A table
 * this cannot fill fails the test by name, so a new table with an odd
 * constraint is noticed rather than silently skipped.
 */
async function seedRow(table, userCol, uid, over = {}) {
  const names = [];
  const vals = [];
  for (const c of await columnsOf(table)) {
    const n = c.column_name;
    if (c.is_generated === "ALWAYS" || c.is_identity === "YES") continue;
    if (n in over) { names.push(n); vals.push(over[n]); continue; }
    if (n === userCol) { names.push(n); vals.push(String(uid)); continue; }
    if (c.column_default !== null || c.is_nullable === "YES") continue;
    names.push(n);
    vals.push(filler(c, uid));
  }
  const ph = vals.map((_, i) => `$${i + 1}`).join(", ");
  try {
    return await db.one(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${ph}) RETURNING *`, vals);
  } catch (e) {
    throw new Error(`could not seed ${table}: ${e.message}`);
  }
}

const touch = (file, body = "x") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};
const exists = (p) => fs.existsSync(p);
const DAY = "2026-09-01";
const recStem = (uid) => path.join(RECS, DAY, `sess-${uid}`);

/** Rows in every user table, recording rows + audio, document files, keys. */
async function seedUser(uid, { phone }) {
  for (const [table, col] of await privacy.existingUserTables()) {
    if (table === "live_recordings" || table === "chat_group_members") continue; // real ones below
    await seedRow(table, col, uid);
  }
  // A finished recording: the row, its merged audio, and both raw halves.
  const stem = recStem(uid);
  await db.run(
    `INSERT INTO live_recordings (user_id, session_id, started_at, file, state, bytes)
     VALUES ($1, $2, $3, $4, 'ready', 1)`,
    [uid, `sess-${uid}-${Date.now()}`, Date.now(), stem + ".m4a"]);
  touch(stem + ".m4a"); touch(stem + ".user.pcm"); touch(stem + ".agent.pcm");
  // Document files, where docs/store.js puts them.
  touch(path.join(FILES, String(uid), "1.pdf"));
  touch(path.join(FILES, String(uid), "2.jpg"));
  // The keys kv holds for them.
  for (const k of [`call_analysis:${uid}`, `brief:${uid}:ev1`, `morning:${uid}:2026-09-25`, `pdate:${uid}:3:2026`]) {
    await db.run(`INSERT INTO kv (k, v) VALUES ($1, '1') ON CONFLICT (k) DO NOTHING`, [k]);
  }
  if (phone) await db.run(`UPDATE users SET phone_number = $1 WHERE id = $2`, [phone, uid]);
}

async function rowsOf(uid) {
  const out = {};
  for (const [table, col] of await privacy.existingUserTables()) {
    const r = await db.one(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [String(uid)]);
    out[table] = r.n;
  }
  return out;
}

async function newGroup(title, createdBy, members, createdAt = Date.now()) {
  const g = await db.one(
    `INSERT INTO chat_groups (title, created_by, created_at) VALUES ($1, $2, $3) RETURNING id`,
    [title, createdBy, createdAt]);
  for (const m of members) {
    await db.run(
      `INSERT INTO chat_group_members (group_id, user_id, joined_at) VALUES ($1, $2, $3)`,
      [g.id, m, Date.now()]);
  }
  return Number(g.id);
}
const say = (gid, from, body) => db.one(
  `INSERT INTO chat_group_messages (group_id, from_user_id, body, created_at)
   VALUES ($1, $2, $3, $4) RETURNING id`, [gid, from, body, Date.now()]).then((r) => Number(r.id));
const tell = (from, toPhone, message) => db.one(
  `INSERT INTO agent_messages (from_user_id, to_phone_number, message, created_at)
   VALUES ($1, $2, $3, $4) RETURNING id`, [from, toPhone, message, Date.now()]).then((r) => Number(r.id));

(async () => {
  await ensureEveryTable();

  /* ================================================================ *
   * (b) SCHEMA GUARD
   * ================================================================ */
  console.log("\nno user table can be forgotten");

  await atest("every table the source creates exists once every migration has run", async () => {
    // Otherwise a new lazily-created table would be invisible to the
    // guard below — add its migrate() to ensureEveryTable().
    const made = new Set();
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".js")) {
          for (const m of fs.readFileSync(p, "utf8").matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/gi)) {
            made.add(m[1].toLowerCase());
          }
        }
      }
    };
    walk(path.join(__dirname, "..", "src"));
    const have = new Set((await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    )).map((r) => r.table_name));
    const missing = [...made].filter((t) => !have.has(t));
    assert.deepStrictEqual(missing, [], "tables the guard cannot see — add their migrate() to ensureEveryTable()");
    assert.ok(made.size > 50, `found only ${made.size} CREATE TABLEs — the scan is broken`);
  });

  await atest("every table with a user column is erased, shared, or declared not personal", async () => {
    const rows = await db.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = ANY($1::text[])
        ORDER BY table_name`, [privacy.USER_COLUMNS]);
    const erased = new Set(privacy.USER_TABLES.map(([t, c]) => `${t}.${c}`));
    const forgotten = rows
      .filter((r) => r.table_name !== "users")
      .filter((r) => !erased.has(`${r.table_name}.${r.column_name}`))
      .filter((r) => privacy.SHARED_TABLES[r.table_name] !== r.column_name)
      .filter((r) => !privacy.NOT_PERSONAL[r.table_name])
      .map((r) => `${r.table_name}.${r.column_name}`);
    assert.deepStrictEqual(forgotten, [],
      "add these to USER_TABLES in src/routes/privacy.js (or to NOT_PERSONAL, with the reason)");
    assert.ok(rows.length > 50, "the guard saw almost no user columns — it is not looking");
  });

  await atest("the lists are sound: no duplicates, and every exemption says why", () => {
    const keys = privacy.USER_TABLES.map(([t, c]) => `${t}.${c}`);
    assert.strictEqual(new Set(keys).size, keys.length, "USER_TABLES lists a table twice");
    for (const [t, why] of Object.entries(privacy.NOT_PERSONAL)) {
      assert.ok(typeof why === "string" && why.length > 10, `NOT_PERSONAL.${t} needs a reason`);
    }
    for (const t of ["live_recordings", "conversation_turns", "email_accounts", "call_records",
      "task_outcomes", "chat_group_members", "user_devices", "pending_pushes"]) {
      assert.ok(keys.some((k) => k.startsWith(t + ".")), `${t} is not erased`);
    }
  });

  /* ================================================================ *
   * (a) BOTH DELETE DOORS
   * ================================================================ */
  const stamp = String(Date.now()).slice(-8);
  const mk = async (tag, phone) => {
    const u = await db.createUser({ email: `erase-${tag}-${stamp}@example.test`, name: `Erase ${tag}` });
    await seedUser(u.id, { phone });
    return u.id;
  };
  const PHONE = { A: `+9170${stamp}`, B: `+9171${stamp}`, C: `+9172${stamp}` };
  const A = await mk("a", PHONE.A); // deleted from the admin panel
  const B = await mk("b", PHONE.B); // must come through untouched
  const C = await mk("c", PHONE.C); // deletes their own account in the app

  // Groups: G1 is shared, G2 is A's alone and must go with A.
  const G1 = await newGroup("family", A, [A, B, C]);
  const G2 = await newGroup("just me", A, [A]);
  const msgA1 = await say(G1, A, "A in the family group");
  const msgB1 = await say(G1, B, "B in the family group");
  const msgC1 = await say(G1, C, "C in the family group");
  await say(G2, A, "A talking to himself");
  // Agent messages: to A's number, from A, and to somebody not on the app.
  const toA = await tell(B, PHONE.A, "B to A");
  const toC = await tell(B, PHONE.C, "B to C");
  const fromA = await tell(A, PHONE.B, "A to B");
  const toStranger = await tell(B, "+910000000001", "B to a stranger");
  // uid A followed by a 0 is somebody else's id: the prefix must not reach it.
  const lookalike = `brief:${A}0:ev1`;
  await db.run(`INSERT INTO kv (k, v) VALUES ($1, '1') ON CONFLICT (k) DO NOTHING`, [lookalike]);
  // Recording rows whose path escapes the recordings folder: the file on
  // the other end must survive.
  const escapee = touch(path.join(OUTSIDE, "a-escape.m4a"));
  const absolute = touch(path.join(OUTSIDE, "a-absolute.m4a"));
  await db.run(
    `INSERT INTO live_recordings (user_id, session_id, started_at, file, state)
     VALUES ($1, $2, $3, $4, 'ready'), ($1, $5, $3, $6, 'ready')`,
    // Joined by hand: path.join would fold the ".." away before it is stored.
    [A, `esc-${stamp}`, Date.now(), [RECS, DAY, "..", "..", "outside", "a-escape.m4a"].join(path.sep),
     `abs-${stamp}`, absolute]);
  // A call A is on right now: its raw audio is being written.
  const liveSession = `live-${A}-${stamp}`;
  const handle = recorder.begin(A, liveSession);
  for (let i = 0; i < 100; i++) {
    if (await db.one(`SELECT 1 FROM live_recordings WHERE session_id = $1`, [liveSession])) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 30));
  handle.user(Buffer.alloc(3200));
  const liveDay = new Date().toISOString().slice(0, 10);
  const livePcm = path.join(RECS, liveDay, `${liveSession}.user.pcm`);
  assert.ok(exists(livePcm), "the live call never started recording");

  // B as the deletes must leave them: everything, less the two messages
  // B sent to A and C — messages to a deleted account's number go too.
  const bBefore = await rowsOf(B);
  const bExpect = { ...bBefore, agent_messages: bBefore.agent_messages - 2 };

  const app = express();
  app.use("/admin-panel", require("../src/routes/admin_web"));
  app.use("/privacy", (req, _res, next) => { req.user = { sub: String(req.get("x-test-user")) }; next(); },
    privacy);
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/admin-panel/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: process.env.ADMIN_KEY }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const admin = (p, opts = {}) => fetch(`${base}/admin-panel/api${p}`,
    { ...opts, headers: { ...(opts.headers || {}), cookie } });

  console.log("\nDelete user in the admin panel");

  await atest("it is behind the admin login, and a bad id is refused", async () => {
    assert.strictEqual((await fetch(`${base}/admin-panel/api/users/${A}`, { method: "DELETE" })).status, 401);
    assert.strictEqual((await fetch(`${base}/admin-panel/api/maintenance/orphans`)).status, 401);
    assert.strictEqual((await fetch(`${base}/admin-panel/api/maintenance/orphans/purge`, { method: "POST" })).status, 401);
    assert.strictEqual((await admin(`/users/abc`, { method: "DELETE" })).status, 400);
    assert.strictEqual(await db.one(`SELECT 1 AS x FROM users WHERE id = $1`, [A]).then(Boolean), true);
  });

  let reportA;
  await atest("it reports what it removed, table by table and file by file", async () => {
    const res = await admin(`/users/${A}`, { method: "DELETE" });
    assert.strictEqual(res.status, 200);
    reportA = await res.json();
    assert.strictEqual(reportA.ok, true);
    assert.strictEqual(reportA.existed, true);
    assert.strictEqual(reportA.rows.users, 1);
    // The seeded one, the call in progress, and the two with bad paths.
    assert.strictEqual(reportA.rows.live_recordings, 4);
    assert.strictEqual(reportA.rows.conversation_turns, 1);
    assert.strictEqual(reportA.rows.email_accounts, 1);
    assert.strictEqual(reportA.files.recordings, 3, "the .m4a and both raw halves");
    assert.strictEqual(reportA.files.documents, 2);
    assert.strictEqual(reportA.revoked.google, "revoked");
    assert.strictEqual(reportA.revoked.liveRecordings, 1);
    assert.strictEqual(reportA.revoked.mcpConnections, 1);
    assert.strictEqual(reportA.revoked.firebase, "deleted");
    assert.strictEqual(reportA.totalRows,
      Object.values(reportA.rows).reduce((a, b) => a + b, 0));
  });

  await atest("A has no row left in any user table", async () => {
    const left = Object.entries(await rowsOf(A)).filter(([, n]) => n > 0);
    assert.deepStrictEqual(left, []);
    assert.strictEqual(await db.one(`SELECT 1 AS x FROM users WHERE id = $1`, [A]), null);
  });

  await atest("A's recordings are gone from disk and from the Recordings page", async () => {
    for (const ext of [".m4a", ".user.pcm", ".agent.pcm"]) {
      assert.ok(!exists(recStem(A) + ext), `${ext} still on disk`);
    }
    assert.ok(!exists(livePcm), "the call in progress kept writing");
    const listed = await recorder.list({ limit: 200 });
    assert.ok(!listed.some((r) => Number(r.user_id) === A));
  });

  await atest("a stored path can never reach outside the recordings folder", async () => {
    assert.ok(exists(escapee), "a ../ path deleted a file outside the root");
    assert.ok(exists(absolute), "an absolute path deleted a file outside the root");
  });

  await atest("A's document folder is gone", async () => {
    assert.ok(!exists(path.join(FILES, String(A))));
  });

  await atest("A's keys are gone, and a longer id that starts the same is not touched", async () => {
    const left = await db.query(`SELECT k FROM kv WHERE k LIKE ANY($1::text[]) OR k = $2`,
      [[`brief:${A}:%`, `morning:${A}:%`, `pdate:${A}:%`], `call_analysis:${A}`]);
    assert.deepStrictEqual(left, []);
    assert.ok(await db.one(`SELECT 1 AS x FROM kv WHERE k = $1`, [lookalike]));
  });

  await atest("messages to A's number are gone, nobody else's are", async () => {
    const ids = (await db.query(`SELECT id FROM agent_messages WHERE id = ANY($1::bigint[])`,
      [[toA, fromA, toC, toStranger]])).map((r) => Number(r.id));
    assert.ok(!ids.includes(toA), "the next owner of A's number would read these");
    assert.ok(!ids.includes(fromA));
    assert.ok(ids.includes(toC) && ids.includes(toStranger));
  });

  await atest("in groups, A's words are blanked, the group stays for the others", async () => {
    const m = await db.one(`SELECT body, deleted FROM chat_group_messages WHERE id = $1`, [msgA1]);
    assert.deepStrictEqual({ body: m.body, deleted: Number(m.deleted) }, { body: "", deleted: 1 });
    const b = await db.one(`SELECT body, deleted FROM chat_group_messages WHERE id = $1`, [msgB1]);
    assert.strictEqual(b.body, "B in the family group");
    assert.ok(await db.one(`SELECT 1 AS x FROM chat_groups WHERE id = $1`, [G1]));
    assert.strictEqual(await db.one(`SELECT 1 AS x FROM chat_groups WHERE id = $1`, [G2]), null,
      "a group with nobody left in it should go");
    assert.strictEqual((await db.one(
      `SELECT count(*)::int AS n FROM chat_group_messages WHERE group_id = $1`, [G2])).n, 0);
  });

  await atest("Google was told, Firebase was told, and nothing else left the machine", async () => {
    const google = outbound.filter((o) => o.url.startsWith("https://oauth2.googleapis.com/revoke"));
    assert.strictEqual(google.length, 1);
    assert.match(google[0].url, new RegExp(`seed-${A}-refresh_token`));
    assert.strictEqual(outbound.length, google.length, JSON.stringify(outbound));
    assert.deepStrictEqual(firebaseCalls, [PHONE.A]);
  });

  await atest("deleting again is harmless and says there was nothing", async () => {
    const r = await (await admin(`/users/${A}`, { method: "DELETE" })).json();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.existed, false);
    assert.strictEqual(r.totalRows, 0);
    assert.strictEqual(r.totalFiles, 0);
  });

  console.log("\nDelete account in the app");

  await atest("the app's own delete removes the same things", async () => {
    const res = await fetch(`${base}/privacy/account`, { method: "DELETE", headers: { "x-test-user": String(C) } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true, deleted: true });
    const left = Object.entries(await rowsOf(C)).filter(([, n]) => n > 0);
    assert.deepStrictEqual(left, []);
    assert.strictEqual(await db.one(`SELECT 1 AS x FROM users WHERE id = $1`, [C]), null);
    for (const ext of [".m4a", ".user.pcm", ".agent.pcm"]) assert.ok(!exists(recStem(C) + ext));
    assert.ok(!exists(path.join(FILES, String(C))));
    assert.strictEqual(await db.one(`SELECT 1 AS x FROM agent_messages WHERE id = $1`, [toC]), null);
    const m = await db.one(`SELECT body, deleted FROM chat_group_messages WHERE id = $1`, [msgC1]);
    assert.strictEqual(m.body, "");
    const google = outbound.filter((o) => o.url.includes(`seed-${C}-refresh_token`));
    assert.strictEqual(google.length, 1, "C's Google grant was not revoked");
    assert.deepStrictEqual(firebaseCalls, [PHONE.A, PHONE.C]);
  });

  console.log("\neverybody else");

  await atest("B's rows, files, keys, messages and group are exactly as they were", async () => {
    assert.deepStrictEqual(await rowsOf(B), bExpect);
    for (const ext of [".m4a", ".user.pcm", ".agent.pcm"]) assert.ok(exists(recStem(B) + ext));
    assert.ok(exists(path.join(FILES, String(B), "1.pdf")));
    assert.ok(await db.one(`SELECT 1 AS x FROM kv WHERE k = $1`, [`call_analysis:${B}`]));
    assert.ok(await db.one(`SELECT 1 AS x FROM agent_messages WHERE id = $1`, [toStranger]));
    const mem = await db.one(`SELECT 1 AS x FROM chat_group_members WHERE group_id = $1 AND user_id = $2`, [G1, B]);
    assert.ok(mem, "B was taken out of their group");
    assert.ok(!outbound.some((o) => o.url.includes(`seed-${B}-`)), "B's Google grant was revoked");
    assert.ok(!firebaseCalls.includes(PHONE.B));
  });

  await atest("B's export has their data, with the mail password redacted", async () => {
    const res = await fetch(`${base}/privacy/export`, { headers: { "x-test-user": String(B) } });
    const d = await res.json();
    assert.strictEqual(d.live_recordings.length, 1);
    assert.strictEqual(d.email_accounts.length, 1);
    assert.strictEqual(d.email_accounts[0].secrets_enc, "[stored — redacted]");
  });

  /* ================================================================ *
   * (c) LEFTOVERS
   * ================================================================ */
  console.log("\nLeftovers from earlier deletes");

  // A user an older delete took out of `users` and nothing else.
  const GHOST = 2_000_000_000 + (Date.now() % 100_000);
  await seedUser(GHOST, {});
  const ghostTables = (await privacy.existingUserTables())
    .map(([t]) => t).filter((t) => t !== "chat_group_members");
  const ghostMsg = await say(G1, GHOST, "said before the old delete");
  await db.run(`INSERT INTO chat_group_members (group_id, user_id, joined_at) VALUES ($1, $2, $3)`,
    [G1, GHOST, Date.now()]);
  // A group only the ghost was in, made long ago — and one made a moment
  // ago, which may simply not have its members yet.
  const G3 = await newGroup("ghost town", GHOST, [GHOST], Date.now() - 2 * 86_400_000);
  await say(G3, GHOST, "anyone?");
  const G4 = await newGroup("being created", GHOST, [], Date.now());
  // Audio no row points at: an old one is dead, a fresh one may be a call.
  const oldStray = touch(path.join(RECS, "2026-09-02", "stray-old.m4a"));
  const oldDate = new Date(Date.now() - 86_400_000);
  fs.utimesSync(oldStray, oldDate, oldDate);
  const newStray = touch(path.join(RECS, "2026-09-02", "stray-new.user.pcm"));
  // Rows that belong to nobody on purpose: the server's own alert, a
  // system job. Neither is a deleted user's.
  const alert = await db.one(
    `INSERT INTO developer_feedback (user_id, kind, summary, created_at)
     VALUES (0, 'alert', $1, $2) RETURNING id`, [`erase-test alert ${stamp}`, Date.now()]);
  const systemJob = await seedRow("jobs", "user_id", 0, { user_id: null });
  const systemJobs = (await db.one(`SELECT count(*)::int AS n FROM jobs WHERE user_id IS NULL`)).n;

  let found;
  await atest("the Recordings page labels a deleted account's call as such", async () => {
    const listed = await recorder.list({ limit: 200 });
    const ghost = listed.find((r) => Number(r.user_id) === GHOST);
    assert.ok(ghost, "the ghost's recording is listed");
    assert.strictEqual(ghost.user_exists, false);
    assert.strictEqual(listed.find((r) => Number(r.user_id) === B).user_exists, true);
  });

  await atest("the panel counts every table, the audio and the document folders", async () => {
    const res = await admin(`/maintenance/orphans`);
    assert.strictEqual(res.status, 200);
    found = await res.json();
    for (const t of ghostTables) {
      assert.ok(found.tables[t] >= 1, `${t}: the ghost's row is not counted`);
    }
    assert.ok(found.tables["chat_group_members"] >= 2);
    assert.ok(found.tables["chat_group_messages (blanked)"] >= 1);
    assert.ok(found.tables["chat_groups (nobody left)"] >= 1);
    assert.ok(found.tables["chat_group_messages"] >= 1, "G3's message goes with G3");
    assert.ok(found.tables["kv (their keys)"] >= 4);
    assert.ok(found.files.recordingFiles >= 3);
    assert.ok(found.files.strayRecordingFiles >= 1);
    assert.ok(found.files.documentFolders >= 1);
    assert.ok(found.files.documentFiles >= 2);
    assert.ok(!(`users` in found.tables));
  });

  await atest("purge removes exactly what was counted", async () => {
    const res = await admin(`/maintenance/orphans/purge`, { method: "POST" });
    assert.strictEqual(res.status, 200);
    const done = await res.json();
    assert.deepStrictEqual(done.tables, found.tables);
    assert.deepStrictEqual(done.files, found.files);
    assert.strictEqual(done.totalRows, found.totalRows);
    assert.strictEqual(done.totalFiles, found.totalFiles);
    const again = await (await admin(`/maintenance/orphans`)).json();
    assert.strictEqual(again.totalRows, 0, JSON.stringify(again.tables));
    assert.strictEqual(again.totalFiles, 0, JSON.stringify(again.files));
    assert.strictEqual(again.files.documentFolders, 0);
  });

  await atest("the ghost is gone: rows, audio, documents, keys, its empty group", async () => {
    const left = Object.entries(await rowsOf(GHOST)).filter(([, n]) => n > 0);
    assert.deepStrictEqual(left, []);
    for (const ext of [".m4a", ".user.pcm", ".agent.pcm"]) assert.ok(!exists(recStem(GHOST) + ext));
    assert.ok(!exists(path.join(FILES, String(GHOST))));
    assert.ok(!exists(oldStray));
    assert.strictEqual(await db.one(`SELECT 1 AS x FROM kv WHERE k = $1`, [`call_analysis:${GHOST}`]), null);
    assert.strictEqual(await db.one(`SELECT 1 AS x FROM chat_groups WHERE id = $1`, [G3]), null);
    const m = await db.one(`SELECT body, deleted FROM chat_group_messages WHERE id = $1`, [ghostMsg]);
    assert.deepStrictEqual({ body: m.body, deleted: Number(m.deleted) }, { body: "", deleted: 1 });
  });

  await atest("and nothing that still belongs to someone was touched", async () => {
    assert.deepStrictEqual(await rowsOf(B), bExpect);
    for (const ext of [".m4a", ".user.pcm", ".agent.pcm"]) assert.ok(exists(recStem(B) + ext));
    assert.ok(exists(path.join(FILES, String(B), "2.jpg")));
    assert.ok(exists(newStray), "a fresh raw file may belong to a call in progress");
    assert.ok(exists(escapee) && exists(absolute));
    assert.ok(await db.one(`SELECT 1 AS x FROM chat_groups WHERE id = $1`, [G1]));
    assert.ok(await db.one(`SELECT 1 AS x FROM chat_groups WHERE id = $1`, [G4]), "a group being created was removed");
    const b = await db.one(`SELECT body FROM chat_group_messages WHERE id = $1`, [msgB1]);
    assert.strictEqual(b.body, "B in the family group");
    assert.ok(await db.one(`SELECT 1 AS x FROM developer_feedback WHERE id = $1`, [alert.id]),
      "the server's own alert (user 0) is nobody's leftover");
    assert.strictEqual((await db.one(`SELECT count(*)::int AS n FROM jobs WHERE user_id IS NULL`)).n,
      systemJobs, "a system job (no user) is nobody's leftover");
  });

  await atest("the panel shows the Leftovers card with a confirm that states the numbers", () => {
    const js = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "admin_panel", "app.js"), "utf8");
    assert.match(js, /leftoversCard\(\)/);
    assert.match(js, /api\("\/maintenance\/orphans\/purge", \{ method: "POST" \}\)/);
    assert.match(js, /if \(!confirm\(msg\)\) return;/);
    assert.match(js, /\$\{d\.totalRows\} database rows/);
    assert.match(js, /Remove leftovers/);
  });

  // Tidy up after ourselves.
  server.close();
  await privacy.deleteUserEverywhere(B, { reason: "test cleanup" }).catch(() => {});
  await db.run(`DELETE FROM chat_group_messages WHERE group_id = ANY($1::bigint[])`, [[G1, G4]]);
  await db.run(`DELETE FROM chat_groups WHERE id = ANY($1::bigint[])`, [[G1, G4]]);
  await db.run(`DELETE FROM chat_group_members WHERE group_id = ANY($1::bigint[])`, [[G1, G4]]);
  await db.run(`DELETE FROM developer_feedback WHERE id = $1`, [alert.id]);
  await db.run(`DELETE FROM agent_messages WHERE id = $1`, [toStranger]);
  await db.run(`DELETE FROM kv WHERE k = $1`, [lookalike]);
  await db.run(`DELETE FROM jobs WHERE id = $1`, [systemJob.id]);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
