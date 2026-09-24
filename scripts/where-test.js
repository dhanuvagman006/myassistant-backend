/**
 * WHERE THE OWNER IS — `node scripts/where-test.js`.
 *
 * A client in Bengaluru asked for the Lalit near the golf club and was
 * given a resort in Goa (2026-09-24). Every local search must carry the
 * owner's city, results naming another city must not be offered as
 * "near", and the model must be told the city up front. No network: the
 * geocoder and the search are scripted.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@127.0.0.1:55432/myassistant";
const assert = require("assert");
const geo = require("../src/users/whereNow");

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
}

(async () => {
  const builtins = require("../src/tools/builtins");
  const registry = require("../src/tools/registry");
  builtins.registerBuiltins();
  // Scripted geocoder and search.
  builtins.reverseGeocode = async () => ({ address: "Koramangala, Bengaluru, Karnataka", area: "Koramangala", city: "Bengaluru" });
  const webSearch = require("../src/tools/webSearch");
  const asked = [];
  webSearch.run = async (q) => {
    asked.push(q);
    return { ok: true, provider: "brave", data: [
      { title: "The LaLiT Golf & Spa Resort Goa", snippet: "Canacona, South Goa", url: "https://www.thelalit.com/the-lalit-goa/" },
      { title: "The LaLiT Ashok Bangalore", snippet: "Kumara Krupa High Grounds, next to the Bangalore Golf Club", url: "https://www.thelalit.com/the-lalit-ashok-bangalore/" },
    ] };
  };

  await t("another city is told apart from the owner's own", () => {
    assert.strictEqual(geo.namesOtherCity("The LaLiT Golf & Spa Resort Goa", "Bengaluru"), true);
    assert.strictEqual(geo.namesOtherCity("The LaLiT Ashok Bangalore", "Bengaluru"), false, "Bangalore is Bengaluru");
    assert.strictEqual(geo.namesOtherCity("Lalit Ashok, Kumara Krupa Road", "Bengaluru"), false, "no city named at all");
    assert.strictEqual(geo.namesAPlace("lalit hotel in goa"), true);
    assert.strictEqual(geo.namesAPlace("lalit hotel near golf club"), false);
  });

  await t("the model is told where the owner is, area and city", async () => {
    const line = await geo.whereLine(12.9352, 77.6245);
    assert.match(line, /WHERE THE OWNER IS NOW: Koramangala, Bengaluru/);
    assert.match(line, /never ask\s+which city/);
    assert.strictEqual(await geo.whereLine(null, null), "");
  });

  await t("REGRESSION: 'Lalit Hotel near golf club' in Bengaluru never answers with Goa", async () => {
    asked.length = 0;
    const r = await registry.get("find_places_nearby").execute(
      { query: "Lalit Hotel near golf club", open_map: false }, { userId: 1, lat: 12.9352, lng: 77.6245 });
    assert.match(asked[0], /Lalit Hotel near golf club in Koramangala, Bengaluru/);
    const names = r.data.places.map((p) => p.name).join(" | ");
    assert.ok(!/goa/i.test(names), `Goa must not be offered: ${names}`);
    assert.ok(/ashok/i.test(names), names);
    assert.ok(!/goa/i.test(r.speak));
  });

  await t("asking for another city on purpose still gets that city", async () => {
    asked.length = 0;
    await registry.get("find_places_nearby").execute(
      { query: "lalit hotel in goa", open_map: false }, { userId: 1, lat: 12.9352, lng: 77.6245 });
    assert.strictEqual(asked[0], "lalit hotel in goa");
  });

  await t("web_search: a named place's address is searched in the owner's city", async () => {
    asked.length = 0;
    await registry.get("web_search").execute({ query: "Lalit Ashok address" }, { lat: 12.9352, lng: 77.6245 });
    assert.strictEqual(asked[0], "Lalit Ashok address Bengaluru");
    asked.length = 0;
    await registry.get("web_search").execute({ query: "who won the match yesterday" }, { lat: 12.9352, lng: 77.6245 });
    assert.strictEqual(asked[0], "who won the match yesterday", "non-local questions are left alone");
    asked.length = 0;
    await registry.get("web_search").execute({ query: "Lalit Ashok Mumbai address" }, { lat: 12.9352, lng: 77.6245 });
    assert.strictEqual(asked[0], "Lalit Ashok Mumbai address", "a place they named wins");
  });

  console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})();
