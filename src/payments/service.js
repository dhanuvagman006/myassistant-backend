/**
 * PAYMENT COLLECTION — the assistant starts making the user money.
 *
 *   "Collect fifteen thousand from Ravi for the consultation."
 *
 * Hari creates a real payment link, hands it to the user to send on
 * WhatsApp, and tells them the moment it is paid.
 *
 * DIRECTION MATTERS, AND IT IS ONE-WAY.
 * This module only ever creates a request for money to come TO the user.
 * It cannot send, transfer, refund or withdraw anything, and there is
 * deliberately no code path that could: an assistant that can move money
 * out of an account is a category of risk this product does not need to
 * take, and "collect what I'm owed" is where the value is for a doctor,
 * lawyer or consultant anyway.
 *
 * PROVIDER: Razorpay Payment Links. Test-mode keys work end to end, which
 * is what makes this demonstrable without a live merchant account.
 * Unconfigured, the tool says so rather than inventing a link.
 */
const crypto = require("crypto");
const { query, one, run } = require("../db");

const API = "https://api.razorpay.com/v1";
const TIMEOUT_MS = 12_000;

function cfg() {
  return {
    keyId: process.env.RAZORPAY_KEY_ID || "",
    keySecret: process.env.RAZORPAY_KEY_SECRET || "",
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "",
  };
}

function enabled() {
  const c = cfg();
  return Boolean(c.keyId && c.keySecret);
}

/* ------------------------------------------------------------------ */

async function migrate(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS payment_requests (
      id          BIGSERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      -- Razorpay's own id (plink_…). The webhook arrives keyed by this.
      provider_id TEXT UNIQUE,
      provider    TEXT NOT NULL DEFAULT 'razorpay',
      -- Stored in PAISE, never rupees. Money in a float is a bug waiting
      -- to be found in production.
      amount_paise BIGINT NOT NULL,
      currency    TEXT NOT NULL DEFAULT 'INR',
      payer_name  TEXT NOT NULL DEFAULT '',
      payer_phone TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      short_url   TEXT NOT NULL DEFAULT '',
      -- created | sent | paid | cancelled | expired
      status      TEXT NOT NULL DEFAULT 'created',
      paid_at     BIGINT,
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payments_user
      ON payment_requests(user_id, status, id DESC);
  `);
}

/* ------------------------------------------------------------------ *
 * CREATING
 * ------------------------------------------------------------------ */

function authHeader() {
  const c = cfg();
  return "Basic " + Buffer.from(`${c.keyId}:${c.keySecret}`).toString("base64");
}

/**
 * Creates a payment link and records it.
 *
 * @param {{userId, amountRupees, payerName, payerPhone, description, userName}} p
 * @returns {{ok:true, id, url, amountRupees}|{ok:false, error:string}}
 */
async function createRequest({ userId, amountRupees, payerName, payerPhone, description, userName }) {
  if (!enabled()) {
    return {
      ok: false,
      error: "payment collection isn't configured on this server (no Razorpay keys)",
    };
  }
  const rupees = Number(amountRupees);
  if (!Number.isFinite(rupees) || rupees <= 0) {
    return { ok: false, error: "I need a valid amount" };
  }
  // Round to paise explicitly rather than letting a float decide.
  const paise = Math.round(rupees * 100);
  if (paise < 100) return { ok: false, error: "the minimum is ₹1" };

  const now = Date.now();
  let link;
  try {
    const res = await fetch(`${API}/payment_links`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader() },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        amount: paise,
        currency: "INR",
        description: String(description || "Payment").slice(0, 200),
        customer: {
          name: String(payerName || "").slice(0, 100) || undefined,
          contact: payerPhone || undefined,
        },
        // We send the link ourselves over WhatsApp, so Razorpay must not
        // also SMS and email the customer — one request, not three.
        notify: { sms: false, email: false },
        reminder_enable: true,
        notes: { collected_by: String(userName || ""), user_id: String(userId) },
      }),
    });
    const j = await res.json();
    if (!res.ok) {
      return {
        ok: false,
        error: `Razorpay rejected it: ${j?.error?.description || res.status}`,
      };
    }
    link = j;
  } catch (e) {
    return { ok: false, error: `couldn't reach Razorpay (${String(e.message).slice(0, 80)})` };
  }

  const row = await one(
    `INSERT INTO payment_requests
       (user_id, provider_id, provider, amount_paise, currency, payer_name,
        payer_phone, description, short_url, status, created_at, updated_at)
     VALUES ($1,$2,'razorpay',$3,'INR',$4,$5,$6,$7,'created',$8,$8)
     RETURNING id`,
    [
      userId, link.id, paise, String(payerName || ""), String(payerPhone || ""),
      String(description || ""), link.short_url || "", now,
    ]
  );

  return {
    ok: true,
    id: Number(row.id),
    providerId: link.id,
    url: link.short_url,
    amountRupees: rupees,
  };
}

/* ------------------------------------------------------------------ *
 * THE WEBHOOK — how we know it was paid
 * ------------------------------------------------------------------ */

/**
 * Verifies Razorpay's HMAC over the RAW request body.
 *
 * Timing-safe, and it refuses outright when no secret is configured: an
 * unverified webhook could mark any invoice paid, which is a far worse
 * failure than a missed notification.
 */
function verifySignature(rawBody, signature) {
  const secret = cfg().webhookSecret;
  if (!secret || !rawBody || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Applies a verified webhook. Returns the affected row, or null. */
async function applyWebhook(event) {
  const entity =
    event?.payload?.payment_link?.entity || event?.payload?.payment?.entity || null;
  const providerId = entity?.id || event?.payload?.payment_link?.entity?.id;
  if (!providerId) return null;

  const status =
    event.event === "payment_link.paid" || entity?.status === "paid"
      ? "paid"
      : event.event === "payment_link.cancelled"
        ? "cancelled"
        : event.event === "payment_link.expired"
          ? "expired"
          : null;
  if (!status) return null;

  const row = await one(
    `UPDATE payment_requests
        SET status=$2, paid_at=CASE WHEN $2='paid' THEN $3 ELSE paid_at END, updated_at=$3
      WHERE provider_id=$1 AND status <> $2
      RETURNING *`,
    [providerId, status, Date.now()]
  ).catch(() => null);
  return row;
}

/** Tells the user their money arrived. */
async function notifyPaid(row) {
  if (!row || row.status !== "paid") return;
  try {
    const u = await one(`SELECT fcm_token FROM users WHERE id=$1`, [row.user_id]);
    if (!u?.fcm_token) return;
    const rupees = (Number(row.amount_paise) / 100).toLocaleString("en-IN");
    await require("../services/push").sendNotification(
      u.fcm_token,
      `₹${rupees} received`,
      `${row.payer_name || "Someone"} paid${row.description ? ` for ${row.description}` : ""}.`
    );
  } catch (_) {}
}

/* ------------------------------------------------------------------ */

async function list(userId, { status = null, limit = 20 } = {}) {
  return query(
    `SELECT * FROM payment_requests
      WHERE user_id=$1 ${status ? "AND status=$3" : ""}
      ORDER BY id DESC LIMIT $2`,
    status ? [userId, limit, status] : [userId, limit]
  );
}

async function markSent(id) {
  await run(
    `UPDATE payment_requests SET status='sent', updated_at=$2
      WHERE id=$1 AND status='created'`,
    [id, Date.now()]
  ).catch(() => {});
}

module.exports = {
  migrate, enabled, createRequest, verifySignature, applyWebhook,
  notifyPaid, list, markSent, cfg,
};
