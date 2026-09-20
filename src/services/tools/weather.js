/**
 * WEATHER TOOL — Open-Meteo (free, no API key).
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
async function getWeather(where) {
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
function describe(w) {
  if (!w) return "";
  const c = w.current;
  const today = w.days[0], tomorrow = w.days[1];
  let s =
    `Weather in ${w.label} right now: ${c.condition}, ${c.tempC}°C ` +
    `(feels like ${c.feelsC}°C), humidity ${c.humidity}%, wind ${c.windKmh} km/h.`;
  if (today) s += ` Today: ${today.condition}, ${today.minC}–${today.maxC}°C, ${today.rainChance}% chance of rain.`;
  if (tomorrow) s += ` Tomorrow: ${tomorrow.condition}, ${tomorrow.minC}–${tomorrow.maxC}°C, ${tomorrow.rainChance}% rain.`;
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
async function hourlyOutlook(where, hoursAhead = 8) {
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

module.exports = { getWeather, describe, hourlyOutlook };
