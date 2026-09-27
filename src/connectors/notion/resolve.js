/**
 * NOTION — which page or database did they mean?
 *
 * Order: an explicit link or id; then the page last written to, when they
 * named none ("my list", "the same page"); then a TITLE search (Notion's
 * search matches titles only): an exact case-insensitive match wins, a
 * single hit wins, anything else is ambiguous.
 *
 * strict (live voice, where nothing was pinned before the yes): only an
 * explicit id, the last page, or an EXACT title is accepted. A single
 * fuzzy hit comes back as ambiguous — never written to.
 */
const client = require("./client");
const store = require("./store");
const { plainTitle, safeTitle } = require("./format");

const LINK_ID = /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[?#].*)?$/i;

/** The id at the end of a Notion link (or a bare id), dashed; else null. */
function idFromText(s) {
  const t = String(s || "").trim();
  if (!t) return null;
  const m = LINK_ID.exec(t);
  if (!m) return null;
  // A bare id, or the tail of something that looks like a link.
  const before = t.slice(0, m.index);
  if (before && !/(^|[/\-])$/.test(before) && !/notion\.(so|site)/i.test(t)) return null;
  return client.normId(m[1]);
}

const SAME = /^(my list|the list|same|the same|the same page|same page|that page|that list|it|there|last|the last one|last page)$/i;

const edited = (o) => String((o && o.last_edited_time) || "").slice(0, 10);

/** A database's data sources, as targets. One → the target; several → ambiguous. */
async function fromDatabase(uid, db) {
  const sources = Array.isArray(db.data_sources) ? db.data_sources : [];
  const dbTitle = plainTitle(db) || "Untitled";
  if (sources.length === 1) {
    return { ok: true, target: { kind: "data_source", id: client.normId(sources[0].id), title: safeTitle(dbTitle), url: db.url || "" } };
  }
  if (!sources.length) return { none: true };
  return {
    ambiguous: sources.slice(0, 3).map((s) => ({ title: safeTitle(`${dbTitle} — ${s.name || "source"}`), kind: "database", edited: "" })),
  };
}

/** Whatever this id is: a page, a database, or a data source. */
async function byId(uid, id) {
  try {
    const p = await client.getPage(uid, id);
    return { ok: true, target: { kind: "page", id: client.normId(p.id), title: safeTitle(plainTitle(p)), url: p.url || "" } };
  } catch (e) {
    if (e.kind !== "not_shared" && e.kind !== "rejected") throw e;
  }
  try {
    return await fromDatabase(uid, await client.getDatabase(uid, id));
  } catch (e) {
    if (e.kind !== "not_shared" && e.kind !== "rejected") throw e;
  }
  try {
    const ds = await client.getDataSource(uid, id);
    return { ok: true, target: { kind: "data_source", id: client.normId(ds.id), title: safeTitle(plainTitle(ds)), url: ds.url || "" } };
  } catch (e) {
    if (e.kind !== "not_shared" && e.kind !== "rejected") throw e;
  }
  return { none: true };
}

/** The current state of a pinned target: its title, or null when gone. */
async function refetch(uid, kind, id) {
  if (!client.isId(id)) return null;
  try {
    if (kind === "data_source") {
      const ds = await client.getDataSource(uid, id);
      return ds.in_trash ? null : safeTitle(plainTitle(ds));
    }
    const p = await client.getPage(uid, id);
    return p.in_trash || p.archived ? null : safeTitle(plainTitle(p));
  } catch (e) {
    if (e.kind === "not_shared" || e.kind === "no_permission") return null;
    throw e;
  }
}

async function lastTarget(uid) {
  const conn = await store.load(uid);
  const last = conn && conn.row && conn.row.defaults && conn.row.defaults.last;
  if (!last || !client.isId(last.id)) return null;
  return { kind: last.kind === "data_source" ? "data_source" : "page", id: client.normId(last.id), title: safeTitle(last.title), url: "" };
}

/**
 * @returns {ok:true,target} | {ambiguous:[{title,kind,edited}]} | {none:true} | {noTarget:true}
 */
// `want` ("container" | "any") is kept for the callers' intent: pages and
// data sources are both containers, so it does not narrow anything today.
async function resolveTarget(uid, text, { strict = false } = {}) {
  const raw = String(text || "").trim();

  const id = idFromText(raw);
  if (id) return byId(uid, id);

  if (!raw || SAME.test(raw)) {
    const last = await lastTarget(uid);
    return last ? { ok: true, target: last } : { noTarget: true };
  }

  const found = await client.search(uid, { query: raw, kind: "any", limit: 10 });
  const hits = (found.results || [])
    .filter((o) => !o.in_trash && !o.archived)
    .filter((o) => ["page", "data_source", "database"].includes(o.object))
    .map((o) => ({ obj: o, title: plainTitle(o) || "Untitled" }));
  if (!hits.length) return { none: true };

  const exact = hits.filter((h) => h.title.trim().toLowerCase() === raw.toLowerCase());
  const pick = exact.length === 1 ? exact[0] : !strict && hits.length === 1 ? hits[0] : null;
  if (pick) {
    const o = pick.obj;
    if (o.object === "database") return fromDatabase(uid, o);
    return {
      ok: true,
      target: {
        kind: o.object === "data_source" ? "data_source" : "page",
        id: client.normId(o.id), title: safeTitle(pick.title), url: o.url || "",
      },
    };
  }
  const pool = exact.length > 1 ? exact : hits;
  return {
    ambiguous: pool.slice(0, 3).map((h) => ({
      title: safeTitle(h.title), kind: h.obj.object === "page" ? "page" : "database", edited: edited(h.obj),
    })),
  };
}

module.exports = { idFromText, resolveTarget, refetch, isId: client.isId };
