/**
 * MEMORY THAT LEARNS — reinforcement, consolidation, habits (2026-10-18).
 * -----------------------------------------------------------------------
 * agents/memory.js stores what the user SAYS. Left alone that memory only
 * grows: the same address saved six ways, "prefers Kannada" filed as an
 * ordinary fact, a fact used every day weighing the same as one that was
 * wrong from the start, and nothing learnt from what the user DOES.
 *
 * Every remembered row now carries a strength (1 as stored, 0.1 … 3):
 *
 *   used in a reply ........ +0.05 (at most five facts a turn)
 *   said again ............. +0.3  (agents/memory.js saveMemory/supersede)
 *   contradicted ........... ×0.4, judged by a model only when the user's
 *                            words look like a correction and touch something
 *                            remembered. A misjudged "it's fine" costs a
 *                            little standing, never the fact; a real change
 *                            ("moved to Pune") is learnt as the new fact and
 *                            supersede() retires the old one. A learned habit
 *                            (0.8) falls under 0.35 at once and is let go.
 *   unused 30 days ......... ×0.98 a day; identity/health (importance 3)
 *                            never fades
 *
 * Below 0.35 a fact leaves the prompt but stays listed and recallable.
 *
 * Once a day per user (lazily, from their first turn — the same pattern as
 * memory/episodes.js, never on a reply's path):
 *   1. decay, as above;
 *   2. consolidation — duplicates merged, contradictions resolved newest-
 *      wins, kinds corrected. Only conversational rows: kitchen/shopping
 *      notes and "Saved a …" document lines are parsed elsewhere by their
 *      exact wording and are never rewritten;
 *   3. reflection — a week of turns read for HABITS (which app, how long
 *      an answer, which language, routines). A habit is kept only once it
 *      has shown on three different days; it is kept as source='learned',
 *      and one correction retires it for good.
 *
 * AI_MEMORY_LEARNING=off turns all of it off; stored rows rank as before.
 */
const { query, one, run } = require("../db");
const memory = require("../agents/memory");

const DAY_MS = 86_400_000;
const MAX_STRENGTH = 3;
const USE_BUMP = 0.05;
const USES_PER_TURN = 5;
const DECAY_AFTER_DAYS = 30;
const DECAY_PER_DAY = 0.98;
const LEARN_MIN_DAYS = () => {
  const n = Math.floor(Number(process.env.AI_MEMORY_LEARN_MIN_DAYS));
  return Number.isFinite(n) && n >= 2 && n <= 14 ? n : 3;
};
const REFLECT_MIN_USER_TURNS = 8;
const REFLECT_WINDOW_DAYS = 7;
const CONSOLIDATE_SOURCES = ["conversation", "consolidated", "learned"];

const on = () => !/^(off|0|false|no)$/i.test(String(process.env.AI_MEMORY_LEARNING || "on").trim());

const parseJson = (reply) => JSON.parse(String(reply || "").replace(/```json|```/g, "").trim());

async function ask(system, content, maxTokens = 600) {
  const { generateReply } = require("../services/ai/router");
  const { reply } = await generateReply(
    [{ role: "user", content }],
    // Judgement about what is true of a person: the app's default nano
    // model retired a building's address because its owner moved out.
    { system, maxTokens, timeoutMs: 30_000, noRetry: true, model: process.env.AI_MEMORY_MODEL || "gpt-5.4-mini" }
  );
  return parseJson(reply);
}

/* ------------------------------------------------------------------ */
/* Per turn: used facts grow, contradicted facts go                     */
/* ------------------------------------------------------------------ */

// Words that appear in many facts and say nothing about which one a reply
// leaned on.
const GENERIC = new Set(("prefer like want assistant speak talk answer reply usually always " +
  "name live lives work works call message").split(" ").map((w) => memory.memTokens(w)[0] || w));

/**
 * The remembered rows a reply drew on: two of the fact's own words in the
 * reply, or one of its names plus one word. Pure; rows as listMemories.
 */
