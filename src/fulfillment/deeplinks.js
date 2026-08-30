/**
 * SMART DEEP LINKS — hand the user off to a provider app with the work
 * already done.
 *
 * WHY THIS EXISTS, AND WHAT IT HONESTLY IS
 * ----------------------------------------
 * Swiggy, Zomato, BookMyShow, Uber and Ola do NOT publish a consumer API
 * that lets a third-party server place an order or buy a ticket. There is
 * no key we can obtain to do it properly. The only alternatives would be
 * scraping their private endpoints (breaks their terms, breaks on every UI
 * change, and would require holding the user's payment credentials on our
 * server) or pretending — which is what the old mocked booking tool did.
 *
 * So we do the honest thing: Hari does EVERYTHING up to the payment step —
 * works out which restaurant, which showtime, which exact dropoff — and
 * opens the provider app already pointed at it. The user taps pay.
 *
 * That last-mile handoff is a real limit, and every caller of this module
 * must describe it as one. `speakFor()` below gives the truthful phrasing;
 * nothing here may ever be reported as a completed order.
 *
 * LINK SHAPES
 * -----------
 * Android gets an `intent://` URL carrying the target package plus a
 * `browser_fallback_url`, matching the idiom already used by play_music:
 * if the app is installed it opens; if not, the browser opens the same
 * destination instead of dead-ending. iOS/web use the https link, which
 * these providers register as a universal/app link.
 *
 * Link accuracy varies by provider and is marked per builder below:
 *   VERIFIED  documented, parameterised deep link (Uber, Ola)
 *   SEARCH    public search URL — lands on the right result, not a filled
 *             cart (Swiggy, Zomato, BookMyShow, Amazon, Flipkart)
 * We never claim more precision than the link actually delivers.
 */

/** Providers we can hand off to, and the Android package behind each. */
const PROVIDERS = {
  swiggy: { label: "Swiggy", pkg: "in.swiggy.android", host: "www.swiggy.com" },
  zomato: { label: "Zomato", pkg: "com.application.zomato", host: "www.zomato.com" },
  uber: { label: "Uber", pkg: "com.ubercab", host: "m.uber.com" },
  ola: { label: "Ola", pkg: "com.olacabs.customer", host: "book.olacabs.com" },
  bookmyshow: { label: "BookMyShow", pkg: "com.bt.bms", host: "in.bookmyshow.com" },
  blinkit: { label: "Blinkit", pkg: "com.grofers.customerapp", host: "blinkit.com" },
  zepto: { label: "Zepto", pkg: "com.zeptoconsumerapp", host: "www.zeptonow.com" },
  amazon: { label: "Amazon", pkg: "in.amazon.mShop.android.shopping", host: "www.amazon.in" },
  flipkart: { label: "Flipkart", pkg: "com.flipkart.android", host: "www.flipkart.com" },
  makemytrip: { label: "MakeMyTrip", pkg: "com.makemytrip", host: "www.makemytrip.com" },
};

function isProvider(name) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, String(name || "").toLowerCase());
}

function labelFor(name) {
  const p = PROVIDERS[String(name || "").toLowerCase()];
  return p ? p.label : String(name || "the app");
}

const enc = (s) => encodeURIComponent(String(s == null ? "" : s));

/**
 * Wraps an https destination in an Android intent:// URL so the provider's
 * own app handles it, falling back to the browser when it isn't installed.
 *
 * `platform` is what the APP told us. Only Android understands intent://;
 * on iOS the https universal link is already the correct thing to open.
 */
