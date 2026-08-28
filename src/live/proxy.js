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
    "You are SPEAKING with the user in real time. Reply in the same language " +
    "the user speaks — English, Kannada, Hindi, or any mix. Keep replies " +
    "short and conversational, one thought at a time, like a friend on a " +
    "phone call. If asked about astrology, use your get_horoscope tool. " +
    "If asked about Ayurvedic remedies or current facts, use Google Search to fetch the details. " +
    "Never mention being an AI unless directly asked. Decline harmful requests politely and briefly.";

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
 */
async function bridge(appWs, user, room) {
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
            },
          },
          systemInstruction: { parts: [{ text: liveSystemPrompt(assistantName, unreadMessages) }] },
          tools: [
            { functionDeclarations: require("../tools/registry").declarations({ userId: user?.sub }) },
            { googleSearch: {} }
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
        const res = await require("../tools/registry").execute(fc.name, fc.args, { userId: user?.sub, userName, approved: true });
        
        // If the tool produced a device action (like open_camera or contact_lookup),
        // we send it down the WebSocket so the app can perform the action.
        if (res.deviceAction) {
          appWs.send(JSON.stringify(res.deviceAction));
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
    wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, user, room));
  });
}

module.exports = { probeRouter, attachWs };
