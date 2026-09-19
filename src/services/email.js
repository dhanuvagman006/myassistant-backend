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
const { generateReply } = require("./ai/router");
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

// ---- SENT LEDGER + REMEMBERED RECIPIENTS -----------------------------
// Every send is recorded: the Email screen IS this list (his call,
// 2026-09-19 — "whatever mail I have sent should be visible here"), and
// it doubles as the address book, so "send it to the same address again"
// resolves without him repeating it.

async function ensureSentTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS email_sent (
      id         BIGSERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      to_addr    TEXT NOT NULL,
      to_label   TEXT NOT NULL DEFAULT '',
      subject    TEXT NOT NULL DEFAULT '',
      body       TEXT NOT NULL DEFAULT '',
      gmail_id   TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL
    )`);
  await query(
    "CREATE INDEX IF NOT EXISTS email_sent_user_idx ON email_sent (user_id, created_at DESC)"
  );
}

async function recordSent(userId, { to, label, subject, body, gmailId }) {
  try {
    await ensureSentTable();
    await query(
      `INSERT INTO email_sent (user_id, to_addr, to_label, subject, body, gmail_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [userId, to, (label || "").slice(0, 60), String(subject || "").slice(0, 300),
       String(body || "").slice(0, 8000), gmailId || "", Date.now()]
    );
  } catch (e) {
    console.warn("email sent-ledger write failed:", e.message);
  }
}

