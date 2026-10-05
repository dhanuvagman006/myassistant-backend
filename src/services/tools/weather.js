/**
 * WEATHER TOOL — OpenWeatherMap (OPENWEATHER_API_KEY) first, Open-Meteo
 * (free, no key) as the fallback.
 * Used by the /chat intent layer ("what's the weather") and the app's
 * Today screen (GET /tools/weather). 10-minute in-memory cache.
 */
const TIMEOUT = 8000;
const cache = new Map(); // key → { ts, data }
const TTL = 10 * 60 * 1000;

const WMO = {
  0: "clear sky", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "rime fog", 51: "light drizzle", 53: "drizzle",
  55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
  66: "freezing rain", 67: "freezing rain", 71: "light snow", 73: "snow",
  75: "heavy snow", 77: "snow grains", 80: "light showers", 81: "showers",
  82: "violent showers", 85: "snow showers", 86: "snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with hail",
};

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`weather ${r.status}`);
  return r.json();
}

async function geocodeCity(name) {
  const key = `geo:${name.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < 24 * 3600_000) return hit.data;
  const j = await getJson(
    "https://geocoding-api.open-meteo.com/v1/search?count=1&name=" +
      encodeURIComponent(name)
  );
  const g = j.results?.[0];
  if (!g) return null;
  const data = {
    lat: g.latitude, lng: g.longitude,
    label: [g.name, g.admin1, g.country].filter(Boolean).join(", "),
  };
  cache.set(key, { ts: Date.now(), data });
  return data;
}

/**
 * @param {{lat?:number,lng?:number,city?:string}} where
 * @returns {Promise<object|null>} { label, current:{...}, days:[...] }
 */
async function omGetWeather(where) {
  let lat = where.lat, lng = where.lng, label = where.city || null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    if (!where.city) return null;
    const g = await geocodeCity(where.city);
    if (!g) return null;
    ({ lat, lng, label } = g);
  }

  const key = `wx:${lat.toFixed(2)},${lng.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return { ...hit.data, label: label || hit.data.label };

  const j = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      "&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m" +
      "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code" +
      "&timezone=auto&forecast_days=3"
  );

  const data = {
    label: label || `${lat.toFixed(2)}, ${lng.toFixed(2)}`,
    current: {
      tempC: j.current?.temperature_2m,
      feelsC: j.current?.apparent_temperature,
      humidity: j.current?.relative_humidity_2m,
      windKmh: j.current?.wind_speed_10m,
      condition: WMO[j.current?.weather_code] || "unknown",
    },
    days: (j.daily?.time || []).map((date, i) => ({
      date,
      maxC: j.daily.temperature_2m_max?.[i],
      minC: j.daily.temperature_2m_min?.[i],
      rainChance: j.daily.precipitation_probability_max?.[i],
      condition: WMO[j.daily.weather_code?.[i]] || "unknown",
    })),
  };
  cache.set(key, { ts: Date.now(), data });
  return data;
}

/** One-paragraph plain text for the AI context. */
function describe(w, unit = "c") {
  if (!w) return "";
  const c = w.current;
  const today = w.days[0], tomorrow = w.days[1];
  const temp = (value) => {
    if (!Number.isFinite(value)) return "unknown";
    return unit === "f"
      ? Math.round(value * 9 / 5 + 32)
      : value;
  };
  const suffix = unit === "f" ? "°F" : "°C";
  let s =
    `Weather in ${w.label} right now: ${c.condition}, ${temp(c.tempC)}${suffix} ` +
    `(feels like ${temp(c.feelsC)}${suffix}), humidity ${c.humidity}%, wind ${c.windKmh} km/h.`;
  if (today) s += ` Today: ${today.condition}, ${temp(today.minC)}–${temp(today.maxC)}${suffix}, ${today.rainChance}% chance of rain.`;
  if (tomorrow) s += ` Tomorrow: ${tomorrow.condition}, ${temp(tomorrow.minC)}–${temp(tomorrow.maxC)}${suffix}, ${tomorrow.rainChance}% rain.`;
  return s;
}

/**
 * THE NEXT FEW HOURS, NOT THE DAY.
 *
 * "Should I take an umbrella?" is an hourly question — a 60% daily rain
 * chance says nothing about whether it rains while you are actually out,
 * and a day summary is what makes an assistant sound like a weather app
 * instead of someone who knows. Open-Meteo gives this in the same call
 * shape; only the fields differ.
 *
 * @returns {Promise<{label:string, hours:Array, rainWindow:?{from:string,to:string,peak:number}}>}
 */
