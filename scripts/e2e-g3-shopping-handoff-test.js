/**
 * E2E · GROUP 3 — shopping and payments, store hand-offs, WhatsApp /
 * Instagram, third-party apps.
 *
 *   DATABASE_URL=postgres://…/myassistant_e2e_g3 node scripts/e2e-g3-shopping-handoff-test.js
 *
 * What runs for real: the /contacts router behind the real appAuth (a
 * signed session JWT per test user), the tool registry with every builtin,
 * the fulfillment hand-offs, and Postgres.
 *
 * What is stubbed: every model, web search, places lookup and the
 * social-handle lookup. Any fetch to a host other than 127.0.0.1 throws —
 * nothing here can reach a paid or real service.
 *
 * The app side (Dart + Kotlin) is checked statically against the files in
 * ../myassistant-flutter: the intent filters and channel handlers the
 * hand-offs rely on.
 *
 * Self-cleaning: every row written for the test users is deleted at the
 * end, whatever happened.
 *
 * Tests named "DEFECT:" pin a real defect and are EXPECTED TO FAIL until
 * the defect is fixed. Do not weaken them.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://myassistant:localdev@127.0.0.1:55432/myassistant_e2e_g3";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "g3-e2e-test-secret-not-real";
delete process.env.AUTH_DISABLED;

const assert = require("assert");
const fs = require("fs");
const path = require("path");

/* ------------------------------------------------------------------ *
 * NO NETWORK. Only this process's own test server may be fetched.
 * ------------------------------------------------------------------ */
const realFetch = globalThis.fetch;
const blocked = [];
globalThis.fetch = async (url, opts) => {
  const u = new URL(typeof url === "string" ? url : url.url || String(url));
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return realFetch(url, opts);
  blocked.push(u.hostname);
  throw new Error(`network blocked in test: ${u.hostname}`);
};

/* ------------------------------------------------------------------ *
 * THE MODELS, STUBBED — set before anything binds them at load time
 * (commitments/service and agents/runtime destructure the router).
 * ------------------------------------------------------------------ */
const ai = require("../src/services/ai/router");
ai.generateReply = async () => { throw new Error("model stubbed in test"); };
ai.generateWithToolsStream = async () => ({ functionCalls: [], text: "" });
ai.generateWithTools = async () => ({ functionCalls: [], text: "" });

const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../src/db");

let passed = 0;
let failed = 0;
const failures = [];
async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    failures.push(name);
    console.error(`  FAIL ${name}\n       ${String(e.stack || e.message).split("\n").slice(0, 6).join("\n       ")}`);
    process.exitCode = 1;
  }
}

const FLUTTER = path.resolve(__dirname, "../../myassistant-flutter");
const KT = path.join(FLUTTER, "android/app/src/main/kotlin/com/myassistant/myassistant");
const readApp = (rel) => fs.readFileSync(path.join(FLUTTER, rel), "utf8");
const readKt = (f) => fs.readFileSync(path.join(KT, f), "utf8");
const haveApp = fs.existsSync(path.join(FLUTTER, "lib/features/assistant/state/assistant_engine.dart"));

