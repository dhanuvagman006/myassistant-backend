/**
 * SHORTCUTS BY VOICE — "create a shortcut called office mode that puts my
 * phone on silent, gives me directions to office and WhatsApps my wife I'm
 * leaving", then just "office mode".
 *
 *   create_shortcut        save a new one from plain steps (nothing runs)
 *   run_shortcut           run one by name; asks once first if a step needs a yes
 *   continue_shortcut      ONLY after that question was answered yes
 *   list_shortcuts         what they have
 *   update_shortcut        rename, other names, add / remove / replace steps
 *   delete_shortcut        always asks first
 *
 * App build 120 ships the phone half (SHORTCUT_MIN_BUILD); older builds
 * are offered none of this. Kill switch: SHORTCUTS=off.
 *
 * These are the first tools in the codebase to declare `effects`, so
 * registry.seal() logs one informational "declare membership a seed list
 * does not list" line for them at boot. That is expected.
 */
const store = require("./store");
const match = require("./match");
const S = require("./steps");

const SHORTCUT_MIN_BUILD = 120;
const available = () => process.env.SHORTCUTS !== "off";

function tooOld(ctx) {
  const b = Number(ctx && ctx.appBuild) || 0;
  return b > 0 && b < SHORTCUT_MIN_BUILD;
}
const TOO_OLD = {
  ok: false,
  error: "app_too_old",
  data: { needsBuild: SHORTCUT_MIN_BUILD },
  note: "This phone's app is too old for shortcuts. Say an app update is needed, in one line.",
};

const NOTES = {
  name_taken: "Ask whether to replace its steps (update_shortcut) or pick another name.",
  reserved_name: "That name is one of the assistant's own words. Ask for another name.",
  bad_name: "A shortcut name is 2 to 40 letters, up to six words. Ask for another.",
  too_many_shortcuts: "They have 50 shortcuts. Ask which one to delete first.",
  too_many_names: "A shortcut can have its name and up to 3 other names.",
  too_many_steps: "A shortcut can have up to 10 steps. Ask which to leave out.",
  step_not_allowed: "Say which step can't be in a shortcut and why, in one line. Nothing was saved.",
  needs_detail: "Nothing was saved. Ask the question in data.question, then call again with that step written out in full.",
  compile_failed: "Nothing was saved. Ask them to say that step more simply.",
  compile_limit: "That's the limit for making shortcuts today. Say so in one line.",
  too_many_spoken: "Only one of weather, headlines, today's brief or today's list fits in a shortcut. Ask which to keep.",
  duplicate_step: "Two steps do the same thing. Ask which to keep.",
  step_needs_update: "That step needs the latest app update.",
  step_too_long: "One step is too long. Ask them to shorten it.",
  no_steps: "Ask what the shortcut should do.",
  no_such_shortcut: "Say you don't have a shortcut by that name and read out the names they do have.",
  which_one: "Ask which of the candidates they mean.",
  stale: "It changed a moment ago. Say it again.",
  not_found: "That shortcut no longer exists.",
};

function fail(code, data = {}, note = "") {
  return { ok: false, error: code, data, note: note || NOTES[code] || "Nothing was changed." };
}

function fromError(e) {
  if (e instanceof store.ShortcutError) return fail(e.code, e.data);
  console.error("shortcuts tool:", e && (e.stack || e.message));
  return { ok: false, error: "Shortcuts hit a snag — try again in a moment." };
}

async function assistantName(userId) {
  try {
    const p = await require("../users/context").getProfile(userId);
    return (p && p.assistant && p.assistant.name) || "";
  } catch (_) {
    return "";
  }
}

async function checkNames(userId, names) {
  const aName = await assistantName(userId);
  for (const n of names) {
    const c = match.checkName(n, { assistantName: aName });
    if (!c.ok) return c;
  }
  return { ok: true };
}

const otherNamesOf = (v) => (Array.isArray(v) ? v : v ? [v] : [])
  .map((x) => String(x || "").trim()).filter(Boolean).slice(0, S.MAX_NAMES - 1);

