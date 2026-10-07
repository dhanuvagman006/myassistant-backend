/**
 * WHICH TOOLS THIS TURN ACTUALLY NEEDS.
 * ---------------------------------------------------------------
 * MEASURED 2026-09-20 against production: the tool catalogue, not the
 * prompt, is what makes a turn slow. 107 declarations are 84 KB, and the
 * same request answers in ~10 s with five tools and ~26 s with all of
 * them. Every user waits that difference on every single turn.
 *
 * So the catalogue is chosen per turn instead of being sent whole.
 *
 * THE DANGER IS OBVIOUS AND IT DRIVES THE DESIGN: a tool that is not
 * offered cannot be called, so a miss does not make the assistant slower,
 * it makes it incapable — "order biryani" with order_food left out is a
 * flat refusal for something the app does. Every choice below is biased
 * against that:
 *
 *   • CORE is always present — conversation, memory, search, reminders,
 *     calling, documents. The tools a turn reaches for out of nowhere.
 *   • Scoring reads each tool's OWN DESCRIPTION, which is written in the
 *     user's words ("order biryani from Swiggy", "wake-up call") — so
 *     matching is against the phrases people actually say.
 *   • The previous turn's selection is carried forward, because "yes, do
 *     it" carries no signal of its own.
 *   • Anything scoring at all is kept, up to a generous cap. The cap is a
 *     ceiling on the worst case, not a target.
 *   • Below MIN_SIGNAL total score the whole catalogue is sent. A turn we
 *     cannot read is a turn we do not gamble on.
 */

const CORE = new Set([
  // Holding the conversation
  "end_conversation", "present_text", "draft_text", "edit_draft", "recall_conversation",
  // Knowing the user
  "remember_fact", "recall_memory", "lookup_person", "update_my_profile",
  // The things asked for constantly, in any context
  "web_search", "get_weather", "daily_brief", "play_daily_brief", "create_reminder",
  // "what's near me" is asked constantly and has no near-synonym the
  // scorer would catch from a two-word question.
  "find_places_nearby", "get_current_location",
  "list_reminders", "schedule_task", "place_phone_call",
  "send_agent_message", "send_whatsapp_message",
  "search_documents", "create_document",
  // "Arnesh vs State of Bihar pdf" — a public PDF, asked out of nowhere
  // (2026-10-07); without it the turn only had the user's own files.
  "open_public_pdf",
  "list_calendar_events", "create_calendar_event",
  "open_named_app", "check_recent_actions",
  // Disappointment rarely names the tool: "this is useless", "why can't
  // you…" must still reach the developer.
  "send_developer_feedback",
  // "delete Instagram", "get rid of this game", "remove the app".
  "uninstall_app",
  // "Any missed calls?", "did Ravi call?" — asked out of nowhere, and a
  // miss here is the assistant guessing call history (2026-09-24).
  "phone_calls",
  // "Add this to my shopping list" — groceries, a dress, anything — must
  // work in any ordinary conversation (the owner, 2026-09-29).
  "shopping_list_add", "shopping_list_show",
]);

/**
 * Words that carry no signal about which tool is wanted.
 *
 * KEPT DELIBERATELY SHORT. The first version also stopped "out", "need",
 * "make", "get", "tell" and "say" — which are not filler, they are how
 * people name actions. "I have to go out today" reduced to the single
 * token "today" and matched nothing, so the one tool written for that
 * sentence was never selected. Only true grammar goes here.
 */
const STOP = new Set(
  ("a an the and or but if then than that this these those is are was were be " +
   "been being do does did doing done have has had having i me my mine we us " +
   "our you your he she it they them his her its their to for of in on at by " +
   "with from again once such no nor not only own same so too very can will " +
   "just please hey okay ok yes yeah what which who whom")
    .split(" ")
);

// TWO LETTERS IS A WORD: "go", "up", "AC", "hi". Three was chosen for
// tidiness and it cost the shortest, most common requests their signal.
const words = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9ऀ-෿\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP.has(w));

/** Token set per tool, built once from its name and description. */
const vocab = new Map();
function tokensFor(tool) {
  const hit = vocab.get(tool.name);
  if (hit) return hit;
  const name = new Set(words(tool.name.replace(/_/g, " ")));
  const desc = new Set(words(tool.description).slice(0, 400));
  const v = { name, desc };
  vocab.set(tool.name, v);
  return v;
}