(async () => {
  await db.init();
  const registry = require("../src/tools/registry");
  require("../src/tools/builtins").registerBuiltins();
  const webSearch = require("../src/tools/webSearch");
  const socialHandles = require("../src/tools/socialHandles");
  const places = require("../src/services/tools/places");
  const { appAuth } = require("../src/middleware/auth");

  // Stubs for the lookups (no network, fixed answers).
  webSearch.run = async (q) => ({
    ok: true, provider: "stub",
    data: /virat/i.test(q)
      ? [{ title: "Virat Kohli (@virat.kohli) • Instagram photos and videos",
          url: "https://www.instagram.com/virat.kohli/", snippet: "Verified account" }]
      : [],
  });
  socialHandles.resolveVerified = async (person) => (/virat/i.test(person) ? "virat.kohli" : null);
  socialHandles.inspectionBlocked = () => true; // what production sees (Instagram 429s the server)
  places.searchPlaces = async ({ q }) => (/airport/i.test(q)
    ? [{ name: "Kempegowda International Airport", lat: 13.1986, lng: 77.7066, phone: "" }] : []);

  /* ---------------- users, sessions, server ---------------- */
  // Leftovers of an earlier run that died before its own clean-up.
  async function purge(ids) {
    if (!ids.length) return;
    const tables = await db.query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema='public' AND column_name='user_id' AND table_name <> 'users'`);
    for (const { table_name: t } of tables) {
      await db.run(`DELETE FROM "${t}" WHERE user_id::text = ANY($1::text[])`, [ids.map(String)]).catch(() => 0);
    }
    await db.run(`DELETE FROM users WHERE id = ANY($1::int[])`, [ids]);
  }
  await purge((await db.query(`SELECT id FROM users WHERE email LIKE 'g3-%@example.test'`)).map((r) => Number(r.id)));
  const stamp = Date.now();
  const mk = async (tag, extra = {}) => {
    const u = await db.createUser({ email: `g3-${tag}-${stamp}@example.test`, name: extra.name || `G3 ${tag}` });
    await db.run(`UPDATE users SET phone_number=COALESCE($2, phone_number), location=COALESCE($3, location) WHERE id=$1`,
      [u.id, extra.phone || null, extra.city || null]);
    return { id: u.id, token: jwt.sign({ uid: u.id }, process.env.JWT_SECRET, { expiresIn: "1h" }) };
  };
  const A = await mk("a", { name: "Ravi Kumar", phone: "+919812345678", city: "Bengaluru" });
  const B = await mk("b");
  const USERS = [A, B];

  const app = express();
  app.use(express.json());
  app.use("/contacts", appAuth, require("../src/routes/contacts"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (method, p, { token, body, headers = {} } = {}) => {
    const res = await realFetch(base + p, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { status: res.status, body: json };
  };
  const tool = (n) => registry.get(n);
  const ctxFor = (u, extra = {}) => ({ userId: u.id, platform: "android", appBuild: 118, source: "text", ...extra });

  try {
    /* ============================================================== *
     * 1 · THE WEB
     * ============================================================== */
    console.log("\nweb · real addresses only");

    await atest("open_webpage opens only real web addresses, and a search when unsure", async () => {
      const t = tool("open_webpage");
      assert.strictEqual((await t.execute({ url: "intent://x#Intent;action=android.intent.action.DELETE;end" })).ok, false);
      const s = await t.execute({ search: "district court documents download Karnataka" });
      assert.strictEqual(s.deviceAction.url, "https://www.google.com/search?q=district%20court%20documents%20download%20Karnataka");
      const ok = await t.execute({ url: "eportal.incometax.gov.in", label: "the income tax portal" });
      assert.strictEqual(ok.deviceAction.type, "open_url");
      assert.match(ok.deviceAction.url, /^https:\/\/eportal\.incometax\.gov\.in/);
    });

    /* ============================================================== *
     * 2 · STORES AND PAYMENTS
     * ============================================================== */
    console.log("\nstores and payments · hand-offs, UPI, connectors");

    await atest("DEFECT: open_service_app makemytrip with a search does not promise results it cannot open", async () => {
      const r = await tool("open_service_app").execute({ service: "makemytrip", query: "flights to Goa" }, { platform: "android" });
      const landsOnSearch = /goa/i.test(decodeURIComponent(r.deviceAction.url));
      const promisesSearch = /for flights to Goa — pick the one you want/.test(r.speak);
      assert.ok(landsOnSearch || !promisesSearch,
        `the link opens MakeMyTrip's HOME page (${r.deviceAction.url}) while the assistant says "${r.speak}" — ` +
        "deeplinks.js shop() marks precision 'search' whenever a query is given, even for makemytrip whose path ignores it");
    });

    await atest("PayPal → UPI: no saved ID asks once; a saved ID pre-fills the UPI app; the PIN is the owner's", async () => {
      const ask = await registry.execute("pay_by_upi", { payee: "Suresh", amount: 500 }, ctxFor(A));
      assert.strictEqual(ask.ok, false);
      assert.strictEqual(ask.error, "need_upi_id");
      assert.ok(!ask.deviceAction);
      const saved = await registry.execute("save_upi_id", { person: "Amma", upi_id: "98450 12345@YBL" }, ctxFor(A));
      assert.strictEqual(saved.ok, true, JSON.stringify(saved));
      assert.strictEqual(saved.data.upi_id, "9845012345@ybl");
      const pay = await registry.execute("pay_by_upi", { payee: "amma", amount: 1500, note: "groceries & milk" }, ctxFor(A));
      assert.strictEqual(pay.ok, true, JSON.stringify(pay));
      assert.strictEqual(pay.deviceAction.url, "upi://pay?pa=9845012345@ybl&pn=amma&am=1500.00&cu=INR&tn=groceries%20%26%20milk");
      assert.match(pay.speak, /approve with your PIN/);
      assert.doesNotMatch(pay.speak, /\bpaid\b|\bsent\b/i);
      const row = await db.one(`SELECT upi_id FROM clients WHERE user_id=$1 AND lower(name)='amma'`, [A.id]);
      assert.strictEqual(row.upi_id, "9845012345@ybl");
      assert.match((await registry.execute("pay_by_upi", { payee: "Amma", amount: 150000 }, ctxFor(A))).error, /between/);
      const bad = await registry.execute("save_upi_id", { person: "X", upi_id: "not-an-id" }, ctxFor(A));
      assert.strictEqual(bad.ok, false);
    });

    await atest("PayPal → UPI: after reading a web page the payment needs a yes, and a scheduled task can never pay", async () => {
      const t = await registry.execute("pay_by_upi", { payee: "Amma", amount: 700 }, { ...ctxFor(A), __untrustedAt: Date.now() });
      assert.strictEqual(t.needsConfirmation, true);
      assert.match(t.summary, /Pay ₹700 to Amma by UPI/);
      const bg = await registry.execute("pay_by_upi", { payee: "Amma", amount: 700 }, { ...ctxFor(A), background: true });
      assert.strictEqual(bg.ok, false);
      assert.match(bg.error, /cannot run unattended/);
      if (haveApp) {
        const man = readApp("android/app/src/main/AndroidManifest.xml");
        assert.match(man, /<data android:scheme="upi"\/>/, "Android 11+ must be able to see a UPI app");
      }
    });

    await atest("payment connectors that need a partner stay hidden: collect_payment, calling a business, one-time cards", () => {
      const names = new Set(registry.declarations({}).map((x) => x.name));
      for (const n of ["collect_payment", "book_by_calling_business", "arrange_meeting_with"]) {
        assert.ok(!names.has(n), `${n} must not be offered`);
      }
      assert.ok(names.has("pay_by_upi") && names.has("open_service_app"));
    });

    /* ============================================================== *
     * 3 · META: WHATSAPP AND INSTAGRAM
     * ============================================================== */
    console.log("\nmeta · WhatsApp and Instagram");

    await atest("WhatsApp: a contact synced from the phone gets a pre-written chat, the owner taps Send", async () => {
      const sync = await http("POST", "/contacts/sync", { token: A.token,
        body: { contacts: [{ name: "Ravi Shankar", phone: "+91 98450 12345" }, { name: "", phone: "123" }] } });
      assert.strictEqual(sync.status, 200);
      assert.strictEqual(sync.body.stored, 1);
      const r = await registry.execute("send_whatsapp_message", { to: "Ravi Shankar", message: "Running 10 minutes late" }, ctxFor(A));
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.deviceAction.type, "open_url");
      assert.match(r.deviceAction.url, /^whatsapp:\/\/send\?phone=\+?919845012345&text=Running%2010%20minutes%20late$/);
      assert.match(r.speak, /just tap send/);
      assert.doesNotMatch(r.speak, /\bsent\b/i);
      const g = await registry.execute("send_whatsapp_message", { to: "Family", is_group: true, message: "Dinner at 8" }, ctxFor(A));
      assert.strictEqual(g.deviceAction.url, "whatsapp://send?text=Dinner%20at%208");
      if (haveApp) {
        assert.match(readApp("android/app/src/main/AndroidManifest.xml"), /<data android:scheme="whatsapp"\/>/);
      }
    });

    await atest("WhatsApp calls: 'call Ravi on WhatsApp' goes to the phone with via=whatsapp, and the phone has the handler", async () => {
      const r = await registry.execute("place_phone_call", { name: "Ravi", via: "whatsapp" }, { ...ctxFor(A), approved: true });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.deviceAction.type, "resolve_and_call");
      assert.strictEqual(r.deviceAction.via, "whatsapp");
      if (haveApp) {
        const eng = readApp("lib/features/assistant/state/assistant_engine.dart");
        assert.match(eng, /case 'resolve_and_call':/);
        assert.match(eng, /CallService\.instance\.whatsappCall\(/);
        const main = readKt("MainActivity.kt");
        assert.match(main, /"whatsappCall" ->/);
        assert.match(main, /vnd\.android\.cursor\.item\/vnd\.com\.whatsapp\.voip\.call/);
      }
    });

    await atest("Instagram: opening a person's profile says plainly when the handle could not be confirmed", async () => {
      const r = await tool("open_app").execute({ app: "instagram", person: "Virat Kohli" }, ctxFor(A));
      assert.strictEqual(r.deviceAction.url, "https://www.instagram.com/virat.kohli/");
      assert.match(r.speak, /couldn't confirm it's the right one/);
      const none = await tool("open_app").execute({ app: "instagram", person: "Some Unknown Person" }, ctxFor(A));
      assert.match(none.deviceAction.url, /^https:\/\/www\.google\.com\/search\?tbm=isch&q=/);
    });

    await atest("connected apps: 'open X' lets the phone decide; install only on the owner's word; an old app is told to update", async () => {
      const t = tool("open_named_app");
      const sw = await t.execute({ app: "the Swiggy app" }, ctxFor(A));
      assert.deepStrictEqual(sw.deviceAction, { type: "open_any_app", name: "Swiggy", pkg: "in.swiggy.android", store_if_missing: true, install: false });
      const inst = await t.execute({ app: "Zomato", install: true }, ctxFor(A));
      assert.strictEqual(inst.deviceAction.install, true);
      const old = await t.execute({ app: "Swiggy" }, { ...ctxFor(A), appBuild: 20 });
      assert.strictEqual(old.deviceAction.type, "open_url", "a very old app still gets the deep link");
      const oldUnknown = await t.execute({ app: "Croma" }, { ...ctxFor(A), appBuild: 20 });
      assert.strictEqual(oldUnknown.error, "app_too_old");
      if (haveApp) assert.match(readApp("lib/features/assistant/state/assistant_engine.dart"), /case 'open_any_app':/);
    });

    /* ============================================================== *
     * 4 · THIRD-PARTY COORDINATION (hand-offs)
     * ============================================================== */
    console.log("\nproductivity · third-party service coordination");

    await atest("food, ride and cinema hand off to the app at the right place and file a task; nothing claims it was booked", async () => {
      const food = await registry.execute("order_food", { dish: "chicken biryani" }, ctxFor(B));
      assert.strictEqual(food.ok, true, JSON.stringify(food));
      assert.match(food.deviceAction.url, /^intent:\/\/www\.swiggy\.com\/search\?query=chicken%20biryani#Intent;scheme=https;package=in\.swiggy\.android;/);
      const ride = await registry.execute("book_ride", { destination: "the airport" }, { ...ctxFor(B), lat: 12.9716, lng: 77.5946 });
      assert.strictEqual(ride.ok, true, JSON.stringify(ride));
      assert.match(ride.deviceAction.url, /dropoff\[latitude\]=13\.1986&dropoff\[longitude\]=77\.7066/);
      assert.match(ride.deviceAction.url, /pickup\[latitude\]=12\.9716/);
      assert.match(ride.deviceAction.url, /package=com\.ubercab;/);
      assert.match(ride.speak, /already set — confirm it/);
      const movie = await registry.execute("book_movie_tickets", { title: "Kantara", city: "Bengaluru" }, ctxFor(B));
      assert.match(movie.deviceAction.url, /in\.bookmyshow\.com\/explore\/search\?q=Kantara/);
      for (const r of [food, ride, movie]) assert.doesNotMatch(r.speak, /\b(?:ordered|booked|placed|confirmed)\b/i);
      const rows = await db.query(`SELECT kind, provider, status, deep_link FROM fulfillment_tasks WHERE user_id=$1 AND path='handoff' ORDER BY id`, [B.id]);
      assert.deepStrictEqual(rows.map((x) => [x.kind, x.provider, x.status]),
        [["food", "swiggy", "handed_off"], ["ride", "uber", "handed_off"], ["movie", "bookmyshow", "handed_off"]]);
      assert.strictEqual(rows[0].deep_link, food.deviceAction.url);
    });
  } finally {
    server.close();
    // Self-cleaning: every row of every table keyed by these users, then the users.
    try {
      await purge(USERS.map((u) => u.id));
    } catch (e) {
      console.error("cleanup failed:", e.message);
    }
  }

  if (blocked.length) console.log(`\n(network blocked ${blocked.length}x: ${[...new Set(blocked)].join(", ")})`);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log(`failed: ${failures.join(" | ")}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
