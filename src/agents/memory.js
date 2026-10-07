/**
 * PER-USER MEMORY — what makes the conversational agent PERSONAL.
 *
 * Durable facts learned from conversation ("her name is Dhanya", "lives
 * in Mysuru", "vegetarian", "prefers Kannada", "exam on the 20th") are
 * stored per user and injected into EVERY agent's system prompt — the
 * voice loop, the chat screen and the D-ID photoreal face all remember
 * the same person.
 *
 * Extraction runs AFTER the reply has already been sent (fire-and-
 * forget), and only when the message looks self-descriptive — so
 * remembering costs the user zero latency and near-zero extra tokens.
 *
 * Table: agent_memories (created in db.js init()).
 */
const { query, one, run } = require("../db");
const { generateReply } = require("../services/ai/router");

// Per user; the least important (then oldest) evicted past the cap. 150,
// not 60: goals and preferences joined the facts (2026-10-07), and only
// the relevant ~15 plus goals/preferences ever reach a prompt.
const MAX_MEMORIES = 150;

/** What a remembered line is. 'semantic' = an ordinary fact (the default
 *  every older row carries). */
const KINDS = new Set(["goal", "preference", "semantic"]);
const cleanKind = (k) => {
  const v = String(k || "").trim().toLowerCase();
  return KINDS.has(v) ? v : "semantic";
};

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

/** All memories for a user, most important + newest first. */
async function listMemories(userId) {
  if (!userId) return [];
  // valid=1 matters: a corrected fact is superseded by setting valid=0
  // (forget_memory deletes outright since 2026-09-27), and without the
  // filter it kept coming back here — in recall_memory and in every
  // system prompt via memoryBlock below.
  return query(
    `SELECT id, fact, importance, created_at, kind FROM agent_memories
      WHERE user_id=$1 AND valid=1 ORDER BY importance DESC, id DESC LIMIT $2`,
    [userId, MAX_MEMORIES]
  );
}

/* ------------------------------------------------------------------ */
/* Relevance (2026-09-30)                                              */
/* ------------------------------------------------------------------ */

// RELEVANT, NOT ALL (voice audit, 2026-09-30): every turn carried up to 60
// facts by importance, whatever was asked — a long, changing block in
// every prompt, and the one fact that mattered buried among the rest. A
// turn now gets ~15 facts scored against the user's own words (the words
// they share, a name they said, how recent, how important). With no words
// (a Live session opening) it gets the top ~20 by importance and recency.
// AI_MEMORY_SCORING=off sends every fact again.
const scoringOn = () => !/^(off|0|false|no)$/i.test(String(process.env.AI_MEMORY_SCORING || "on").trim());
const pickCount = () => {
  const n = Math.floor(Number(process.env.AI_MEMORY_PICK));
  return Number.isFinite(n) && n >= 1 && n <= MAX_MEMORIES ? n : 15;
};

const MEM_STOP = new Set((
  "the and for with that this from have has had was were are you your our their his her its " +
  "him she they them what which who whom when where how why can will would should could " +
  "not but about into just please okay yes yeah also some any all very user user's users " +
  "me my mine i'm im is it to of in on at by an as be do does did a or so if no up"
).split(" "));

/** Lowercase word stems, stop words out ("sisters" and "sister" meet). */
function memTokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/'s\b/g, "")
    .replace(/[^a-z0-9ऀ-෿\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !MEM_STOP.has(w))
    .map(stem);
}

