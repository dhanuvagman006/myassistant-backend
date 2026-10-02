/**
 * ADDRESSES (2026-09-30) — `node scripts/address-memory-test.js`.
 *
 * The owner's ask: "remember Ravi's house address", then "remember that"
 * after one, and "what's Ravi's address?" must SHOW it. Pins:
 *   (a) remember_address then show_address through registry.execute — the
 *       exact name, a first name ('Ravi' → 'Ravi Kumar'), a misheard one;
 *   (b) labels: home/office, 'house' is home, a new one replaces the old;
 *   (c) the card: {type:'show_address', name, label, address, phone?, saved};
 *   (d) lookup_person carries addresses; the legacy fallback finds an
 *       address told before today in a note or a fact; nothing saved is
 *       ok:false with words the model can say; another user sees nothing;
 *   (e) the wiring: GATE 0, claim families, the Live set, the phone's
 *       per-turn pick, the REMEMBER THAT rule;
 *   (f) account deletion removes the rows.
 *
 * Local Postgres only; nothing leaves the machine.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@127.0.0.1:56432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const assert = require("assert");

let passed = 0;
async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

// Nothing may reach the network (embeddings, a model): the test is local.
const blocked = [];
global.fetch = async (url) => {
  blocked.push(String(url && url.url ? url.url : url));
  throw new Error("blocked in test");
};

const db = require("../src/db");

(async () => {
  await db.init();
  const registry = require("../src/tools/registry");
  require("../src/tools/builtins").registerBuiltins();
  const mem = require("../src/memory/service");
  const privacy = require("../src/routes/privacy");

  const stamp = String(Date.now()).slice(-8);
  const A = (await db.createUser({ email: `addr-a-${stamp}@example.test`, name: "Address A" })).id;
  const B = (await db.createUser({ email: `addr-b-${stamp}@example.test`, name: "Address B" })).id;
  const ctx = (userId, said = "") => ({ userId, tzOffsetMin: 330, source: "text", intent: said });
  const run = (name, args, userId = A, said = "") => registry.execute(name, args, ctx(userId, said));
  const CARD_KEYS = ["address", "label", "name", "saved", "type"];

  console.log("\nSave, then show");

  await atest("remember_address saves on a new person and shows the saved card", async () => {
    const r = await run("remember_address",
      { name: "Meera Nair", address: "12, 4th Cross, Jayanagar, Bengaluru 560011.", label: "house" },
      A, "remember Meera Nair's house address is 12, 4th Cross, Jayanagar, Bengaluru 560011");
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.speak, "Saved Meera Nair's home address.");
    assert.deepStrictEqual(r.data, { name: "Meera Nair", label: "home",
      address: "12, 4th Cross, Jayanagar, Bengaluru 560011.", created: true });
    assert.deepStrictEqual(Object.keys(r.deviceAction).sort(), CARD_KEYS, "no phone key when none is on file");
    assert.deepStrictEqual(r.deviceAction, { type: "show_address", name: "Meera Nair", label: "home",
      address: "12, 4th Cross, Jayanagar, Bengaluru 560011.", saved: true });
  });

  await atest("show_address by the exact name: the card, the data, and the address read out", async () => {
    const r = await run("show_address", { name: "meera nair" });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.data, { name: "Meera Nair", label: "home",
      address: "12, 4th Cross, Jayanagar, Bengaluru 560011.", others: [] });
    assert.deepStrictEqual(r.deviceAction, { type: "show_address", name: "Meera Nair", label: "home",
      address: "12, 4th Cross, Jayanagar, Bengaluru 560011.", saved: false });
    assert.strictEqual(r.speak,
      "Meera Nair's home address is 12, 4th Cross, Jayanagar, Bengaluru 5 6 0 0 1 1.", "the PIN digit by digit");
  });

  await atest("'Ravi' finds 'Ravi Kumar' (first name), on save and on show; his phone rides on the card", async () => {
    const p = await mem.upsertPerson(A, { name: "Ravi Kumar", relationship: "friend" });
    await db.run(`UPDATE clients SET phone='+919812345678' WHERE id=$1`, [p.id]);
    const s = await run("remember_address", { name: "Ravi", address: "No. 7, MG Road, Mysuru" }, A,
      "Ravi lives at No. 7, MG Road, Mysuru");
    assert.strictEqual(s.ok, true, JSON.stringify(s));
    assert.strictEqual(s.data.name, "Ravi Kumar", "saved on the person already on file");
    assert.strictEqual(s.data.created, false);
    assert.strictEqual(s.deviceAction.phone, "+919812345678");
    const n = (await db.one(`SELECT count(*)::int AS n FROM clients WHERE user_id=$1 AND lower(name) LIKE 'ravi%'`, [A])).n;
    assert.strictEqual(n, 1, "no second 'Ravi' was created");
    const r = await run("show_address", { name: "Ravi" });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.deviceAction, { type: "show_address", name: "Ravi Kumar", label: "home",
      address: "No. 7, MG Road, Mysuru", phone: "+919812345678", saved: false });
  });

  await atest("a misheard name finds the person (fuzzy) on show — but a save never guesses", async () => {
    await run("remember_address", { name: "Hemalatha", address: "45, 2nd Main, Vijayanagar, Mysuru 570017" }, A,
      "Hemalatha's address is 45, 2nd Main, Vijayanagar, Mysuru 570017");
    const r = await run("show_address", { name: "Hemalata" });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.data.name, "Hemalatha");
    assert.strictEqual(r.data.address, "45, 2nd Main, Vijayanagar, Mysuru 570017");
    // "Rani" is one letter from "Ravi": a write must not land on his page.
    const w = await run("remember_address", { name: "Rani", address: "3, Temple Street, Udupi" }, A,
      "Rani's address is 3, Temple Street, Udupi");
    assert.strictEqual(w.data.name, "Rani");
    assert.strictEqual(w.data.created, true);
    assert.strictEqual((await run("show_address", { name: "Ravi" })).data.address, "No. 7, MG Road, Mysuru");
  });

  console.log("\nLabels");

  await atest("home and office are kept apart; the label asked for wins; no label = the newest", async () => {
    await run("remember_address", { name: "Ravi Kumar", address: "Infosys Gate 2, Hebbal, Mysuru", label: "Office" }, A,
      "note down Ravi Kumar's office address Infosys Gate 2 Hebbal Mysuru");
    const office = await run("show_address", { name: "Ravi", label: "work" });
    assert.strictEqual(office.data.label, "office", "'work' is the office");
    assert.strictEqual(office.data.address, "Infosys Gate 2, Hebbal, Mysuru");
    assert.deepStrictEqual(office.data.others, [{ label: "home", address: "No. 7, MG Road, Mysuru" }]);
    assert.match(office.speak, /^Ravi Kumar's office address is Infosys Gate 2, Hebbal, Mysuru\. I also have the home address\.$/);
    const home = await run("show_address", { name: "Ravi", label: "house" });
    assert.strictEqual(home.data.label, "home", "'house' is home");
    assert.strictEqual(home.data.address, "No. 7, MG Road, Mysuru");
    const newest = await run("show_address", { name: "Ravi" });
    assert.strictEqual(newest.data.label, "office", "no label: the most recent");
    const shop = await run("show_address", { name: "Ravi", label: "shop" });
    assert.strictEqual(shop.ok, true);
    assert.match(shop.speak, /^I don't have Ravi Kumar's shop address — the office address is /);
  });

  await atest("a new address for the same label replaces the old one", async () => {
    await run("remember_address", { name: "Ravi", address: "22, 1st Main, Kuvempunagar, Mysuru", label: "home" }, A,
      "Ravi moved, his home address is 22, 1st Main, Kuvempunagar, Mysuru");
    const rows = await db.query(
      `SELECT pa.label, pa.address FROM person_addresses pa JOIN clients c ON c.id=pa.person_id
        WHERE pa.user_id=$1 AND c.name='Ravi Kumar' ORDER BY pa.label`, [A]);
    assert.deepStrictEqual(rows.map((r) => [r.label, r.address]),
      [["home", "22, 1st Main, Kuvempunagar, Mysuru"], ["office", "Infosys Gate 2, Hebbal, Mysuru"]]);
  });

  console.log("\nLookup, legacy, missing, isolation");

  await atest("lookup_person includes the addresses", async () => {
    const r = await run("lookup_person", { name: "Ravi" });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.data.addresses.map((a) => a.label).sort(), ["home", "office"]);
    assert.ok(r.data.addresses.some((a) => a.address === "22, 1st Main, Kuvempunagar, Mysuru"));
  });

  await atest("legacy: an address told before today, in a note, is found as 'saved note'", async () => {
    await run("add_person_note", { name: "Suresh", note: "Owes me ₹150000 for the car" }, A, "Suresh owes me 150000 for the car");
    await run("add_person_note", { name: "Suresh", note: "House address is #18, 3rd Cross, Gokulam, Mysuru." }, A,
      "Suresh's house address is #18, 3rd Cross, Gokulam, Mysuru");
    await run("add_person_note", { name: "Suresh", note: "Likes filter coffee" }, A, "Suresh likes filter coffee");
    const r = await run("show_address", { name: "Suresh" });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.data.label, "saved note");
    assert.strictEqual(r.data.address, "#18, 3rd Cross, Gokulam, Mysuru");
    assert.strictEqual(r.deviceAction.label, "saved note");
    assert.match(r.speak, /^Here's what I have for Suresh's address: #18, 3rd Cross, Gokulam, Mysuru\.$/);
  });

  await atest("legacy: a fact saved with no person linked still counts when it names them", async () => {
    await mem.remember(A, { fact: "Kiran's address is 9, Lake Road, Kodagu 571201", embedding: [0] });
    await mem.upsertPerson(A, { name: "Kiran" });
    const r = await run("show_address", { name: "Kiran" });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.data.address, "9, Lake Road, Kodagu 571201");
  });

  await atest("a money note is not an address; nothing saved is ok:false with words to say", async () => {
    await run("add_person_note", { name: "Mohan", note: "Owes me 250000" }, A, "Mohan owes me 250000");
    const r = await run("show_address", { name: "Mohan" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "I don't have Mohan's address yet — tell me and I'll save it.");
    assert.strictEqual(r.deviceAction, undefined, "no card without an address");
    const nobody = await run("show_address", { name: "Zebediah" });
    assert.strictEqual(nobody.ok, false);
    assert.match(nobody.error, /I don't have Zebediah's address yet/);
  });

  await atest("another user sees none of it", async () => {
    const r = await run("show_address", { name: "Ravi" }, B);
    assert.strictEqual(r.ok, false);
    assert.strictEqual((await mem.addressesFor(B, 1)).length, 0);
  });

  await atest("missing arguments are asked for, not guessed", async () => {
    const r = await run("remember_address", { name: "Ravi", address: " " }, A, "remember Ravi's address");
    assert.strictEqual(r.ok, false);
  });

  console.log("\nWiring");

  await atest("GATE 0: 'remember that' is honoured; an unrelated turn cannot write an address", async () => {
    const ok = await run("remember_address", { name: "Latha", address: "5, Temple Road, Karkala" }, A, "remember that");
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    const no = await run("remember_address", { name: "Latha", address: "5, Temple Road, Karkala" }, A,
      "what's the weather tomorrow");
    assert.strictEqual(no.ok, false);
    assert.strictEqual(no.error, "not_in_this_turn");
  });

  await atest("claim families: remember_address records, show_address opens", () => {
    const { FAMILIES } = require("../src/agents/claimCheck");
    const fam = (id) => FAMILIES.find((f) => f.id === id).tools;
    assert.ok(fam("record").includes("remember_address"));
    assert.ok(fam("open").includes("show_address"));
  });

  await atest("the Live set holds both, right after remember_fact/recall_memory, within LIVE_MAX = 40", () => {
    const live = require("../src/ai/liveTools");
    assert.strictEqual(live.LIVE_MAX, 40);
    const i = live.LIVE_ORDER.indexOf("recall_memory");
    assert.deepStrictEqual(live.LIVE_ORDER.slice(i - 1, i + 3),
      ["remember_fact", "recall_memory", "remember_address", "show_address"]);
    const names = live.liveNames(registry.list(), { must: ["run_shortcut", "continue_shortcut"] });
    const decls = live.capDeclarations(names.map((name) => ({ name })), names);
    const got = decls.map((d) => d.name);
    assert.ok(got.includes("remember_address") && got.includes("show_address"), got.join(","));
  });

  await atest("the phone's per-turn pick carries both when the words say address — even past a full carried set", () => {
    const rel = require("../src/tools/relevance");
    const all = registry.list();
    const sid = `addr-${stamp}`;
    // A busy earlier turn fills the carried set.
    rel.selectForPhone(all, "set an alarm for 6 am tomorrow and remind me to call the bank and order biryani", { sessionId: sid });
    for (const said of ["what's Ravi's address?", "where does Ravi live", "remember that",
      "note down Ravi's office address", "Ravi lives at 12 MG Road", "save this address for Amma"]) {
      const picked = rel.selectForPhone(all, said, { sessionId: sid });
      assert.ok(picked.includes("show_address") && picked.includes("remember_address"), `"${said}": ${picked.length} tools`);
      assert.ok(picked.length <= rel.PHONE_MAX);
      assert.ok(picked.includes("web_search"), "the core set kept");
    }
    const plain = rel.selectForPhone(all, "hmm okay", { sessionId: `addr2-${stamp}` });
    assert.ok(!plain.includes("show_address"), "not on every turn — CORE stays small");
    assert.ok(!rel.CORE.has("show_address") && !rel.CORE.has("remember_address"));
  });


  await atest("the tool descriptions steer addresses to the address tools", () => {
    for (const n of ["remember_fact", "add_person_note", "remember_person"]) {
      assert.match(registry.get(n).description, /remember_address/, n);
    }
    assert.match(registry.get("lookup_person").description, /show_address/);
    assert.deepStrictEqual(registry.get("remember_address").inputSchema.required, ["name", "address"]);
    assert.deepStrictEqual(registry.get("show_address").inputSchema.required, ["name"]);
  });

  console.log("\nAccount deletion");

  await atest("deleting the account removes the address rows", async () => {
    const before = (await db.one(`SELECT count(*)::int AS n FROM person_addresses WHERE user_id=$1`, [A])).n;
    assert.ok(before >= 5, `${before} rows`);
    assert.ok(privacy.USER_TABLES.some(([t, c]) => t === "person_addresses" && c === "user_id"));
    await privacy.deleteUserEverywhere(A, { reason: "address-memory-test" });
    const after = (await db.one(`SELECT count(*)::int AS n FROM person_addresses WHERE user_id=$1`, [A])).n;
    assert.strictEqual(after, 0);
  });

  await atest("no request left the machine", () => {
    assert.deepStrictEqual(blocked.filter((u) => !/embed/i.test(u)), []);
  });

  try {
    await privacy.deleteUserEverywhere(B, { reason: "address-memory-test" });
  } catch (_) {}
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
