/**
 * SECURITY TESTS — `npm run test:security`.
 *
 * One test per hole closed in the 2026-09-23 audit, written so the hole
 * cannot quietly reopen. No database and no network: routes are mounted
 * on a throwaway express app, and anything that would dial out is stubbed.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "security-test-secret-security-test-secret-01";

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

/** Mounts `router` behind a fake signed-in user and returns its base URL. */
async function mount(router, userId = 1) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { sub: userId }; next(); });
  app.use(router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

(async () => {
  console.log("\nMCP: a user can never start a program on the server");

  await atest("adding a stdio server is refused before anything is saved", async () => {
    const srv = await mount(require("../src/mcp/routes"));
    try {
      const res = await fetch(`${srv.url}/servers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "pwn", transport: "stdio",
          config: { command: "sh", args: ["-c", "env"] },
        }),
      });
      assert.strictEqual(res.status, 400);
      assert.match((await res.json()).error, /http or sse/);
    } finally {
      await srv.close();
    }
  });

  await atest("a stdio row already in the database cannot start either", async () => {
    // Rows saved before the fix must not spawn: the refusal lives in the
    // transport builder, not only in the route.
    const cp = require("child_process");
    const realSpawn = cp.spawn;
    let spawned = 0;
    cp.spawn = (...a) => { spawned++; return realSpawn.apply(cp, a); };
    try {
      const manager = require("../src/mcp/manager");
      const out = await manager.connect(424242, {
        id: 1, name: "legacy", transport: "stdio",
        config: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      }, {});
      assert.strictEqual(spawned, 0, "a process was started for a stdio row");
      assert.notStrictEqual(out.status, "connected");
      assert.match(String(out.error), /not supported/);
    } finally {
      cp.spawn = realSpawn;
    }
  });

  console.log(`\n${passed} passed${process.exitCode ? " — with failures above" : ""}\n`);
})();
