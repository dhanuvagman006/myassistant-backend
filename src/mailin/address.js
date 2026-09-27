/**
 * BILLS BY EMAIL — the private address.
 *
 * 12 characters of lowercase Crockford base32 (60 bits), shown as
 * xxxx-xxxx-xxxx@<MAILIN_DOMAIN>. No name in it, so it leaks nothing, and
 * enumeration over SMTP is not practical. The code only lets mail in —
 * it is not a credential — so it is stored as it is.
 *
 * States: active (accepts mail), off (refused; turning on keeps the code),
 * retired (replaced by "Get a new address"; refused, and the row is kept
 * so a code is never reissued while the account exists).
 */
const crypto = require("crypto");
const { one, run, tx } = require("../db");
const { cfg } = require("./config");

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const CODE_LEN = 12;
const ROTATE_PER_DAY = 5;
const MAX_TRUSTED = 5;
const DAY = 864e5;

function newCode() {
  const b = crypto.randomBytes(CODE_LEN);
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[b[i] & 31];
  return s;
}

function format(code, domain = cfg().domain) {
  const c = String(code || "");
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}@${domain}`;
}

/** An incoming local part → the stored code, or null. */
function normalizeLocal(local) {
  let s = String(local || "").toLowerCase();
  const plus = s.indexOf("+");
  if (plus >= 0) s = s.slice(0, plus);
  s = s.replace(/[-.]/g, "").replace(/o/g, "0").replace(/[il]/g, "1");
  if (s.length !== CODE_LEN) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

function parseRecipient(rcpt) {
  const s = String(rcpt || "").trim().replace(/^<|>$/g, "");
  const at = s.lastIndexOf("@");
  if (at <= 0) return { code: null, domainOk: false };
  const domain = s.slice(at + 1).toLowerCase().replace(/\.$/, "");
  const want = cfg().domain;
  return { code: normalizeLocal(s.slice(0, at)), domainOk: Boolean(want) && domain === want };
}

/** → {userId, addressId, status} for a known code, else null. */
async function resolve(rcpt) {
  const p = parseRecipient(rcpt);
  if (!p.domainOk || !p.code) return null;
  const r = await one(`SELECT id, user_id, status FROM mail_addresses WHERE code=$1`, [p.code]);
  return r ? { userId: Number(r.user_id), addressId: Number(r.id), status: r.status } : null;
}

const getForUser = (uid) =>
  one(`SELECT * FROM mail_addresses WHERE user_id=$1 AND status IN ('active','off')`, [uid]);

async function insertNew(c, uid, trustedFrom = []) {
  const now = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      await c.query("SAVEPOINT mailin_code");
      const r = await c.query(
        `INSERT INTO mail_addresses (user_id, code, status, trusted_from, created_at, updated_at)
         VALUES ($1,$2,'active',$3,$4,$4) RETURNING *`,
        [uid, newCode(), JSON.stringify(trustedFrom), now]);
      await c.query("RELEASE SAVEPOINT mailin_code");
      return r.rows[0];
    } catch (e) {
      await c.query("ROLLBACK TO SAVEPOINT mailin_code");
      // One retry on a code collision; anything else is real.
      if (e.code !== "23505" || attempt >= 1 || !/code/.test(e.constraint || e.detail || "")) throw e;
    }
  }
}

/** Creates the address, or switches the existing one back on. Idempotent. */
async function turnOn(uid) {
  const had = await getForUser(uid);
  if (had) {
    if (had.status === "active") return had;
    return one(`UPDATE mail_addresses SET status='active', updated_at=$2 WHERE id=$1 RETURNING *`,
      [had.id, Date.now()]);
  }
  try {
    return await tx((c) => insertNew(c, uid));
  } catch (e) {
    // Two taps at once: the one-live index let the other one win.
    if (e.code === "23505") return getForUser(uid);
    throw e;
  }
}

async function setOn(uid, on) {
  return one(
    `UPDATE mail_addresses SET status=$2, updated_at=$3
      WHERE user_id=$1 AND status IN ('active','off') RETURNING *`,
    [uid, on ? "active" : "off", Date.now()]);
}

/** Retire the live address and issue a new one, carrying trusted_from over. */
async function rotate(uid, now = Date.now()) {
  return tx(async (c) => {
    const n = (await c.query(
      `SELECT count(*)::int AS n FROM mail_addresses WHERE user_id=$1 AND retired_at >= $2`,
      [uid, now - DAY])).rows[0].n;
    if (n >= ROTATE_PER_DAY) throw Object.assign(new Error("rotate limit"), { code: "rotate_limit" });
    const old = (await c.query(
      `UPDATE mail_addresses SET status='retired', retired_at=$2, updated_at=$2
        WHERE user_id=$1 AND status IN ('active','off') RETURNING *`, [uid, now])).rows[0];
    const made = await insertNew(c, uid, old ? old.trusted_from || [] : []);
    return { address: made, retired: old || null };
  });
}

const trustedOf = (row) => (Array.isArray(row && row.trusted_from) ? row.trusted_from : []);

async function trust(uid, addr) {
  const a = String(addr || "").trim().toLowerCase();
  const row = await getForUser(uid);
  if (!row || !a) return null;
  const next = [...trustedOf(row).filter((x) => x !== a), a].slice(-MAX_TRUSTED);
  await run(`UPDATE mail_addresses SET trusted_from=$2, updated_at=$3 WHERE id=$1`,
    [row.id, JSON.stringify(next), Date.now()]);
  return next;
}

/** @returns the new list, or null when the address was not in it. */
async function untrust(uid, addr) {
  const a = String(addr || "").trim().toLowerCase();
  const row = await getForUser(uid);
  if (!row || !trustedOf(row).includes(a)) return null;
  const next = trustedOf(row).filter((x) => x !== a);
  await run(`UPDATE mail_addresses SET trusted_from=$2, updated_at=$3 WHERE id=$1`,
    [row.id, JSON.stringify(next), Date.now()]);
  return next;
}

function toClient(row) {
  if (!row) return null;
  return { address: format(row.code), status: row.status, createdAt: Number(row.created_at) };
}

module.exports = {
  ALPHABET, newCode, format, normalizeLocal, parseRecipient, resolve, getForUser,
  turnOn, setOn, rotate, trust, untrust, trustedOf, toClient, ROTATE_PER_DAY,
};
