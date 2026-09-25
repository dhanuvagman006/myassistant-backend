/**
 * PRIVACY DASHBOARD (F2) — the two rights every user has:
 *   GET    /privacy/export   → one JSON file with EVERYTHING we hold on them
 *   DELETE /privacy/account  → permanent, irreversible erasure
 *
 * ONE ERASER FOR BOTH DOORS (2026-09-25).
 *
 * Owner: "delete old user accounts and data's from the database", and
 * then "i ran but db files have not yet deleted" — after the admin
 * panel's Delete user, the Recordings page still listed those people's
 * calls. The panel had its own copy of the delete: rows only, no files, no
 * Google revoke. Neither copy knew about live_recordings, or about the
 * dozen tables added since the list below was last touched, and the call
 * audio is stored by day rather than by user, so nothing ever found it.
 *
 * Now the app's DELETE /privacy/account and the panel's
 * DELETE /admin-panel/api/users/:id both call deleteUserEverywhere(), and
 * findOrphans()/purgeOrphans() (the panel's "Leftovers") clear what the
 * earlier deletes left behind.
 *
 * Design notes:
 *   • Every row goes in ONE Postgres transaction (atomic even if the
 *     process dies). Files go after commit, idempotently, and nothing
 *     after commit may throw: the account is already gone by then.
 *   • Revocation that needs a stored token (Google) runs BEFORE the
 *     transaction, because the token is gone once its row is.
 *   • Tables are looked up via information_schema, so an entry for a table
 *     a deployment does not have is a no-op. That is what lets the legacy
 *     tables below be listed safely.
 *   • Files are found only through values in the database, and a path is
 *     used only when it resolves inside its known root. A bad row can never
 *     aim an unlink at anything else.
 *   • A live call they are on when the delete starts is cut off first
 *     (live/proxy.js closeUser), so it cannot write turns, tool logs or
 *     audio under the erased id once the rows are gone.
 *
 * Not revoked (known limits, review 2026-09-25). Some legacy rows below
 * point at things kept by an outside service. The rows go; the things
 * they point at stay where they are, because the code that made them was
 * removed long ago and this routine does not call those services:
 *   • a per-user Bolna agent      calling_agent_prefs.bolna_agent_id
 *   • an ElevenLabs voice clone    voice_profiles.voice_id
 *   • a Tavus persona              avatar_personas.persona_id
 *   • a D-ID agent                 did_agents.agent_id
 * To remove those by hand in each provider's dashboard, note the ids
 * BEFORE deleting the account or pressing Remove leftovers: after that
 * nothing here remembers them.
 */
const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { query, one, tx, findById } = require("../db");
const gtokens = require("../google/tokens");
const recorder = require("../live/recorder");
const firebase = require("../services/firebase");

const router = express.Router();

// Resolved, so the "is this path inside the root" test below compares two
// absolute paths even when DATA_DIR is given relative.
const filesRoot = path.resolve(
  process.env.DATA_DIR || path.join(__dirname, "..", "..", "data"),
  "files"
);

