/**
 * ─────────────────────────────────────────────────────────────────────────
 *  THE SPEND METER (2026-10-09). Owner: "a clear dashboard of how many
 *  people used how much, who uses more, how much spent".
 *
 *  Nothing recorded what a request cost. Now every paid call the server
 *  makes is written to ai_spend: who it was for, what for (chat, search,
 *  transcribe, speech, image, embed, voice session, phone call), the
 *  model, the tokens or seconds, and its price in US dollars by the table
 *  below. The admin dashboard sums it per day, per user, per feature.
 *
 *  WHO: the request's signed-in user, found through AsyncLocalStorage
 *  (bind() wraps every request once, after the body parser), or given
 *  outright (a Bolna call knows its user). Background work with no user
 *  is recorded as unattributed.
 *
 *  WHAT IS NOT HERE: the phone's own voice (GPT-Live and the realtime
 *  voice talk to OpenAI directly; the server only opens the session). The
 *  sessions are counted; their cost shows in OpenAI's own bill, which the
 *  dashboard reads when OPENAI_ADMIN_KEY (an organisation admin key) is
 *  set — billed() below.
 *
 *  Prices are estimates from OpenAI's list prices (USD per 1M tokens,
 *  October 2026); SPEND_PRICES (JSON, same shape) overrides any of them.
 *  Never throws, never slows a request: a write that fails is dropped.
 * ─────────────────────────────────────────────────────────────────────────
 */
const { AsyncLocalStorage } = require("async_hooks");

const als = new AsyncLocalStorage();

// [input, cached input, output] USD per 1M tokens; longest prefix wins.
const TOKEN_PRICES = {
  "gpt-6-luna": [0.10, 0.01, 0.50],
  "gpt-5.4-nano": [0.20, 0.02, 1.25],
  "gpt-5.4-mini": [0.75, 0.075, 4.50],
  "gpt-5-nano": [0.05, 0.005, 0.40],
  "gpt-5-mini": [0.25, 0.025, 2.00],
  "gpt-5": [1.25, 0.125, 10.00],
  "gpt-4.1-nano": [0.10, 0.025, 0.40],
  "gpt-4.1-mini": [0.40, 0.10, 1.60],
  "gpt-4.1": [2.00, 0.50, 8.00],
  "gpt-4o-mini-transcribe": [1.25, 1.25, 5.00],
  "gpt-4o-transcribe": [2.50, 2.50, 10.00],
  "gpt-4o-mini-tts": [0.60, 0.60, 12.00],
  "gpt-4o-mini": [0.15, 0.075, 0.60],
  "gpt-4o": [2.50, 1.25, 10.00],
  "gpt-image-1-mini": [2.00, 0.20, 8.00],
  "gpt-image-1": [5.00, 1.25, 40.00],
  "text-embedding-3-small": [0.02, 0.02, 0],
  "text-embedding-3-large": [0.13, 0.13, 0],
  "gpt-realtime": [4.00, 0.40, 16.00],
};
// Flat rates for what is not billed by the token.
const FLAT = {
  transcribeMinute: { "gpt-4o-mini-transcribe": 0.003, "gpt-4o-transcribe": 0.006, "whisper-1": 0.006 },
  speechMinute: 0.015, // gpt-4o-mini-tts, ~900 characters a minute
  webSearchCall: 0.01,
};

function overrides() {
  try {
    const j = JSON.parse(process.env.SPEND_PRICES || "{}");
    return j && typeof j === "object" ? j : {};
  } catch (_) {
    return {};
  }
}

function priceOf(model) {
  const m = String(model || "").toLowerCase();
  const table = { ...TOKEN_PRICES, ...overrides() };
  let best = null;
  for (const k of Object.keys(table)) {
    if (m.startsWith(k.toLowerCase()) && (!best || k.length > best.length)) best = k;
  }
  const p = best ? table[best] : null;
  return Array.isArray(p) && p.length >= 3 ? p.map(Number) : null;
}

/** USD for a token count on a model; 0 when the model is not priced. */
function tokenCost(model, { input = 0, cached = 0, output = 0 }) {
  const p = priceOf(model);
  if (!p) return 0;
  const fresh = Math.max(0, input - cached);
  return (fresh * p[0] + cached * p[1] + output * p[2]) / 1e6;
}

