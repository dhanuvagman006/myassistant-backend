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
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "ci-dummy-key";

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

  console.log("SMOKE TEST PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
