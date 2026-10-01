/**
 * FIGURES OUT OF PAGES — `npm run test:pagetext`.
 *
 * The owner, 2026-10-01: flight timings were searched three times and
 * then handed to Google. Pins: a question that wants figures is
 * recognised, snippets without a figure trigger a read of the top pages,
 * the page's figure-bearing lines come back with the site, and a page
 * that is not HTML or has no figures is left out.
 */
const assert = require("assert");
// The page read goes through safeFetch; stub it before webSearch binds it.
const sf = require("../src/services/safeFetch");
const pages = {};
sf.safeFetch = async (url) => {
  const p = pages[String(url)];
  if (!p) return { ok: false, status: 404, headers: { get: () => "" }, text: async () => "" };
  return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === "content-type" ? p.type : "") }, text: async () => p.body };
};
const pt = require("../src/tools/pageText");
const ws = require("../src/tools/webSearch");

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

(async () => {
  await check("questions that want figures are recognised", () => {
    for (const q of ["what is the flight timings from mangalore to bangalore", "how much is the Ola fare to the airport",
      "when does Lulu mall open", "train schedule Mysore to Bangalore", "Bangalore se Lucknow flight ka price kitna hai"]) {
      assert.strictEqual(pt.wantsFigures(q), true, q);
    }
    for (const q of ["who is Devi Shetty", "show me a picture of Virat Kohli", "what is new in technology"]) {
      assert.strictEqual(pt.wantsFigures(q), false, q);
    }
  });

  await check("timetables and routes prefer the settled page; today's rates and news keep the day filter", () => {
    for (const q of ["flight timings from Mangalore to Bangalore tomorrow", "train schedule Mysore to Bangalore", "Mangalore to Bangalore flights",
      "when does Lulu mall open, what are the hours"]) assert.strictEqual(pt.prefersStablePages(q), true, q);
    for (const q of ["gold rate today in Bangalore", "what's the news", "India vs Australia score"]) assert.strictEqual(pt.prefersStablePages(q), false, q);
  });

  await check("snippets with a time, a price or a duration already answer", () => {
    assert.strictEqual(pt.hasFigures([{ title: "IndiGo 6E 123", snippet: "departs 06:45, arrives 07:55" }]), true);
    assert.strictEqual(pt.hasFigures([{ title: "Fares", snippet: "from ₹2,499 one way" }]), true);
    assert.strictEqual(pt.hasFigures([{ title: "Flights Mangalore to Bangalore", snippet: "Book cheap flights with us. Best deals." }]), false);
  });

  await check("the lines that carry figures come out of a page, nothing else", () => {
    const html = `<html><head><title>x</title><script>var a=1;</script></head><body>
      <nav>Home | Flights</nav>
      <h1>Mangalore to Bangalore flights</h1>
      <p>Book with confidence.</p>
      <div class="row">IndiGo 6E 7281 &nbsp; 06:45 &rarr; 07:55 &nbsp; 1h 10m &nbsp; ₹3,120</div>
      <div class="row">Air India Express IX 1341 &nbsp; 7 pm &rarr; 8:05 pm</div>
      <div>Terms apply.</div>
      <footer>© 2026</footer></body></html>`;
    const lines = pt.figureLines(pt.extractReadableText(html));
    assert.strictEqual(lines.length, 2);
    assert.match(lines[0], /06:45/);
    assert.match(lines[0], /₹3,120/);
    assert.match(lines[1], /7 pm/);
    assert.ok(!lines.join(" ").includes("Terms apply"));
    assert.ok(!lines.join(" ").includes("Home | Flights"));
  });

  await check("deepRead returns the top pages' figure lines with their site; non-HTML and figure-less pages are left out", async () => {
    pages["https://www.ixigo.com/flights/ixe-blr"] = { type: "text/html; charset=utf-8",
      body: "<html><body><div>6E 7281 06:45 - 07:55</div><div>IX 1341 19:00 - 20:05</div><div>Book now</div></body></html>" };
    pages["https://x.in/schedule.pdf"] = { type: "application/pdf", body: "%PDF" };
    pages["https://y.in/about"] = { type: "text/html", body: "<html><body><p>We love flying.</p></body></html>" };
    const out = await ws.deepRead([
      { title: "ixigo", url: "https://www.ixigo.com/flights/ixe-blr", snippet: "" },
      { title: "pdf", url: "https://x.in/schedule.pdf", snippet: "" },
      { title: "about", url: "https://y.in/about", snippet: "" },
    ], { max: 3 });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].site, "ixigo.com");
    assert.deepStrictEqual(out[0].lines, ["6E 7281 06:45 - 07:55", "IX 1341 19:00 - 20:05"]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