/** tables that key rows by a user column → [table, column] */
// EVERY user-keyed table in the schema. This list drives BOTH the privacy
// export and account deletion (including the admin panel's Delete user), so
// a table missing here means orphaned rows surviving a "complete" delete —
// which is exactly what happened as the schema grew past the original
// eight entries, and again by 2026-09-25. existingUserTables() filters
// against information_schema at runtime, so entries for tables a
// deployment doesn't have are no-ops. When adding a table to the schema,
// add it here in the same change: `npm run test:erase` fails otherwise.
const USER_TABLES = [
  ["actions_log", "user_id"],
  ["reminders", "user_id"],
  ["documents", "user_id"], // the files themselves go after commit
  ["document_chunks", "user_id"], // per-document search index
  ["document_links", "user_id"],
  ["google_tokens", "user_id"], // revoked at Google first
  ["swiggy_tokens", "user_id"],
  ["agent_memories", "user_id"], // everything the assistant remembers
  ["bookings", "user_id"], // the booking agent's ledger
  ["clients", "user_id"], // professional mode: patient/client cards
  ["client_notes", "user_id"], // …and their dated case notes
  ["commitments", "user_id"], // promises the assistant tracks
  ["contacts", "user_id"], // mirrored address book
  ["finance_items", "user_id"],
  ["meetings", "user_id"],
  ["payment_requests", "user_id"],
  ["fulfillment_tasks", "user_id"],
  ["fare_watches", "user_id"],
  ["conversations", "user_id"],
  ["messages", "user_id"], // conversation turns
  ["events", "user_id"],
  ["cases", "user_id"],
  ["case_people", "user_id"],
  ["person_dates", "user_id"], // birthdays/anniversaries per person
  ["jobs", "user_id"], // queued and recurring scheduled tasks
  // Messages they sent to other people's agents. A hard delete, so these
  // leave the recipients' inboxes too; messages sent TO them are removed
  // by phone number in deleteUserEverywhere().
  ["agent_messages", "from_user_id"],
  ["mcp_servers", "user_id"], // live connections are closed first
  ["assistant_profiles", "user_id"], // assistant name/voice/face choices
  ["user_instructions", "user_id"], // standing rules
  ["developer_feedback", "user_id"], // what the assistant reported for them
  ["automation_runs", "user_id"], // tasks done for them inside other apps
  ["inbound_calls", "user_id"],
  ["inbound_numbers", "user_id"],
  ["inbound_settings", "user_id"],
  ["app_usage_daily", "user_id"],
  ["avatar_profiles", "user_id"], // future: consented face/voice identity
  ["avatar_renders", "user_id"],

  // Added 2026-09-25. All of these were in the schema and missing here,
  // so they outlived every delete (owner: "i ran but db files have not
  // yet deleted").
  ["live_recordings", "user_id"], // call recordings; the audio goes after commit
  ["conversation_turns", "user_id"], // every question and answer (admin Conversations)
  ["task_outcomes", "user_id"], // agent-call results and transcripts
  ["call_records", "user_id"], // phone-call transcripts and summaries
  ["email_accounts", "user_id"], // their encrypted mail login
  ["email_sent", "user_id"], // mail they sent, bodies included
  ["executed_actions", "user_id"], // per-turn tool log with arguments
  ["agent_tasks", "user_id"],
  ["records", "user_id"],
  ["client_recalls", "user_id"], // professional mode, beside clients
  ["client_ledger", "user_id"],
  ["pending_pushes", "user_id"], // notifications still waiting for a device
  ["user_devices", "user_id"], // phone model, OS, permissions
  ["studio_photos", "user_id"], // the bytes are documents; these point at them
  ["studio_looks", "user_id"],
  // The biometric consent record goes too: with the photos gone there is
  // nothing left that it covers.
  ["studio_consent", "user_id"],
  ["chat_group_members", "user_id"], // what they SAID in groups: see SHARED_TABLES
  ["chat_prefs", "user_id"], // their own mute / clear-chat settings
  ["chat_hidden_messages", "user_id"],

  // Legacy tables, taken out of init() on 2026-08-10 but never DROPped, so
  // a database created before that date may still hold them.
  ["memories", "user_id"],
  ["agent_calls", "user_id"], // TEXT id — compared as text, which is fine
  ["agent_call_settings", "user_id"],
  ["subscriptions", "user_id"],
  ["usage", "user_id"],
  ["families", "owner_id"],
  ["family_members", "user_id"],
  ["payments", "user_id"],
  // More legacy tables (review, 2026-09-25): made by code that shipped and
  // was later removed, and never DROPped either. Missing here, they
  // outlived every delete and every Leftovers run on a database that has
  // them. The outside things four of them point at are NOT removed: see
  // "Not revoked" at the top of this file.
  ["calling_agent_prefs", "user_id"], // 2026-09-20 to 09-21: their own Bolna agent's id
  ["voice_profiles", "user_id"], // 2026-08-08 to 08-10, TEXT id: ElevenLabs voice clone id
  ["assistant_settings", "user_id"], // 2026-08-08 to 08-10, TEXT id
  ["avatar_personas", "user_id"], // 2026-08-14 to 08-26: Tavus persona id and its bearer key
  ["avatar_sessions", "user_id"],
  ["conversation_state", "user_id"], // a rolling summary of their conversation
  ["did_agents", "user_id"], // 2026-08-05 to 08-11: D-ID agent id
  ["did_briefings", "user_id"], // briefing scripts and D-ID video links
];

