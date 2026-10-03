#!/usr/bin/env node
/**
 * THE INBOUND AGENT ON BOLNA (2026-10-03). Dry by default: prints what it
 * would send.
 *
 *   node scripts/bolna_inbound.js            show the agent
 *   node scripts/bolna_inbound.js --apply    create or update it
 *   node scripts/bolna_inbound.js --link     also answer the account's number
 *                                            with it (POST /inbound/setup) —
 *                                            only with the owner's go
 *
 * The source of truth is src/agents/callAgentConfig.js (inboundAgentConfig).
 */
const crypto = require("crypto");
const cfg = require("../src/agents/callAgentConfig");

const KEY = process.env.BOLNA_API_KEY || "";
const BASE = (process.env.PUBLIC_BASE_URL || "https://api.hariassistant.tech").replace(/\/$/, "");
const APPLY = process.argv.includes("--apply") || process.argv.includes("--link");
const LINK = process.argv.includes("--link");
if (!KEY) {
  console.error("Set BOLNA_API_KEY.");
  process.exit(1);
}
const secret = crypto.createHash("sha256").update(KEY).digest("hex").slice(0, 32);
const webhookUrl = `${BASE}/agent-call/bolna/webhook/${secret}`;
const toolBase = `${BASE}/agent-call/bolna/tool/${secret}`;
const lookupUrl = `${BASE}/agent-call/bolna/inbound/${secret}`;
const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function api(method, path, body) {
  const r = await fetch(`https://api.bolna.ai${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { ok: r.ok, status: r.status, text, json };
}

(async () => {
  const payload = cfg.inboundAgentConfig({ webhookUrl, toolBase, lookupUrl, gender: "woman" });
  const name = payload.agent_config.agent_name;
  if (!APPLY) {
    console.log(JSON.stringify(payload, null, 2).split(secret).join("<secret>"));
    return;
  }
  const list = await api("GET", "/v2/agent/all?page_number=1&page_size=100");
  const existing = Array.isArray(list.json) ? list.json : (list.json?.data || []);
  const found = existing.find((a) => a.agent_name === name);
  const r = found ? await api("PUT", `/v2/agent/${found.id}`, payload) : await api("POST", "/v2/agent", payload);
  if (!r.ok) {
    console.error(`Bolna refused (${r.status}): ${r.text.slice(0, 1500)}`);
    process.exit(1);
  }
  const id = found ? found.id : (r.json?.agent_id || r.json?.id);
  console.log(`${found ? "updated" : "created"} "${name}" ${id}`);
  const back = await api("GET", `/v2/agent/${id}`);
  console.log("lookup configured:", Boolean(back.json?.ingest_source_config?.source_url));
  if (!LINK) return;
  const nums = await api("GET", "/phone-numbers/all");
  const num = (Array.isArray(nums.json) ? nums.json : [])[0];
  if (!num) return console.error("no phone number on the account");
  const link = await api("POST", "/inbound/setup", { agent_id: id, phone_number_id: num.id });
  console.log(link.ok ? "number now answered by the inbound agent" : `link refused (${link.status}): ${link.text.slice(0, 300)}`);
})().catch((e) => {
  console.error("bolna_inbound failed:", e.message || e);
  process.exit(1);
});
