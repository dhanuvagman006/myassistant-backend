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
 *       removes exactly that, and nothing that still belongs to someone —
 *       and when it cannot tell what is in use, it removes nothing;
 *   (d) a live call the account is on is ended by the delete, and writes
 *       nothing under the erased id afterwards (review, 2026-09-25).
 *
 * The whole run includes the LEGACY tables: made by code that shipped and
 * was later removed, never DROPped, so an older database still has them.
 * They are created here with their historical columns and dropped again at
 * the end, so every delete and the Leftovers are checked against them too.
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

/**
 * A second copy of privacy.js whose database is `wrap(realDb)`, for making
 * one query fail. Everything else (recorder, Firebase stub, the admin
 * panel's copy) stays as it was.
 */
function privacyWithDb(wrap) {
  const dbMod = require.cache[require.resolve("../src/db")];
  const privPath = require.resolve("../src/routes/privacy");
  const realDb = dbMod.exports;
  const realPriv = require.cache[privPath];
  try {
    dbMod.exports = wrap(realDb);
    delete require.cache[privPath];
    return require("../src/routes/privacy");
  } finally {
    dbMod.exports = realDb;
    require.cache[privPath] = realPriv;
  }
}

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
    "studio/store", "tools/searchCache", "posters/store", "shortcuts/store",
  ]) {
    await require("../src/" + m).migrate();
  }
}

/**
 * Tables the code once made and no longer does, with the columns they had
 * (from git history). None was ever DROPped, so a production database
 * created before the removal still holds them, rows and all.
 */
const LEGACY_TABLES = {
  // Taken out of init() on 2026-08-10 (917ca95).
  memories: `id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL,
    category TEXT NOT NULL DEFAULT 'fact', key TEXT NOT NULL, value TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'ai', created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL, UNIQUE(user_id, key)`,
  agent_calls: `id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_name TEXT NOT NULL,
    to_number TEXT NOT NULL, task TEXT NOT NULL, lang TEXT NOT NULL DEFAULT 'en-IN',
    state TEXT NOT NULL DEFAULT 'queued', transcript TEXT NOT NULL DEFAULT '[]',
    result TEXT, provider_call_id TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL`,
  agent_call_settings: `user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
    daily_limit INTEGER NOT NULL DEFAULT 10, hours_start INTEGER NOT NULL DEFAULT 8,
    hours_end INTEGER NOT NULL DEFAULT 21`,
  subscriptions: `user_id TEXT PRIMARY KEY, plan TEXT NOT NULL, period_end BIGINT NOT NULL,
    last_payment TEXT, updated_at BIGINT NOT NULL`,
  usage: `user_id TEXT NOT NULL, kind TEXT NOT NULL, period TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, kind, period)`,
  families: `id SERIAL PRIMARY KEY, owner_id TEXT NOT NULL UNIQUE, code TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL`,
  family_members: `family_id INTEGER NOT NULL, user_id TEXT NOT NULL UNIQUE,
    joined_at BIGINT NOT NULL, PRIMARY KEY (family_id, user_id)`,
  payments: `payment_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan TEXT NOT NULL,
    amount INTEGER NOT NULL, created_at BIGINT NOT NULL`,
  swiggy_tokens: `user_id INTEGER PRIMARY KEY, refresh_token TEXT NOT NULL, access_token TEXT,
    expires_at BIGINT, updated_at BIGINT NOT NULL`,
  // Removed later (review, 2026-09-25). Four hold the id of something an
  // outside service keeps; the delete removes the row, not the thing.
  calling_agent_prefs: `user_id INTEGER PRIMARY KEY, character TEXT NOT NULL DEFAULT 'polite',
    persona TEXT NOT NULL DEFAULT '', voice TEXT NOT NULL DEFAULT 'monika',
    brain TEXT NOT NULL DEFAULT 'balanced', language TEXT NOT NULL DEFAULT 'hi',
    bolna_agent_id TEXT NOT NULL DEFAULT '', updated_at BIGINT NOT NULL DEFAULT 0`,
  voice_profiles: `user_id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'elevenlabs',
    voice_id TEXT NOT NULL, label TEXT, created_at BIGINT NOT NULL`,
  assistant_settings: `user_id TEXT PRIMARY KEY, disclose_assistant INT NOT NULL DEFAULT 1,
    require_confirmation INT NOT NULL DEFAULT 1`,
  avatar_personas: `user_id INTEGER PRIMARY KEY, persona_id TEXT NOT NULL, api_key TEXT NOT NULL,
    created_at BIGINT NOT NULL`,
  avatar_sessions: `conversation_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
    started_at BIGINT NOT NULL, ended_at BIGINT`,
  conversation_state: `user_id INTEGER PRIMARY KEY, summary TEXT NOT NULL DEFAULT '',
    updated_at BIGINT NOT NULL`,
  did_agents: `user_id INTEGER NOT NULL, mode TEXT NOT NULL DEFAULT 'assistant',
    agent_id TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (user_id, mode)`,
  did_briefings: `user_id INTEGER NOT NULL, day TEXT NOT NULL, talk_id TEXT,
    status TEXT NOT NULL DEFAULT 'creating', result_url TEXT, script TEXT,
    created_at BIGINT NOT NULL, PRIMARY KEY (user_id, day)`,
};

