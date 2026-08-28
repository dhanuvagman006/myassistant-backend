/**
 * Phone numbers, in exactly one shape: E.164 (+919876543210).
 *
 * Every phone number that reaches the database MUST pass through here.
 * Agent-to-agent delivery is an exact-string lookup — "does this contact's
 * number belong to a registered user?" — so a number stored as typed is a
 * message that silently never arrives. The same person is written
 * "+91 98765 43210" in one phone's address book, "098765 43210" in another
 * and "9876543210" by the user signing up; all three are one account here.
 *
 * DEFAULT_REGION exists because a bare "9876543210" carries no country. It
 * is only consulted for numbers that have no + prefix; anything already in
 * international form is parsed as written, so users abroad are unaffected.
 */
const { parsePhoneNumberFromString } = require("libphonenumber-js");

const DEFAULT_REGION = () => process.env.DEFAULT_PHONE_REGION || "IN";

/**
 * → E.164 string, or null when the input is not a valid dialable number.
 * Null is a real answer, not an error: callers store null rather than a
 * malformed number, so a bad value can never occupy a real one's slot.
 */
function normalizePhone(input, region) {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  try {
    const parsed = parsePhoneNumberFromString(raw, region || DEFAULT_REGION());
    return parsed && parsed.isValid() ? parsed.number : null;
  } catch (_) {
    return null;
  }
}

/// True when two numbers reach the same handset, whatever their formatting.
const samePhone = (a, b) => {
  const x = normalizePhone(a);
  return x != null && x === normalizePhone(b);
};

module.exports = { normalizePhone, samePhone, DEFAULT_REGION };
