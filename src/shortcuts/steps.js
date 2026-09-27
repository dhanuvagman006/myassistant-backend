/**
 * SHORTCUT STEPS — what one shortcut may do, in what order, and how each
 * step is said back.
 *
 * STEP_TOOLS is the allowlist. A tool not named here can never be a step,
 * whatever the model, the phone or a crafted REST body sends: money,
 * business calls, deleting, forgetting and every rule about the user stay
 * the user's own step, always (design: shortcuts.md §2).
 *
 * Classes decide the order, because Android only lets an app open another
 * app while it is in front:
 *   server     runs on the server; nothing reaches the phone
 *   in_app     the phone does it without leaving the app (ringer, torch…)
 *   hand_back  leaves for another app where the owner taps Send, then back
 *   stays      leaves for another app and stays there (directions, music)
 *   app_task   the do-it-for-me engine takes over the phone — always last
 *
 * `class` and `label` are ALWAYS recomputed here, never trusted from a
 * client.
 */
const MAX_STEPS = 10;
const MAX_SHORTCUTS = 50;
const MAX_NAMES = 4;
const MAX_STEP_TEXT = 300;
const MAX_MESSAGE = 500;
const MIN_BUILD = 120;

/** phone_control actions a step may use (never go_home, battery, settings). */
const PHONE_ACTIONS = new Set([
  "flashlight_on", "flashlight_off", "volume_set", "volume_up", "volume_down",
  "mute", "unmute", "media_play", "media_pause", "media_next", "media_previous",
  "ringer_silent", "ringer_vibrate", "ringer_normal", "dnd_on", "dnd_off",
]);
/** The phone_control actions that arrive in app build 120. */
const RINGER_ACTIONS = new Set(["ringer_silent", "ringer_vibrate", "ringer_normal", "dnd_on", "dnd_off"]);

const STEP_TOOLS = {
  phone_control: { cls: "in_app", keep: ["action", "value"] },
  set_alarm: { cls: "in_app", keep: ["hour", "minute", "label"] },
  set_timer: { cls: "in_app", keep: ["minutes", "label"] },
  start_focus: { cls: "in_app", keep: ["minutes", "label"], minBuild: 111 },
  open_app_screen: { cls: "in_app", keep: ["screen"] },
  send_whatsapp_message: { cls: "hand_back", keep: ["to", "message", "is_group"] },
  start_navigation: { cls: "stays", keep: ["destination"] },
  play_music: { cls: "stays", keep: ["query", "provider"] },
  open_named_app: { cls: "stays", keep: ["app"], force: { install: false } },
  open_webpage: { cls: "stays", keep: ["url"] },
  create_reminder: { cls: "server", keep: ["text"] },
  plan_my_day: { cls: "server", keep: ["priorities"], speaks: true },
  check_habit: { cls: "server", keep: ["habit"] },
  get_weather: { cls: "server", keep: ["location"], speaks: true },
  daily_brief: { cls: "server", keep: [], speaks: true },
  get_news: { cls: "server", keep: ["topic"], speaks: true },
  send_agent_message: { cls: "server", keep: ["contact_name", "message"], confirmEachRun: true },
  email_send: { cls: "server", keep: ["to", "subject", "body"], confirmEachRun: true },
  do_task_in_app: { cls: "app_task", keep: ["goal", "category", "app", "query", "url"], minBuild: 104 },
};
const STEP_TOOL_NAMES = Object.keys(STEP_TOOLS);

/** Why a tool can never be a step, in words the model can say. */
function whyNot(tool) {
  const t = String(tool || "");
  if (/pay|upi|payment|money|finance/.test(t)) return "money is always your own step";
  if (/book|order_food|ride|movie|call|meeting/.test(t)) return "calls and bookings are always your own step";
  if (/delete|forget|remove|cancel|uninstall/.test(t)) return "deleting is always your own step";
  if (/instruction|configure|profile|remember/.test(t)) return "changing what I know about you is never a shortcut step";
  if (/shortcut/.test(t)) return "a shortcut can't run another shortcut";
  return "that can't be part of a shortcut";
}

