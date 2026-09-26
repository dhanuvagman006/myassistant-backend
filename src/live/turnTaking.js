/**
 * WHO TALKS WHEN, AND WHICH MODEL TALKS — decided per session, by app build.
 *
 * Owner, 2026-09-26: "it's taking so much time to respond… it should
 * respond fast, but interrupt should be there… a strong valid one
 * interrupt… how we talk with a human", and "that voice sounds robotic,
 * we need more natural".
 *
 * Until build 113 every session is half-duplex: the phone sends nothing
 * while she speaks (barge-in went on 2026-09-20 — on a Samsung S24 her own
 * voice leaked back through the echo canceller and she kept cutting herself
 * off). A turn therefore must not end early, because whatever the user says
 * after an early end is lost while she answers. Hence the patient 1.1 s of
 * quiet before every answer (2026-09-26), which is what now feels slow.
 *
 * Build 113 lets the owner talk over her, but only after the phone has
 * checked that it really is them: speech sustained for a moment and clearly
 * louder than her own voice coming back (lib/services/barge_in.dart). With
 * that safety net a pause may end the turn sooner. If it ended too soon,
 * they carry on talking and she stops, the way a person would. Older
 * builds keep the patient settings, since an early end still loses their
 * words there.
 *
 * Build 113 also talks to Gemini 3.8 Live, Google's stable default live
 * model since 2026-09-15 (lower latency, more natural speech). If it ever
 * refuses a session, the model that has served everyone so far takes over
 * for half an hour (markRefused), and the app's own reconnect lands on it.
 *
 * Every number is env-tunable without a rebuild:
 *   LIVE_BARGE_IN=off           build 113 goes back to half-duplex
 *   GEMINI_LIVE_MODEL_NEXT=off  build 113 stays on GEMINI_LIVE_MODEL
 *   LIVE_SILENCE_MS_DUPLEX      the pause that ends a turn when barge-in is on
 *   LIVE_SILENCE_MS             the same, half-duplex
 */
const { envModel } = require("../services/ai/router");

/** The first app build with the on-phone barge-in check. */
const DUPLEX_BUILD = 113;

const CURRENT = () => envModel("GEMINI_LIVE_MODEL", "gemini-2.5-flash-native-audio-preview");
const NEXT = () => envModel("GEMINI_LIVE_MODEL_NEXT", "gemini-3.8-live");

const off = (v) => /^(off|0|false|no|none)$/i.test(String(v ?? "").trim());
const ms = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
};

/* ------------------------------------------------------------------ *
 * A model that refused a session is not asked again for a while
 * ------------------------------------------------------------------ */

const REFUSED_FOR_MS = 30 * 60_000;
const refused = new Map(); // model -> until (ms)

function markRefused(model, now = Date.now()) {
  if (model) refused.set(String(model), now + REFUSED_FOR_MS);
}

function isRefused(model, now = Date.now()) {
  const until = refused.get(String(model));
  if (!until) return false;
  if (until <= now) {
    refused.delete(String(model));
    return false;
  }
  return true;
}

/**
 * TOOLS MUST STILL WAIT FOR THEIR ANSWERS.
 *
 * On Gemini 3.8 Live a function call is NON_BLOCKING by default: the model
 * carries on talking while the tool runs. Every rule in the live prompt
 * assumes the opposite ("call find_places_nearby FIRST AND SAY NOTHING
 * UNTIL IT ANSWERS"), and a model that talks on invents the answer, which
 * is exactly the failure those rules were written against. So on those
 * models every declaration asks for BLOCKING, the behaviour the older
 * models always had.
 */
const toolsMustBlock = (model) =>
  /^gemini-(?:3\.(?:[89]|[1-9]\d)|[4-9])/i.test(String(model || ""));

/**
 * The session's model and turn-taking.
 * @returns {{ model, next, bargeIn, silenceMs, realtimeInputConfig, blockingTools }}
 */
function forSession({ build = 0, now = Date.now() } = {}) {
  const capable = Number(build) >= DUPLEX_BUILD;
  const nextWanted = capable && !off(process.env.GEMINI_LIVE_MODEL_NEXT);
  const next = nextWanted ? NEXT() : null;
  const useNext = Boolean(next) && next !== CURRENT() && !isRefused(next, now);
  const model = useNext ? next : CURRENT();
  const bargeIn = capable && !off(process.env.LIVE_BARGE_IN);

  const silenceMs = bargeIn
    ? ms(process.env.LIVE_SILENCE_MS_DUPLEX, 600)
    : ms(process.env.LIVE_SILENCE_MS, 1100);

  const automaticActivityDetection = {
    disabled: false,
    // HIGH, always: at LOW a clean spoken "hello" was never detected at
    // all (measured, see proxy.js), and the session sat silent.
    startOfSpeechSensitivity:
      process.env.LIVE_START_SENSITIVITY || "START_SENSITIVITY_HIGH",
    // LOW keeps a breath or an "umm" from counting as the end of a turn.
    endOfSpeechSensitivity:
      process.env.LIVE_END_SENSITIVITY || "END_SENSITIVITY_LOW",
    // 300 ms of audio before the detected onset is kept, so the first
    // syllable is never clipped ("hello" reaching the model as "ello").
    prefixPaddingMs: ms(process.env.LIVE_PREFIX_PADDING_MS, 300),
    silenceDurationMs: silenceMs,
  };

  // With barge-in, interrupting is Google's default, so nothing is sent
  // for it; that also keeps the setup free of a field a newer model might
  // not know. Half-duplex keeps its second lock: whatever reaches Google
  // during her turn cannot end it.
  const realtimeInputConfig = bargeIn
    ? { automaticActivityDetection }
    : {
        activityHandling: process.env.LIVE_ACTIVITY_HANDLING || "NO_INTERRUPTION",
        automaticActivityDetection,
      };

  return {
    model,
    next: useNext,
    bargeIn,
    silenceMs,
    realtimeInputConfig,
    blockingTools: toolsMustBlock(model),
  };
}

/** Declarations as the session's model needs them (see toolsMustBlock). */
function declarationsFor(decls, session) {
  if (!session?.blockingTools) return decls;
  return decls.map((d) => ({ ...d, behavior: "BLOCKING" }));
}

module.exports = {
  DUPLEX_BUILD, forSession, declarationsFor, markRefused, isRefused, toolsMustBlock,
  _forgetRefusals: () => refused.clear(),
};