/** Creates the legacy tables this database lacks; returns those it made. */
async function createLegacyTables() {
  const have = new Set((await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  )).map((r) => r.table_name));
  const made = [];
  for (const [t, cols] of Object.entries(LEGACY_TABLES)) {
    if (have.has(t)) continue; // a real legacy table: used, never dropped
    await db.run(`CREATE TABLE "${t}" (${cols})`);
    made.push(t);
  }
  return made;
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
    // A shortcut's name points at one of their own shortcuts (a foreign key).
    if (table === "shortcut_names") continue;
    await seedRow(table, col, uid);
  }
  const sc = await db.one("SELECT id FROM shortcuts WHERE user_id = $1 ORDER BY id LIMIT 1", [uid]);
  await seedRow("shortcut_names", "user_id", uid, { shortcut_id: sc.id });
  // Search text and links belong to one of their own documents: those of
  // a document that is gone are a leftover of their own (see Leftovers).
  const doc = await db.one(`SELECT id FROM documents WHERE user_id = $1 ORDER BY id LIMIT 1`, [uid]);
  for (const t of ["document_chunks", "document_links"]) {
    await db.run(`UPDATE ${t} SET document_id = $2 WHERE user_id = $1`, [uid, doc.id]);
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
  for (const k of [`call_analysis:${uid}`, `brief:${uid}:ev1`, `morning:${uid}:2026-09-25`, `pdate:${uid}:3:2026`,
    `momentum:${uid}:2026-09-25`, `momentum:${uid}:earned`]) {
    await db.run(`INSERT INTO kv (k, v) VALUES ($1, '1') ON CONFLICT (k) DO NOTHING`, [k]);
  }
  if (phone) await db.run(`UPDATE users SET phone_number = $1 WHERE id = $2`, [phone, uid]);
  await optIn(uid);
}

/**
 * "Help improve the assistant" is on for this tester: only then are their
 * calls recorded and listed (users/helpImprove.js; test:improve pins it).
 */