function wrap(httpsUrl, pkg, platform) {
  if (String(platform || "").toLowerCase() !== "android" || !pkg) return httpsUrl;
  const stripped = httpsUrl.replace(/^https?:\/\//, "");
  return (
    `intent://${stripped}#Intent;scheme=https;package=${pkg};` +
    `S.browser_fallback_url=${enc(httpsUrl)};end`
  );
}

/* ------------------------------------------------------------------ *
 * PER-PROVIDER BUILDERS
 *
 * Each returns { url, precision, note } where precision describes what
 * the user will actually land on:
 *   "target"  the exact restaurant / showtime / route
 *   "search"  a results list for the right thing
 *   "app"     just the app's home screen
 * ------------------------------------------------------------------ */

/**
 * FOOD — Swiggy / Zomato.  SEARCH precision.
 *
 * When we resolved a specific restaurant we search for it BY NAME, which
 * lands on that restaurant's page; otherwise we search the dish, which is
 * what the user actually asked for ("biryani"). A dish query is genuinely
 * more useful than the app's home screen, but it is still a search — say so.
 */
function food({ provider = "swiggy", dish, restaurant, platform }) {
  const p = PROVIDERS[provider] || PROVIDERS.swiggy;
  const q = restaurant || dish || "";
  let url;
  if (provider === "zomato") {
    url = q ? `https://www.zomato.com/search?q=${enc(q)}` : "https://www.zomato.com/";
  } else {
    url = q ? `https://www.swiggy.com/search?query=${enc(q)}` : "https://www.swiggy.com/";
  }
  return {
    url: wrap(url, p.pkg, platform),
    precision: q ? "search" : "app",
    note: restaurant
      ? `${p.label} search for ${restaurant}`
      : dish
        ? `${p.label} search for ${dish}`
        : `${p.label} home`,
  };
}

/**
 * RIDE — Uber / Ola.  VERIFIED precision when we have coordinates.
 *
 * Uber's universal link takes a real dropoff with lat/lng and a nickname,
 * so the rider opens straight onto a quoted route with the destination
 * already set — they only choose the tier and confirm. Passing coordinates
 * matters: a text-only dropoff makes Uber guess, and it guesses badly for
 * Indian addresses.
 */
function ride({ provider = "uber", destination, lat, lng, pickupLat, pickupLng, platform }) {
  const p = PROVIDERS[provider] || PROVIDERS.uber;
  const hasCoords = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));

  if (provider === "ola") {
    // Ola's documented launch link. Without a drop it opens on pickup.
    let url = "https://book.olacabs.com/?utm_source=myassistant";
    if (hasCoords) url += `&drop_lat=${Number(lat)}&drop_lng=${Number(lng)}`;
    if (destination) url += `&drop_name=${enc(destination)}`;
    return {
      url: wrap(url, p.pkg, platform),
      precision: hasCoords ? "target" : destination ? "search" : "app",
      note: destination ? `Ola to ${destination}` : "Ola home",
    };
  }

  let url = "https://m.uber.com/ul/?action=setPickup";
  if (Number.isFinite(Number(pickupLat)) && Number.isFinite(Number(pickupLng))) {
    url += `&pickup[latitude]=${Number(pickupLat)}&pickup[longitude]=${Number(pickupLng)}`;
  } else {
    url += "&pickup=my_location";
  }
  if (hasCoords) {
    url += `&dropoff[latitude]=${Number(lat)}&dropoff[longitude]=${Number(lng)}`;
  }
  if (destination) url += `&dropoff[nickname]=${enc(destination)}`;
  return {
    url: wrap(url, p.pkg, platform),
    precision: hasCoords ? "target" : destination ? "search" : "app",
    note: destination ? `Uber to ${destination}` : "Uber home",
  };
}

/**
 * MOVIES — BookMyShow.  SEARCH precision.
 *
 * BMS has no public per-showtime link, so the best honest target is its
 * search for the title; the user picks cinema and time. When we know the
 * city we open that city's movie listing instead, which is one tap closer
 * than the national home page.
 */
function movie({ title, city, platform }) {
  const p = PROVIDERS.bookmyshow;
  let url, precision, note;
  if (title) {
    url = `https://in.bookmyshow.com/explore/search?q=${enc(title)}`;
    precision = "search";
    note = `BookMyShow search for ${title}`;
  } else if (city) {
    const slug = String(city).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-");
    url = `https://in.bookmyshow.com/explore/movies-${slug}`;
    precision = "search";
    note = `Now showing in ${city}`;
  } else {
    url = "https://in.bookmyshow.com/";
    precision = "app";
    note = "BookMyShow home";
  }
  return { url: wrap(url, p.pkg, platform), precision, note };
}

/** GROCERIES / SHOPPING — Blinkit, Zepto, Amazon, Flipkart. SEARCH. */
function shop({ provider, query, platform }) {
  const p = PROVIDERS[provider];
  if (!p) return null;
  const q = query ? enc(query) : "";
  const paths = {
    blinkit: q ? `https://blinkit.com/s/?q=${q}` : "https://blinkit.com/",
    zepto: q ? `https://www.zeptonow.com/search?query=${q}` : "https://www.zeptonow.com/",
    amazon: q ? `https://www.amazon.in/s?k=${q}` : "https://www.amazon.in/",
    flipkart: q ? `https://www.flipkart.com/search?q=${q}` : "https://www.flipkart.com/",
    makemytrip: "https://www.makemytrip.com/",
  };
  const url = paths[provider];
  if (!url) return null;
  return {
    url: wrap(url, p.pkg, platform),
    precision: q ? "search" : "app",
    note: query ? `${p.label} search for ${query}` : `${p.label} home`,
  };
}

/**
 * The sentence Hari SAYS when handing off. This is the honesty seam: the
 * user is told they finish the last step, every time, in every path.
 *
 * "target" links get a confident lead-in because the destination really is
 * set; "search"/"app" links promise only what they deliver.
 */
function speakFor({ precision, providerLabel, what }) {
  const subject = what ? ` for ${what}` : "";
  if (precision === "target") {
    return `Opening ${providerLabel} with${subject ? subject.replace(" for ", " ") : " your trip"} already set — confirm it and you're done.`;
  }
  if (precision === "search") {
    return `Opening ${providerLabel}${subject} — pick the one you want and I'll leave the payment to you.`;
  }
  return `Opening ${providerLabel} — I couldn't narrow it down, so you'll need to search from there.`;
}

module.exports = {
  PROVIDERS,
  isProvider,
  labelFor,
  food,
  ride,
  movie,
  shop,
  speakFor,
  _wrap: wrap, // tests
};
