/**
 * CALENDAR EXTRAS (2026-09-30) — `node scripts/calendar-extras-test.js`.
 *
 * Pins GET /tools/calendar/extras and its service: the curated data is
 * well-formed and its weekdays are right, Kerala vs national rules, world
 * days and events, the optional Google ICS (once a day, stale copy kept, a
 * failure never shows), and the route's 400s. No database, no network:
 * every fetch is a stub.
 */
const assert = require("assert");
const express = require("express");
const path = require("path");
const fs = require("fs");

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

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url && url.url ? url.url : url);
  if (/^http:\/\/127\.0\.0\.1[:/]/.test(u)) return realFetch(url, opts);
  throw new Error(`blocked in test: ${u}`);
};

const cx = require("../src/services/tools/calendarExtras");
const india = require("../src/services/tools/calendar-data/india.json");
const world = require("../src/services/tools/calendar-data/world.json");

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const wd = (s) => WD[new Date(`${s}T00:00:00Z`).getUTCDay()];
const reset = () => {
  cx._ics.events = null;
  cx._ics.fetchedAt = 0;
  cx._ics.failedAt = 0;
  cx._cache.clear();
};
const find = (r, date, re) => r.items.find((i) => i.date === date && re.test(i.title));

const ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260826", "SUMMARY:Onam", "DESCRIPTION:Observance\\nTo hide", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260914", "SUMMARY:Ganesh Chaturthi", "DESCRIPTION:Observance", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260823", "SUMMARY:Test Obs", "DESCRIPTION:Observance", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260815", "SUMMARY:Independence Day", "DESCRIPTION:Public holiday", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260414", "SUMMARY:Vishu", "DESCRIPTION:Observance", "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