function usedMemories(rows, reply, limit = USES_PER_TURN) {
  const text = String(reply || "");
  if (!text.trim()) return [];
  const said = new Set(memory.memTokens(text));
  const lower = text.toLowerCase();
  const hits = [];
  for (const r of rows || []) {
    const words = [...new Set(memory.memTokens(r.fact))].filter((w) => !GENERIC.has(w));
    const shared = words.filter((w) => said.has(w)).length;
    const names = [...new Set(memory.entitiesOf(r.fact))]
      .filter((n) => new RegExp(`\\b${n.replace(/[^a-z0-9]/g, "")}\\b`).test(lower)).length;
    const score = shared + names;
    if (score >= 2) hits.push({ r, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit).map((h) => h.r);
}

const CORRECTION_PROMPT =
  "A personal assistant keeps long-term facts about its user. Below is what the " +
  "assistant last said, what the user said next, and numbered FACTS. Which facts " +
  "does the user now say are wrong or no longer true? Count only a fact the user " +
  "clearly contradicts or rejects ('no, I moved to Pune' contradicts 'lives in " +
  "Mumbai'; 'don't use WhatsApp for me' rejects 'prefers WhatsApp'): their words " +
  "would be false if the fact were true. Agreeing, thanking, 'it's fine', 'no " +
  "problem' and changing the subject reject nothing. A fact the " +
  "user only mentions, asks about or adds to is NOT wrong, and neither is a fact " +
  "about some other person, place or thing that stays true when the user's own " +
  "situation changes (moving out does not change the old building's address). " +
  "Return STRICT JSON " +
  'only: {"wrong":[2]} — {"wrong":[]} when none. No prose, no markdown.';

/** The facts a correction could be about: named in it, or used just before. */
function correctionCandidates(rows, userText, prevReply, limit = 10) {
  const out = [...memory.relatedFacts(rows, userText, limit), ...usedMemories(rows, prevReply, limit)];
  const seen = new Set();
  return out.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))).slice(0, limit);
}

/**
 * Fire-and-forget, after a turn the user really spoke. `reply` is what
 * they heard ("" when cut off or silent), `prevReply` the turn before.
 */
function afterTurn(userId, { user = "", reply = "", prevReply = "" } = {}) {
  const uid = Number(userId);
  if (!on() || !Number.isInteger(uid) || uid <= 0) return;
  (async () => {
    try {
      const rows = await memory.listMemories(uid);
      if (!rows.length) return;
      const used = usedMemories(rows, reply);
      if (used.length) {
        await run(
          `UPDATE agent_memories SET uses = uses + 1, last_used_at = $3,
                  strength = LEAST(${MAX_STRENGTH}, strength + ${USE_BUMP})
            WHERE user_id = $1 AND id = ANY($2::bigint[]) AND valid = 1`,
          [uid, used.map((r) => r.id), Date.now()]
        );
      }
      if (memory.CORRECTION_RX.test(String(user))) {
        await judgeCorrection(uid, rows, String(user), String(prevReply || ""));
      }
    } catch (e) {
      console.warn("memory learning: afterTurn failed:", e.message);
    }
  })();
}

async function judgeCorrection(uid, rows, user, prevReply) {
  const cands = correctionCandidates(rows, user, prevReply);
  if (!cands.length) return [];
  const verdict = await ask(CORRECTION_PROMPT,
    `ASSISTANT SAID: ${prevReply.slice(0, 400)}\nUSER NOW SAYS: ${user.slice(0, 400)}\nFACTS:\n` +
    cands.map((r, i) => `${i + 1}. ${r.fact}`).join("\n"), 60);
  const wrong = [...new Set(Array.isArray(verdict && verdict.wrong) ? verdict.wrong : [])]
    .map((n) => cands[Number(n) - 1]).filter(Boolean);
  if (!wrong.length) return [];
  const ids = wrong.map((r) => r.id);
  const at = Date.now();
  await run(
    `UPDATE agent_memories SET strength = GREATEST(0.1, strength * 0.4), updated_at = $3
      WHERE user_id = $1 AND id = ANY($2::bigint[]) AND valid = 1`,
    [uid, ids, at]
  );
  // A learned habit they turned down goes now, and is never learnt again.
  const learned = wrong.filter((r) => r.source === "learned").map((r) => r.id);
  if (learned.length) {
    await run(
      `UPDATE agent_memories SET valid = 0, invalidated_at = $3, updated_at = $3
        WHERE user_id = $1 AND id = ANY($2::bigint[])`,
      [uid, learned, at]
    );
    await run(
      `UPDATE memory_candidates SET status = 'rejected', updated_at = $3
        WHERE user_id = $1 AND memory_id = ANY($2::bigint[])`,
      [uid, learned, at]
    );
  }
  console.log(`memory learning: user=${uid} correction weakened ${ids.length} fact(s)` +
    (learned.length ? `, let go ${learned.length} learned` : ""));
  return wrong.map((r) => r.fact);
}

