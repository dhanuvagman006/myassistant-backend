/**
 * THE LIVE SESSION'S TOOLS (POST /ai/context, mode "live"; 2026-09-30).
 *
 * The Live API takes its tools once, when the session opens, and keeps
 * them for the whole conversation — there is no per-turn relevance pick
 * as the cascade has (tools/relevance.selectForPhone). So a Live session
 * gets one fixed set: the phone's core set (relevance.CORE and
 * PHONE_ALWAYS) plus the few spoken requests that come out of nowhere
 * (alarms, timers, phone settings, music), in the order below, at most
 * LIVE_MAX. The order is the priority: past the cap the tail goes first.
 * Gating is unchanged — availability, build and permissions decide
 * (registry.declarations) before the cap is applied.
 */
// 36 (was 32, 2026-09-30): room for meeting prep, posters and pictures.
// Measured with a 30k-char prompt and 32 tools: setup 1.8 s, first audio
// 1.5 s after a tool call — the size of this list barely moves either.
// 40 (2026-09-30): room for remember_address and show_address.
const LIVE_MAX = 40;

// Most needed first. Anything new in CORE that is not listed here still
// joins, after these, while there is room.
const LIVE_ORDER = [
  "stay_silent", "end_conversation",
  "web_search", "get_weather", "find_places_nearby", "get_current_location",
  "create_reminder", "list_reminders", "schedule_task", "set_alarm", "set_timer",
  "place_phone_call", "phone_calls", "send_agent_message", "send_whatsapp_message",
  "list_calendar_events", "create_calendar_event",
  // The wow tools (2026-09-30). "What's my day" stays daily_brief below:
  // Live speaks the brief itself in its own voice, faster than the
  // play_daily_brief player.
  "prepare_meeting", "create_event_poster", "generate_image",
  // "Open the news / my calendar": this app's own screens (2026-09-30,
  // it was past the cap, so Live opened other apps or said "not connected").
  "open_app_screen", "open_named_app", "phone_control", "play_music",
  "remember_fact", "recall_memory",
  // "Remember Ravi's house address" / "what's Ravi's address" (2026-09-30).
  "remember_address", "show_address",
  "lookup_person", "update_my_profile", "recall_conversation",
  "check_recent_actions", "daily_brief", "shopping_list_add", "shopping_list_show",
  "search_documents", "edit_my_photo", "create_document", "present_text",
  "send_developer_feedback", "uninstall_app",
];

/**
 * The names to offer, in priority order. `must` (a pending question's
 * tool, the shortcut tools) go right after the two conversation tools.
 */
function liveNames(allTools, { must = [] } = {}) {
  const { CORE, PHONE_ALWAYS } = require("../tools/relevance");
  const live = new Set((allTools || []).map((t) => t.name));
  const ordered = [...new Set([
    ...LIVE_ORDER.slice(0, 2), ...must, ...LIVE_ORDER, ...PHONE_ALWAYS, ...CORE,
  ])];
  return ordered.filter((n) => live.has(n));
}

/** Gated declarations back in priority order, capped at LIVE_MAX. */
function capDeclarations(decls, names) {
  const rank = new Map(names.map((n, i) => [n, i]));
  return (decls || [])
    .filter((d) => rank.has(d.name))
    .sort((a, b) => rank.get(a.name) - rank.get(b.name))
    .slice(0, LIVE_MAX);
}

module.exports = { liveNames, capDeclarations, LIVE_MAX, LIVE_ORDER };
