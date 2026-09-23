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

  console.log("\nSSRF: user- and model-chosen URLs cannot reach this server's network");

  const dns = require("dns");
  const sf = require("../src/services/safeFetch");
  const registry = require("../src/tools/registry");
  require("../src/tools/builtins").registerBuiltins();

  /** Makes `names` resolve to `ip` for the duration of fn. */
  async function withDns(names, ip, fn) {
    const real = dns.lookup;
    dns.lookup = (host, opts, cb) => {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      if (!names.includes(host)) return real(host, opts, cb);
      const family = ip.includes(":") ? 6 : 4;
      return opts.all ? cb(null, [{ address: ip, family }]) : cb(null, ip, family);
    };
    try { return await fn(); } finally { dns.lookup = real; }
  }

  await atest("the public internet is allowed; private space is not, in any spelling", async () => {
    for (const ip of ["104.20.23.154", "8.8.8.8", "103.102.166.224", "2606:4700::6810:1"]) {
      assert.strictEqual(sf.isBlockedAddress(ip), false, `${ip} is public and was blocked`);
    }
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.3.4", "192.168.1.1", "169.254.169.254",
      "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1",
      "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254"]) {
      assert.strictEqual(sf.isBlockedAddress(ip), true, `${ip} is private and was allowed`);
    }
  });

  await atest("read_webpage refuses internal and metadata addresses", async () => {
    for (const url of [
      "http://127.0.0.1:3000/admin", "http://169.254.169.254/latest/meta-data/",
      "http://10.43.121.142:5432/", "http://[::1]/", "http://localhost:3000/",
      "http://metadata.google.internal/", "http://postgres.myassistant.svc/",
    ]) {
      const r = await registry.get("read_webpage").execute({ url }, {});
      assert.strictEqual(r.ok, false, `${url} was fetched`);
      assert.match(r.error, /not on the public internet/, `${url}: ${r.error}`);
    }
  });

  await atest("a hostname that resolves to a private address is refused at connect", async () => {
    // Checked in the socket's own lookup, so a rebinding DNS answer cannot
    // slip between a check and the connect.
    await withDns(["rebind.test"], "10.1.2.3", async () => {
      await assert.rejects(sf.safeFetch("http://rebind.test/"), { code: "EBLOCKED" });
    });
  });

  await atest("a public page that redirects inward is refused on the redirect", async () => {
    const http = require("http");
    const zlib = require("zlib");
    const server = http.createServer((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        return res.end(zlib.gzipSync("hello from the public internet"));
      }
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/iam/" });
      res.end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    sf._TEST_ALLOW.add("127.0.0.1"); // the local server plays "the internet"
    try {
      await withDns(["public.test"], "127.0.0.1", async () => {
        const ok = await sf.safeFetch(`http://public.test:${port}/ok`);
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(await ok.text(), "hello from the public internet",
          "an ordinary gzip page must still read normally");
        await assert.rejects(sf.safeFetch(`http://public.test:${port}/go`), { code: "EBLOCKED" });
      });
    } finally {
      sf._TEST_ALLOW.delete("127.0.0.1");
      await new Promise((r) => server.close(r));
    }
  });

  await atest("save_web_document refuses internal addresses too", async () => {
    const r = await registry.get("save_web_document").execute(
      { url: "http://169.254.169.254/latest/user-data" }, { userId: 1 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not on the public internet/);
  });

  await atest("an MCP server URL cannot point inside the network", async () => {
    const manager = require("../src/mcp/manager");
    const out = await manager.connect(424243, {
      id: 2, name: "probe", transport: "http",
      config: { url: "http://169.254.169.254/mcp" },
    }, {});
    assert.notStrictEqual(out.status, "connected");
    assert.match(String(out.error), /not on the public internet/, String(out.error));
  });

  await atest("a mail account cannot point at an internal host", async () => {
    const email = require("../src/services/email");
    await assert.rejects(
      email.connectAccount(1, {
        address: "me@example.com", password: "app-password",
        imapHost: "10.43.121.142", smtpHost: "smtp.example.com",
      }),
      /IMAP server 10\.43\.121\.142 is not a public mail server/
    );
  });

  console.log(`\n${passed} passed${process.exitCode ? " — with failures above" : ""}\n`);
})();