/**
 * Tables where the user is one party among several. Deleting their rows
 * outright would cut holes in other people's history, so each has its own
 * rule, run in the same transaction as USER_TABLES:
 */
const SHARED_TABLES = {
  // What they said in a group stays as "This message was deleted", the
  // codebase's own delete-for-everyone tombstone (memory/schema.js), so the
  // other members' threads still read in order. The words themselves go.
  chat_group_messages: "from_user_id",
  // A group belongs to its members, not to whoever pressed New group. It
  // stays for the others, and goes (messages and all) once nobody is left,
  // the same as when the last member leaves (routes/chatGroups.js).
  chat_groups: "created_by",
};

/**
 * Tables with a user column that hold nothing personal. None today. An
 * entry needs a reason, because the erase suite's schema guard accepts a
 * user-keyed table only when it is in USER_TABLES, SHARED_TABLES or here.
 */
const NOT_PERSONAL = {};

/** The column names the schema guard treats as "this row is a user's". */
const USER_COLUMNS = ["user_id", "from_user_id", "owner_id", "created_by"];

/**
 * kv has no user column, so no table list can find these keys: the
 * call-analysis consent record and the scheduler's "already told them"
 * markers.
 */
const KV_EXACT = ["call_analysis"]; // call_analysis:<uid>
const KV_PREFIX = ["brief", "morning", "pdate"]; // <name>:<uid>:…

/**
 * Quotes a table or column name. Every name here comes from the lists above,
 * never from a request; quoting only keeps a legacy name like "usage", which
 * is also an SQL keyword, from being read as one.
 */
const q = (name) => `"${String(name).replace(/"/g, "")}"`;

async function columnSet() {
  const rows = await query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'`
  );
  return new Set(rows.map((r) => r.table_name + "." + r.column_name));
}

async function existingUserTables(cols) {
  const have = cols || (await columnSet());
  return USER_TABLES.filter(([t, c]) => have.has(t + "." + c));
}

// Never export secrets — the user owns their data, not our credentials.
const REDACT = new Set([
  "password_hash", "refresh_token", "access_token", "token", "id_token",
  "secrets_enc",
  // avatar_personas.api_key: the bearer key a Tavus persona presented to
  // this server (legacy, above).
  "api_key",
]);
function redactRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = REDACT.has(k) ? (v ? "[stored — redacted]" : null) : v;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Files: only ever under a known root
 * ------------------------------------------------------------------ */

/**
 * The absolute path `p` if it lies strictly inside `root`, else null.
 * Both sides are resolved the way the writer resolved them (against the
 * working directory), so "../" in a stored path cannot climb out, and a
 * path equal to the root itself is refused.
 */
function inside(root, p) {
  if (!root || !p) return null;
  const base = path.resolve(String(root));
  const full = path.resolve(String(p));
  return full.startsWith(base + path.sep) ? full : null;
}

/** Unlinks a recording's .m4a and both raw halves. Returns files removed. */
async function unlinkRecording(file) {
  const f = inside(recorder.ROOT, file);
  if (!f) return 0;
  const all = /\.m4a$/.test(f)
    ? [f, f.replace(/\.m4a$/, ".user.pcm"), f.replace(/\.m4a$/, ".agent.pcm")]
    : [f];
  let n = 0;
  for (const p of all) {
    try { await fsp.unlink(p); n++; } catch (_) { /* already gone */ }
  }
  return n;
}

function countFiles(dir) {
  let n = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const e of entries) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

