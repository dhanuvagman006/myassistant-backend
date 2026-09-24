/**
 * DOCUMENT EXPIRY ALERTS.
 *
 * A scanned insurance policy, driving licence, passport, vehicle PUC or
 * warranty carries the one date that matters later: when it runs out. The
 * analyser reads it (docs/analyze.js `expires_on`); this files renewal
 * reminders 30 days, 7 days and on the day — at 10 am the user's time —
 * once per document, so nobody discovers a lapsed policy at a toll plaza.
 *
 * Owner's pick, 2026-09-23 ("Document expiry alerts").
 */
const db = require("../db");
const reminders = require("../reminders/store");
const { offsetOr } = require("../services/tz");

const DAY = 864e5;
const LEADS = [30, 7, 0]; // days before expiry
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** yyyy-mm-dd, or "" — never a date that is not one. */
function cleanDate(v) {
  const s = String(v || "").trim().slice(0, 10);
  if (!ISO.test(s)) return "";
  const t = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(t) ? s : "";
}

/** 10:00 local time on `iso` minus `lead` days, as epoch ms. */
function alertAt(iso, lead, tzOffsetMin) {
  const midnightUtc = Date.parse(iso + "T00:00:00Z") - lead * DAY;
  return midnightUtc + 10 * 3600e3 - tzOffsetMin * 60e3;
}

function pretty(iso) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

function textFor(title, iso, lead) {
  if (lead === 0) return `${title} expires today — renew it`;
  if (lead === 7) return `${title} expires in a week (${pretty(iso)}) — renew it now`;
  return `${title} expires on ${pretty(iso)} — time to renew`;
}

/**
 * Records the expiry date and files the renewal reminders, once.
 * @returns number of reminders filed
 */
async function onExpiry(userId, docId, expiresOn, now = Date.now()) {
  const iso = cleanDate(expiresOn);
  if (!iso) return 0;
  const doc = await db.one(
    `SELECT d.id, d.title, d.expiry_alerts, u.tz_offset_min
       FROM documents d JOIN users u ON u.id = d.user_id
      WHERE d.id=$1 AND d.user_id=$2`,
    [docId, userId]
  );
  if (!doc) return 0;
  await db.run(`UPDATE documents SET expires_on=$1 WHERE id=$2 AND user_id=$3`,
    [iso, docId, userId]);
  if (doc.expiry_alerts) return 0;

  const tz = offsetOr(doc.tz_offset_min);
  const title = String(doc.title || "Your document").trim();
  let filed = 0;
  for (const lead of LEADS) {
    const at = alertAt(iso, lead, tz);
    if (at <= now + 60e3) continue; // that moment has passed
    const made = await reminders.create(userId, textFor(title, iso, lead), at, "gentle")
      .catch(() => null);
    if (made) filed++;
  }
  // Marked even when every moment has passed (an already-lapsed ID): the
  // decision is made once, not re-made on every re-analysis.
  await db.run(`UPDATE documents SET expiry_alerts=1 WHERE id=$1 AND user_id=$2`,
    [docId, userId]);
  return filed;
}

/** Documents with a known expiry, soonest first; `withinDays` narrows. */
async function listExpiring(userId, { withinDays = null, now = Date.now() } = {}) {
  const rows = await db.query(
    `SELECT id, title, category, expires_on FROM documents
      WHERE user_id=$1 AND expires_on <> ''
      ORDER BY expires_on ASC LIMIT 50`,
    [userId]
  );
  const today = new Date(now).toISOString().slice(0, 10);
  return rows
    .map((r) => {
      const days = Math.round(
        (Date.parse(r.expires_on + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / DAY);
      return { id: r.id, title: r.title, category: r.category,
        expiresOn: r.expires_on, daysLeft: days, expired: days < 0 };
    })
    .filter((r) => withinDays == null || r.daysLeft <= withinDays);
}

module.exports = { onExpiry, listExpiring, cleanDate, alertAt, textFor, LEADS };