const CLASS_RANK = { server: 0, in_app: 0, hand_back: 1, stays: 2, app_task: 3 };

function classify(step) {
  return (STEP_TOOLS[step && step.tool] || {}).cls || null;
}

const clip = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

function hostOf(url) {
  try { return new URL(String(url)).host.replace(/^www\./, ""); } catch (_) { return "a page"; }
}

function clock(h, m) {
  const hh = Number(h) || 0;
  const ap = hh >= 12 ? "pm" : "am";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(Number(m) || 0).padStart(2, "0")} ${ap}`;
}

const SCREEN_WORDS = {
  momentum: "Momentum", focus: "the focus timer", reminders: "your reminders",
  documents: "your documents", news: "the news", finance: "your finances",
  settings: "settings", hub: "the Hub", chat: "Chat", home: "Home",
};

const PHONE_LABEL = {
  ringer_silent: "Phone on silent", ringer_vibrate: "Vibrate only", ringer_normal: "Ringer on",
  dnd_on: "Do not disturb on", dnd_off: "Do not disturb off",
  flashlight_on: "Torch on", flashlight_off: "Torch off",
  volume_up: "Volume up", volume_down: "Volume down",
  mute: "Mute media", unmute: "Unmute media",
  media_play: "Play music", media_pause: "Pause music",
  media_next: "Next track", media_previous: "Previous track",
};

function whenWords(when) {
  if (!when) return "";
  if (when.in_minutes) return ` in ${when.in_minutes} min`;
  if (when.at) {
    const [h, m] = String(when.at).split(":");
    return ` at ${clock(h, m)}`;
  }
  return "";
}

/** The step as one short line. No company names: the user's own words only. */
function labelFor(step) {
  const a = (step && step.args) || {};
  switch (step && step.tool) {
    case "phone_control":
      if (a.action === "volume_set") return `Volume ${Number(a.value ?? 50)}%`;
      return PHONE_LABEL[a.action] || "Phone setting";
    case "set_alarm": return `Alarm ${clock(a.hour, a.minute)}`;
    case "set_timer": return `Timer ${Number(a.minutes) || 0} min`;
    case "start_focus": return `Focus ${Number(a.minutes) || 25} min`;
    case "open_app_screen": return `Open ${SCREEN_WORDS[a.screen] || a.screen}`;
    case "send_whatsapp_message":
      return `Chat message to ${clip(a.to || "the chat you pick", 40)}: “${clip(a.message, 60)}” (you tap Send)`;
    case "start_navigation": return `Directions to ${clip(a.destination, 80)}`;
    case "play_music": return `Play “${clip(a.query, 50)}”`;
    case "open_named_app": return `Open ${clip(a.app, 40)}`;
    case "open_webpage": return `Open ${hostOf(a.url)}`;
    case "create_reminder": return `Reminder${whenWords(step.when)}: ${clip(a.text, 60)}`;
    case "plan_my_day": return "Today's 3";
    case "check_habit": return `Tick ${clip(a.habit, 40)}`;
    case "get_weather": return "Weather";
    case "daily_brief": return "Today's brief";
    case "get_news": return "Headlines";
    case "send_agent_message": return `Message to ${clip(a.contact_name, 40)}: “${clip(a.message, 60)}”`;
    case "email_send": return `Email to ${clip(a.to, 40)}: “${clip(a.subject, 50)}”`;
    case "do_task_in_app": return `In ${clip(a.app || "your phone", 30)}: ${clip(a.goal, 70)}`;
    default: return clip(step && step.said, 60) || "A step";
  }
}

/** The line a preflight question uses for a step that needs a yes. */
function confirmLine(step) {
  const a = step.args || {};
  if (step.tool === "send_agent_message") return `send ${a.contact_name}'s assistant “${a.message}”`;
  if (step.tool === "email_send") return `email ${a.to} “${a.subject}”`;
  return labelFor(step).toLowerCase();
}

