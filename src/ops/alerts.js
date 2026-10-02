/**
 * THINGS THAT STOP A FEATURE QUIETLY, REPORTED TO THE DEVELOPER'S INBOX.
 *
 * 2026-10-01: the Bolna wallet was at $6 and nobody knew; Gemini's image
 * model was out of quota and Style Studio told the client "your photo was
 * unclear". Each of those now lands in developer_feedback as an ops alert
 * (feedback/store.alert, from "server", once per window), so the inbox the
 * developer opens every session shows the money and quota problems before
 * the client finds them.
 */
const DAY = 24 * 3600 * 1000;
const BALANCE_EVERY_MS = 6 * 3600 * 1000;

let lastBalanceCheck = 0;

/** Bolna's wallet, read off the account; alert when it is below the floor. */
async function checkBolnaBalance({ now = Date.now(), fetchImpl = fetch } = {}) {
  const key = process.env.BOLNA_API_KEY;
  if (!key) return null;
  const floor = Number(process.env.BOLNA_LOW_BALANCE_USD || 10);
  let j;
  try {
    const r = await fetchImpl("https://api.bolna.ai/user/me", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    j = await r.json();
  } catch (_) {
    return null;
  }
  const wallet = Number(j?.wallet);
  if (!Number.isFinite(wallet)) return null;
  if (wallet < floor) {
    // One summary for the day whatever the exact figure (alert() dedupes on it).
    await require("../feedback/store").alert(
      `Calling balance is low on Bolna (under $${floor}) — top up or the assistant's calls stop`,
      { details: `wallet $${wallet.toFixed(2)}; concurrency ${JSON.stringify(j?.concurrency || {})}`, windowMs: DAY },
    ).catch(() => {});
    return { wallet, low: true };
  }
  return { wallet, low: false };
}

/** Called by the picture modules when the image model answers 429: once a day is enough. */
async function imageQuota(note) {
  await require("../feedback/store").alert(
    "Pictures are off: the image model is out of quota (429) — top up or raise the limit on the OpenAI key",
    { details: String(note || "").slice(0, 300), windowMs: DAY },
  ).catch(() => {});
}

/** Run from the proactive sweep; the balance is read at most every six hours. */
async function sweep({ now = Date.now() } = {}) {
  if (now - lastBalanceCheck < BALANCE_EVERY_MS) return 0;
  lastBalanceCheck = now;
  const b = await checkBolnaBalance({ now });
  return b && b.low ? 1 : 0;
}

module.exports = { checkBolnaBalance, imageQuota, sweep, _reset() { lastBalanceCheck = 0; } };
