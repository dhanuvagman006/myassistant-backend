/**
 * LIVE MODE — real speech-to-speech via the Gemini Live API.
 *
 * This replaces the whole record → STT → LLM → TTS pipeline with ONE
 * bidirectional stream: the app sends raw PCM (16 kHz mono s16le) up as it
 * is captured, and Gemini's native-audio model streams SPOKEN AUDIO back
 * (24 kHz mono s16le). There is no transcription step, end-of-speech is
 * detected server-side by Google (no client VAD guessing), and barge-in is
 * native: talking over Hari interrupts her mid-word.
 *
 * The API key must never reach the app, so the app connects HERE and this
 * module proxies frames to Google:
 *
 *   app  ──ws──  /live/ws?token=…  ──wss──  BidiGenerateContent
 *
 * Wire protocol with the app (deliberately tiny):
 *   app → server   binary frame        = one PCM16/16k mic chunk
 *   app → server   {"type":"end"}      = user closed the session
 *   server → app   binary frame        = one PCM16/24k audio chunk to play
 *   server → app   {"type":"ready"}                    setup complete
 *   server → app   {"type":"interrupted"}              stop playback NOW
 *   server → app   {"type":"turn_complete"}            Hari finished talking
 *   server → app   {"type":"input_transcript","text"}  what the user said
 *   server → app   {"type":"output_transcript","text"} what Hari said
 *   server → app   {"type":"error","message"}          fatal, then close
 *
 * EXPERIMENTAL and feature-flagged: nothing in the classic /assistant loop
 * is touched. If this path fails on a given key/model, the app keeps
 * working exactly as before.
 */
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const { envModel } = require("../services/ai/router");
const db = require("../db");

const LIVE_MODEL = () =>
  envModel("GEMINI_LIVE_MODEL", "gemini-2.5-flash-native-audio-preview");

const LIVE_VOICE = () => envModel("GEMINI_TTS_VOICE", "Kore");

const GOOGLE_WS =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/// Same auth tiers as the REST middleware, adapted for a WS query string.
function authorize(url) {
  if (process.env.AUTH_DISABLED === "true") return { sub: "anonymous-dev" };
  const token = url.searchParams.get("token") || "";
  if (token) {
    try {
      const { uid } = jwt.verify(token, process.env.JWT_SECRET);
      return { sub: String(uid) };
    } catch (_) {
      return null;
    }
  }
  if (
    process.env.ALLOW_APP_KEY === "true" &&
    process.env.APP_API_KEY &&
    url.searchParams.get("appKey") === process.env.APP_API_KEY
  ) {
    return { sub: "dev" };
  }
  return null;
}

