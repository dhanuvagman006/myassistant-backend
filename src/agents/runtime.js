/**
 * AGENT RUNTIME — the decision-making layer (§37).
 *
 * Replaced the regex chain of the old /assistant loop. One loop handles
 * every turn the SERVER runs — scheduled tasks, the home-screen widget,
 * deep research, reminder calls. (Since 2026-09-29 the app's own
 * conversation runs its models itself, through Firebase AI Logic, and
 * reaches this server as tools: src/ai/.)
 *
 *   context → model reasons over TOOL DECLARATIONS → executes chosen tools
 *   → feeds results back → model composes the spoken answer
 *
 * The model decides. There is no per-capability `if` here, which is the
 * whole point: a phrasing nobody anticipated still routes correctly.
 *
 * Honest by construction (§27/§28):
 *   • a failed tool is reported as failed, in the reply
 *   • a device action is described as STARTING, never as completed
 *   • a high-risk action pauses for confirmation before running
 */
const registry = require("../tools/registry");
const { registerBuiltins } = require("../tools/builtins");
const {
  generateWithTools,
  generateWithToolsStream,
} = require("../services/ai/router");
const { sentenceSplitter } = require("./sentences");

registerBuiltins();
// The multi-step task tool registers alongside the builtins so both agent
// surfaces — the classic turn loop and the live proxy — are offered the
// same set. Registering it anywhere later would have declared it on one
// path and not the other, which is the exact bug the comment in server.js
// records about registerBuiltins itself.
require("./taskTools").registerTaskTools();

const MAX_TOOL_ROUNDS = 3; // guards against a tool-calling loop

/**
 * HOW LONG A BACKGROUND TURN MAY TAKE.
 *
 * MEASURED on this VPS, 2026-09-20: one tool turn is dominated by the
 * TOOL CATALOGUE, not the prompt — 5 declarations answer in ~10 s, all
 * 107 (84 KB of schemas) take ~26 s, and ~30 s once the full system
 * prompt is added. Thirty seconds is exactly the interactive timeout, so
 * EVERY scheduled task died on its first model call: the job was marked
 * failed, and the call it existed to place was never dialled. Found by
 * queueing a real one and watching it abort 25 s in.
 *
 * A background turn has nobody waiting on it — a 4 a.m. wake-up call does
 * not care whether the model took 10 s or 60 s, only whether it finished.
 * Interactive turns keep the shorter budget, where latency is the product.
 */
/**
 * WHAT A BACKGROUND TURN IS EVEN ALLOWED TO SEE.
 *
 * MEASURED 2026-09-20: the tool catalogue, not the prompt, is what makes a
 * turn slow — 104 declarations are 81 KB and ~26 s, which is why every
 * scheduled task used to die on the 30 s timeout. Two thirds of that
 * weight is tools that CANNOT RUN with nobody holding the phone: opening
 * an app, the camera, navigation, an alarm, the screen. The handler
 * already has to apologise for those after the fact ("part of this needed
 * your phone in hand"), so offering them at 4 a.m. buys a slower turn and
 * a worse answer.
 *
 * Dropping them leaves 71 tools and ~50 KB. The three device tools kept
 * are the ones whose real work happens on the SERVER: the relay places
 * the call itself, and generated images and video are rendered and filed
 * server-side. Everything a background task can actually finish, it can
 * still see.
 */
const BACKGROUND_DEVICE_TOOLS = new Set([
  "place_phone_call",
  "generate_image",
  "generate_video",
]);

const BACKGROUND_TURN_TIMEOUT_MS =
  Number(process.env.BACKGROUND_TURN_TIMEOUT_MS) || 90_000;


function systemPrompt(extra = "", { appBuild } = {}) {
  // One prompt for every path since 2026-10-02 (ai/voicePrompt.js); the
  // 36,000-character rule list that lived here is gone. The assistant's
  // name and the user's profile arrive in `extra` (YOUR IDENTITY, HOW TO
  // ADDRESS), with what the tools returned and the time.
  const vp = require("../ai/voicePrompt");
  return vp.assistantRules("the assistant", "") +
    "\n\nTHEY ARE TYPING: short paragraphs are fine; still no markdown tables or headings.\n" + extra;
}