(async () => {
  // ── data ──────────────────────────────────────────────────────────
  await atest("every curated row is well-formed", () => {
    const kinds = new Set(["holiday", "festival", "event", "world_day"]);
    for (const r of india.items) {
      assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, JSON.stringify(r));
      assert.ok(!Number.isNaN(Date.parse(r.date)), r.date);
      assert.ok(kinds.has(r.kind), r.kind);
      assert.ok(["national", "IN-KL"].includes(r.scope), r.scope);
      assert.ok(r.title && r.title.length <= 60, r.title);
    }
    for (const r of [...india.recurring, ...world.recurring]) assert.match(r.md, /^\d{2}-\d{2}$/);
    for (const e of world.events) assert.ok(!e.end || e.end >= e.date, e.title);
    assert.ok(world.recurring.length >= 25, "about 25 world days");
  });

  await atest("key dates fall on the official weekdays", () => {
    const want = {
      "2026-01-26": "Mon", "2026-03-04": "Wed", "2026-03-20": "Fri", "2026-04-03": "Fri",
      "2026-04-15": "Wed", "2026-08-26": "Wed", "2026-09-04": "Fri", "2026-10-21": "Wed",
      "2026-11-08": "Sun", "2026-12-25": "Fri", "2027-01-26": "Tue", "2027-03-10": "Wed",
      "2027-03-23": "Tue", "2027-04-15": "Thu", "2027-09-12": "Sun", "2027-10-29": "Fri",
      "2027-12-25": "Sat",
    };
    for (const [d, w] of Object.entries(want)) assert.strictEqual(wd(d), w, d);
    const dates = new Set(india.items.map((r) => r.date));
    for (const d of Object.keys(want)) assert.ok(dates.has(d), `curated lacks ${d}`);
  });

  await atest("every Kerala 2027 row is tentative (list not yet notified)", () => {
    for (const r of india.items) {
      if (r.scope === "IN-KL" && r.kind === "holiday" && r.date.startsWith("2027")) assert.ok(r.tentative, r.title);
    }
  });

  // ── ranges and region ─────────────────────────────────────────────
  await atest("parseRange: month, from/to, limits", () => {
    assert.deepStrictEqual(cx.parseRange({ y: "2026", m: "2" }), { from: "2026-02-01", to: "2026-02-28" });
    assert.deepStrictEqual(cx.parseRange({ y: 2028, m: 2 }), { from: "2028-02-01", to: "2028-02-29" });
    assert.deepStrictEqual(cx.parseRange({ from: "2026-10-01", to: "2026-12-31" }), { from: "2026-10-01", to: "2026-12-31" });
    assert.ok(cx.parseRange({ from: "2026-10-01", to: "2027-01-02" }).error, "94 days refused");
    assert.ok(cx.parseRange({ from: "2026-02-30", to: "2026-03-01" }).error, "impossible date");
    assert.ok(cx.parseRange({ from: "2026-10-05", to: "2026-10-01" }).error, "backwards");
    assert.ok(cx.parseRange({ y: 2026, m: 13 }).error);
    assert.deepStrictEqual(cx.parseRange({ from: "2026-10-02" }), { from: "2026-10-02", to: "2026-10-02" });
  });

  await atest("region: query, then geo, then Kerala", () => {
    const req = (query, h = {}) => ({ query, get: (k) => h[k] });
    assert.strictEqual(cx.resolveRegion(req({ region: "in" })), "IN");
    assert.strictEqual(cx.resolveRegion(req({ region: "KL" })), "IN-KL");
    assert.strictEqual(cx.resolveRegion(req({}, { "X-Geo-Lat": "9.93", "X-Geo-Lng": "76.26" })), "IN-KL"); // Kochi
    assert.strictEqual(cx.resolveRegion(req({}, { "X-Geo-Lat": "19.07", "X-Geo-Lng": "72.88" })), "IN"); // Mumbai
    assert.strictEqual(cx.resolveRegion(req({ region: "bogus" })), "IN-KL");
  });

  // ── the rules ─────────────────────────────────────────────────────
  await atest("Kerala sees its own Eid date and Holi as a working-day festival", async () => {
    reset();
    const kl = await cx.extras({ from: "2026-03-01", to: "2026-03-31", region: "IN-KL", useIcs: false });
    assert.ok(find(kl, "2026-03-20", /Eid/), "Kerala Eid on the 20th");
    assert.ok(!find(kl, "2026-03-21", /Eid/), "not the central 21st");
    const holi = find(kl, "2026-03-04", /Holi/);
    assert.strictEqual(holi.kind, "festival");
    assert.match(holi.note, /working day in Kerala/);
    assert.strictEqual(holi.bank, false);
    const nat = await cx.extras({ from: "2026-03-01", to: "2026-03-31", region: "IN", useIcs: false });
    assert.ok(find(nat, "2026-03-21", /Eid/) && !find(nat, "2026-03-20", /Eid/));
    assert.strictEqual(find(nat, "2026-03-04", /Holi/).kind, "holiday");
    assert.ok(nat.items.every((i) => i.bank === false), "bank flag only for Kerala");
  });

  await atest("Onam in Kerala: four days, bank holidays; Shivaratri upgraded", async () => {
    const kl = await cx.extras({ from: "2026-08-01", to: "2026-08-31", region: "IN-KL", useIcs: false });
    for (const d of ["2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"]) {
      assert.ok(kl.items.some((i) => i.date === d && i.kind === "holiday" && i.bank), d);
    }
    assert.ok(!find(kl, "2026-08-26", /Milad-un-Nabi/), "central Milad hidden in Kerala");
    const feb = await cx.extras({ from: "2026-02-01", to: "2026-02-28", region: "IN-KL", useIcs: false });
    assert.strictEqual(find(feb, "2026-02-15", /Shivaratri/).kind, "holiday");
    const febIn = await cx.extras({ from: "2026-02-01", to: "2026-02-28", region: "IN", useIcs: false });
    assert.strictEqual(find(febIn, "2026-02-15", /Shivaratri/).kind, "festival");
  });

  await atest("world days, nth-weekday days, business dates and overlapping events", async () => {
    assert.strictEqual(cx.nthWeekday(2026, 5, 2, 7), "2026-05-10");
    assert.strictEqual(cx.nthWeekday(2027, 6, 3, 7), "2027-06-20");
    const oct = await cx.extras({ from: "2026-10-01", to: "2026-10-31", region: "IN-KL", useIcs: false });
    assert.ok(find(oct, "2026-10-24", /United Nations Day/).kind === "world_day");
    const games = oct.items.find((i) => /Asian Games/.test(i.title));
    assert.ok(games && games.date === "2026-09-19" && games.end === "2026-10-04", "event overlapping the window");
    const may = await cx.extras({ from: "2026-05-01", to: "2026-05-31", region: "IN", useIcs: false });
    assert.ok(find(may, "2026-05-10", /Mother's Day/));
    const sep = await cx.extras({ from: "2026-09-01", to: "2026-09-30", region: "IN-KL", useIcs: false });
    assert.strictEqual(find(sep, "2026-09-15", /Advance tax/).kind, "event");
    // Sorted by date, holidays first on a day.
    const dates = sep.items.map((i) => i.date);
    assert.deepStrictEqual(dates, [...dates].sort());
    // Every item has the documented shape.
    for (const i of [...oct.items, ...sep.items]) {
      assert.deepStrictEqual(
        Object.keys(i).filter((k) => k !== "end").sort(),
        ["bank", "date", "kind", "note", "scope", "source", "tentative", "title"]
      );
    }
  });

  await atest("a window across the new year gets both years' rows", async () => {
    const r = await cx.extras({ from: "2026-12-20", to: "2027-01-31", region: "IN-KL", useIcs: false });
    assert.ok(find(r, "2026-12-25", /Christmas/) && find(r, "2027-01-26", /Republic/));
    assert.ok(find(r, "2027-01-01", /New Year/) && find(r, "2026-12-31", /New Year's Eve/));
  });

  // ── Google ICS ────────────────────────────────────────────────────
  await atest("ICS adds only missing observances; dedupes Onam/Vishu/holidays", async () => {
    reset();
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: true, status: 200, text: async () => ICS };
    };
    const kl = await cx.extras({ from: "2026-08-01", to: "2026-08-31", region: "IN-KL", fetchImpl });
    assert.ok(find(kl, "2026-08-23", /Test Obs/).source === "google");
    assert.ok(!kl.items.some((i) => i.source === "google" && /Onam|Independence/.test(i.title)), "dupes dropped");
    const nat = await cx.extras({ from: "2026-08-01", to: "2026-08-31", region: "IN", fetchImpl });
    assert.ok(find(nat, "2026-08-26", /^Onam$/), "outside Kerala, Google's Onam shows");
    const apr = await cx.extras({ from: "2026-04-01", to: "2026-04-30", region: "IN-KL", fetchImpl });
    assert.ok(!apr.items.some((i) => i.source === "google" && /Vishu/.test(i.title)), "Vishu a day off is still a dupe");
    const sep = await cx.extras({ from: "2026-09-01", to: "2026-09-30", region: "IN-KL", fetchImpl });
    assert.ok(!sep.items.some((i) => i.source === "google" && /Ganesh/.test(i.title)), "curated Ganesh Chaturthi wins");
    assert.strictEqual(calls, 1, "fetched once for the day");
  });

  await atest("ICS failure: curated still served, stale copy kept, retry rests", async () => {
    reset();
    let calls = 0;
    const bad = async () => {
      calls++;
      throw new Error("offline");
    };
    const r = await cx.extras({ from: "2026-08-01", to: "2026-08-31", region: "IN-KL", fetchImpl: bad });
    assert.ok(find(r, "2026-08-26", /Thiruvonam/));
    await cx.extras({ from: "2026-07-01", to: "2026-07-31", region: "IN-KL", fetchImpl: bad });
    assert.strictEqual(calls, 1, "no retry storm after a failure");
    // A good copy, then it goes stale and the next fetch fails: keep it.
    reset();
    await cx.extras({ from: "2026-08-01", to: "2026-08-31", region: "IN-KL", fetchImpl: async () => ({ ok: true, text: async () => ICS }) });
    cx._ics.fetchedAt -= 25 * 3600_000;
    const again = await cx.extras({ from: "2026-08-01", to: "2026-08-31", region: "IN-KL", fetchImpl: async () => ({ ok: false, status: 503 }) });
    assert.ok(find(again, "2026-08-23", /Test Obs/), "stale copy still used");
    assert.strictEqual(cx.parseIcs("garbage").length, 0);
  });

  // ── the route ─────────────────────────────────────────────────────
  await atest("route: 200 with items, 400 on a bad window, registered in server.js", async () => {
    reset();
    cx._ics.failedAt = Date.now(); // no ICS attempt in this test
    const app = express();
    app.get("/tools/calendar/extras", cx.handler);
    const srv = app.listen(0);
    const base = `http://127.0.0.1:${srv.address().port}/tools/calendar/extras`;
    try {
      const ok = await fetch(`${base}?y=2026&m=10&region=IN-KL`);
      assert.strictEqual(ok.status, 200);
      const j = await ok.json();
      assert.strictEqual(j.region, "IN-KL");
      assert.ok(j.items.some((i) => i.title === "Gandhi Jayanti"));
      const kochi = await (await fetch(`${base}?from=2026-10-01&to=2026-10-31`, { headers: { "X-Geo-Lat": "19.07", "X-Geo-Lng": "72.88" } })).json();
      assert.strictEqual(kochi.region, "IN");
      assert.strictEqual((await fetch(`${base}?from=2026-01-01&to=2026-12-31`)).status, 400);
      assert.strictEqual((await fetch(`${base}?from=nope`)).status, 400);
    } finally {
      srv.close();
    }
    const server = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
    assert.match(server, /app\.get\("\/tools\/calendar\/extras", appAuth,/);
  });

  await atest("brief calendar carries item times (backward compatible)", () => {
    const src = fs.readFileSync(path.join(__dirname, "../src/routes/brief.js"), "utf8");
    assert.match(src, /del: "reminders", at: due/);
    assert.match(src, /e\.allDay \? \{\} : \{ at \}/);
  });

  console.log(`\n  calendar extras: ${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
})();