/// The system prompt for live mode. Kept short: the live model speaks, so
/// the TTS-formatting rules from the text prompt don't apply.
function liveSystemPrompt(assistantName = "Hari", unreadMessages = []) {
  let prompt = `You are ${assistantName}, a warm, quick-witted personal voice assistant from India. ` +
    "You are SPEAKING with the user in real time. Speak ENGLISH by default " +
    "(Indian English). Only switch language if the user clearly and " +
    "deliberately speaks another one to you, and then stay in it — never " +
    "drift between languages mid-conversation. Keep replies short and " +
    "conversational, one thought at a time, like a friend on a phone call. " +
    "If you did not clearly hear something, ask them to repeat it rather " +
    "than guessing — answering the wrong question is worse than asking. " +
    "If asked about astrology, use your get_horoscope tool. " +
    // Google Search is opt-in now (see the setup payload), so pointing at
    // it unconditionally would name a tool that is not there. web_search is
    // ours, is measurable, and reports honestly when unconfigured.
    "For current facts you don't know — flight and train timings, prices, " +
    "opening hours, live events — use your search tool (web_search or " +
    "Google Search, whichever you have) and answer from what it returns. " +
    "Never tell the user you are unable to look something up " +
    "without trying search first. " +
    "But for stable, well-known facts — who a country's leader is, " +
    "capitals, definitions, history — answer DIRECTLY from your own " +
    "knowledge; do not spend a search on them. And if a search fails or is " +
    "rate-limited, never refuse the question: give your best answer from " +
    "your own knowledge and briefly note you couldn't verify it live. " +
    // "There are flights tomorrow" is not an answer. If the search cannot
    // produce specifics, saying so plainly is more useful than a vague
    // gesture at the topic.
    "BE SPECIFIC. For flights or trains give actual airlines/operators, " +
    "departure times and approximate fares — a reply like 'there are " +
    "flights tomorrow' is useless. If the search does not give you concrete " +
    "times, say exactly that and tell them where to check, rather than " +
    "padding with vague statements. Never invent a time or a fare. " +
    // Silence during a lookup is indistinguishable from the app being
    // broken. One short spoken line before the pause turns dead air into
    // an obviously-working assistant.
    "IMPORTANT: before you search or call any tool that takes a moment, SAY " +
    "a short line out loud first — 'one second, let me check that', 'give " +
    "me a moment' — then do the lookup, then give the answer. Never go " +
    "silent while you work. " +
    "To deliver a message by phone for me — 'call X and tell them Y' — call place_phone_call WITH the message argument; it handles whether you can speak on the call yourself or must connect me directly. If relaying is unavailable, offer to send it as a WhatsApp message instead. " +
    "To SEND A MESSAGE to someone, use send_agent_message — it reaches them " +
    "through their own assistant with a push. Use send_whatsapp_message ONLY " +
    "if I explicitly say WhatsApp. " +
    "FACTS ABOUT PEOPLE go on that person's file, not into a reminder: " +
    "when I tell you something about someone — money owed either way, " +
    "health details, preferences, family — use add_person_note (with " +
    "remember_person for who they are), tagged with the relationship I " +
    "actually stated (friend, patient, client). Use create_reminder ONLY " +
    "when I ask to be reminded or name a time. " +
    "Never mention being an AI unless directly asked. Decline harmful requests politely and briefly. " +
    // Live mode is the app's MAIN screen, so the legal guard has to exist
    // here too — not only in the SSE runtime. Without it the model answers
    // Indian law from training data that predates the 2024 criminal codes
    // and cites sections that were repealed.
    // consult_knowledge is for RULES, not for facts that change by the
    // hour. This distinction was missing, and the result was absurd: asked
    // for flight timings the assistant pulled up the Motor Vehicles Act and
    // railway refund rules and put them on screen. A personal assistant
    // answers the question asked.
    "Call the consult_knowledge tool ONLY when the user asks about a RULE, " +
    "a RIGHT, a LAW or an official PROCEDURE — 'what's the punishment " +
    "for…', 'what are my rights if…', 'how do I apply for a passport', " +
    "'can they legally…', 'what's the deadline to file…'. " +
    "NEVER call it for live facts: flight or train timings, prices, " +
    "availability, weather, news, opening hours, scores. Those are Google " +
    "Search questions. If in doubt, it is a search question, not a " +
    "knowledge question. " +
    "When you DO answer a legal question: never state a section number, a " +
    "tax slab or a fee from memory. India replaced the IPC, CrPC and " +
    "Evidence Act with the BNS, BNSS and BSA on 1 July 2024, so numbers " +
    "like 'Section 420' and 'Section 302' no longer exist. You give " +
    "information, never advice for the user's own case; you are not their " +
    "lawyer, and you never diagnose or recommend medicines.";

  if (unreadMessages.length > 0) {
    prompt +=
      "\n\nCRITICAL INSTRUCTION: Another person's assistant has passed you " +
      "the messages below for this user. Say them out loud IMMEDIATELY as " +
      "your very first response, and ALWAYS say who each one is from — a " +
      "message delivered without its sender is confusing and useless. " +
      "Relay them naturally, as one person passing on word from another:\n";
    unreadMessages.forEach((m) => {
      const from = m.from_name || "someone";
      prompt += `- From ${from}: "${m.message}"\n`;
    });
  }
  return prompt;
}

/**
 * Bridges one app socket to one Gemini Live session.
 *
 * [deviceCtx] carries what only the handset knows — timezone offset,
 * platform, and (when the app has permission) coordinates — so tools run
 * with the same context they get on the SSE path.
 */
