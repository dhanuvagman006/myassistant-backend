/**
 * BILLS BY EMAIL — who really sent it (spec §5.3 step 2).
 *
 *   you         DMARC passes AND the From is the user's own address
 *               (users.email, their connected mailbox) or one they marked
 *               "This was me".
 *   verified    DMARC passes AND the From domain is not a public mailbox
 *               provider: the biller's own signature, surviving a forward.
 *   personal    DMARC passes on a free mailbox we do not know. Anyone can
 *               open one, so this is NOT trusted — it is the usual shape of
 *               a bill forwarded by hand, hence the "This was me" button.
 *   unverified  anything else, including any lookup error or timeout.
 *
 * Only `you` and `verified` get automatic reminders.
 */
const db = require("../db");
const { authenticate } = require("./dkim");

const PUBLIC_MAILBOX_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "ymail.com", "outlook.com",
  "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "rediffmail.com", "zoho.com",
  "zohomail.in", "proton.me", "protonmail.com", "aol.com", "gmx.com",
]);

/** The user's own sending addresses we already know, lowercased. */
async function ownAddresses(userId) {
  const out = new Set();
  const u = await db.one(`SELECT email FROM users WHERE id=$1`, [userId]).catch(() => null);
  if (u && u.email) out.add(String(u.email).toLowerCase());
  // The mail connection's table is created lazily; it may not exist.
  const acct = await db.one(`SELECT address FROM email_accounts WHERE user_id=$1`, [userId]).catch(() => null);
  if (acct && acct.address) out.add(String(acct.address).toLowerCase());
  return [...out];
}

async function classifySender(raw, { trustedFrom = [], ownAddresses: own = [], resolveTxt, now } = {}) {
  let a;
  try {
    a = await authenticate(raw, { ...(resolveTxt ? { resolveTxt } : {}), ...(now ? { now } : {}) });
  } catch (_) {
    return { auth: "unverified", fromAddr: "", fromDomain: "" };
  }
  const fromAddr = String(a.fromAddr || "").slice(0, 200);
  const fromDomain = String(a.fromDomain || "").slice(0, 120);
  if (a.dmarc !== "pass") return { auth: "unverified", fromAddr, fromDomain };
  const mine = new Set([...own, ...trustedFrom].map((x) => String(x).toLowerCase()));
  if (mine.has(fromAddr)) return { auth: "you", fromAddr, fromDomain };
  if (PUBLIC_MAILBOX_DOMAINS.has(fromDomain)) return { auth: "personal", fromAddr, fromDomain };
  return { auth: "verified", fromAddr, fromDomain };
}

module.exports = { classifySender, ownAddresses, PUBLIC_MAILBOX_DOMAINS };