/* ------------------------------------------------------------------ */
/* Once a day                                                          */
/* ------------------------------------------------------------------ */

const inFlight = new Set();

function localDay(ms, tz) {
  const off = Number.isFinite(tz) ? tz : 330;
  return new Date(Number(ms) + off * 60_000).toISOString().slice(0, 10);
}

/** Fire-and-forget; at most once per user per local day. Never throws. */
function ensureDaily(userId, tz) {
  const uid = Number(userId);
  if (!on() || !Number.isInteger(uid) || uid <= 0 || inFlight.has(uid)) return;
  inFlight.add(uid);
  (async () => {
    try {
      const today = localDay(Date.now(), tz);
      const state = await one(`SELECT * FROM memory_upkeep WHERE user_id = $1`, [uid]);
      if (state && state.day === today) return;
      // Marked first: a failing step is retried tomorrow, not on every turn.
      await run(
        `INSERT INTO memory_upkeep (user_id, day) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET day = EXCLUDED.day`,
        [uid, today]
      );
      const steps = [
        ["embed", () => backfillEmbeddings(uid)],
        ["decay", () => decay(uid, state)],
        ["consolidate", () => consolidate(uid, { since: Number(state && state.consolidated_at) || 0 })],
        ["reflect", () => reflect(uid, tz)],
      ];
      for (const [name, step] of steps) {
        try { await step(); } catch (e) { console.warn(`memory learning: ${name} failed for user=${uid}:`, e.message); }
      }
    } catch (e) {
      console.warn("memory learning: daily upkeep failed:", e.message);
    } finally {
      inFlight.delete(uid);
    }
  })();
}

/** Facts stored before embedding-on-write get their vectors, 50 a day. */
async function backfillEmbeddings(uid) {
  const rows = await query(
    `SELECT id, fact FROM agent_memories
      WHERE user_id = $1 AND valid = 1 AND embedding IS NULL ORDER BY id DESC LIMIT 50`, [uid]);
  if (!rows.length) return 0;
  const vecs = await require("./embeddings").embed(rows.map((r) => r.fact));
  if (!vecs) return 0;
  for (let i = 0; i < rows.length; i++) {
    await run(`UPDATE agent_memories SET embedding = $3 WHERE user_id = $1 AND id = $2`,
      [uid, rows[i].id, JSON.stringify(vecs[i])]);
  }
  return rows.length;
}

async function decay(uid, state) {
  const now = Date.now();
  const last = Number(state && state.decayed_at) || 0;
  const days = last ? Math.min(30, Math.max(1, Math.round((now - last) / DAY_MS))) : 1;
  await run(
    `UPDATE agent_memories SET strength = GREATEST(0.1, strength * POWER($3::float, $4::float))
      WHERE user_id = $1 AND valid = 1 AND importance < 3
        AND COALESCE(last_used_at, created_at) < $2`,
    [uid, now - DECAY_AFTER_DAYS * DAY_MS, DECAY_PER_DAY, days]
  );
  // A learned habit that stopped showing up is let go.
  await run(
    `UPDATE agent_memories SET valid = 0, invalidated_at = $2, updated_at = $2
      WHERE user_id = $1 AND valid = 1 AND source = 'learned' AND strength < $3`,
    [uid, now, memory.FADED]
  );
  await run(`UPDATE memory_upkeep SET decayed_at = $2 WHERE user_id = $1`, [uid, now]);
}

/* ---------- consolidation ---------- */

