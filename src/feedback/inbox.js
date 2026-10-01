/**
 * THE DEVELOPER'S INBOX — what users asked the assistant to change.
 *
 * The owner, 2026-10-01: "add a feature where if users need any
 * improvements or changes in the app let them say it to the assistant
 * itself, so that you can check and fix it." The saying part existed
 * (send_developer_feedback → developer_feedback); this is the checking
 * and the closing of the loop: list what is waiting, mark what was
 * handled, and tell the person who asked when their request shipped.
 *
 *   node -e "require('/app/src/feedback/inbox').cli(['list'])"           # new + seen
 *   … cli(['list', '--all'])                                              # everything
 *   … cli(['seen', '12,13'])                                              # looked at
 *   … cli(['done', '12', '--build', '144', '--note', 'Calls now…'])       # shipped → user is told
 *
 * In production it runs inside the backend pod (it needs the database),
 * e.g. `kubectl -n myassistant exec deploy/myassistant-backend -- node -e "…"`.
 * Locally, scripts/feedback_inbox.js is the same thing.
 */
const store = require("./store");

function when(ms) {
  const d = new Date(Number(ms) || 0);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function line(r) {
  const who = r.name || r.email || (r.user_id === 0 ? "server" : `user ${r.user_id}`);
  const head = `#${r.id} [${r.status}${r.resolved_build ? ` in ${r.resolved_build}` : ""}] ${r.kind} · ${who} · build ${r.app_build || "?"} · ${when(r.created_at)}`;
  const body = [r.summary, r.details && `  details: ${r.details}`, r.user_words && `  they said: "${r.user_words}"`]
    .filter(Boolean).join("\n");
  return `${head}\n${body}`;
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Runs one command; returns the text it printed (also printed via `out`). */
async function cli(argv = [], out = console.log) {
  const [cmd = "list", ...rest] = argv;
  if (cmd === "list") {
    const all = rest.includes("--all");
    const rows = all
      ? await store.list({ limit: 200 })
      : [...(await store.list({ status: "new", limit: 200 })), ...(await store.list({ status: "seen", limit: 200 }))];
    const c = await store.counts();
    const text = [
      `feedback: ${c.new} new, ${c.seen} seen, ${c.done} done`,
      ...rows.map(line),
    ].join("\n\n");
    out(text);
    return text;
  }
  if (cmd === "seen") {
    const ids = String(rest[0] || "").split(",").map((s) => Number(s.trim())).filter(Boolean);
    for (const id of ids) await store.setStatus(id, "seen");
    const text = `seen: ${ids.join(", ") || "(none)"}`;
    out(text);
    return text;
  }
  if (cmd === "done") {
    const id = Number(rest[0]);
    const build = Number(arg(rest, "--build")) || 0;
    const note = String(arg(rest, "--note") || "");
    if (!id) throw new Error("done <id> --build <n> [--note …]");
    const row = await store.resolve(id, { build, note });
    if (!row) throw new Error(`no feedback #${id}`);
    const told = await store.notifyResolved(row);
    const text = `done: #${id} "${row.summary}"${build ? ` in build ${build}` : ""} — user ${told ? "told by push" : "not told (no phone, or push failed — see notify)"}`;
    out(text);
    return text;
  }
  if (cmd === "notify") {
    // Tell the person about a request already marked done (once).
    const ids = String(rest[0] || "").split(",").map((s) => Number(s.trim())).filter(Boolean);
    const lines = [];
    for (const id of ids) {
      const row = await store.get(id);
      if (!row || row.status !== "done") { lines.push(`#${id}: not done`); continue; }
      const told = await store.notifyResolved(row);
      lines.push(`#${id}: ${told ? "told" : Number(row.notified_at) > 0 ? "already told" : "not told (no phone, or push failed)"}`);
    }
    const text = lines.join("\n") || "(nothing)";
    out(text);
    return text;
  }
  throw new Error(`unknown command ${cmd} (list | seen <ids> | done <id> --build <n> --note … | notify <ids>)`);
}

module.exports = { cli, line };