/** The feature an OpenAI path pays for. */
function featureOf(path) {
  const p = String(path || "");
  if (p.startsWith("/chat/completions")) return "chat";
  if (p.startsWith("/responses")) return "search";
  if (p.startsWith("/audio/transcriptions")) return "transcribe";
  if (p.startsWith("/audio/speech")) return "speech";
  if (p.startsWith("/images")) return "image";
  if (p.startsWith("/embeddings")) return "embed";
  if (p.startsWith("/realtime") || p.startsWith("/live")) return "voice_session";
  return "other";
}

/** Tokens out of any OpenAI usage object (chat, responses, audio, image). */
function tokensOf(u) {
  if (!u || typeof u !== "object") return { input: 0, cached: 0, output: 0 };
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const output = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  const det = u.prompt_tokens_details || u.input_tokens_details || {};
  const cached = Number(det.cached_tokens || 0) || 0;
  return { input, cached: Math.min(cached, input), output };
}

/** The signed-in user of the request this code runs for, if any. */
function currentUser() {
  const s = als.getStore();
  const sub = s && s.req && s.req.user && s.req.user.sub;
  const n = Number(s && s.userId) || Number(sub);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Express middleware: remember the request for currentUser(). */
function bind() {
  return (req, _res, next) => als.run({ req }, next);
}

/** Runs fn as the given user (background work that knows who it is for). */
function as(userId, fn) {
  return als.run({ userId: Number(userId) || null }, fn);
}

let migrated = false;
async function migrate(exec) {
  await exec(`
    CREATE TABLE IF NOT EXISTS ai_spend (
      id            BIGSERIAL PRIMARY KEY,
      at            BIGINT NOT NULL,
      user_id       INTEGER,
      provider      TEXT NOT NULL DEFAULT 'openai',
      feature       TEXT NOT NULL DEFAULT 'other',
      model         TEXT NOT NULL DEFAULT '',
      tokens_in     INTEGER NOT NULL DEFAULT 0,
      tokens_cached INTEGER NOT NULL DEFAULT 0,
      tokens_out    INTEGER NOT NULL DEFAULT 0,
      units         DOUBLE PRECISION NOT NULL DEFAULT 0,
      cost_usd      DOUBLE PRECISION NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ai_spend_at ON ai_spend (at);
    CREATE INDEX IF NOT EXISTS idx_ai_spend_user ON ai_spend (user_id, at);
  `);
  migrated = true;
}

/** Writes one row. Never throws, never awaited by a request. */
function record({ userId, provider = "openai", feature = "other", model = "", tokens = {}, units = 0, cost = 0 } = {}) {
  try {
    const uid = userId === undefined ? currentUser() : Number(userId) || null;
    const t = { input: 0, cached: 0, output: 0, ...tokens };
    const usd = Number.isFinite(Number(cost)) ? Math.max(0, Number(cost)) : 0;
    const db = require("../db");
    db.run(
      `INSERT INTO ai_spend (at, user_id, provider, feature, model, tokens_in, tokens_cached, tokens_out, units, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [Date.now(), uid, String(provider).slice(0, 20), String(feature).slice(0, 30), String(model || "").slice(0, 60),
        Math.round(t.input) || 0, Math.round(t.cached) || 0, Math.round(t.output) || 0, Number(units) || 0, usd]
    ).catch(() => {});
  } catch (_) { /* the meter must never break a request */ }
}

/**
 * One OpenAI answer, metered: the path called, the body sent (for the
 * model and the input) and the JSON that came back (for the usage).
 */
function openai(path, body, data, { userId } = {}) {
  try {
    const feature = featureOf(path);
    const model = String((data && data.model) || (body && body.model) || "");
    const usage = data && data.usage;
    const tokens = tokensOf(usage);
    let cost = tokenCost(model, tokens);
    let units = 0;
    if (feature === "transcribe" && usage && usage.type === "duration") {
      units = Number(usage.seconds || usage.duration || 0) || 0;
      const rate = FLAT.transcribeMinute[model.replace(/-\d{4}.*$/, "")] ?? 0.006;
      cost = (units / 60) * rate;
    } else if (feature === "speech") {
      const chars = String((body && body.input) || "").length;
      units = chars;
      cost = (chars / 900) * FLAT.speechMinute;
    } else if (feature === "search") {
      const calls = ((data && data.output) || []).filter((o) => o && o.type === "web_search_call").length;
      units = calls;
      cost += calls * FLAT.webSearchCall;
    } else if (feature === "image") {
      units = Array.isArray(data && data.data) ? data.data.length : 1;
    } else if (feature === "voice_session") {
      units = 1;
      cost = 0; // the conversation itself is billed to the phone's session
    }
    if (!usage && !units && feature !== "voice_session") return;
    record({ userId, feature, model, tokens, units, cost });
  } catch (_) {}
}

/**
 * A finished Bolna phone call: Bolna reports total_cost in US cents
 * (BOLNA_COST_UNIT=usd if it is ever dollars) and conversation_duration
 * in seconds. Recorded once per execution.
 */
const seenCalls = new Map();
function bolna(userId, body) {
  try {
    const id = String((body && (body.id || body.execution_id)) || "");
    if (!id || seenCalls.has(id)) return;
    seenCalls.set(id, Date.now());
    if (seenCalls.size > 2000) {
      for (const [k, t] of seenCalls) if (Date.now() - t > 6 * 3600_000) seenCalls.delete(k);
    }
    const raw = Number(body.total_cost ?? body.cost ?? 0) || 0;
    const usd = String(process.env.BOLNA_COST_UNIT || "cents").toLowerCase() === "usd" ? raw : raw / 100;
    const secs = Number(body.conversation_duration || body.telephony_data?.duration || 0) || 0;
    record({ userId, provider: "bolna", feature: "phone_call", model: "bolna", units: secs, cost: usd });
  } catch (_) {}
}

/**
 * OpenAI's own bill, per day, when OPENAI_ADMIN_KEY is set: the true
 * total, the phone's voice included. Cached for 15 minutes.
 * Returns { days: [{d, usd}], byLine: [{line, usd}], total } or null.
 */
let billCache = { at: 0, days: 0, value: null };
async function billed(days = 30, { fetchImpl = fetch } = {}) {
  const key = String(process.env.OPENAI_ADMIN_KEY || "").trim();
  if (!key) return null;
  if (billCache.value && billCache.days === days && Date.now() - billCache.at < 15 * 60_000) return billCache.value;
  const start = Math.floor((Date.now() - days * 86400_000) / 1000);
  const byDay = new Map();
  const byLine = new Map();
  let page = "";
  try {
    for (let i = 0; i < 6; i++) {
      const u = new URL("https://api.openai.com/v1/organization/costs");
      u.searchParams.set("start_time", String(start));
      u.searchParams.set("bucket_width", "1d");
      u.searchParams.set("limit", String(Math.min(180, days + 1)));
      u.searchParams.append("group_by", "line_item");
      if (page) u.searchParams.set("page", page);
      const r = await fetchImpl(u, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return null;
      const j = await r.json();
      for (const b of j.data || []) {
        const d = new Date(Number(b.start_time) * 1000).toISOString().slice(0, 10);
        for (const res of b.results || []) {
          const v = Number(res.amount && res.amount.value) || 0;
          byDay.set(d, (byDay.get(d) || 0) + v);
          const line = String(res.line_item || "other");
          byLine.set(line, (byLine.get(line) || 0) + v);
        }
      }
      if (!j.has_more || !j.next_page) break;
      page = j.next_page;
    }
  } catch (_) {
    return null;
  }
  const value = {
    days: [...byDay.entries()].sort().map(([d, usd]) => ({ d, usd })),
    byLine: [...byLine.entries()].map(([line, usd]) => ({ line, usd })).sort((a, b) => b.usd - a.usd),
    total: [...byDay.values()].reduce((a, b) => a + b, 0),
  };
  billCache = { at: Date.now(), days, value };
  return value;
}

module.exports = {
  bind, as, currentUser, record, openai, bolna, billed, migrate,
  // for tests
  tokenCost, tokensOf, featureOf, priceOf, isMigrated: () => migrated,
};
