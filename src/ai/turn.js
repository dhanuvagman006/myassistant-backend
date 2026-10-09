/**
 * POST /ai/turn — the app's turn is over: check the reply and record it.
 *
 *   { sessionId, turnId, user, reply, engine, tools: [{name, ok, outcome?}],
 *     latencyMs, mode, cutOffAfter?, latency?: {endToFirstAudioMs,
 *     endToPlayMs, toolMs} }
 *   → { ok: true, reply, corrected, cutOff? }
 *
 * THE REPLY MAY NOT CLAIM WHAT DID NOT RUN. It is checked against what
 * this turn really executed on the server (the session's own tool log —
 * never the app's say-so), with anything the phone reports as having
 * failed taken off the evidence first, and the corrected words are
 * returned for the app to show and speak.
 *
 * Recorded exactly as a turn is recorded today: both halves into the
 * conversation memory (memory/recent.js, with latency, tools and build for
 * the admin panel), the ledger closed with the reply, durable facts and
 * promises learnt from what the owner said. An app note is not the owner
 * speaking: only the reply to it is kept. A turn in which the assistant
 * chose silence (stay_silent) says and records nothing.
 */
const claimCheck = require("../agents/claimCheck");
const sessionState = require("../agents/sessionState");
const sessions = require("./sessions");

// "nano" left this set on 2026-10-01: the on-device route was removed on 2026-09-29.
const ENGINES = new Set(["cloud", "search", "shortcut", "live"]);
const MODES = new Set(["voice", "live", "chat"]);
const turnLogOn = () => !/^(off|0|false|no)$/i.test(String(process.env.AI_TURN_LOG || "on").trim());
const ms = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n < 10 * 60_000 ? n : null;
};

// CUT OFF MID-REPLY (voice audit, 2026-09-30): a barge-in stopped the
// reply, but the whole of it was recorded, so the next turn's model
// believed the user had heard every word. `cutOffAfter` is what they did
// hear; what is kept is that much and a note saying the rest never
// reached them.
const CUT_NOTE = "[cut off here: the user interrupted and did not hear the rest of this reply]";
const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();

/**
 * The reply as it should be remembered after a cut-off, or null when it
 * was heard whole. `heard` is what played before the interruption.
 */
function heardPart(reply, heard) {
  // The app sends how many characters of the reply were heard.
  if (typeof heard === "number" && Number.isFinite(heard) && heard >= 0) {
    heard = String(reply || "").slice(0, Math.floor(heard));
  }
  if (typeof heard !== "string") return null;
  const full = squash(reply);
  const got = squash(heard).slice(0, 8000);
  if (!full || (got && full.length <= got.length)) return null;
  if (!got) return CUT_NOTE;
  // Usually the start of the reply; a transcript of Live's own voice may
  // differ a little, and it is still what was heard.
  return `${got} ${CUT_NOTE}`;
}

