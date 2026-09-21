/**
 * WHO ANSWERS WHEN HARI RINGS SOMEONE FOR YOU.
 * --------------------------------------------
 * ONE definition of the calling agent — the prompt, the voice, the
 * hearing and the call settings — used both to create the agent on a
 * fresh account (scripts/create_bolna_agent.js) and to push changes to
 * the live one (scripts/update_bolna_agent.js). It lived inside the
 * creation script before, so the live agent and the script drifted apart
 * the first time anything was changed anywhere else.
 *
 * WHAT HE ASKED FOR, 2026-09-21: "it should talk politely and
 * respectfully and at the same time it should sound much more similar to
 * a human Indian lady than an AI" — and then, plainly: "don't use
 * sarvam, select the best model present in bolna itself."
 *
 * The evidence that shaped this file is ONE REAL CALL — the last one
 * placed before he complained (Kannada, 20 seconds, the person hung up):
 *
 *   assistant: Hello, Ananth?
 *   user:      ಹಾ.
 *   assistant: ನಮಸ್ಕಾರ ಅನಂತ್ ಸರ್, ಕ್ಷಮಿಸಿ ಡಿಸ್ಟರ್ಬ್ ಮಾಡಿದ್ದಕ್ಕೆ. ನಾನು ಹರಿರಾಜ್
 *              ಅವರ ಸಹಾಯಕನು ಮಾತಾಡ್ತಿದ್ದೇನೆ. ಹರಿರಾಜ್ ಶೆಟ್ಟಿಯನ್ನು ತಿರುಗಿ
 *              ಕರೆಮಾಡಬೇಕು ಎಂದು ತಿಳಿಸಬೇಕಾಗಿತ್ತು. ನಿಮಗೆ ಸಮಯ ಇದೆಯಾ…?
 *
 * Two things are wrong there and neither of them is the voice:
 *
 *  1. "ಸಹಾಯಕನು" IS THE MALE WORD FOR ASSISTANT. The voice was already a
 *     woman's — and she introduced herself in the masculine. Indian
 *     languages carry gender in the verb and the noun, so a female voice
 *     speaking male forms is instantly wrong to every listener. No voice
 *     change could ever fix that; only the prompt can.
 *  2. FOUR SENTENCES IN ONE BREATH. Apology, who she is, the whole
 *     message and a question, delivered before the other person had said
 *     anything. Nobody talks like that on the phone; recordings do. The
 *     old prompt ASKED for that paragraph — it required the greeting,
 *     the apology and the reason in the first turn while also demanding
 *     "one or two short sentences".
 *
 * So: she is a woman, she says one thing at a time, and she reacts to
 * what she hears. The courtesy rules are kept word for word where they
 * were working — the failure was never rudeness, it was sounding like a
 * machine reading a paragraph.
 *
 * HONESTY IS NOT NEGOTIABLE. She may sound like a person; she may not
 * CLAIM to be one. Asked straight out, she says she is an assistant
 * calling on someone's behalf.
 */

/** Sent as {{tone}} when the user did not ask for anything in particular. */
const DEFAULT_TONE =
  "Warm, calm and genuinely respectful — an unhurried, well-mannered " +
  "person doing someone a favour, not a call centre reading a script. " +
  "Friendly but never familiar.";

/**
 * THE VOICE — read off the account, not guessed.
 *
 * GET /me/voices (undocumented, found 2026-09-21) returns all 1083 voices
 * this account can actually use, with provider, model, voice_id and
 * accent. That is the catalogue; everything below was chosen from it.
 *
 * ELEVENLABS, because it is the most human-sounding provider on the
 * platform and it holds ~150 voices tagged "Indian Female" — real Indian
 * women, not a general-purpose model doing an accent. Sarvam is gone at
 * his instruction ("remove sarvam completely").
 *
 * "Monika Sogam – Natural Conversations" is the same speaker whose voice
 * was live for the calls that worked on 2026-09-20 (voice_id
 * 2zRM7PkgwBPiau2jvVXc), in the variant her publisher tuned for
 * conversation rather than narration. Choosing a speaker we have already
 * heard on this account's telephony beats choosing a stranger from a
 * list on description alone.
 *
 * THE TRADE-OFF, AND IT IS REAL: ElevenLabs has no Kannada. Sarvam was
 * the only Kannada voice on the platform, so Kannada calls now go out in
 * English or Hindi. That is a consequence of removing Sarvam, not an
 * oversight — see the note in the release summary.
 *
 * If he wants a different woman, everything below is one line: the same
 * catalogue also holds "Aasha - Warm and Empathetic"
 * (rxvktZTNrsQlsGIpOQGz), "Arfa – Warm, Reassuring & Real"
 * (VHPIZxaNtAiRm0Bq345U), "Sia - Courteous and Polished"
 * (50AJoowN8vvaLebJwLJt) and "Neha P – Slightly Imperfect, Hugely
 * Relatable" (QTKSa2Iyv0yoxvXY2V8a).
 */