function stepIcon(step) {
  const a = step.args || {};
  if (step.tool === "phone_control") {
    if (/ringer|mute|dnd/.test(a.action)) return "volume_off";
    if (/flashlight/.test(a.action)) return "flashlight";
    return "tune";
  }
  return {
    set_alarm: "alarm", set_timer: "timer", start_focus: "timer", open_app_screen: "apps",
    send_whatsapp_message: "chat", start_navigation: "directions", play_music: "music",
    open_named_app: "apps", open_webpage: "web", create_reminder: "reminder",
    plan_my_day: "list", check_habit: "check", get_weather: "weather", daily_brief: "brief",
    get_news: "news", send_agent_message: "send", email_send: "mail", do_task_in_app: "touch",
  }[step.tool] || "bolt";
}

/** Stable sort by class rank; says whether the order changed. */
function orderSteps(steps) {
  const idx = steps.map((s, i) => ({ s, i }));
  idx.sort((x, y) => (CLASS_RANK[classify(x.s)] - CLASS_RANK[classify(y.s)]) || (x.i - y.i));
  return { steps: idx.map((x) => x.s), reordered: idx.some((x, k) => x.i !== k) };
}

/** Keep only the args a step may carry, coerced by the tool's own schema. */
function cleanArgs(tool, raw) {
  const def = STEP_TOOLS[tool];
  const registry = require("../tools/registry");
  const t = registry.get(tool);
  const picked = {};
  for (const k of def.keep) if (raw && raw[k] !== undefined && raw[k] !== null && raw[k] !== "") picked[k] = raw[k];
  const args = t ? registry.coerceArgs(t, picked) : picked;
  return { ...args, ...(def.force || {}) };
}

const isHttps = (u) => /^https:\/\/[^\s]+$/i.test(String(u || ""));
const SPOKEN = new Set(["get_weather", "daily_brief", "get_news", "plan_my_day"]);

/**
 * Validate and normalise a list of steps. Returns {ok, steps, warnings}
 * or {ok:false, error, data}. Each step comes back with class and label
 * recomputed.
 */
