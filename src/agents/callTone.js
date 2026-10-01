/**
 * HOW A CALL THE ASSISTANT PLACES SHOULD SOUND — worked out from the
 * situation, not only from an explicit "be firm".
 *
 * The owner, 2026-10-01: "when my assistant calls to inform someone it
 * should show respect, emotion and anger based on the situation and
 * context — in loan recovery we need a similar voice and tone, but in
 * wishing we need a different one." Until now the calling agent received
 * a tone ONLY when the user spelled one out ("be firm"); a dues reminder
 * and a birthday wish both went out in the same warm, apologetic manner
 * (callAgentConfig.DEFAULT_TONE). The agent's prompt already honours
 * whatever arrives in {{tone}} ("THE TONE YOU ARE GIVEN IS THE TONE YOU
 * USE"), so the fix is to fill that slot from the task itself.
 *
 * What is deliberately NOT a tone, at any setting: insults, swearing,
 * shouting, threats. "Angry" here means stern and visibly displeased —
 * a creditor's office, not a goon. The person called did not ask to be
 * called, and the user's own name is on the line.
 */

const { DEFAULT_TONE } = require("./callAgentConfig");

const MAX = 900;

/** The manners, each a paragraph the calling agent reads as "HOW YOU SOUND". */
const TONES = {
  default: DEFAULT_TONE,

  // Dues, loan recovery, overdue payments, unpaid bills.
  firm:
    "Firm, serious and businesslike — a creditor's office calling about " +
    "money that is owed, not a friend doing a favour. Polite but NOT " +
    "apologetic: do not say sorry for calling and do not ask whether it is " +
    "a good time. State plainly what is owed, since when, and by when it " +
    "must be paid, then get a clear commitment with a date. Do not soften " +
    "the message, no small talk, no laughing, no thanking them at the end — " +
    "a plain 'we expect it by then, goodbye'. Stay calm and controlled: a " +
    "lower, steadier voice, never raised, never threatening, never insulting.",

  // Something was promised and not done; the user is displeased.
  displeased:
    "Serious and clearly displeased — the voice of someone who has been let " +
    "down and is not pretending otherwise. Cool, short sentences, no " +
    "apology for calling, no small talk. Say exactly what was promised, " +
    "what did not happen, and what must happen now, and get a clear answer. " +
    "Controlled, not loud: disappointment carries further than anger. No " +
    "insults, no threats.",

  // Birthdays, anniversaries, weddings, festivals, congratulations.
  warm:
    "Warm, bright and genuinely happy for them — the voice of someone " +
    "passing on good wishes from a friend. Smile in the voice, a little " +
    "lift in the greeting, unhurried. Say the wish the way the user put " +
    "it, add one warm line, and let them enjoy it; do not rush to end.",

  // Illness, death, loss, bad news.
  gentle:
    "Gentle, soft and unhurried — someone speaking to a person who is " +
    "hurting. Lower the voice, slow down, leave pauses. Lead with " +
    "sympathy before the message, never sound bright or brisk, never " +
    "fill a silence with chatter. If they cry or go quiet, wait.",

  // Emergencies and things that cannot wait.
  urgent:
    "Urgent and clear — this cannot wait. Skip the pleasantries, say in the " +
    "first sentence that it is urgent and what it is, speak a little faster " +
    "but every word distinct, and make sure they have understood what to do " +
    "before you let them go. Serious, not panicked.",

  // The user is thanking or apologising to someone.
  sincere:
    "Sincere and heartfelt — slower and softer than ordinary courtesy. The " +
    "words must sound meant, not read: let the thank-you or the apology " +
    "stand on its own without hurrying to the next sentence.",

  // The user is inviting someone.
  welcoming:
    "Warm and welcoming — the voice of someone genuinely glad to invite " +
    "them. Friendly, clear about the day, time and place, and happy to " +
    "repeat them.",

  // A wake-up call the user asked their own assistant to make.
  wakeup:
    "Bright, energetic and persistent — a cheerful wake-up from their own " +
    "assistant. Lively and clear, repeat yourself happily until they are " +
    "properly awake; never dull, never stern.",
};

