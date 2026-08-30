/**
 * PAYMENT ROUTES.
 *
 * Public (Razorpay calls this — NO app auth, mounted before appAuth):
 *   POST /payments/webhook   -> verified by HMAC over the raw body
 *
 * App-facing (behind appAuth):
 *   GET  /payments           -> the user's collection requests (?status=paid)
 *
 * The webhook is the only unauthenticated write in this module, and it is
 * gated on a signature rather than on obscurity. Without
 * RAZORPAY_WEBHOOK_SECRET it rejects everything: an unverified webhook
 * could mark any invoice paid, and a missed notification is far cheaper
 * than a forged payment.
 */
const express = require("express");
const payments = require("./service");

/* ---------------- PUBLIC WEBHOOK ---------------- */

const webhooks = express.Router();

webhooks.post("/webhook", async (req, res) => {
  const signature = req.get("X-Razorpay-Signature");
  const raw = req.rawBody;

  if (!payments.verifySignature(raw, signature)) {
    // Deliberately terse: do not tell an unauthenticated caller whether the
    // secret is missing, the signature is wrong, or the body was not kept.
    return res.status(400).json({ error: "invalid signature" });
  }

  // Acknowledge FAST. Razorpay retries on a slow or failed response, and a
  // retried webhook applied twice is a duplicate notification; the update
  // itself is idempotent (it only fires on a real status change).
  res.json({ ok: true });

  try {
    const row = await payments.applyWebhook(req.body || {});
    if (row) await payments.notifyPaid(row);
  } catch (e) {
    console.error("payment webhook error:", e.message || e);
  }
});

/* ---------------- APP-FACING ---------------- */

const router = express.Router();

router.get("/", async (req, res) => {
  const u = Number(req.user?.sub);
  if (!Number.isInteger(u) || u <= 0) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const rows = await payments.list(u, {
      status: req.query.status ? String(req.query.status) : null,
      limit: Number(req.query.limit) || 20,
    });
    res.json({
      available: payments.enabled(),
      payments: rows.map((r) => ({
        ...r,
        amount: Number(r.amount_paise) / 100,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: "could not read payments" });
  }
});

module.exports = { router, webhooks };