/**
 * WHO the user is, WHO the assistant is, their STANDING RULES, what is
 * remembered, the earlier conversation, their clock, who this session is
 * about and what already ran in it, and the honest limits of this phone —
 * the judgment layer (§13/§14) every text turn is given. Shared with the
 * app's cloud model (src/ai/context.js), which is handed the same block.
 *
 * @param ctx   { userId, lat, lng, tzOffsetMin, appBuild, sessionId, deviceCaps }
 * @param state this session's sessionState, or null
 * @returns the joined block (no leading blank line), or ""
 */
async function contextExtra(ctx, state) {
  const sessionState = require("../agents/sessionState");
  const [block, mem, recent, episodes] = await Promise.all([
    require("../users/context").contextBlock(ctx.userId, { lat: ctx.lat, lng: ctx.lng, tz: ctx.tzOffsetMin, appBuild: ctx.appBuild }),
    // The app's turns (ai/context.js) pass the user's words: only the facts
    // that fit them are sent (2026-09-30). Everyone else gets them all.
    require("../agents/memory").memoryBlock(ctx.userId,
      ctx.memoryWords === undefined ? undefined : { words: ctx.memoryWords }),
    // Continuity across sessions: what was said minutes ago, so a
    // fresh session never re-asks what it just answered. THIS
    // session's own turns are excluded — they are the live
    // conversation, not history to be re-read as instructions.
    require("../memory/recent").recentBlock(ctx.userId, {
      excludeSessionId: ctx.sessionId || "",
    }),
    // What was talked about on earlier days (memory/episodes.js).
    require("../memory/episodes").block(ctx.userId).catch(() => ""),
  ]);
  // The user's clock, so "tomorrow 5 pm" resolves in THEIR zone and
  // tool datetimes carry the right offset (bare ones read as UTC).
  const tz = Number.isFinite(ctx.tzOffsetMin) ? ctx.tzOffsetMin : 330;
  const sign = tz < 0 ? "-" : "+";
  const abs = Math.abs(tz);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const nowLine =
    `Current date and time for the user: ` +
    `${new Date(Date.now() + tz * 60_000).toISOString().replace("T", " ").slice(0, 16)} (UTC${off}). ` +
    `When passing any datetime to a tool, use the user's LOCAL time with ` +
    `this offset written explicitly, e.g. 2026-09-04T17:00:00${off}.`;
  const live = sessionLines(state);
  // The honest limits of THIS phone, so a denied permission is
  // explained rather than attempted and then apologised for.
  const limits = registry.limitsBlock(ctx.deviceCaps);
  // The clock LAST (2026-09-30): it changes every minute, and anything
  // after it could never be part of the prompt prefix Gemini caches.
  return [limits, block, mem, recent, ...live, nowLine]
    .filter(Boolean).join("\n");
}

/**
 * WHO WE ARE TALKING ABOUT, and WHAT ALREADY HAPPENED in this session.
 * Both were tracked and never shown to the model, so a pronoun resolved
 * from whatever survived in its own window, and a question about this
 * session's actions could be answered from remembered facts instead of
 * from what actually ran.
 */
function sessionLines(state) {
  const sessionState = require("../agents/sessionState");
  const live = [];
  const who = state && sessionState.activeEntity(state);
  if (who) {
    live.push(
      `CURRENTLY TALKING ABOUT: ${who.name}` +
      (who.phone ? ` (${who.phone})` : "") +
      `. "her", "him", "them", "that number" mean this person until the ` +
      `user names someone else. If the user corrects the name, the ` +
      `correction wins immediately — do not act on the old one.`
    );
  }
  const doneHere = state ? sessionState.executedThisSession(state) : [];
  if (doneHere.length) {
    live.push(
      "ALREADY DONE IN THIS SESSION (from the execution record, not memory — " +
      "answer questions about what you did from THIS list, and do not repeat these):\n" +
      doneHere.slice(-8).map((e) =>
        `- ${e.tool}${e.target ? ` → ${e.target}` : ""}${e.ok ? "" : " (FAILED)"}`
      ).join("\n")
    );
  }
  return live;
}

/**
 * Runs one turn.
 *
 * @param {string} userText   what the user said
 * @param {object} ctx        { userId, city, lat, lng, history[], approved,
 *                              pendingCall }
 * @param {function} onEvent  optional progress hook: ("tool_start"|"tool_done", payload)
 * @returns {{ text, deviceActions[], toolResults[], needsConfirmation? }}
 */
