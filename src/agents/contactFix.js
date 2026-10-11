/**
 * THE NAME AS HEARD → THE NAME AS SAVED (2026-10-11).
 *
 * The owner, after a night of failed calls: "it should fix any typo
 * mistakes even when it hears". Speech recognition writes "Ashratha Rao",
 * "ashelatha rao", "Jayant Karle" for contacts saved as "Ashalatha Rao"
 * and "Jayantha Karle"; the phone then looks for a name that does not
 * exist, or asks "did you mean…" for a name it should simply have known.
 *
 * best(userId, spoken) compares the spoken name with the user's synced
 * contacts by SOUND, not spelling (th/t, sh/s, w/v, doubled letters, a
 * trailing "a"), and returns the saved name only when one contact is
 * clearly the closest. Two close candidates → null: the phone's own
 * "which one?" question is the right answer then, never a guess.
 */
const { query } = require("../db");

const MIN_SCORE = 0.88;
const MARGIN = 0.04;

/** A name reduced to how it sounds, per word. */
function sound(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/th/g, "t").replace(/dh/g, "d").replace(/bh/g, "b").replace(/ph/g, "f")
    .replace(/sh/g, "s").replace(/kh/g, "k").replace(/gh/g, "g").replace(/ch/g, "c")
    .replace(/w/g, "v").replace(/z/g, "j").replace(/ee/g, "i").replace(/oo/g, "u")
    .replace(/(.)\1+/g, "$1")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 ? w.replace(/a$/, "") : w));
}

/** Jaro-Winkler similarity, 0..1. */
function jw(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false);
  const bm = new Array(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; m++; break; }
    }
  }
  if (!m) return 0;
  let t = 0;
  for (let i = 0, k = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const j = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let p = 0;
  while (p < 4 && a[p] === b[p]) p++;
  return j + p * 0.1 * (1 - j);
}

/**
 * How alike a spoken name and a saved one sound, 0..1. Every spoken word
 * must find its partner among the saved name's words ("jayatha mawa" →
 * "Jayantha Mava", never "Jayatha", which has no "mava"); the run-together
 * form counts only when both are about the same length ("Asha Lata
 * Harav" → "Ashalatha Rao").
 */
function score(spoken, saved) {
  const a = sound(spoken), b = sound(saved);
  if (!a.length || !b.length) return 0;
  const words = a.reduce((s, w) => s + Math.max(...b.map((x) => jw(w, x))), 0) / a.length;
  const ca = a.join(""), cb = b.join("");
  const close = Math.min(ca.length, cb.length) / Math.max(ca.length, cb.length) >= 0.8;
  return Math.max(words, close ? jw(ca, cb) : 0);
}

/** Only Latin-script names are compared; others go to the phone as said. */
const LATIN = /^[\p{Script=Latin}\p{N}\s.'&-]+$/u;

/**
 * The saved contact the user meant → { name, phone, score, corrected } |
 * null (no confident single match, or the name is already exact).
 */
async function best(userId, spoken, { rows = null } = {}) {
  const said = String(spoken || "").trim();
  if (!userId || !said || said.length > 60 || !LATIN.test(said)) return null;
  let list = rows;
  if (!list) {
    list = await query(
      `SELECT name, phone FROM contacts WHERE user_id = $1 AND name <> '' LIMIT 3000`,
      [userId]
    ).catch(() => []);
  }
  if (!list.length) return null;
  if (list.some((r) => String(r.name).trim().toLowerCase() === said.toLowerCase())) return null;
  const scored = list
    .map((r) => ({ name: String(r.name).trim(), phone: r.phone, score: score(said, r.name) }))
    .sort((x, y) => y.score - x.score);
  const top = scored[0];
  if (!top || top.score < MIN_SCORE) return null;
  // A close second that is a DIFFERENT person: let the phone ask.
  const rival = scored.find((r, i) => i > 0 && r.phone !== top.phone);
  if (rival && top.score - rival.score < MARGIN) return null;
  return { name: top.name, phone: top.phone, score: Number(top.score.toFixed(3)), corrected: true };
}

module.exports = { best, score, sound, jw };