async function optIn(uid) {
  await db.run(
    `INSERT INTO privacy_prefs (user_id, help_improve, on_since, updated_at) VALUES ($1, 1, 0, $2)
     ON CONFLICT (user_id) DO UPDATE SET help_improve = 1, on_since = 0`, [uid, Date.now()]);
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
  const legacyMade = await createLegacyTables();

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

  await atest("the legacy tables of removed code are in this run, and every one is erased", async () => {
    // The guard above now sees them too; this pins that it really does.
    const erased = new Set((await privacy.existingUserTables()).map(([t]) => t));
    const missing = Object.keys(LEGACY_TABLES).filter((t) => !erased.has(t) && !privacy.NOT_PERSONAL[t]);
    assert.deepStrictEqual(missing, [], "legacy tables not erased — add them to USER_TABLES");
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
  app.use(express.json());
  app.use("/profile", (req, _res, next) => { req.user = { sub: String(req.get("x-test-user")) }; next(); },
    require("../src/routes/profile"));
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
      [[`brief:${A}:%`, `morning:${A}:%`, `pdate:${A}:%`, `momentum:${A}:%`], `call_analysis:${A}`]);
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

  await atest("B's export has their data, with the mail password and the persona key redacted", async () => {
    const res = await fetch(`${base}/privacy/export`, { headers: { "x-test-user": String(B) } });
    const d = await res.json();
    assert.strictEqual(d.live_recordings.length, 1);
    assert.strictEqual(d.email_accounts.length, 1);
    assert.strictEqual(d.email_accounts[0].secrets_enc, "[stored — redacted]");
    // Legacy: the bearer key a Tavus persona presented to this server.
    assert.strictEqual(d.avatar_personas.length, 1);
    assert.strictEqual(d.avatar_personas[0].api_key, "[stored — redacted]");
    assert.match(d.avatar_personas[0].persona_id, /^seed-/);
    assert.strictEqual(d.voice_profiles.length, 1);
    // What B wrote in a group (SHARED_TABLES, so not in the table loop).
    const said = d.chat_group_messages_written;
    assert.ok(said.some((m) => m.body === "B in the family group"), "B's group messages are not exported");
    assert.ok(said.every((m) => Number(m.from_user_id) === B), "someone else's group message is in B's export");
  });

  await atest("a standing rule deleted in Settings or by voice is removed, not kept inactive", async () => {
    // "Delete an item … and it is removed immediately" (the privacy policy).
    const as = { "x-test-user": String(B), "content-type": "application/json" };
    const rule = `never call after 9 pm ${stamp}`;
    const made = await (await fetch(`${base}/profile/instructions`, {
      method: "POST", headers: as, body: JSON.stringify({ instruction: rule }) })).json();
    assert.ok(made.instruction && made.instruction.id);
    const del = await fetch(`${base}/profile/instructions/${made.instruction.id}`, { method: "DELETE", headers: as });
    assert.strictEqual(del.status, 200);
    assert.strictEqual(await db.one(`SELECT 1 AS x FROM user_instructions WHERE id = $1`, [made.instruction.id]), null,
      "the deleted rule is still stored");
    // "You don't need to ask before reminders anymore" (remove_standing_instruction).
    const spoken = `always ask before reminders ${stamp}`;
    await (await fetch(`${base}/profile/instructions`, {
      method: "POST", headers: as, body: JSON.stringify({ instruction: spoken }) })).json();
    assert.strictEqual(await require("../src/users/context").removeInstruction(B, `reminders ${stamp}`), 1);
    assert.deepStrictEqual(await db.query(`SELECT id FROM user_instructions WHERE instruction = $1`, [spoken]), [],
      "the rule removed by voice is still stored");
    const d = await (await fetch(`${base}/privacy/export`, { headers: as })).text();
    assert.ok(!d.includes(rule), "the deleted rule is still in the export");
    assert.ok(!d.includes(spoken), "the rule removed by voice is still in the export");
  });

  await atest("deleting a document takes its text everywhere, and an index job still running writes none back", async () => {
    // Audit 2026-09-27: the row went; its search chunks, links and the
    // index job's copy of the text stayed, and were exported. An index job
    // still waiting or embedding when the delete ran wrote them back.
    const store = require("../src/docs/store");
    const intelligence = require("../src/docs/intelligence");
    const embeddings = require("../src/memory/embeddings");
    const realEmbed = embeddings.embed;
    const text = `Biopsy report ${stamp}. Nothing of it may stay.`;
    const newDoc = () => db.one(
      `INSERT INTO documents (user_id, filename, mime, size, path, title, category, full_text, created_at)
       VALUES ($1, 'biopsy.txt', 'text/plain', 10, $2, 'Biopsy', 'medical', $3, $4) RETURNING id`,
      [B, path.join(FILES, String(B), `biopsy-${stamp}.txt`), text, Date.now()]);
    const traces = async (id) => (await db.query(
      `SELECT 'chunk' AS t FROM document_chunks WHERE user_id = $1 AND document_id = $2
       UNION ALL SELECT 'link' FROM document_links WHERE user_id = $1 AND document_id = $2
       UNION ALL SELECT 'job' FROM jobs WHERE user_id = $1 AND payload->>'documentId' = $3`,
      [B, id, String(id)])).map((r) => r.t).sort();
    try {
      embeddings.embed = async () => null;
      const d1 = await newDoc();
      await require("../src/infra/jobs").enqueue("document.index", { userId: B, documentId: d1.id, text }, { userId: B });
      await intelligence.indexDocument(B, d1.id, text);
      await db.run(`INSERT INTO document_links (user_id, document_id, entity_type, entity_id, created_at)
        VALUES ($1, $2, 'person', 1, $3)`, [B, d1.id, Date.now()]);
      assert.deepStrictEqual(await traces(d1.id), ["chunk", "job", "link"]);
      assert.strictEqual(await store.deleteDocument(B, d1.id), true);
      assert.deepStrictEqual(await traces(d1.id), [], "the deleted document left its text behind");
      // Deleted while its index job was embedding (a wrong upload, removed at once).
      const d2 = await newDoc();
      embeddings.embed = async () => { await store.deleteDocument(B, d2.id); return null; };
      assert.strictEqual((await intelligence.indexDocument(B, d2.id, text)).chunks, 0);
      assert.deepStrictEqual(await traces(d2.id), [], "the index job wrote the text back after the delete");
      const d = await (await fetch(`${base}/privacy/export`, { headers: { "x-test-user": String(B) } })).text();
      assert.ok(!d.includes(`Biopsy report ${stamp}`), "a deleted document's text is in the export");
    } finally {
      embeddings.embed = realEmbed;
    }
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
  // The search text and a link of a document B deleted before a delete
  // took them too (audit, 2026-09-27). B is still here; these are not.
  const goneDoc = 9_000_000_000 + (Date.now() % 100_000);
  const goneChunk = await seedRow("document_chunks", "user_id", B,
    { document_id: goneDoc, text: `deleted report ${stamp}` });
  await seedRow("document_links", "user_id", B, { document_id: goneDoc });
  // Its document.index job, kept after it ran, whose payload is the same
  // text — and one for a document B still has, which stays.
  const indexJob = (documentId, text) => seedRow("jobs", "user_id", B,
    { kind: "document.index", payload: JSON.stringify({ userId: B, documentId, text }) });
  const goneJob = await indexJob(goneDoc, `deleted report ${stamp}`);
  const bDoc = await db.one(`SELECT id FROM documents WHERE user_id = $1 ORDER BY id LIMIT 1`, [B]);
  const liveJob = await indexJob(bDoc.id, `kept report ${stamp}`);

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
    assert.ok(found.tables["document_chunks (document deleted)"] >= 1, "a deleted document's text is not counted");
    assert.ok(found.tables["document_links (document deleted)"] >= 1);
    assert.ok(found.tables["jobs (document deleted)"] >= 1, "a deleted document's index job is not counted");
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
    assert.strictEqual(await db.one(`SELECT 1 AS x FROM document_chunks WHERE id = $1`, [goneChunk.id]), null,
      "a deleted document's text outlived the purge");
    assert.strictEqual(await db.one(`SELECT 1 AS x FROM document_links WHERE document_id = $1`, [goneDoc]), null);
    assert.strictEqual(await db.one(`SELECT 1 AS x FROM jobs WHERE id = $1`, [goneJob.id]), null,
      "a deleted document's text outlived the purge in its index job");
  });

  await atest("and nothing that still belongs to someone was touched", async () => {
    assert.ok(await db.one(`SELECT 1 AS x FROM jobs WHERE id = $1`, [liveJob.id]),
      "the index job of a document B still has was removed");
    await db.run(`DELETE FROM jobs WHERE id = $1`, [liveJob.id]);
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

  await atest("when the recordings list cannot be read, Remove leftovers leaves every recording alone", async () => {
    // B's recording, aged past the point where an unlisted file counts as
    // a stray, and a real stray beside it.
    const aDayAgo = new Date(Date.now() - 86_400_000);
    for (const ext of [".m4a", ".user.pcm", ".agent.pcm"]) fs.utimesSync(recStem(B) + ext, aDayAgo, aDayAgo);
    const realStray = touch(path.join(RECS, "2026-09-03", "stray-real.m4a"));
    fs.utimesSync(realStray, aDayAgo, aDayAgo);

    // This privacy module's database fails that one query, as a dropped
    // connection or a Postgres restart would.
    let failed = 0;
    const flaky = privacyWithDb((real) => ({
      ...real,
      query: (sql, params) => {
        if (/^SELECT file FROM live_recordings$/.test(String(sql).trim())) {
          failed++;
          return Promise.reject(new Error("Connection terminated unexpectedly"));
        }
        return real.query(sql, params);
      },
    }));
    const seen = await flaky.findOrphans();
    const done = await flaky.purgeOrphans();
    assert.strictEqual(failed, 2, "the failing query was not reached");
    assert.strictEqual(seen.files.strayRecordingFiles, 0, "the panel would have offered B's audio");
    assert.strictEqual(done.files.strayRecordingFiles, 0);
    for (const ext of [".m4a", ".user.pcm", ".agent.pcm"]) {
      assert.ok(exists(recStem(B) + ext), `B's ${ext} was deleted as a stray`);
    }
    assert.ok(exists(realStray), "with no list, nothing is a stray — not even a real one");

    // Once the list reads again: the real stray goes, B's (listed) stays.
    const ok = await privacy.purgeOrphans();
    assert.strictEqual(ok.files.strayRecordingFiles, 1);
    assert.ok(!exists(realStray));
    for (const ext of [".m4a", ".user.pcm", ".agent.pcm"]) assert.ok(exists(recStem(B) + ext));
  });

  /* ================================================================ *
   * (d) A CALL IN PROGRESS
   * ================================================================ */
  console.log("\na call in progress when the account is deleted");

  // The real bridge, with Google's socket and the phone's faked in memory
  // (the harness scripts/automation-test.js uses). A closed fake delivers
  // nothing further, as a closed socket does.
  const EventEmitter = require("events");
  const realWs = require("ws");
  class FakeWs extends EventEmitter {
    constructor(url) {
      super(); this.readyState = 1; this.sent = []; this.closedWith = null;
      if (url) FakeWs.upstream = this;
    }
    send(x) { this.sent.push(Buffer.isBuffer(x) ? x : String(x)); }
    close(code) {
      if (this.readyState === 3) return;
      this.readyState = 3; this.closedWith = code || 1005; this.emit("close", this.closedWith);
    }
    terminate() { this.close(); }
    ping() {}
  }
  Object.assign(FakeWs, { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3, Server: realWs.Server });
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-key";
  const wsModule = require.cache[require.resolve("ws")];
  const wsExports = wsModule.exports;
  const proxyPath = require.resolve("../src/live/proxy");
  let proxy;
  try {
    wsModule.exports = FakeWs;
    delete require.cache[proxyPath]; // privacy.js requires this same instance
    proxy = require("../src/live/proxy");
  } finally {
    wsModule.exports = wsExports;
  }
  const until = async (fn, what) => {
    for (let i = 0; i < 300; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 10)); }
    throw new Error(`timed out: ${what}`);
  };
  const device = { build: 106, platform: "android", tz: 330 };
  const today = path.join(RECS, new Date().toISOString().slice(0, 10));
  const liveFiles = () => (fs.existsSync(today) ? fs.readdirSync(today) : []).filter((f) => f.startsWith("live_"));
  const D = (await db.createUser({ email: `erase-d-${stamp}@example.test`, name: "Erase d" })).id;
  await optIn(D);
  const turnsOfD = async () =>
    (await db.one(`SELECT count(*)::int AS n FROM conversation_turns WHERE user_id = $1`, [D])).n;
  const recsOfD = async () =>
    (await db.one(`SELECT count(*)::int AS n FROM live_recordings WHERE user_id = $1`, [D])).n;

  await atest("the delete ends the call: both sockets close, and nothing is written after", async () => {
    const before = new Set(liveFiles());
    const phone = new FakeWs();
    proxy.bridge(phone, { sub: String(D) }, null, device);
    const up = FakeWs.upstream;
    up.emit("open");
    await until(() => up.sent.some((x) => /"setup"/.test(x)), "setup");
    up.emit("message", Buffer.from(JSON.stringify({ setupComplete: {} })));
    await until(() => phone.sent.some((x) => /"ready"/.test(String(x))), "ready");
    const fromGoogle = (o) => { if (up.readyState === 1) up.emit("message", Buffer.from(JSON.stringify(o))); };
    const speak = (text) => {
      fromGoogle({ serverContent: { inputTranscription: { text } } });
      fromGoogle({ serverContent: { turnComplete: true } });
    };
    // Proof the harness is live: a turn is written, the call is recorded.
    speak("what is the weather tomorrow");
    await until(async () => (await turnsOfD()) === 1, "the call writes its turns");
    await until(async () => (await recsOfD()) === 1, "the call is recorded");

    const res = await admin(`/users/${D}`, { method: "DELETE" });
    assert.strictEqual(res.status, 200);
    const report = await res.json();
    assert.strictEqual(report.revoked.liveSessions, 1);
    assert.strictEqual(report.revoked.liveRecordings, 1);
    assert.strictEqual(phone.readyState, 3, "the phone is still connected to a deleted account");
    assert.strictEqual(phone.closedWith, 1008);
    assert.strictEqual(up.readyState, 3, "the Gemini session is still open");

    speak("and book me a cab home");
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(await turnsOfD(), 0, "a turn was written under the erased id");
    assert.strictEqual(await recsOfD(), 0);
    const left = liveFiles().filter((f) => !before.has(f));
    assert.deepStrictEqual(left, [], "the call's audio is still on disk");
  });

  await atest("a call that reaches the bridge just after the delete is closed on arrival", async () => {
    const before = new Set(liveFiles());
    const late = new FakeWs();
    proxy.bridge(late, { sub: String(D) }, null, device); // authorised a moment before the delete
    assert.strictEqual(late.readyState, 3);
    assert.strictEqual(late.closedWith, 1008);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(await recsOfD(), 0, "it recorded a call for a deleted account");
    assert.deepStrictEqual(liveFiles().filter((f) => !before.has(f)), []);
  });

  await atest("a recording still starting when the delete runs removes itself", async () => {
    // Its INSERT is held back (a lock on the table) until the delete has
    // looked for open recordings, so the delete cannot see it: the
    // recording has to notice by itself.
    const E = (await db.createUser({ email: `erase-e-${stamp}@example.test`, name: "Erase e" })).id;
    await optIn(E);
    const session = `race-${E}-${stamp}`;
    let release;
    let locked = false;
    const held = new Promise((r) => { release = r; });
    const locker = db.tx(async (c) => {
      await c.query(`LOCK TABLE live_recordings IN EXCLUSIVE MODE`);
      locked = true;
      await held;
    });
    const waiting = (pattern) => db.one(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE $1`,
      [pattern]).then((r) => r.n > 0);
    const day = path.join(RECS, new Date().toISOString().slice(0, 10));
    const raw = [".user.pcm", ".agent.pcm"].map((ext) => path.join(day, session + ext));
    let handle = null;
    try {
      await until(() => locked, "lock");
      handle = recorder.begin(E, session);
      await until(() => waiting("%INSERT INTO live_recordings%"), "the recording's INSERT waits");
      assert.ok(raw.every(exists), "the raw halves are open while it starts");
      const deleting = privacy.deleteUserEverywhere(E, { reason: "race test" });
      // The delete has passed abortUser once its own transaction queues
      // behind the same lock.
      await until(() => waiting("DELETE FROM live_recordings%"), "the delete's transaction waits");
      release();
      await locker;
      const report = await deleting;
      assert.strictEqual(report.revoked.liveRecordings, 0, "the delete saw it: this is not the race");
      // Not stopped from here: a real call would keep sending audio. The
      // recording has to give up on its own, row and raw halves together.
      await until(() => raw.every((p) => !exists(p)), "still recording a deleted account's call");
      assert.strictEqual(
        (await db.one(`SELECT count(*)::int AS n FROM live_recordings WHERE session_id = $1`, [session])).n, 0);
      assert.ok(!exists(path.join(day, session + ".m4a")));
    } finally {
      release();
      await locker.catch(() => {});
      if (handle) await handle.stop();
    }
  });

  // Tidy up after ourselves.
  server.close();
  await privacy.deleteUserEverywhere(D, { reason: "test cleanup" }).catch(() => {});
  await privacy.deleteUserEverywhere(B, { reason: "test cleanup" }).catch(() => {});
  await db.run(`DELETE FROM chat_group_messages WHERE group_id = ANY($1::bigint[])`, [[G1, G4]]);
  await db.run(`DELETE FROM chat_groups WHERE id = ANY($1::bigint[])`, [[G1, G4]]);
  await db.run(`DELETE FROM chat_group_members WHERE group_id = ANY($1::bigint[])`, [[G1, G4]]);
  await db.run(`DELETE FROM developer_feedback WHERE id = $1`, [alert.id]);
  await db.run(`DELETE FROM agent_messages WHERE id = $1`, [toStranger]);
  await db.run(`DELETE FROM kv WHERE k = $1`, [lookalike]);
  await db.run(`DELETE FROM jobs WHERE id = $1`, [systemJob.id]);
  for (const t of legacyMade) await db.run(`DROP TABLE IF EXISTS "${t}"`);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
