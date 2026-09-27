/**
 * RUNNING A SHORTCUT.
 *
 * ASK ONCE, BEFORE ANYTHING RUNS. Every step that needs a yes (a message
 * sent on the user's behalf, anything after an email or web page was read)
 * is named in ONE question first; nothing runs until the answer. The yes
 * approves exactly those steps of that run — never a step the model names,
 * never another run.
 *
 * EVERY STEP GOES THROUGH registry.execute, with every gate: garbled
 * speech, requirements, taint, unattended, repeats, audit and the ledger.
 * The runner never calls a tool's execute() itself.
 *
 * Phone steps come back as the tool's own device action; they are sent to
 * the phone as ONE `shortcut_run` directive, which the app performs in
 * order (in-app first, the chat message, then the app that stays open,
 * then a phone task last).
 *
 * agents/tasks.js is not reused on purpose: its stepper parks mid-plan,
 * after earlier steps have run, and a step's device action never reaches
 * the phone from it.
 */
const store = require("./store");
const S = require("./steps");

const DAILY_RUNS = 60;

function registry() {
  return require("../tools/registry");
}

function surfaceOf(ctx = {}) {
  return String(ctx.source || (ctx.session && ctx.session.surface) || "").slice(0, 20);
}

/** Does this step need the user's yes on this run? */
function needsYes(step, ctx) {
  const def = S.STEP_TOOLS[step.tool] || {};
  return !!def.confirmEachRun || registry().requiresConfirmation(step.tool, ctx);
}

function summaryFor(run, idx, ctx) {
  const lines = idx.map((i) => S.confirmLine(run.steps[i]));
  const tainted = registry().turnIsUntrusted(ctx);
  const base = `${run.name} will also ${lines.join(", and ")}`.slice(0, 400);
  return tainted
    ? `${base} — this came up after reading an email or web page, or someone else's message, so check it is what you want`
    : base;
}

/** Start a run: the daily limit, a snapshot, then ask or execute. */
async function start(userId, shortcut, ctx = {}) {
  if ((await store.countToday(userId)) >= DAILY_RUNS) {
    return { ok: false, error: "daily_limit", data: { max: DAILY_RUNS } };
  }
  const steps = shortcut.steps.map(({ i, icon, ...s }) => S.materialise(s, { tzOffsetMin: ctx.tzOffsetMin }));
  const run = await store.createRun(userId, shortcut, { surface: surfaceOf(ctx), steps });
  const sensitive = run.steps.map((_, i) => i).filter((i) => needsYes(run.steps[i], ctx));
  if (sensitive.length) {
    const summary = summaryFor(run, sensitive, ctx);
    const parked = await store.saveRun(userId, run.id, {
      status: "waiting", pending: { steps: sensitive, summary },
    });
    return { ok: true, parked: true, run: parked, summary };
  }
  return execute(userId, run, shortcut, ctx, []);
}

function stepCtxFor(run, shortcut, step, i, ctx, approved, resumed) {
  const out = {
    ...ctx,
    userText: step.said || run.name,
    intent: `shortcut “${run.name}” step ${i + 1}: ${step.said || step.label}`,
    // ALWAYS set, never inherited: the /confirm replay carries approved:true
    // in its ctx, and a spread would approve every step.
    approved: approved.has(i),
    shortcutRun: run.id,
    shortcutReplay: undefined,
  };
  // A resumed run was judged on the turn that started it; the "yes" turn
  // (often one weak word) must not refuse the steps it did not approve.
  if (resumed) out.inputQuality = { quality: "clear", reason: "approved shortcut run", heard: "" };
  if (step.tool === "do_task_in_app") {
    out.shortcutReplay = { shortcutId: shortcut ? shortcut.id : run.shortcut_id, hint: shortcut ? shortcut.replay : null };
  }
  return out;
}

function argsFor(step, approved) {
  // The preflight question read this exact message out, and the yes was to it.
  if (step.tool === "send_agent_message" && approved) return { ...step.args, confirmed: true };
  return step.args;
}

/** A spoken phrase for a step that went through, never "sent" for a chat. */
function phrase(step) {
  const a = step.args || {};
  if (step.tool === "send_whatsapp_message") return `your message to ${a.to || "the chat you pick"} is ready to send`;
  if (step.tool === "send_agent_message") return `your message to ${a.contact_name} is on its way`;
  if (step.tool === "start_navigation") return `directions to ${a.destination} are opening`;
  if (step.tool === "do_task_in_app") return "I'm starting the task on your phone";
  return step.label.replace(/\s*\(you tap Send\)$/, "").toLowerCase();
}

function compose(run, spoken) {
  const ok = run.steps.filter((s) => s.status === "dispatched" || s.status === "done");
  const failed = run.steps.filter((s) => s.status === "failed");
  let line = `${run.name}`;
  if (ok.length) line += ` — ${ok.map(phrase).join(", ")}.`;
  else line += ": nothing could be done.";
  if (failed.length) {
    line += ` I couldn't do ${failed.map((s) => `${s.label.toLowerCase()} (${s.detail || "it failed"})`).join(", ")}.`;
  }
  if (spoken.length) line += " " + spoken.join(" ");
  return line.replace(/\s+/g, " ").trim().slice(0, 600);
}

function directiveOf(run, envelopes) {
  const steps = envelopes.map((e, k) => ({
    ...e,
    wait_return: e.class === "hand_back" && k < envelopes.length - 1,
  }));
  return {
    type: "shortcut_run",
    run_id: run.id,
    shortcut_id: run.shortcut_id,
    name: run.name,
    leaves_app: steps.some((s) => s.class !== "in_app"),
    steps,
  };
}