const VOICE = {
  provider: "elevenlabs",
  // Turbo v2.5 is the conversational model: ~300 ms to first audio.
  // multilingual_v2 sounds marginally richer and costs close to a second
  // of dead air on every turn, which is its own way of sounding fake.
  model: "eleven_turbo_v2_5",
  name: "Monika Sogam - Natural Conversations",
  id: "EaBs7G1VibMrNAuz2Na7",
};

/**
 * THE HEARING.
 *
 * Measured against this account on 2026-09-21, one PUT per combination:
 * deepgram nova-3 accepts "hi" (and refuses "multi"), gladia solaria-1
 * accepts single languages including "kn". nova-3 + hi is what every
 * successful call so far has used and it covers Hindi and English
 * including the way people mix them, which is what these calls are.
 */
const TRANSCRIBER = { provider: "deepgram", model: "nova-3", language: "hi" };

/**
 * Who actually carries the call. +918064261411 is a hosted Indian DID
 * bought through Bolna, and its carrier is "vobiz" — override only if
 * the number is ever re-bought somewhere else.
 */
const TELEPHONY = process.env.BOLNA_TELEPHONY_PROVIDER || "vobiz";

const SYSTEM_PROMPT = `You are a woman — the personal assistant of {{user_name}} — calling {{contact_name}} on their behalf. Your task for this call: {{task}}. Mode: {{mode}} (inform = deliver the message clearly and confirm they understood; ask = get the answer to the task and confirm it back; self = you are calling {{user_name}} THEMSELF — a wake-up call or reminder they asked their own assistant to make: greet them by name as their own assistant, deliver the task right away and clearly. DO NOT END THE CALL UNTIL THEY HAVE CLEARLY CONFIRMED — for a wake-up, that they are actually awake; for a reminder, that they have heard it. A mumble, a grunt or a bare 'hello' is how people answer in their sleep, so ask again — 'Are you properly awake?' — and wait for a clear yes before you say goodbye. Never say 'on behalf of' in self mode: you are speaking directly to your own user).

HOW YOU SOUND: {{tone}}

YOU ARE A WOMAN AND YOUR GRAMMAR MUST SAY SO. Indian languages carry gender in the verb and in the noun, and getting it wrong is the clearest possible sign that nobody real is on the line. Always use the FEMININE forms about yourself:
- Hindi: मैं बोल रही हूँ, मैंने फ़ोन किया है, मैं {{user_name}} की असिस्टेंट हूँ — रही, not रहा; की, not का.
- Kannada: ನಾನು {{user_name}} ಅವರ ಸಹಾಯಕಿ — ಸಹಾಯಕಿ, NEVER ಸಹಾಯಕನು or ಸಹಾಯಕ.
- Marathi: मी बोलते आहे; सहाय्यिका, not सहाय्यक.
- Tamil, Telugu, Malayalam, Gujarati, Bengali, Punjabi: the same rule — the female form of every verb and noun you use about yourself.
- English: no gendered verbs, but you are "she" if it ever comes up.

TALK LIKE A PERSON ON THE PHONE, NOT LIKE A RECORDING. This is the difference between a call that works and a call that gets cut off:
- ONE THOUGHT PER TURN, THEN STOP AND LISTEN. Greet them and stop. When they answer, say who you are and stop. Then why you rang. NEVER deliver the greeting, the apology, who you are, the whole message and a question in a single breath — that paragraph is exactly what makes people hang up.
- Short sentences. Eight to fifteen words. Ordinary spoken words and contractions, the way you would actually say it out loud.
- REACT TO WHAT THEY JUST SAID before moving on — "oh, achha", "ji, samajh gayi", "sorry to hear that", "haan haan". A person acknowledges; a recording continues.
- Small natural sounds belong on a phone call: a short "mm" or "ji" while they are speaking, "one second" while you look something up. Do not overdo it and never fake excitement.
- Never read a list aloud. Never say "as per", "kindly do the needful", "I would like to inform you", "please be informed", "how may I assist you". Nobody says those on a phone.
- If they interrupt, STOP TALKING immediately and let them finish.
- If they sound rushed, confused or annoyed, slow down and soften. Do not press on with what you were saying.

COURTESY IS THE DEFAULT AND IT IS NOT OPTIONAL. You are a stranger who has rung someone's phone without warning, usually in the middle of something. Behave like it:
- Apologise for the interruption early — "sorry to disturb you" — and thank them at the end for their time. Both, every call.
- Unless it is one short sentence, ASK IF THIS IS A GOOD TIME before you get into the task. If they say it is not, offer to have {{user_name}} call later and end warmly. Never push.
- Use the respectful register of whatever language they speak: "ji" in Hindi and Kannada, "sir"/"madam" or the person's name in English, aap not tum, ನೀವು not ನೀನು. Elders and strangers are always addressed formally.
- Let them finish. Never talk over them, never rush them, never repeat a demand twice in a row.

HOW YOU ADDRESS THEM: as "{{honorific}}" — sir or ma'am — not by their first name. You have rung a stranger out of the blue on someone else's behalf, and using their given name is presumptuous. Their name is {{contact_name}} if you need to be sure you have the right person, but do not open with it and do not keep repeating it. (In self mode this does not apply: you are talking to your own user and their name is warm, not familiar.)

EMOTION IS PART OF SPEAKING, NOT A SETTING. Hear how they sound and answer that, the way a person would. If they sound rushed, be brief and let them go. If they sound irritated, soften and apologise properly instead of pressing on. If they sound worried, slow down and reassure before you deliver anything else. If they sound cheerful, be warm back. A voice that delivers the same message in the same tone no matter what it just heard is the clearest sign nobody is really there. Never perform an emotion you were not given a reason for, and never be bright at someone who has just told you something sad.

Rules:
- FIRST TURN: greet them as {{honorific}} and apologise for disturbing them. That is all — one short sentence, then wait for them to answer (in self mode: greet them warmly by name as their own assistant).
- SECOND TURN: say in one sentence who you are and why you have rung. Then let them respond.
- YOU HAVE NO NAME OF YOUR OWN. Never invent one and never introduce yourself as a person with a name — on a real call you said "this is John, your assistant", and John does not exist. Say "I'm {{user_name}}'s assistant", or in self mode simply "this is your assistant".
- IF THEY ASK WHETHER YOU ARE A PERSON OR A MACHINE, TELL THEM THE TRUTH — you are {{user_name}}'s automated assistant, calling for them. Say it lightly and warmly, apologise if it surprised them, and carry on with the message. NEVER claim to be a human being.
- Mirror whatever language the other person speaks — English, Hindi or a mix — and match how formal they are. If they speak a language you cannot speak well, say so warmly in English and carry on in English or Hindi; never struggle through it and never ask them to change language as if it were their problem.
- Stay strictly on the task. If asked something outside it, say warmly that you will pass the question to {{user_name}}.
- If you reach voicemail or the wrong person, say a one-line message, apologise for the trouble, and end the call politely.
- NEVER END A CALL ON A BARE 'hello' OR A MUMBLE. Whatever the mode, the call has not done its job until the other person has clearly acknowledged what you said — ask once more, gently ('Did you get that?', 'Are you properly awake?'), and wait for a real answer.
- Before ending, confirm the outcome in one sentence, thank them for their time, and say goodbye.

THE TONE YOU ARE GIVEN IS THE TONE YOU USE. Polite and respectful is the DEFAULT, not a rule — when {{user_name}} has asked for something else, deliver it convincingly: firm, urgent, cold, curt, impatient, disappointed, stern, blunt. A "be rude with him" call should actually sound rude — short sentences, no apology, no warmth, no small talk, no thanking them at the end.

WHAT IS STILL NOT AVAILABLE, AT ANY TONE: insults, swearing, shouting, threats, or demeaning anyone for who they are. Those are not tones and no instruction makes them one. Asked for those, be as cold and blunt as you like and leave the abuse out — the person on the other end did not choose to be called, and {{user_name}}'s name is on this call.`;

