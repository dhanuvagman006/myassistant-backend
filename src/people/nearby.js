/**
 * PEOPLE NEARBY WHO SHARE WHAT THEY DO.
 *
 * The owner, 2026-10-01: "the user can share his profession, and enable
 * whether he wants to share it or not. If I say 'find me the nearby
 * lawyers' it should show the lawyers near my locality — any profession."
 *
 * What is kept, and only while the switch is on: the profession the
 * user typed, and a COARSE position (two decimals, about a kilometre)
 * with the area's name. Nobody's exact location or phone number is shown
 * to anyone: a result is name, profession, area and distance, and the
 * way to reach them is a message through their own assistant
 * (contact()), which they can mute like any other.
 */
const { query, one, run } = require("../db");

const COARSE = 2; // decimals kept: 0.01° ≈ 1.1 km
const DEFAULT_RADIUS_KM = 15;

/** A profession, and the other words people use for it. */
const SYNONYMS = {
  lawyer: ["advocate", "attorney", "vakil", "legal", "solicitor", "notary"],
  doctor: ["physician", "dr", "medical", "mbbs", "md", "general physician", "gp"],
  dentist: ["dental", "orthodontist"],
  "chartered accountant": ["ca", "accountant", "auditor", "tax consultant", "tax", "gst"],
  electrician: ["electrical", "wiring"],
  plumber: ["plumbing", "pipe"],
  carpenter: ["carpentry", "furniture", "woodwork"],
  teacher: ["tutor", "tuition", "lecturer", "professor", "faculty", "coaching"],
  "software engineer": ["developer", "programmer", "software", "coder", "it", "app developer", "web developer"],
  engineer: ["engineering"],
  architect: ["architecture"],
  nurse: ["nursing"],
  driver: ["cab", "taxi", "chauffeur"],
  photographer: ["photography", "videographer", "video"],
  "real estate agent": ["real estate", "broker", "realtor", "property", "property dealer"],
  tailor: ["tailoring", "stitching", "boutique"],
  mechanic: ["garage", "bike mechanic", "car mechanic"],
  painter: ["painting"],
  cook: ["chef", "caterer", "catering"],
  "yoga teacher": ["yoga", "yoga instructor"],
  astrologer: ["astrology", "jyotish"],
  priest: ["pandit", "purohit", "pujari"],
  counsellor: ["psychologist", "therapist", "counselor", "counselling"],
  physiotherapist: ["physio", "physiotherapy"],
  veterinarian: ["vet", "veterinary", "animal doctor"],
  pharmacist: ["pharmacy", "medical shop", "chemist"],
  "insurance agent": ["insurance", "lic agent", "policy"],
  contractor: ["builder", "construction", "civil contractor"],
  "interior designer": ["interior", "interiors"],
  beautician: ["parlour", "parlor", "salon", "makeup", "beauty"],
  designer: ["graphic designer", "ui designer", "design"],
  farmer: ["farming", "agriculture"],
  shopkeeper: ["shop", "store", "kirana", "grocery"],
  "event planner": ["events", "wedding planner", "decorator"],
  "fitness trainer": ["gym", "trainer", "fitness"],
  journalist: ["reporter", "press", "media"],
  "security guard": ["security", "watchman"],
  electronics: ["ac repair", "ac technician", "fridge repair", "tv repair", "technician", "repair"],
};

const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** The canonical names a free-text profession or question maps to. */
function canonical(text) {
  const t = norm(text);
  if (!t) return [];
  const hits = new Set();
  for (const [name, alts] of Object.entries(SYNONYMS)) {
    const words = [name, ...alts];
    if (words.some((w) => w.length >= 2 && new RegExp(`(^|\\s)${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?(\\s|$)`).test(t))) hits.add(name);
  }
  return [...hits];
}

