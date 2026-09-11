/**
 * CLAIM CHECK — a reply may not assert an action that did not happen.
 * -------------------------------------------------------------------
 * Observed in one tester session: "Opening Instagram and searching for
 * Ashmita. There you go!" with no tool call behind it — the user then
 * said "It's not open yet." The opposite failure appeared minutes later,
 * the assistant denying it had opened a search that it had.
 *
 * Prompts alone cannot fix this: the model is the thing being checked.
 * So the turn's reply is compared against the turn's EXECUTED ACTIONS
 * (src/agents/sessionState.js) before it is spoken, and an unsupported
 * claim is rewritten into the truth.
 *
 * Deliberately narrow. It only fires when a sentence claims a WORLD
 * action of a kind the assistant has tools for, and no tool of that
 * family ran in the same turn. Talking about the past ("I called her
 * yesterday"), offering ("shall I call?") and questions are left alone.
 *
 * DETECTION IS MULTILINGUAL, CORRECTION IS NOT. The patterns cover the
 * languages this product is actually used in — English plus Devanagari,
 * Kannada, Tamil, Telugu and Malayalam script — because a false claim in
 * Kannada is exactly as false as one in English, and English-only
 * patterns let it through both the streaming gate and the final check.
 * The honest replacement stays in English: a correction written in
 * shaky Kannada would be its own failure, and this text needs a native
 * speaker before it is spoken to anyone. A true sentence in the wrong
 * language beats a false one in the right language.
 */

/**
 * Families of action, each with the tools that satisfy it and the
 * phrases that claim it. Order matters only for the message we produce.
 */
