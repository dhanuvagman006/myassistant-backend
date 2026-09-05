/**
 * USER CONTEXT (§3, §4, §13, §14) — who the user is, who the assistant is,
 * and the user's standing rules. This is what makes the agent decide with
 * judgment instead of executing blindly: every turn's system prompt is
 * assembled from here, so preferences and rules sit IN FRONT of tool
 * selection, not bolted on after.
 *
 * Three stores:
 *   users               widened profile (profession, organisation,
 *                       location, preferred_language, timezone)
 *   assistant_profiles  the assistant's own identity per user
 *                       (name — e.g. "Maya" — gender, voice, style)
 *   user_instructions   standing rules ("always ask before sending
 *                       messages", "call me Dhanu"), soft-deletable
 *
 * Conversational onboarding: extractProfile() turns "I'm Dhanush, I live
 * in Mangalore, I'm a software engineer" into structured fields via one
 * structured-output model call. Extraction NEVER overwrites a field the
 * user set explicitly with a lower-confidence guess — it only fills gaps.
 */
const { query, one, run } = require("../db");

async function migrate(exec) {
  await exec(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profession        TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS organisation      TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS location          TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone          TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token         TEXT NOT NULL DEFAULT '';
    -- Nullable on purpose: NULL means "no verified number". A NOT NULL
    -- default of '' would put every unverified account on one shared value,
    -- which the uniqueness index in db.js could not tell apart from a real
    -- collision.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number      TEXT;

    CREATE TABLE IF NOT EXISTS assistant_profiles (
      user_id    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL DEFAULT 'Assistant',
      gender     TEXT NOT NULL DEFAULT '',      -- female|male|neutral|'' (auto)
      voice      TEXT NOT NULL DEFAULT '',      -- TTS voice override
      style      TEXT NOT NULL DEFAULT '',      -- concise|friendly|formal|''
      updated_at BIGINT NOT NULL
    );
    -- Video-avatar face chosen in Settings; '' = the deployment default.
    ALTER TABLE assistant_profiles ADD COLUMN IF NOT EXISTS avatar_id TEXT NOT NULL DEFAULT '';

    CREATE TABLE IF NOT EXISTS user_instructions (
      id          BIGSERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      instruction TEXT NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  BIGINT NOT NULL,
      deactivated_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_instructions_user
      ON user_instructions(user_id, active, id);
  `);
}

const uidOk = (u) => Number.isFinite(Number(u)) && Number(u) > 0;

/* ---------------- profile ---------------- */

/// Fields the app may write directly through PUT /profile/details.
///
/// phone_number is deliberately NOT here. It is the address other people's
/// agents deliver to, so it may only be set by POST /phone/verify, which
/// reads it out of a verified Firebase OTP token. Leaving it writable here
/// would let any signed-in client claim any number — including one already
/// belonging to somebody else — and quietly receive that person's messages.
const PROFILE_FIELDS = ["profession", "organisation", "location", "preferred_language", "timezone", "birthday", "fcm_token"];

async function getProfile(userId) {
  if (!uidOk(userId)) throw new Error("authenticated userId required");
  const u = await one(
    `SELECT id, name, gender, birthday, profession, organisation, location,
            preferred_language, timezone, fcm_token, phone_number FROM users WHERE id=$1`,
    [userId]
  );
  if (!u) return null;
  const a = await one(`SELECT * FROM assistant_profiles WHERE user_id=$1`, [userId]);
  return {
    user: u,
    assistant: a
      ? { name: a.name, gender: a.gender, voice: a.voice, style: a.style,
          avatar_id: a.avatar_id || "" }
      : { name: "Assistant", gender: "", voice: "", style: "", avatar_id: "" },
  };
}

/** Fills ONLY provided fields; empty strings do not blank existing data. */
async function updateProfile(userId, fields = {}) {
  if (!uidOk(userId)) throw new Error("authenticated userId required");
  const sets = [];
  const vals = [userId];
  let i = 2;
  for (const f of PROFILE_FIELDS) {
    const v = String(fields[f] ?? "").trim();
    if (v) {
      sets.push(`${f} = $${i++}`);
      // fcm_token must NEVER be truncated: real FCM tokens are ~142-163
      // chars, and slicing them to 120 stored a plausible-looking prefix
      // that FCM rejects as "not registered" on every send. This one line
      // is why push notifications never worked for ANY user — the console
      // campaign path (no DB) delivered fine while every server send died.
      vals.push(f === "fcm_token" ? v.slice(0, 512) : v.slice(0, 120));
    }
  }
  if (fields.name && String(fields.name).trim()) {
    sets.push(`name = $${i++}`);
    vals.push(String(fields.name).trim().slice(0, 80));
  }
  if (["male", "female", "other"].includes(String(fields.gender || "").toLowerCase())) {
    sets.push(`gender = $${i++}`);
    vals.push(String(fields.gender).toLowerCase());
  }
  if (!sets.length) return getProfile(userId);
  await run(`UPDATE users SET ${sets.join(", ")} WHERE id = $1`, vals);
  return getProfile(userId);
}

async function setAssistantProfile(userId, { name, gender, voice, style, avatar_id } = {}) {
  if (!uidOk(userId)) throw new Error("authenticated userId required");
  // avatar_id: undefined/'' keeps the current face; the literal 'default'
  // clears the choice back to the deployment default.
  const face =
    avatar_id === "default" ? "" : String(avatar_id || "").slice(0, 80);
  const faceKeep = avatar_id === undefined || avatar_id === "";
  await run(
    `INSERT INTO assistant_profiles (user_id,name,gender,voice,style,avatar_id,updated_at)
     VALUES ($1, COALESCE(NULLIF($2,''),'Assistant'), $3, $4, $5, $7, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       name  = COALESCE(NULLIF($2,''), assistant_profiles.name),
       gender= COALESCE(NULLIF($3,''), assistant_profiles.gender),
       -- '' means "keep"; the literal 'default' CLEARS back to automatic.
       voice = CASE WHEN $4 = 'default' THEN ''
                    ELSE COALESCE(NULLIF($4,''), assistant_profiles.voice) END,
       style = CASE WHEN $5 = 'default' THEN ''
                    ELSE COALESCE(NULLIF($5,''), assistant_profiles.style) END,
       avatar_id = CASE WHEN $8 THEN assistant_profiles.avatar_id ELSE $7 END,
       updated_at = $6`,
    [userId, String(name || "").slice(0, 40), String(gender || "").toLowerCase(),
     String(voice || "").slice(0, 40), String(style || "").slice(0, 30), Date.now(),
     face, faceKeep]
  );
  return (await getProfile(userId)).assistant;
}

/* ---------------- standing instructions (§14) ---------------- */

async function addInstruction(userId, text) {
  if (!uidOk(userId)) throw new Error("authenticated userId required");
  const t = String(text || "").trim().slice(0, 300);
  if (!t) throw new Error("instruction text required");
  // Idempotent: re-stating an active rule must not duplicate it.
  const dup = await one(
    `SELECT id FROM user_instructions
      WHERE user_id=$1 AND active=1 AND lower(instruction)=lower($2)`,
    [userId, t]
  );
  if (dup) return dup;
  return one(
    `INSERT INTO user_instructions (user_id,instruction,created_at)
     VALUES ($1,$2,$3) RETURNING *`,
    [userId, t, Date.now()]
  );
}

async function listInstructions(userId) {
  if (!uidOk(userId)) throw new Error("authenticated userId required");
  return query(
    `SELECT id, instruction, created_at FROM user_instructions
      WHERE user_id=$1 AND active=1 ORDER BY id`,
    [userId]
  );
}

/** Soft-deactivates rules matching the text (audit preserved, §19). */
async function removeInstruction(userId, match) {
  if (!uidOk(userId)) throw new Error("authenticated userId required");
  const words = String(match || "").toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return 0;
  const rows = await listInstructions(userId);
  let n = 0;
  for (const r of rows) {
    const low = r.instruction.toLowerCase();
    if (words.some((w) => low.includes(w))) {
      await run(
        `UPDATE user_instructions SET active=0, deactivated_at=$3
          WHERE user_id=$1 AND id=$2`,
        [userId, r.id, Date.now()]
      );
      n++;
    }
  }
  return n;
}

/* ---------------- context block for the runtime (§13) ---------------- */

/**
 * The system-prompt fragment carrying who the user is, who the assistant
 * is, and the standing rules. Returns "" for anonymous sessions.
 */
async function contextBlock(userId) {
  if (!uidOk(userId)) return "";
  const p = await getProfile(userId).catch(() => null);
  if (!p) return "";
  const u = p.user;
  const lines = [];

  const who = [
    u.name && `name: ${u.name}`,
    u.profession && `profession: ${u.profession}`,
    u.organisation && `organisation: ${u.organisation}`,
    u.location && `location: ${u.location}`,
    u.preferred_language && `preferred language: ${u.preferred_language}`,
    u.timezone && `timezone: ${u.timezone}`,
  ].filter(Boolean);
  if (who.length) lines.push(`ABOUT THE USER — ${who.join("; ")}.`);

  const a = p.assistant;
  lines.push(
    `YOUR IDENTITY — your name is ${a.name}.` +
      (a.style ? ` Communication style: ${a.style}.` : "")
  );

  const rules = await listInstructions(userId).catch(() => []);
  if (rules.length) {
    lines.push(
      "THE USER'S STANDING RULES — follow these before deciding on any action:\n" +
        rules.map((r) => `- ${r.instruction}`).join("\n")
    );
  }
  return lines.join("\n");
}

/* ---------------- conversational onboarding (§3) ---------------- */

/**
 * Extracts structured profile fields from free speech/text using one
 * structured-output model call. Applies ONLY non-empty extracted fields
 * and returns what changed, so the UI can confirm honestly.
 */
async function extractProfile(userId, text) {
  if (!uidOk(userId)) throw new Error("authenticated userId required");
  const t = String(text || "").trim();
  if (!t) return { applied: {}, profile: await getProfile(userId) };

  const { callGemini } = require("../services/ai/router");
  const prompt =
    "Extract the speaker's personal details from this introduction. " +
    'Respond ONLY with JSON: {"name":"","gender":"","profession":"",' +
    '"organisation":"","location":"","preferred_language":"","timezone":""}. ' +
    "Use empty strings for anything not stated. gender only if explicitly " +
    "stated (male/female/other). Do not guess.\n\nIntroduction: " + t;

  let fields = {};
  try {
    const out = await callGemini(
      [{ role: "user", content: prompt }],
      "You extract structured data. Respond with ONLY the JSON object, no prose, no markdown."
    );
    const raw = String(out || "{}")
      .replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    fields = JSON.parse(raw);
  } catch (e) {
    // Extraction failing must not fail onboarding — the user can still
    // fill the form. Report honestly that nothing was extracted.
    return { applied: {}, error: "could not understand that, please try the form", profile: await getProfile(userId) };
  }

  const applied = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string" && v.trim()) applied[k] = v.trim();
  }
  const profile = await updateProfile(userId, applied);
  return { applied, profile };
}

module.exports = {
  migrate,
  getProfile,
  updateProfile,
  setAssistantProfile,
  addInstruction,
  listInstructions,
  removeInstruction,
  contextBlock,
  extractProfile,
  PROFILE_FIELDS,
};