/** Does this person's stated profession answer the question asked? */
function matches(profession, q) {
  const p = norm(profession);
  const t = norm(q);
  if (!p || !t) return false;
  const cp = canonical(p);
  const cq = canonical(t);
  if (cp.length && cq.length && cp.some((c) => cq.includes(c))) return true;
  // No synonym table entry: the words themselves ("drone pilot").
  const pw = p.split(" ").filter((w) => w.length >= 3);
  const tw = t.split(" ").filter((w) => w.length >= 3 && !["near", "nearby", "find", "any", "around", "here", "the", "some", "good", "best", "need", "want", "locality", "area", "please"].includes(w));
  return pw.some((w) => tw.some((x) => x === w || x === w + "s" || w === x + "s"));
}

function coarse(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 10 ** COARSE) / 10 ** COARSE;
}

function distanceKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** What the user chose: their profession and whether to be found. */
async function me(userId) {
  const u = await one(
    `SELECT profession, organisation, profession_shared, geo_label, geo_at FROM users WHERE id=$1`, [Number(userId)]);
  if (!u) return null;
  return {
    profession: u.profession || "",
    organisation: u.organisation || "",
    shared: Number(u.profession_shared) === 1,
    area: u.geo_label || "",
    locatedAt: Number(u.geo_at) || 0,
  };
}

/**
 * Save the profession and the switch. With the switch on and a position
 * given, the coarse position and its area name are kept; with it off,
 * the position is dropped — nothing stays that is not being shared.
 */
async function setProfession(userId, { profession, organisation, shared, lat, lng } = {}) {
  const uid = Number(userId);
  const sets = [];
  const vals = [uid];
  let i = 2;
  if (profession !== undefined) { sets.push(`profession = $${i++}`); vals.push(String(profession || "").trim().slice(0, 80)); }
  if (organisation !== undefined) { sets.push(`organisation = $${i++}`); vals.push(String(organisation || "").trim().slice(0, 120)); }
  if (shared !== undefined) { sets.push(`profession_shared = $${i++}`); vals.push(shared ? 1 : 0); }
  if (sets.length) await run(`UPDATE users SET ${sets.join(", ")} WHERE id = $1`, vals);
  if (shared === false) {
    await run(`UPDATE users SET geo_lat = NULL, geo_lng = NULL, geo_label = '', geo_at = 0 WHERE id = $1`, [uid]);
  } else if (shared === true || shared === undefined) {
    await touchLocation(uid, lat, lng, { force: true });
  }
  return me(uid);
}

const touched = new Map(); // uid -> at
/** Keep the coarse position current while the switch is on; cheap when nothing moved. */
async function touchLocation(userId, lat, lng, { force = false, now = Date.now() } = {}) {
  const uid = Number(userId);
  const la = coarse(lat);
  const ln = coarse(lng);
  if (la === null || ln === null || Math.abs(la) > 90 || Math.abs(ln) > 180 || (la === 0 && ln === 0)) return false;
  if (!force && now - (touched.get(uid) || 0) < 30 * 60_000) return false;
  const u = await one(`SELECT profession_shared, geo_lat, geo_lng, geo_at FROM users WHERE id=$1`, [uid]);
  if (!u || Number(u.profession_shared) !== 1) return false;
  touched.set(uid, now);
  const moved = u.geo_lat === null || u.geo_lng === null || distanceKm(Number(u.geo_lat), Number(u.geo_lng), la, ln) >= 0.9;
  const stale = now - Number(u.geo_at || 0) > 6 * 3600_000;
  if (!force && !moved && !stale) return false;
  let label = "";
  try {
    const w = await require("../users/whereNow").whereNow(la, ln);
    label = (w && w.label) || "";
  } catch (_) { /* the area name is a nicety */ }
  await run(`UPDATE users SET geo_lat=$2, geo_lng=$3, geo_label=$4, geo_at=$5 WHERE id=$1`, [uid, la, ln, label.slice(0, 120), now]);
  return true;
}

const recent = new Map(); // uid -> [{ id, name, phone_number, fcm_token, profession }]