async function omHourlyOutlook(where, hoursAhead = 8) {
  let lat = where.lat, lng = where.lng, label = where.city || null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    if (!where.city) return null;
    const g = await geocodeCity(where.city);
    if (!g) return null;
    ({ lat, lng, label } = g);
  }
  const key = `wxh:${lat.toFixed(2)},${lng.toFixed(2)}`;
  const hit = cache.get(key);
  let j = hit && Date.now() - hit.ts < TTL ? hit.data : null;
  if (!j) {
    j = await getJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
        "&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,uv_index" +
        "&current=temperature_2m,apparent_temperature,weather_code" +
        "&timezone=auto&forecast_days=2"
    );
    cache.set(key, { ts: Date.now(), data: j });
  }

  const times = j.hourly?.time || [];
  // START FROM THE CURRENT HOUR *THERE*, NOT HERE.
  //
  // timezone=auto means every timestamp comes back in the LOCATION's
  // local time, so comparing them against a UTC clock slides the whole
  // outlook by the offset — at 20:00 IST it opened the forecast at 14:00
  // and reported hours that had already happened. `current.time` is the
  // API's own local clock, which is the only correct anchor.
  const nowLocal = String(j.current?.time || "").slice(0, 13);
  const anchor =
    nowLocal ||
    new Date(Date.now() + Number(j.utc_offset_seconds || 0) * 1000)
      .toISOString()
      .slice(0, 13);
  let start = times.findIndex((t) => t.slice(0, 13) >= anchor);
  if (start < 0) start = 0;

  const hours = [];
  for (let i = start; i < Math.min(start + hoursAhead, times.length); i++) {
    hours.push({
      at: times[i],
      hour: Number(times[i].slice(11, 13)),
      tempC: j.hourly.temperature_2m?.[i],
      feelsC: j.hourly.apparent_temperature?.[i],
      rainChance: j.hourly.precipitation_probability?.[i] ?? 0,
      mm: j.hourly.precipitation?.[i] ?? 0,
      windKmh: j.hourly.wind_speed_10m?.[i],
      uv: j.hourly.uv_index?.[i],
      condition: WMO[j.hourly.weather_code?.[i]] || "unknown",
    });
  }

  // The first stretch worth warning about, and how bad it gets.
  let rainWindow = null;
  const wet = hours.filter((h) => h.rainChance >= 40);
  if (wet.length) {
    const first = wet[0];
    let last = first;
    for (const h of wet) {
      if (h.hour - last.hour <= 2) last = h; else break;
    }
    rainWindow = {
      from: String(first.hour).padStart(2, "0") + ":00",
      to: String(last.hour + 1).padStart(2, "0") + ":00",
      peak: Math.max(...wet.map((h) => h.rainChance)),
    };
  }

  return {
    label: label || `${lat.toFixed(2)}, ${lng.toFixed(2)}`,
    nowC: j.current?.temperature_2m,
    feelsC: j.current?.apparent_temperature,
    condition: WMO[j.current?.weather_code] || "unknown",
    hours,
    rainWindow,
    maxUv: hours.length ? Math.max(...hours.map((h) => h.uv || 0)) : 0,
    maxWindKmh: hours.length ? Math.max(...hours.map((h) => h.windKmh || 0)) : 0,
  };
}

/**
 * THE HOME WEATHER CARD (2026-09-30, owner: "need weather card in the home
 * page" with a screenshot of a forecast card): now, the next 24 hours and
 * the week, in one Open-Meteo call, plus the area's name for the title.
 *
 * @returns {Promise<object|null>} { label, now:{tempC,feelsC,humidity,
 *   windKmh,visibilityKm,uv,code,condition,isDay}, hours:[{at,hour,tempC,
 *   rainChance,mm,code,isDay}], days:[{date,maxC,minC,mm,rainChance,code,
 *   windKmh,uv,sunrise,sunset}], rainWindow }
 */
