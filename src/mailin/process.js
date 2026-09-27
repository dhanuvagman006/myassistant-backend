/**
 * BILLS BY EMAIL — the processing stage (spec §5.3), one accepted email at
 * a time, from the worker.
 *
 * WHAT AN EMAIL CAN BECOME: documents in My documents, reminders, and one
 * push. Nothing else. Nothing here calls a tool, the agent runtime, the
 * registry, or any URL in the mail; the only model call is the analyser's
 * JSON extraction, and what it returns is range-checked (plan.js) before
 * it touches a title, a reminder or a push.
 *
 * Every step is idempotent, so a retry after a crash never duplicates:
 * documents are found again by source_ref, hashes and ids are recorded as
 * they are made, and reminders_done guards the reminders.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("../db");
const store = require("./store");
const plan = require("./plan");
const trust = require("./trust");
const address = require("./address");
const { cfg } = require("./config");
const analyze = require("../docs/analyze"); // looked up per call: the tests stub it
const docs = require("../docs/store");

const DAY = 864e5;
const MIME = { pdf: "application/pdf", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const EXT = { pdf: ".pdf", jpeg: ".jpg", png: ".png", webp: ".webp" };
const OTP_RE = /\b(otp|one[- ]time (pass(word|code)|code)|verification code|login code|security code)\b/i;

const count = (name) => { try { require("../infra/observability").count(name); } catch (_) {} };

/** Magic bytes only — the declared type is never trusted. */
function sniffType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.slice(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

/** Width and height from the header alone, or null. */
function imageDims(buf, type) {
  try {
    if (type === "png") return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (type === "webp") {
      const chunk = buf.slice(12, 16).toString("latin1");
      if (chunk === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (chunk === "VP8L") {
        const b = buf.readUInt32LE(21);
        return { w: 1 + (b & 0x3fff), h: 1 + ((b >>> 14) & 0x3fff) };
      }
      if (chunk === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      return null;
    }
    if (type === "jpeg") {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const m = buf[i + 1];
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch (_) {}
  return null;
}

/** A tiny file that decodes to a huge bitmap would crash the phone's grid. */
function imageTooLarge(buf, type) {
  const d = imageDims(buf, type);
  return Boolean(d && (d.w > 12000 || d.h > 12000 || d.w * d.h > 40e6));
}

/** No path or control characters, ≤80 characters, extension = sniffed type. */
function safeFilename(name, type) {
  let base = String(name || "").replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).pop();
  base = base.replace(/[:*?"<>|]/g, "").replace(/\.[a-z0-9]{1,5}$/i, "").replace(/\s+/g, " ").trim();
  const ext = EXT[type] || "";
  return (base || "email-document").slice(0, 80 - ext.length).trim() + ext;
}

const isEncryptedPdf = (buf) => buf.includes("/Encrypt", 0, "latin1");

/** HTML → plain words: tags, scripts and styles gone; nothing is fetched. */
function htmlToText(html) {
  const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(html || "")
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] !== "#") return ENT[e.toLowerCase()] ?? m;
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return n > 31 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The plain-text part, or the HTML part's words when there is none. */
const bodyText = (parsed) =>
  String((parsed && (parsed.text || htmlToText(parsed.html))) || "").replace(/\r\n/g, "\n").slice(0, 20000);

function looksLikeOtp(subject, text, keptParts) {
  if (keptParts > 0) return false;
  const s = `${subject || ""}\n${String(text || "").slice(0, 600)}`;
  return OTP_RE.test(s) && /(?<![\d.,])\d{4,8}(?![\d.,])/.test(s);
}

/** A forwarding confirmation's code (only from a signed sender), or null. */
function detectForwardConfirm({ subject, text }, auth) {
  if (!["you", "verified", "personal"].includes(auth)) return null;
  const s = `${subject || ""}\n${String(text || "").slice(0, 3000)}`;
  if (!/forward/i.test(s) || !/confirm|verif/i.test(s)) return null;
  // The code the message names as a code, else any 6-10 digit run.
  const m = s.match(/code\D{0,20}?(?<!\d)(\d{6,10})(?!\d)/i) || s.match(/(?<!\d)(\d{6,10})(?!\d)/);
  return m ? m[1] : null;
}

/** The email's words as a text-only PDF: no images, no links, nothing fetched. */
async function renderBodyPdf({ subject, fromDomain, date, text }) {
  const docgen = require("../services/docgen");
  let spec;
  try {
    spec = docgen.normalize("pdf", {
      title: subject || "Email",
      subtitle: `From ${fromDomain || "an outside sender"} · ${date}`,
      sections: [{ heading: "", paragraphs: String(text || "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).slice(0, 30) }],
    });
  } catch (_) {
    return null; // "came back empty": nothing to file
  }
  return docgen.RENDER.pdf(spec, docgen.hex());
}

/** Which attachments are worth filing, and why each other one is not. */
function pickParts(attachments, html = "") {
  const c = cfg();
  const kept = [];
  const skipped = [];
  for (const a of attachments) {
    const name = String(a.filename || "attachment").slice(0, 80);
    const content = a.content;
    const type = sniffType(content);
    const skip = (why) => skipped.push({ name, type: String(a.contentType || "").slice(0, 60), why });
    if (!type) { skip("file type not supported"); continue; }
    if (content.length > c.maxPartBytes) { skip("too big"); continue; }
    if (type !== "pdf") {
      if (content.length < 15 * 1024) { skip("picture too small"); continue; }
      if (imageTooLarge(content, type)) { skip("picture too large"); continue; }
      if (a.cid && html.includes(`cid:${a.cid}`)) { skip("picture in the email itself"); continue; }
    }
    if (kept.length >= c.maxFiles) { skip("too many files"); continue; }
    kept.push({
      content, type, mime: MIME[type], filename: safeFilename(a.filename, type),
      hash: crypto.createHash("sha256").update(content).digest("hex"), name,
    });
  }
  return { kept, skipped };
}

const userExists = async (uid) => Boolean(await db.one(`SELECT 1 AS x FROM users WHERE id=$1`, [uid]));

async function dropRaw(row) {
  if (row.raw_path) await fs.promises.rm(row.raw_path, { force: true }).catch(() => {});
}

/** The account is gone: nothing of this email may stay. */
async function gone(row) {
  await db.run(`DELETE FROM mail_inbound WHERE id=$1`, [row.id]).catch(() => {});
  await dropRaw(row);
  return { state: "erased" };
}

async function sendPush(row, uid, msg, data, pushKind, now) {
  if (row.pushed) return false;
  const since = now - DAY;
  if ((await store.countPushesSince(uid, since)) >= 10) return false;
  if ((pushKind === "already" || pushKind === "nothing") &&
      (await store.countPushesSince(uid, since, ["already", "nothing"])) >= 3) return false;
  const u = await db.one(`SELECT fcm_token FROM users WHERE id=$1`, [uid]);
  if (!u) return false;
  const strData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
  try {
    const r = await require("../services/push").send(u.fcm_token, msg.title, msg.body, strData);
    if (!r.ok && !r.stale) {
      await require("../services/pendingPush").queue(uid, msg.title, msg.body, strData).catch(() => {});
    }
  } catch (_) { /* a push never fails the filing */ }
  await store.patch(row.id, { pushed: 1, push_kind: pushKind });
  row.pushed = 1;
  return true;
}

/** Finish without filing: skipped or failed. */
async function finish(row, fields, push = null, now = Date.now()) {
  const changed = await store.patch(row.id, { ...fields, raw_path: "" });
  await dropRaw(row);
  if (!changed) return { state: "erased" };
  count(`mailin.${fields.state}`);
  if (push) await sendPush(row, Number(row.user_id), push.msg, push.data, push.kind, now);
  return { state: fields.state };
}

const categoryFor = (kind, fallback) =>
  kind === "ticket" ? "ticket" : ["bill", "invoice", "statement"].includes(kind) ? "bill" :
    kind === "receipt" ? "receipt" : fallback;

/**
 * @param row  the claimed mail_inbound row
 * @param opts {final, now, resolveTxt}
 * @returns {Promise<{state}>}; throws to be retried
 */
async function processInbound(row, opts = {}) {
  const now = opts.now || Date.now();
  const uid = Number(row.user_id);
  if (!(await userExists(uid))) return gone(row);

  let raw;
  try { raw = await fs.promises.readFile(row.raw_path); } catch (_) {
    return finish(row, { state: "failed", reason: "email was lost" }, null, now);
  }
  const { simpleParser } = require("mailparser");
  const parsed = await simpleParser(raw, { skipImageLinks: true });

  // Trust always comes from the OUTER message.
  const addrRow = await db.one(`SELECT trusted_from FROM mail_addresses WHERE id=$1`, [row.address_id]);
  const t = await trust.classifySender(raw, {
    trustedFrom: address.trustedOf(addrRow), ownAddresses: await trust.ownAddresses(uid),
    resolveTxt: opts.resolveTxt, now,
  });

  let subject = parsed.subject || "";
  let text = bodyText(parsed);
  let html = String(parsed.html || "");
  const attachments = [];
  for (const a of parsed.attachments || []) {
    if (!/^message\/rfc822/i.test(a.contentType || "")) { attachments.push(a); continue; }
    // "Forward as attachment": one level down. Its From is never trusted.
    const inner = await simpleParser(a.content, { skipImageLinks: true }).catch(() => null);
    if (!inner) continue;
    attachments.push(...(inner.attachments || []).filter((x) => !/^message\//i.test(x.contentType || "")));
    text = (text + "\n\n" + bodyText(inner)).slice(0, 20000);
    html += String(inner.html || "");
    if (t.auth === "you" && inner.subject) subject = inner.subject;
  }
  // The user's own forward ("Fwd: bill"): the forwarded mail's subject
  // says more. mailparser folds a forwarded-as-attachment message into the
  // body, headers and all, so it is read from there. Only for `you`.
  if (t.auth === "you" && /^\s*(fwd?|fw)\s*:/i.test(subject)) {
    const inner = text.match(/^Subject:[ \t]*(.+)$/im);
    if (inner) subject = inner[1];
  }
  subject = plan.cleanText(subject, 300);
  const who = { from_addr: t.fromAddr, from_domain: t.fromDomain, auth: t.auth, subject };
  await store.patch(row.id, who);

  // Special cases, deterministic, before any AI call.
  const code = detectForwardConfirm({ subject, text }, t.auth);
  if (code) {
    return finish(row, { state: "skipped", kind: "forward_confirm", reason: "confirmation code",
      extract: { confirmCode: code } },
    { msg: plan.pushFor({ status: "confirm" }), data: { kind: "mail_confirm", mailId: row.id }, kind: "confirm" }, now);
  }
  const { kept, skipped } = pickParts(attachments, html);
  const fresh = [];
  for (const k of kept) {
    if (await store.findByFileHash(uid, k.hash, now - 90 * DAY, row.id)) {
      skipped.push({ name: k.name, type: MIME[k.type], why: "already saved" });
    } else fresh.push(k);
  }
  if (looksLikeOtp(subject, text, fresh.length)) {
    return finish(row, { state: "skipped", kind: "otp", subject: "", reason: "one-time code, not saved",
      skipped_parts: [] }, null, now);
  }

  let parts = fresh;
  let bodyIsDocument = false;
  if (!parts.length) {
    if (kept.length) {
      return finish(row, { state: "skipped", reason: "already saved", skipped_parts: skipped },
        { msg: plan.pushFor({ status: "already" }), data: { kind: "mail_filed", mailId: row.id }, kind: "already" }, now);
    }
    const pdf = text.trim().length >= 40
      ? await renderBodyPdf({ subject, fromDomain: t.fromDomain, date: new Date(now).toISOString().slice(0, 10), text })
      : null;
    if (!pdf) {
      return finish(row, { state: "skipped", reason: "nothing to save", skipped_parts: skipped },
        { msg: plan.pushFor({ status: "nothing" }), data: { kind: "mail_filed", mailId: row.id }, kind: "nothing" }, now);
    }
    bodyIsDocument = true;
    parts = [{ content: pdf, type: "pdf", mime: MIME.pdf, filename: safeFilename(subject || "Email", "pdf"),
      hash: crypto.createHash("sha256").update(pdf).digest("hex"), name: "email" }];
  }

  // Understand, before anything is filed.
  const mailCtx = { subject, fromDomain: t.fromDomain, bodyText: text.slice(0, 4000) };
  const bodyBuf = Buffer.from(text || subject || " ", "utf8");
  let encrypted = false;
  const metas = [];
  for (const p of parts) {
    let meta;
    if (bodyIsDocument) {
      meta = await analyze.analyzeDocument(bodyBuf, "text/plain", "email.txt", { mail: { ...mailCtx, bodyIsDocument: true } });
    } else if (p.type === "pdf" && isEncryptedPdf(p.content)) {
      // Never ask for, or use, a password: read the email's own words.
      encrypted = true;
      skipped.push({ name: p.name, type: MIME.pdf, why: "password-protected — open it with your password" });
      meta = await analyze.analyzeDocument(bodyBuf, "text/plain", "email.txt", { mail: { ...mailCtx, bodyIsDocument: false } });
    } else {
      meta = await analyze.analyzeDocument(p.content, p.mime, p.filename, { mail: { ...mailCtx, bodyIsDocument: false } });
    }
    metas.push(meta || null);
  }
  const couldntRead = !metas[0];
  if (couldntRead && !opts.final) throw new Error("the analyser could not read it yet");
  const primary = metas[0];
  const x = primary ? plan.cleanExtract(primary.mail, now, primary.expiresOn) : null;
  if (x && x.kind === "promo") {
    return finish(row, { state: "skipped", kind: "promo", reason: "looked like an ad", skipped_parts: skipped }, null, now);
  }
  if (x && x.kind === "otp") {
    return finish(row, { state: "skipped", kind: "otp", subject: "", reason: "one-time code, not saved", skipped_parts: [] }, null, now);
  }

  // File.
  if (!(await userExists(uid))) return gone(row);
  const verified = t.auth === "you" || t.auth === "verified";
  const docIds = (row.document_ids || []).map(Number);
  const hashes = [...(row.file_hashes || [])];
  const titles = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const meta = metas[i];
    const ref = `${row.id}:${i}`;
    let docId = (await db.one(`SELECT id FROM documents WHERE user_id=$1 AND source_ref=$2`, [uid, ref]))?.id;
    let created = false;
    if (!docId) {
      try {
        docId = (await docs.createDocument(uid, {
          buffer: p.content, filename: p.filename, mime: p.mime,
          source: { kind: "email", ref, label: t.fromDomain, verified },
        })).id;
        created = true;
      } catch (e) {
        if (e instanceof docs.DocumentLimitError) {
          return finish(row, { state: "failed", reason: "documents full", skipped_parts: skipped },
            { msg: plan.pushFor({ status: "full" }), data: { kind: "mail_filed", mailId: row.id }, kind: "full" }, now);
        }
        if (e.code !== "23505") throw e;
        docId = (await db.one(`SELECT id FROM documents WHERE user_id=$1 AND source_ref=$2`, [uid, ref]))?.id;
        if (!docId) throw e;
      }
    }
    const title = plan.cleanText(meta && meta.title, 100) || plan.cleanText(subject, 100) ||
      `Email from ${t.fromDomain || "an outside sender"}`;
    titles.push(title);
    const updated = await docs.setMetadata(uid, docId, {
      title,
      category: categoryFor(x && x.kind, meta && meta.category),
      docDate: meta && meta.docDate,
      summary: meta ? plan.cleanText(meta.summary, 1200) : "Couldn't read this one automatically — open it to check.",
      tags: meta && meta.tags,
      fullText: meta && meta.fullText,
    });
    if (!docIds.includes(Number(docId))) docIds.push(Number(docId));
    if (!hashes.includes(p.hash)) hashes.push(p.hash);
    await store.patch(row.id, { document_ids: docIds, file_hashes: hashes });

    // Renewals: listed as expiring, and nothing else ever files expiry
    // alerts for it — its reminders are this email's own (step 9), under
    // the sender gate, with their ids kept so a delete removes them.
    const renewOn = x && (x.expiresOn || (x.kind === "renewal" ? x.dueOn : ""));
    if (renewOn) {
      await db.run(`UPDATE documents SET expires_on=$1, expiry_alerts=1 WHERE id=$2 AND user_id=$3`,
        [renewOn, docId, uid]);
    }
    // Searchable inside, exactly as uploads are. No memory fact, and no
    // understandDocument: an outside sender's title never enters memory.
    const fullText = updated && updated.full_text;
    if (created && fullText) {
      await require("../infra/jobs").enqueue("document.index", { userId: uid, documentId: Number(docId), text: fullText }, { userId: uid })
        .catch((e) => console.warn("mailin: index enqueue failed:", e.message));
    }
  }

  // Reminders: only for mail from the user or a signed company.
  let reminderIds = (row.reminder_ids || []).map(Number);
  let planned = [];
  let remindersSet = Boolean(row.reminders_done);
  if (x && !row.reminders_done && (verified || cfg().remindUnverified)) {
    if (!(await userExists(uid))) return undo(row, uid, docIds, reminderIds);
    const r = await remindFrom(uid, row.id, x, titles[0], now);
    reminderIds = r.ids;
    planned = r.planned;
    remindersSet = true;
  }

  const changed = await store.patch(row.id, {
    state: "filed", kind: x ? x.kind : "other", extract: x || {}, reason: couldntRead ? "couldn't read" : "",
    skipped_parts: skipped, raw_path: "",
  }, uid);
  if (!changed) return undo(row, uid, docIds, reminderIds);
  await dropRaw(row);
  count("mailin.filed");
  require("../audit/log").record(uid, "document.saved", `from email: ${titles[0].slice(0, 60)}`);
  await require("../outcomes/store").create(uid, { kind: "document", target: "My documents",
    detail: "saved from email", status: "completed" }).catch(() => {});

  const u = await db.one(`SELECT tz_offset_min FROM users WHERE id=$1`, [uid]);
  const tz = require("../services/tz").offsetOr(u && u.tz_offset_min);
  const msg = couldntRead
    ? plan.pushFor({ status: "couldnt_read", subject })
    : plan.pushFor({ status: "filed", x, auth: t.auth, title: titles[0], reminders: planned, remindersSet,
      encrypted, now, tzOffsetMin: tz });
  await sendPush(row, uid, msg, { kind: "mail_filed", mailId: row.id, documentId: docIds[0] || "" }, "filed", now);
  return { state: "filed", documentIds: docIds, reminderIds };
}

/** Files the planned reminders once (reminders_done). */
async function remindFrom(uid, rowId, x, title, now = Date.now()) {
  const u = await db.one(`SELECT tz_offset_min FROM users WHERE id=$1`, [uid]);
  const tz = require("../services/tz").offsetOr(u && u.tz_offset_min);
  const planned = plan.planReminders(x, { now, tzOffsetMin: tz, title });
  const reminders = require("../reminders/store");
  const ids = [];
  const made = [];
  for (const p of planned) {
    // Always notify, never a call: filing on the user's behalf must not ring.
    const r = await reminders.create(uid, p.text, p.atMs, "gentle").catch(() => null);
    if (r) { ids.push(Number(r.id)); made.push({ id: Number(r.id), text: r.text, atMs: Number(r.due_at) }); }
  }
  await store.patch(rowId, { reminder_ids: ids, reminders_done: 1 });
  return { ids, planned, made };
}

/** Erased while filing: take back what was just made. */
async function undo(row, uid, docIds, reminderIds) {
  for (const id of docIds) await docs.deleteDocument(uid, id).catch(() => {});
  const reminders = require("../reminders/store");
  for (const id of reminderIds) await reminders.remove(uid, id).catch(() => {});
  await dropRaw(row);
  await db.run(`DELETE FROM mail_inbound WHERE id=$1`, [row.id]).catch(() => {});
  if (!(await userExists(uid))) {
    const root = path.join(process.env.DATA_DIR || path.join(__dirname, "..", "..", "data"), "files", String(uid));
    await fs.promises.rm(root, { recursive: true, force: true }).catch(() => {});
  }
  return { state: "erased" };
}

module.exports = {
  processInbound, remindFrom, pickParts, sniffType, imageDims, imageTooLarge, safeFilename,
  isEncryptedPdf, bodyText, looksLikeOtp, renderBodyPdf, detectForwardConfirm,
};