/** The sent list for the app. Newest first. */
async function listSent(userId, { limit = 30 } = {}) {
  await ensureSentTable();
  const rows = await query(
    `SELECT id, to_addr, to_label, subject, body, gmail_id, created_at
       FROM email_sent WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(Number(limit) || 30, 100)]
  );
  return rows.map((r) => ({
    id: String(r.id),
    to: r.to_addr,
    label: r.to_label || "",
    subject: r.subject,
    preview: String(r.body || "").replace(/\s+/g, " ").slice(0, 120),
    gmailId: r.gmail_id || "",
    at: Number(r.created_at),
  }));
}

/** Addresses this user has written to before, most recent first. */
async function recentRecipients(userId, limit = 12) {
  await ensureSentTable();
  return await query(
    `SELECT to_addr, MAX(to_label) AS to_label, MAX(created_at) AS last_at
       FROM email_sent WHERE user_id=$1
      GROUP BY to_addr ORDER BY MAX(created_at) DESC LIMIT $2`,
    [userId, limit]
  );
}

const ADDRESS_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SAME_RE =
  /^(the\s+)?(same|that|previous|last|usual)(\s+(address|one|person|email|id))?$/i;

/**
 * Turn whatever the user said into a real address.
 * An address passes through; "the same address", a name, or a label is
 * matched against who they have written to before. Returns
 * { address, label } or { need: "..." } when it must be asked for.
 */
async function resolveRecipient(userId, spoken) {
  const raw = String(spoken || "").trim();
  if (!raw) return { need: "who should it go to" };
  // Spoken addresses arrive as words: "ravi at gmail dot com".
  const spelled = raw
    .replace(/\s+at\s+/gi, "@")
    .replace(/\s+dot\s+/gi, ".")
    .replace(/\s+underscore\s+/gi, "_")
    .replace(/\s+(dash|hyphen)\s+/gi, "-")
    .replace(/\s+/g, "");
  if (ADDRESS_RE.test(raw)) return { address: raw.toLowerCase(), label: "" };
  if (ADDRESS_RE.test(spelled)) return { address: spelled.toLowerCase(), label: "" };

  const known = await recentRecipients(userId, 20);
  if (!known.length) return { need: `the email address for "${raw}"` };
  if (SAME_RE.test(raw)) {
    return { address: known[0].to_addr, label: known[0].to_label || "" };
  }
  const q = raw.toLowerCase();
  const hit =
    known.find((k) => (k.to_label || "").toLowerCase() === q) ||
    known.find((k) => (k.to_label || "").toLowerCase().includes(q)) ||
    known.find((k) => k.to_addr.toLowerCase().split("@")[0] === q) ||
    known.find((k) => k.to_addr.toLowerCase().includes(q));
  if (hit) return { address: hit.to_addr, label: hit.to_label || "" };
  return { need: `the email address for "${raw}"` };
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
// NOTE: no `category:primary`. Gmail only has categories when the user
// keeps the inbox TABS enabled — his does not, so that term matched zero
// messages and the screen looked empty with a perfectly good link.
// Excluding the noisy categories works either way.
const IMPORTANT_ONLY =
  "in:inbox -category:promotions -category:social " +
  "-category:updates -category:forums -in:spam -in:trash";

const NOISE_LABELS = [
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_FORUMS",
];

/** Worth reading aloud? Starred/Gmail-important always wins; otherwise
 *  drop the promo/social/forum buckets and anything carrying the bulk
 *  sender's unsubscribe header. */
function isImportant(m) {
  if (m.starred || m.important) return true;
  if ((m.labels || []).some((l) => NOISE_LABELS.includes(l))) return false;
  if (m.bulk) return false;
  return true;
}

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
      // Importance is decided on labels (see google/api.js), so fetch a
      // wider net and trim after filtering rather than asking Gmail for
      // exactly n and losing most of them.
      const rows = await gapi.recentEmails(userId, {
        max: important === false ? n : Math.min(n * 4, 40),
        q: gmailQuery({ from, text, unreadOnly, important }),
      });
      if (rows === null) throw { code: "no_account" };
      const kept = important === false ? rows : rows.filter(isImportant);
      return kept.slice(0, n).map((m) => ({
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

/**
 * THE IMPORTANT MAIL, RANKED BY THE MODEL.
 *
 * Structural signals were not enough: recruiter blasts and job-board
 * alerts arrive labelled CATEGORY_PERSONAL with no List-Unsubscribe
 * header, so labels alone cannot tell them from a real person writing.
 * Importance is a judgement, so a judgement is what makes it — the list
 * is pre-filtered cheaply, then the model keeps what a busy person would
 * actually want read out, most pressing first.
 *
 * Falls back to the structural list if the model is unavailable: a
 * slightly noisy inbox beats an empty screen.
 */
const _impCache = new Map(); // userId -> { at, items }

async function listImportant(userId, { limit = 12, force = false } = {}) {
  const hit = _impCache.get(userId);
  if (!force && hit && Date.now() - hit.at < 180_000) {
    return hit.items.slice(0, limit);
  }
  const rows = await listRecent(userId, { limit: 15, important: true });
  if (!rows.length) {
    _impCache.set(userId, { at: Date.now(), items: [] });
    return [];
  }

  const listing = rows
    .map((m, i) => `${i}. from ${m.from} <${m.fromAddr}> — "${m.subject}" — ${(m.snippet || "").slice(0, 120)}`)
    .join("\n");
  const sys =
    "You triage a busy professional's inbox. From the numbered emails, " +
    "return ONLY the ones that genuinely matter to them, most important " +
    "first. KEEP: a real person writing to them; interviews, offers and " +
    "recruiter mail addressed to them personally; security alerts and " +
    "account warnings; money — bills, payments, banking, invoices; " +
    "deadlines, exams, results, travel and delivery updates; anything " +
    "needing a reply. DROP: marketing and promotions, newsletters, " +
    "job-board blasts and quiz/enrolment campaigns, social notifications, " +
    "and automated notifications nobody must act on. Reply with STRICT " +
    'JSON only: {"keep":[{"i":<number>,"why":"<max 6 words>"}]}. ' +
    "If nothing qualifies, return an empty keep array.";

  let picked = null;
  try {
    const { reply } = await generateReply([{ role: "user", content: listing }], {
      system: sys,
    });
    const parsed = JSON.parse(
      String(reply || "").replace(/```json/gi, "").replace(/```/g, "").trim()
    );
    if (Array.isArray(parsed.keep)) picked = parsed.keep;
  } catch (_) {
    picked = null; // model down or bad JSON — fall through
  }

  const items = picked
    ? picked
        .map((k) => {
          const m = rows[Number(k.i)];
          return m ? { ...m, why: String(k.why || "").slice(0, 60) } : null;
        })
        .filter(Boolean)
    : rows;
  _impCache.set(userId, { at: Date.now(), items });
  return items.slice(0, limit);
}

module.exports = {
  getAccount,
  listImportant,
  listSent,
  recentRecipients,
  resolveRecipient,
  recordSent,
  connectAccount,
  disconnectAccount,
  listRecent,
  readBody,
  send,
};