async function omForecast(where) {
  let lat = where.lat, lng = where.lng, label = where.city || null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    if (!where.city) return null;
    const g = await geocodeCity(where.city);
    if (!g) return null;
    ({ lat, lng, label } = g);
  }
  const key = `wxf:${lat.toFixed(2)},${lng.toFixed(2)}`;
  const hit = cache.get(key);
  let j = hit && Date.now() - hit.ts < TTL ? hit.data : null;
  if (!j) {
    j = await getJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
        "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day,visibility,uv_index" +
        "&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,is_day" +
        "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,uv_index_max,sunrise,sunset" +
        "&timezone=auto&forecast_days=7"
    );
    cache.set(key, { ts: Date.now(), data: j });
  }
  const round = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

  // The next 24 hours from the hour it is THERE (see hourlyOutlook).
  const times = j.hourly?.time || [];
  const anchor = String(j.current?.time || "").slice(0, 13);
  let start = times.findIndex((t) => t.slice(0, 13) >= anchor);
  if (start < 0) start = 0;
  const hours = [];
  for (let i = start; i < Math.min(start + 24, times.length); i++) {
    hours.push({
      at: times[i],
      hour: Number(times[i].slice(11, 13)),
      tempC: round(j.hourly.temperature_2m?.[i]),
      rainChance: j.hourly.precipitation_probability?.[i] ?? 0,
      mm: round(j.hourly.precipitation?.[i] ?? 0),
      code: j.hourly.weather_code?.[i] ?? null,
      isDay: j.hourly.is_day?.[i] === 1,
    });
  }
  const days = (j.daily?.time || []).map((date, i) => ({
    date,
    maxC: round(j.daily.temperature_2m_max?.[i]),
    minC: round(j.daily.temperature_2m_min?.[i]),
    mm: round(j.daily.precipitation_sum?.[i] ?? 0),
    rainChance: j.daily.precipitation_probability_max?.[i] ?? 0,
    code: j.daily.weather_code?.[i] ?? null,
    windKmh: round(j.daily.wind_speed_10m_max?.[i]),
    uv: round(j.daily.uv_index_max?.[i]),
    sunrise: String(j.daily.sunrise?.[i] || "").slice(11, 16) || null,
    sunset: String(j.daily.sunset?.[i] || "").slice(11, 16) || null,
  }));

  // The first stretch in the next 12 hours worth an umbrella.
  let rainWindow = null;
  const wet = hours.slice(0, 12).filter((h) => h.rainChance >= 40);
  if (wet.length) {
    let last = wet[0];
    for (const h of wet) {
      if (((h.hour - last.hour + 24) % 24) <= 2) last = h; else break;
    }
    rainWindow = {
      from: String(wet[0].hour).padStart(2, "0") + ":00",
      to: String((last.hour + 1) % 24).padStart(2, "0") + ":00",
      peak: Math.max(...wet.map((h) => h.rainChance)),
    };
  }

  const c = j.current || {};
  return {
    label: label || null,
    now: {
      tempC: round(c.temperature_2m),
      feelsC: round(c.apparent_temperature),
      humidity: c.relative_humidity_2m ?? null,
      windKmh: round(c.wind_speed_10m),
      visibilityKm: Number.isFinite(c.visibility) ? Math.round(c.visibility / 100) / 10 : null,
      uv: round(c.uv_index),
      code: c.weather_code ?? null,
      condition: WMO[c.weather_code] || "unknown",
      isDay: c.is_day === 1,
    },
    hours,
    days,
    rainWindow,
  };
}

// ------------------------------------------------------------ OpenWeatherMap
//
// OPENWEATHERMAP FIRST (2026-10-02, the owner: "the weather is totally
// wrong — it says heavy rain here, and here it is sunny"). Open-Meteo's
// "now" is a model's guess for the grid cell; OpenWeatherMap's current
// conditions lean on station reports, and its 3-hourly forecast carries a
// real chance of rain. Same shapes out as before, so the Home card and the
// assistant need no change. Any failure (a key not yet active, a quota)
// falls back to Open-Meteo; a refused key is not retried for 5 minutes.
const owmKey = () => String(process.env.OPENWEATHER_API_KEY || "").trim();
let owmDownUntil = 0;
const owmOn = () => Boolean(owmKey()) && Date.now() >= owmDownUntil;

/** OpenWeatherMap condition id → the WMO code the app's icons use. */
function codeOf(id) {
  const n = Number(id);
  if (n >= 200 && n < 300) return 95;
  if (n >= 300 && n < 400) return [302, 312, 314].includes(n) ? 55 : [300, 310].includes(n) ? 51 : 53;
  if (n === 500) return 61;
  if (n === 501) return 63;
  if (n >= 502 && n <= 504) return 65;
  if (n === 511) return 66;
  if (n === 520) return 80;
  if (n === 521) return 81;
  if (n === 522 || n === 531) return 82;
  if (n === 600) return 71;
  if (n === 601) return 73;
  if (n === 602) return 75;
  if (n >= 611 && n <= 616) return 66;
  if (n === 620) return 85;
  if (n === 621 || n === 622) return 86;
  if (n === 781) return 95;
  if (n >= 700 && n < 800) return 45;
  if (n === 800) return 0;
  if (n === 801) return 1;
  if (n === 802) return 2;
  if (n === 803 || n === 804) return 3;
  return null;
}

