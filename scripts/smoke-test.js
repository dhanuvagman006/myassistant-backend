/**
 * CI SMOKE TEST — boots the REAL server against the CI Postgres and
 * proves the deployable artifact actually starts and serves.
 *
 * Replaces the old tests/ e2e suite, which was deleted in c172da9 while
 * package.json kept pointing at it — every CI run since died on a missing
 * file. A boot + endpoint check is the honest floor: it catches broken
 * requires, bad SQL at init, route-mount crashes and auth-guard mistakes.
 *
 * Checks:
 *   1. server starts and /health answers ok:true
 *   2. public legal pages render (Play Store links must never 500)
 *   3. an authed route without credentials is REFUSED (401/400, not 200)
 */
process.env.PORT = process.env.PORT || "3999";
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "ci-smoke-secret-0123456789abcdefghijklmnopqrstuv";
process.env.NODE_ENV = "test";
// CI has no real keys; boot must not depend on them.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "ci-dummy-key";
// Set so the metrics guard is exercised; unset Plivo so its webhooks are closed.
process.env.METRICS_TOKEN = "smoke-metrics-token";
delete process.env.PLIVO_AUTH_TOKEN;

const BASE = `http://localhost:${process.env.PORT}`;

async function get(path) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(8000) });
  return { status: r.status, text: await r.text() };
}

async function waitForBoot() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await get("/health");
      if (r.status === 200 && JSON.parse(r.text).ok === true) return;
    } catch (_) {}
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error("server did not become healthy within 20s");
}

(async () => {
  require("../src/server");
  await waitForBoot();
  console.log("✓ server boots, /health ok");

  for (const p of ["/legal/privacy", "/legal/terms"]) {
    const r = await get(p);
    if (r.status !== 200 || !/<h1>/.test(r.text)) {
      throw new Error(`${p} → ${r.status} (expected 200 with content)`);
    }
  }
  console.log("✓ legal pages render");

  const guarded = await get("/brief");
  if (guarded.status === 200) {
    throw new Error("/brief served without credentials — auth guard broken");
  }
  console.log(`✓ authed route refused without credentials (${guarded.status})`);

  // An exact "/metrics" check once let GET /metrics/ past the token.
  for (const p of ["/metrics", "/metrics/", "/METRICS", "/metrics/agent"]) {
    const r = await get(p);
    if (r.status === 200) throw new Error(`${p} served without the metrics token`);
  }
  const withToken = await fetch(BASE + "/metrics", {
    headers: { authorization: "Bearer smoke-metrics-token" },
    signal: AbortSignal.timeout(8000),
  });
  if (withToken.status !== 200) throw new Error(`/metrics refused its own token (${withToken.status})`);
  console.log("✓ metrics need the token, on every spelling of the path");

  // With no Plivo account configured, nothing may pose as Plivo.
  const forged = await fetch(BASE + "/inbound/plivo/answer", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "To=%2B911234567890&From=%2B919876543210",
    signal: AbortSignal.timeout(8000),
  });
  if (forged.status === 200) throw new Error("an unsigned Plivo webhook was served");
  console.log(`✓ unsigned Plivo webhooks are refused (${forged.status})`);

  console.log("SMOKE TEST PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