const FAMILIES = [
  {
    id: "call",
    tools: ["place_phone_call", "book_by_calling_business", "arrange_meeting_with"],
    // "calling X", "I'll call", "connecting your call", "dialling"
    claim: /\b(calling|dialling|dialing|connecting your call|placing the call|ringing)\b/i,
    // कॉल/फ़ोन कर…, ಕರೆ/ಫೋನ್/ಕಾಲ್ ಮಾಡ…, அழைக்/கால் செய்…, కాల్/ఫోన్ చేస్…, വിളിക്ക…
    claimIntl: /(कॉल\s*कर|फ़?ोन\s*कर|डायल|मिला\s*रहा|ಕರೆ\s*ಮಾಡ|ಕಾಲ್\s*ಮಾಡ|ಫೋನ್\s*ಮಾಡ|அழைக்க|கால்\s*செய்|கூப்பிட|కాల్\s*చేస|ఫోన్\s*చేస|విళిక్|വിളിക്ക|കോൾ\s*ചെയ്)/,
    honest: (t) => "I couldn't start that call — nothing was dialled.",
  },
  {
    id: "open",
    tools: ["open_app", "open_webpage", "open_service_app", "open_video_mode", "phone_control", "start_navigation", "capture_document", "analyze_camera"],
    claim: /\b(opening|opened|launching|launched|pulling up|bringing up)\b/i,
    // खोल…, ओपन कर…, ತೆರೆ…/ಓಪನ್ ಮಾಡ…, திறக்க…, తెరుస్…, തുറക്ക…
    claimIntl: /(खोल\s*(रहा|दिया|रही)|ओपन\s*कर|ತೆರೆ(ಯು|ದಿ)|ಓಪನ್\s*ಮಾಡ|திறக்கிற|திறந்த|తెరుస్తు|తెరిచా|തുറക്കു|തുറന്നു)/,
    honest: () => "I couldn't open that on your phone.",
  },
  {
    id: "message",
    tools: ["send_agent_message", "send_whatsapp_message", "send_document", "send_patient_document"],
    claim: /\b(sent|sending|i'?ve sent|message is on its way|passed (it|that) on|delivered)\b/i,
    // भेज दिया/रहा…, ಕಳುಹಿಸ…, அனுப்ப…, పంప…, അയച്ചു…
    claimIntl: /(भेज\s*(दिया|रहा|रही)|मैसेज\s*कर|ಕಳುಹಿಸ|ಮೆಸೇಜ್\s*ಮಾಡ|ಸೆಂಡ್\s*ಮಾಡ|அனுப்ப|பதிவிட|పంపా|పంపుతు|അയച്ചു|അയക്കുന്നു)/,
    honest: () => "I haven't sent anything — that didn't go through.",
  },
  {
    id: "remind",
    tools: ["create_reminder", "update_reminder", "set_alarm", "schedule_task", "schedule_patient_recall", "set_morning_brief"],
    claim: /\b(reminder (is )?(set|saved)|i'?ve set|alarm (is )?set|scheduled it|i'?ll remind you)\b/i,
    // रिमाइंडर/अलार्म सेट…, ರಿಮೈಂಡರ್/ಅಲಾರಂ ಇಟ್ಟ…, நினைவூட்ட…, గుర్తు చేస…, ഓർമ്മിപ്പിക്ക…
    claimIntl: /(रिमाइंडर\s*(सेट|लगा)|अलार्म\s*(सेट|लगा)|याद\s*दिला|ರಿಮೈಂಡರ್|ಅಲಾರಂ|ಅಲಾರಾಂ|ನೆನಪಿಸ|நினைவூட்ட|அலாரம்|గుర్తు\s*చేస|అలారం|ഓർമ്മിപ്പിക്ക|അലാറം)/,
    honest: () => "That reminder wasn't saved — say it again and I'll set it.",
  },
  {
    id: "play",
    tools: ["play_music"],
    claim: /\b(playing|now playing|started playing)\b/i,
    // बजा/चला रहा…, ಪ್ಲೇ ಮಾಡ…, இசைக்க…, ప్లే చేస…, പ്ലേ ചെയ്യ…
    claimIntl: /(बजा\s*रहा|चला\s*रहा|प्ले\s*कर|ಪ್ಲೇ\s*ಮಾಡ|ಹಾಡು\s*ಹಾಕ|இசைக்கிற|பிளே\s*செய்|ప్లే\s*చేస|പ്ലേ\s*ചെയ്)/,
    honest: () => "I couldn't start the music.",
  },
  {
    id: "record",
    tools: ["record_entry", "amend_last_entry", "record_patient_payment", "remember_fact",
            "remember_person", "add_person_note", "file_document_under_client",
            "associate_document", "save_web_document"],
    claim: /\b(logged|recorded|noted it down|saved (it |that )?(to|in) your|filed under|i'?ve (written|saved)|written that down)\b/i,
    // सहेज/सेव/नोट कर…, ಉಳಿಸ/ಸೇವ್ ಮಾಡ…, சேமிக்க…, సేవ్ చేస…, സേവ് ചെയ്…
    claimIntl: /(सहेज|सेव\s*कर|नोट\s*कर|लिख\s*दिया|ಉಳಿಸ|ಸೇವ್\s*ಮಾಡ|ಬರೆದಿ|சேமிக்க|குறித்து|సేవ్\s*చేస|రాశా|സേവ്\s*ചെയ്|എഴുതി)/,
    honest: () => "That wasn't saved — nothing was written down.",
  },
];

/** Filler that only makes sense after a successful action — "There you
 *  go!", "Take a look." Left standing after a correction it reads as if
 *  something still happened. */
const FILLER = /^(there you go|take a look|all set|done|enjoy|have a look|check it out|that's it)[!.…]*$/i;

/** Does this sentence claim this family's action, in any script? */
function claims(family, sentence) {
  return family.claim.test(sentence) ||
    (family.claimIntl ? family.claimIntl.test(sentence) : false);
}

/** Sentences that are offers, questions or history, not claims. */
const NOT_A_CLAIM =
  /\?\s*$|\b(shall i|should i|do you want|would you like|want me to|i can|i could|i'?ll be able|earlier today|yesterday|last (time|week)|if you want)\b/i;

function sentences(text) {
  return String(text || "")
    .split(/(?<=[.!?।…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Which action family a single sentence ASSERTS, or null when it asserts
 * nothing (narration, an offer, a question). The stream gate uses this to
 * decide whether a sentence is safe to speak before the tools have run.
 */
function classify(sentence) {
  const s = String(sentence || "");
  if (!s.trim() || NOT_A_CLAIM.test(s)) return null;
  const family = FAMILIES.find((f) => claims(f, s));
  return family ? family.id : null;
}

/** The honest replacement for a sentence of this family. */
function honestFor(familyId, sentence) {
  const f = FAMILIES.find((x) => x.id === familyId);
  return f ? f.honest(sentence) : sentence;
}

/** Did a tool of this family run (successfully) in the given list? */
function satisfied(familyId, executed = []) {
  const f = FAMILIES.find((x) => x.id === familyId);
  if (!f) return true;
  const ranOk = new Set(
    (executed || []).filter((e) => e && e.ok !== false).map((e) => e.tool)
  );
  return f.tools.some((t) => ranOk.has(t));
}

/**
 * @param replyText   what the model wants to say
 * @param executed    [{tool, ok}] from THIS turn
 * @returns {{ok:boolean, text:string, violations:string[]}}
 *          ok=false means the text was corrected.
 */
function check(replyText, executed = []) {
  const text = String(replyText || "");
  if (!text.trim()) return { ok: true, text, violations: [] };

  const ranOk = new Set(
    (executed || []).filter((e) => e && e.ok !== false).map((e) => e.tool)
  );
  const violations = [];
  const out = [];
  let corrupted = false; // a claim in this reply has already been corrected

  for (const s of sentences(text)) {
    if (corrupted && FILLER.test(s.trim())) continue; // "There you go!" after a failure
    if (NOT_A_CLAIM.test(s)) {
      out.push(s);
      continue;
    }
    const family = FAMILIES.find((f) => claims(f, s));
    if (!family) {
      out.push(s);
      continue;
    }
    const satisfied = family.tools.some((t) => ranOk.has(t));
    if (satisfied) {
      out.push(s);
      continue;
    }
    // An unsupported claim. Replace that sentence with the truth rather
    // than appending a contradiction after it.
    violations.push(`${family.id}: "${s.slice(0, 80)}"`);
    out.push(family.honest(s));
    corrupted = true;
  }

  const corrected = out.join(" ");
  return { ok: violations.length === 0, text: corrected, violations };
}

/**
 * The opposite guard: the user asks whether something happened, and the
 * reply must come from the log rather than recollection. Returns the
 * tools whose history is relevant to the question, or null.
 */
function familiesAskedAbout(question) {
  const q = String(question || "");
  if (!/\b(did you|why did you|when did (i|you)|have you|you just|did i ask|what did you (do|open|call))\b/i.test(q)) {
    return null;
  }
  const hit = FAMILIES.filter((f) => claims(f, q) ||
    (f.id === "open" && /\b(search|settings|instagram|app|google)\b/i.test(q)) ||
    (f.id === "call" && /\bcall\b/i.test(q)));
  return hit.length ? hit.flatMap((f) => f.tools) : FAMILIES.flatMap((f) => f.tools);
}

module.exports = { check, classify, claims, honestFor, satisfied, familiesAskedAbout, FAMILIES };