async function bridge(appWs, user, room, deviceCtx = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    appWs.send(JSON.stringify({ type: "error", message: "no API key" }));
    appWs.close();
    return;
  }

  // AVATAR MODE. When the app opened an avatar session it passes that
  // room here, and the assistant's voice goes to the LiveKit room instead
  // of down this socket — BEY republishes it in lockstep with the video,
  // which is what keeps the lips on the words. If attach() returns null
  // (unknown/expired room, or one belonging to another user) we simply
  // stay in audio-only mode rather than failing the call.
  const avatar = room ? require("../avatar/session").attach(room, user?.sub) : null;
  if (room && !avatar) console.warn(`live: avatar room ${room} not attachable — audio only`);
  // The app needs to know whether reply audio is coming down this socket
  // or out of the avatar's track, so its own playback and "speaking"
  // indicator stay honest as BEY comes and goes mid-call.
  if (avatar) {
    avatar.onReadyChange = (ready) => {
      try {
        appWs.send(JSON.stringify({ type: "avatar", ready }));
      } catch (_) {}
    };
    // Tells the app exactly when Hari's voice is in the air, so it can hold
    // the microphone shut for that whole stretch. The app cannot work this
    // out for itself: the audio never reaches it, and the room's own
    // speaker detection turned out to fire only sometimes — leaving the mic
    // muted until a watchdog rescued it.
    if ("onAudioActive" in avatar) {
      avatar.onAudioActive = (speaking) => {
        try {
          appWs.send(JSON.stringify({ type: "avatar_speaking", speaking }));
        } catch (_) {}
      };
    }
  }

  // The assistant's configured name (Settings → Assistant). Resolved per
  // session so a rename applies to the very next live call. Anonymous dev
  // sessions fall back to the default.
  let assistantName = "Hari";
  let unreadMessages = [];
  // The USER's own name, for tools that tell someone else who is calling.
  // Without it, the push notification a recipient sees reads "Message from
  // a friend" — which is the one detail that makes the message useful.
  // First name only, matching the classic assistant path.
  let userName = null;
  try {
    const uid = Number(user?.sub);
    if (Number.isFinite(uid) && uid > 0) {
      const p = await require("../users/context").getProfile(uid);
      if (p?.assistant?.name) assistantName = p.assistant.name;
      if (p?.user?.name) userName = String(p.user.name).split(" ")[0];
      

      // Only a verified number has an inbox; unverified accounts are NULL
      // here, so this simply does not run for them.
      if (p?.user?.phone_number) {
        unreadMessages = await db.query(
          `SELECT m.id, m.message, u.name AS from_name
             FROM agent_messages m
             LEFT JOIN users u ON u.id = m.from_user_id
            WHERE m.status = 'unread' AND m.to_phone_number = $1
            ORDER BY m.created_at ASC`,
          [p.user.phone_number]
        );
        // NOT marked read here. These are marked only once the live session
        // is actually established (see setupComplete): loading them is not
        // delivering them, and a session that fails to start would otherwise
        // consume someone's message and leave it unsaid forever.
      }
    }
  } catch (e) { console.error("Failed to load profile or messages:", e); }

  let upstream;
  let upstreamReady = false;

  // Real user turns seen so far, and the high-risk action awaiting a spoken
  // yes. Together these make the confirmation gate work in live mode: an
  // approval is only honoured on a turn LATER than the one that asked for
  // it. See the toolCall handler.
  let userTurns = 0;
  let pendingApproval = null;
  // Turn-boundary timing, so latency can be measured rather than guessed.
  let speechStartedAt = 0;
  let activityEndAt = 0;
  let repliedAt = 0;
  // True while the assistant is acting as an interpreter rather than an
  // assistant. Tracked so the app can show it and so it survives the turn.
  let interpreting = false;
  // Mic audio that arrives before Google's setupComplete would be lost —
  // buffer a little so the first word is never clipped.
  const pending = [];

  try {
    // Google's documented WS auth is the key as a query parameter (the
    // connection originates from OUR server, so it never reaches the app).
    upstream = new WebSocket(`${GOOGLE_WS}?key=${encodeURIComponent(key)}`);
  } catch (e) {
    appWs.send(JSON.stringify({ type: "error", message: "connect failed" }));
    appWs.close();
    return;
  }

  const closeBoth = (why) => {
    try {
      appWs.close();
    } catch (_) {}
    try {
      upstream.close();
    } catch (_) {}
    if (why) console.log(`live: session closed (${why})`);
    // Ends BEY billing. Fired on every close path, including errors.
    if (room) require("../avatar/session").detach(room);
  };

  upstream.on("open", () => {
    upstream.send(
      JSON.stringify({
        setup: {
          model: `models/${LIVE_MODEL()}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: LIVE_VOICE() },
              },
              // NO languageCode HERE.
              //
              // The native-audio model REJECTS it: adding it closed the
              // session immediately with WebSocket 1007 (invalid payload),
              // so every conversation died at setup. These models pick up
              // language from the audio themselves. The language steering
              // that actually works lives in the system prompt below —
              // "speak English by default, do not drift mid-conversation" —
              // which is what stops Indian-accented English being
              // transcribed into Devanagari.
            },
            // DO NOT send thinkingConfig here.
            //
            // It is valid on the text models (services/ai/router.js sets
            // thinkingBudget: 0 there) but the NATIVE-AUDIO live model
            // rejects it in a way that is almost impossible to debug: the
            // socket stays open, input audio is still transcribed back to
            // us, and generation simply never happens. The user says hello,
            // sees "listening", and waits forever. Measured directly —
            // with it, zero replies; without it, replies in ~2 seconds.
            // Opt in only to re-test that behaviour.
            ...(process.env.LIVE_THINKING_CONFIG === "force"
              ? { thinkingConfig: { thinkingBudget: 0 } }
              : {}),
          },

          // LATENCY: how long a pause means "they've finished talking".
          //
          // Unset, Google's default silence window is long enough to feel
          // broken — the user sits in silence wondering if it heard them.
          // ~600 ms is the sweet spot for conversational speech: short
          // enough to feel instant, long enough not to cut people off
          // mid-sentence. Tune with LIVE_SILENCE_MS if it clips anyone.
          // VOICE ACTIVITY DETECTION.
          //
          // MANUAL MODE DOES NOT WORK ON THIS MODEL. It was tried: the app
          // sent activityStart/activityEnd around real speech, the markers
          // arrived correctly (logged, ~530ms utterances), the audio framing
          // was right — and gemini-2.5-flash-native-audio simply never
          // generated a reply. No error, no close, just silence. So the
          // detector goes back to Google, which demonstrably does answer.
          //
          // startOfSpeechSensitivity MUST be HIGH. This was LOW to keep a
          // fan or a TV from opening turns — but measured directly (a clean
          // −19 dBFS spoken "hello, how can I help you today"), LOW never
          // detected the utterance AT ALL: no transcript, no reply, the
          // session just sat silent until it closed. That is the "I speak
          // and it waits forever in silence" bug. HIGH detects the same
          // clip immediately. Room noise is handled by the app's own
          // noise-suppressed voiceCommunication mic path instead.
          //   endOfSpeechSensitivity HIGH   — a pause SHOULD promptly count
          //     as the user finishing.
          //
          // silenceDurationMs is what the user actually feels: the gap
          // between them stopping and Hari starting.
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              startOfSpeechSensitivity:
                process.env.LIVE_START_SENSITIVITY || "START_SENSITIVITY_HIGH",
              endOfSpeechSensitivity:
                process.env.LIVE_END_SENSITIVITY || "END_SENSITIVITY_HIGH",
              // prefixPadding is how much audio BEFORE detected onset is
              // kept. It was 20ms, which clips the first consonant clean
              // off every sentence — "hello" reaches the model as "ello",
              // and a model given a truncated word guesses. 300ms keeps the
              // whole first syllable.
              prefixPaddingMs: Number(process.env.LIVE_PREFIX_PADDING_MS || 300),
              // The pause that ends a turn. 400ms was too eager: people
              // pause mid-sentence to think, and cutting there sends half a
              // question to the model, which then answers the wrong one.
              // 700ms survived a breath but was the largest single share of
              // the "why is it still silent" wait; 500ms still clears a
              // normal breath and shaves a fifth of a second off EVERY turn.
              silenceDurationMs: Number(process.env.LIVE_SILENCE_MS || 500),
            },
          },
          systemInstruction: { parts: [{ text: liveSystemPrompt(assistantName, unreadMessages) }] },
          // GOOGLE SEARCH — only on models that accept it.
          //
          // The gemini-3.x live models close the session outright (WS 1011,
          // before setupComplete) when a googleSearch tool is present —
          // measured directly; googleSearchRetrieval is rejected the same
          // way. On those models live-data questions route through the
          // registry's web_search function tool instead (which now falls
          // back to Gemini search grounding when no search key is set).
          // Set LIVE_GOOGLE_SEARCH=off to disable everywhere.
          tools: [
            { functionDeclarations: require("../tools/registry").declarations({ userId: user?.sub }) },
            ...(process.env.LIVE_GOOGLE_SEARCH === "off" ||
            /^gemini-[3-9]/i.test(LIVE_MODEL())
              ? []
              : [{ googleSearch: {} }]),
          ],
          // even though no text ever drives the conversation.
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      })
    );
  });

  upstream.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }

    // Anything that is not audio, transcription or a tool call is either a
    // setup result or an error. Without logging it, a rejected generation
    // looks identical to silence — which is exactly how the thinkingConfig
    // problem hid: input was transcribed, no reply ever came, nothing logged.
    if (msg.error || msg.goAway || msg.serverContent?.generationComplete === false) {
      console.error("live: upstream said:", JSON.stringify(msg).slice(0, 500));
    }

    if (msg.setupComplete) {
      upstreamReady = true;
      // The prompt carrying these messages has been accepted, so they are
      // about to be spoken. Safe to retire them now — and only now.
      if (unreadMessages.length > 0) {
        db.run(
          `UPDATE agent_messages SET status = 'read' WHERE id = ANY($1::bigint[])`,
          [unreadMessages.map((m) => m.id)]
        ).catch((e) => console.error("live: could not retire messages:", e.message));
      }
      appWs.send(JSON.stringify({ type: "ready", model: LIVE_MODEL() }));
      for (const frame of pending.splice(0)) sendAudioUp(frame);
      return;
    }

    if (msg.toolCall) {
      const responses = [];
      for (const fc of msg.toolCall.functionCalls || []) {
        // HIGH-RISK CONFIRMATION IN LIVE MODE (§17).
        //
        // This used to pass approved:true unconditionally, which meant the
        // confirmation gate did not exist on the app's MAIN screen: the
        // model could delete a memory, place a call, or — now that booking
        // by phone is real rather than mocked — telephone a business, with
        // no approval from the user at all.
        //
        // Live mode has no confirmation card (it is a voice call, not a
        // form), so the approval is SPOKEN. The first attempt is refused
        // back to the model with an instruction to ask out loud. The retry
        // is only honoured once the user has actually said something in
        // between — `userTurns` advances on real input transcription — so
        // the model cannot approve on the user's behalf by immediately
        // calling again.
        const tool = require("../tools/registry").get(fc.name);
        let approved = true;
        if (tool && tool.risk === "high") {
          const key = `${fc.name}:${JSON.stringify(fc.args || {})}`;
          if (pendingApproval && pendingApproval.key === key && userTurns > pendingApproval.askedAtTurn) {
            approved = true;
            pendingApproval = null;
          } else {
            pendingApproval = { key, askedAtTurn: userTurns };
            const summary = tool.confirmSummary
              ? tool.confirmSummary(fc.args || {}, { userId: user?.sub, userName })
              : fc.name;
            responses.push({
              id: fc.id,
              name: fc.name,
              response: {
                ok: false,
                needs_confirmation: true,
                result:
                  `Not done yet — this needs the user's permission first. ` +
                  `Ask them out loud to confirm: "${summary}". ` +
                  `If they agree, call this tool again with the same arguments. ` +
                  `Do not say it is done.`,
              },
            });
            continue;
          }
        }

        // Same ctx the SSE path builds (assistant/routes.js): without
        // tz/platform/location, weather fell back to nothing, deep links
        // never got their Android intent:// form, and "tomorrow at 8"
        // resolved in the wrong timezone — in live mode only.
        const res = await require("../tools/registry").execute(fc.name, fc.args, {
          userId: user?.sub,
          userName,
          approved,
          lat: deviceCtx.lat,
          lng: deviceCtx.lng,
          platform: deviceCtx.platform,
          tzOffsetMin: deviceCtx.tz,
        });

        // If the tool produced a device action (like open_camera or contact_lookup),
        // we send it down the WebSocket so the app can perform the action.
        if (res.deviceAction) {
          appWs.send(JSON.stringify(res.deviceAction));

          // Hari is now on the phone to a business. The call takes up to a
          // couple of minutes, which is far too long to hold the tool
          // response open, so we answer the model immediately with the
          // truth ("it is ringing") and follow the call in the background.
          // When it lands, the real outcome is injected as a new turn so
          // she tells the user what the business actually said — without
          // it, live mode would start a call and then go silent forever.
          // Meeting negotiation: follow the call, then tell the user what
          // was agreed. Same background pattern as a business booking —
          // the call is far too long to hold the tool response open.
          // INTERPRETER MODE — the role change is pushed to the model as
          // an instruction turn. A live session's system instruction is
          // fixed at setup, so the switch has to arrive in-band; the app
          // is told too, so it can show that it is interpreting rather
          // than assisting.
          if (res.deviceAction.type === "interpreter_mode") {
            const a = res.deviceAction;
            interpreting = a.active === true;
            if (upstream.readyState === WebSocket.OPEN) {
              upstream.send(
                JSON.stringify({
                  clientContent: {
                    turns: [{ role: "user", parts: [{ text: `[SYSTEM] ${a.instructions}` }] }],
                    // No turnComplete: this reconfigures behaviour, it is
                    // not a prompt that should be answered out loud.
                    turnComplete: false,
                  },
                })
              );
            }
          }

          if (res.deviceAction.type === "scheduling_call") {
            const a = res.deviceAction;
            (async () => {
              try {
                const out = await require("../scheduling/negotiator").awaitAndBook({
                  userId: Number(user?.sub),
                  taskId: a.task_id,
                  callId: a.call_id,
                  contactName: a.person,
                  purpose: a.purpose,
                  slots: a.slots || [],
                  tzOffsetMin: a.tz || 330,
                  onStatus: (st) =>
                    appWs.readyState === WebSocket.OPEN &&
                    appWs.send(JSON.stringify({ type: "call_status", status: st, contact_name: a.person })),
                });
                if (upstream.readyState !== WebSocket.OPEN) return;
                upstream.send(
                  JSON.stringify({
                    clientContent: {
                      turns: [{ role: "user", parts: [{ text:
                        `[SYSTEM] The call to ${a.person} about the meeting has ended. ` +
                        `Result: ${out.spoken} Tell me this now in one short sentence, ` +
                        `exactly as it happened. Do not claim anything was booked unless that result says so.` }] }],
                      turnComplete: true,
                    },
                  })
                );
              } catch (e) {
                console.error("live: scheduling call follow failed:", e.message || e);
              }
            })();
          }

          if (res.deviceAction.type === "fulfillment_call") {
            const a = res.deviceAction;
            (async () => {
              try {
                const outcome = await require("../fulfillment/service").awaitCallOutcome(
                  a.task_id,
                  a.call_id,
                  {
                    onStatus: (st) =>
                      appWs.readyState === WebSocket.OPEN &&
                      appWs.send(JSON.stringify({ type: "call_status", status: st, contact_name: a.venue })),
                  }
                );
                if (upstream.readyState !== WebSocket.OPEN) return;
                const said =
                  outcome.result ||
                  (outcome.state === "no_answer"
                    ? `${a.venue} did not answer, so nothing is booked.`
                    : `The call to ${a.venue} did not go through, so nothing is booked.`);
                upstream.send(
                  JSON.stringify({
                    clientContent: {
                      turns: [{
                        role: "user",
                        parts: [{
                          text:
                            `[SYSTEM] The call to ${a.venue} has ended. Result: ${said} ` +
                            `Tell me this now, in one short sentence, exactly as it happened. ` +
                            `Do not claim anything was confirmed unless that result says so.`,
                        }],
                      }],
                      turnComplete: true,
                    },
                  })
                );
              } catch (e) {
                console.error("live: fulfillment call follow failed:", e.message || e);
              }
            })();
          }

          responses.push({ id: fc.id, name: fc.name, response: res.data ? res : { result: "Device action requested: " + res.deviceAction.type } });
        } else {
          responses.push({ id: fc.id, name: fc.name, response: res });
        }
      }
      upstream.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    // First sign of a reply after the user stopped: this closes the loop on
    // where the wait actually is.
    if (activityEndAt && !repliedAt && (sc.modelTurn || sc.outputTranscription)) {
      repliedAt = Date.now();
      console.log(`live: FIRST REPLY ${repliedAt - activityEndAt}ms after activity_end`);
    }
    if (sc.turnComplete) {
      activityEndAt = 0;
      repliedAt = 0;
    }

    if (sc.interrupted) {
      // Drop audio already queued for the avatar, or it keeps mouthing a
      // sentence the user just talked over.
      if (avatar && !avatar.closed) avatar.interrupt();
      appWs.send(JSON.stringify({ type: "interrupted" }));
    }
    const parts = sc.modelTurn?.parts || [];
    for (const p of parts) {
      const b64 = p.inlineData?.data;
      if (b64) {
        const pcm = Buffer.from(b64, "base64");
        // Exactly one destination. Sending to both would play the voice
        // twice — once from the phone's own speaker path and once from
        // the avatar's track, a beat apart.
        //
        // The test is avatarReady (BEY's video is genuinely on air), NOT
        // merely "a room exists". A room whose avatar never rendered is a
        // black hole: audio pushed there is heard by nobody and the user
        // sits through a silent call. Falling back to the socket means a
        // failed avatar costs the picture, never the conversation.
        if (avatar && !avatar.closed && avatar.avatarReady) avatar.push(pcm);
        // Raw 24 kHz PCM straight through as binary — no re-encoding.
        else appWs.send(pcm);
      }
    }
    if (sc.inputTranscription?.text) {
      // The user has spoken. This is the signal the high-risk confirmation
      // gate below waits on: an approval only counts if it came AFTER we
      // asked, and a real user turn is what separates the two.
      userTurns++;
      // Live mode is the main screen, so commitments must be caught here
      // too. Fire-and-forget: nothing about this may delay the audio.
      if (Number(user?.sub) > 0) {
        require("../commitments/service").extractAsync(
          Number(user.sub),
          sc.inputTranscription.text,
          { source: "voice" }
        );
      }
      appWs.send(
        JSON.stringify({
          type: "input_transcript",
          text: sc.inputTranscription.text,
        })
      );
    }
    if (sc.outputTranscription?.text) {
      appWs.send(
        JSON.stringify({
          type: "output_transcript",
          text: sc.outputTranscription.text,
        })
      );
    }
    if (sc.turnComplete) {
      appWs.send(JSON.stringify({ type: "turn_complete" }));
    }
  });

  upstream.on("error", (e) => {
    console.error("live: upstream error:", e.message);
    try {
      appWs.send(
        JSON.stringify({
          type: "error",
          message: `live model unavailable (${String(e.message).slice(0, 120)})`,
        })
      );
    } catch (_) {}
    closeBoth("upstream error");
  });
  upstream.on("close", (code) => closeBoth(`upstream ${code}`));

  function sendAudioUp(chunk) {
    upstream.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: chunk.toString("base64"),
            mimeType: "audio/pcm;rate=16000",
          },
        },
      })
    );
  }

  appWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!upstreamReady) {
        // ~2s of pre-ready audio max, so a stalled setup can't balloon.
        if (pending.length < 64) pending.push(data);
        return;
      }
      sendAudioUp(data);
      return;
    }
    try {
      const m = JSON.parse(data.toString());
      if (m.type === "end") closeBoth("app ended");

      // TURN BOUNDARIES from the app's own voice detector. These are the
      // whole reason replies feel immediate: activity_end is sent the
      // instant the user stops talking, and Gemini begins generating on
      // that signal rather than waiting out a silence timer of its own.
      // Kept only as a timing probe. Forwarding these would fight Google's
      // automatic detector, which is now the one in charge.
      if (m.type === "activity_start") {
        speechStartedAt = Date.now();
      }
      if (m.type === "activity_end") {
        activityEndAt = Date.now();
        const spoke = speechStartedAt ? activityEndAt - speechStartedAt : 0;
        console.log(`live: user stopped (utterance ${spoke}ms)`);
      }
      if (m.type === "text" && m.text && upstreamReady && upstream.readyState === WebSocket.OPEN) {
        upstream.send(
          JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: m.text }] }],
              turnComplete: true,
            },
          })
        );
      }
    } catch (_) {}
  });

  appWs.on("close", () => closeBoth());
  appWs.on("error", () => closeBoth("app error"));
}

/// Express router for the /live availability probe (registered at app
/// setup time, BEFORE the 404 catch-all).
function probeRouter() {
  const router = require("express").Router();
  router.get("/", (_req, res) => {
    res.json({
      available: Boolean(process.env.GEMINI_API_KEY),
      model: LIVE_MODEL(),
      experimental: true,
    });
  });
  return router;
}

/**
 * Attaches the /live/ws upgrade handler to the HTTP server.
 */
function attachWs(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch (_) {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/live/ws") return; // not ours
    const user = authorize(url);
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const room = url.searchParams.get("room") || null;
    const num = (k) => {
      const v = Number(url.searchParams.get(k));
      return Number.isFinite(v) ? v : undefined;
    };
    const deviceCtx = {
      lat: num("lat"),
      lng: num("lng"),
      tz: num("tz") ?? 330,
      platform:
        String(url.searchParams.get("platform") || "").toLowerCase() || null,
    };
    wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, user, room, deviceCtx));
  });
}

module.exports = { probeRouter, attachWs };
