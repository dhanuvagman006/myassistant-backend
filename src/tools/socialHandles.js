/**
 * WHOSE PROFILE IS THIS, ACTUALLY?
 * ----------------------------------------------------------------------
 * open_app used to take a handle the MODEL remembered. For a globally
 * famous account that recall is often right; for anyone else it is a guess
 * dressed as a fact, and a guessed handle is worse than none — it opens a
 * stranger's account while saying the person's name aloud.
 *
 * So the handle is established rather than recalled, for anybody the user
 * names, on any platform they name. Candidates come from a web search and
 * from the shapes usernames ordinarily take; each is then CHECKED against
 * the live profile page, which states who it belongs to.
 *
 * Nothing here invents a handle. When no candidate's page carries the
 * person's name, this returns null and the caller falls back to a search —
 * showing a choice rather than confidently opening the wrong person.
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
 * Strip what describes the person from what IS their name.
 *
 * The model passes what the user said, and people say "open actor X's
 * Instagram" or "the cricketer Y". Scoring then demanded the handle
 * contain the describing word too, which pushed real accounts below the
 * threshold and fell through to the platform's home feed. A role is not
 * part of anybody's username.
 */
const ROLE_WORDS = new Set([
  "actor", "actress", "singer", "cricketer", "player", "star", "celebrity",
  "famous", "hero", "heroine", "model", "comedian", "director", "producer",
  "politician", "minister", "author", "writer", "dancer", "musician",
  "youtuber", "influencer", "the", "a", "an", "mr", "mrs", "ms", "dr",
  "official", "real", "profile", "account", "page", "id",
]);

function cleanName(name) {
  const kept = String(name || "")
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9'.-]/g, ""))
    .filter((w) => w && !ROLE_WORDS.has(w.toLowerCase()));
  // If stripping left nothing, the words WERE the name — keep the original.
  return kept.length ? kept.join(" ") : String(name || "").trim();
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
  const parts = cleanName(name).trim().split(/\s+/).map(norm).filter((p) => p.length > 1);
  if (!parts.length) return 0;
  const joined = parts.join("");
  if (h === joined) return 100;                        // firstlast
  if (h.replace(/[0-9_.]/g, "") === joined) return 90; // first_last, first.last
  if (h.startsWith(joined)) return 70;                 // firstlastofficial
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
  const who = cleanName(name);
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
  // THE ENCYCLOPEDIA CANNOT ANSWER THIS. When the search providers are
  // rate-limited, webSearch falls back to Wikipedia, which returns
  // articles about whoever has the nearest matching name. Those pages
  // never carry a handle, and a near-miss on a name is exactly how the
  // wrong person's account gets opened.
  if (res.provider === "wikipedia") return null;

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

/* ------------------------------------------------------------------ *
 * VERIFY, DON'T TRUST
 *
 * A profile page states who it belongs to, in its own metadata:
 *
 *   <meta property="og:title"       content="Full Name (@handle) …">
 *   <meta property="og:description" content="1M Followers, …">
 *
 * That turns "which account is theirs?" from a question about memory into
 * one with a checkable answer. A handle only opens if the page it points
 * at carries the person's name, so a remembered-but-wrong username is
 * caught instead of opened.
 *
 * It also means the lookup does not depend on the search quota, which is
 * small and rate-limits in ordinary use.
 * ------------------------------------------------------------------ */

const PROFILE_URL = {
  instagram: (h) => `https://www.instagram.com/${h}/`,
  facebook: (h) => `https://www.facebook.com/${h}`,
  x: (h) => `https://x.com/${h}`,
  youtube: (h) => `https://www.youtube.com/@${h}`,
  linkedin: (h) => `https://www.linkedin.com/in/${h}`,
};

/** Names a person plausibly uses, in the order they are worth trying. */
function candidatesFrom(name) {
  const parts = cleanName(name).toLowerCase().split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean);
  if (!parts.length) return [];
  const joined = parts.join("");
  const out = [
    joined,
    parts.join("."),
    parts.join("_"),
    `iam${joined}`,
    `${joined}official`,
    `thereal_${joined}`,
  ];
  return [...new Set(out)].filter((h) => h.length >= 3 && h.length <= 30);
}

/**
 * How many people follow this account: "1M", "12.3K", "1,275".
 *
 * The word "Followers" is only there in English. A page served in the
 * viewer's own language puts the same number in front of a word this code
 * cannot read — so when the labelled form is absent, the largest number on
 * the line is taken instead. Followers outnumber posts and following on
 * any account this ranking has to decide between.
 */
