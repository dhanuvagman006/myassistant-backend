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
  "end_conversation", "present_text", "recall_conversation",
  // Knowing the user
  "remember_fact", "recall_memory", "lookup_person", "update_my_profile",
  // The things asked for constantly, in any context
  "web_search", "get_weather", "daily_brief", "create_reminder",
  // "what's near me" is asked constantly and has no near-synonym the
  // scorer would catch from a two-word question.
  "find_places_nearby", "get_current_location",
  "list_reminders", "schedule_task", "place_phone_call",
  "send_agent_message", "send_whatsapp_message",
  "search_documents", "create_document",
  "list_calendar_events", "create_calendar_event",
  "open_named_app", "check_recent_actions",
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

module.exports = { selectForTurn, CORE, MAX_TOOLS };
