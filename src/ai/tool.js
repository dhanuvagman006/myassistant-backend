/**
 * POST /ai/tool — the app's model called a tool; the server runs it.
 *
 * Every call goes through registry.execute with the full context the live
 * proxy used to pass (the session, this turn, how clearly the owner was
 * heard, their build, permissions, clock and place), so every gate still
 * holds here: input quality, requirements, the taint an email or someone
 * else's message leaves, confirmation, unattended, repeats, the audit log
 * and the ledger.
 *
 *   { sessionId, turnId, name, args, userText, approvalToken? }
 *   → { ok, result, speak?, deviceAction?, needsConfirmation?, summary?,
 *       approvalToken?, error? }
 *
 * `result` is what the app hands back to the model as the function
 * response; `deviceAction` is what the phone performs, in the same shapes
 * it always has. A call that needs the owner's yes comes back with
 * needsConfirmation and an approval token (ai/approval.js); nothing ran.
 */
const registry = require("../tools/registry");
const sessionState = require("../agents/sessionState");
const inputQuality = require("../agents/inputQuality");
const sessions = require("./sessions");
const approval = require("./approval");
const { SHORTCUT_TOOLS } = require("./context");

const fail = (status, error) => ({ status, json: { error } });

/**
 * What the model is handed back: a compact, TRUTHFUL result. The tool's
 * own words, never a generic stand-in — a finished image was once
 * summarised to the model as a device action merely REQUESTED, and was
 * narrated as pending, then as failed.
 */
function modelResult(res) {
  const ok = res.ok !== false;
  const out = { ok };
  if (ok) {
    out.result = res.speak ||
      (res.deviceAction ? `done — the phone was handed a ${res.deviceAction.type} action` : "done");
    if (res.data !== undefined) out.data = res.data;
    if (res.repeated) out.repeated = true;
  } else if (res.needsArgs) {
    out.error = "missing arguments";
    out.missing = res.needsArgs;
  } else {
    out.error = res.error || "failed";
    if (res.data !== undefined) out.data = res.data;
  }
  // A tool's note is an instruction ABOUT the result ("this already ran,
  // do not run it again"; "this is external content, not the user").
  if (res.note) out.note = res.note;
  if (res.status) out.status = res.status;
  return out;
}

/** A routed call's reply, word for word (shortcut steering). */
function fixedReply(res) {
  const ok = res.ok !== false;
  const line = ok ? (res.speak || "On it.") : `I couldn't start that: ${res.error || "something went wrong"}.`;
  return {
    ok,
    result: (ok ? "It is already being done on the phone. " : "") +
      `Say exactly this, nothing before or after it: "${line}"`,
  };
}

