/**
 * WEATHER — `npm run test:weather`.
 *
 * OpenWeatherMap first (2026-10-02, the owner: "it says heavy rain here,
 * and here it is sunny"), the same shapes the Home card and the assistant
 * read, and Open-Meteo only when OpenWeatherMap refuses. Network faked.
 */
process.env.OPENWEATHER_API_KEY = "owm-test";
const assert = require("assert");
const W = require("../src/services/tools/weather");

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); }
}
const realFetch = globalThis.fetch;
let calls = [];
function fake(handler) {
  calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const r = await handler(String(url));
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  };
}

// 2 Oct 2026, 11:30 IST (06:00 UTC); Mangalore is UTC+5:30.
const NOW = Date.UTC(2026, 9, 2, 6, 0) / 1000;
const TZ = 19800;
const slot = (h, id, pop, rain, t) => ({
  dt: NOW + h * 3600, main: { temp: t, feels_like: t + 2, temp_min: t - 1, temp_max: t + 1, humidity: 70 },
  weather: [{ id, description: id === 800 ? "clear sky" : id === 500 ? "light rain" : "broken clouds" }],
  pop, rain: rain ? { "3h": rain } : undefined, wind: { speed: 3 }, sys: { pod: "d" },
});
const OWM_CURRENT = {
  dt: NOW, timezone: TZ, name: "Mangaluru", visibility: 10000,
  main: { temp: 31.2, feels_like: 36.4, humidity: 62 }, wind: { speed: 2.5 },
  weather: [{ id: 800, description: "clear sky" }], sys: { sunrise: NOW - 5 * 3600, sunset: NOW + 7 * 3600 },
};
const OWM_FORECAST = {
  city: { timezone: TZ },
  list: [slot(1, 800, 0.05, 0, 31), slot(4, 803, 0.2, 0, 30), slot(7, 500, 0.62, 1.4, 27), slot(10, 500, 0.55, 0.8, 26),
    slot(25, 800, 0.1, 0, 30), slot(28, 801, 0.1, 0, 31)],
};
const owm = (url) => {
  if (/openweathermap\.org\/data\/2\.5\/weather/.test(url)) return OWM_CURRENT;
  if (/openweathermap\.org\/data\/2\.5\/forecast/.test(url)) return OWM_FORECAST;
  if (/open-meteo/.test(url)) return { current: { uv_index: 9.1 }, daily: { time: ["2026-10-02", "2026-10-03"], uv_index_max: [11, 10] } };
  throw new Error("unexpected " + url);
};

(async () => {
  try {
    await check("now comes from OpenWeatherMap: clear sky stays clear sky, with the app's WMO code", async () => {
      W._owmReset();
      fake(owm);
      const f = await W.forecast({ lat: 12.9141, lng: 74.856 });
      assert.strictEqual(f.provider, "openweathermap");
      assert.strictEqual(f.label, "Mangaluru");
      assert.strictEqual(f.now.condition, "clear sky");
      assert.strictEqual(f.now.code, 0);
      assert.strictEqual(f.now.tempC, 31.2);
      assert.strictEqual(f.now.windKmh, 9);
      assert.strictEqual(f.now.uv, 9.1);
      assert.strictEqual(f.now.isDay, true);
      assert.ok(calls.some((u) => /appid=owm-test/.test(u) && /units=metric/.test(u)));
    });

    await check("the next hours carry the real chance of rain; the rain window is when it comes", async () => {
      W._owmReset();
      fake(owm);
      const f = await W.forecast({ lat: 12.9141, lng: 74.856 });
      assert.deepStrictEqual(f.hours.slice(0, 4).map((h) => [h.hour, h.rainChance, h.code]), [[12, 5, 0], [15, 20, 3], [18, 62, 61], [21, 55, 61]]);
      assert.deepStrictEqual(f.rainWindow, { from: "18:00", to: "00:00", peak: 62 });
      assert.strictEqual(f.days[0].date, "2026-10-02");
      assert.strictEqual(f.days[0].rainChance, 62);
      assert.strictEqual(f.days[0].condition, "light rain", "a wet evening makes the day rainy");
      assert.strictEqual(f.days[0].sunrise, "06:30");
      assert.strictEqual(f.days[1].condition, "clear sky");
      assert.strictEqual(f.days[1].uv, 10);
    });

    await check("the assistant's shapes: getWeather and hourlyOutlook, and describe reads them", async () => {
      W._owmReset();
      fake(owm);
      const w = await W.getWeather({ lat: 12.9141, lng: 74.856 });
      assert.strictEqual(w.current.condition, "clear sky");
      assert.match(W.describe(w), /Weather in Mangaluru right now: clear sky, 31.2°C/);
      const h = await W.hourlyOutlook({ lat: 12.9141, lng: 74.856 }, 8);
      assert.strictEqual(h.condition, "clear sky");
      assert.strictEqual(h.hours.length, 3);
      assert.strictEqual(h.rainWindow.from, "18:00");
    });

    await check("a refused key falls back to Open-Meteo, and is not asked again for five minutes", async () => {
      W._owmReset();
      fake((url) => {
        if (/openweathermap/.test(url)) return new Response('{"cod":401}', { status: 401 });
        return {
          current: { temperature_2m: 30, apparent_temperature: 33, relative_humidity_2m: 60, wind_speed_10m: 8, weather_code: 1 },
          daily: { time: ["2026-10-02"], temperature_2m_max: [32], temperature_2m_min: [25], precipitation_probability_max: [10], weather_code: [1] },
        };
      });
      const w = await W.getWeather({ lat: 12.91, lng: 74.85 });
      assert.strictEqual(w.current.condition, "mostly clear");
      const owmCalls = calls.filter((u) => /openweathermap/.test(u)).length;
      await W.getWeather({ lat: 13.5, lng: 75.1 });
      assert.strictEqual(calls.filter((u) => /openweathermap/.test(u)).length, owmCalls, "OpenWeatherMap not asked again");
    });

    await check("OpenWeatherMap condition ids map to the app's icons", () => {
      assert.deepStrictEqual([200, 301, 500, 501, 502, 521, 701, 800, 801, 802, 804].map(W.codeOf), [95, 53, 61, 63, 65, 81, 45, 0, 1, 2, 3]);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
