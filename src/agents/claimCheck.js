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

/*
 * VIDEO NOTES (the `videonote` family below). A sentence is about one when
 * it names a video note / video message and says something happened to
 * it, or pairs the queued wording the tool itself speaks ("being made",
 * "once it's made") with reaching a person. The second half is scoped to
 * a person on purpose: "your video is being made, I'll show it when it's
 * ready" belongs to generate_video, and must not be read as a video note.
 */
const VIDEO_NOTE = /\bvideo\s+(?:note|message)s?\b/i;
const VIDEO_NOTE_ACT =
  /\b(sent|sending|deliver(?:ed|ing)?|on its way|went out|gone out|reach(?:ed|es)?|being made|made|ready|queued)\b/i;
const QUEUED = /\b(being made|once it'?s (?:made|ready)|as soon as it'?s (?:made|ready))\b/i;
const TO_A_PERSON = /\b(reach(?:es)?|delivered to (?!you\b|your\b)|send it to (?!you\b|your\b)|get it to)\b/i;
function isVideoNoteClaim(s) {
  return (VIDEO_NOTE.test(s) && VIDEO_NOTE_ACT.test(s)) || (QUEUED.test(s) && TO_A_PERSON.test(s));
}
// Said as DONE. "It will be delivered", "it'll be sent", "once it's sent"
// are the future a queued note may promise; "I've sent", "has been
// delivered", "sending it now", "on its way" are not.
const WENT = /\b(sent|sending|delivered|on its way|went out|gone out|reached)\b/gi;
const FUTURE_BEFORE = /\b(will|'ll|shall|going to|be|once|when|until|before|as soon as)\b[^.,;!?]{0,12}$/i;
function saysVideoNoteWent(s) {
  const t = String(s || "");
  for (const m of t.matchAll(WENT)) {
    if (!FUTURE_BEFORE.test(t.slice(0, m.index))) return true;
  }
  return false;
}
const VIDEO_NOTE_QUEUED =
  "Your video note hasn't gone yet — it's being made, and you'll get a notification when it's ready.";
const NO_VIDEO_NOTE = "I haven't queued a video note — nothing is being made or sent.";
const CARD_SHARE_OPEN = "The card is open to share — pick the person and press Send.";

/**
 * Families of action, each with the tools that satisfy it and the
 * phrases that claim it. Order matters only for the message we produce.
 *
 * A family may carry `matches(s)` in place of the English `claim`
 * pattern, and `overclaims(s)`: a sentence the family's tool can NEVER
 * back, whatever ran (a queued video note described as sent). `honest`
 * gets the set of tools that ran, so the correction can say what did
 * happen instead of denying everything.
 */
const FAMILIES = [
  {
    id: "call",
    tools: ["place_phone_call", "book_by_calling_business", "arrange_meeting_with"],
    // "calling X", "I'll call", "connecting your call", "dialling"
    // "My calling service couldn't place it" names the SERVICE — it is
    // the honest line said when a call fails, and must not itself be
    // rewritten as a claim to have dialled.
    claim: /\b(calling(?!\s+(?:service|feature|balance|limit)\b)|dialling|dialing|ringing|connecting your call|placing the call)\b/i,
    // SOMEONE ELSE CALLING IS CALL HISTORY, NOT A CLAIM ("Ravi was calling
    // you at 3:10") — but "I tried calling Ravi" still is. See
    // isOnlyCallHistory below.
    onlyHistory: (s) => isOnlyCallHistory(s),
    // कॉल/फ़ोन कर…, ಕರೆ/ಫೋನ್/ಕಾಲ್ ಮಾಡ…, அழைக்/கால் செய்…, కాల్/ఫోన్ చేస్…, വിളിക്ക…
    claimIntl: /(कॉल\s*कर|फ़?ोन\s*कर|डायल|मिला\s*रहा|ಕರೆ\s*ಮಾಡ|ಕಾಲ್\s*ಮಾಡ|ಫೋನ್\s*ಮಾಡ|அழைக்க|கால்\s*செய்|கூப்பிட|కాల్\s*చేస|ఫోన్\s*చేస|విళిక్|വിളിക്ക|കോൾ\s*ചെയ്)/,
    honest: (t) => "I couldn't start that call — nothing was dialled.",
  },
  {
    id: "open",
    // open_named_app was added on 2026-09-13 and NOT added here, which
    // inverted the bug this file exists to prevent: Swiggy opened, the
    // checker saw no tool it recognised as "opening", and made the
    // assistant apologise three seconds later for something that had just
    // worked. A family that does not know about a tool silently calls it
    // a liar, so tools.js has a test that fails when a device action is
    // missing from every family.
    // EVERY TOOL THAT PUTS SOMETHING ON THE USER'S SCREEN belongs here,
    // because the model narrates all of them with the same word. Asked to
    // turn on screen time it says "I'm opening those settings now"; asked
    // for biryani it says "opening Swiggy". Those sentences match this
    // family's pattern, so a tool missing from this list means the
    // assistant is made to apologise for something it just did — observed
    // three times running for enable_usage_tracking while the settings
    // screen was open in front of the user.
    tools: [
      "open_app", "open_named_app", "open_webpage", "open_service_app",
      "open_video_mode", "phone_control", "start_navigation",
      // "Opening GPay with ₹500 for Ravi" — the UPI app on screen.
      "pay_by_upi",
      // The camera for a card; the recorder for a meeting.
      "scan_business_card", "record_meeting",
      // "Opening Swiggy and finding you a 4-star biryani…"
      "do_task_in_app",
      // "Opening the uninstall screen for Instagram".
      "uninstall_app",
      // Opens Google Maps at what it just found — "showing them on the
      // map" is the same claim by the same words.
      "find_places_nearby",
      "capture_document", "analyze_camera",
      // Farewells carry no "opening…" claim, but every device action must
      // live in SOME family or the membership test (rightly) fails.
      "end_conversation",
      // These open an app or a screen too, and say so in the same words.
      "enable_usage_tracking", "order_food", "book_ride", "book_movie_tickets",
      "try_a_look", "present_text", "generate_image", "generate_video",
      // Screens inside this app. "Opening your settings" is the same claim.
      "open_app_screen", "set_app_theme",
      // Bills by email opens its own screen ("Your address is on screen").
      "bills_email",
      // Opens the phone clock app and says "Opening your alarms" — the
      // same words, so it belongs here or it denies what it just did.
      "show_alarms",
      // "Opening the installer" is the same claim again.
      "update_app",
      // "Office mode — directions are opening": a shortcut's phone steps
      // ride in one directive (2026-09-27).
      "run_shortcut", "continue_shortcut",
      // "Opening your focus timer" (Momentum, 2026-09-25).
      "start_focus",
      // In-app panels the model announces the same way ("here's your
      // schedule", "pulling up the headlines"). Both were orphans — no
      // family backed them, so the assistant could apologise for a
      // schedule the user was looking at.
      "show_schedule", "show_news",
      // "Bringing up the second story" — its card comes to the front.
      "read_news_story",
      // "Opening WhatsApp with the card" (photo cards, 2026-09-26).
      "share_poster",
    ],
    claim: /\b(opening|opened|launching|launched|pulling up|bringing up)\b/i,
    // खोल…, ओपन कर…, ತೆರೆ…/ಓಪನ್ ಮಾಡ…, திறக்க…, తెరుస్…, തുറക്ക…
    claimIntl: /(खोल\s*(रहा|दिया|रही)|ओपन\s*कर|ತೆರೆ(ಯು|ದಿ)|ಓಪನ್\s*ಮಾಡ|திறக்கிற|திறந்த|తెరుస్తు|తెరిచా|തുറക്കു|തുറന്നു)/,
    honest: () => "I couldn't open that on your phone.",
  },
  {
    // VIDEO NOTES ARE QUEUED, NEVER SENT (2026-09-26). send_video_note
    // only puts a note in the owner's queue — he makes the clip by hand in
    // Colab, which can take hours or fail — so "it's being made, it will
    // reach Danush when it's ready" is the one true thing to say. Filed
    // under `message` at first, the queued note also backed "Done, I've
    // sent Danush your video note", the exact claim the tool forbids
    // (review, 2026-09-26). Here it backs only the queued wording; a
    // "sent" or "delivered" said of a video note is never backed by it.
    // Ahead of `message` so that "it will be delivered once it's made" is
    // read as the queued claim it is.
    id: "videonote",
    tools: ["send_video_note"],
    matches: (s) => isVideoNoteClaim(s),
    overclaims: (s) => saysVideoNoteWent(s),
    honest: (_s, ranOk) => (ranOk && ranOk.has("send_video_note") ? VIDEO_NOTE_QUEUED : NO_VIDEO_NOTE),
  },
  {
    // "Added it to your Notion" (2026-09-27). Ahead of `message`, and so of
    // `create`/`record`, whose "saved it to your…" would otherwise take
    // "saved it to your Notion" (the first family that matches wins).
    id: "notion",
    tools: ["notion_add", "notion_create_page"],
    claim: /\b(added|saved|put|created)\b[^.]{0,40}\bnotion\b/i,
    honest: () => "I haven't changed anything in your Notion — that didn't go through.",
  },
  {
    id: "message",
    tools: ["send_agent_message", "send_whatsapp_message", "send_document", "send_patient_document",
            "send_developer_feedback", // "I've passed that on to the developer"
            // Mail was missing, so "Sent, your mail is on its way" after a
            // SUCCESSFUL email_send was rewritten to "I haven't sent anything".
            "email_send", "email_reply"],
    claim: /\b(sent|sending|i'?ve sent|message is on its way|passed (it|that) on|delivered)\b/i,
    // भेज दिया/रहा…, ಕಳುಹಿಸ…, அனுப்ப…, పంప…, അയച്ചു…
    claimIntl: /(भेज\s*(दिया|रहा|रही)|मैसेज\s*कर|ಕಳುಹಿಸ|ಮೆಸೇಜ್\s*ಮಾಡ|ಸೆಂಡ್\s*ಮಾಡ|அனுப்ப|பதிவிட|పంపా|పంపుతు|അയച്ചു|അയക്കുന്നു)/,
    // "Sent!" (or भेज दिया) when only a video note was QUEUED is still
    // false, but "I haven't sent anything" would be too: something is on
    // its way to being made. Say that instead.
    // A shared card is the same shape (2026-09-26): WhatsApp opened with
    // it, and the user presses Send — "sent" is false, "nothing went
    // through" would be too.
    honest: (_s, ranOk) =>
      ranOk && ranOk.has("send_video_note") ? VIDEO_NOTE_QUEUED
        : ranOk && ranOk.has("share_poster") ? CARD_SHARE_OPEN
          : "I haven't sent anything — that didn't go through.",
  },
  {
    id: "remind",
    // set_timer was missing: "I've set a timer for ten minutes" matches
    // this family, so the timer was set and then denied.
    tools: ["create_reminder", "update_reminder", "set_alarm", "set_timer", "schedule_task", "schedule_patient_recall", "set_morning_brief",
            // "I've set today's three", "I've set a 25-minute focus", "I've set
            // a daily reminder for water" — Momentum, 2026-09-25.
            "plan_my_day", "start_focus", "add_habit",
            // Its own confirmation is "Saved — I'll remind you the day
            // before Amma's birthday.", and the yearly push is real. Missing
            // here, a saved birthday was answered "that reminder wasn't
            // saved" and the model was told to add it again (2026-09-27).
            "remember_person_date"],
    claim: /\b(reminder (is )?(set|saved)|i'?ve set|alarm (is )?set|scheduled it|i'?ll remind you)\b/i,
    // रिमाइंडर/अलार्म सेट…, ರಿಮೈಂಡರ್/ಅಲಾರಂ ಇಟ್ಟ…, நினைவூட்ட…, గుర్తు చేస…, ഓർമ്മിപ്പിക്ക…
    claimIntl: /(रिमाइंडर\s*(सेट|लगा)|अलार्म\s*(सेट|लगा)|याद\s*दिला|ರಿಮೈಂಡರ್|ಅಲಾರಂ|ಅಲಾರಾಂ|ನೆನಪಿಸ|நினைவூட்ட|அலாரம்|గుర్తు\s*చేస|అలారం|ഓർമ്മിപ്പിക്ക|അലാറം)/,
    honest: () => "That reminder wasn't saved — say it again and I'll set it.",
  },
  {
    // STOPPING IS NOT SETTING. "I've turned off your alarm" is satisfied by
    // stop_alarm, never by set_alarm, so it needs its own family — and
    // without one the tools would not be filed into the session at all
    // (registry only records what backs a claim), leaving the assistant to
    // deny work it had just done.
    id: "clockoff",
    tools: ["stop_alarm", "snooze_alarm", "stop_timer"],
    // EVERY ALTERNATIVE MUST NAME THE ALARM OR THE TIMER. A generic
      // "turned off" also matches "I turned off the lights for you", which
      // phone_control legitimately says — scoping it broadly rewrote a
      // true statement about the torch into a clock failure.
      //
      // Present continuous counts as a claim: these tools speak as they
      // act ("Snoozing that alarm."), so a past-tense-only pattern let
      // their own wording through unchecked.
    claim:
      /\b(snoozing|snoozed)\b|\b(alarms?|timers?)\b[^.]{0,24}\b(off|cancelled|canceled|stopped)\b|\b(turn(ed|ing)?|switch(ed|ing)?|stop(ped|ping)?|cancel(led|ing|ling)?|shut(ting)?)\b[^.]{0,24}\b(alarms?|timers?)\b/i,
    claimIntl: /(अलार्म\s*(बंद|रद्द)|टाइमर\s*बंद|ಅಲಾರಂ\s*(ಆಫ್|ನಿಲ್ಲಿಸ)|ಟೈಮರ್\s*ನಿಲ್ಲಿಸ|அலாரம்\s*நிறுத்த|అలారం\s*ఆపా)/,
    honest: () => "I couldn't turn that off — say it again and I'll try.",
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
    // THINGS THE ASSISTANT PRODUCED. create_document hands back a real
    // .pdf/.pptx/.docx/.xlsx, and the model narrates that as "I've made
    // your deck" / "your report is ready" — words no existing family
    // recognised, which would have left a brand-new capability apologising
    // for work the user can see in their documents list.
    //
    // THE NOUN IS LOAD-BEARING. A bare "created"/"made" also fits "I've
    // created that reminder", which belongs to `remind` and would be
    // denied here — so a sentence only counts as this family's claim when
    // it names the THING that was produced.
    //
    // Membership overlaps `record` on purpose: "I've saved the report to
    // your documents" satisfies both readings, and whichever family
    // classifies first must find the tool that ran.
    id: "create",
    tools: ["create_document", "save_web_document", "present_text",
            "generate_image", "generate_video", "capture_document",
            // Photo cards (2026-09-26): "I've made your card", "the photo is
            // done". Their follow-up [SYSTEM] turns run no tool; the app's
            // own lines vouch for them instead (appNoteVouches below).
            "make_greeting_poster", "change_poster", "improve_old_photo",
            // Sharing saves the finished card to his documents first, so
            // "the card is saved in your documents, WhatsApp is open" is
            // true after it — and was being rewritten into "nothing was
            // saved" (review, 2026-09-26).
            "share_poster"],
    // A "card" is a greeting card here, never a business, ID or bank
    // card: "done, the business card is in your contacts" belongs to the
    // scanner, and must not be read as a claim to have made something.
    claim:
      /\b(created|made|prepared|generated|built|drafted|put together|written up|drawn up|ready|done)\b[^.]{0,40}\b(pdf|document|report|letter|deck|presentation|slides?|powerpoint|word file|spreadsheet|sheet|excel|workbook|invoice|proposal|resume|cv|file|image|picture|poster|(?<!\b(?:business|visiting|id|identity|credit|debit|atm|aadhaar|aadhar|pan|ration|voter|sim|sd|memory|news|report|smart|contact)\s)card|photo|video)\b|\b(your|the)\b\s+\b(pdf|deck|presentation|slides?|powerpoint|spreadsheet|report|document|file|image|video|poster|card)\b[^.]{0,20}\b(is|'s)\s+(ready|done|saved|in your documents)\b/i,
    // बना दिया…, ತಯಾರಿಸ…/ಮಾಡಿದೆ…, உருவாக்க…, తయారు చేస…, ഉണ്ടാക്കി…
    claimIntl: /(बना\s*(दिया|दी|लिया)|तैयार\s*(कर|है)|ತಯಾರಿಸ|ಮಾಡಿ\s*(ದೆ|ಕೊಟ್ಟ)|ಸಿದ್ಧ|உருவாக்க|தயாரித்த|తయారు\s*చేస|సిద్ధం|ഉണ്ടാക്കി|തയ്യാറാക്കി)/,
    honest: () => "I couldn't create that file — nothing was saved.",
  },
  {
    id: "record",
    tools: ["record_entry", "amend_last_entry", "record_patient_payment", "remember_fact",
            "remember_person", "add_person_note", "file_document_under_client",
            "associate_document", "save_web_document", "send_developer_feedback",
            "save_upi_id",
            // "Logged your water", "noted it down", "I've saved today's list".
            "plan_my_day", "complete_priority", "add_habit", "check_habit",
            // "I've saved the clearer photo to your documents" — the keep
            // step of improve_old_photo (2026-09-26); and the card a share
            // saved first.
            "improve_old_photo", "share_poster",
            // EVERY TOOL THAT SAVES WHAT THE USER TOLD IT (2026-09-27). "I've
            // saved your bike EMI" after add_finance_item was rewritten into
            // "that wasn't saved", and the live model was told to add it
            // again — add_finance_item does not de-duplicate, so the EMI was
            // recorded twice. A saving tool no family names can never back
            // the words it is described with.
            "remember_person_date", "add_finance_item", "update_finance_item",
            "add_standing_instruction", "remember_event", "remember_case",
            "update_my_profile",
            // "Saved your shortcut" (2026-09-27).
            "create_shortcut", "update_shortcut", "delete_shortcut", "save_last_as_shortcut"],
    claim: /\b(logged|recorded|noted it down|saved (it |that )?(to|in) your|saved (the|your) shortcut|filed under|i'?ve (written|saved)|written that down)\b/i,
    // सहेज/सेव/नोट कर…, ಉಳಿಸ/ಸೇವ್ ಮಾಡ…, சேமிக்க…, సేవ్ చేస…, സേവ് ചെയ്…
    claimIntl: /(सहेज|सेव\s*कर|नोट\s*कर|लिख\s*दिया|ಉಳಿಸ|ಸೇವ್\s*ಮಾಡ|ಬರೆದಿ|சேமிக்க|குறித்து|సేవ్\s*చేస|రాశా|സേവ്\s*ചെയ്|എഴുതി)/,
    honest: () => "That wasn't saved — nothing was written down.",
  },
];

/** Filler that only makes sense after a successful action — "There you
 *  go!", "Take a look." Left standing after a correction it reads as if
 *  something still happened. */
const FILLER = /^(there you go|take a look|all set|done|enjoy|have a look|check it out|that's it)[!.…]*$/i;

/**
 * CALL HISTORY IS NOT A CALL CLAIM — AND THE ASSISTANT'S OWN DIALLING
 * ALWAYS IS.
 *
 * Once the phone reads its call log (phone_calls, 2026-09-24) the true
 * answer is "Ravi was calling you at 3:10", and the bare word "calling"
 * would rewrite it into "I couldn't start that call". The first fix
 * exempted any "was / been / kept / tried calling" — which also let the
 * assistant's own false claims through: "I tried calling Ravi but he
 * didn't pick up", "I was calling him just now", "I kept ringing him",
 * with place_phone_call never having run.
 *
 * So the exemption is read per occurrence, from the clause in front of
 * the call word, and anything it is unsure of stays a CLAIM:
 *   - "I" / "we" anywhere in that clause → CLAIM ("I only kept calling
 *     him", "we just tried ringing him"). A leading "I see / I think /
 *     looks like" is only a preamble and is set aside first.
 *   - no subject at all → CLAIM: a dropped subject is the speaker's
 *     ("Calling Ravi now", "Tried calling him", "Ringing you through",
 *     "Okay Sir calling you back" — "Okay Sir" is nobody).
 *   - a named subject calling THE OWNER → history ("Ravi was calling you",
 *     "Amma's ringing you").
 *   - a named person who WAS / HAS BEEN / KEPT / TRIED "calling" → history
 *     ("Amma has been calling since nine"). Only "calling": "it was
 *     ringing", "his phone kept ringing" describe the assistant's own
 *     call, and a phone or line is never the person in the call log.
 * A sentence with one history reading and one claim ("Ravi was calling
 * you, so I'm calling him back") is a claim.
 *
 * Not keyed to "phone_calls ran this turn": the phone answers that tool
 * with a [SYSTEM] line, so the reading is spoken in the NEXT turn, and in
 * the tool's own turn the exemption would only open a hole ("Checking your
 * calls. Calling Ravi now.").
 */
const CALL_WORD = /\b(calling(?!\s+(?:service|feature|balance|limit)\b)|dialling|dialing|ringing)\b/gi;
const CALL_PHRASE = /\b(connecting your call|placing the call)\b/i;
const FIRST_PERSON = /\b(?:i|we)\b/i;
const PREAMBLE =
  /^\s*(?:(?:i|we)\s+(?:can\s+)?(?:see|think|notice|noticed|found|checked)(?:\s+that)?|(?:it\s+)?(?:looks|seems)\s+like)\s+/i;
const OWNER_OBJECT = /^\s+you\b/i;
// Auxiliaries and adverbs between a subject and its verb. What is left
// once they are peeled off the end of the clause is the subject.
const HELPERS = new Set([
  "am", "is", "are", "was", "were", "be", "been", "being", "has", "have", "had",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must",
  "do", "does", "did", "keep", "keeps", "kept", "try", "tries", "tried",
  "just", "also", "still", "already", "really", "actually", "even", "again",
  "now", "then", "repeatedly", "only", "honestly", "literally", "twice",
]);
const PAST_OR_REPEATED = new Set(["was", "were", "been", "kept", "keeps", "tried", "tries"]);
const NOT_A_PERSON = /\b(it|phone|line|number|mobile|call)\b/i;
// Words that stand where a subject would but are nobody: how the
// assistant opens a sentence to the owner. "Okay Sir calling you back"
// has no subject at all, so it is the speaker's own call — without this
// "Okay Sir" read as the name of whoever was calling.
const NOT_A_SUBJECT = new Set([
  "sir", "ma'am", "maam", "madam", "okay", "ok", "sure", "alright", "right",
  "yes", "yeah", "fine", "great", "done", "well", "so", "hi", "hello", "now",
]);

function isOnlyCallHistory(sentence) {
  const s = String(sentence || "");
  if (CALL_PHRASE.test(s)) return false;
  let seen = false;
  for (const m of s.matchAll(CALL_WORD)) {
    seen = true;
    const clause = s.slice(0, m.index)
      .split(/[,;:—–]|\s-\s|\b(?:and|but|so)\b/i).pop()
      .replace(PREAMBLE, "");
    if (FIRST_PERSON.test(clause)) return false;
    const words = clause.trim().split(/\s+/).filter(Boolean);
    const helpers = [];
    while (words.length && HELPERS.has(words[words.length - 1].toLowerCase())) {
      helpers.push(words.pop().toLowerCase());
    }
    const subject = words
      .filter((w) => !NOT_A_SUBJECT.has(w.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z']/g, "")))
      .join(" ");
    if (!subject) return false;
    const after = s.slice(m.index + m[0].length);
    if (OWNER_OBJECT.test(after)) continue;
    if (m[1].toLowerCase() === "calling" && !NOT_A_PERSON.test(subject) &&
        helpers.some((h) => PAST_OR_REPEATED.has(h))) continue;
    return false;
  }
  return seen;
}

/** Does this sentence claim this family's action, in any script? */
function claims(family, sentence) {
  const english = (family.matches ? family.matches(sentence) : family.claim.test(sentence)) &&
    !(family.onlyHistory && family.onlyHistory(sentence));
  return english ||
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

const ranOkOf = (executed) =>
  new Set((executed || []).filter((e) => e && e.ok !== false).map((e) => e.tool));

/** Does what ran back this family's claim — and is it one it CAN back? */
function backs(family, sentence, ranOk) {
  if (family.overclaims && family.overclaims(String(sentence || ""))) return false;
  return family.tools.some((t) => ranOk.has(t));
}

/**
 * The honest replacement for a sentence of this family. `executed` lets
 * it say what did happen (a video note queued, not sent).
 */
function honestFor(familyId, sentence, executed = []) {
  const f = FAMILIES.find((x) => x.id === familyId);
  return f ? f.honest(sentence, ranOkOf(executed)) : sentence;
}

/**
 * Did a tool of this family run (successfully) in the given list? With
 * the sentence, a claim the family's tools can never back (overclaims)
 * is not satisfied either.
 */
function satisfied(familyId, executed = [], sentence = "") {
  const f = FAMILIES.find((x) => x.id === familyId);
  if (!f) return true;
  return backs(f, sentence, ranOkOf(executed));
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

  const ranOk = ranOkOf(executed);
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
    if (backs(family, s, ranOk)) {
      out.push(s);
      continue;
    }
    // An unsupported claim. Replace that sentence with the truth rather
    // than appending a contradiction after it.
    violations.push(`${family.id}: "${s.slice(0, 80)}"`);
    out.push(family.honest(s, ranOk));
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

/**
 * WHAT THE APP'S OWN [SYSTEM] LINES VOUCH FOR (photo cards, 2026-09-26).
 * The card screen reports back with lines like "[SYSTEM] Signature saved
 * on this phone; it is on the card now." — a turn in which no tool runs,
 * so "Done, your signature is on the card now" had nothing behind it and
 * was rewritten into "I couldn't create that file — nothing was saved",
 * straight after it was saved. The line itself is the evidence: the phone
 * only sends it once the thing is on the card. Returns the tools such a
 * line stands for (runtime and live proxy file them for the reply), or [].
 * Only the lines that say something landed: "the picker was closed…
 * Nothing was made" vouches for nothing, and neither does any
 * "[SYSTEM] ERROR:" line — the app's own failure reports, some of which
 * name the card ("the photo on the card has not arrived on this phone
 * yet, so nothing was sent"; integration check, 2026-09-26).
 */
function appNoteVouches(text) {
  const t = String(text || "");
  if (!/^\s*\[SYSTEM\]/.test(t) || /^\s*\[SYSTEM\]\s*ERROR\b/i.test(t) ||
      /\bnothing was (made|cut|changed|saved|sent)\b/i.test(t)) return [];
  const out = [];
  if (/\b(on the card|card is on the screen)\b/i.test(t)) out.push("change_poster");
  if (/\bcleaned-up photo is on the screen\b/i.test(t)) out.push("improve_old_photo");
  if (/\bopen with the card\b/i.test(t)) out.push("share_poster");
  return out;
}

/**
 * Every tool any family relies on.
 *
 * The registry needs this: it only files WORLD ACTIONS into the session's
 * claim-checking list, and a family tool that is not a world action can
 * therefore never be seen to have run — so the assistant is made to
 * apologise for it. open_named_app opened BigBasket and was contradicted
 * ten seconds later for exactly this reason, as were enable_usage_tracking
 * and, quietly, remember_fact.
 */
const FAMILY_TOOLS = new Set(FAMILIES.flatMap((f) => f.tools));

module.exports = {
  check, classify, claims, honestFor, satisfied, familiesAskedAbout, appNoteVouches,
  FAMILIES, FAMILY_TOOLS,
};
