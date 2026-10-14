/**
 * WHAT A CONNECTED APP'S KEY MAY DO. The user ticks these when they connect
 * the app, and can change them any time; a key carries its app's scopes as
 * they are NOW (read on every request), so unticking one takes effect at
 * once without a new key.
 */
const SCOPES = Object.freeze([
  { id: "assistant", title: "Talk to your assistant", detail: "Chat with the same assistant, memory and tools as in My Assistant.", default: true },
  { id: "voice", title: "Voice conversations", detail: "Open a live voice-to-voice session with your assistant.", default: true },
  { id: "data", title: "Keep its own data", detail: "Save and read this app's own records and activity. Your assistant can read them back to you.", default: true },
  { id: "memory:read", title: "Read your memory", detail: "Read what your assistant remembers about you.", default: true },
  { id: "memory:write", title: "Add to your memory", detail: "Add facts to what your assistant remembers about you.", default: false },
  { id: "tools", title: "Use assistant tools directly", detail: "Run your assistant's tools (reminders, search, weather, lists…) without a conversation.", default: false },
  { id: "notify", title: "Send you notifications", detail: "Show a notification on your phone (up to 20 a day).", default: true },
  { id: "profile", title: "Know your name", detail: "Read your name and your assistant's name.", default: true },
]);

const IDS = new Set(SCOPES.map((s) => s.id));
const DEFAULTS = SCOPES.filter((s) => s.default).map((s) => s.id);

/** Known scopes only, in catalogue order; undefined → the defaults. */
function clean(v) {
  if (v === undefined || v === null) return [...DEFAULTS];
  const arr = Array.isArray(v) ? v : String(v).split(/[\s,]+/);
  const want = new Set(arr.map((s) => String(s).trim()).filter((s) => IDS.has(s)));
  return SCOPES.map((s) => s.id).filter((id) => want.has(id));
}

module.exports = { SCOPES, IDS, DEFAULTS, clean };
