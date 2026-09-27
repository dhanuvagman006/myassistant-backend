/**
 * BILLS BY EMAIL — glue for the routes, the voice tool and server.js.
 */
const fs = require("fs");
const db = require("../db");
const store = require("./store");
const address = require("./address");
const plan = require("./plan");
const { cfg } = require("./config");

const DAY = 864e5;
let receiverUp = false;
let clock = () => Date.now(); // the tests pin it

/** On for this server: switched on AND the listener actually started. */
const available = () => cfg().enabled && receiverUp;

function statusWord(r) {
  if (r.state === "queued" || r.state === "processing") return "processing";
  if (r.kind === "forward_confirm") return "confirm_code";
  if (r.state === "filed") return r.reason === "couldn't read" ? "couldnt_read" : "saved";
  if (r.reason === "already saved") return "already_saved";
  return "not_saved";
}

const plainText = (s) => plan.cleanText(s, 120);

async function toItem(r, remindersById = new Map(), now = Date.now()) {
  const ext = r.extract || {};
  const code = r.kind === "forward_confirm" && ext.confirmCode && now - Number(r.received_at) < DAY
    ? String(ext.confirmCode) : null;
  return {
    id: Number(r.id),
    receivedAt: Number(r.received_at),
    subject: plainText(r.subject),
    from: r.auth === "you" ? "You" : plainText(r.from_domain),
    auth: r.auth,
    verified: r.auth === "you" || r.auth === "verified",
    fromAddress: r.auth === "personal" ? String(r.from_addr || "").slice(0, 200) : null,
    state: r.state,
    status: statusWord(r),
    reason: r.reason || "",
    kind: r.kind || "",
    documentIds: (r.document_ids || []).map(Number),
    reminders: (r.reminder_ids || []).map((id) => remindersById.get(Number(id))).filter(Boolean),
    remindersDone: Boolean(r.reminders_done),
    skipped: (r.skipped_parts || []).map((s) => ({ name: plainText(s.name), why: s.why })),
    confirmCode: code,
  };
}

async function remindersFor(uid, rows) {
  const ids = [...new Set(rows.flatMap((r) => (r.reminder_ids || []).map(Number)))];
  if (!ids.length) return new Map();
  const rs = await db.query(`SELECT id, text, due_at FROM reminders WHERE user_id=$1 AND id = ANY($2::bigint[])`, [uid, ids]);
  return new Map(rs.map((r) => [Number(r.id), { id: Number(r.id), text: r.text, atMs: Number(r.due_at) }]));
}

async function status(uid) {
  const c = cfg();
  const row = await address.getForUser(uid);
  return {
    available: available(),
    address: address.toClient(row),
    trustedFrom: address.trustedOf(row),
    limits: { maxMb: c.maxMb, perDay: c.dailyCap, maxFiles: c.maxFiles },
    today: { received: await store.countSince(uid, Date.now() - DAY) },
  };
}

async function recent(uid, limit = 20) {
  const rows = await store.list(uid, { limit });
  const byId = await remindersFor(uid, rows);
  return Promise.all(rows.map((r) => toItem(r, byId)));
}

/** The user's own tap: set this email's reminders, whoever sent it. */
async function remindAnyway(uid, id) {
  const r = await store.get(uid, id);
  if (!r) return { error: "not found", status: 404 };
  if (r.reminders_done) {
    const byId = await remindersFor(uid, [r]);
    return { reminders: (r.reminder_ids || []).map((x) => byId.get(Number(x))).filter(Boolean) };
  }
  if (r.state !== "filed") return { error: "nothing to remind about", status: 409 };
  const x = r.extract || {};
  const doc = (r.document_ids || []).length
    ? await db.one(`SELECT title FROM documents WHERE user_id=$1 AND id=$2`, [uid, Number(r.document_ids[0])])
    : null;
  const title = doc ? doc.title : "";
  const now = clock();
  if (!plan.planReminders(x, { title, now }).length) return { error: "nothing to remind about", status: 409 };
  const out = await require("./process").remindFrom(uid, r.id, x, title, now);
  return { reminders: out.made };
}

/** "This was me": trust this sending address, then set the reminders. */
async function trustAndRemind(uid, id) {
  const r = await store.get(uid, id);
  if (!r) return { error: "not found", status: 404 };
  if (r.auth !== "personal" || !r.from_addr) return { error: "only for mail from a personal address", status: 409 };
  const list = await address.trust(uid, r.from_addr);
  if (!list) return { error: "not found", status: 404 };
  await store.patch(r.id, { auth: "you" }, uid);
  const ids = (r.document_ids || []).map(Number);
  if (ids.length) {
    await db.run(`UPDATE documents SET source_verified=1 WHERE user_id=$1 AND id = ANY($2::bigint[])`, [uid, ids]);
  }
  const rem = await remindAnyway(uid, id);
  return { trustedFrom: list, reminders: rem.reminders || [] };
}

/**
 * A document from email was deleted: once none of that email's documents
 * remain, its still-pending reminders go too (renewal ones included).
 */
async function onDocumentDeleted(uid, docId) {
  const rows = await db.query(
    `SELECT * FROM mail_inbound WHERE user_id=$1 AND document_ids @> $2::jsonb`,
    [uid, JSON.stringify([Number(docId)])]);
  const reminders = require("../reminders/store");
  for (const r of rows) {
    const left = await db.one(
      `SELECT count(*)::int AS n FROM documents WHERE user_id=$1 AND id = ANY($2::bigint[])`,
      [uid, (r.document_ids || []).map(Number)]);
    if (left.n > 0) continue;
    for (const rid of r.reminder_ids || []) {
      const rem = await db.one(`SELECT done FROM reminders WHERE user_id=$1 AND id=$2`, [uid, Number(rid)]);
      if (rem && !rem.done) await reminders.remove(uid, Number(rid)).catch(() => {});
    }
  }
}

/** Daily: old log rows, 24-hour codes, and any raw file left behind. */
async function sweep(now = Date.now()) {
  await store.blankCodes(now - DAY);
  const gone = await store.prune(now - 180 * DAY);
  for (const g of gone) if (g.raw_path) await fs.promises.rm(g.raw_path, { force: true }).catch(() => {});
  return { pruned: gone.length };
}

async function startReceiver() {
  const c = cfg();
  if (!c.enabled) {
    console.log("  mailin: off (MAILIN_ENABLED/MAILIN_DOMAIN unset)");
    return false;
  }
  const smtp = require("./smtp");
  const { key, cert } = smtp.tlsFiles();
  const r = await smtp.start({ port: c.port, hostname: c.hostname, key, cert });
  require("./worker").start();
  receiverUp = true;
  console.log(`  mailin: SMTP on :${r.port} for ${c.domain} (tls: ${r.tls ? "own" : "off"})`);
  return true;
}

async function stopReceiver() {
  receiverUp = false;
  require("./worker").stop();
  await require("./smtp").stop();
}

/** Tests only: say the receiver is up without binding a port. */
function _setReceiverUp(v) { receiverUp = Boolean(v); }
function _setClock(fn) { clock = fn || (() => Date.now()); }

module.exports = {
  available, status, recent, toItem, remindAnyway, trustAndRemind, onDocumentDeleted, sweep,
  startReceiver, stopReceiver, _setReceiverUp, _setClock,
};
