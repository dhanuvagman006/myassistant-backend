/**
 * AGENT RUNTIME — the decision-making layer (§37).
 *
 * Replaces the regex chain in assistant/routes.js. One loop handles every
 * request, whatever the channel (voice, text, live, avatar):
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

const MAX_TOOL_ROUNDS = 3; // guards against a tool-calling loop

function systemPrompt(extra = "") {
  return (
    "You are the user's personal assistant — warm, quick-witted, from India. " +
    "(Your name and identity are provided below when configured.) " +
    "You are having a SPOKEN conversation, so keep replies short and natural " +
    "— one or two sentences unless asked for detail. Reply in whatever " +
    "language the user speaks (English, Kannada, Hindi or a mix).\n\n" +
    "You have tools. Use them whenever the answer depends on current " +
    "information, the user's stored data, or an action on their phone. " +
    "Never guess at something a tool can tell you. But stable, well-known " +
    "facts — who a country's leader is, capitals, definitions, history — " +
    "you answer DIRECTLY without searching. And if a search tool fails or " +
    "is rate-limited, never refuse the question: give your best answer " +
    "from your own knowledge and briefly note you couldn't verify it live " +
    "just now.\n\n" +
    "CRITICAL HONESTY RULES:\n" +
    "- If a tool fails, say plainly what failed. Never pretend it worked.\n" +
    "- If a tool reports that an integration is not configured, do NOT " +
    "describe it to the user as a technical error. Try another route — " +
    "web_search, consult_knowledge — and only say you cannot help if there " +
    "genuinely is no other way.\n" +
    "- Phone calls and camera open ON THE USER'S DEVICE. Say you are " +
    "starting it, never that it is done.\n" +
    "- If you need a detail to run a tool (a city, a date, a name), ask one " +
    "short question instead of guessing.\n" +
    "- NEVER end your reply promising to look something up ('one moment, " +
    "let me check') without actually calling the tool in this same turn. " +
    "Say the short line AND make the call together; the promise alone " +
    "leaves the user waiting for an answer that never comes.\n" +
    "- RULES vs FACTS. consult_knowledge answers questions about RULES, " +
    "RIGHTS, LAWS and official PROCEDURES. It must NOT be called for live " +
    "facts — flight or train timings, prices, availability, weather, news, " +
    "opening hours. Those are search questions. Asking it for flight times " +
    "returns transport LAW, which is not what the user wanted.\n" +
    "- On law, government paperwork, tax and health, never answer from your " +
    "own memory: call consult_knowledge and answer only from what it " +
    "returns. In particular India replaced the IPC, CrPC and " +
    "Evidence Act with the BNS, BNSS and BSA on 1 July 2024, so your " +
    "recollection of section numbers is out of date — 'Section 420' and " +
    "'Section 302' no longer exist. A wrong citation is worse than saying " +
    "you don't know.\n" +
    extra
  );
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
  // WHO the user is, WHO the assistant is, and the user's STANDING RULES
  // sit in front of every decision — this is the judgment layer (§13/§14).
  if (ctx.userId && ctx.extraSystem === undefined) {
    try {
      const block = await require("../users/context").contextBlock(ctx.userId);
      if (block) ctx = { ...ctx, extraSystem: "\n\n" + block };
    } catch (_) {}
  }
  // Built-ins plus ONLY this user's MCP tools (§6). One selection path for
  // both sources — the runtime does not know MCP exists (§1).
  const declarations = registry.declarations({ userId: ctx.userId });
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
    const splitter = sentenceSplitter((sentence) =>
      onEvent("sentence", { text: sentence })
    );
    let out;
    try {
      out = await generateWithToolsStream({
        contents,
        system: systemPrompt(ctx.extraSystem || ""),
        declarations,
        onDelta: (d) => splitter.push(d),
      });
    } catch (e) {
      // Streaming hiccuped — the turn must survive, so fall back to the
      // non-streaming call and deliver its text as sentences the same way.
      out = await generateWithTools({
        contents,
        system: systemPrompt(ctx.extraSystem || ""),
        declarations,
      });
      if (out.text) splitter.push(out.text);
    }
    splitter.finish();
    if (out.text) spoken.push(out.text.trim());

    if (!out.functionCalls.length) {
      return {
        text: spoken.join(" ").trim(),
        deviceActions,
        toolResults,
      };
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
        return {
          text: "",
          needsConfirmation: {
            tool: res.tool,
            args: res.args,
            summary: res.summary,
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

      responseParts.push({
        functionResponse: { name: call.name, response: payload },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  // Ran out of rounds — answer with whatever was said/produced rather
  // than looping forever.
  const last = toolResults[toolResults.length - 1];
  return {
    text: spoken.join(" ").trim() || (last && last.speak ? last.speak : ""),
    deviceActions,
    toolResults,
  };
}

module.exports = { runAgentTurn, systemPrompt };