/** Removes files/<uid>. Returns how many files were in it. */
function removeUserDir(uid) {
  const dir = inside(filesRoot, path.join(filesRoot, String(uid)));
  if (!dir || !/^[1-9][0-9]*$/.test(String(uid))) return 0;
  const n = countFiles(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return n;
}

/* ------------------------------------------------------------------ *
 * Revocation outside the database
 * ------------------------------------------------------------------ */

async function revokeGoogle(uid) {
  try {
    if (!(await gtokens.isConnected(uid))) return "not linked";
    await gtokens.disconnect(uid);
    return "revoked";
  } catch (e) {
    console.warn("google revoke during account delete:", e.message);
    return "failed";
  }
}

/** Closes their MCP connections so no client or tool outlives the rows. */
async function closeMcp(uid, cols) {
  if (!cols.has("mcp_servers.user_id")) return 0;
  const rows = await query(`SELECT id FROM mcp_servers WHERE user_id = $1`, [uid])
    .catch(() => []);
  if (!rows.length) return 0;
  let n = 0;
  try {
    const manager = require("../mcp/manager");
    for (const r of rows) {
      await manager.disconnect(uid, r.id).then(() => n++, () => {});
    }
  } catch (e) {
    console.warn("mcp disconnect during account delete:", e.message);
  }
  return n;
}

/** Cuts off their live calls on this pod. Returns how many were open. */
async function closeLiveSessions(uid) {
  try {
    // Required here, not at the top: the live proxy is a large module
    // that nothing else in this file needs.
    return require("../live/proxy").closeUser(uid);
  } catch (e) {
    console.warn("live close during account delete:", e.message);
    return 0;
  }
}

/**
 * The transaction failed, so the account still exists: lift the marks
 * abortUser/closeUser left, or this pod would refuse the user's calls and
 * recordings until it restarts. A call already cut off stays cut off.
 */
function cancelLiveErase(uid) {
  try { recorder.cancelErase(uid); } catch (_) {}
  try { require("../live/proxy").cancelErase(uid); } catch (_) {}
}

/* ------------------------------------------------------------------ *
 * deleteUserEverywhere — the one routine both delete buttons call
 * ------------------------------------------------------------------ */

/**
 * Erases one account: every row, every file, every grant we can revoke.
 * Safe to run twice, and safe for an id whose users row is already gone
 * (it then clears whatever an older, partial delete left behind).
 *
 * @returns a report: rows removed per table, files removed, what was revoked.
 */
async function deleteUserEverywhere(userId, { reason = "" } = {}) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) throw new Error("bad user id");

  const user = await one(`SELECT id, phone_number FROM users WHERE id = $1`, [uid]);
  const phone = user?.phone_number || null;
  const cols = await columnSet();
  const tables = await existingUserTables(cols);
  const report = {
    ok: true,
    userId: uid,
    existed: Boolean(user),
    revoked: {},
    rows: {},
    totalRows: 0,
    files: { recordings: 0, documents: 0 },
    totalFiles: 0,
  };
  const count = (name, n) => {
    if (n > 0) report.rows[name] = (report.rows[name] || 0) + n;
  };

  // 1) BEFORE the transaction: what needs the rows to still exist.
  report.revoked.google = await revokeGoogle(uid);
  report.revoked.mcpConnections = await closeMcp(uid, cols);
  // A call still open on this pod would write audio after its row is gone.
  report.revoked.liveRecordings = await recorder.abortUser(uid).catch(() => 0);
  // ...and the call itself would carry on (review, 2026-09-25): the live
  // socket checks the account once, when it opens, so a user deleted
  // mid-call kept talking to the assistant, and every turn after this
  // point wrote conversation_turns, executed_actions and the like under
  // the erased id — the admin Conversations page showed them again.
  // After abortUser on purpose: closing the call stops its recording, and
  // a stop that got there first would merge the audio into a new file.
  // Known limit: a tool already running when the call is cut can still
  // finish and write its one row; the Leftovers card finds that.
  report.revoked.liveSessions = await closeLiveSessions(uid);

  // 2) Every row, one transaction.
  let recordingFiles = [];
  await tx(async (client) => {
    const groups = cols.has("chat_group_members.user_id")
      ? (await client.query(
          `SELECT group_id FROM chat_group_members WHERE user_id = $1`, [uid]
        )).rows.map((r) => r.group_id)
      : [];

    for (const [table, col] of tables) {
      // table/col come from OUR whitelist above (never user input) and were
      // verified against information_schema — safe to interpolate.
      if (table === "live_recordings") {
        // RETURNING, so the audio unlinked after commit is exactly the
        // audio of the rows this transaction removed.
        const r = await client.query(
          `DELETE FROM live_recordings WHERE user_id = $1 RETURNING file`, [uid]);
        recordingFiles = r.rows.map((x) => x.file);
        count(table, r.rowCount);
        continue;
      }
      const r = await client.query(`DELETE FROM ${q(table)} WHERE ${q(col)} = $1`, [String(uid)]);
      count(table, r.rowCount);
    }

    if (cols.has("chat_groups.created_by") && cols.has("chat_group_members.group_id")) {
      const mine = `(g.id = ANY($1::bigint[]) OR g.created_by = $2)
        AND NOT EXISTS (SELECT 1 FROM chat_group_members m WHERE m.group_id = g.id)`;
      const msgs = await client.query(
        `DELETE FROM chat_group_messages WHERE group_id IN
           (SELECT g.id FROM chat_groups g WHERE ${mine})`, [groups, uid]);
      count("chat_group_messages", msgs.rowCount);
      const g = await client.query(`DELETE FROM chat_groups g WHERE ${mine}`, [groups, uid]);
      count("chat_groups (nobody left)", g.rowCount);
    }
    if (cols.has("chat_group_messages.deleted")) {
      const r = await client.query(
        `UPDATE chat_group_messages SET deleted = 1, body = ''
          WHERE from_user_id = $1 AND (deleted = 0 OR body <> '')`, [uid]);
      count("chat_group_messages (blanked)", r.rowCount);
    }

    // Messages other people's agents sent TO them are addressed by number,
    // not by id. Left in place, whoever next verifies this number would
    // open an inbox full of them. The senders lose these from their own
    // history, exactly as recipients lose what a deleted account sent.
    if (phone && cols.has("agent_messages.to_phone_number")) {
      const r = await client.query(
        `DELETE FROM agent_messages WHERE to_phone_number = $1
           AND NOT EXISTS (SELECT 1 FROM users WHERE phone_number = $1 AND id <> $2)`,
        [phone, uid]);
      count("agent_messages (sent to them)", r.rowCount);
    }

    if (cols.has("kv.k")) {
      // The trailing colon keeps user 1 from matching user 12's keys.
      const r = await client.query(
        `DELETE FROM kv WHERE k = ANY($1::text[]) OR k LIKE ANY($2::text[])`,
        [KV_EXACT.map((p) => `${p}:${uid}`), KV_PREFIX.map((p) => `${p}:${uid}:%`)]);
      count("kv (their keys)", r.rowCount);
    }

    const u = await client.query(`DELETE FROM users WHERE id = $1`, [uid]);
    count("users", u.rowCount);
  }).catch((e) => {
    cancelLiveErase(uid);
    throw e;
  });

  // 3) After commit. The account is gone; from here nothing may throw.
  for (const f of recordingFiles) {
    report.files.recordings += await unlinkRecording(f).catch(() => 0);
  }
  if (recordingFiles.length) await recorder.sweepEmptyDays().catch(() => {});
  try {
    report.files.documents = removeUserDir(uid);
  } catch (e) {
    console.warn("file cleanup during account delete:", e.message);
  }
  // After commit rather than before: it needs nothing from our rows, and a
  // failed transaction must not leave a live account whose number Firebase
  // has already forgotten.
  try {
    report.revoked.firebase = phone ? await firebase.deletePhoneUser(phone) : "no phone";
  } catch (e) {
    report.revoked.firebase = "failed";
  }

  report.totalRows = Object.values(report.rows).reduce((a, b) => a + b, 0);
  report.totalFiles = report.files.recordings + report.files.documents;
  // Ids and counts only — never names, numbers or content.
  console.log(
    `account erased: #${uid}${reason ? ` (${reason})` : ""} — ` +
    `${report.totalRows} rows, ${report.totalFiles} files`);
  return report;
}

