/**
 * BILLS BY EMAIL — the accept stage (spec §5.1). The ONLY function an
 * adapter calls; it does not care whether mail came over SMTP or a
 * webhook. Cheap on purpose: no full MIME parse, no AI call. The adapter
 * answers 250 only after the row and the raw file are durable, so a
 * sender whose message we could not keep is told to retry.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("../db");
const store = require("./store");
const address = require("./address");
const { cfg } = require("./config");

const HOUR = 3600e3;
const DAY = 864e5;

const count = (name) => { try { require("../infra/observability").count(name); } catch (_) {} };

function refuse(code, smtpCode, text) {
  count(`mailin.rejected.${code}`);
  return { ok: false, code, smtp: { code: smtpCode, text } };
}

/** The header block, unfolded; null when the message has none. */
function headerBlock(raw) {
  const s = raw.slice(0, Math.min(raw.length, 256 * 1024)).toString("latin1");
  const m = s.match(/\r?\n\r?\n/);
  if (!m) return null;
  return s.slice(0, m.index).replace(/\r?\n[ \t]+/g, " ");
}

const filesRoot = () =>
  path.join(process.env.DATA_DIR || path.join(__dirname, "..", "..", "data"), "files");

/**
 * @param {Buffer} rawMime  the whole message
 * @param {string} recipient  the envelope RCPT address
 * @param {object} meta  {transport:'smtp'|'webhook'|'test', tls?}
 * @returns Accept: {ok:true, id, duplicate?} | {ok:false, code, smtp:{code,text}}
 */
async function ingestInbound(rawMime, recipient, meta = {}, { now = Date.now() } = {}) {
  const c = cfg();
  if (!c.enabled) return refuse("disabled", 451, "4.3.2 Not accepting mail right now");
  const p = address.parseRecipient(recipient);
  if (!p.domainOk) return refuse("relay", 550, "5.7.1 Relaying denied");
  const who = await address.resolve(recipient);
  if (!who || who.status !== "active") return refuse("unknown", 550, "5.1.1 Address not in use");
  const raw = Buffer.isBuffer(rawMime) ? rawMime : Buffer.from(String(rawMime || ""), "utf8");
  if (raw.length > c.maxBytes) return refuse("too_big", 552, `5.3.4 Message too big (limit ${c.maxMb} MB)`);
  if ((await store.countSince(who.userId, now - DAY)) >= c.dailyCap) {
    return refuse("daily_cap", 550, "5.2.2 Daily limit reached for this address");
  }
  if ((await store.countAllSince(now - HOUR)) >= c.hourlyCap) return refuse("busy", 451, "4.3.2 Busy, try again later");
  const head = headerBlock(raw);
  if (!head || !/^from:/im.test(head)) return refuse("bad_message", 550, "5.6.0 Not a valid email");

  const mid = head.match(/^message-id:\s*(.+)$/im);
  const messageId = mid ? mid[1].trim().slice(0, 300) : "";
  const dedupeKey = messageId
    ? "mid:" + crypto.createHash("sha256").update(messageId.toLowerCase()).digest("hex")
    : "raw:" + crypto.createHash("sha256").update(raw).digest("hex");

  const ins = await store.insertInbound({
    user_id: who.userId, address_id: who.addressId, dedupe_key: dedupeKey, message_id: messageId,
    size: raw.length, run_after: now, received_at: now,
  });
  if (!ins.created) {
    // The same message delivered twice: 250 again, filed once.
    count("mailin.duplicate");
    return { ok: true, id: ins.id, duplicate: true };
  }
  const dir = path.join(filesRoot(), String(who.userId), "mailin");
  const file = path.join(dir, `${ins.id}.eml`);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(file, raw, { mode: 0o600 });
    await store.patch(ins.id, { raw_path: file });
  } catch (e) {
    console.error("mailin: could not keep a message:", e.message);
    await db.run(`DELETE FROM mail_inbound WHERE id=$1`, [ins.id]).catch(() => {});
    await fs.promises.rm(file, { force: true }).catch(() => {});
    return refuse("store", 451, "4.3.0 Temporary problem, try again later");
  }
  count("mailin.accepted");
  try { require("./worker").kick(); } catch (_) {}
  return { ok: true, id: ins.id };
}

module.exports = { ingestInbound, headerBlock };