/** "phone on silent, a chat message to Priya … — then directions to office" */
function readBack(shortcut) {
  const labels = shortcut.steps.map((s) => (s.tool === "send_whatsapp_message"
    ? `a chat message to ${s.args.to} saying “${s.args.message}” (you tap Send)`
    : s.label.charAt(0).toLowerCase() + s.label.slice(1)));
  const joined = labels.length > 1 ? `${labels.slice(0, -1).join(", ")}, then ${labels[labels.length - 1]}` : labels[0];
  const asks = shortcut.steps.some((s) => (S.STEP_TOOLS[s.tool] || {}).confirmEachRun)
    ? " I'll ask before sending anything each time." : "";
  return `Saved “${shortcut.name}”: ${joined}.${asks} Say “${shortcut.name.toLowerCase()}” any time.`
    .replace(/\s+/g, " ");
}

function savedResult(shortcut, { reordered = false, warnings = [] } = {}) {
  return {
    ok: true,
    data: {
      shortcut_id: shortcut.id,
      name: shortcut.name,
      other_names: shortcut.other_names,
      steps: shortcut.steps.map((s, k) => ({ n: k + 1, label: s.label })),
      reordered,
      warnings,
    },
    speak: readBack(shortcut),
    note:
      "It is SAVED, not run: nothing happened on the phone. Read it back in one or two short sentences " +
      `in the user's language. From now on, when they say “${shortcut.name.toLowerCase()}”, call run_shortcut.`,
  };
}

const stripStep = ({ i, icon, status, detail, ...s }) => s;

function stepsSummary(list) {
  return (Array.isArray(list) ? list : [list]).map((x) => String(x || "").trim()).filter(Boolean).join("; ");
}

async function resolveShortcut(userId, name) {
  const r = await match.resolve(userId, name);
  if (!r.ok) return { res: fail(r.error, r.data) };
  const sc = await store.get(userId, r.id);
  if (!sc) return { res: fail("no_such_shortcut", { heard: name }) };
  return { sc };
}

/** Run one: the dispatched answer, or ONE question before anything runs. */
async function runResult(out, sc) {
  if (!out.ok) return fail(out.error, out.data || {}, out.note);
  if (out.parked) {
    return {
      ok: false,
      needsConfirmation: true,
      tool: "continue_shortcut",
      args: { run_id: out.run.id },
      summary: out.summary,
      data: { run_id: out.run.id, name: out.run.name },
    };
  }
  const status = out.run.status;
  if (status === "failed") {
    return { ok: false, error: out.speak, data: { run_id: out.run.id, failed: out.failed } };
  }
  return {
    ok: true,
    data: {
      run_id: out.run.id, name: out.run.name, status,
      done: out.done, on_phone: out.on_phone, failed: out.failed,
    },
    ...(out.directive ? { deviceAction: out.directive } : {}),
    speak: out.speak,
    note: "Say only this, in one short sentence, in the user's language. Never say a chat message was sent — they tap Send.",
  };
}