function followerCount(text) {
  const t = String(text || "");
  const m = t.match(/([\d.,]+)\s*([KMB])?\s*Followers/i);
  if (m) {
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(n)) {
      const mult = { k: 1e3, m: 1e6, b: 1e9 }[String(m[2] || "").toLowerCase()] || 1;
      return Math.round(n * mult);
    }
  }
  let best = 0;
  for (const g of t.matchAll(/([\d][\d.,]*)\s*([KMB])?\b/gi)) {
    const n = Number(String(g[1]).replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[String(g[2] || "").toLowerCase()] || 1;
    best = Math.max(best, Math.round(n * mult));
  }
  return best;
}

/**
 * What [handle]'s profile page says about itself:
 * { name, followers } — or null when there is no such profile.
 */
/**
 * WHETHER THIS SERVER CAN READ PROFILE PAGES AT ALL.
 *
 * Verification was built and proved against a residential connection. From
 * the VPS, Instagram answers 429 with an empty body — datacenter ranges are
 * rate-limited hard — so every candidate "failed" verification and the
 * lookup fell through to a search for everybody.
 *
 * One blocked response is remembered for a while so the next lookup does
 * not spend seven futile requests discovering the same thing, and the
 * caller degrades to search-derived handles instead of stalling.
 */
const BLOCKED_FOR_MS = 10 * 60_000;
const blockedUntil = new Map(); // platform -> ts

function inspectionBlocked(platform) {
  const until = blockedUntil.get(platform) || 0;
  return Date.now() < until;
}

async function inspect(handle, platform) {
  const make = PROFILE_URL[platform];
  if (!make || !handle) return null;
  if (inspectionBlocked(platform)) return null;
  try {
    const r = await fetch(make(handle), {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile",
      },
      signal: AbortSignal.timeout(6000),
    });
    if (r.status === 429 || r.status === 403) {
      // The platform is refusing this server, not denying the account.
      blockedUntil.set(platform, Date.now() + BLOCKED_FOR_MS);
      return null;
    }
    if (!r.ok) return null;
    const html = await r.text();
    const t = html.match(/<meta property="og:title" content="([^"]*)"/i);
    if (!t) return null; // no such profile
    const d = html.match(/<meta property="og:description" content="([^"]*)"/i);
    return {
      // The displayed name, before the "(@handle)" part.
      name: t[1].split("(")[0].replace(/&[a-z]+;/gi, " ").trim(),
      followers: followerCount(d && d[1]),
    };
  } catch (_) {
    return null;
  }
}

/** Whether [handle]'s profile page actually belongs to [name]. */
async function verify(handle, name, platform) {
  const got = await inspect(handle, platform);
  return Boolean(got && score(norm(got.name), name) >= 60);
}

/**
 * The handle for [name], checked against the live profile page.
 * Tries what the search suggested first, then the shapes people actually
 * use, and returns the first that the page itself confirms.
 */
async function resolveVerified(name, platform, ctx = {}) {
  const who = cleanName(name);
  if (!who || !PROFILE_URL[platform]) return null;

  const key = `v:${platform}:${norm(who)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.handle;

  const fromSearch = await resolve(name, platform, ctx).catch(() => null);
  const tries = [...new Set([fromSearch, ...candidatesFrom(who)].filter(Boolean))]
    .slice(0, 7); // bounded: this is one network call each

  // THE BIGGEST MATCHING ACCOUNT WINS.
  //
  // Several real people share a name, and checking the name alone cannot
  // tell them apart — a namesake with a handful of followers reads exactly
  // like the public figure. When someone asks for a person by name, the
  // account the world means is the one the world follows, so matches are
  // ranked by reach. For an uncommon name there is a single match and the
  // ranking decides nothing.
  const checked = await Promise.all(
    tries.map(async (h) => {
      const got = await inspect(h, platform);
      if (!got) return null;
      const s = score(norm(got.name), who);
      return s >= 60 ? { handle: h, followers: got.followers, s } : null;
    })
  );
  const matches = checked.filter(Boolean).sort((a, b) => b.followers - a.followers);
  if (!matches.length) return null;

  const best = matches[0].handle;
  cache.set(key, { ts: Date.now(), handle: best });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return best;
}

/** Test seam. */
function _clear() {
  cache.clear();
}

module.exports = {
  resolve, resolveVerified, verify, inspect, inspectionBlocked, followerCount, candidatesFrom,
  score, cleanName, PROFILE_RX, NOT_A_HANDLE, _clear,
};