/* ------------------------------------------------------------------ *
 * Leftovers: what the earlier deletes left behind
 * ------------------------------------------------------------------ */

// A row is an orphan when its user column holds a real user id (a positive
// whole number: 0 is the server's own, NULL is nobody's) and no users row
// has that id. Compared as text, so the legacy TEXT columns work too and a
// non-numeric legacy value is never mistaken for a deleted user.
const orphanWhere = (col) =>
  `x.${q(col)}::text ~ '^[1-9][0-9]*$'
   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = x.${q(col)}::text)`;

const KV_ORPHAN = `(x.k ~ '^(${KV_EXACT.join("|")}):[1-9][0-9]*$'
    OR x.k ~ '^(${KV_PREFIX.join("|")}):[1-9][0-9]*:')
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = split_part(x.k, ':', 2))`;

// A group nobody who still exists belongs to. Group creation inserts the
// group before its members, so a group younger than an hour is left alone.
const EMPTY_GROUP = `g.created_at < $1
  AND NOT EXISTS (SELECT 1 FROM chat_group_members m JOIN users u ON u.id = m.user_id
                   WHERE m.group_id = g.id)`;
const GROUP_GRACE_MS = 3600_000;

/** Recording files on disk that no row points at, old enough to be dead. */
async function strayRecordingFiles() {
  const root = recorder.ROOT;
  let days = [];
  try { days = await fsp.readdir(root); } catch (_) { return []; }
  // FAILS CLOSED (review, 2026-09-25). This list is what keeps a file.
  // It used to fall back to an empty list when the query failed (a
  // dropped connection, a restart, a timeout), which made every call
  // recording of every existing user a "stray", and Remove leftovers
  // would have unlinked up to KEEP_DAYS of them. A check that cannot be
  // made now finds no strays; the next run will.
  let rows;
  try {
    rows = await query(`SELECT file FROM live_recordings`);
  } catch (e) {
    console.warn("leftovers: recordings list unavailable, stray audio left alone:", e.message);
    return [];
  }
  const known = new Set(rows.map((r) => inside(root, r.file)).filter(Boolean));
  // The same test reclaimOrphans() uses: no live call can own a file this old.
  const staleBefore = Date.now() - (recorder.MAX_MINUTES + 10) * 60_000;
  const out = [];
  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const dir = path.join(root, day);
    let files = [];
    try { files = await fsp.readdir(dir); } catch (_) { continue; }
    for (const f of files) {
      const m = f.match(/^(.+)\.(m4a|user\.pcm|agent\.pcm)$/);
      if (!m) continue;
      if (known.has(path.resolve(dir, m[1] + ".m4a"))) continue;
      const full = path.join(dir, f);
      const st = await fsp.stat(full).catch(() => null);
      if (st && st.isFile() && st.mtimeMs < staleBefore) out.push(full);
    }
  }
  return out;
}

