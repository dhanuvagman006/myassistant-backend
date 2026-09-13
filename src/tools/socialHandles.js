/**
 * WHOSE PROFILE IS THIS, ACTUALLY?
 * ----------------------------------------------------------------------
 * open_app used to take a handle the MODEL remembered. For a globally
 * famous account that is usually right; for a regional one it is a guess
 * dressed as a fact. Asked for the actor Neha Shetty — Kannada and Telugu
 * films — it opened a different Neha Shetty's account, four times running,
 * while the user rephrased and tried again.
 *
 * A guessed handle is worse than no handle: it opens a stranger's profile
 * and says the person's name while doing it. So the handle is LOOKED UP
 * instead, from the search results' own URLs. The web already knows which
 * account belongs to which person; the model's recall of a username does
 * not need to be the source of truth.
 *
 * Nothing here invents a handle. If the search does not produce a profile
 * URL for the platform asked about, this returns null and the caller falls
 * back to a search page — which shows the user a choice rather than
 * confidently opening the wrong person.
 */
const webSearch = require("./webSearch");

/** How a profile URL is shaped on each platform we can resolve. */
const PROFILE_RX = {
  instagram: /(?:^|\/\/)(?:www\.)?instagram\.com\/([A-Za-z0-9._]{2,30})(?:[/?#]|$)/i,
  x: /(?:^|\/\/)(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{2,15})(?:[/?#]|$)/i,
  facebook: /(?:^|\/\/)(?:www\.)?facebook\.com\/([A-Za-z0-9.]{5,50})(?:[/?#]|$)/i,
  youtube: /(?:^|\/\/)(?:www\.)?youtube\.com\/@([A-Za-z0-9._-]{3,30})(?:[/?#]|$)/i,
  linkedin: /(?:^|\/\/)(?:www\.)?linkedin\.com\/in\/([A-Za-z0-9-]{3,100})(?:[/?#]|$)/i,
};

/**
 * Path segments that look like a handle but are not a person: every
 * platform puts its own pages on the same path shape, and
 * instagram.com/explore is not somebody's account.
 */
const NOT_A_HANDLE = new Set([
  "explore", "accounts", "about", "developer", "directory", "legal", "privacy",
  "terms", "help", "login", "signup", "reels", "stories", "p", "tv", "share",
  "hashtag", "pages", "groups", "watch", "marketplace", "events", "profile",
  "home", "search", "i", "intent", "status", "photo", "media", "settings",
  "channel", "results", "feed", "company", "jobs", "posts", "web",
]);

const TTL_MS = 24 * 60 * 60_000; // handles change rarely; a day is plenty
const cache = new Map(); // `${platform}:${name}` -> { ts, handle }

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Score a candidate handle against the name that was asked for.
 *
 * A handle that contains the person's name is far more likely to be them
 * than one that merely appeared on the results page — searching an actor's
 * name returns fan accounts, news posts and co-stars alongside the real
 * profile.
 */
function score(handle, name) {
  const h = norm(handle);
  const parts = String(name).trim().split(/\s+/).map(norm).filter((p) => p.length > 1);
  if (!parts.length) return 0;
  const joined = parts.join("");
  if (h === joined) return 100;                       // nehashetty
  if (h.replace(/[0-9_.]/g, "") === joined) return 90; // neha_shetty, neha.shetty
  if (h.startsWith(joined)) return 70;                // nehashettyofficial
  const hit = parts.filter((p) => h.includes(p)).length;
  if (hit === parts.length) return 60;                // all name parts present

  // HANDLES ARE OFTEN THE NAME, TRIMMED. "dhanuvagman" is Dhanush Vagman:
  // a prefix of the first name joined to the second. Scoring that as a
  // near-miss sent exactly the case this exists for — an uncommon name
  // with one obvious account — to a search page instead of the profile.
  if (consumesAsPrefixes(h, parts)) return 80;
  if (hit > 0) return 20 + hit * 5;                   // only some — weak
  return 0;
}

/**
 * Can [h] be read as the name's parts in order, each shortened but not
 * below three characters? "dhanuvagman" → dhanu|vagman against
 * [dhanush, vagman]. Order matters: "vagmandhanu" is somebody else.
 */
function consumesAsPrefixes(h, parts) {
  let rest = h.replace(/[0-9_.]/g, "");
  for (const part of parts) {
    let took = 0;
    // Longest prefix of this name part that `rest` starts with.
    for (let len = Math.min(part.length, rest.length); len >= 3; len--) {
      if (rest.startsWith(part.slice(0, len))) { took = len; break; }
    }
    if (!took) return false;
    rest = rest.slice(took);
  }
  // Trailing "official", "real" and the like are fine; anything longer is
  // probably a different account that merely starts the same way.
  return rest.length <= 8;
}

/**
 * Find [name]'s real handle on [platform], or null.
 *
 * @param {string} name      the person as the user said it
 * @param {string} platform  instagram | x | facebook | youtube | linkedin
 * @param {object} ctx       passed through to the search provider
 */
async function resolve(name, platform, ctx = {}) {
  const who = String(name || "").trim();
  const rx = PROFILE_RX[platform];
  if (!who || !rx) return null;

  const key = `${platform}:${norm(who)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.handle;

  let res;
  try {
    // The platform name is in the query so the results are profile pages
    // rather than news about the person.
    res = await webSearch.run(`${who} official ${platform} profile`, ctx);
  } catch (_) {
    return null;
  }
  if (!res || !res.ok || !Array.isArray(res.data)) return null;

  const seen = new Map(); // handle -> best score
  const offer = (h) => {
    if (!h) return;
    const clean = String(h).replace(/^@/, "");
    if (NOT_A_HANDLE.has(clean.toLowerCase())) return;
    const sc = score(clean, who);
    if (sc <= 0) return;
    if (!seen.has(clean) || seen.get(clean) < sc) seen.set(clean, sc);
  };

  for (const r of res.data) {
    // PROFILE URLs — how Brave, Tavily and Google CSE return it.
    for (const text of [r.url, r.snippet, r.title]) {
      if (!text) continue;
      for (const m of String(text).matchAll(new RegExp(rx.source, "gi"))) offer(m[1]);
    }
    // @HANDLES IN PROSE — how GEMINI GROUNDING returns it, which is the
    // provider actually in use here. Its result URLs are
    // vertexaisearch redirects, so nothing matches the profile pattern;
    // the answer text, however, says "...profile is @virat.kohli". Reading
    // only URLs found nothing for anybody, famous or not.
    const prose = `${r.snippet || ""} ${r.title || ""}`;
    for (const m of prose.matchAll(/@([A-Za-z0-9._]{2,30})\b/g)) offer(m[1]);
  }
  if (!seen.size) return null;

  const [best, bestScore] = [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
  // A weak match is worse than none: opening the wrong person's account is
  // the failure being fixed, so an uncertain result falls back to search.
  if (bestScore < 60) return null;

  cache.set(key, { ts: Date.now(), handle: best });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return best;
}

/** Test seam. */
function _clear() {
  cache.clear();
}

module.exports = { resolve, score, PROFILE_RX, NOT_A_HANDLE, _clear };