const CONSOLIDATE_PROMPT =
  "You tidy a personal assistant's long-term memory about ONE user. The facts are " +
  "numbered oldest first: a higher number is newer. Find groups that say the same " +
  "thing, or that contradict each other about the same attribute of the same " +
  "person or thing — including one attribute written several ways with more, " +
  "less or different detail (five versions of where the user lives are ONE " +
  "group). For each group write ONE fact that keeps every detail that is " +
  "still true — when they contradict, the NEWEST wins. Write it as the facts are " +
  "written (third person, 'User …'). Never merge facts about different people or " +
  "different attributes, never invent a detail, never drop a detail nothing " +
  "contradicts. Also correct the kind of any fact filed wrongly: preference = how " +
  "they like things done, or what they like or dislike; goal = something they are " +
  "working towards; fact = anything else. Return STRICT JSON only: " +
  '{"merge":[{"ids":[1,4],"fact":"…","kind":"fact"}],"kind":[{"id":3,"kind":"preference"}]}' +
  " — empty arrays when there is nothing to do. No prose, no markdown.";

const subjectKey = (r) => `${r.subject_type || ""}:${r.subject_id == null ? "" : r.subject_id}`;
const toKind = (k) => (k === "fact" ? "semantic" : memory.cleanKind(k));

/**
 * Checks the model's plan against the rows it was shown; drops anything
 * malformed. Pure. Returns { merges: [{rows, fact, kind}], kinds: [{row, kind}] }.
 */
function planConsolidation(rows, plan) {
  const out = { merges: [], kinds: [] };
  const used = new Set();
  const at = (n) => (Number.isInteger(Number(n)) ? rows[Number(n) - 1] : null);
  for (const m of Array.isArray(plan && plan.merge) ? plan.merge.slice(0, 15) : []) {
    const group = [...new Set(Array.isArray(m && m.ids) ? m.ids : [])].map(at);
    const fact = String((m && m.fact) || "").trim();
    if (group.length < 2 || group.some((r) => !r || used.has(r.id))) continue;
    // Facts about two different people never blend. Unlinked rows may join
    // ONE person's rows; the merged fact then stays on that person's card.
    const subjects = new Set(group.filter((r) => r.subject_type).map(subjectKey));
    if (subjects.size > 1) continue;
    if (!fact || fact.length > 300) continue;
    group.forEach((r) => used.add(r.id));
    const linked = group.find((r) => r.subject_type);
    out.merges.push({ rows: group, fact, kind: toKind(m.kind),
      subjectType: linked ? linked.subject_type : "", subjectId: linked ? linked.subject_id : null });
  }
  for (const k of Array.isArray(plan && plan.kind) ? plan.kind.slice(0, 40) : []) {
    const row = at(k && k.id);
    const kind = toKind(k && k.kind);
    if (!row || used.has(row.id) || row.kind === kind) continue;
    out.kinds.push({ row, kind });
  }
  return out;
}

/**
 * Merge duplicates and contradictions. `since`: skip when nothing changed
 * after that time. `dry`: return the plan without applying it.
 */