/** files/<uid> folders whose user no longer exists. */
async function orphanDocumentDirs() {
  let entries = [];
  try { entries = await fsp.readdir(filesRoot, { withFileTypes: true }); } catch (_) { return []; }
  const ids = entries
    .filter((e) => e.isDirectory() && /^[1-9][0-9]{0,9}$/.test(e.name))
    .map((e) => e.name);
  if (!ids.length) return [];
  const alive = new Set(
    (await query(`SELECT id::text AS id FROM users WHERE id::text = ANY($1::text[])`, [ids]))
      .map((r) => r.id)
  );
  return ids
    .filter((id) => !alive.has(id))
    .map((id) => ({ id, dir: path.join(filesRoot, id), files: countFiles(path.join(filesRoot, id)) }));
}

/** How many existing recording files the given .m4a paths account for. */
async function filesOnDisk(list) {
  let n = 0;
  for (const file of list) {
    const f = inside(recorder.ROOT, file);
    if (!f) continue;
    const all = /\.m4a$/.test(f)
      ? [f, f.replace(/\.m4a$/, ".user.pcm"), f.replace(/\.m4a$/, ".agent.pcm")]
      : [f];
    for (const p of all) if (await fsp.stat(p).then(() => true, () => false)) n++;
  }
  return n;
}