/** Run every step (concurrently; they are independent by construction). */
async function execute(userId, run, shortcut, ctx, approvedSteps, { resumed = false } = {}) {
  const approved = new Set(approvedSteps || []);
  const reg = registry();
  // THE READ-BACK ALREADY HAPPENED. The one question named this message's
  // exact words and the user said yes to it; the message tool's own
  // read-back gate (agents/readBack.js) is told exactly that, so it does
  // not ask a second time.
  const readBack = require("../agents/readBack");
  const ctxs = run.steps.map((st, i) => {
    const c = stepCtxFor(run, shortcut, st, i, ctx, approved, resumed);
    if (st.tool === "send_agent_message" && approved.has(i)) {
      readBack.mayGo({ userId: ctx.userId, kind: "message", parts: [st.args.contact_name, st.args.message], confirmed: false, userText: st.said || "" });
      c.userText = "yes";
    }
    return c;
  });
  const results = await Promise.all(run.steps.map((st, i) =>
    reg.execute(st.tool, argsFor(st, approved.has(i)), ctxs[i])
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))));
  const envelopes = [];
  const spoken = [];
  const steps = run.steps.map((st, i) => {
    const res = results[i] || {};
    const mark = (status, detail = "") => ({ ...st, status, detail: String(detail || "").slice(0, 120) });
    if (res.needsConfirmation) return mark("failed", "needed your OK");
    if (res.repeated) return mark("skipped", "already done moments ago");
    if (!res.ok) {
      return mark("failed", res.error || (res.needsArgs ? `missing ${res.needsArgs.join(", ")}` : "") ||
        (res.needs_confirmation ? "needed your OK" : "it failed"));
    }
    if (res.deviceAction) {
      envelopes.push({ i, class: st.class, label: st.label, action: res.deviceAction });
      return mark("dispatched");
    }
    if ((S.STEP_TOOLS[st.tool] || {}).speaks && res.speak) spoken.push(String(res.speak).slice(0, 300));
    return mark("done");
  });
  const doneOrSent = steps.filter((s) => s.status === "done" || s.status === "dispatched").length;
  const status = envelopes.length ? "dispatched"
    : doneOrSent === steps.length ? "done"
      : doneOrSent ? "partial" : "failed";
  const finished = { ...run, steps };
  const report = compose(finished, spoken);
  const saved = await store.saveRun(userId, run.id, { steps, status, report, pending: null });
  await store.bumpRunCount(userId, run.shortcut_id).catch(() => {});
  const directive = envelopes.length ? directiveOf(run, envelopes) : null;
  return {
    ok: true,
    run: saved || { ...finished, status, report },
    directive,
    speak: report,
    done: steps.filter((s) => s.status === "done").map((s) => s.label),
    on_phone: steps.filter((s) => s.status === "dispatched").map((s) => s.label),
    failed: steps.filter((s) => s.status === "failed").map((s) => s.label),
  };
}

/**
 * The yes. The run must be this user's, waiting, under 10 minutes old and
 * made from the shortcut as it is now (an edit after the question voids
 * the yes, and the run is asked again).
 */
async function resume(userId, runId, ctx = {}, { now = Date.now() } = {}) {
  const run = await store.getRun(userId, runId);
  if (!run) return { ok: false, error: "no_such_run" };
  if (run.status !== "waiting") return { ok: false, error: "not_waiting", data: { status: run.status } };
  if (now - run.created_at > store.RUN_TTL_MS) {
    await store.saveRun(userId, run.id, { status: "expired" }, { onlyIf: ["waiting"] });
    return { ok: false, error: "expired", note: "That was a while ago — ask them to say the shortcut again." };
  }
  const shortcut = await store.get(userId, run.shortcut_id);
  if (!shortcut) {
    await store.saveRun(userId, run.id, { status: "cancelled" }, { onlyIf: ["waiting"] });
    return { ok: false, error: "no_such_shortcut" };
  }
  if (shortcut.version !== run.version) {
    await store.saveRun(userId, run.id, { status: "cancelled", report: "changed before the yes" }, { onlyIf: ["waiting"] });
    return start(userId, shortcut, ctx);
  }
  const claimed = await store.saveRun(userId, run.id, { status: "running" }, { onlyIf: ["waiting"] });
  if (!claimed) return { ok: false, error: "not_waiting" };
  return execute(userId, { ...run, status: "running" }, shortcut, ctx, (run.pending && run.pending.steps) || [], { resumed: true });
}

/** The no: nothing runs. */
async function decline(userId, runId) {
  const r = await store.saveRun(userId, runId, { status: "cancelled", report: "you said no", pending: null }, { onlyIf: ["waiting"] });
  return r ? { ok: true, run: r } : { ok: false, error: "not_waiting" };
}

/** Device caps for a REST run: the app's header build over the stored row. */
async function capsFor(userId, req) {
  let row = null;
  try {
    row = await require("../db").one(
      "SELECT platform, build, granted, denied FROM user_devices WHERE user_id = $1", [userId]);
  } catch (_) {}
  const header = Number(req && req.get && req.get("X-App-Build")) || 0;
  const split = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
  return {
    platform: (row && row.platform) || "android",
    build: header || Number(row && row.build) || 0,
    granted: split(row && row.granted),
    denied: split(row && row.denied),
  };
}

module.exports = { start, execute, resume, decline, directiveOf, compose, capsFor, needsYes, DAILY_RUNS };