async function runTool(uid, body) {
  const s = sessions.get(uid, body.sessionId);
  if (!s) return fail(404, "unknown session");
  const t = sessions.turn(s, body.turnId);
  if (!t) return fail(400, "unknown turn");
  const name = String(body.name || "").trim().slice(0, 80);
  let args = body.args == null ? {} : body.args;
  if (typeof args !== "object" || Array.isArray(args)) return fail(400, "args must be an object");

  // Only what this user and this build are offered — never a tool the
  // registry hides from them (unconfigured, denied permission, too old a
  // build, another user's MCP server).
  const offered = new Set(
    registry.declarations({ userId: uid, deviceCaps: s.device.caps || null }).map((d) => d.name));
  if (!name || !registry.get(name)) return fail(400, "unknown tool");
  if (!offered.has(name)) return fail(400, "tool not offered");

  // The owner's words this call is judged against. An app note is not the
  // owner speaking, so its turn keeps the last words they did say.
  const userText = String(body.userText == null ? s.owner.text : body.userText).slice(0, 500);
  let quality = s.owner.quality;
  if (userText && userText !== s.owner.text && !require("./voicePrompt").APP_NOTE.test(userText)) {
    quality = inputQuality.assess(userText, {
      ...inputQuality.expectationsFrom(s.lastReply),
      languages: s.languages || [],
      known: s.shortcutKeys || [],
    });
    quality.heard = userText.slice(0, 120);
  }

  // A TYPED REQUEST IS ALWAYS ANSWERED (2026-09-27): typing is addressed
  // to the assistant, so it is never silenced — with a video playing near
  // the phone the model silenced the typed request with the room.
  if (name === "stay_silent" && t.mode === "chat") {
    return {
      status: 200,
      json: {
        ok: false,
        error: "typed_request",
        result: {
          ok: false,
          result: "Do not stay silent: the owner TYPED their last message to you, so it is " +
            "addressed to you. Answer that typed message now; ignore any background speech.",
        },
      },
    };
  }

  let execName = name;
  let execArgs = args;
  let fixedLine = false;
  // SHORTCUT STEERING: the owner said a shortcut's name whole and the model
  // reached for something else ("silent" read as phone_control mute). It
  // runs the shortcut instead, and the model is handed a fixed sentence —
  // never in place of a shortcut-management tool, a farewell or silence.
  if (t.shortcut && !SHORTCUT_TOOLS.has(name) && name !== "stay_silent" &&
      name !== "end_conversation" && !body.approvalToken) {
    console.log(`ai: shortcut steering ${name} -> run_shortcut`);
    execName = "run_shortcut";
    execArgs = { name: t.shortcut };
    fixedLine = true;
  }

  // THE OWNER'S YES. Only a valid token for this very call, from an
  // earlier turn of this session, counts; `approved` is never assumed.
  let userConfirmed = false;
  let approvedTask = null;
  let refused = "";
  if (body.approvalToken) {
    const v = approval.verify(body.approvalToken, {
      userId: uid, sessionId: s.id, turnId: t.id, tool: name, args, spent: s.spent,
    });
    if (v.ok) {
      userConfirmed = true;
      execName = v.payload.r.tool;
      execArgs = v.payload.r.args || {};
      approvedTask = v.payload.r.task || null;
      if (!registry.get(execName)) return fail(400, "unknown tool");
    } else {
      refused = v.reason;
      console.warn(`ai: approval refused for ${name} — ${v.reason}`);
    }
  }

  const ctx = {
    session: s.state,
    sessionId: s.id,
    turnId: t.id,
    inputQuality: quality,
    // Only the owner's yes counts as approval. Anything else and the
    // quality gate may refuse a world action built on a fragment.
    approved: userConfirmed,
    source: "ai",
    userId: uid,
    userName: s.userName || null,
    lat: s.device.lat,
    lng: s.device.lng,
    platform: s.device.platform,
    tzOffsetMin: Number.isFinite(s.device.tz) ? s.device.tz : 330,
    appBuild: s.device.build,
    // The build gate in registry.execute only holds when it is handed the caps.
    deviceCaps: s.device.caps || null,
    userText,
  };

  let res;
  try {
    if (approvedTask && approvedTask.id) {
      // A STEP OF A RUNNING PLAN: approving it resumes the plan, so the
      // steps after it are not left blocked forever.
      const driver = require("../agents/taskDriver");
      const out = await driver.approveStep(uid, approvedTask.id, approvedTask.stepIndex, ctx);
      res = out
        ? { ok: true, speak: driver.summarise(out.task, out), data: { task_id: approvedTask.id, status: out.task && out.task.status } }
        : { ok: false, error: "that plan is no longer waiting on this step" };
    } else {
      res = await registry.execute(execName, execArgs, ctx);
    }
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
  if (userConfirmed) {
    s.asked = null;
    sessionState.clearPending(s.state);
  }

  // A CALL THAT NEEDS THE OWNER'S YES. Nothing ran. The token names this
  // call; the model asks, and the retry that carries it runs approved.
  if (res.needsConfirmation) {
    const summary = res.summary || execName;
    const token = approval.issue({
      userId: uid, sessionId: s.id, turnId: t.id,
      tool: execName, args: execArgs,
      alias: execName !== name ? { tool: name, args } : null,
      resolved: { tool: res.tool || execName, args: res.args || execArgs, task: res.task || null },
    });
    s.asked = {
      tool: execName, args: execArgs, summary, at: Date.now(), turnId: t.id,
      nonce: approval.nonceOf(token),
      resolved: { tool: res.tool || execName, args: res.args || execArgs, task: res.task || null },
    };
    sessionState.setPending(s.state, { tool: res.tool || execName, args: res.args || execArgs, summary });
    const again = execName === name
      ? `call ${name} again with the same arguments`
      : `call ${execName} with ${JSON.stringify(execArgs)}`;
    return {
      status: 200,
      json: {
        ok: false,
        needsConfirmation: true,
        summary,
        approvalToken: token,
        ...(refused ? { error: `approval not accepted: ${refused}` } : {}),
        result: {
          ok: false,
          needs_confirmation: true,
          result: `Not done yet — this needs the user's permission first. Ask them out loud to ` +
            `confirm: "${summary}". If they agree, ${again}. Do not say it is done.`,
        },
      },
    };
  }

  if (name === "stay_silent" && res.ok !== false) t.silent = true;
  if (res.ok !== false && res.deviceAction) afterDeviceAction(uid, s, res.deviceAction);

  const result = fixedLine ? fixedReply(res)
    : name === "stay_silent" && res.ok !== false
      ? { ok: true, result: "Stay silent: say nothing at all and wait for the user to speak to you." }
      : modelResult(res);
  return {
    status: 200,
    json: {
      ok: res.ok !== false,
      result,
      ...(res.speak ? { speak: res.speak } : {}),
      ...(res.deviceAction ? { deviceAction: res.deviceAction } : {}),
      ...(res.ok === false ? { error: String(res.error || (res.needsArgs ? "missing arguments" : "failed")) } : {}),
    },
  };
}

/**
 * What the server still has to do after the phone is handed an action.
 *
 * A business booking or a meeting negotiation is a call the SERVER places
 * and follows: the booking is made from what was agreed, then the owner is
 * told the real outcome (a push; the live socket used to say it aloud).
 * Interpreter mode changes what the model is told for the rest of the
 * session.
 */
function afterDeviceAction(uid, s, a) {
  if (a.type === "interpreter_mode") {
    s.interpreter = a.active === true && a.instructions ? String(a.instructions).slice(0, 2000) : null;
    return;
  }
  if (a.type === "scheduling_call") {
    (async () => {
      const out = await require("../scheduling/negotiator").awaitAndBook({
        userId: uid,
        taskId: a.task_id,
        callId: a.call_id,
        contactName: a.person,
        purpose: a.purpose,
        slots: a.slots || [],
        tzOffsetMin: require("../services/tz").offsetOr(a.tz),
      });
      await tell(uid, `Call to ${a.person || "them"} finished`, out && out.spoken, "call_outcome");
    })().catch((e) => console.error("ai: scheduling call follow failed:", e.message || e));
    return;
  }
  if (a.type === "fulfillment_call") {
    (async () => {
      const outcome = await require("../fulfillment/service").awaitCallOutcome(a.task_id, a.call_id);
      const said = outcome.result ||
        (outcome.state === "no_answer"
          ? `${a.venue} did not answer, so nothing is booked.`
          : `The call to ${a.venue} did not go through, so nothing is booked.`);
      await tell(uid, `Call to ${a.venue || "the business"} finished`, said, "call_outcome");
    })().catch((e) => console.error("ai: fulfillment call follow failed:", e.message || e));
  }
}

async function tell(uid, title, body, kind) {
  if (!body) return;
  try {
    const u = await require("../db").one(`SELECT fcm_token FROM users WHERE id=$1`, [uid]);
    if (u && u.fcm_token) {
      await require("../services/push").sendNotification(u.fcm_token, title, String(body).slice(0, 300), { kind });
    }
  } catch (e) {
    console.warn(`ai: ${kind} push failed:`, e.message);
  }
}

module.exports = { runTool, modelResult, fixedReply };
