/**
 * LAST RESULTS — what the tools returned in the last two turns of this
 * session, for the next turn's prompt (POST /ai/context).
 *
 * Voice audit, 2026-09-30: tool results carried forward only WITHIN a turn.
 * The next turn saw the words of earlier replies and the names of what
 * ran ("ALREADY DONE"), never the results — so "the second one", "read it
 * again", "move it to 5" and "call him" had nothing to point at. This is a
 * digest of those results (about 400 characters a tool: its name, the key
 * arguments, and the ids, names, dates and numbers it returned), read from
 * the durable ledger (actions/store.js, executed_actions) where every tool
 * call through the registry is already written, plus what the phone
 * reported back in its own [SYSTEM] lines (a call log, say).
 *
 * AI_LAST_RESULTS=off leaves the block out.
 */
const { RELAYED_MESSAGE_NOTE } = require("./voicePrompt");

const TURNS = 2;
const PER_TOOL = 400;
const MAX_ROWS = 24;
// Not results anyone points back at.
const SKIP = new Set(["clarify", "set_language", "stay_silent", "end_conversation"]);
// The fields worth keeping from an item, most telling first.
const KEYS = [
  "id", "name", "title", "text", "fact", "subject", "message", "summary", "note", "from", "to",
  "person", "contact", "contact_name",
  "phone", "number", "when", "date", "time", "start", "due", "amount", "total", "status",
  "address", "place", "city", "rating", "price", "kind",
];