async function owmJson(path) {
  const r = await fetch(`https://api.openweathermap.org/data/2.5/${path}&units=metric&appid=${encodeURIComponent(owmKey())}`,
    { signal: AbortSignal.timeout(TIMEOUT) });
  if (r.status === 401 || r.status === 429) owmDownUntil = Date.now() + 5 * 60_000;
  if (!r.ok) throw new Error(`openweathermap ${r.status}`);
  return r.json();
}

/** UV is not in OpenWeatherMap's free tier: Open-Meteo's, best effort. */
async function uvFor(lat, lng) {
  const key = `uv:${lat.toFixed(2)},${lng.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;
  try {
    const j = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
      "&current=uv_index&daily=uv_index_max&timezone=auto&forecast_days=7");
    const data = { now: j.current?.uv_index ?? null, byDate: {} };
    (j.daily?.time || []).forEach((d, i) => { data.byDate[d] = j.daily.uv_index_max?.[i] ?? null; });
    cache.set(key, { ts: Date.now(), data });
    return data;
  } catch (_) {
    return { now: null, byDate: {} };
  }
}

async function owmData(lat, lng) {
  const key = `owm:${lat.toFixed(2)},${lng.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;
  const q = `lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}`;
  const [cur, fc, uv] = await Promise.all([owmJson(`weather?${q}`), owmJson(`forecast?${q}`), uvFor(lat, lng)]);
  const data = { cur, fc, uv };
  cache.set(key, { ts: Date.now(), data });
  return data;
}

async function resolvePlace(where) {
  let lat = where.lat, lng = where.lng, label = where.city || null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    if (!where.city) return null;
    const g = await geocodeCity(where.city);
    if (!g) return null;
    ({ lat, lng, label } = g);
  }
  return { lat, lng, label };
}

/** The Home card's shape (see forecast below), from OpenWeatherMap. */
async function owmForecast(where) {
  const p = await resolvePlace(where);
  if (!p) return null;
  const { cur, fc, uv } = await owmData(p.lat, p.lng);
  const tz = Number((fc.city && fc.city.timezone) ?? cur.timezone ?? 0);
  const local = (dt) => new Date((Number(dt) + tz) * 1000).toISOString().slice(0, 16);
  const round = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  const w0 = (x) => (x && Array.isArray(x.weather) && x.weather[0]) || {};
  const say = (x) => String(w0(x).description || WMO[codeOf(w0(x).id)] || "unknown").toLowerCase();
  const list = (fc.list || []).filter((x) => Number(x.dt) + 3 * 3600 > Number(cur.dt));
  const hours = list.slice(0, 8).map((x) => ({
    at: local(x.dt),
    hour: Number(local(x.dt).slice(11, 13)),
    tempC: round(x.main && x.main.temp),
    feelsC: round(x.main && x.main.feels_like),
    rainChance: Math.round((Number(x.pop) || 0) * 100),
    mm: round((x.rain && x.rain["3h"]) || 0),
    windKmh: round(((x.wind && x.wind.speed) || 0) * 3.6),
    code: codeOf(w0(x).id),
    condition: say(x),
    isDay: (x.sys && x.sys.pod) === "d",
  }));
  const today = local(cur.dt).slice(0, 10);
  const byDate = new Map();
  for (const x of fc.list || []) {
    const d = local(x.dt).slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(x);
  }
  if (!byDate.has(today)) byDate.set(today, []);
  const hhmm = (dt) => (dt ? local(dt).slice(11, 16) : null);
  const days = [...byDate.keys()].sort().filter((d) => d >= today).map((date) => {
    const xs = byDate.get(date);
    const temps = xs.flatMap((x) => [x.main.temp_max, x.main.temp_min]);
    if (date === today && cur.main) temps.push(cur.main.temp);
    const wettest = xs.reduce((a, b) => ((Number(b.pop) || 0) > (Number(a && a.pop) || 0) ? b : a), xs[0]);
    const midday = xs.reduce((a, b) => (Math.abs(Number(local(b.dt).slice(11, 13)) - 13) <
      Math.abs(Number(local(a.dt).slice(11, 13)) - 13) ? b : a), xs[0]);
    const pick = xs.length ? ((Number(wettest.pop) || 0) >= 0.5 ? wettest : midday) : cur;
    return {
      date,
      maxC: temps.length ? round(Math.max(...temps)) : null,
      minC: temps.length ? round(Math.min(...temps)) : null,
      mm: round(xs.reduce((s, x) => s + ((x.rain && x.rain["3h"]) || 0), 0)),
      rainChance: xs.length ? Math.round(Math.max(...xs.map((x) => Number(x.pop) || 0)) * 100) : 0,
      code: codeOf(w0(pick).id),
      condition: say(pick),
      windKmh: xs.length ? round(Math.max(...xs.map((x) => ((x.wind && x.wind.speed) || 0) * 3.6))) : null,
      uv: uv.byDate[date] ?? null,
      sunrise: date === today ? hhmm(cur.sys && cur.sys.sunrise) : null,
      sunset: date === today ? hhmm(cur.sys && cur.sys.sunset) : null,
    };
  });
  let rainWindow = null;
  const wet = hours.slice(0, 4).filter((h) => h.rainChance >= 40);
  if (wet.length) {
    let last = wet[0];
    for (const h of wet) {
      if (((h.hour - last.hour + 24) % 24) <= 3) last = h; else break;
    }
    rainWindow = {
      from: String(wet[0].hour).padStart(2, "0") + ":00",
      to: String((last.hour + 3) % 24).padStart(2, "0") + ":00",
      peak: Math.max(...wet.map((h) => h.rainChance)),
    };
  }
  const sys = cur.sys || {};
  return {
    provider: "openweathermap",
    label: p.label || cur.name || null,
    now: {
      tempC: round(cur.main && cur.main.temp),
      feelsC: round(cur.main && cur.main.feels_like),
      humidity: (cur.main && cur.main.humidity) ?? null,
      windKmh: round(((cur.wind && cur.wind.speed) || 0) * 3.6),
      visibilityKm: Number.isFinite(cur.visibility) ? Math.round(cur.visibility / 100) / 10 : null,
      uv: uv.now,
      code: codeOf(w0(cur).id),
      condition: say(cur),
      isDay: sys.sunrise && sys.sunset ? cur.dt >= sys.sunrise && cur.dt < sys.sunset : true,
    },
    hours,
    days,
    rainWindow,
  };
}