async function consolidate(uid, { since = 0, dry = false } = {}) {
  const rows = await query(
    `SELECT id, fact, kind, importance, subject_type, subject_id, strength, uses, evidence,
            source, confidence, created_at, updated_at
       FROM agent_memories
      WHERE user_id = $1 AND valid = 1 AND source = ANY($2::text[]) AND fact NOT LIKE 'Saved a %'
      ORDER BY id ASC LIMIT 150`,
    [uid, CONSOLIDATE_SOURCES]
  );
  if (rows.length < 2) return null;
  const changed = Math.max(...rows.map((r) => Math.max(Number(r.created_at) || 0, Number(r.updated_at) || 0)));
  if (!dry && since && changed <= since) return null;
  const tag = (r) => {
    const k = r.kind === "semantic" ? "fact" : r.kind;
    return r.subject_type ? `${k}, about ${r.subject_type} #${r.subject_id}` : k;
  };
  const plan = planConsolidation(rows, await ask(CONSOLIDATE_PROMPT,
    rows.map((r, i) => `${i + 1}. [${tag(r)}] ${String(r.fact).slice(0, 300)}`).join("\n"), 1500));
  if (dry) return plan;
  const now = Date.now();
  for (const m of plan.merges) {
    const g = m.rows;
    const row = await one(
      `INSERT INTO agent_memories
         (user_id, fact, importance, created_at, updated_at, kind, subject_type, subject_id,
          source, confidence, valid, strength, uses, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$13) RETURNING id`,
      [uid, m.fact,
        Math.max(...g.map((r) => Number(r.importance) || 0)),
        // The group's own newest time: a merge is not news, and the
        // newest-first readers (shopping, kitchen) keep their order.
        Math.max(...g.map((r) => Number(r.created_at) || 0)), now,
        m.kind, m.subjectType, m.subjectId,
        g.every((r) => r.source === "learned") ? "learned" : "consolidated",
        Math.max(...g.map((r) => Number(r.confidence) || 0.8)),
        Math.min(MAX_STRENGTH, Math.max(...g.map((r) => Number(r.strength) || 1))),
        g.reduce((n, r) => n + (Number(r.uses) || 0), 0),
        g.reduce((n, r) => n + (Number(r.evidence) || 1), 0)]
    );
    await run(
      `UPDATE agent_memories SET valid = 0, invalidated_at = $3, updated_at = $3
        WHERE user_id = $1 AND id = ANY($2::bigint[])`,
      [uid, g.map((r) => r.id), now]
    );
    // A learned habit merged away hands its candidate to the new row.
    await run(`UPDATE memory_candidates SET memory_id = $3 WHERE user_id = $1 AND memory_id = ANY($2::bigint[])`,
      [uid, g.map((r) => r.id), row.id]);
    require("./embeddings").embedOne(m.fact).then((vec) => vec && run(
      `UPDATE agent_memories SET embedding = $3 WHERE user_id = $1 AND id = $2`,
      [uid, row.id, JSON.stringify(vec)])).catch(() => {});
  }
  for (const k of plan.kinds) {
    await run(`UPDATE agent_memories SET kind = $3, updated_at = $4 WHERE user_id = $1 AND id = $2`,
      [uid, k.row.id, k.kind, now]);
  }
  await run(`UPDATE memory_upkeep SET consolidated_at = $2 WHERE user_id = $1`, [uid, now]);
  if (plan.merges.length || plan.kinds.length) {
    console.log(`memory learning: user=${uid} merged ${plan.merges.reduce((n, m) => n + m.rows.length, 0)}` +
      ` fact(s) into ${plan.merges.length}, re-filed ${plan.kinds.length}`);
  }
  return plan;
}

/* ---------- reflection: habits from what they do ---------- */

const REFLECT_PROMPT =
  "You read a week of conversation between a user and their personal voice " +
  "assistant to learn HOW this user likes to be helped — patterns they show " +
  "without ever saying them. Report a pattern only when the transcript shows it " +
  "on at least two different days. Good patterns: the app or channel they use for " +
  "something (messages to family always go by WhatsApp), the answer length that " +
  "works for them (they cut long answers off), the language they speak in, " +
  "routines (asks for traffic around 9 am on weekdays). NEVER infer health, " +
  "religion, caste, politics, sexuality, money, or anything about other people; " +
  "never repeat a fact the user stated outright (that is stored elsewhere); never " +
  "guess. Patterns already being tracked are listed with their KEY: reuse the " +
  "same key when you see the same pattern again. Return STRICT JSON only: " +
  '[{"key":"short_snake_case","fact":"User … (one sentence, third person)",' +
  '"kind":"preference"|"fact","days":["YYYY-MM-DD"]}] where days are the dates ' +
  "in this transcript that show it. [] when there is nothing. No prose, no markdown.";

const KEY_RX = /^[a-z][a-z0-9_]{2,60}$/;
const DAY_RX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Folds the model's proposals into the stored candidates. Pure. Returns
 * [{key, fact, kind, days, status, isNew, promote}] for the rows to write.
 */
