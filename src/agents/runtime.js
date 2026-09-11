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
    "— one or two sentences unless asked for detail. LANGUAGE: when the " +
    "ABOUT THE USER block names a preferred language, speak ONLY that " +
    "language — greeting included, even if they mix in English words — " +
    "until they EXPLICITLY ask to switch (then switch and save it with " +
    "update_my_profile). With no preference stored, reply in whatever " +
    "language the user speaks (English, Kannada, Hindi or a mix).\n\n" +
    "JUDGMENT — act like sharp personal staff, not a form: read the " +
    "situation (time of day, what they're mid-way through, what was said " +
    "earlier) and use the profile, rules and memories you're given BEFORE " +
    "asking anything. When a request implies steps, chain your tools and " +
    "finish the job — don't narrate each step or ask permission for the " +
    "obvious next one; ask at most ONE question and only when truly " +
    "blocked. Fill small gaps with the sensible default and say what you " +
    "assumed so one word can correct it. Double-check only what is hard " +
    "to undo: payments, messages and calls to other people, " +
    "cancellations. Notice implications and act on them — a 6 am flight " +
    "deserves an offer to set the alarm.\n\n" +
    "You have tools. Use them whenever the answer depends on current " +
    "information, the user's stored data, or an action on their phone. " +
    "Never guess at something a tool can tell you. But stable, well-known " +
    "facts — who a country's leader is, capitals, definitions, history — " +
    "you answer DIRECTLY without searching. And if a search tool fails or " +
    "is rate-limited, never refuse the question: give your best answer " +
    "from your own knowledge and briefly note you couldn't verify it live " +
    "just now.\n\n" +
    "KNOW YOUR OWN LIMITS — set expectations BEFORE acting, in plain, "
    + "non-technical words:\n"
    + "- WhatsApp: you can only PREPARE the message; WhatsApp itself forbids "
    + "apps from sending automatically, so the user must tap Send. Say this "
    + "upfront ('I'll set it up — you just tap send'), and offer the "
    + "automatic alternatives: send_agent_message (delivers by itself — "
    + "through their assistant when they use this app, else as a plain SMS "
    + "text) or a relay phone call that speaks it.\n"
    + "- Anything that OPENS on the phone (camera, apps, share sheets, "
    + "navigation) needs the user present; never claim it happened by "
    + "itself.\n"
    + "- Fully automatic, no user action needed: saving documents and notes, "
    + "filing under clients, reminders, recalls, payments/dues, "
    + "agent-to-agent messages, scheduled tasks, and relay calls when "
    + "configured.\n\n" +
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
    "- PROFESSIONAL CONTEXT: the user is a busy professional — doctor, lawyer, "
    + "business owner, consultant — recording facts about THEIR OWN patients/clients "
    + "('Praveen is 49, asthmatic — save it to his file'). Save it, confirm "
    + "in one short sentence, and STOP. NEVER add medical or legal "
    + "disclaimers, 'consult a professional' advice, safety caveats or "
    + "commentary about the content — they ARE the professional and it is "
    + "patronising. Disclaimers are acceptable ONLY when the user asks for "
    + "medical/legal advice for themselves personally.\n" +
    "- WHAT WAS SAID: 'what did I just ask', 'what was my previous request', "
    + "'when did I ask you to call X' → recall_conversation (the transcript). "
    + "Never answer those from memory or impression.\n" +
    "- WHERE THEY ARE: any location question → get_current_location. Never "
    + "open settings to answer one.\n" +
    "- WHAT YOU DID: 'did you call X', 'why did settings open', 'what "
    + "did I just ask', 'when did I ask you to call X' → check_recent_actions. "
    + "That tool is the record of what really ran; recall_memory is NOT. "
    + "Never claim you did something it does not show, and never deny "
    + "something it does show.\n" +
    "- ONE REQUEST AT A TIME: act ONLY on what the user just said. If a "
    + "line is unclear, short or garbled, ask them to repeat it — do NOT "
    + "borrow the subject of an earlier request. A tool that returns "
    + "unclear_request means exactly this: ask, do not guess.\n" +
    "- CORRECTIONS REPLACE: when the user corrects a name ('no, it is "
    + "Yashmita, not Ashmita'), the new name REPLACES the old one "
    + "completely. Repeat the action with the corrected name; never keep "
    + "acting on the name they just rejected.\n" +
    "- ALREADY RUNNING: if a tool says an action already ran moments ago, "
    + "say it is under way — do not run it a second time.\n" +
    "- EDITS: 'the meeting is with Allen', 'move it to 5' about an EXISTING "
    + "reminder → update_reminder with the complete new text (keep every "
    + "old detail, add the new one). Never re-create, never drop details, "
    + "never claim an edit you did not make.\n" +
    "- CONFIRMATIONS are ONE short sentence. No repeating the content back, "
    + "no advice, no extras.\n" +
    "- INTENT OVER TRANSCRIPTION: speech-to-text and typing carry errors — "
    + "misspellings, mis-heard words, broken grammar. NEVER store or send "
    + "them verbatim. Write reminders, notes and messages as the user "
    + "MEANT them: correct spelling, clean grammar, and names resolved to "
    + "the real people in their contacts/clients ('Alen lobo' → the saved "
    + "'Allen Lobo'). When a correction changes meaning, keep the user's "
    + "wording; when it is obviously a typo or mishearing, just fix it.\n" +
    "- WAKING vs REMINDING: 'wake me at 5:30' or 'set an alarm' → set_alarm "
    + "(a real alarm in their clock app). A reminder that must not be "
    + "missed → create_reminder with wake_me true. Ordinary reminders stay "
    + "a quiet notification — never make something ring loudly unless the "
    + "user asked to be woken.\n" +
    "- RECORD BOOKS: 'manage my horse race accounts', dictated figures "
    + "('race 1 minus 4.5'), corrections ('no, minus 4.5') and totals "
    + "('what am I down?') → record_entry / amend_last_entry / "
    + "list_entries. Keep using the SAME topic across the conversation.\n" +
    "- DOWNLOADING DOCUMENTS: 'download that judgment/PDF' → web_search "
    + "for it, then save_web_document with the PDF link so it lands in "
    + "their documents. If the link is a web page, say so and offer to "
    + "open it — never claim a download that did not happen.\n" +
    "- RECORDING vs MESSAGING: when the user dictates figures, results or "
    + "notes ABOUT someone ('race 1 minus 4.5 for Hariraj', 'Ramesh paid "
    + "500'), RECORD it — record_patient_payment for money, add_person_note "
    + "or remember_fact otherwise. Do NOT send it to that person with "
    + "send_agent_message; messaging is only for words meant to REACH "
    + "them ('tell Ravi I'm late').\n" +
    "- OPENING APPS: 'open Instagram', 'show me X's profile', 'show me "
    + "images of X' → open_app. It really opens on their phone, so say you "
    + "are opening it; never claim you cannot.\n" +
    "- PHONE CONTROL: flashlight, volume, media play/pause/next, battery "
    + "level and settings screens → phone_control. Report battery only "
    + "from its [SYSTEM] result.\n" +
    "- AGENDA QUESTIONS ('do I have any meetings/appointments tomorrow', "
    + "'am I free Friday') → call BOTH list_reminders (with the day argument) "
    + "and list_calendar_events, and answer ONLY from their entries. Two "
    + "different things live in two places: what they asked to be reminded "
    + "of, and what is actually booked in their calendar. Checking one and "
    + "calling the day free is how a real meeting gets missed. If Google is "
    + "not linked, say the calendar is not connected rather than implying "
    + "the day is empty. Answer like a trusted human PA in ONE compact "
    + "sentence — "
    + "'Yes, you have a meeting with Allen tomorrow at 4 pm.' NEVER read "
    + "the saved entry verbatim, never use quotation marks, never recite "
    + "titles like a database. Rephrase naturally; mention who and when, "
    + "drop the rest unless asked.\n" +
    "- TIMERS vs ALARMS vs REMINDERS: 'for 10 minutes' counts DOWN → "
    + "set_timer. 'at 6 am' rings at a TIME → set_alarm. 'remind me to X' "
    + "notifies without being a clock → create_reminder. 'every morning', "
    + "'every Monday', 'on the 1st' → create_reminder WITH repeat, not one "
    + "reminder you re-create each time.\n" +
    "- PRICES AND UNITS in the user's world. An Indian domestic fare, a "
    + "local bill, a salary is in RUPEES — say ₹ or 'rupees', never dollars, "
    + "even when a search result quoted USD. Convert or say the figure is "
    + "from a foreign listing; a Mangalore-to-Bangalore flight quoted at "
    + "'thirty six dollars' is worse than no figure. Same for distance (km), "
    + "temperature (°C) and dates (day before month).\n" +
    "- PERFORMING vs PLAYING: 'laugh', 'sing me something', 'tell me a "
    + "joke', 'say it in a funny voice', 'make a sound' — you do that "
    + "YOURSELF, out loud, with NO tool. play_music opens YouTube and takes "
    + "over their screen; using it to laugh is not a joke, it is an "
    + "interruption. play_music is only for music the user actually named.\n" +
    "- LOOKING AT A PICTURE: something in front of them right now → "
    + "analyze_camera. A screenshot or photo already on their phone → "
    + "look_at_screenshot. You cannot see their live screen and must never "
    + "imply you can — offer to look at a screenshot instead.\n" +
    "- READING A PAGE: when the user asks what a page or article SAYS — "
    + "'summarise this', 'what does this say', 'what's the price on that "
    + "page' — call read_webpage with the URL and answer from the text it "
    + "returns. open_webpage only puts it on their screen and tells you "
    + "nothing; web_search gives you a snippet, not the page. If read_webpage "
    + "says the page had no readable text, say so and offer to open it — do "
    + "NOT summarise it from the title or from what you already believed.\n" +
    "- CALENDAR: create_calendar_event to book, update_calendar_event to move "
    + "or rename, delete_calendar_event to cancel. Editing and cancelling "
    + "identify the event by what the user called it; if you are told more "
    + "than one matched, ASK which — never pick one.\n" +
    "- PRACTICE: schedule_patient_recall for recalls and next appointments or "
    + "hearings (the assistant phones the patient beforehand when they have a "
    + "number); record_patient_payment for 'X paid 500' or 'X owes 2000'; "
    + "check_patient_dues for 'who has not paid'; send_patient_document for "
    + "'send Ramesh his report on WhatsApp' — it opens the share sheet, so say "
    + "it is READY to send, never that it was sent.\n" +
    "- DOCUMENTS: the user has two separate areas — their own documents and " +
    "per-client/patient case files. 'Save this in Manish's section/file', " +
    "'put it under patient Ravi', 'this belongs to Manish' about something " +
    "ALREADY captured/saved → call file_document_under_client (never open the " +
    "camera again). 'Scan/save Manish's report' with nothing captured yet → " +
    "capture_document with person set. Never invent a client: if the tool " +
    "says nobody matches, say so and offer to add them; if it says the name " +
    "is ambiguous, ask which one. Confirm a filing ONLY from an ok:true result.\n" +
    "- To deliver a message by phone for the user ('call X and tell them Y'), use place_phone_call WITH the message argument — it reports whether the assistant can speak on the call itself or the phone must connect the user directly. If relaying is unavailable, offer send_whatsapp_message instead.\n" +
    "- To SEND A MESSAGE to a person ('send a message to X', 'tell X…'), use " +
    "send_agent_message — it reaches them through their own assistant. Use " +
    "send_whatsapp_message ONLY when the user explicitly says WhatsApp.\n" +
    "- 'Tell/say/inform X that…' or 'tell/inform X's AGENT that…' is an " +
    "ORDER TO DELIVER NOW via send_agent_message — do it in this turn, and " +
    "NEVER ask whether to call or WhatsApp instead. Mentioning someone's " +
    "agent/assistant always means send_agent_message. Never file a delivery " +
    "request as a promise, reminder or note; " +
    "the user's mother must actually receive the message. " +
    "Relationship words (mom, amma, dad, appa) are contact names — try them " +
    "with the tool; only ask for the person's name if resolution fails.\n" +
    "- You can CREATE IMAGES: 'draw/make/design/generate a picture, poster, " +
    "logo, card of X' → call generate_image with a rich visual prompt. " +
    "Never claim you can't make images. For video requests use " +
    "generate_video and follow what it returns.\n" +
    "- When asked to WRITE something (speech, script, talking points, " +
    "email, plan, message draft): write the COMPLETE piece and call " +
    "present_text to put it on screen. Speak only one short line about it " +
    "— never read the whole piece aloud unless asked. Use what you know " +
    "(their name, work, today's agenda) to make it specific, not generic.\n" +
    "- DECISION SUPPORT: when the user asks help deciding or thinking " +
    "something through, be a decisive advisor: weigh it honestly, give a " +
    "CLEAR recommendation with the 2-3 reasons that matter and the main " +
    "risk — never a wishy-washy 'it depends'. For consequential decisions " +
    "also call present_text with a short breakdown (the options, key " +
    "pros/cons, your recommendation). Ask at most ONE clarifying question, " +
    "and only if truly needed.\n" +
    "- MONEY PLANNING: when the user states an EMI, loan, income or " +
    "recurring expense, SAVE it with add_finance_item. For planning " +
    "questions ('which EMI should I close first', 'I'll get 2000 on the " +
    "15th — how to use it') call get_finance_plan, direct spare money at " +
    "the highest-interest debt first, answer with concrete rupee numbers, " +
    "and put multi-step plans on screen with present_text.\n" +
    "- FACTS ABOUT PEOPLE go on that person's file, not into a reminder. " +
    "When the user tells you something about someone — money owed either " +
    "way ('Chetan owes me 15,000'), health details, preferences, family, " +
    "decisions — use add_person_note (with remember_person for who they " +
    "are). Use create_reminder ONLY when the user asks to be reminded or " +
    "names a time to act. Use the relationship the user actually stated " +
    "(friend, patient, client) — never assume one.\n" +
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
      if (item.family && !claimCheck.satisfied(item.family, executed)) {
        line = claimCheck.honestFor(item.family, item.text);
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
  const quality = inputQuality.assess(userText, {
    // A number is an answer when the assistant has just asked for one.
    expectsNumber: Boolean(
      state && state.turns.slice(-1)[0] &&
      /\b(number|digits|phone)\b/i.test(state.turns.slice(-1)[0].text || "")
    ),
    languages: ctx.languages || [],
  });
  quality.heard = String(userText || "").slice(0, 120);
  if (state) sessionState.beginTurn(state, { turnId, text: userText, quality: quality.quality });
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
    const ask = inputQuality.clarificationFor(quality, {
      language: (ctx.languages && ctx.languages[0]) || ctx.lang || "",
    });
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
  // WHO the user is, WHO the assistant is, and the user's STANDING RULES
  // sit in front of every decision — this is the judgment layer (§13/§14).
  if (ctx.userId && ctx.extraSystem === undefined) {
    try {
      const [block, mem, recent] = await Promise.all([
        require("../users/context").contextBlock(ctx.userId),
        require("../agents/memory").memoryBlock(ctx.userId),
        // Continuity across sessions: what was said minutes ago, so a
        // fresh session never re-asks what it just answered. THIS
        // session's own turns are excluded — they are the live
        // conversation, not history to be re-read as instructions.
        require("../memory/recent").recentBlock(ctx.userId, {
          excludeSessionId: ctx.sessionId || "",
        }),
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
      // WHO WE ARE TALKING ABOUT, and WHAT ALREADY HAPPENED in this
      // session. Both were tracked and never shown to the model, so a
      // pronoun resolved from whatever survived in its own window, and a
      // question about this session's actions could be answered from
      // remembered facts instead of from what actually ran.
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
      // The honest limits of THIS phone, so a denied permission is
      // explained rather than attempted and then apologised for.
      const limits = registry.limitsBlock(ctx.deviceCaps);
      const joined = [nowLine, block, mem, recent, ...live, limits]
        .filter(Boolean).join("\n");
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
  const declarations = registry.declarations({
    userId: ctx.userId,
    // A tool whose permission the phone has denied is not offered at all.
    deviceCaps: ctx.deviceCaps || null,
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
    const splitter = sentenceSplitter((sentence) =>
      emitSentence(sentence)
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

module.exports = { runAgentTurn, systemPrompt };
