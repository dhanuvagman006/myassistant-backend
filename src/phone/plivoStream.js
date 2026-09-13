/**
 * THE PHONE, WIRED TO THE ASSISTANT'S OWN MODEL.
 * ----------------------------------------------------------------------
 * Plivo's bidirectional audio streaming hands us the callee's voice over a
 * WebSocket and plays back whatever we send. This bridges that to a Gemini
 * Live session, so the agent on the call is the SAME model, with the same
 * memory, as the one in the app — rather than a hosted voice bot that
 * would need the user's context flattened into template variables.
 *
 * WHY THE FORMATS LINE UP WITH NOTHING TO DO. Plivo lets the contentType
 * be chosen per stream and offers audio/x-l16 at 8k, 16k or 24k. Gemini
 * Live consumes 16 kHz PCM and emits 24 kHz PCM. So we ask Plivo for
 * 16 kHz inbound and hand back 24 kHz: no mu-law transcode, no resampling,
 * no quality lost on either leg. (Twilio's streams are 8 kHz mu-law only,
 * which would have cost a decode and two resamples per frame.)
 *
 * THE PROTOCOL, as documented by Plivo:
 *   from Plivo : start · media · dtmf · playedStream · clearedAudio
 *   to Plivo   : playAudio · checkpoint · clearAudio
 *
 * BARGE-IN IS THE PART THAT MAKES IT FEEL LIKE A CALL. Gemini reports
 * `interrupted` the moment the other person talks over it; we answer with
 * clearAudio, which discards everything already queued for playback.
 * Without that the agent keeps talking over a person who is trying to
 * answer it, which on a real call reads as rude rather than robotic.
 *
 * DELIBERATELY SEPARATE FROM live/proxy.js. That file is the app's voice
 * path and the most load-bearing thing in the product; it is coupled to
 * the app's own JSON event protocol and device actions, none of which a
 * phone call has. Reusing it would have meant refactoring it, and a phone
 * feature is not worth the risk of breaking the microphone.
 */
const WebSocket = require("ws");
const callBrief = require("./callBrief");

const GEMINI_WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** What we ask Plivo to send us, and what we send back. */
const IN_RATE = 16000;   // Gemini Live consumes 16 kHz PCM
const OUT_RATE = 24000;  // Gemini Live emits 24 kHz PCM

const LIVE_MODEL = () =>
  process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";

/**
 * The <Stream> element for a conversational call.
 *
 * bidirectional="true" is the whole point: without it Plivo streams the
 * caller to us and plays nothing back, which is listen-only and useless
 * here. keepCallAlive stops the call being torn down when the XML
 * document ends — the conversation IS the call.
 */
function streamXml(wsUrl, statusCallbackUrl) {
  const attrs = [
    'bidirectional="true"',
    'streamTimeout="600"',
    `contentType="audio/x-l16;rate=${IN_RATE}"`,
    'keepCallAlive="true"',
    'audioTrack="inbound"',
    statusCallbackUrl ? `statusCallbackUrl="${statusCallbackUrl}"` : "",
  ].filter(Boolean).join(" ");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Stream ${attrs}>${wsUrl}</Stream></Response>`
  );
}

/**
 * Bridge one call.
 *
 * @param {WebSocket} phone  the socket Plivo opened to us
 * @param {object} opts      { userId, task, contactName, onTranscript, onEnd }
 */
async function bridgeCall(phone, opts = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    try { phone.close(1011, "no model key"); } catch (_) {}
    return;
  }

  let streamId = "";
  let upstream = null;
  let closed = false;
  const said = [];   // what the agent said, for the caller's summary
  const heard = [];  // what the other person said

  const shut = (why) => {
    if (closed) return;
    closed = true;
    try { upstream && upstream.close(); } catch (_) {}
    try { phone.close(); } catch (_) {}
    if (typeof opts.onEnd === "function") {
      opts.onEnd({ said: said.join(" "), heard: heard.join(" "), why });
    }
  };

  const toPhone = (obj) => {
    if (phone.readyState === WebSocket.OPEN) {
      try { phone.send(JSON.stringify(obj)); } catch (_) {}
    }
  };

  const system = await callBrief.build(opts.userId, {
    task: opts.task,
    contactName: opts.contactName,
  }).catch(() => "You are a personal assistant making a phone call.");

  upstream = new WebSocket(`${GEMINI_WS}?key=${encodeURIComponent(key)}`);

  upstream.on("open", () => {
    upstream.send(JSON.stringify({
      setup: {
        model: `models/${LIVE_MODEL()}`,
        generationConfig: { responseModalities: ["AUDIO"] },
        systemInstruction: { parts: [{ text: system }] },
        // Google's own detector decides when the other person has stopped
        // talking. Manual markers were tried on the app path and the model
        // simply never replied; the same applies here.
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
            endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
            prefixPaddingMs: 300,
            silenceDurationMs: 600,
          },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    }));
  });

  upstream.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (_) { return; }

    if (m.setupComplete) {
      // SPEAK FIRST. The other person has just said "hello" and is waiting;
      // an agent that stays silent until spoken to gets hung up on.
      upstream.send(JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "[SYSTEM] The call has connected. Greet them and state your purpose in one short sentence." }] }],
          turnComplete: true,
        },
      }));
      return;
    }

    const sc = m.serverContent || {};

    // THE OTHER PERSON TALKED OVER US. Discard what is queued, or the
    // agent keeps speaking into someone who is answering it.
    if (sc.interrupted && streamId) {
      toPhone({ event: "clearAudio", streamId });
      return;
    }

    for (const part of sc.modelTurn?.parts || []) {
      const b64 = part.inlineData?.data;
      if (!b64) continue;
      toPhone({
        event: "playAudio",
        media: {
          contentType: "audio/x-l16",
          sampleRate: String(OUT_RATE),
          payload: b64, // Gemini already hands us base64 PCM
        },
      });
    }

    const out = sc.outputTranscription?.text;
    if (out) said.push(out);
    const inp = sc.inputTranscription?.text;
    if (inp) {
      heard.push(inp);
      if (typeof opts.onTranscript === "function") opts.onTranscript(inp);
    }
  });

  upstream.on("error", () => shut("model error"));
  upstream.on("close", () => shut("model closed"));

  phone.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (_) { return; }

    switch (m.event) {
      case "start":
        streamId = m.start?.streamId || m.streamId || "";
        break;
      case "media": {
        const b64 = m.media?.payload;
        if (!b64 || !upstream || upstream.readyState !== WebSocket.OPEN) return;
        upstream.send(JSON.stringify({
          realtimeInput: {
            mediaChunks: [{ mimeType: `audio/pcm;rate=${IN_RATE}`, data: b64 }],
          },
        }));
        break;
      }
      case "clearedAudio":
      case "playedStream":
      case "dtmf":
        break; // acknowledgements; nothing to do
      default:
        break;
    }
  });

  phone.on("close", () => shut("caller hung up"));
  phone.on("error", () => shut("phone socket error"));
}

module.exports = { bridgeCall, streamXml, IN_RATE, OUT_RATE };