async function recordTurn(uid, body) {
  const s = sessions.get(uid, body.sessionId);
  if (!s) return { status: 404, json: { error: "unknown session" } };
  const t = sessions.turn(s, body.turnId);
  if (!t) return { status: 400, json: { error: "unknown turn" } };
  // Recorded once: a retried request gets the same answer, not a second row.
  if (t.recorded) return { status: 200, json: { ok: true, ...t.recorded } };

  const user = String(body.user == null ? t.text : body.user).slice(0, 4000);
  let reply = String(body.reply == null ? "" : body.reply).slice(0, 8000);
  const engine = ENGINES.has(body.engine) ? body.engine : "cloud";
  const mode = MODES.has(body.mode) ? body.mode : t.mode || "chat";
  // Where a spoken turn's time went (Live, 2026-09-30): end of their speech
  // to the first audio, to playback starting, and in tools.
  const lat = body.latency && typeof body.latency === "object" ? body.latency : {};
  // The app names them without "Ms" (tool_server.dart recordLiveTurn).
  const firstAudioMs = ms(lat.endToFirstAudioMs ?? lat.endToFirstAudio);
  const playMs = ms(lat.endToPlayMs ?? lat.endToPlay);
  const toolMs = ms(lat.toolMs ?? lat.tool);
  const latencyMs = Math.max(0, Math.round(Number(body.latencyMs) || firstAudioMs || 0));

  // What the phone says did NOT happen (an app that is not installed, an
  // intent refused): the record must not say it worked, and neither may
  // the reply.
  const actions = require("../actions/store");
  const reported = (Array.isArray(body.tools) ? body.tools : []).slice(0, 20)
    .filter((r) => r && typeof r.name === "string" && r.name.trim());
  for (const r of reported) {
    if (r.ok !== false) continue;
    const name = r.name.trim().slice(0, 60);
    const outcome = String(r.outcome || "").trim().slice(0, 200);
    const mine = s.state.executed.filter((e) => e.turnId === t.id && e.tool === name);
    for (const e of mine) e.ok = false;
    const target = (mine.find((e) => e.target) || {}).target || "";
    actions.invalidate(uid, name, target, {
      windowMs: 5 * 60_000,
      detail: `the phone reported failure${outcome ? ` — ${outcome}` : ""}`,
    }).catch((e) => console.warn("ai: device failure invalidate:", e.message));
  }

  let corrected = false;
  if (t.silent) {
    // Speech that was not addressed to the assistant gets no reply at all.
    corrected = reply.trim() !== "";
    reply = "";
  } else {
    const executed = s.state.executed.filter((e) => e.turnId === t.id);
    const verdict = claimCheck.check(reply, executed);
    if (!verdict.ok) {
      console.warn("ai: claim check corrected a reply:", JSON.stringify({
        violations: verdict.violations,
        ran: executed.map((e) => ({ tool: e.tool, ok: e.ok })),
        turnId: t.id,
      }));
      reply = verdict.text;
      corrected = true;
    }
  }

  const recent = require("../memory/recent");
  const meta = { source: `ai-${engine}`, appBuild: s.device.build, turnId: t.id, sessionId: s.id };
  const tools = [...new Set([
    ...s.state.executed.filter((e) => e.turnId === t.id && !e.vouched).map((e) => e.tool),
    ...reported.map((r) => r.name.trim().slice(0, 60)),
  ])];
  if (t.owner && user.trim()) {
    recent.append(uid, "user", user, { ...meta, latencyMs: 0 });
    // Learn durable personal facts and the promises made out loud — the
    // same account-level memory every device sees after login.
    try { require("../agents/memory").extractAndStore(uid, user); } catch (_) {}
    try { require("../commitments/service").extractAsync(uid, user, { source: "voice" }); } catch (_) {}
  }
  // What they actually heard, when they cut the reply off. A corrected
  // reply is kept whole: the correction is what the app says next.
  const cut = !corrected && reply.trim() ? heardPart(reply, body.cutOffAfter) : null;
  const kept = cut || reply;
  if (reply.trim()) {
    recent.append(uid, "assistant", kept, { ...meta, latencyMs, tools });
    // CLOSE THE LEDGER: every action this turn took carries the answer.
    try { actions.attachReply(uid, t.id, kept); } catch (_) {}
    sessionState.recordReply(s.state, kept);
    s.lastReply = kept;
  }
  if (turnLogOn()) {
    const part = (k, v) => (v === null ? "" : ` ${k}=${v}ms`);
    console.log(`ai: turn ${mode} ${engine} build=${s.device.build || 0}` +
      part("reply", latencyMs || null) + part("firstAudio", firstAudioMs) + part("play", playMs) +
      part("tools", toolMs) + ` toolCalls=${tools.length}` + (cut ? " cutOff=yes" : "") +
      // How much of what THEY said reached us (2026-10-08): voice turns on
      // prod had never recorded a user line, and this shows where it is lost.
      ` heard=${user.trim().length}${t.owner ? "" : " notOwner"}` +
      (corrected ? " corrected=yes" : ""));
  }

  // Messages passed on in this turn have now been said: retire them.
  if (s.relay && s.relay.turnId === t.id && reply.trim()) {
    const ids = s.relay.rows.map((m) => m.id);
    s.relay = null;
    require("../db").run(
      `UPDATE agent_messages SET status = 'read' WHERE id = ANY($1::bigint[])`, [ids]
    ).catch((e) => console.error("ai: could not retire messages:", e.message));
  }

  t.recorded = { reply, corrected, ...(cut ? { cutOff: true } : {}) };
  return { status: 200, json: { ok: true, reply, corrected, ...(cut ? { cutOff: true } : {}) } };
}

module.exports = { recordTurn, heardPart, CUT_NOTE };
