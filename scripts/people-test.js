/**
 * WHO THEY MEANT — `node scripts/people-test.js`.
 *
 * "Follow Neha Shetty actor" must find her own verified account, not the
 * first lookalike an in-app search turns up (2026-09-24: the run followed
 * @neha_shetty_actor; hers is @iamnehashetty). No network: search results
 * are scripted in the shapes the real providers return.
 */
const assert = require("assert");
const people = require("../src/automation/people");

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
}

const IG = (handle, title, snippet = "") => ({ title, snippet, url: `https://www.instagram.com/${handle}/` });
const nehaResults = [
  IG("iamnehashetty", "Neha Shetty (@iamnehashetty) • Instagram photos and videos",
    "1.4M Followers, 312 Following, 890 Posts - See Instagram photos and videos from Neha Shetty"),
  IG("neha_shetty_actor", "neha_shetty_actor • Instagram photos and videos", "12K Followers"),
  IG("nehashetty_fans", "Neha Shetty Fans (@nehashetty_fans)", "fan page"),
  { title: "Neha Shetty - Wikipedia", snippet: "Indian actress who appears in Telugu films", url: "https://en.wikipedia.org/wiki/Neha_Shetty" },
];
const search = (results) => async () => ({ ok: true, provider: "brave", data: results });

(async () => {
  await t("the person is read from the owner's words, descriptors kept apart", () => {
    assert.deepStrictEqual(people.personIn("Open Instagram and follow Neha Shetty actor"),
      { name: "Neha Shetty", hint: "actor" });
    assert.deepStrictEqual(people.personIn("follow virat kohli on instagram"), { name: "virat kohli", hint: "" });
    assert.deepStrictEqual(people.personIn("subscribe to MrBeast on youtube"), { name: "MrBeast", hint: "" });
    assert.strictEqual(people.personIn("follow Neha Shetty and like her last post").name, "Neha Shetty");
    assert.strictEqual(people.personIn("order biryani on swiggy"), null);
    assert.strictEqual(people.personIn("follow the latest post"), null);
  });

  await t("Neha Shetty: her verified profile wins over the lookalike and the fan page", async () => {
    const r = await people.resolveAccount("instagram", "Open Instagram and follow Neha Shetty actor",
      { search: search(nehaResults) });
    assert.strictEqual(r.handle, "iamnehashetty");
    assert.strictEqual(r.confident, true);
    assert.ok(!r.alternatives.includes("nehashetty_fans"), "fan pages are never offered");
    assert.strictEqual(r.openUrl, "", "Instagram profile links open a blank page — search the handle instead");
    assert.match(r.query, /Neha Shetty actor official Instagram account/);
  });

  await t("the handle is also read from titles and snippets (grounded search has no profile URL)", async () => {
    const r = await people.resolveAccount("instagram", "follow neha shetty", { search: search([
      { title: "Neha Shetty (@iamnehashetty) • Instagram photos and videos", snippet: "", url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc" },
    ]) });
    assert.strictEqual(r.handle, "iamnehashetty");
  });

  await t("YouTube and X open the profile itself", async () => {
    const yt = await people.resolveAccount("youtube", "subscribe to MrBeast on youtube", { search: search([
      { title: "MrBeast - YouTube", snippet: "", url: "https://www.youtube.com/@MrBeast" },
      { title: "MrBeast Gaming", snippet: "", url: "https://www.youtube.com/@MrBeastGaming" },
    ]) });
    assert.strictEqual(yt.handle, "MrBeast");
    assert.strictEqual(yt.openUrl, "https://www.youtube.com/@MrBeast");
    const x = await people.resolveAccount("twitter", "follow virat kohli on twitter", { search: search([
      { title: "Virat Kohli (@imVkohli) / X", snippet: "", url: "https://x.com/imVkohli" },
    ]) });
    assert.strictEqual(x.openUrl, "https://x.com/imVkohli");
  });

  await t("nothing convincing, an encyclopedia fallback, an outage or a slow search -> null (search in the app)", async () => {
    assert.strictEqual(await people.resolveAccount("instagram", "follow neha shetty",
      { search: search([{ title: "Some blog", snippet: "", url: "https://example.com/x" }]) }), null);
    assert.strictEqual(await people.resolveAccount("instagram", "follow neha shetty",
      { search: async () => ({ ok: true, provider: "wikipedia", data: nehaResults }) }), null);
    assert.strictEqual(await people.resolveAccount("instagram", "follow neha shetty",
      { search: async () => ({ ok: false, error: "rate limit" }) }), null);
    assert.strictEqual(await people.resolveAccount("instagram", "follow neha shetty",
      { search: () => new Promise(() => {}), timeoutMs: 50 }), null);
    assert.strictEqual(await people.resolveAccount("swiggy", "follow neha shetty", { search: search(nehaResults) }), null);
  });

  await t("two close strong candidates are not 'confident' — the planner decides in the app", async () => {
    const r = await people.resolveAccount("instagram", "follow rahul sharma", { search: search([
      IG("rahulsharma", "Rahul Sharma • Instagram photos and videos"),
      IG("rahul.sharma", "Rahul Sharma • Instagram photos and videos"),
    ]) });
    assert.strictEqual(r.confident, false);
    assert.deepStrictEqual(r.alternatives, ["rahul.sharma"]);
  });

  await t("reserved paths are never handles", () => {
    const c = people.candidates(people.SITES.instagram, [
      { title: "x", snippet: "", url: "https://www.instagram.com/p/Cabc123/" },
      { title: "y", snippet: "", url: "https://www.instagram.com/reel/xyz/" },
      { title: "z", snippet: "", url: "https://www.instagram.com/explore/tags/neha/" },
    ]);
    assert.deepStrictEqual(c, []);
  });

  console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
})();