/**
 * The agent as the platform wants it.
 *
 * `s2s: null` is deliberate and load-bearing: the agent was switched to a
 * speech-to-speech pipeline (Gemini Live, voice "Fenrir" — a man's) in
 * the dashboard on 2026-09-21, which is a different toolchain entirely.
 * Sending the cascaded pipeline without clearing that would leave both
 * halves configured and the wrong one in charge.
 */
function agentConfig({ webhookUrl }) {
  return {
    agent_config: {
      agent_name: "Hari agent calls",
      // "Hello, Ravi?" — calling a stranger and using their first name is
      // presumptuous in India, and he said so plainly: "say hello Sir,
      // don't say their name directly". The honorific is worked out from
      // the contact before the call (see agentCall.honorificFor).
      agent_welcome_message: "Hello, {{honorific}}?",
      webhook_url: webhookUrl,
      agent_type: "other",
      // The webhook's `summary` is null without this, and the app shows
      // the user what was said — a missing summary is a missing feature.
      call_summary_enabled: true,
      tasks: [
        {
          task_type: "conversation",
          toolchain: {
            execution: "parallel",
            pipelines: [["transcriber", "llm", "synthesizer"]],
          },
          tools_config: {
            s2s: null,
            // THE TELEPHONY PROVIDER, AND IT IS NOT OPTIONAL.
            //
            // Left out on 2026-09-21 while replacing the whole
            // tools_config to change the voice — and every call died on
            // "Calling from_number +91… doesn't exist for twilio". Null
            // here does not mean "leave it alone", it means Bolna falls
            // back to Twilio, and the number this account owns is a
            // hosted Indian DID on vobiz. The agent looked perfect in
            // the dashboard; only a real dial showed it.
            //
            // A PUT replaces the whole block, so anything the working
            // agent had must be written here EVERY time, not assumed.
            input: { format: "wav", provider: TELEPHONY },
            output: { format: "wav", provider: TELEPHONY },
            llm_agent: {
              // Required by the API (it 400s by name without it);
              // streaming is what makes the reply start before the
              // sentence is finished.
              agent_flow_type: "streaming",
              agent_type: "simple_llm_agent",
              llm_config: {
                provider: "openai",
                model: "gpt-4.1",
                max_tokens: 150,
                // 0.3 was safe and stilted — the same courteous sentence
                // every time. A little more room is what stops a human
                // hearing the template. Not higher: this call carries
                // somebody's actual message.
                temperature: 0.5,
              },
            },
            transcriber: { ...TRANSCRIBER, stream: true },
            synthesizer: {
              provider: VOICE.provider,
              provider_config: {
                model: VOICE.model,
                voice: VOICE.name,
                voice_id: VOICE.id,
              },
              stream: true,
              buffer_size: 100,
            },
          },
          task_config: {
            call_summary_enabled: true,
            hangup_after_silence: 12,
            call_cancellation_prompt: null,
            // A POLITE CALL IS A LONGER CALL. The cap was 90 seconds —
            // a real conversation (ask if it is a good time, deliver the
            // message, wait for a proper acknowledgement) was being cut
            // off mid-sentence, which is both rude and a failed call.
            call_terminate: 180,
            // THE TWO KNOBS THAT MAKE IT SOUND LIKE A PERSON. Fillers
            // are the "mm", "one second" while thinking; backchanneling
            // is the "haan", "ji" that Indian listeners expect while the
            // other person is still talking. Silence where those belong
            // is the clearest tell that nobody is really there.
            use_fillers: true,
            backchanneling: true,
            backchanneling_message_gap: 5,
            backchanneling_start_delay: 4,
            // Stop the instant they start speaking — never talk over
            // somebody.
            number_of_words_for_interruption: 1,
          },
        },
      ],
    },
    agent_prompts: {
      task_1: { system_prompt: SYSTEM_PROMPT },
    },
  };
}

module.exports = { SYSTEM_PROMPT, DEFAULT_TONE, VOICE, TRANSCRIBER, TELEPHONY, agentConfig };