function mergeCandidates(existing, proposals, { validDays, minDays = LEARN_MIN_DAYS() } = {}) {
  const byKey = new Map((existing || []).map((c) => [c.key, c]));
  const out = [];
  for (const p of Array.isArray(proposals) ? proposals.slice(0, 10) : []) {
    const key = String((p && p.key) || "").trim().toLowerCase();
    const fact = String((p && p.fact) || "").trim();
    if (!KEY_RX.test(key) || !fact || fact.length > 200) continue;
    const days = (Array.isArray(p.days) ? p.days : [])
      .map(String).filter((d) => DAY_RX.test(d) && (!validDays || validDays.has(d)));
    if (!days.length) continue;
    const old = byKey.get(key);
    if (old && old.status !== "pending") continue; // kept already, or turned down
    const prior = old ? safeDays(old.days) : [];
    const all = [...new Set([...prior, ...days])].sort().slice(-30);
    out.push({
      key, fact, kind: p.kind === "fact" ? "semantic" : "preference",
      days: all, status: "pending", isNew: !old, promote: all.length >= minDays,
    });
  }
  return out;
}

function safeDays(v) {
  try { const a = JSON.parse(v || "[]"); return Array.isArray(a) ? a.map(String) : []; } catch (_) { return []; }
}

async function reflect(uid, tz) {
  const since = Date.now() - REFLECT_WINDOW_DAYS * DAY_MS;
  const turns = await query(
    `SELECT role, text, tools, created_at FROM conversation_turns
      WHERE user_id = $1 AND created_at >= $2 ORDER BY id DESC LIMIT 400`,
    [uid, since]
  );
  if (turns.filter((t) => t.role === "user").length < REFLECT_MIN_USER_TURNS) return null;
  // Newest kept first when the transcript has to be cut, then read in order.
  const lines = [];
  let size = 0;
  for (const t of turns) {
    const tools = t.role === "assistant" && t.tools ? ` [tools: ${String(t.tools).slice(0, 80)}]` : "";
    const line = `${localDay(t.created_at, tz)} ${t.role === "user" ? "User" : "Assistant"}: ` +
      `${String(t.text || "").replace(/\s+/g, " ").trim().slice(0, 200)}${tools}`;
    if (size + line.length > 9000) break;
    lines.push(line);
    size += line.length + 1;
  }
  lines.reverse();
  const validDays = new Set(turns.map((t) => localDay(t.created_at, tz)));
  const existing = await query(`SELECT * FROM memory_candidates WHERE user_id = $1`, [uid]);
  const tracked = existing.filter((c) => c.status === "pending")
    .map((c) => `${c.key}: ${c.fact}`).slice(0, 30).join("\n") || "(none)";
  const proposals = await ask(REFLECT_PROMPT,
    `TRACKED PATTERNS:\n${tracked}\n\nTRANSCRIPT:\n${lines.join("\n")}`, 800);
  const now = Date.now();
  let kept = 0;
  for (const c of mergeCandidates(existing, proposals, { validDays })) {
    const row = await one(
      `INSERT INTO memory_candidates (user_id, key, fact, kind, days, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$6)
       ON CONFLICT (user_id, key) DO UPDATE SET fact = EXCLUDED.fact, kind = EXCLUDED.kind,
         days = EXCLUDED.days, updated_at = EXCLUDED.updated_at
       WHERE memory_candidates.status = 'pending'
       RETURNING id`,
      [uid, c.key, c.fact, c.kind, JSON.stringify(c.days), now]
    );
    if (!row || !c.promote) continue;
    const id = await memory.saveMemory(uid, c.fact, 2, c.kind);
    if (id) {
      // Learnt, not told: a little below a stated fact, so one doubt or a
      // few unused weeks let it go.
      // Never supersede(): a habit seen must not retire what they SAID.
      await run(`UPDATE agent_memories SET source = 'learned', strength = 0.8 WHERE user_id = $1 AND id = $2`, [uid, id]);
    }
    await run(`UPDATE memory_candidates SET status = 'promoted', memory_id = $3, updated_at = $4
                WHERE user_id = $1 AND id = $2`, [uid, row.id, id, now]);
    kept++;
  }
  if (kept) console.log(`memory learning: user=${uid} learnt ${kept} habit(s)`);
  return kept;
}

module.exports = {
  afterTurn, ensureDaily, consolidate, reflect, decay, backfillEmbeddings, judgeCorrection,
  usedMemories, correctionCandidates, planConsolidation, mergeCandidates, localDay,
  CONSOLIDATE_PROMPT, REFLECT_PROMPT, CORRECTION_PROMPT,
};
