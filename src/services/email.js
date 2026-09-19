/**
 * EMAIL — the assistant reads and sends the user's mail WHEN ASKED.
 *
 * "Read my mails" / "any mail from the bank?"  -> summarise the newest
 * matching messages aloud. "Send a mail to ravi@x.com that I'll be late"
 * -> compose + send after the user confirms the gist.
 *
 * One mailbox per user, connected ONCE in the app (Hub → Email) with an
 * address + app password (Gmail's app password, or any IMAP/SMTP account;
 * hosts are derived from the domain and can be overridden). Credentials
 * are AES-256-GCM encrypted at rest with the same key scheme as the MCP
 * registry (mcp/schema.js) and are never returned by any GET.
 *
 * Deliberately IMAP/SMTP and not the Gmail REST API: no Google app
 * verification gauntlet, works for Outlook/Yahoo/company mail too, and
 * an app password is revocable by the user at any time.
 */

const { ImapFlow } = require("imapflow");
const nodemailer = require("nodemailer");
const { simpleParser } = require("mailparser");
const { query } = require("../db");
const { encryptSecrets, decryptSecrets } = require("../mcp/schema");

// Known providers; anything else falls back to imap.<domain>/smtp.<domain>.
const PRESETS = {
  "gmail.com": { imap: "imap.gmail.com", smtp: "smtp.gmail.com" },
  "googlemail.com": { imap: "imap.gmail.com", smtp: "smtp.gmail.com" },
  "outlook.com": { imap: "outlook.office365.com", smtp: "smtp.office365.com" },
  "hotmail.com": { imap: "outlook.office365.com", smtp: "smtp.office365.com" },
  "live.com": { imap: "outlook.office365.com", smtp: "smtp.office365.com" },
  "yahoo.com": { imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com" },
  "yahoo.in": { imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com" },
  "zoho.com": { imap: "imap.zoho.com", smtp: "smtp.zoho.com" },
  "zoho.in": { imap: "imap.zoho.in", smtp: "smtp.zoho.in" },
  "rediffmail.com": { imap: "imap.rediffmail.com", smtp: "smtp.rediffmail.com" },
};

function hostsFor(address, imapHost, smtpHost) {
  const domain = String(address).split("@")[1]?.toLowerCase() || "";
  const p = PRESETS[domain] || { imap: `imap.${domain}`, smtp: `smtp.${domain}` };
  return {
    imap: (imapHost || "").trim() || p.imap,
    smtp: (smtpHost || "").trim() || p.smtp,
  };
}

async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS email_accounts (
      user_id     INTEGER PRIMARY KEY,
      address     TEXT NOT NULL,
      imap_host   TEXT NOT NULL,
      smtp_host   TEXT NOT NULL,
      secrets_enc TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

async function getAccount(userId) {
  await ensureTable();
  const r = await query(
    "SELECT address, imap_host, smtp_host, secrets_enc FROM email_accounts WHERE user_id=$1",
    [userId]
  );
  // db.query() resolves to the ROWS ARRAY, not a pg result object —
  // reading r.rows here threw on every single call, which is why the
  // assistant answered "I can't do that" even with Gmail fully linked.
  if (!r.length) return null;
  const row = r[0];
  const sec = decryptSecrets(row.secrets_enc);
  if (!sec || !sec.password) return null; // key rotated — treat as unlinked
  return {
    address: row.address,
    imapHost: row.imap_host,
    smtpHost: row.smtp_host,
    password: sec.password,
  };
}

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${what} timed out`)), ms)
    ),
  ]);
}

function imapClient(acc) {
  return new ImapFlow({
    host: acc.imapHost,
    port: 993,
    secure: true,
    auth: { user: acc.address, pass: acc.password },
    logger: false,
    // A phone hotspot in a lift should fail, not hang the voice turn.
    socketTimeout: 20000,
    greetingTimeout: 15000,
  });
}

function smtpTransport(acc) {
  return nodemailer.createTransport({
    host: acc.smtpHost,
    port: 465,
    secure: true,
    auth: { user: acc.address, pass: acc.password },
    connectionTimeout: 15000,
  });
}

/** Verify both directions actually log in, then store (upsert). */
async function connectAccount(userId, { address, password, imapHost, smtpHost }) {
  const addr = String(address || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) throw new Error("that email address doesn't look valid");
  const pass = String(password || "").replace(/\s+/g, ""); // Gmail shows app passwords with spaces
  if (pass.length < 6) throw new Error("password looks too short");
  const hosts = hostsFor(addr, imapHost, smtpHost);
  const acc = { address: addr, password: pass, imapHost: hosts.imap, smtpHost: hosts.smtp };

  const client = imapClient(acc);
  try {
    await withTimeout(client.connect(), 20000, "IMAP login");
  } catch (e) {
    throw new Error(`IMAP login failed at ${hosts.imap}: ${cleanErr(e)}`);
  } finally {
    client.logout().catch(() => {});
  }
  try {
    await withTimeout(smtpTransport(acc).verify(), 20000, "SMTP login");
  } catch (e) {
    throw new Error(`SMTP login failed at ${hosts.smtp}: ${cleanErr(e)}`);
  }

  await ensureTable();
  await query(
    `INSERT INTO email_accounts (user_id, address, imap_host, smtp_host, secrets_enc)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id) DO UPDATE SET address=$2, imap_host=$3, smtp_host=$4, secrets_enc=$5`,
    [userId, addr, hosts.imap, hosts.smtp, encryptSecrets({ password: pass })]
  );
  return { address: addr };
}

async function disconnectAccount(userId) {
  await ensureTable();
  await query("DELETE FROM email_accounts WHERE user_id=$1", [userId]);
}

function cleanErr(e) {
  return String(e?.responseText || e?.message || e)
    .replace(/[\r\n]+/g, " ")
    .slice(0, 160);
}

// ---- GOOGLE ONE-TAP PATH ----------------------------------------------
// A user who linked Google (google_tokens) gets Gmail through the REST
// API — no password ever typed. The IMAP account, when present, wins
// (it is the more deliberate setup); Google is the seamless default.

async function googleLinked(userId) {
  try {
    return await require("../google/tokens").isConnected(userId);
  } catch (_) {
    return false;
  }
}

// WHAT "IMPORTANT" MEANS HERE (his spec, 2026-09-19): the primary inbox
// with promotions, social, updates, forums, spam and trash all excluded —
// the mail a person actually wants read to them, not newsletters.
const IMPORTANT_ONLY =
  "in:inbox category:primary -category:promotions -category:social " +
  "-category:updates -category:forums -in:spam -in:trash";

function gmailQuery({ from, text, unreadOnly, important }) {
  const parts = [important === false ? "in:inbox" : IMPORTANT_ONLY];
  if (from) parts.push(`from:${String(from).replace(/\s+/g, "")}`);
  if (text) parts.push(String(text));
  if (unreadOnly) parts.push("is:unread");
  if (!from && !text) parts.push("newer_than:14d");
  return parts.join(" ");
}

/**
 * Latest messages, newest first. `from`/`text` narrow the search.
 * Returns [{uid, from, fromAddr, subject, date, snippet, unread}].
 */
async function listRecent(
  userId,
  { from, text, unreadOnly, limit, important } = {}
) {
  const acc = await getAccount(userId);
  if (!acc) {
    if (await googleLinked(userId)) {
      const gapi = require("../google/api");
      const n = Math.min(Math.max(Number(limit) || 5, 1), 25);
      const rows = await gapi.recentEmails(userId, {
        max: n,
        q: gmailQuery({ from, text, unreadOnly, important }),
      });
      if (rows === null) throw { code: "no_account" };
      return rows.map((m) => ({
        uid: m.id, // Gmail message id — email_read passes it back for the body
        from: m.from || "unknown sender",
        fromAddr: m.fromEmail || "",
        subject: m.subject,
        snippet: m.snippet || "",
        date: m.date ? new Date(m.date).toISOString() : null,
        unread: Boolean(m.unread),
      }));
    }
    throw { code: "no_account" };
  }
  const n = Math.min(Math.max(Number(limit) || 5, 1), 25);
  const client = imapClient(acc);
  await withTimeout(client.connect(), 20000, "IMAP connect");
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      let uids;
      const crit = {};
      if (from) crit.from = String(from);
      if (text) crit.or = [{ subject: String(text) }, { body: String(text) }];
      if (unreadOnly) crit.seen = false;
      if (Object.keys(crit).length) {
        uids = await withTimeout(client.search(crit, { uid: true }), 20000, "search");
        uids = (uids || []).slice(-n);
      } else {
        const exists = client.mailbox.exists;
        if (!exists) return [];
        const start = Math.max(1, exists - n + 1);
        uids = null; // sequence range fetch below
        const out = [];
        for await (const msg of client.fetch(`${start}:*`, {
          envelope: true,
          flags: true,
          uid: true,
        })) {
          out.push(msg);
        }
        return out.map(toSummary).reverse();
      }
      if (!uids.length) return [];
      const out = [];
      for await (const msg of client.fetch(uids, { envelope: true, flags: true, uid: true }, { uid: true })) {
        out.push(msg);
      }
      out.sort((a, b) => (a.envelope?.date || 0) - (b.envelope?.date || 0));
      return out.map(toSummary).reverse();
    } finally {
      lock.release();
    }
  } finally {
    client.logout().catch(() => {});
  }
}

function toSummary(msg) {
  const env = msg.envelope || {};
  const f = (env.from && env.from[0]) || {};
  return {
    uid: msg.uid,
    from: f.name || f.address || "unknown sender",
    fromAddr: f.address || "",
    subject: env.subject || "(no subject)",
    date: env.date ? new Date(env.date).toISOString() : null,
    unread: !(msg.flags && msg.flags.has("\\Seen")),
  };
}

/** Full plain-text body of one message (for "read that one out"). */
async function readBody(userId, uid) {
  const acc = await getAccount(userId);
  if (!acc) {
    if (await googleLinked(userId)) {
      const m = await require("../google/api").messageBody(userId, String(uid));
      if (m === null) throw { code: "no_account" };
      return m || null;
    }
    throw { code: "no_account" };
  }
  const client = imapClient(acc);
  await withTimeout(client.connect(), 20000, "IMAP connect");
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const msg = await withTimeout(
        client.fetchOne(String(uid), { source: true }, { uid: true }),
        25000,
        "fetch message"
      );
      if (!msg || !msg.source) return null;
      const parsed = await simpleParser(msg.source);
      const bodyText = (parsed.text || "").trim() ||
        String(parsed.html || "").replace(/<[^>]+>/g, " ");
      return {
        from: parsed.from?.text || "",
        subject: parsed.subject || "(no subject)",
        date: parsed.date ? parsed.date.toISOString() : null,
        body: bodyText.replace(/\s+/g, " ").slice(0, 4000),
      };
    } finally {
      lock.release();
    }
  } finally {
    client.logout().catch(() => {});
  }
}

async function send(userId, { to, subject, body }) {
  const acc = await getAccount(userId);
  const addr = String(to || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) throw { code: "bad_address" };
  if (!acc) {
    if (await googleLinked(userId)) {
      const gapi = require("../google/api");
      try {
        const out = await gapi.sendEmail(userId, {
          to: addr,
          subject: String(subject || "").slice(0, 200) || "(no subject)",
          body: String(body || "").slice(0, 20000),
        });
        if (out === null) throw { code: "no_account" };
        return { messageId: out.id, from: "your Gmail" };
      } catch (e) {
        if (/scope/.test(String(e?.message))) {
          // Older grant without gmail.send — leave a ready draft instead.
          const d = await gapi.createDraft(userId, {
            to: addr,
            subject: String(subject || "").slice(0, 200) || "(no subject)",
            body: String(body || "").slice(0, 20000),
          });
          if (d === null) throw { code: "no_account" };
          return { draft: true, from: "your Gmail" };
        }
        throw e;
      }
    }
    throw { code: "no_account" };
  }
  const info = await withTimeout(
    smtpTransport(acc).sendMail({
      from: acc.address,
      to: addr,
      subject: String(subject || "").slice(0, 200) || "(no subject)",
      text: String(body || "").slice(0, 20000),
    }),
    30000,
    "send"
  );
  return { messageId: info.messageId || null, from: acc.address };
}

module.exports = {
  getAccount,
  connectAccount,
  disconnectAccount,
  listRecent,
  readBody,
  send,
};
