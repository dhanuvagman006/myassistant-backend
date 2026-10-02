/**
 * SHOW A PICTURE OF A PARTICULAR PERSON — `npm run test:pictures`.
 *
 * The client, 2026-10-01 (feedback #15): "show me K.P. Jagadish Adhikari
 * from Moodabidri" showed a stranger. These pin: a named person's query
 * is quoted with the place beside it, a result counts only when it
 * carries the name, and when none does the finder says "unsure" rather
 * than handing over the first face.
 */
process.env.BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY || "test-key";
const assert = require("assert");
// The image download goes through safeFetch; stub it before the module binds it.
const sf = require("../src/services/safeFetch");
let imageFor = () => null;
sf.safeFetch = async (url) => {
  const bytes = imageFor(String(url));
  if (!bytes) return { ok: false, status: 404, headers: { get: () => "" } };
  let sent = false;
  return {
    ok: true, status: 200,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? "image/jpeg" : "") },
    body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes })), cancel: async () => {} }) },
  };
};
const P = require("../src/tools/pictures");

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

(async () => {
  await check("a named person is searched in quotes, with the place", () => {
    assert.strictEqual(P.searchQuery("K.P. Jagadish Adhikari from Moodabidri"), '"K.P. Jagadish Adhikari" Moodabidri');
    assert.strictEqual(P.searchQuery("Virat Kohli"), '"Virat Kohli"');
    assert.strictEqual(P.searchQuery("golden retriever"), "golden retriever");
    assert.strictEqual(P.searchQuery("the Taj Mahal"), "the Taj Mahal");
  });

  await check("who looks like a particular person", () => {
    assert.strictEqual(P.looksLikePerson("K.P. Jagadish Adhikari from Moodabidri"), true);
    assert.strictEqual(P.looksLikePerson("Rashmika Mandanna"), true);
    assert.strictEqual(P.looksLikePerson("a golden retriever"), false);
    assert.strictEqual(P.looksLikePerson("Moodabidri"), false);
  });

  await check("a result counts only when it carries the name", () => {
    const subj = "K.P. Jagadish Adhikari from Moodabidri";
    assert.strictEqual(P.nameMatch(subj, { title: "Jagadish Adhikari felicitated at Moodabidri", page: "https://x.in/news/1" }), true);
    assert.strictEqual(P.nameMatch(subj, { title: "", page: "https://site.in/people/jagadish-adhikari-profile" }), true);
    assert.strictEqual(P.nameMatch(subj, { title: "Moodabidri temple festival", page: "https://x.in/a" }), false);
    assert.strictEqual(P.nameMatch(subj, { title: "Adhikari family reunion", page: "https://x.in/b" }), false);
    // Anything goes for a thing or a place.
    assert.strictEqual(P.nameMatch("golden retriever", { title: "cute dog", page: "" }), true);
  });

  await check("no result tied to the name → unsure, never a stranger", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (/api\.search\.brave\.com/.test(String(url))) {
        return { ok: true, json: async () => ({ results: [
          { title: "Temple festival at Moodabidri", url: "https://x.in/fest", properties: { url: "https://img.x.in/1.jpg" } },
          { title: "Local news", url: "https://x.in/news", properties: { url: "https://img.x.in/2.jpg" } },
        ] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    try {
      await assert.rejects(P.findPicture("K.P. Jagadish Adhikari from Moodabidri"), (e) => e.code === "unsure");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await check("a matching result is fetched and returned", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (/api\.search\.brave\.com/.test(String(url))) {
        return { ok: true, json: async () => ({ results: [
          { title: "Temple festival", url: "https://x.in/fest", properties: { url: "https://img.x.in/1.jpg" } },
          { title: "Jagadish Adhikari, Moodabidri", url: "https://x.in/ja", properties: { url: "https://img.x.in/2.jpg" } },
        ] }) };
      }
      return { ok: false, status: 404, headers: { get: () => "" }, json: async () => ({}) };
    };
    imageFor = (url) => (url === "https://img.x.in/2.jpg" ? new Uint8Array(5000) : null);
    try {
      const pic = await P.findPicture("K.P. Jagadish Adhikari from Moodabidri");
      assert.ok(pic, "a picture");
      assert.strictEqual(pic.url, "https://img.x.in/2.jpg");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await check("several pictures: only the person's, the same photo once, full-size before thumbnails", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (/api\.search\.brave\.com/.test(String(url))) {
        return { ok: true, json: async () => ({ results: [
          { title: "Virat Kohli thumbnail", url: "https://a.in/t", properties: { url: "https://img.in/thumb.jpg" } },
          { title: "Virat Kohli at the nets", url: "https://a.in/1", properties: { url: "https://img.in/1.jpg" } },
          { title: "Someone else entirely", url: "https://a.in/x", properties: { url: "https://img.in/x.jpg" } },
          { title: "Virat Kohli celebrates", url: "https://a.in/2", properties: { url: "https://img.in/2.jpg" } },
          { title: "Virat Kohli (same photo, other site)", url: "https://b.in/2", properties: { url: "https://img.in/2-copy.jpg" } },
          { title: "Virat Kohli portrait", url: "https://a.in/3", properties: { url: "https://img.in/3.jpg" } },
        ] }) };
      }
      return { ok: false, status: 404, headers: { get: () => "" }, json: async () => ({}) };
    };
    const big = (n) => new Uint8Array(20_000).fill(n);
    imageFor = (url) => ({
      "https://img.in/thumb.jpg": new Uint8Array(6000).fill(9),
      "https://img.in/1.jpg": big(1), "https://img.in/2.jpg": big(2), "https://img.in/2-copy.jpg": big(2),
      "https://img.in/3.jpg": big(3), "https://img.in/x.jpg": big(7),
    })[url] || null;
    try {
      const got = await P.findPictures("Virat Kohli", 6);
      assert.deepStrictEqual(got.map((g) => g.url), ["https://img.in/1.jpg", "https://img.in/2.jpg", "https://img.in/3.jpg", "https://img.in/thumb.jpg"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
