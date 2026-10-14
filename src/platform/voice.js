/**
 * VOICE TO VOICE IN A CONNECTED APP (2026-10-14).
 *
 * POST /v1/voice/sessions opens a realtime voice session for the app the
 * same way the phone opens its own (ai/routes.js /realtime/secret): the
 * key stays on this server, the app gets a short-lived client secret and
 * connects to OpenAI's realtime endpoint itself (WebRTC in a browser,
 * WebSocket elsewhere). The session is built here: her voice and manner,
 * the user's profile, memory and recent conversation, the app's frame,
 * the assistant's spoken-safe tools and the app's own tools.
 *
 * When the voice model calls a tool, the app runs its own tools itself and
 * sends an assistant tool to POST /v1/tools/call; when the conversation
 * ends (or every few turns) it posts the transcript to
 * POST /v1/voice/transcript, which files it in the user's conversation
 * memory and counts the minutes on their account.
 */
const registry = require("../tools/registry");
const store = require("./store");
const { apiTool, cleanAppTools, appBlock, ApiError } = require("./assistant");

const MAX_VOICE_TOOLS = 20;
const DAILY_SESSIONS = () => Number(process.env.PLATFORM_DAILY_VOICE_SESSIONS) || 60;

/** The assistant tools a voice session in an app is given (and may call through /v1/tools/call). */
function voiceToolNames(scopes = null) {
  const { CORE } = require("../tools/relevance");
  const names = [...CORE].filter((n) => apiTool(registry.get(n), scopes));
  return [...new Set(names)].slice(0, MAX_VOICE_TOOLS);
}

async function openSession({ app, user, body, tzOffsetMin = null }) {
  const b = body && typeof body === "object" ? body : {};
  const uid = Number(user.id);
  const used = await store.usageToday(app.id);
  if (used.voiceSessions >= DAILY_SESSIONS()) {
    throw new ApiError(429, "daily_limit", `This app has opened today's ${DAILY_SESSIONS()} voice sessions. It resets at midnight UTC.`);
  }
  const appTools = cleanAppTools(b.tools) || [];
  const withAssistantTools = b.include_assistant_tools !== false;
  const context = typeof b.context === "string" ? b.context : b.context ? JSON.stringify(b.context) : "";
  if (context.length > 12_000) throw new ApiError(400, "bad_context", "context is larger than 12,000 characters");

  const runtime = require("../agents/runtime");
  const cfg = require("../ai/config");
  const profile = await require("../users/context").getProfile(uid).catch(() => null);
  let extra = "";
  try {
    extra = await runtime.contextExtra({ userId: uid, tzOffsetMin, sessionId: `voice:${app.slug}` }, null);
  } catch (_) {}
  const instructions = [
    require("../ai/routes").VOICE_STYLE,
    runtime.systemPrompt("\n\n" + [extra, appBlock(app, {
      instructions: typeof b.instructions === "string" ? b.instructions : "", context, appTools,
    })].filter(Boolean).join("\n")).replace("THEY ARE TYPING: short paragraphs are fine; still no markdown tables or headings.\n", "THEY ARE SPEAKING: answer in short spoken sentences.\n"),
  ].join("\n\n");

  const serverNames = withAssistantTools ? voiceToolNames(app.scopes || []) : [];
  const serverDecls = serverNames.length ? registry.declarations({ userId: uid, only: serverNames }) : [];
  const tools = [
    ...serverDecls,
    ...appTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
  ];
  const language = cfg.speechLanguage(profile && profile.user && profile.user.preferred_language).slice(0, 2);
  const openai = require("../services/ai/openai");
  let out;
  try {
    out = await openai.realtimeClientSecret({
      language,
      silenceMs: cfg.liveBlock(uid).silenceMs,
      user: uid,
      parallelTools: true,
      voice: typeof b.voice === "string" && b.voice ? b.voice : require("../ai/proxy").DEFAULT_VOICE,
      instructions: instructions.slice(0, 60_000),
      tools,
    });
  } catch (e) {
    throw new ApiError(502, "voice_unavailable", `Voice could not start: ${String(e.message || e).slice(0, 160)}`);
  }
  store.bump(app, "voice_sessions");
  return {
    client_secret: out.value,
    expires_at: out.expiresAt,
    model: out.model,
    connect: {
      webrtc: "https://api.openai.com/v1/realtime/calls",
      websocket: `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(out.model)}`,
    },
    assistant: { name: (profile && profile.assistant && profile.assistant.name) || "Assistant" },
    assistant_tools: serverNames.filter((n) => serverDecls.some((d) => d.name === n)),
    app_tools: appTools.map((t) => t.name),
  };
}