function validate(input, { build = 0 } = {}) {
  const list = Array.isArray(input) ? input : [];
  if (!list.length) return { ok: false, error: "no_steps", data: {} };
  if (list.length > MAX_STEPS) return { ok: false, error: "too_many_steps", data: { max: MAX_STEPS } };
  const registry = require("../tools/registry");
  const targetOf = require("../actions/store").targetOf;
  const out = [];
  const seen = new Set();
  let spoken = 0;
  for (let i = 0; i < list.length; i++) {
    const n = i + 1;
    const raw = list[i] || {};
    const tool = String(raw.tool || "");
    const said = String(raw.said || "").trim();
    if (said.length > MAX_STEP_TEXT) return { ok: false, error: "step_too_long", data: { n, max: MAX_STEP_TEXT } };
    const def = STEP_TOOLS[tool];
    if (!def || !registry.get(tool)) {
      return { ok: false, error: "step_not_allowed", data: { n, said, why: whyNot(tool) } };
    }
    const args = cleanArgs(tool, raw.args || {});
    const t = registry.get(tool);
    const missing = registry.missingRequired(t, args);
    if (missing.length) {
      return { ok: false, error: "needs_detail", data: { n, said, missing, question: `What should step ${n} use for ${missing.join(", ")}?` } };
    }
    for (const k of ["message", "body"]) {
      if (typeof args[k] === "string" && args[k].length > MAX_MESSAGE) {
        return { ok: false, error: "step_too_long", data: { n, max: MAX_MESSAGE } };
      }
    }
    for (const v of Object.values(args)) {
      if (typeof v === "string" && v.length > MAX_MESSAGE) return { ok: false, error: "step_too_long", data: { n, max: MAX_MESSAGE } };
    }
    if (tool === "phone_control") {
      if (!PHONE_ACTIONS.has(args.action)) {
        return { ok: false, error: "step_not_allowed", data: { n, said, why: "that phone setting can't be part of a shortcut" } };
      }
      if (RINGER_ACTIONS.has(args.action) && build && build < MIN_BUILD) {
        return { ok: false, error: "step_needs_update", data: { n, said, needsBuild: MIN_BUILD } };
      }
    }
    if (def.minBuild && build && build < def.minBuild) {
      return { ok: false, error: "step_needs_update", data: { n, said, needsBuild: def.minBuild } };
    }
    if (tool === "open_webpage" && !isHttps(args.url)) {
      return { ok: false, error: "step_not_allowed", data: { n, said, why: "only secure web links (https) can be a step" } };
    }
    if (tool === "do_task_in_app" && args.url !== undefined && !isHttps(args.url)) {
      return { ok: false, error: "step_not_allowed", data: { n, said, why: "only secure web links (https) can be a step" } };
    }
    if (SPOKEN.has(tool) && ++spoken > 1) {
      return { ok: false, error: "too_many_spoken", data: { n, said } };
    }
    // An unidentifiable target is never a duplicate (as in the registry).
    const t0 = targetOf(tool, args);
    const target = `${tool}|${t0}`;
    if (t0 && seen.has(target)) return { ok: false, error: "duplicate_step", data: { n, said } };
    seen.add(target);
    let when = null;
    if (tool === "create_reminder" && raw.when && typeof raw.when === "object") {
      const mins = Number(raw.when.in_minutes);
      if (Number.isFinite(mins) && mins > 0 && mins <= 7 * 24 * 60) when = { in_minutes: Math.round(mins) };
      else if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(raw.when.at || ""))) when = { at: String(raw.when.at) };
    }
    const step = { tool, args, said: said || null, when };
    step.class = def.cls;
    step.label = labelFor(step);
    out.push(step);
  }
  const tasks = out.filter((s) => s.class === "app_task");
  if (tasks.length > 1) return { ok: false, error: "mixed_app_task", data: {} };
  if (tasks.length && out.some((s) => s.class === "stays")) return { ok: false, error: "mixed_app_task", data: {} };
  const warnings = [];
  if (out.filter((s) => s.class === "stays").length > 1) {
    warnings.push("The second app opens when you tap the notification, unless 'use other apps' is switched on.");
  }
  const ordered = orderSteps(out);
  return { ok: true, steps: ordered.steps, reordered: ordered.reordered, warnings };
}

/**
 * A stored step with its time template turned into the tool's absolute
 * `due_at`, in the user's own clock. A time already past today is
 * tomorrow's.
 */
function materialise(step, { tzOffsetMin = 330, now = Date.now() } = {}) {
  if (step.tool !== "create_reminder" || !step.when) return { ...step, args: { ...step.args } };
  const tz = Number.isFinite(Number(tzOffsetMin)) ? Number(tzOffsetMin) : 330;
  let at;
  if (step.when.in_minutes) at = now + step.when.in_minutes * 60_000;
  else {
    const [h, m] = String(step.when.at).split(":").map(Number);
    const local = new Date(now + tz * 60_000);
    let t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, m) - tz * 60_000;
    if (t <= now) t += 24 * 3600_000;
    at = t;
  }
  const sign = tz < 0 ? "-" : "+";
  const abs = Math.abs(tz);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const iso = new Date(at + tz * 60_000).toISOString().slice(0, 19) + off;
  return { ...step, args: { ...step.args, due_at: iso } };
}

module.exports = {
  STEP_TOOLS, STEP_TOOL_NAMES, PHONE_ACTIONS, RINGER_ACTIONS, SPOKEN,
  MAX_STEPS, MAX_SHORTCUTS, MAX_NAMES, MAX_STEP_TEXT, MAX_MESSAGE, MIN_BUILD,
  whyNot, classify, labelFor, confirmLine, stepIcon, orderSteps, validate, materialise, cleanArgs,
};
