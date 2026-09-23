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

/**
 * Swaps runAgentTurn for a stub that records the ctx it was given.
 * `impl(text, ctx, onEvent)` may replace the default behaviour.
 */
function stubRuntime(reply = "Done.", impl = null) {
  const runtime = require("../src/agents/runtime");
  const real = runtime.runAgentTurn;
  const calls = [];
  runtime.runAgentTurn = async (text, ctx, onEvent = () => {}) => {
    calls.push({ text, ctx });
    if (impl) return impl(text, ctx, onEvent);
    return { text: reply, toolResults: [], deviceActions: [] };
  };
  return { calls, restore: () => { runtime.runAgentTurn = real; } };
}

async function mount() {
  const routes = require("../src/assistant/routes");
  const app = express();
  app.get("/assistant/stream/:sid", routes.streamHandler);
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { sub: "0", name: "Test" }; next(); });
  app.use("/assistant", routes);
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/assistant`;
  const post = (path, body = {}, headers = {}) => fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  /** Opens the session's SSE stream and collects its events. */
  const listen = async (s) => {
    const ac = new AbortController();
    const res = await fetch(`${base}/stream/${s.sessionId}?token=${s.streamToken}`, { signal: ac.signal });
    const events = [];
    (async () => {
      const dec = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = block.split("\n").find((l) => l.startsWith("data: "));
            if (data) events.push(JSON.parse(data.slice(6)));
          }
        }
      } catch (_) {}
    })();
    return { events, stop: () => ac.abort() };
  };
  return { post, listen, close: () => new Promise((r) => server.close(r)) };
}

/** Waits until an event matching `pred` arrives (or times out). */
async function waitFor(events, pred, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (events.some(pred)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
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

  console.log("\nnothing the agent already did is done twice");

  const CALL = "call mom and tell her I'll be late";

  await atest("a runtime failure AFTER a tool ran is reported, not re-run by the legacy chain", async () => {
    const rt = stubRuntime(null, async (_t, _c, onEvent) => {
      onEvent("tool_start", { name: "place_phone_call" });
      onEvent("tool_done", { name: "place_phone_call", ok: true }); // the call went out
      throw new Error("model timed out on the follow-up round");
    });
    const srv = await mount();
    try {
      const s = await (await srv.post("/session")).json();
      const sse = await srv.listen(s);
      await srv.post(`/${s.sessionId}/message`, { text: CALL });
      await waitFor(sse.events, (e) => e.type === "assistant_message");
      await new Promise((r) => setTimeout(r, 150)); // anything the legacy chain would add
      sse.stop();
      assert.ok(!sse.events.some((e) => e.type === "contact_lookup"),
        "the legacy chain started a second call");
      const said = sse.events.find((e) => e.type === "assistant_message");
      assert.ok(said, "the user was told nothing");
      assert.match(said.text, /may already have gone through/);
    } finally {
      rt.restore();
      await srv.close();
    }
  });

  await atest("a silent reply after a successful tool speaks the tool's result, not the legacy chain", async () => {
    const rt = stubRuntime(null, async (_t, _c, onEvent) => {
      onEvent("tool_done", { name: "send_agent_message", ok: true });
      return {
        text: "",
        toolResults: [{ name: "send_agent_message", ok: true, speak: "Sent to Mom." }],
        deviceActions: [],
      };
    });
    const srv = await mount();
    try {
      const s = await (await srv.post("/session")).json();
      const sse = await srv.listen(s);
      await srv.post(`/${s.sessionId}/message`, { text: CALL });
      await waitFor(sse.events, (e) => e.type === "assistant_message");
      await new Promise((r) => setTimeout(r, 150));
      sse.stop();
      assert.ok(!sse.events.some((e) => e.type === "contact_lookup"),
        "an empty reply handed the turn to the legacy chain, which dialled");
      assert.strictEqual(sse.events.find((e) => e.type === "assistant_message").text, "Sent to Mom.");
    } finally {
      rt.restore();
      await srv.close();
    }
  });

  await atest("when the agent did nothing at all, the legacy chain still catches the turn", async () => {
    // The fallback exists for a runtime that broke before acting; that
    // must keep working.
    const rt = stubRuntime(null, async () => { throw new Error("model unavailable"); });
    const srv = await mount();
    try {
      const s = await (await srv.post("/session")).json();
      const sse = await srv.listen(s);
      await srv.post(`/${s.sessionId}/message`, { text: CALL });
      await waitFor(sse.events, (e) => e.type === "contact_lookup");
      sse.stop();
      assert.ok(sse.events.some((e) => e.type === "contact_lookup"),
        "the fallback no longer handles a turn the agent never started");
    } finally {
      rt.restore();
      await srv.close();
    }
  });

  console.log(`\n${passed} passed${process.exitCode ? " — with failures above" : ""}\n`);
  process.exit(process.exitCode || 0);
})();