// What the user may have asked for in their own words.
const REQUESTED = [
  [/\b(firm|strict|stern|serious|tough|hard|no.?nonsense|business.?like|cold|curt|blunt)\b/i, "firm"],
  [/\b(angry|anger|annoyed|upset|displeased|disappoint\w*|unhappy|frustrat\w*|fed up)\b/i, "displeased"],
  [/\b(urgent\w*|emergency|immediately|asap|right away|cannot wait|can't wait)\b/i, "urgent"],
  [/\b(gentle|gently|soft\w*|sympath\w*|kind\w*|tender\w*|consol\w*|comfort\w*)\b/i, "gentle"],
  [/\b(warm\w*|happy|happily|cheerful\w*|joyful\w*|excited\w*|lovingly|sweet\w*|bright\w*)\b/i, "warm"],
  [/\b(sincere\w*|heartfelt|humbl\w*|apologetic\w*|grateful\w*)\b/i, "sincere"],
];

// Abuse is not a tone; asked for one, the call goes out firm instead.
const ABUSE =
  /\b(abuse|abusive|insult\w*|swear\w*|curse\w*|cuss\w*|threat\w*|shout\w*|scream\w*|yell\w*|humiliat\w*|rude|gaali|galli|bad ?words)\b/i;

// What the task itself is about. Order matters: the first match wins, and
// grief beats everything so a sad message is never delivered brightly.
const SITUATIONS = [
  ["gentle",
    /\b(passed away|pass away|demise|death|died|funeral|condolence\w*|rip|hospitali[sz]ed|in (the )?hospital|icu|accident|not well|unwell|very ill|seriously ill|cancer|surgery|sad news|bad news|sorry for your loss|get well|speedy recovery)\b/i],
  ["urgent",
    /\b(urgent\w*|emergency|immediately|right now|asap|at once|cannot wait|can't wait|critical|very important)\b/i],
  ["firm",
    /\b(loan|emi|e\.m\.i|instal?lment|kist|dues?|overdue|outstanding|pending (payment|amount|money|dues|bill|balance)|unpaid|not paid|hasn'?t paid|has not paid|yet to pay|balance (amount|payment|is due)|recover\w*|collection|repay\w*|pay (back|up|the (amount|balance|money|bill|rent))|clear the (dues|balance|bill|payment)|rent is (due|pending|late)|late (payment|fee)|default\w*|borrowed|udhaar|udhar|baaki|baki|paisa|paise|wapas)\b/i],
  ["displeased",
    /\b(still (not|hasn'?t|haven'?t|waiting)|not (done|delivered|completed|finished|fixed|responding|replying)|hasn'?t (done|delivered|replied|responded|turned up|come)|third time|second time|again and again|no response|ignoring|complain\w*|disappoint\w*|unacceptable|very late|too late|broke (his|her|the) promise|promised (but|and)|not happy|unhappy)\b/i],
  ["warm",
    /\b(happy birthday|birthday|bday|anniversary|wedding|marriage|engag(ed|ement)|congrat\w*|wish(es|ing)?( (him|her|them))? (a|happy|all|well)|best wishes|good luck|all the best|new ?year|diwali|deepavali|dasara|dussehra|ugadi|pongal|onam|eid|christmas|holi|ganesh\w*|navratri|sankranti|baby|new born|newborn|promotion|graduat\w*|passed (the|his|her) exam|got (the )?job|celebrat\w*|party|good news|great news)\b/i],
  ["sincere",
    /\b(thank (you|him|her|them)|thanks|grateful|gratitude|apologi[sz]e|apology|sorry (for|about|that)|forgive)\b/i],
  ["welcoming",
    /\b(invit\w*|come (over|home|for)|join us|you are welcome|housewarming|gruhapravesh\w*|function|ceremony|reception|puja|pooja)\b/i],
];

const WAKEUP = /\b(wake|wake.?up|get up|alarm|utho|uth jao|yeddelu|ezhunthiru)\b/i;

/**
 * resolve({ requested, task, selfCall }) → { id, tone, source }
 *   requested — what the user asked for, if anything ("be firm", "warmly")
 *   task      — the message or question the call carries
 *   selfCall  — the user is ringing themself (wake-up, reminder)
 * `tone` is the paragraph sent as {{tone}}; `source` says how it was
 * chosen: "requested", "task" or "default".
 */
function resolve({ requested, task, selfCall } = {}) {
  const asked = String(requested || "").trim();
  const text = String(task || "");

  if (asked) {
    if (ABUSE.test(asked)) {
      return { id: "firm", source: "requested", tone: fit(TONES.firm +
        " (The user asked for abuse; that is refused. Be as firm and cold as this allows, and leave the abuse out.)") };
    }
    const hit = REQUESTED.find(([rx]) => rx.test(asked));
    if (hit) {
      return { id: hit[1], source: "requested", tone: fit(`${TONES[hit[1]]} The user's own words for it: "${asked.slice(0, 120)}".`) };
    }
    // Their own description, kept as given, inside the standing limits.
    return { id: "custom", source: "requested", tone: fit(
      `${asked.slice(0, 300)} — deliver exactly that manner convincingly. ` +
      "Still never insults, swearing, shouting or threats.") };
  }

  if (selfCall) {
    if (WAKEUP.test(text)) return { id: "wakeup", source: "task", tone: TONES.wakeup };
    // A reminder to pay one's own EMI is not a collection call on oneself.
    const own = SITUATIONS.find(([id, rx]) => (id === "urgent" || id === "warm") && rx.test(text));
    return own
      ? { id: own[0], source: "task", tone: TONES[own[0]] }
      : { id: "default", source: "default", tone: TONES.default };
  }

  const hit = SITUATIONS.find(([, rx]) => rx.test(text));
  if (hit) return { id: hit[0], source: "task", tone: TONES[hit[0]] };
  return { id: "default", source: "default", tone: TONES.default };
}

/**
 * The voice can act what it reads. ElevenLabs v3 (the live voice, see
 * callAgentConfig.VOICE) renders inline audio tags such as [firm] or
 * [cheerful]; a voice that is not v3 would read them ALOUD, which on a
 * real call is far worse than a flat delivery. So the hint is off until
 * the owner has heard one call with it: BOLNA_AUDIO_TAGS=on.
 */
function withAudioTags(tone) {
  if (process.env.BOLNA_AUDIO_TAGS !== "on") return tone;
  return fit(tone +
    " Your voice is ElevenLabs v3: you may begin a sentence with ONE audio " +
    "tag in square brackets that fits this manner — [firm], [serious], " +
    "[disappointed], [cheerful], [warm], [gentle], [sad], [hurried] — " +
    "never more than one per sentence, never one that contradicts this tone.");
}

function fit(s) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > MAX ? s.slice(0, MAX - 1).trimEnd() + "…" : s;
}

module.exports = { resolve, withAudioTags, TONES, MAX };
