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
    honest: (t) => "I couldn't start that call — nothing was dialled.",
  },
  {
    id: "open",
    tools: ["open_app", "open_webpage", "open_service_app", "open_video_mode", "phone_control", "start_navigation", "capture_document", "analyze_camera"],
    claim: /\b(opening|opened|launching|launched|pulling up|bringing up)\b/i,
    honest: () => "I couldn't open that on your phone.",
  },
  {
    id: "message",
    tools: ["send_agent_message", "send_whatsapp_message", "send_document", "send_patient_document"],
    claim: /\b(sent|sending|i'?ve sent|message is on its way|passed (it|that) on|delivered)\b/i,
    honest: () => "I haven't sent anything — that didn't go through.",
  },
  {
    id: "remind",
    tools: ["create_reminder", "update_reminder", "set_alarm", "schedule_task", "schedule_patient_recall", "set_morning_brief"],
    claim: /\b(reminder (is )?(set|saved)|i'?ve set|alarm (is )?set|scheduled it|i'?ll remind you)\b/i,
    honest: () => "That reminder wasn't saved — say it again and I'll set it.",
  },
  {
    id: "play",
    tools: ["play_music"],
    claim: /\b(playing|now playing|started playing)\b/i,
    honest: () => "I couldn't start the music.",
  },
  {
    id: "record",
    tools: ["record_entry", "amend_last_entry", "record_patient_payment", "remember_fact",
            "remember_person", "add_person_note", "file_document_under_client",
            "associate_document", "save_web_document"],
    claim: /\b(logged|recorded|noted it down|saved to your|filed under|i'?ve written|written that down)\b/i,
    honest: () => "That wasn't saved — nothing was written down.",
  },
];

/** Filler that only makes sense after a successful action — "There you
 *  go!", "Take a look." Left standing after a correction it reads as if
 *  something still happened. */
const FILLER = /^(there you go|take a look|all set|done|enjoy|have a look|check it out|that's it)[!.…]*$/i;

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
  const family = FAMILIES.find((f) => f.claim.test(s));
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
 * Which action family a single sentence ASSERTS, or null when it asserts
 * nothing (narration, an offer, a question). The stream gate uses this to
 * decide whether a sentence is safe to speak before the tools have run.
 */
function classify(sentence) {
  const s = String(sentence || "");
  if (!s.trim() || NOT_A_CLAIM.test(s)) return null;
  const family = FAMILIES.find((f) => f.claim.test(s));
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
    const family = FAMILIES.find((f) => f.claim.test(s));
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
  const hit = FAMILIES.filter((f) => f.claim.test(q) ||
    (f.id === "open" && /\b(search|settings|instagram|app|google)\b/i.test(q)) ||
    (f.id === "call" && /\bcall\b/i.test(q)));
  return hit.length ? hit.flatMap((f) => f.tools) : FAMILIES.flatMap((f) => f.tools);
}

module.exports = { check, classify, honestFor, satisfied, familiesAskedAbout, FAMILIES };