function registerShortcutTools(registry) {
  const base = {
    minAppBuild: SHORTCUT_MIN_BUILD,
    available,
  };

  registry.register({
    ...base,
    name: "create_shortcut",
    risk: "medium",
    effects: ["write:record"],
    unattended: false,
    timeoutMs: 20_000,
    description:
      "Save a NEW one-command shortcut the user names, e.g. \"create a shortcut called office mode that " +
      "puts my phone on silent, gives directions to office and WhatsApps my wife I'm leaving\". Pass the " +
      "name exactly as they said it, other_names with the same name in English letters and in their own " +
      "script, and each step as a short plain instruction in their words. Do NOT run anything now; this " +
      "only saves it. Money, payments, calls to businesses, deleting and changing settings about them are " +
      "never shortcut steps; say so if asked. If a step needs a detail you don't have (who, where), ask " +
      "first. To change an existing shortcut use update_shortcut.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The shortcut's name exactly as the user said it." },
        other_names: { type: "array", items: { type: "string" }, description: "Up to 3 other ways to say it (other script, English letters)." },
        steps: { type: "array", items: { type: "string" }, description: "Each step as a short plain instruction in the user's words. At most 10." },
      },
      required: ["name", "steps"],
    },
    confirmSummary: (args = {}) =>
      `Save a shortcut "${args.name || ""}": ${stepsSummary(args.steps)}`.slice(0, 300),
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      if (tooOld(ctx)) return TOO_OLD;
      try {
        const others = otherNamesOf(args.other_names);
        const names = await checkNames(ctx.userId, [args.name, ...others]);
        if (!names.ok) return fail(names.error, names.data);
        const taken = await store.byNameKey(ctx.userId, match.nameKey(args.name));
        if (taken) return fail("name_taken", { name: args.name });
        const c = await require("./compile").compile(ctx.userId, args.steps, ctx);
        if (!c.ok) return fail(c.error, c.data);
        const sc = await store.create(ctx.userId, {
          name: args.name, otherNames: others, steps: c.steps, source: ctx.source === "screen" ? "screen" : "voice",
        });
        return savedResult(sc, c);
      } catch (e) {
        return fromError(e);
      }
    },
  });

  registry.register({
    ...base,
    name: "run_shortcut",
    risk: "low",
    deviceAction: true,
    effects: ["device"],
    timeoutMs: 25_000,
    description:
      "Run one of the user's saved shortcuts. Call it AT ONCE whenever the user says a shortcut's name " +
      "listed under THE USER'S SHORTCUTS — alone, or with start / run / turn on / activate / chalu karo / " +
      "ഓൺ ആക്കൂ, in any language. Never ask what it means. Say only the sentence you get back.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The shortcut's name as the user said it." } },
      required: ["name"],
    },
    confirmSummary: (args = {}) => `Run your shortcut “${args.name || ""}”`,
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      if (tooOld(ctx)) return TOO_OLD;
      try {
        const { sc, res } = await resolveShortcut(ctx.userId, args.name);
        if (res) return res;
        return runResult(await require("./runner").start(ctx.userId, sc, ctx), sc);
      } catch (e) {
        return fromError(e);
      }
    },
  });

  registry.register({
    ...base,
    name: "continue_shortcut",
    risk: "high",
    deviceAction: true,
    effects: ["device"],
    dedupe: "never",
    timeoutMs: 25_000,
    description:
      "ONLY after run_shortcut asked the user a yes/no question and they said YES. Pass the run_id it gave " +
      "you. Never call it for any other reason.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "integer", description: "The run_id run_shortcut gave you." } },
      required: ["run_id"],
    },
    // Reads no data: the live proxy calls this with only the user id.
    confirmSummary: () => "Go ahead with the shortcut steps I just asked about",
    // The specific question, for THIS user's run only; another user's run
    // id is simply unknown, and no summary text leaves this function.
    async prepare(args, ctx) {
      const run = ctx.userId ? await store.getRun(Number(ctx.userId), args.run_id).catch(() => null) : null;
      if (!run || run.status !== "waiting" || !run.pending) return { error: "no such shortcut run" };
      return { summary: run.pending.summary };
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      try {
        const out = await require("./runner").resume(Number(ctx.userId), args.run_id, ctx);
        if (!out.ok && out.error === "expired") {
          return { ok: false, error: "expired", note: "That was a while ago — ask them to say the shortcut again. Nothing ran." };
        }
        if (!out.ok && (out.error === "no_such_run" || out.error === "not_waiting")) {
          return { ok: false, error: "no such shortcut run", note: "Nothing ran." };
        }
        return runResult(out);
      } catch (e) {
        return fromError(e);
      }
    },
  });

  registry.register({
    ...base,
    name: "list_shortcuts",
    risk: "low",
    effects: ["read"],
    description: "List the user's saved shortcuts: \"what shortcuts do I have?\".",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      if (tooOld(ctx)) return TOO_OLD;
      const list = await store.list(ctx.userId);
      const names = list.map((s) => s.name.toLowerCase());
      return {
        ok: true,
        data: {
          shortcuts: list.map((s) => ({
            name: s.name, other_names: s.other_names, steps: s.steps.map((st) => st.label),
            runs: s.run_count,
          })),
        },
        speak: !list.length
          ? "You don't have any shortcuts yet."
          : `You have ${list.length} shortcut${list.length === 1 ? "" : "s"}: ${
            names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]}.`,
      };
    },
  });

  registry.register({
    ...base,
    name: "update_shortcut",
    risk: "medium",
    effects: ["write:record"],
    unattended: false,
    timeoutMs: 20_000,
    description:
      "Change a saved shortcut: rename it (\"rename office mode to work mode\"), set its other names, add " +
      "steps (\"add torch on to pooja mode\"), remove steps (by number or by words) or replace all its steps. " +
      "Fields you leave out stay as they are.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The shortcut to change, as the user said it." },
        new_name: { type: "string", description: "Only for a rename." },
        other_names: { type: "array", items: { type: "string" }, description: "Replaces its other names." },
        add_steps: { type: "array", items: { type: "string" }, description: "New steps in plain words." },
        remove_steps: { type: "array", items: { type: "string" }, description: "Step numbers, or words from the steps to remove." },
        replace_steps: { type: "array", items: { type: "string" }, description: "The whole new list of steps." },
      },
      required: ["name"],
    },
    confirmSummary: (args = {}) => {
      const parts = [];
      if (args.new_name) parts.push(`rename it to "${args.new_name}"`);
      if (args.add_steps) parts.push(`add: ${stepsSummary(args.add_steps)}`);
      if (args.replace_steps) parts.push(`new steps: ${stepsSummary(args.replace_steps)}`);
      if (args.remove_steps) parts.push(`remove: ${stepsSummary(args.remove_steps)}`);
      return `Change your shortcut "${args.name || ""}": ${parts.join("; ") || "no change"}`.slice(0, 300);
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      if (tooOld(ctx)) return TOO_OLD;
      try {
        const { sc, res } = await resolveShortcut(ctx.userId, args.name);
        if (res) return res;
        return await applyUpdate(ctx, sc, {
          newName: args.new_name, otherNames: args.other_names === undefined ? undefined : otherNamesOf(args.other_names),
          add: args.add_steps, remove: args.remove_steps, replace: args.replace_steps,
        });
      } catch (e) {
        return fromError(e);
      }
    },
  });

  registry.register({
    ...base,
    name: "delete_shortcut",
    risk: "high",
    effects: ["write:record"],
    unattended: false,
    description: "Delete one of the user's saved shortcuts. Always asks them first.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The shortcut to delete, as the user said it." } },
      required: ["name"],
    },
    confirmSummary: (args = {}) => `Delete your shortcut “${args.name || ""}”`,
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      try {
        const { sc, res } = await resolveShortcut(ctx.userId, args.name);
        if (res) return res;
        await store.remove(ctx.userId, sc.id);
        return { ok: true, data: { deleted: sc.name }, speak: `Deleted your shortcut “${sc.name}”.` };
      } catch (e) {
        return fromError(e);
      }
    },
  });
}

