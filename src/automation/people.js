/**
 * WHO THEY MEANT — the real account, not the first name that matches.
 *
 * "Open Instagram and follow Neha Shetty actor" once followed
 * @neha_shetty_actor, a lookalike: the run searched Instagram for the
 * owner's exact words and took the top hit, while her own account is the
 * verified @iamnehashetty (owner's report, 2026-09-24). People do not know handles
 * and should never need to. So before the hands touch a social app for a
 * person, their OFFICIAL account is looked up on the web — the profile link
 * search engines rank for that person. Where the app opens profile links
 * reliably the run starts on that profile; Instagram does not (a profile
 * link from outside the app leaves a blank page, measured on the owner's
 * phone 2026-09-24), so there the run searches the exact username inside
 * the app — which lists the verified account first. Either way the planner
 * checks the profile (name, verified tick) before it taps Follow, and asks
 * when it is not sure.
 *
 * Nothing here decides alone: a lookup that finds nothing convincing
 * returns null and the run searches inside the app as before, with the
 * planner's own rules for choosing the real account.
 */

const SITES = {
  instagram: {
    label: "Instagram",
    host: /(?:^|\.)instagram\.com$/i,
    handle: /^[a-z0-9._]{1,30}$/i,
    reserved: new Set(["p", "reel", "reels", "explore", "stories", "accounts", "about",
      "developer", "legal", "tv", "direct", "web", "popular", "directory", "topics"]),
    fromPath: (segs) => segs[0],
    url: (h) => `https://www.instagram.com/${h}/`,
    // Profile links from outside the app open a blank page: search instead.
    openLink: false,
    inText: /instagram\.com\/([a-z0-9._]{1,30})/ig,
  },
  youtube: {
    label: "YouTube",
    host: /(?:^|\.)youtube\.com$/i,
    handle: /^[a-z0-9._-]{3,30}$/i,
    reserved: new Set(),
    // Only @handles: /watch, /channel/UC…, /c/… are not a person's handle.
    fromPath: (segs) => (segs[0] && segs[0].startsWith("@") ? segs[0].slice(1) : ""),
    url: (h) => `https://www.youtube.com/@${h}`,
    openLink: true,
    inText: /youtube\.com\/@([a-z0-9._-]{3,30})/ig,
  },
  twitter: {
    label: "X",
    host: /(?:^|\.)(?:x|twitter)\.com$/i,
    handle: /^[a-z0-9_]{1,15}$/i,
    reserved: new Set(["home", "search", "i", "intent", "share", "hashtag", "explore",
      "settings", "login", "signup", "tos", "privacy", "messages", "notifications"]),
    fromPath: (segs) => segs[0],
    url: (h) => `https://x.com/${h}`,
    openLink: true,
    inText: /(?:x|twitter)\.com\/([a-z0-9_]{1,15})/ig,
  },
};

// Things done TO a person or page — the only tasks that need their account.
// The social verbs come first: in "open Instagram and follow X" the person
// is after "follow", not after "open".
const PERSON_ACTION =
  /\b(?:follow|unfollow|subscribe(?:\s+to)?|unsubscribe(?:\s+from)?|like\s+(?:the\s+)?(?:latest|last|recent|new)?\s*(?:post|photo|reel|video)s?\s+(?:of|by|from)|turn on notifications for)\s+/i;
const PERSON_VIEW = /\b(?:see|view|open|check|find|visit)\s+/i;
// Words that describe WHO, not part of the name — kept to sharpen the search.
const DESCRIPTOR =
  /\b(?:actor|actress|singer|cricketer|player|footballer|athlete|politician|minister|director|producer|comedian|youtuber|influencer|creator|model|author|writer|journalist|anchor|chef|musician|band|rapper|dancer|official|verified|real)\b/ig;
const NOISE =
  /\b(?:the|his|her|their|account|page|profile|channel|handle|id|on|in|at|from|instagram|insta|ig|youtube|yt|twitter|x|app|please|for me|now)\b/ig;
