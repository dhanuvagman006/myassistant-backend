#!/usr/bin/env node
/**
 * CREATE THE BOLNA CALLING AGENT — run ONCE when the Bolna account exists:
 *
 *   BOLNA_API_KEY=bn-... node scripts/create_bolna_agent.js
 *
 * Prints the agent id to store as BOLNA_AGENT_ID in myassistant-secrets
 * (with BOLNA_API_KEY and BOLNA_FROM_NUMBER, the +91 number bought in the
 * dashboard). The webhook URL embeds sha256(api key)[:32], which is what
 * src/routes/agentCall.js expects — no separate secret to store.
 *
 * THE CONFIGURATION ITSELF LIVES IN src/agents/callAgentConfig.js and is
 * shared with scripts/update_bolna_agent.js, which pushes changes to an
 * agent that already exists. It used to be inlined here, which meant the
 * live agent and this script disagreed the moment anything changed.
 */

const crypto = require("crypto");
const { agentConfig, VOICE, TRANSCRIBER } = require("../src/agents/callAgentConfig");

const KEY = process.env.BOLNA_API_KEY || "";
const BASE = (process.env.PUBLIC_BASE_URL || "https://api.hariassistant.tech").replace(/\/$/, "");

if (!KEY) {
  console.error("Set BOLNA_API_KEY (Bolna dashboard → Developers tab).");
  process.exit(1);
}

const secret = crypto.createHash("sha256").update(KEY).digest("hex").slice(0, 32);
const webhookUrl = `${BASE}/agent-call/bolna/webhook/${secret}`;

(async () => {
  const r = await fetch("https://api.bolna.ai/v2/agent", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(agentConfig({ webhookUrl })),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error(`Bolna refused (${r.status}) — fix the named field and re-run:\n${text}`);
    process.exit(1);
  }
  const j = JSON.parse(text);
  console.log("Agent created.");
  console.log("  BOLNA_AGENT_ID =", j.agent_id || j.id || "(see full response below)");
  console.log("  webhook_url    =", webhookUrl);
  console.log("  voice          =", VOICE.provider, VOICE.model, VOICE.id);
  console.log("  hearing        =", TRANSCRIBER.provider, TRANSCRIBER.model, TRANSCRIBER.language);
  console.log(JSON.stringify(j, null, 2));
})().catch((e) => {
  console.error("create_bolna_agent failed:", e.message || e);
  process.exit(1);
});