/** Last selection per session — "yes, do it" has no signal of its own. */
const lastPick = new Map(); // sessionId -> { names:Set, at:number }
const CARRY_MS = 10 * 60_000;

function remember(sessionId, names) {
  if (!sessionId) return;
  lastPick.set(sessionId, { names: new Set(names), at: Date.now() });
  if (lastPick.size > 500) {
    for (const [k, v] of lastPick) {
      if (Date.now() - v.at > CARRY_MS) lastPick.delete(k);
    }
  }
}

function carried(sessionId) {
  const hit = sessionId && lastPick.get(sessionId);
  if (!hit) return [];
  if (Date.now() - hit.at > CARRY_MS) {
    lastPick.delete(sessionId);
    return [];
  }
  return [...hit.names];
}

const MAX_TOOLS = 55;   // ceiling on the worst case, not a target
const MIN_SIGNAL = 2;   // below this the turn is unreadable — send everything

/**
 * @param {Array} tools      full tool list (registry.list() shape)
 * @param {string} text      what the user just said
 * @param {object} opts      { history: [{content}], sessionId }
 * @returns {string[]|null}  names to offer, or null for "send everything"
 */
function selectForTurn(tools, text, { history = [], sessionId = "" } = {}) {
  if (!Array.isArray(tools) || tools.length <= MAX_TOOLS) return null;

  // The current turn counts most; the two before it carry the thread.
  const recent = history.slice(-2).map((m) => String(m?.content || "")).join(" ");
  const q = new Set([...words(text), ...words(recent)]);
  if (!q.size) return null;

  let signal = 0;
  let best = 0;
  const scored = [];
  for (const t of tools) {
    const { name, desc } = tokensFor(t);
    let s = 0;
    for (const w of q) {
      if (name.has(w)) s += 3;
      else if (desc.has(w)) s += 1;
    }
    if (s > 0) scored.push([t.name, s]);
    if (s > best) best = s;
    signal += s;
  }
  // Nothing we can read — do not gamble on a trimmed set. `best` is the
  // stricter half: a turn where every tool matched only weakly (one stray
  // word in a long description) has told us nothing, and trimming on that
  // is how a capability quietly disappears. Only a confident match — a
  // tool NAME hit, or three separate description hits — earns a trim.
  if (signal < MIN_SIGNAL || best < 3) return null;

  scored.sort((a, b) => b[1] - a[1]);
  const picked = new Set(CORE);
  // Words that name their tools outright go before the carried set.
  for (const n of pinnedFor(text, new Set(tools.map((t) => t.name)))) picked.add(n);
  for (const n of carried(sessionId)) picked.add(n);
  for (const [n] of scored) {
    if (picked.size >= MAX_TOOLS) break;
    picked.add(n);
  }

  // Only tools that really exist (CORE is hand-written and can drift).
  const live = new Set(tools.map((t) => t.name));
  const out = [...picked].filter((n) => live.has(n));
  remember(sessionId, out);
  return out.length ? out : null;
}

/**
 * THE TRIGGER VOCABULARY — the words that name a tool, for the app's
 * router (GET /ai/config routing.toolWords). A request carrying one of
 * these goes to the cloud model with the tools; everything else may be
 * answered on the phone by Gemini Nano, which has none.
 *
 * Built from the tool NAMES (the same tokens selectForTurn scores highest),
 * not their descriptions: a description holds a hundred ordinary words,
 * and every one of them would send small talk to the cloud. The few name
 * tokens that say nothing about intent ("get", "list", "end"…) are left
 * out; the verbs people actually use arrive from the caller.
 */