/** Shared by update_shortcut and PATCH /shortcuts/:id. */
async function applyUpdate(ctx, sc, { newName, otherNames, add, remove, replace, keep, said, version } = {}) {
  const uid = Number(ctx.userId);
  if (newName !== undefined || otherNames !== undefined) {
    const names = await checkNames(uid, [newName ?? sc.name, ...(otherNames ?? [])]);
    if (!names.ok) return fail(names.error, names.data);
    if (newName && match.nameKey(newName) !== match.nameKey(sc.name)) {
      const taken = await store.byNameKey(uid, match.nameKey(newName));
      if (taken && taken.id !== sc.id) return fail("name_taken", { name: newName });
    }
  }
  let steps;
  let reordered = false;
  let warnings = [];
  const compile = require("./compile");
  const current = sc.steps.map(stripStep);
  const wantsSteps = replace !== undefined || add !== undefined || remove !== undefined || keep !== undefined || said !== undefined;
  if (wantsSteps) {
    let base = current;
    if (replace !== undefined) {
      const c = await compile.compile(uid, replace, ctx);
      if (!c.ok) return fail(c.error, c.data);
      base = c.steps;
    }
    if (keep !== undefined) base = keep.map((i) => current[Number(i)]).filter(Boolean);
    if (remove !== undefined) {
      const rm = (Array.isArray(remove) ? remove : [remove]).map((x) => String(x || "").trim().toLowerCase()).filter(Boolean);
      base = base.filter((s, k) => !rm.some((r) => (/^\d+$/.test(r) ? Number(r) === k + 1
        : String(s.said || "").toLowerCase().includes(r) || s.label.toLowerCase().includes(r))));
    }
    const newTexts = [...(add ? (Array.isArray(add) ? add : [add]) : []), ...(said || [])];
    if (newTexts.length) {
      const c = await compile.compile(uid, newTexts, ctx);
      if (!c.ok) return fail(c.error, c.data);
      base = [...base, ...c.steps];
    }
    const v = S.validate(base, { build: Number(ctx.appBuild) || 0 });
    if (!v.ok) return fail(v.error, v.data);
    steps = v.steps;
    reordered = v.reordered;
    warnings = v.warnings;
  }
  const updated = await store.update(uid, sc.id, { name: newName, otherNames, steps }, { version });
  return savedResult(updated, { reordered, warnings });
}

module.exports = { registerShortcutTools, SHORTCUT_MIN_BUILD, applyUpdate, readBack, fail, NOTES, runResult };
