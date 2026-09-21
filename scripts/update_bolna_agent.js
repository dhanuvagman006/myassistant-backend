#!/usr/bin/env node
/**
 * PUSH THE CALLING AGENT'S CONFIGURATION TO BOLNA.
 *
 *   BOLNA_API_KEY=bn-… BOLNA_AGENT_ID=… node scripts/update_bolna_agent.js
 *   …                                   node scripts/update_bolna_agent.js --dry
 *
 * src/agents/callAgentConfig.js is the source of truth for the prompt,
 * the voice, the hearing and the call settings; this sends it. Run it
 * after ANY change to that file — the agent lives on Bolna's side, so
 * editing the file alone changes nothing about a real call.
 *
 * Safe to re-run: it is a PUT of the whole configuration, so the agent
 * ends up matching the file whatever state the dashboard left it in.
 * Bolna validates before it applies, so a rejected call changes nothing.
 *
 * It prints what the agent looked like BEFORE and AFTER, because a
 * config that was edited in the dashboard (it has been) is exactly the
 * kind of thing that should not disappear silently.
 */

const crypto = require("crypto");
const { agentConfig, VOICE, TRANSCRIBER } = require("../src/agents/callAgentConfig");

const KEY = process.env.BOLNA_API_KEY || "";
const AGENT = process.env.BOLNA_AGENT_ID || "";
const BASE = (process.env.PUBLIC_BASE_URL || "https://api.hariassistant.tech").replace(/\/$/, "");
const DRY = process.argv.includes("--dry");

if (!KEY || !AGENT) {
  console.error("Set BOLNA_API_KEY and BOLNA_AGENT_ID.");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
// The same derivation src/routes/agentCall.js uses — never a second secret.
const webhookUrl =
  `${BASE}/agent-call/bolna/webhook/` +
  crypto.createHash("sha256").update(KEY).digest("hex").slice(0, 32);

/** The three lines that decide how a call sounds. */
function summarise(agent) {
  const tc = agent?.tasks?.[0]?.tools_config || {};
  const cfg = agent?.tasks?.[0]?.task_config || {};
  const s = tc.synthesizer;
  const t = tc.transcriber;
  return {
    pipeline: (agent?.tasks?.[0]?.toolchain?.pipelines || []).flat().join(" → "),
    voice: s
      ? `${s.provider}/${s.provider_config?.model} ${s.provider_config?.voice_id}`
      : tc.s2s
      ? `s2s ${tc.s2s.provider}/${tc.s2s.provider_config?.model} ${tc.s2s.provider_config?.voice}`
      : "(none)",
    hearing: t ? `${t.provider}/${t.model} ${t.language}` : "(none)",
    fillers: `use_fillers=${cfg.use_fillers} backchanneling=${cfg.backchanneling} terminate=${cfg.call_terminate}s`,
  };
}

(async () => {
  const before = await fetch(`https://api.bolna.ai/agent/${AGENT}`, { headers });
  if (!before.ok) {
    console.error(`Could not read agent ${AGENT} (${before.status})`);
    process.exit(1);
  }
  console.log("BEFORE:", JSON.stringify(summarise(await before.json()), null, 1));

  const body = agentConfig({ webhookUrl });
  if (DRY) {
    console.log("\n--dry: would send", VOICE.provider, VOICE.model, VOICE.id,
      "| hearing", TRANSCRIBER.provider, TRANSCRIBER.model, TRANSCRIBER.language);
    console.log("prompt bytes:", body.agent_prompts.task_1.system_prompt.length);
    return;
  }

  // v1 is deprecated for updates; v2 PUT replaces the whole config.
  const r = await fetch(`https://api.bolna.ai/v2/agent/${AGENT}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error(`Bolna refused (${r.status}) — nothing was changed:\n${text}`);
    process.exit(1);
  }

  const after = await fetch(`https://api.bolna.ai/agent/${AGENT}`, { headers });
  console.log("AFTER: ", JSON.stringify(summarise(await after.json()), null, 1));
  console.log("\nAgent updated. Webhook:", webhookUrl);
})().catch((e) => {
  console.error("update_bolna_agent failed:", e.message || e);
  process.exit(1);
});
