/**
 * APPROVAL TOKENS — the owner's yes, carried by the app between turns.
 *
 * A tool that needs the owner's permission (a high-risk tool, or a send
 * after an email or someone else's message entered the session) answers
 * POST /ai/tool with needsConfirmation and one of these. The model asks;
 * when the owner agrees, the app retries the SAME tool with the SAME
 * arguments and the token, and the call runs approved. Anything else is
 * refused: another tool or other arguments, another account or session,
 * a token past its ten minutes, a forged or altered one, one already
 * spent, or one presented in the very turn that asked — the owner's yes
 * has to come in between, so the model cannot approve on their behalf by
 * calling again at once (the rule the Live proxy enforced with its turn
 * counter).
 *
 * token = base64url(payload) "." base64url(HMAC-SHA256(key, payload))
 * payload = { v, u: userId, s: sessionId, t: turn that asked,
 *             k: sha256 of the requested call's canonical key,
 *             a: the same for the call the model made, when it was routed,
 *             r: the call that runs once approved { tool, args, task? },
 *             x: expiry (ms), n: nonce }
 *
 * The canonical key is registry.approvalKey — the tool and its COERCED
 * arguments, so {run_id:"31"} and {run_id:31} are the same request.
 * `r` is what registry.execute asked to confirm, which may be pinned
 * (tool.prepare) or another tool (a shortcut's continue_shortcut).
 *
 * The key is AI_APPROVAL_SECRET when set (32+ characters), else derived
 * from JWT_SECRET, which the server cannot start without.
 */
const crypto = require("crypto");

const TTL_MS = 10 * 60_000;

function secret() {
  const own = process.env.AI_APPROVAL_SECRET;
  if (own && own.length >= 32) return own;
  return crypto.createHmac("sha256", String(process.env.JWT_SECRET || ""))
    .update("myassistant/ai-approval-token/v1").digest();
}

const b64 = (buf) => Buffer.from(buf).toString("base64url");
const sign = (body) => b64(crypto.createHmac("sha256", secret()).update(body).digest());
const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("base64url");

function canonical(tool, args) {
  return require("../tools/registry").approvalKey(tool, args || {});
}

/** A token for the call the owner is being asked about. */
function issue({ userId, sessionId, turnId, tool, args, alias = null, resolved, now = Date.now() }) {
  const payload = {
    v: 1,
    u: String(userId),
    s: String(sessionId),
    t: String(turnId || ""),
    k: hash(canonical(tool, args)),
    // The call the model actually made, when the server routed it to
    // another (shortcut steering): its retry is the same request.
    ...(alias && alias.tool ? { a: hash(canonical(alias.tool, alias.args)) } : {}),
    r: {
      tool: (resolved && resolved.tool) || tool,
      args: (resolved && resolved.args) || args || {},
      ...(resolved && resolved.task ? { task: resolved.task } : {}),
    },
    x: now + TTL_MS,
    n: crypto.randomBytes(9).toString("base64url"),
  };
  const body = b64(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

/**
 * Checks a token against the call it came with. Returns
 * { ok: true, payload } or { ok: false, reason }. `spent` is the session's
 * nonce map; a valid token is marked spent here, before anything runs.
 */
function verify(token, { userId, sessionId, turnId, tool, args, spent, now = Date.now() }) {
  const raw = String(token || "");
  const dot = raw.indexOf(".");
  if (dot <= 0 || raw.length > 8192) return { ok: false, reason: "malformed" };
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const want = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };
  let p;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch (_) {
    return { ok: false, reason: "malformed" };
  }
  if (!p || p.v !== 1 || !p.r || typeof p.r.tool !== "string") return { ok: false, reason: "malformed" };
  if (p.u !== String(userId)) return { ok: false, reason: "another account" };
  if (p.s !== String(sessionId)) return { ok: false, reason: "another session" };
  if (!(Number(p.x) > now)) return { ok: false, reason: "expired" };
  if (turnId && p.t === String(turnId)) return { ok: false, reason: "no answer from the owner yet" };
  const asked = canonical(tool, args);
  const h = hash(asked);
  if (h !== p.k && h !== p.a && asked !== canonical(p.r.tool, p.r.args)) {
    return { ok: false, reason: "another call" };
  }
  if (spent) {
    for (const [n, x] of spent) if (x <= now) spent.delete(n);
    if (spent.has(p.n)) return { ok: false, reason: "already used" };
    spent.set(p.n, Number(p.x));
  }
  return { ok: true, payload: p };
}

/** The nonce a token carries (so a "no" can spend it), or "". */
function nonceOf(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split(".")[0], "base64url").toString("utf8"));
    return (p && p.n) || "";
  } catch (_) {
    return "";
  }
}

module.exports = { issue, verify, canonical, nonceOf, TTL_MS };
