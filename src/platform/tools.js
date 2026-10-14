/**
 * THE MAIN ASSISTANT KNOWS WHAT HAPPENED IN THE USER'S OWN APPS.
 *
 * "What happened in <my app>?" asked in My Assistant is answered from the
 * connected app's activity and records (src/platform/store.js search).
 * The tool is offered only on the turns that need it — wantsApps() below
 * matches the words of the user's own apps (their names and the keywords
 * given when connecting them) plus a few generic phrases — and always to a
 * live voice session of a user who has connected apps (its tools are fixed
 * when it opens).
 */
const store = require("./store");

const GENERIC = /\b(connected apps?|my apps?|custom apps?|my own app|the app i (made|built)|apps? i (made|built))\b/i;

// Per user, a minute: the words that mean "one of my apps".
const cache = new Map(); // uid -> { at, rx, count }
const TTL_MS = 60_000;

function escape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function wordsFor(uid) {
  const hit = cache.get(uid);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  let apps = [];
  try { apps = (await store.listApps(uid)).filter((a) => a.status === "active"); } catch (_) {}
  const words = new Set();
  for (const a of apps) {
    for (const w of String(a.name).toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.length >= 4 && w !== "app") words.add(w);
    if (a.name.trim().length >= 3) words.add(a.name.trim().toLowerCase());
    for (const k of a.keywords || []) if (k.length >= 3) words.add(k);
  }
  const rx = words.size ? new RegExp(`\\b(${[...words].map(escape).join("|")})\\b`, "iu") : null;
  const out = { at: Date.now(), rx, count: apps.length };
  cache.set(uid, out);
  return out;
}

function forget(uid) {
  cache.delete(Number(uid));
}

/** Does this turn plausibly ask about one of the user's connected apps? */
async function wantsApps(uid, text) {
  const id = Number(uid);
  if (!(id > 0)) return false;
  const w = await wordsFor(id);
  if (!w.count) return false;
  const t = String(text || "");
  return GENERIC.test(t) || Boolean(w.rx && w.rx.test(t));
}

async function hasApps(uid) {
  const id = Number(uid);
  if (!(id > 0)) return false;
  return (await wordsFor(id)).count > 0;
}

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
};

function registerPlatformTools(registry) {
  registry.register({
    name: "connected_apps",
    risk: "low",
    effects: ["read"],
    description:
      "What happened in the user's OWN connected apps — apps they built themselves and connected to you with the My Assistant API " +
      "(anything they built). Use for 'what happened in <app>', 'what's my latest in <app>', 'what did I do in " +
      "<app>', 'which apps have I connected'. Without app/query it lists the connected apps and each one's latest activity; " +
      "with them it searches that app's activity and saved records. Answer from what it returns, briefly.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "The app's name, if they named one as they said it." },
        query: { type: "string", description: "What they want to know about, in a few words (e.g. 'last match result')." },
      },
    },
    async execute(args, ctx) {
      const uid = Number(ctx && ctx.userId);
      if (!(uid > 0)) return { ok: false, error: "not signed in" };
      const apps = await store.listApps(uid);
      if (!apps.length) {
        return { ok: true, speak: "No apps are connected yet. Apps you build are connected in the Developer Console on the web.", data: { apps: [] } };
      }
      const want = String(args.app || "").toLowerCase().trim();
      // Every app the name fits (two apps may share a name): exact first,
      // then a looser match on the name or its keywords.
      let matched = want ? apps.filter((a) => a.name.toLowerCase() === want || a.slug === want) : [];
      if (want && !matched.length) {
        matched = apps.filter((a) => a.name.toLowerCase().includes(want) || want.includes(a.name.toLowerCase()) ||
          (a.keywords || []).some((k) => want.includes(k)));
      }
      const app = matched[0] || null;
      const appIds = matched.map((a) => a.id);
      if (want && !app) {
        return { ok: true, speak: `There is no connected app called ${args.app}. Connected: ${apps.map((a) => a.name).join(", ")}.`, data: { apps: apps.map((a) => a.name) } };
      }
      const q = String(args.query || "");
      if (!app && !q) {
        const lines = [];
        for (const a of apps) {
          const last = (await store.listEvents(uid, a.id, { limit: 1 }))[0];
          lines.push(`${a.name}${a.status !== "active" ? " (paused)" : ""}: ${last ? `${last.summary} (${ago(last.createdAt)})` : "no activity yet"}`);
        }
        return { ok: true, speak: lines.join("\n"), data: { apps: apps.map((a) => ({ name: a.name, description: a.description })) } };
      }
      let found = await store.search(uid, { appIds, q, limit: 8 });
      // Nothing matched the words: the app's newest is still the best answer.
      if (q && !found.events.length && !found.records.length) found = await store.search(uid, { appIds, q: "", limit: 6 });
      const name = (id) => (apps.find((a) => a.id === id) || {}).name || "an app";
      const lines = [
        ...found.events.map((e) => `[${name(e.appId)}, ${ago(e.createdAt)}] ${e.summary}`),
        ...found.records.map((r) => `[${name(r.appId)} ${r.collection}/${r.id}, updated ${ago(r.updatedAt)}] ` +
          (r.summary || JSON.stringify(r.data).slice(0, 300))),
      ];
      if (!lines.length) return { ok: true, speak: `${app ? app.name : "Your apps"} has no activity saved yet.` };
      return { ok: true, speak: lines.slice(0, 14).join("\n") };
    },
  });
}

module.exports = { registerPlatformTools, wantsApps, hasApps, forget };