const on = () => !/^(off|0|false|no)$/i.test(String(process.env.AI_LAST_RESULTS || "on").trim());
const oneLine = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const clip = (s, n) => {
  const t = oneLine(s);
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** JSON the ledger cut at 600 characters, closed again where it can be. */
function parseLoose(text) {
  const s = String(text || "").trim();
  if (!/^[[{]/.test(s)) return undefined;
  try { return JSON.parse(s); } catch (_) {}
  const cut = s.lastIndexOf("}");
  if (cut <= 0) return undefined;
  for (const close of ["]", "]}", "}", "}]", "]}]", "}]}"]) {
    try { return JSON.parse(s.slice(0, cut + 1) + close); } catch (_) {}
  }
  return undefined;
}

function scalar(v) {
  if (v == null || v === "") return "";
  if (typeof v === "object") return "";
  return clip(v, 60);
}

/** One item: its telling fields, "id 12: Call the bank, tomorrow 5 pm". */
function itemText(x) {
  if (x == null || typeof x !== "object") return clip(x, 80);
  const parts = [];
  let id = "";
  for (const k of KEYS) {
    const v = scalar(x[k]);
    if (!v) continue;
    if (k === "id") id = v;
    else parts.push(v);
    if (parts.length >= 4) break;
  }
  if (!parts.length) {
    for (const [k, v] of Object.entries(x)) {
      const t = k === "id" ? "" : scalar(v);
      if (t) parts.push(`${k} ${t}`);
      if (parts.length >= 3) break;
    }
  }
  return (id ? `id ${id}: ` : "") + parts.join(", ");
}

function listText(arr) {
  if (!arr.length) return "nothing found";
  const shown = arr.slice(0, 8).map((x, i) => `${i + 1}. ${itemText(x)}`).join("; ");
  return arr.length > 8 ? `${shown} (+${arr.length - 8} more)` : shown;
}

/** What the tool returned, as the few things a reference can point at. */
function resultText(result) {
  const v = parseLoose(result);
  if (v === undefined) return clip(result, PER_TOOL);
  if (Array.isArray(v)) return listText(v);
  if (v && typeof v === "object") {
    const key = Object.keys(v).find((k) => Array.isArray(v[k]) && v[k].some((x) => x && typeof x === "object"));
    if (key) {
      const head = itemText(Object.fromEntries(Object.entries(v).filter(([k]) => k !== key)));
      return `${head ? head + "; " : ""}${key}: ${listText(v[key])}`;
    }
    return itemText(v);
  }
  return clip(v, PER_TOOL);
}

/** The arguments the model chose, short: "day=tomorrow, contact_name=Ravi". */
function argsText(args) {
  const v = parseLoose(args);
  if (!v || typeof v !== "object" || Array.isArray(v)) return "";
  return Object.entries(v)
    .map(([k, x]) => [k, scalar(x)])
    .filter(([, x]) => x)
    .slice(0, 5)
    .map(([k, x]) => `${k}=${clip(x, 40)}`)
    .join(", ");
}

// Someone else's words (an email, a web page, an MCP server) never reach
// the system instruction: the model is pointed back at the tool instead.
function external(tool) {
  try {
    const registry = require("../tools/registry");
    const t = registry.get(tool);
    return registry.UNTRUSTED_SOURCES.has(tool) || Boolean(t && t.source === "mcp");
  } catch (_) {
    return false;
  }
}

/** One ledger row as one digest line (≤ ~400 characters). */
function digestRow(r) {
  const args = argsText(r.args);
  const ok = Number(r.ok) !== 0;
  const out = !ok ? `FAILED${r.detail ? `: ${clip(r.detail, 120)}` : ""}`
    : external(r.tool) ? "external content (not repeated here; call the tool again to read it)"
      : resultText(r.result) || "done";
  return clip(`${r.tool}(${args}) → ${out}`, PER_TOOL);
}

/** Ledger rows for the last TURNS turns of this session before `turnId`, oldest first. */
async function rowsFor(uid, sessionId, turnId) {
  const rows = await require("../db").query(
    `SELECT turn_id, tool, args, result, ok, detail FROM executed_actions
      WHERE user_id = $1 AND session_id = $2 AND turn_id <> '' AND turn_id <> $3
      ORDER BY id DESC LIMIT ${MAX_ROWS}`,
    [Number(uid), String(sessionId || ""), String(turnId || "")]
  );
  const turns = [];
  const out = [];
  for (const r of rows) {
    if (SKIP.has(r.tool)) continue;
    if (!turns.includes(r.turn_id)) {
      if (turns.length >= TURNS) break;
      turns.push(r.turn_id);
    }
    out.push(r);
  }
  return out.reverse();
}

/** The phone's own reports ([SYSTEM] lines) from the last turns, never someone else's words. */
function phoneReports(s, turnId) {
  const recent = [...((s && s.turns && s.turns.values()) || [])].filter((t) => t.id !== turnId).slice(-TURNS);
  return recent
    .filter((t) => !t.owner && !t.untrusted && /^\s*\[SYSTEM\]/.test(t.text || "") &&
      !RELAYED_MESSAGE_NOTE.test(t.text || ""))
    .map((t) => `- the phone reported: ${clip(String(t.text).replace(/^\s*\[SYSTEM\]\s*/, ""), PER_TOOL)}`);
}

/**
 * The LAST RESULTS block for this session's next turn, or "" when nothing
 * ran lately (or the ledger cannot be read — a turn never waits on this).
 */
async function block(uid, s, turnId) {
  if (!on() || !s) return "";
  let lines = [];
  try {
    lines = (await rowsFor(uid, s.id, turnId)).map((r) => "- " + digestRow(r));
  } catch (e) {
    console.warn("ai: last results unavailable:", String((e && e.message) || e).slice(0, 120));
  }
  lines.push(...phoneReports(s, turnId));
  if (!lines.length) return "";
  return (
    "LAST RESULTS (what your tools returned in the last two turns — the record, not your " +
    "memory; oldest first, numbered in the order each list was given. Use it for 'the second " +
    "one', 'read it again', 'move it to 5', 'call him'. Ids are for tool arguments, never say " +
    "them aloud):\n" + lines.join("\n")
  );
}

module.exports = { block, digestRow, resultText, argsText, parseLoose, phoneReports, PER_TOOL, TURNS };