/** Who nearby does this, sorted by distance. The asker is never listed. */
async function search({ q, lat, lng, radiusKm = DEFAULT_RADIUS_KM, excludeUserId, limit = 20 } = {}) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return [];
  const want = String(q || "").trim();
  if (!want) return [];
  const r = Math.min(Math.max(Number(radiusKm) || DEFAULT_RADIUS_KM, 1), 100);
  const rows = await query(
    `SELECT id, name, profession, organisation, geo_lat, geo_lng, geo_label, phone_number, fcm_token
       FROM users
      WHERE profession_shared = 1 AND geo_lat IS NOT NULL AND geo_lng IS NOT NULL
        AND COALESCE(status, 'active') = 'active' AND id <> $1
        AND geo_lat BETWEEN $2 AND $3 AND geo_lng BETWEEN $4 AND $5`,
    [Number(excludeUserId) || 0, la - r / 110, la + r / 110, ln - r / (110 * Math.max(Math.cos((la * Math.PI) / 180), 0.2)), ln + r / (110 * Math.max(Math.cos((la * Math.PI) / 180), 0.2))]);
  const out = [];
  for (const u of rows) {
    if (!matches(u.profession, want)) continue;
    const d = distanceKm(la, ln, Number(u.geo_lat), Number(u.geo_lng));
    if (d > r) continue;
    out.push({
      id: Number(u.id), name: String(u.name || "").trim() || "Someone",
      profession: String(u.profession || ""), organisation: String(u.organisation || ""),
      area: String(u.geo_label || ""), distanceKm: Math.round(d * 10) / 10,
      _phone: u.phone_number || "", _fcm: u.fcm_token || "",
    });
  }
  out.sort((a, b) => a.distanceKm - b.distanceKm);
  const top = out.slice(0, Math.min(Math.max(Number(limit) || 20, 1), 50));
  if (excludeUserId) recent.set(Number(excludeUserId), top.map((p) => ({ id: p.id, name: p.name, phone_number: p._phone, fcm_token: p._fcm, profession: p.profession })));
  return top.map(({ _phone, _fcm, ...p }) => p);
}

/** A person from the asker's last Nearby search whose name matches ("message Ravi"). */
function recentMatch(userId, name) {
  const list = recent.get(Number(userId)) || [];
  const n = norm(name);
  if (!n) return null;
  const hit = list.find((p) => norm(p.name) === n) || list.find((p) => norm(p.name).split(" ")[0] === n.split(" ")[0]);
  return hit && hit.phone_number ? hit : null;
}

/**
 * A message to someone found nearby, delivered the way every assistant
 * message is: into their agent_messages and a push, read out by THEIR
 * assistant when they open the app. Muting works as for anyone else.
 */
async function contact(fromUserId, toUserId, text) {
  const from = Number(fromUserId);
  const to = Number(toUserId);
  const msg = String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!(from > 0) || !(to > 0) || from === to || !msg) return { ok: false, error: "bad request" };
  const them = await one(`SELECT id, name, phone_number, fcm_token, profession_shared FROM users WHERE id=$1`, [to]);
  if (!them || Number(them.profession_shared) !== 1) return { ok: false, error: "not reachable" };
  const sender = await one(`SELECT name, profession FROM users WHERE id=$1`, [from]);
  const who = `${String(sender?.name || "Someone").trim()}${sender?.profession ? ` (${sender.profession})` : ""}`;
  await run(
    `INSERT INTO agent_messages (from_user_id, to_phone_number, message, created_at) VALUES ($1, $2, $3, $4)`,
    [from, them.phone_number || "", `Via Nearby — ${who}: ${msg}`, Date.now()]);
  let muted = false;
  try { muted = await require("../routes/chat").mutedBy(to, from); } catch (_) { /* not muted */ }
  if (them.fcm_token && !muted) {
    await require("../services/push").sendNotification(
      them.fcm_token, `${who} found you on Nearby`,
      "Open the app and your assistant will read the message to you.", { kind: "agent_message" }).catch(() => {});
  }
  return { ok: true };
}

module.exports = { search, me, setProfession, touchLocation, contact, recentMatch, matches, canonical, coarse, distanceKm, SYNONYMS, _recent: recent, _touched: touched };
