/**
 * WHO GETS WHICH LIVE MODEL, AND HOW THE CLASSIC VOICE HEARS —
 * `npm run test:aiconfig`.
 *
 * The owner, 2026-10-01: the client gets the higher Live model for now,
 * everyone else the current one; and every classic-voice turn is recorded
 * and transcribed by Gemini so it can be heard and so "Kannada" is not
 * heard as "Canada".
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://x@localhost:5432/x";
const assert = require("assert");
const cfg = require("../src/ai/config");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

const saved = { m: process.env.AI_LIVE_MODEL, u: process.env.AI_LIVE_MODEL_USERS, s: process.env.AI_CLOUD_STT };
const restore = () => {
  for (const [k, v] of [["AI_LIVE_MODEL", saved.m], ["AI_LIVE_MODEL_USERS", saved.u], ["AI_CLOUD_STT", saved.s]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};

try {
  check("everyone gets the base Live model; a pinned user gets theirs", () => {
    delete process.env.AI_LIVE_MODEL;
    process.env.AI_LIVE_MODEL_USERS = "56:gemini-3.8-live, 54:gemini-3.8-live";
    process.env.AI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
    assert.strictEqual(cfg.liveModelFor(55), "gemini-3.1-flash-live-preview");
    assert.strictEqual(cfg.liveModelFor(56), "gemini-3.8-live");
    assert.strictEqual(cfg.liveModelFor(54), "gemini-3.8-live");
    assert.strictEqual(cfg.liveModelFor(null), "gemini-3.1-flash-live-preview");
  });

  check("a malformed pin is ignored, never served", () => {
    process.env.AI_LIVE_MODEL_USERS = "56:not a model!,abc:gemini-x,:gemini-y";
    process.env.AI_LIVE_MODEL = "gemini-3.8-live";
    assert.strictEqual(cfg.liveModelFor(56), "gemini-3.8-live");
  });

  check("the classic voice records by default; AI_CLOUD_STT=device switches back", () => {
    delete process.env.AI_CLOUD_STT;
    assert.strictEqual(cfg.cloudSttMode(), "record");
    process.env.AI_CLOUD_STT = "device";
    assert.strictEqual(cfg.cloudSttMode(), "device");
    process.env.AI_CLOUD_STT = "nonsense";
    assert.strictEqual(cfg.cloudSttMode(), "record");
  });
} finally {
  restore();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
