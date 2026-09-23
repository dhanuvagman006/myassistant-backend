/**
 * VOICE LOOP (/assistant) TESTS — `npm run test:assistant`.
 *
 * The SSE voice loop is the app's main path and had no HTTP-level test.
 * These drive the real router over HTTP with the agent runtime stubbed, so
 * they check what the loop hands the agent — no model, no keys.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

const assert = require("assert");
const express = require("express");

let passed = 0;
async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

/** Swaps runAgentTurn for a stub that records the ctx it was given. */
function stubRuntime(reply = "Done.") {
  const runtime = require("../src/agents/runtime");
  const real = runtime.runAgentTurn;
  const calls = [];
  runtime.runAgentTurn = async (text, ctx) => {
    calls.push({ text, ctx });
    return { text: reply, toolResults: [], deviceActions: [] };
  };
  return { calls, restore: () => { runtime.runAgentTurn = real; } };
}

async function mount() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { sub: "0", name: "Test" }; next(); });
  app.use("/assistant", require("../src/assistant/routes"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/assistant`;
  const post = (path, body = {}, headers = {}) => fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { post, close: () => new Promise((r) => server.close(r)) };
}

/** Waits until the stub has seen `n` turns (turns run after the 202). */
async function turns(calls, n, ms = 3000) {
  const until = Date.now() + ms;
  while (calls.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  assert.ok(calls.length >= n, `expected ${n} agent turn(s), saw ${calls.length}`);
}

(async () => {
  console.log("\nwhere and when the user is");

  await atest("a turn with no headers (an audio upload) keeps the session's timezone and place", async () => {
    const rt = stubRuntime();
    const srv = await mount();
    try {
      const s = await (await srv.post("/session", {}, {
        "X-TZ-Offset": "60", "X-Geo-Lat": "51.5072", "X-Geo-Lng": "-0.1276",
      })).json();
      // The audio upload carries only Authorization — mimic it: no headers.
      await srv.post(`/${s.sessionId}/message`, { text: "remind me at 8 tomorrow to call the bank" });
      await turns(rt.calls, 1);
      const ctx = rt.calls[0].ctx;
      assert.strictEqual(ctx.tzOffsetMin, 60, "the agent was not given the user's timezone");
      assert.strictEqual(ctx.lat, 51.5072);
      assert.strictEqual(ctx.lng, -0.1276);
    } finally {
      rt.restore();
      await srv.close();
    }
  });

  await atest("UTC is a timezone, not a missing one", async () => {
    const rt = stubRuntime();
    const srv = await mount();
    try {
      const s = await (await srv.post("/session", {}, { "X-TZ-Offset": "0" })).json();
      await srv.post(`/${s.sessionId}/message`, { text: "what's on my calendar tomorrow" });
      await turns(rt.calls, 1);
      assert.strictEqual(rt.calls[0].ctx.tzOffsetMin, 0, "a UTC user was treated as IST");
    } finally {
      rt.restore();
      await srv.close();
    }
  });

  await atest("IST is assumed only when the phone never said", async () => {
    const rt = stubRuntime();
    const srv = await mount();
    try {
      const s = await (await srv.post("/session")).json();
      await srv.post(`/${s.sessionId}/message`, { text: "what's the weather" });
      await turns(rt.calls, 1);
      assert.strictEqual(rt.calls[0].ctx.tzOffsetMin, 330);
      assert.strictEqual(rt.calls[0].ctx.lat, undefined, "a location was invented");
    } finally {
      rt.restore();
      await srv.close();
    }
  });

  await atest("the offset helper keeps 0 and rejects nonsense", () => {
    const { offsetOr } = require("../src/services/tz");
    assert.strictEqual(offsetOr("0"), 0);
    assert.strictEqual(offsetOr(-300), -300);
    assert.strictEqual(offsetOr(undefined), 330);
    assert.strictEqual(offsetOr(""), 330);
    assert.strictEqual(offsetOr("abc"), 330);
    assert.strictEqual(offsetOr(99999), 330, "an impossible offset was accepted");
  });

  console.log(`\n${passed} passed${process.exitCode ? " — with failures above" : ""}\n`);
  process.exit(process.exitCode || 0);
})();
