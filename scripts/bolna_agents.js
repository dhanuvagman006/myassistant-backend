#!/usr/bin/env node
/**
 * PUSH THE CALLING AGENTS TO BOLNA — `node scripts/bolna_agents.js`.
 *
 * src/agents/callAgentConfig.js is the single definition; this script
 * makes the account match it: one agent per voice gender, found by name,
 * created when missing and replaced (PUT) when present. It prints the
 * ids the server needs:
 *
 *   BOLNA_API_KEY=bn-… PUBLIC_BASE_URL=https://api.hariassistant.tech node scripts/bolna_agents.js --dry
 *   BOLNA_API_KEY=bn-… PUBLIC_BASE_URL=… node scripts/bolna_agents.js --apply
 *
 * --dry prints the payloads and what would happen; --apply writes.
 * Replaces scripts/create_bolna_agent.js and update_bolna_agent.js
 * (2026-10-01): with the file as the only source of truth there is no
 * dashboard drift to protect — the dashboard is for looking.
 */
const crypto = require("crypto");
const cfg = require("../src/agents/callAgentConfig");

const KEY = process.env.BOLNA_API_KEY || "";
const BASE = (process.env.PUBLIC_BASE_URL || "https://api.hariassistant.tech").replace(/\/$/, "");
const APPLY = process.argv.includes("--apply");
const DRY = process.argv.includes("--dry") || !APPLY;
const GENDERS = ["woman", "man"];

if (!KEY) {
  console.error("Set BOLNA_API_KEY (Bolna dashboard → Developers).");
  process.exit(1);
}

const secret = crypto.createHash("sha256").update(KEY).digest("hex").slice(0, 32);
const webhookUrl = `${BASE}/agent-call/bolna/webhook/${secret}`;
const toolBase = `${BASE}/agent-call/bolna/tool/${secret}`;
const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function api(method, path, body) {
  const r = await fetch(`https://api.bolna.ai${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { ok: r.ok, status: r.status, text, json };
}

(async () => {
  const list = await api("GET", "/v2/agent/all?page_number=1&page_size=100");
  if (!list.ok) {
    console.error(`Could not list agents (${list.status}): ${list.text.slice(0, 300)}`);
    process.exit(1);
  }
  const existing = Array.isArray(list.json) ? list.json : (list.json?.data || []);
  const out = {};
  for (const gender of GENDERS) {
    const name = cfg.agentName(gender);
    const payload = cfg.agentConfig({ webhookUrl, toolBase, gender });
    const found = existing.find((a) => a.agent_name === name);
    const verb = found ? `UPDATE ${found.id}` : "CREATE";
    console.log(`${gender}: ${verb} "${name}"`);
    if (DRY) {
      console.log(JSON.stringify(payload, null, 2).replace(secret, "<secret>"));
      continue;
    }
    const r = found
      ? await api("PUT", `/v2/agent/${found.id}`, payload)
      : await api("POST", "/v2/agent", payload);
    if (!r.ok) {
      console.error(`Bolna refused ${verb} (${r.status}) — fix the named field and re-run:\n${r.text.slice(0, 1500)}`);
      process.exit(1);
    }
    const id = found ? found.id : (r.json?.agent_id || r.json?.id);
    out[gender] = id;
    console.log(`  ok (${r.status}) ${r.text.slice(0, 160)}`);
  }
  if (!DRY) {
    console.log("\nPut these in the server's environment:");
    console.log(`  BOLNA_AGENT_ID=${out.woman || "(unchanged)"}`);
    console.log(`  BOLNA_AGENT_ID_MALE=${out.man || "(unchanged)"}`);
    console.log(`  webhook: ${webhookUrl.replace(secret, "<secret>")}`);
  }
})().catch((e) => {
  console.error("bolna_agents failed:", e.message || e);
  process.exit(1);
});