const GENERIC = new Set(
  ("get list end check update add find present text web info details data " +
   "item items mode status result results run use show last new all any " +
   "into about " +
   // Common in small talk, and no sign of a tool on their own: a request
   // that needs one and carries none of the other words is still handed
   // on — Nano is told to answer [[CLOUD]] for anything it cannot do.
   "day date make look out try old change complete continue enable under " +
   "going stay recent current start stop remove improve associate analyze " +
   "configure consult convert expiring theme story case service person id " +
   "card screen entry entries amend lookup knowledge conversation assistant " +
   "agent priority tracking outcomes usage errands morning brief silent read").split(" ")
);
function triggerWords(tools, extra = []) {
  const out = new Set();
  for (const t of tools || []) {
    for (const w of words(String(t.name || "").replace(/_/g, " "))) {
      if (!GENERIC.has(w) && !/^\d+$/.test(w)) out.add(w);
    }
  }
  for (const w of extra) {
    const k = String(w || "").toLowerCase().trim();
    if (k) out.add(k);
  }
  return [...out].sort();
}

/**
 * The phone's cloud model (Firebase AI Logic) is slow in proportion to the
 * tools it is handed: never the whole catalogue there. A readable turn gets
 * selectForTurn's pick, capped at PHONE_MAX; an unreadable one ("hello",
 * "how are you") the core set plus what this session was using.
 * @returns {string[]} names to offer
 */
const PHONE_MAX = 40;
// Always on the phone besides CORE: the spoken prompt tells the model to
// call stay_silent for talk that was not meant for it.
const PHONE_ALWAYS = ["stay_silent"];

/**
 * PINNED BY WORDS (2026-09-30). A few requests must reach their tools
 * whatever the scores and the carried set say: past PHONE_MAX the
 * carried tools of earlier turns fill the room ahead of this turn's, so a
 * scored tool can still be cut. Two tools per pin, not CORE — they cost
 * nothing on the turns that do not say these words.
 */
const PINS = [
  // "Remember Ravi's house address", "where does Ravi live", "what's his
  // office address", and "remember that" said after one.
  {
    rx: /\baddress(es)?\b|\blives?\b|\bstays?\b|\bwhere does\b|\bhouse\b|\bhome\b|\boffice\b|\b(remember|save|note)\s+(that|this|it)\b/i,
    tools: ["remember_address", "show_address"],
  },
  // "Open my calendar / the news", "what's on my calendar": this app's own
  // screens and schedule, never a Google-only answer (2026-09-30).
  {
    rx: /\bcalendar\b|\bdiary\b|\bagenda\b|\bschedule\b|\bnews\b|\bopen\b|\bshow me\b/i,
    tools: ["open_app_screen", "show_schedule"],
  },
  // "Show me a picture / image / photo of X", "how does X look" — a
  // picture in the app, never Instagram (client, 2026-10-01).
  {
    rx: /\b(picture|pictures|image|images|photo|photos|pic|pics)\b|\bhow does\b.*\blook\b|\bwhat does\b.*\blook like\b/i,
    tools: ["show_pictures"],
  },
  // "Show me the search results for X", "google X" (2026-10-04).
  {
    rx: /\b(search results?|google (it|that|this)|google\b.*\bfor|on google|search (for )?.+ on google|^google\b)/i,
    tools: ["show_search_results"],
  },
];
function pinnedFor(text, live) {
  const t = String(text || "");
  return PINS.filter((p) => p.rx.test(t)).flatMap((p) => p.tools).filter((n) => live.has(n));
}

function selectForPhone(tools, text, opts = {}) {
  const live = new Set(Array.isArray(tools) ? tools.map((t) => t.name) : []);
  let picked = selectForTurn(tools, text, opts);
  if (!Array.isArray(picked)) {
    picked = [...new Set([...CORE, ...carried(opts.sessionId || "")])].filter((n) => live.has(n));
    remember(opts.sessionId || "", picked);
  }
  const always = PHONE_ALWAYS.filter((n) => live.has(n));
  const pins = pinnedFor(text, live);
  const kept = new Set([...CORE, ...always, ...pins]);
  const out = [...new Set([...always, ...pins, ...picked])];
  if (out.length <= PHONE_MAX) return out;
  // Past the cap the core set stays and the best-scored rest fill it.
  return [...out.filter((n) => kept.has(n)), ...out.filter((n) => !kept.has(n))].slice(0, PHONE_MAX);
}

module.exports = { selectForTurn, selectForPhone, triggerWords, pinnedFor, CORE, MAX_TOOLS, PHONE_MAX, PHONE_ALWAYS };