async function runAgentTurn(userText, ctx = {}, onEvent = () => {}) {
  // What they actually said, for tools that must honour it word for word.
  ctx.userText = String(userText || "").slice(0, 500);
  // Response-time measurement for the admin panel: wall clock from the
  // moment the turn enters the runtime to the moment its answer is ready.
  const turnStartedAt = Date.now();
  // One id shared by this turn's question and its answer, so the admin
  // panel can never pair an answer with somebody else's question.
  const turnId = require("crypto").randomUUID();

  // ── SPEECH GATE ───────────────────────────────────────────────────
  // The model writes its prose and its tool calls in the SAME breath,
  // and the prose reaches the user's ear first. "Opening Instagram…"
  // was therefore spoken before — and sometimes instead of — any tool
  // running. A sentence that ASSERTS a world action is held until the
  // matching tool has actually run; narration streams as before, so
  // nothing slows down. Held sentences are released in order, corrected
  // if the action never happened.
  const held = [];
  let holding = false;
  const emitSentence = (text) => {
    if (!text || !text.trim()) return;
    const family = require("./claimCheck").classify(text);
    if (!holding && !family) {
      onEvent("sentence", { text });
      return;
    }
    holding = true;
    held.push({ text, family });
  };
  const flushHeld = (executed) => {
    if (!held.length) {
      holding = false;
      return;
    }
    const claimCheck = require("./claimCheck");
    for (const item of held) {
      let line = item.text;
      // The sentence and what ran go in too: a queued video note backs
      // "it's being made" but never "I've sent it" (2026-09-26).
      if (item.family && !claimCheck.satisfied(item.family, executed, item.text)) {
        line = claimCheck.honestFor(item.family, item.text, executed);
      }
      onEvent("sentence", { text: line });
    }
    held.length = 0;
    holding = false;
  };

  // ── TURN STATE ────────────────────────────────────────────────────
  // Five separate things, never mixed: this turn, the conversation, the
  // remembered facts, what is pending, what has run. A session that did
  // not exist a moment ago starts EMPTY — no inherited pending action.
  const sessionState = require("../agents/sessionState");
  const inputQuality = require("../agents/inputQuality");
  const claimCheck = require("../agents/claimCheck");
  // A SESSION KEY IS NEVER SHARED. Falling back to a per-user constant
  // meant every caller that omitted a session id landed in the same state
  // object — which is the one thing this state machine exists to prevent.
  // A caller with no session of its own gets a fresh one per turn.
  const sid = ctx.sessionId || `turn:${ctx.userId || 0}:${turnId}`;
  const state = ctx.userId ? sessionState.begin(ctx.userId, sid, {
    surface: ctx.source || (ctx.background ? "background" : "voice"),
    appBuild: ctx.appBuild,
  }) : null;
  // A number, a name or one offered word is an ANSWER when the assistant
  // has just asked for it ("How old is she turning?" → "25"): read from
  // its last line (inputQuality.expectationsFrom, 2026-09-26).
  const lastLine = state && state.turns.slice(-1)[0];
  // The names of their shortcuts (build 120+): said whole, "pooja mode" is
  // a clear command, and it is routed below before the model.
  const shortcutKeys = ctx.userId && !ctx.background && Number(ctx.appBuild) >= 120 &&
    process.env.SHORTCUTS !== "off"
    ? await require("../shortcuts/match").keysFor(ctx.userId).catch(() => [])
    : [];
  const quality = inputQuality.assess(userText, {
    ...inputQuality.expectationsFrom(lastLine && lastLine.role === "assistant" ? lastLine.text : ""),
    languages: ctx.languages || [],
    known: shortcutKeys,
  });
  quality.heard = String(userText || "").slice(0, 120);
  if (state) sessionState.beginTurn(state, { turnId, text: userText, quality: quality.quality });
  // The phone's own card lines ("[SYSTEM] Signature saved…; it is on the
  // card now") run no tool, yet what they report is true: filed for the
  // claim check, so "Done, it's on the card" is not rewritten (2026-09-26).
  if (state) {
    for (const tool of claimCheck.appNoteVouches(userText)) sessionState.noteVouched(state, { turnId, tool });
  }
  ctx = { ...ctx, session: state, turnId, sessionId: sid, inputQuality: quality };

  // ── GARBLED IN, CLARIFICATION OUT ─────────────────────────────────
  // The tool gate catches a bad transcript only if the model happens to
  // reach for a world action. A fragment that produced no tool call was
  // answered freely — which is how "con" became a confident reply about
  // the previous conversation's contact. Nothing is worth generating from
  // a transcript this poor, so the turn ends here with a question.
  //
  // Deliberately only the WORST tier: "weak" input is often a real short
  // command ("louder", "next one"), and refusing those would be its own
  // failure.
  if (quality.quality === "garbled" && !ctx.background && !ctx.approved) {
    // "Sorry, I didn't catch that" IN ENGLISH, TO A HINDI SPEAKER, is
    // its own small failure — and until now the only value reaching here
    // on this surface was empty, so the Hindi, Kannada and Tulu
    // clarifications in inputQuality were unreachable from the text path.
    // Read only on a garbled turn, which is rare, so the hot path is
    // untouched.
    let clarifyIn = (ctx.languages && ctx.languages[0]) || ctx.lang || "";
    if (!clarifyIn && ctx.userId) {
      clarifyIn = await require("../users/context").getProfile(ctx.userId)
        .then((p) => (p && p.user && p.user.preferred_language) || "")
        .catch(() => "");
    }
    const ask = inputQuality.clarificationFor(quality, { language: clarifyIn });
    onEvent("sentence", { text: ask });
    if (state) sessionState.recordReply(state, ask);
    try {
      const recentMem = require("../memory/recent");
      const meta = {
        source: ctx.source || (ctx.background ? "background" : "voice"),
        appBuild: ctx.appBuild, turnId, sessionId: sid,
      };
      recentMem.append(ctx.userId, "user", userText, { ...meta, latencyMs: 0 });
      recentMem.append(ctx.userId, "assistant", ask, {
        ...meta, latencyMs: Date.now() - turnStartedAt,
      });
      // Observable: a turn that was deliberately refused is a decision,
      // and "why did nothing happen?" needs an answer other than silence.
      require("../actions/store").record(ctx.userId, {
        sessionId: sid, turnId, tool: "clarify", args: { heard: quality.heard },
        ok: true, world: false, intent: userText,
        detail: `input ${quality.reason || "garbled"}`, result: ask,
        surface: ctx.source || "voice",
      });
    } catch (_) {}
    return { text: ask, deviceActions: [], toolResults: [], clarified: true };
  }

  // ── A SHORTCUT'S NAME, SAID WHOLE, RUNS IT ────────────────────────
  // "office mode" (or "start office mode please") goes straight to
  // run_shortcut with one fixed sentence back — except as the ANSWER to a
  // question just asked, or while a yes/no is pending: "Which shortcut
  // should I delete?" answered "office mode" must never run it.
  if (shortcutKeys.length && !ctx.approved) {
    const match = require("../shortcuts/match");
    const guarded = match.answerGuard(
      lastLine && lastLine.role === "assistant" ? lastLine.text : "",
      !!(state && state.pending && Date.now() - state.pending.askedAt < sessionState.PENDING_TTL_MS)
    );
    const sc = guarded ? null : await match.exactFor(ctx.userId, userText).catch(() => null);
    if (sc) {
      const res = await registry.execute("run_shortcut", { name: sc.name }, ctx)
        .catch((e) => ({ ok: false, error: String(e.message || e) }));
      const recentMem = require("../memory/recent");
      const meta = { source: ctx.source || "voice", appBuild: ctx.appBuild, turnId, sessionId: sid };
      if (res.needsConfirmation) {
        const question = res.summary ? `${res.summary}?` : "Shall I go ahead?";
        if (state) {
          sessionState.setPending(state, { tool: res.tool, args: res.args, summary: res.summary });
          sessionState.recordReply(state, question);
        }
        try {
          recentMem.append(ctx.userId, "user", userText, { ...meta, latencyMs: 0 });
          recentMem.append(ctx.userId, "assistant", question, { ...meta, latencyMs: Date.now() - turnStartedAt, tools: ["run_shortcut"] });
          require("../actions/store").attachReply(ctx.userId, turnId, question);
        } catch (_) {}
        return {
          text: "",
          question,
          turnId,
          needsConfirmation: { tool: res.tool, args: res.args, summary: res.summary },
          deviceActions: [],
          toolResults: [{ name: "run_shortcut", ...res }],
          routed: true,
        };
      }
      const line = res.ok
        ? (res.speak || "Done.")
        : `I couldn't run ${sc.name}: ${res.error || "something went wrong"}.`;
      onEvent("sentence", { text: line });
      if (state) sessionState.recordReply(state, line);
      try {
        recentMem.append(ctx.userId, "user", userText, { ...meta, latencyMs: 0 });
        recentMem.append(ctx.userId, "assistant", line, { ...meta, latencyMs: Date.now() - turnStartedAt, tools: ["run_shortcut"] });
        require("../actions/store").attachReply(ctx.userId, turnId, line);
      } catch (_) {}
      return {
        text: line,
        deviceActions: res.ok && res.deviceAction ? [res.deviceAction] : [],
        toolResults: [{ name: "run_shortcut", ...res }],
        routed: true,
      };
    }
  }

  // WHO the user is, WHO the assistant is, and the user's STANDING RULES
  // sit in front of every decision — this is the judgment layer (§13/§14).
  if (ctx.userId && ctx.extraSystem === undefined) {
    try {
      const joined = await contextExtra(ctx, state);
      if (joined) ctx = { ...ctx, extraSystem: "\n\n" + joined };
    } catch (_) {}
  }
  // Learn durable personal facts from this turn (regex-gated, async) —
  // the same account-level memory every device sees after login.
  if (ctx.userId) {
    try {
      require("../agents/memory").extractAndStore(ctx.userId, userText);
    } catch (_) {}
  }
  // Built-ins plus ONLY this user's MCP tools (§6). One selection path for
  // both sources — the runtime does not know MCP exists (§1).
  // WHICH TOOLS THIS TURN GETS. Two independent narrowings, and both are
  // about the same measured fact: the catalogue, not the prompt, is the
  // latency (81 KB / ~26 s for all of them, ~10 s for a handful).
  //   • background — drop what cannot run with nobody holding the phone
  //   • foreground — offer what THIS turn plausibly needs, and the whole
  //     catalogue whenever that cannot be judged confidently
  // tools/relevance.js carries the reasoning and the fallbacks.
  //
  // After a restart this user's MCP tools are gone from the registry until
  // reconnected — once per process, and never more than 3 s of this turn.
  if (ctx.userId) {
    await require("../mcp/routes").ensureConnectedWithin(ctx.userId).catch(() => {});
    // Whether this user's Notion tools are offered (free until configured).
    await require("../connectors/notion/store").prime(ctx.userId).catch(() => {});
  }
  // "Add it to my Notion" from someone who has not connected it gets an
  // honest line — only on the turns that mention Notion.
  const notionLine = ctx.userId && /\bnotion\b/i.test(userText)
    ? require("../connectors/notion/tools").notionHintFor(ctx.userId, ctx.appBuild) : "";
  if (notionLine) ctx.extraSystem = [ctx.extraSystem || "", notionLine].filter(Boolean).join("\n");
  const only = ctx.background
    ? registry
        .list()
        .filter((t) => !t.deviceAction || BACKGROUND_DEVICE_TOOLS.has(t.name))
        .map((t) => t.name)
    : require("../tools/relevance").selectForTurn(registry.list(), userText, {
        history: ctx.history || [],
        sessionId: ctx.sessionId || "",
      });
  // A user with shortcuts is always offered run_shortcut — never every
  // user (relevance.CORE ships on every turn, and the catalogue is the
  // latency), and a no-signal turn gets the whole catalogue anyway.
  if (Array.isArray(only) && shortcutKeys.length) {
    for (const n of ["run_shortcut", "continue_shortcut"]) if (!only.includes(n)) only.push(n);
  }
  const declarations = registry.declarations({
    userId: ctx.userId,
    // A tool whose permission the phone has denied is not offered at all.
    deviceCaps: ctx.deviceCaps || null,
    only,
  });
  const contents = [];

  // Short conversation context (§18) — recent turns only, never the whole
  // lifetime history.
  for (const m of (ctx.history || []).slice(-8)) {
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "") }],
    });
  }
  contents.push({ role: "user", parts: [{ text: userText }] });

  const deviceActions = [];
  const toolResults = [];
  // Every piece of text the model produced across rounds, in order — a
  // spoken preamble before a tool call ("one second, let me check") is part
  // of the reply, so the transcript must contain it too.
  const spoken = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // STREAMING (voice latency). Text deltas are split into sentences and
    // surfaced through onEvent the moment each completes, so the app can
    // start speaking sentence 1 while the rest of the reply — or a tool
    // call — is still generating. This is what turns "wait five seconds,
    // then hear everything" into a conversation.
    // What this round has actually said out loud, sentence by sentence.
    const heard = [];
    const speakTo = () => sentenceSplitter((sentence) => {
      heard.push(sentence);
      emitSentence(sentence);
    });
    let splitter = speakTo();
    let out;
    try {
      out = await generateWithToolsStream({
        contents,
        system: systemPrompt(ctx.extraSystem || "", { appBuild: ctx.appBuild }),
        declarations,
        timeoutMs: ctx.background ? BACKGROUND_TURN_TIMEOUT_MS : 0,
        onDelta: (d) => splitter.push(d),
      });
    } catch (e) {
      // Streaming hiccuped — the turn must survive, so fall back to the
      // non-streaming call and deliver its text as sentences the same way.
      out = await generateWithTools({
        contents,
        system: systemPrompt(ctx.extraSystem || "", { appBuild: ctx.appBuild }),
        declarations,
        timeoutMs: ctx.background ? BACKGROUND_TURN_TIMEOUT_MS : 0,
      });
      // NOT FROM THE TOP. The fallback regenerates the whole reply, and it
      // used to go into the same splitter — so whatever the stream had
      // already spoken was spoken again. The half-sentence the stream left
      // buffered is dropped (it was never heard); then only what follows
      // the heard part is spoken. A reworded fallback adds nothing: saying
      // the same thing twice in different words is still repeating it.
      splitter = speakTo();
      const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
      const full = norm(out.text);
      const already = norm(heard.join(" "));
      if (!already) {
        if (full) splitter.push(full);
      } else if (full.startsWith(already)) {
        splitter.push(full.slice(already.length));
      } else {
        out = { ...out, text: already };
      }
    }
    splitter.finish();
    if (out.text) spoken.push(out.text.trim());

    if (!out.functionCalls.length) {
      {
        flushHeld(state ? sessionState.executedThisTurn(state) : []);
        let finalText = spoken.join(" ").trim();
        // THE REPLY MAY NOT CLAIM WHAT DID NOT RUN. Checked against this
        // turn's executed actions, not against the model's recollection.
        if (state) {
          const verdict = claimCheck.check(finalText, sessionState.executedThisTurn(state));
          if (!verdict.ok) {
            console.warn("claim check corrected a reply:", verdict.violations.join(" | "));
            finalText = verdict.text;
          }
          sessionState.recordReply(state, finalText);
        }
        const recent = require("../memory/recent");
        const meta = {
          latencyMs: Date.now() - turnStartedAt,
          source: ctx.source || (ctx.background ? "background" : "voice"),
          tools: toolResults.map((t) => t.name).filter(Boolean),
          appBuild: ctx.appBuild,
          turnId,
          sessionId: sid,
        };
        // CLOSE THE LEDGER. Every action this turn took now carries the
        // answer the user actually received, so one row shows the whole
        // chain: what was asked, what ran with which arguments, what came
        // back, and what was said.
        try {
          require("../actions/store").attachReply(ctx.userId, turnId, finalText);
        } catch (_) {}
        recent.append(ctx.userId, "user", userText, { ...meta, latencyMs: 0 });
        recent.append(ctx.userId, "assistant", finalText, meta);
        return {
          text: finalText,
          deviceActions,
          toolResults,
        };
      }
    }

    // Record the model's turn (any preamble text plus its tool calls) so
    // the follow-up request has the full context. Each part carries its
    // thoughtSignature back — Gemini 3 rejects the follow-up without it.
    contents.push({
      role: "model",
      parts: [
        ...(out.text
          ? [
              {
                text: out.text,
                ...(out.textSignature
                  ? { thoughtSignature: out.textSignature }
                  : {}),
              },
            ]
          : []),
        ...out.functionCalls.map((c) => ({
          functionCall: { name: c.name, args: c.args },
          ...(c.thoughtSignature
            ? { thoughtSignature: c.thoughtSignature }
            : {}),
        })),
      ],
    });

    const responseParts = [];
    for (const call of out.functionCalls) {
      onEvent("tool_start", { name: call.name, args: call.args });
      const res = await registry.execute(call.name, call.args, ctx);
      toolResults.push({ name: call.name, ...res });
      onEvent("tool_done", { name: call.name, ok: res.ok });

      // High-risk: stop the whole turn and ask the user first (§17).
      if (res.needsConfirmation) {
        // THE TURN STILL HAPPENED. This path used to return silently and
        // write nothing: the user's request and the question asked back
        // were both absent from the transcript, so "what did I just ask
        // you?" could not see them and the only record of the pending
        // action was a field on the SSE session. Record all three.
        const question = res.summary ? `${res.summary}?` : "Shall I go ahead?";
        flushHeld(state ? sessionState.executedThisTurn(state) : []);
        if (state) {
          sessionState.setPending(state, {
            tool: res.tool,
            args: res.args,
            summary: res.summary,
          });
          sessionState.recordReply(state, question);
        }
        try {
          const recentMem = require("../memory/recent");
          const meta = {
            source: ctx.source || (ctx.background ? "background" : "voice"),
            appBuild: ctx.appBuild,
            turnId,
            sessionId: sid,
          };
          recentMem.append(ctx.userId, "user", userText, { ...meta, latencyMs: 0 });
          recentMem.append(ctx.userId, "assistant", question, {
            ...meta,
            latencyMs: Date.now() - turnStartedAt,
            tools: [res.tool],
          });
          require("../actions/store").attachReply(ctx.userId, turnId, question);
        } catch (_) {}
        return {
          text: "",
          question,
          // The turn this question belongs to. The approval arrives on a
          // separate request, and without this the action it authorises
          // cannot be joined back to the request that raised it.
          turnId,
          needsConfirmation: {
            tool: res.tool,
            args: res.args,
            summary: res.summary,
            // WHICH PLAN THIS BELONGS TO, when it belongs to one.
            // A step of a multi-step task stops here like any other
            // high-risk action, but approving it must resume the TASK —
            // re-running the tool on its own would leave the remaining
            // steps blocked forever with no way to reach them.
            task: res.task || undefined,
          },
          deviceActions,
          toolResults,
        };
      }
      if (res.deviceAction) deviceActions.push(res.deviceAction);

      // What the model sees: a compact, TRUTHFUL result.
      const payload = res.ok
        ? { ok: true, result: res.speak || res.data || "done" }
        : res.needsArgs
          ? { ok: false, missing: res.needsArgs }
          : { ok: false, error: res.error || "failed" };
      // A tool's `note` is an instruction ABOUT the result — "this already
      // ran, do not run it again". It was reaching the live path (which
      // forwards the whole envelope) and being dropped here, so the same
      // suppression behaved differently on the two surfaces and the voice
      // path — the one the confirmation flow runs on — flew blind.
      if (res.note) payload.note = res.note;

      responseParts.push({
        functionResponse: { name: call.name, response: payload },
      });
    }
    // The round's actions have run — anything held may now be spoken,
    // corrected against what actually executed.
    flushHeld(state ? sessionState.executedThisTurn(state) : []);
    contents.push({ role: "user", parts: responseParts });
  }

  // Ran out of rounds — answer with whatever was said/produced rather
  // than looping forever.
  flushHeld(state ? sessionState.executedThisTurn(state) : []);
  const last = toolResults[toolResults.length - 1];
  let finalText = spoken.join(" ").trim() || (last && last.speak ? last.speak : "");
  if (state) {
    const verdict = claimCheck.check(finalText, sessionState.executedThisTurn(state));
    if (!verdict.ok) {
      console.warn("claim check corrected a reply:", verdict.violations.join(" | "));
      finalText = verdict.text;
    }
    sessionState.recordReply(state, finalText);
  }
  const recent = require("../memory/recent");
  const meta = {
    latencyMs: Date.now() - turnStartedAt,
    source: ctx.source || (ctx.background ? "background" : "voice"),
    tools: toolResults.map((t) => t.name).filter(Boolean),
    appBuild: ctx.appBuild,
    turnId,
    sessionId: sid,
  };
  try {
    require("../actions/store").attachReply(ctx.userId, turnId, finalText);
  } catch (_) {}
  recent.append(ctx.userId, "user", userText, { ...meta, latencyMs: 0 });
  recent.append(ctx.userId, "assistant", finalText, meta);
  return {
    text: finalText,
    deviceActions,
    toolResults,
  };
}

module.exports = { runAgentTurn, systemPrompt, contextExtra, sessionLines };