/**
 * Counts everything purgeOrphans() would remove. Read-only.
 * @returns { tables: {name: rows}, files: {...}, totalRows, totalFiles }
 */
async function findOrphans() {
  const cols = await columnSet();
  const tables = {};
  const put = (name, n) => { if (Number(n) > 0) tables[name] = Number(n); };

  for (const [table, col] of await existingUserTables(cols)) {
    const r = await one(`SELECT count(*)::int AS n FROM ${q(table)} x WHERE ${orphanWhere(col)}`);
    put(table, r?.n);
  }
  // Same labels and the same order of rules as purgeOrphans(), so the
  // numbers the panel shows before are the numbers it reports after:
  // messages in a group with nobody left are deleted with the group, and
  // only the rest are blanked.
  const cutoff = Date.now() - GROUP_GRACE_MS;
  const emptyGroups = `(SELECT g.id FROM chat_groups g WHERE ${EMPTY_GROUP})`;
  if (cols.has("chat_groups.created_at") && cols.has("chat_group_messages.group_id")) {
    const m = await one(
      `SELECT count(*)::int AS n FROM chat_group_messages WHERE group_id IN ${emptyGroups}`,
      [cutoff]);
    put("chat_group_messages", m?.n);
    const g = await one(`SELECT count(*)::int AS n FROM chat_groups g WHERE ${EMPTY_GROUP}`,
      [cutoff]);
    put("chat_groups (nobody left)", g?.n);
  }
  if (cols.has("chat_group_messages.deleted")) {
    const inEmpty = cols.has("chat_groups.created_at")
      ? `AND x.group_id NOT IN ${emptyGroups}` : "";
    const r = await one(
      `SELECT count(*)::int AS n FROM chat_group_messages x
        WHERE ${orphanWhere("from_user_id")} AND (x.deleted = 0 OR x.body <> '') ${inEmpty}`,
      inEmpty ? [cutoff] : []);
    put("chat_group_messages (blanked)", r?.n);
  }
  if (cols.has("kv.k")) {
    const r = await one(`SELECT count(*)::int AS n FROM kv x WHERE ${KV_ORPHAN}`);
    put("kv (their keys)", r?.n);
  }

  const recRows = cols.has("live_recordings.file")
    ? await query(`SELECT file FROM live_recordings x WHERE ${orphanWhere("user_id")}`)
    : [];
  const dirs = await orphanDocumentDirs();
  const files = {
    recordingFiles: await filesOnDisk(recRows.map((r) => r.file)),
    strayRecordingFiles: (await strayRecordingFiles()).length,
    documentFolders: dirs.length,
    documentFiles: dirs.reduce((a, d) => a + d.files, 0),
  };
  return {
    tables,
    files,
    totalRows: Object.values(tables).reduce((a, b) => a + b, 0),
    totalFiles: files.recordingFiles + files.strayRecordingFiles + files.documentFiles,
  };
}

/**
 * Removes exactly what findOrphans() counts: rows whose user no longer
 * exists (in one transaction), then the audio of those recordings, stray
 * recording files, and the document folders of deleted users.
 */
