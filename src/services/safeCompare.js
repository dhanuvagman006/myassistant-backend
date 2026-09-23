/**
 * Constant-time string equality for secrets (admin keys, webhook
 * signatures). `a === b` returns at the first differing byte, which leaks
 * how much of a guess was right. Both sides are hashed first so unequal
 * lengths neither throw (timingSafeEqual requires equal lengths) nor leak
 * the length.
 */
const crypto = require("crypto");

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { safeEqual };