function stem(w) {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** The names in a fact (capitalised words that are not "User"). */
function entitiesOf(fact) {
  return (String(fact || "").match(/\b[A-Z][a-zA-Z]{2,}\b/g) || [])
    .map((w) => w.toLowerCase())
    .filter((w) => w !== "user");
}

const DAY_MS = 86_400_000;
function recencyBonus(row, now) {
  const age = now - Number(row.created_at || 0);
  if (!(age >= 0)) return 0;
  return age < 7 * DAY_MS ? 1 : age < 30 * DAY_MS ? 0.5 : 0;
}

/**
 * The facts worth sending for these words: the relevant ones first (score
 * = shared words ×2 + a name they said ×3 + recency + importance/2), then
 * the most important and recent to fill up to `limit`. No words → the top
 * `limit` by importance and recency. Rows as listMemories returns them.
 */
function pickMemories(rows, { words = "", limit = 15, now = Date.now() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const base = (r) => Number(r.importance || 0) + recencyBonus(r, now);
  const byBase = list
    .map((r, i) => ({ r, i, b: base(r) }))
    .sort((x, y) => y.b - x.b || x.i - y.i);
  const q = new Set(memTokens(words));
  if (!q.size) return byBase.slice(0, limit).map((x) => x.r);
  const said = new Set(String(words).toLowerCase().replace(/'s\b/g, "").split(/[^a-zऀ-෿]+/));
  const scored = byBase.map((x) => {
    const toks = new Set(memTokens(x.r.fact));
    let hit = 0;
    for (const t of toks) if (q.has(t)) hit += 2;
    for (const e of new Set(entitiesOf(x.r.fact))) if (said.has(e)) hit += 3;
    return { ...x, hit, s: hit ? hit + recencyBonus(x.r, now) + Number(x.r.importance || 0) / 2 : 0 };
  });
  const relevant = scored.filter((x) => x.hit > 0).sort((a, b) => b.s - a.s || b.b - a.b || a.i - b.i);
  const rest = scored.filter((x) => x.hit === 0);
  return [...relevant, ...rest].slice(0, limit).map((x) => x.r);
}

/**
 * The block injected into system prompts. Empty string when there is
 * nothing remembered (or no signed-in user) — prompts stay clean.
 *
 * With `opts` (POST /ai/context since 2026-09-30) only the facts that fit
 * the turn are sent: { words } — the user's words this turn ("" when they
 * said nothing yet) — and { limit } (default AI_MEMORY_PICK, 15). Without
 * `opts` every fact is sent, as every other caller always had.
 */
async function memoryBlock(userId, opts) {
  const all = await listMemories(userId).catch(() => []);
  if (!all.length) return "";
  // GOALS AND PREFERENCES ride on every turn (a handful each): they shape
  // HOW to answer whatever is asked, so relevance-by-words must not drop
  // "keep answers short" or "saving for a house". Facts are picked by
  // relevance as before.
  const goals = all.filter((r) => r.kind === "goal").slice(0, 8);
  const prefs = all.filter((r) => r.kind === "preference").slice(0, 10);
  let facts = all.filter((r) => r.kind !== "goal" && r.kind !== "preference");
  if (opts && scoringOn()) {
    facts = pickMemories(facts, { words: opts.words || "", limit: Number(opts.limit) > 0 ? Number(opts.limit) : pickCount() });
  }
  const list = (rows) => rows.map((r) => "- " + r.fact).join("\n");
  const parts = [];
  if (prefs.length) parts.push("How they like things done (follow these without being asked):\n" + list(prefs));
  if (goals.length) parts.push("Their ongoing goals (help them move these forward when it fits):\n" + list(goals));
  if (facts.length) parts.push("About them:\n" + list(facts));
  return (
    "\n\nWHAT YOU REMEMBER ABOUT THIS USER (from earlier conversations; " +
    "use naturally, never recite as a list, never claim to 'have notes'). " +
    "Tailor every answer to this: never ask again for something already " +
    "here (their city, language, diet, family, work), and link advice to " +
    "their goals when it is relevant. If they now ask for something " +
    "different from a preference here, do what they ask now.\n" +
    parts.join("\n")
  );
}

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

async function saveMemory(userId, fact, importance = 2, kind = "semantic") {
  const k = cleanKind(kind);
  if (!userId || !fact) return;
  const f = String(fact).trim().slice(0, 300);
  if (!f) return;
  // Skip near-duplicates (same fact re-learned across sessions) — but a
  // FORGOTTEN fact the user states again is a revival, not a duplicate:
  // the old dedupe matched the invalid row and silently stored nothing.
  const dup = await one(
    `SELECT id, valid FROM agent_memories WHERE user_id=$1 AND lower(fact)=lower($2)`,
    [userId, f]
  );
  if (dup) {
    if (!dup.valid) {
      await run(
        `UPDATE agent_memories SET valid=1, importance=GREATEST(importance,$3), created_at=$4, kind=$5 WHERE id=$1 AND user_id=$2`,
        [dup.id, userId, importance, Date.now(), k]
      );
    }
    return;
  }
  await run(
    `INSERT INTO agent_memories (user_id, fact, importance, created_at, kind)
     VALUES ($1,$2,$3,$4,$5)`,
    [userId, f, importance, Date.now(), k]
  );
  // Evict beyond the cap: KEEP the top rows by importance (newest as the
  // tie-break) and delete the remainder. The old ASC ordering kept the 60
  // least important facts and deleted the rest — fact #61 evicted "user
  // is diabetic" and preserved "likes dosa". Forgotten rows no longer
  // occupy cap slots either.
  await run(
    `DELETE FROM agent_memories WHERE id IN (
       SELECT id FROM agent_memories WHERE user_id=$1 AND valid=1
       ORDER BY importance DESC, id DESC
       OFFSET $2)`,
    [userId, MAX_MEMORIES]
  );
}

/**
 * Remove facts containing an exact substring (LIKE-escaped). Used when a
 * saved document is deleted so its "Saved a receipt: …" context fact
 * doesn't outlive the file. Returns the number of facts removed.
 */
async function deleteFactsContaining(userId, substring) {
  if (!userId) return 0;
  const s = String(substring || "").trim();
  if (s.length < 3) return 0; // never mass-delete on a junk needle
  const escaped = s.replace(/([%_\\])/g, "\\$1");
  return run(
    `DELETE FROM agent_memories WHERE user_id = $1 AND fact LIKE $2 ESCAPE '\\'`,
    [userId, `%${escaped}%`]
  );
}

/** Full wipe — called from the privacy/deletion path. */
async function deleteAllMemories(userId) {
  if (!userId) return;
  await run(`DELETE FROM agent_memories WHERE user_id=$1`, [userId]);
}

/* ------------------------------------------------------------------ */
/* Extraction (async, post-reply)                                      */
/* ------------------------------------------------------------------ */

// Only bother the extractor when the user plausibly told us something
// about themselves — keeps cost at ~zero for ordinary Q&A turns.
const SELF_RX =
  /\b(my name|i am|i'm|im |call me|i live|i work|i study|i like|i love|i hate|i prefer|my (wife|husband|mom|dad|amma|appa|sister|brother|son|daughter|friend|birthday|exam|job|boss|school|college|city|village)|i can'?t eat|allergic|vegetarian|vegan|remember (that|this)|nanna hesaru|mera naam)\b/i;

// GOALS AND PREFERENCES (2026-10-07): "I want to lose 5 kg", "I'm
// preparing for UPSC", "keep it short", "don't call me before 9" never
// matched the self-description words above, so they were never learned
// and the user had to repeat them every time.
const GOAL_PREF_RX =
  /\b(my (goal|target|dream|plan|aim|business|startup|company|team|clients?|diet|routine|habit)|i (want|wish|hope|plan|intend) to|i'?m (trying|planning|preparing|learning|saving|working on|building|starting|aiming)|i (usually|always|never|mostly|normally)|i (don'?t|do not) (like|want|eat|drink)|i'?d rather|from now on|(please )?(always|never) (call|message|remind|wake|tell|use|speak|reply|answer)|don'?t (call|message|remind|disturb|wake) me|(reply|answer|talk|speak) (to me )?in (hindi|kannada|tamil|telugu|malayalam|marathi|bengali|gujarati|english)|(keep|make) (it|answers?|replies) (short|brief|simple|detailed)|every (morning|day|night|evening|week))\b/i;

function looksSelfDescriptive(text) {
  const t = String(text || "");
  return SELF_RX.test(t) || GOAL_PREF_RX.test(t);
}

const EXTRACT_PROMPT =
  "You extract durable personal facts from one user message for a personal " +
  "assistant's long-term memory. Return STRICT JSON only — an array of " +
  'objects: [{"fact":"...","kind":"fact"|"goal"|"preference","importance":1|2|3}] ' +
  "— no markdown, no prose. Facts must be about the USER, written as short " +
  "third-person statements (\"User's name is Dhanya\"). kind: \"goal\" = " +
  "something they are working towards for weeks or longer (\"User wants to " +
  "lose 5 kg\", \"User is preparing for the UPSC exam\", \"User is raising " +
  "funds for their startup\"); \"preference\" = how they want things done or " +
  "what they like (\"User prefers short answers\", \"User wants replies in " +
  "Kannada\", \"User does not want calls before 9 am\", \"User is " +
  "vegetarian\"); \"fact\" = everything else durable (name, family, city, " +
  "work, health, important dates). importance: 3 = identity/health/major " +
  "goals, 2 = preferences/relationships, 1 = minor. If nothing durable, " +
  "return []. STRICT EXCLUSIONS — return [] for: anything the user is " +
  "asking you to RELAY or SEND to someone else ('tell Allen I'm…', " +
  "'message Ravi that…' — that is the message, not a fact about the user); " +
  "quoted or reported speech of other people; hypotheticals, jokes and test " +
  "phrases; one-off requests ('book a cab', 'what's the weather'); and ANY " +
  "short time-bound plan ('going to Bangalore tomorrow', 'meeting at 5', " +
  "'next week') — those belong to reminders. Keep only what stays true for " +
  "weeks or months; never store passwords, OTPs, card or bank numbers.";

/**
 * Fire-and-forget: never throws, never blocks the reply.
 * @param {number} userId
 * @param {string} userText the raw user message/transcript
 */
// Words the user wants CARRIED to someone else are the message, not a
// fact about the user — "tell Allen I'm going to Bangalore tomorrow" once
// became "User is travelling to Bangalore tomorrow" in permanent memory.
// System-tagged text from the app is never the user's own voice either.
const RELAY_RX =
  /^\s*\[system\]|\b(?:tell|message|inform|text|whatsapp|ask|say to)\s+(?!me\b|you\b)\w+/i;

function extractAndStore(userId, userText) {
  const text = String(userText || "");
  if (!userId || RELAY_RX.test(text) || !looksSelfDescriptive(text)) return;
  (async () => {
    try {
      const { reply } = await generateReply(
        [{ role: "user", content: String(userText).slice(0, 1500) }],
        { system: EXTRACT_PROMPT }
      );
      const clean = String(reply || "").replace(/```json|```/g, "").trim();
      const facts = JSON.parse(clean);
      if (!Array.isArray(facts)) return;
      for (const f of facts.slice(0, 5)) {
        const imp = [1, 2, 3].includes(f?.importance) ? f.importance : 2;
        await saveMemory(userId, f?.fact, imp, f?.kind === "fact" ? "semantic" : f?.kind);
      }
    } catch (_) {
      /* memory is best-effort by design */
    }
  })();
}

module.exports = {
  listMemories,
  memoryBlock,
  pickMemories,
  memTokens,
  saveMemory,
  deleteAllMemories,
  deleteFactsContaining,
  extractAndStore,
  looksSelfDescriptive,
  cleanKind,
};