/**
 * Runs one assistant tool for an app (a voice session's function call, or
 * an app with the "tools" scope acting directly). `userText` is what the
 * user just said, which is what a memory write is checked against.
 */
async function callTool({ app, user, body, tzOffsetMin = null }) {
  const b = body && typeof body === "object" ? body : {};
  const name = String(b.name || "").trim();
  const tool = registry.get(name);
  const scopes = app.scopes || [];
  const allowed = apiTool(tool, scopes) && (
    scopes.includes("tools") || (scopes.includes("voice") && voiceToolNames(scopes).includes(name)));
  if (!allowed) throw new ApiError(404, "unknown_tool", `"${name}" is not an assistant tool this app may use. GET /v1/tools lists them.`);
  const offered = registry.declarations({ userId: Number(user.id), only: [name] });
  if (!offered.length) throw new ApiError(409, "tool_unavailable", `"${name}" is not available on this account right now.`);
  const args = b.arguments === undefined ? {} : typeof b.arguments === "string" ? safeParse(b.arguments) : b.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new ApiError(400, "bad_arguments", "arguments must be a JSON object");

  const crypto = require("crypto");
  const sessionState = require("../agents/sessionState");
  const sid = `api:${app.slug}`;
  const state = sessionState.begin(user.id, sid, { surface: `app:${app.slug}` });
  const userText = String(b.user_text || "").slice(0, 500);
  const turnId = crypto.randomUUID();
  if (userText) sessionState.beginTurn(state, { turnId, text: userText, quality: "clear" });
  let res;
  try {
    res = await registry.execute(name, args, {
      userId: Number(user.id), source: `app:${app.slug}`, sessionId: sid, turnId, session: state,
      userText, tzOffsetMin, noDevice: true, connectedApp: { id: app.id, slug: app.slug, name: app.name },
    });
  } catch (e) {
    res = { ok: false, error: String(e.message || e).slice(0, 200) };
  }
  if (res && res.needsConfirmation) {
    return { ok: false, error: "needs_confirmation", result: "This needs the user's yes in the My Assistant app." };
  }
  return res && res.ok
    ? { ok: true, result: res.speak || res.data || "done" }
    : { ok: false, error: (res && res.error) || "failed", ...(res && res.needsArgs ? { missing: res.needsArgs } : {}) };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

/** The transcript of a voice conversation, into the user's conversation memory. */
async function transcript({ app, user, body }) {
  const b = body && typeof body === "object" ? body : {};
  const turns = Array.isArray(b.turns) ? b.turns.slice(0, 100) : [];
  const recent = require("../memory/recent");
  let kept = 0;
  const sessionId = typeof b.session_id === "string" ? b.session_id.slice(0, 80) : `voice:${app.slug}`;
  for (const t of turns) {
    const role = t && (t.role === "assistant" ? "assistant" : t.role === "user" ? "user" : null);
    const text = t && typeof t.text === "string" ? t.text.trim() : "";
    if (!role || !text) continue;
    recent.append(user.id, role, text.slice(0, 1200), { source: `app:${app.slug}`, sessionId, latencyMs: 0 });
    if (role === "user" && (app.scopes || []).includes("memory:write")) {
      try { require("../agents/memory").extractAndStore(user.id, text); } catch (_) {}
    }
    kept++;
  }
  const seconds = Math.max(0, Math.min(Number(b.seconds) || 0, 6 * 3600));
  if (seconds) {
    // The account's voice ledger, where this deployment has one (ai/plans.js).
    let plans = null;
    try { plans = require("../ai/plans"); } catch (_) {}
    if (plans && plans.recordVoice) await plans.recordVoice(user.id, "realtime", seconds);
    await store.bump(app, "voice_seconds", seconds);
  }
  return { ok: true, kept, seconds };
}

module.exports = { openSession, callTool, transcript, voiceToolNames };