// Lookalikes a person's name attracts.
const LOOKALIKE = /(?:^|[._\s-])(?:fan|fans|fc|fanclub|fanpage|fp|club|army|updates?|world|daily|parody|edits?|stan)(?:$|[._\s-])|(?:fan|fans|updates|edits)$/i;

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const tokens = (s) => clean(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

/**
 * The person named in a social task, or null.
 *   "Open Instagram and follow Neha Shetty actor" -> { name: "Neha Shetty", hint: "actor" }
 */
function personIn(goal) {
  const g = clean(goal).replace(/[“”"]/g, "");
  const m = g.match(PERSON_ACTION) || g.match(PERSON_VIEW);
  if (!m) return null;
  let rest = g.slice(m.index + m[0].length);
  // Stop at the next clause: "follow X and like her last post".
  rest = rest.split(/\s+(?:and|then|also|&)\s+|[,.;!?]/i)[0];
  const hints = (rest.match(DESCRIPTOR) || []).map((w) => w.toLowerCase());
  const name = clean(rest.replace(DESCRIPTOR, " ").replace(NOISE, " ").replace(/^@/, ""));
  if (!name || name.length < 3 || name.split(" ").length > 5) return null;
  // "follow the latest post" — no person there.
  if (/^(?:(?:latest|last|recent|new|this|that|it|them|him|her|back|post|posts|photo|reel|video|story|stories)\s*)+$/i.test(name)) return null;
  return { name, hint: [...new Set(hints)].filter((h) => !/official|verified|real/.test(h)).join(" ") };
}

/** Candidate handles from search results, in rank order. */
function candidates(site, results) {
  const out = [];
  const seen = new Set();
  results.slice(0, 8).forEach((r, rank) => {
    const found = [];
    try {
      const u = new URL(String(r.url || ""));
      if (site.host.test(u.hostname)) {
        const h = site.fromPath(u.pathname.split("/").filter(Boolean));
        if (h) found.push(h);
      }
    } catch (_) {}
    const text = `${r.title || ""} ${r.snippet || ""} ${r.url || ""}`;
    for (const m of text.matchAll(site.inText)) found.push(m[1]);
    // "Neha Shetty (@imnehashetty) • Instagram photos and videos"
    const at = String(r.title || "").match(/\(@([a-z0-9._-]{1,30})\)/i);
    if (at && new RegExp(site.label, "i").test(text)) found.push(at[1]);
    for (let h of found) {
      h = h.replace(/[.]+$/, "");
      const key = h.toLowerCase();
      if (!site.handle.test(h) || site.reserved.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ handle: h, rank, title: clean(r.title), snippet: clean(r.snippet).slice(0, 300) });
    }
  });
  return out;
}

/**
 * Picks the account the person themselves runs. Rank matters most (search
 * engines put the official profile first); the person's name in the title
 * confirms it; fan, update and parody pages never win.
 */
function pick(site, person, results) {
  const want = tokens(person.name);
  const scored = candidates(site, results).map((c) => {
    const title = c.title.toLowerCase();
    const nameHits = want.filter((t) => title.includes(t) || c.handle.toLowerCase().includes(t)).length;
    let score = 10 - c.rank * 1.5 + nameHits * 3;
    // "Neha Shetty (@iamnehashetty) • Instagram photos and videos" is the
    // profile page's own title — the strongest sign it is theirs.
    if (new RegExp(`\\(@${c.handle.replace(/[.]/g, "\\.")}\\)`, "i").test(c.title)) score += 3;
    if (/verified|official/i.test(`${c.title} ${c.snippet}`)) score += 2;
    if (LOOKALIKE.test(c.handle) || /\bfan (?:page|account|club)\b|\bparody\b|\bupdates\b/i.test(c.title)) score = -99;
    return { ...c, nameHits, score };
  }).filter((c) => c.score > 0 && c.nameHits > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const best = scored[0];
  // Two strong, different candidates close together: not sure enough to
  // open one of them on the owner's behalf — the planner decides in the app.
  const runnerUp = scored[1];
  const confident = best.nameHits >= Math.min(2, want.length) &&
    (!runnerUp || best.score - runnerUp.score >= 2);
  return { handle: best.handle, confident, alternatives: scored.slice(1, 3).map((c) => c.handle) };
}

/**
 * The official account for a social task, or null.
 * @returns {{app, name, handle, url, confident, alternatives, query}|null}
 */
async function resolveAccount(appName, goal, { search, timeoutMs = 6000 } = {}) {
  const site = SITES[String(appName || "").toLowerCase()];
  if (!site) return null;
  const person = personIn(goal);
  if (!person) return null;
  const query = clean(`${person.name} ${person.hint} official ${site.label} account`);
  const run = search || ((q) => require("../tools/webSearch").run(q));
  let res;
  try {
    res = await Promise.race([
      run(query),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch (_) {
    return null;
  }
  if (!res || res.ok === false || !Array.isArray(res.data) || res.provider === "wikipedia") return null;
  const hit = pick(site, person, res.data);
  if (!hit) return null;
  return {
    app: appName, name: person.name, handle: hit.handle, url: site.url(hit.handle),
    // Where the run may start: the profile itself, or (Instagram) nowhere
    // special — the planner searches the handle in the app.
    openUrl: site.openLink ? site.url(hit.handle) : "",
    confident: hit.confident, alternatives: hit.alternatives, query, label: site.label,
  };
}

module.exports = { resolveAccount, personIn, pick, candidates, SITES };