async function purgeOrphans() {
  const cols = await columnSet();
  const tables = {};
  const put = (name, n) => { if (Number(n) > 0) tables[name] = (tables[name] || 0) + Number(n); };
  let recordingFiles = [];

  await tx(async (client) => {
    for (const [table, col] of await existingUserTables(cols)) {
      if (table === "live_recordings") {
        const r = await client.query(
          `DELETE FROM live_recordings x WHERE ${orphanWhere("user_id")} RETURNING file`);
        recordingFiles = r.rows.map((row) => row.file);
        put(table, r.rowCount);
        continue;
      }
      const r = await client.query(`DELETE FROM ${q(table)} x WHERE ${orphanWhere(col)}`);
      put(table, r.rowCount);
    }
    if (cols.has("chat_groups.created_at") && cols.has("chat_group_messages.group_id")) {
      const cutoff = Date.now() - GROUP_GRACE_MS;
      const msgs = await client.query(
        `DELETE FROM chat_group_messages WHERE group_id IN
           (SELECT g.id FROM chat_groups g WHERE ${EMPTY_GROUP})`, [cutoff]);
      put("chat_group_messages", msgs.rowCount);
      const g = await client.query(`DELETE FROM chat_groups g WHERE ${EMPTY_GROUP}`, [cutoff]);
      put("chat_groups (nobody left)", g.rowCount);
    }
    if (cols.has("chat_group_messages.deleted")) {
      const r = await client.query(
        `UPDATE chat_group_messages x SET deleted = 1, body = ''
          WHERE ${orphanWhere("from_user_id")} AND (x.deleted = 0 OR x.body <> '')`);
      put("chat_group_messages (blanked)", r.rowCount);
    }
    if (cols.has("kv.k")) {
      const r = await client.query(`DELETE FROM kv x WHERE ${KV_ORPHAN}`);
      put("kv (their keys)", r.rowCount);
    }
  });

  // After commit: never throws.
  const files = { recordingFiles: 0, strayRecordingFiles: 0, documentFolders: 0, documentFiles: 0 };
  for (const f of recordingFiles) files.recordingFiles += await unlinkRecording(f).catch(() => 0);
  for (const f of await strayRecordingFiles().catch(() => [])) {
    if (inside(recorder.ROOT, f)) {
      await fsp.unlink(f).then(() => files.strayRecordingFiles++, () => {});
    }
  }
  await recorder.sweepEmptyDays().catch(() => {});
  for (const d of await orphanDocumentDirs().catch(() => [])) {
    try {
      if (!inside(filesRoot, d.dir)) continue;
      fs.rmSync(d.dir, { recursive: true, force: true });
      files.documentFolders++;
      files.documentFiles += d.files;
    } catch (e) {
      console.warn("leftover document folder:", e.message);
    }
  }

  const out = {
    ok: true,
    tables,
    files,
    totalRows: Object.values(tables).reduce((a, b) => a + b, 0),
    totalFiles: files.recordingFiles + files.strayRecordingFiles + files.documentFiles,
  };
  console.log(`leftovers purged: ${out.totalRows} rows, ${out.totalFiles} files`);
  return out;
}

// ---------- GET /privacy/export ----------
router.get("/export", async (req, res) => {
  const uid = req.user.sub;
  const user = (await findById(Number(uid))) || null;
  const data = {
    exported_at: new Date().toISOString(),
    format: "myassistant-export-v1",
    account: user ? redactRow({ ...user }) : { id: uid },
    // service link status instead of raw tokens
    connections: {
      google: !!(await gtokens.isConnected?.(uid)),
    },
  };
  for (const [table, col] of await existingUserTables()) {
    if (table === "google_tokens" || table === "swiggy_tokens") continue; // covered above
    try {
      // table/col come from OUR whitelist above (never user input) and were
      // verified against information_schema — safe to interpolate.
      data[table] = (
        await query(`SELECT * FROM ${q(table)} WHERE ${q(col)} = $1`, [String(uid)])
      ).map(redactRow);
    } catch (e) {
      data[table] = { error: "could not read: " + e.message };
    }
  }
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="myassistant-data.json"'
  );
  res.json(data);
});

// ---------- DELETE /privacy/account ----------
router.delete("/account", async (req, res) => {
  try {
    await deleteUserEverywhere(req.user.sub, { reason: "in-app" });
  } catch (e) {
    console.error("account delete failed:", e.message);
    return res.status(500).json({ error: "deletion failed — try again" });
  }
  res.json({ ok: true, deleted: true });
});

module.exports = router;
// The admin panel calls the same routine, so an admin delete removes
// exactly what a self-service delete would — no orphaned data either way.
module.exports.existingUserTables = existingUserTables;
module.exports.deleteUserEverywhere = deleteUserEverywhere;
module.exports.findOrphans = findOrphans;
module.exports.purgeOrphans = purgeOrphans;
module.exports.USER_TABLES = USER_TABLES;
module.exports.SHARED_TABLES = SHARED_TABLES;
module.exports.NOT_PERSONAL = NOT_PERSONAL;
module.exports.USER_COLUMNS = USER_COLUMNS;
module.exports.filesRoot = filesRoot;