async function owmGetWeather(where) {
  const f = await owmForecast(where);
  if (!f) return null;
  return {
    provider: f.provider,
    label: f.label || `${Number(where.lat).toFixed(2)}, ${Number(where.lng).toFixed(2)}`,
    current: { tempC: f.now.tempC, feelsC: f.now.feelsC, humidity: f.now.humidity, windKmh: f.now.windKmh, condition: f.now.condition },
    days: f.days.slice(0, 3).map((d) => ({ date: d.date, maxC: d.maxC, minC: d.minC, rainChance: d.rainChance, condition: d.condition })),
  };
}

async function owmHourlyOutlook(where, hoursAhead = 8) {
  const f = await owmForecast(where);
  if (!f) return null;
  const n = Math.max(1, Math.ceil(hoursAhead / 3));
  const hours = f.hours.slice(0, n).map((h) => ({ ...h, uv: f.now.uv }));
  return {
    provider: f.provider,
    label: f.label || `${Number(where.lat).toFixed(2)}, ${Number(where.lng).toFixed(2)}`,
    nowC: f.now.tempC,
    feelsC: f.now.feelsC,
    condition: f.now.condition,
    hours,
    rainWindow: f.rainWindow,
    maxUv: f.now.uv || 0,
    maxWindKmh: hours.length ? Math.max(...hours.map((h) => h.windKmh || 0)) : 0,
  };
}

/** OpenWeatherMap when it answers, Open-Meteo when it does not. */
function preferOwm(owm, om) {
  return async (...args) => {
    if (owmOn()) {
      try {
        const out = await owm(...args);
        if (out) return out;
      } catch (e) {
        console.warn(`weather: ${e.message} — using Open-Meteo`);
      }
    }
    return om(...args);
  };
}
const getWeather = preferOwm(owmGetWeather, omGetWeather);
const hourlyOutlook = preferOwm(owmHourlyOutlook, omHourlyOutlook);
const forecast = preferOwm(owmForecast, omForecast);

module.exports = { getWeather, describe, hourlyOutlook, forecast, WMO, codeOf, _owmReset: () => { owmDownUntil = 0; cache.clear(); } };
