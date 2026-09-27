/**
 * SHORTCUT NAMES — how "office mode", "start office mode please" and
 * "ഓഫീസ് മോഡ് ഓൺ ആക്കൂ" all become the same key, which names may never be
 * used, and the per-user cache of names the voice paths read.
 *
 * ONLY A WHOLE-UTTERANCE MATCH COUNTS: "what is office mode?" and "delete
 * office mode" never run it, and neither does a name said as the answer to
 * a question (answerGuard).
 */
const CACHE_MS = 60_000;
const cache = new Map(); // uid -> {at, rows:[{key, said, shortcut_id, is_primary, name}]}

/** Normalised key of a name: case, width, joiners, punctuation, "my … shortcut". */
function nameKey(s) {
  return String(s || "").normalize("NFKC").toLowerCase()
    // ZWSP, ZWNJ, ZWJ and BOM: Malayalam chillu and Devanagari half forms.
    .replace(/[​-‍﻿]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ").trim()
    .replace(/^(?:my|the|a)\s+/, "")
    .replace(/\s+(?:shortcut|routine)$/, "");
}

const LEADING = [
  "hey hari", "hari", "ok", "okay", "please", "turn on", "switch on", "start", "run", "do",
  "activate", "begin", "enable",
];
const TRAILING = [
  "please", "now", "chalu karo", "shuru karo", "on karo", "kar do", "karo", "chalao",
  "चालू करो", "शुरू करो", "ऑन करो", "करो", "चलाओ",
  "ഓൺ ആക്കൂ", "ആക്കൂ", "ചെയ്യൂ", "ചെയ്യുക",
  "ಆನ್ ಮಾಡು", "ಮಾಡು", "ஆன் பண்ணு", "செய்", "ఆన్ చేయి", "చేయి", "on",
].map(nameKey);

/** Strip the words people wrap a name in: "hari start office mode please". */
function stripFillers(text) {
  let k = nameKey(text);
  for (let changed = true; changed;) {
    changed = false;
    for (const w of LEADING) {
      if (k.startsWith(w + " ")) { k = k.slice(w.length + 1); changed = true; }
    }
    for (const w of TRAILING) {
      if (w && k.endsWith(" " + w)) { k = k.slice(0, -(w.length + 1)); changed = true; }
    }
  }
  return nameKey(k);
}

const INDIC = /[ऀ-෿]/;

/**
 * Is this name allowed? Refused: too short/long, too many words, one of
 * the assistant's own commands ("stop", "yes", "news"), the assistant's
 * name, or wholly an app's name.
 */
function checkName(name, { assistantName = "" } = {}) {
  const raw = String(name || "").trim();
  const key = nameKey(raw);
  const letters = (key.match(/\p{L}/gu) || []).length;
  if (raw.length < 2 || raw.length > 40 || letters < 2 || key.split(" ").length > 6) {
    return { ok: false, error: "bad_name", data: { name: raw, min: 2, max: 40 } };
  }
  const reserved = new Set(["hari", "assistant", "shortcut", "shortcuts", nameKey(assistantName)].filter(Boolean));
  let SHORT_OK = new Set();
  try { SHORT_OK = require("../agents/inputQuality").SHORT_OK || new Set(); } catch (_) {}
  let stop = null;
  try { stop = require("../automation/intent").STOP; } catch (_) {}
  const app = (() => {
    try { return require("../automation/prefs").appNamedIn(key); } catch (_) { return null; }
  })();
  if (reserved.has(key) || SHORT_OK.has(key) || (stop && stop.test(key)) ||
      ["news", "weather", "help", "home", "back", "music"].includes(key) ||
      (app && nameKey(app) === key)) {
    return { ok: false, error: "reserved_name", data: { name: raw } };
  }
  return { ok: true, key };
}

async function rowsFor(userId) {
  const uid = Number(userId);
  const hit = cache.get(uid);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  const store = require("./store");
  const rows = await store.namesOf(uid).catch(() => []);
  cache.set(uid, { at: Date.now(), rows });
  return rows;
}

/** Every key this user can say. */
async function keysFor(userId) {
  return (await rowsFor(userId)).map((r) => r.name_key);
}

/** The shortcut a WHOLE utterance names, or null. */
async function exactFor(userId, text) {
  const rows = await rowsFor(userId);
  if (!rows.length) return null;
  const k1 = nameKey(text);
  const k2 = stripFillers(text);
  const hit = rows.find((r) => r.name_key === k1) || rows.find((r) => r.name_key === k2);
  return hit ? { id: Number(hit.shortcut_id), name: hit.name, key: hit.name_key } : null;
}

/** Damerau–Levenshtein (optimal string alignment). */
function distance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

/**
 * The shortcut a spoken name means: exact, then without fillers, then (in
 * Latin script only) same words in any order or a small spelling slip.
 * Returns {ok, id, name} | {ok:false, error:"which_one"|"no_such_shortcut", data}.
 */
async function resolve(userId, spoken) {
  const rows = await rowsFor(userId);
  const exact = await exactFor(userId, spoken);
  if (exact) return { ok: true, ...exact };
  const k = stripFillers(spoken);
  const primaries = [...new Map(rows.filter((r) => r.is_primary).map((r) => [Number(r.shortcut_id), r])).values()];
  if (k && !INDIC.test(k)) {
    const tokens = (s) => [...new Set(s.split(" "))].sort().join(" ");
    const near = new Map();
    for (const r of rows) {
      if (INDIC.test(r.name_key)) continue;
      const tol = Math.max(1, Math.floor(r.name_key.length / 6));
      if (tokens(r.name_key) === tokens(k) || distance(r.name_key, k) <= tol) {
        near.set(Number(r.shortcut_id), r);
      }
    }
    if (near.size === 1) {
      const r = [...near.values()][0];
      return { ok: true, id: Number(r.shortcut_id), name: r.name, key: r.name_key };
    }
    if (near.size > 1) {
      return { ok: false, error: "which_one", data: { candidates: [...near.values()].map((r) => r.name) } };
    }
  }
  return { ok: false, error: "no_such_shortcut", data: { heard: String(spoken || "").slice(0, 60), names: primaries.map((r) => r.name) } };
}

/**
 * Skip the deterministic routes when the assistant just asked a question
 * or a yes/no is pending: "Which shortcut should I delete?" answered with
 * "office mode" must never RUN office mode.
 */
function answerGuard(lastLine, pending = false) {
  if (pending) return true;
  const t = String(lastLine || "").trim();
  if (!t) return false;
  if (/\?\s*["”']?\s*$/.test(t)) return true;
  try {
    const e = require("../agents/inputQuality").expectationsFrom(t);
    return !!(e.expectsName || e.expectsNumber) && t.includes("?");
  } catch (_) {
    return false;
  }
}

/** The prompt lines that tell the model which names are shortcuts. */
async function promptBlock(userId) {
  const store = require("./store");
  const list = await store.list(userId).catch(() => []);
  if (!list.length) return "";
  const parts = [];
  let size = 0;
  for (const s of list.slice(0, 50)) {
    const others = s.other_names.length ? ` (also ${s.other_names.map((n) => `"${n}"`).join(", ")})` : "";
    const summary = s.steps.slice(0, 3).map((st) => st.label.split(":")[0].toLowerCase()).join(", ");
    const line = `"${s.name}"${others} — ${summary.slice(0, 60)}`;
    if (size + line.length > 1400) break;
    size += line.length + 2;
    parts.push(line);
  }
  return "THE USER'S SHORTCUTS — when they say one of these names (in any language, alone or with " +
    "start/run/turn on), call run_shortcut with that name at once; never ask what it means: " +
    parts.join("; ");
}

function invalidate(userId) {
  cache.delete(Number(userId));
}
const forgetUser = invalidate;

module.exports = {
  nameKey, stripFillers, checkName, keysFor, exactFor, resolve, answerGuard,
  promptBlock, invalidate, forgetUser, distance,
};
