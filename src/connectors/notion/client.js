/**
 * NOTION — the REST client. Deliberately small.
 *
 *   • Every path is built from constants plus ids that passed isId(): no
 *     user or model text reaches a URL, and nothing from a Notion response
 *     (links, icons, next_url) is ever fetched. The host is API_BASE.
 *   • Calls for one user run one after another (Notion allows about three
 *     requests a second per connection).
 *   • 401 → one refresh, shared by concurrent callers, then one retry.
 *   • 429 → one retry when Retry-After is 3 s or less, else "busy".
 *   • A WRITE that times out is never retried: "uncertain", because it may
 *     have gone in.
 */
const config = require("./config");
const store = require("./store");
const oauth = require("./oauth");

class NotionError extends Error {
  constructor(kind, message = "") {
    super(message || kind);
    this.kind = kind;
  }
}

const HEX32 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A Notion id, dashed and lower-cased, or null. */
function normId(s) {
  const v = String(s || "").trim().toLowerCase();
  if (UUID.test(v)) return v;
  if (HEX32.test(v)) {
    return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20)}`;
  }
  return null;
}
const isId = (s) => normId(s) !== null;

function idPath(id) {
  const v = normId(id);
  if (!v) throw new NotionError("rejected", "not a Notion id");
  return v;
}

/* Per-user serialisation. */
const chains = new Map();
function serial(uid, fn) {
  const prev = chains.get(uid) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  chains.set(uid, tail);
  tail.then(() => { if (chains.get(uid) === tail) chains.delete(uid); });
  return next;
}

/* Single-flight refresh per user. */
const refreshing = new Map();
async function refreshFor(uid, staleToken) {
  if (refreshing.has(uid)) return refreshing.get(uid);
  const p = (async () => {
    const cur = await store.load(uid);
    if (!cur || !cur.secrets) throw new NotionError("notion_reconnect");
    // Someone else refreshed while we waited: use theirs, never replay a
    // rotated refresh token.
    if (cur.secrets.access_token !== staleToken) return cur.secrets.access_token;
    if (!cur.secrets.refresh_token) {
      await store.markNeedsReconnect(uid, "access expired and no refresh token");
      throw new NotionError("notion_reconnect");
    }
    let tok;
    try {
      tok = await oauth.refresh(cur.secrets.refresh_token);
    } catch (e) {
      if (e.code === "invalid_grant" || e.code === "unauthorized" || e.code === "invalid_client") {
        await store.markNeedsReconnect(uid, `refresh failed: ${e.code}`);
        throw new NotionError("notion_reconnect");
      }
      throw new NotionError("unavailable");
    }
    const pair = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || cur.secrets.refresh_token,
    };
    await store.setTokens(uid, pair); // persisted BEFORE use
    return pair.access_token;
  })();
  refreshing.set(uid, p);
  try {
    return await p;
  } finally {
    refreshing.delete(uid);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function once(token, method, path, body) {
  return fetch(`${config.API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": config.NOTION_VERSION(),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

async function errorOf(res) {
  let j = {};
  try { j = await res.json(); } catch (_) { /* no body */ }
  const code = String(j.code || "");
  const msg = String(j.message || "").replace(/\s+/g, " ").slice(0, 120);
  if (res.status === 403) return new NotionError("no_permission", msg);
  if (res.status === 404) return new NotionError("not_shared", msg);
  if (res.status === 400) return new NotionError("rejected", msg || code);
  if (res.status === 429) return new NotionError("busy");
  return new NotionError("unavailable", `http ${res.status}`);
}

/**
 * One Notion request as `uid`. `path` must be built by the helpers below.
 */
function call(uid, method, path, body, { write = false } = {}) {
  const id = Number(uid);
  return serial(id, async () => {
    const conn = await store.load(id);
    if (!conn) throw new NotionError("not_connected");
    if (!conn.secrets || conn.row.status !== "connected") throw new NotionError("notion_reconnect");
    let token = conn.secrets.access_token;
    let refreshed = false;
    let retried = false;
    for (;;) {
      let res;
      try {
        res = await once(token, method, path, body);
      } catch (e) {
        if (write) throw new NotionError("uncertain");
        throw new NotionError("unavailable");
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        token = await refreshFor(id, token);
        continue;
      }
      if (res.status === 401) {
        await store.markNeedsReconnect(id, "unauthorized after refresh");
        throw new NotionError("notion_reconnect");
      }
      if (res.status === 429 && !retried) {
        const wait = Number(res.headers.get("retry-after"));
        if (Number.isFinite(wait) && wait >= 0 && wait <= 3) {
          retried = true;
          await sleep(wait * 1000);
          continue;
        }
        throw new NotionError("busy");
      }
      if (res.status === 409 && !write && !retried) {
        retried = true;
        continue;
      }
      if (!res.ok) {
        if (res.status >= 500 && write) throw new NotionError("uncertain");
        throw await errorOf(res);
      }
      try {
        return await res.json();
      } catch (_) {
        return {};
      }
    }
  });
}

/* ---- helpers: every path from constants + validated ids ---- */

function search(uid, { query, kind = "any", limit = 5 }) {
  const body = {
    query: String(query || "").slice(0, 200),
    sort: { direction: "descending", timestamp: "last_edited_time" },
    page_size: Math.min(Math.max(Number(limit) || 5, 1), 10),
  };
  if (kind === "page") body.filter = { property: "object", value: "page" };
  if (kind === "database") body.filter = { property: "object", value: "data_source" };
  return call(uid, "POST", "/search", body);
}
const getPage = (uid, id) => call(uid, "GET", `/pages/${idPath(id)}`);
const getDatabase = (uid, id) => call(uid, "GET", `/databases/${idPath(id)}`);
const getDataSource = (uid, id) => call(uid, "GET", `/data_sources/${idPath(id)}`);
const queryDataSource = (uid, id, { pageSize = 15 } = {}) =>
  call(uid, "POST", `/data_sources/${idPath(id)}/query`, { page_size: pageSize });
const blockChildren = (uid, id, { pageSize = 50 } = {}) =>
  call(uid, "GET", `/blocks/${idPath(id)}/children?page_size=${Math.min(Number(pageSize) || 50, 100)}`);

async function pageMarkdown(uid, id) {
  try {
    const r = await call(uid, "GET", `/pages/${idPath(id)}/markdown`);
    if (r && typeof r.markdown === "string") return r.markdown;
  } catch (e) {
    if (e.kind !== "rejected" && e.kind !== "not_shared") throw e;
  }
  // Fallback: plain text from the page's blocks.
  const kids = await blockChildren(uid, id);
  return (kids.results || []).map((b) => {
    const t = b[b.type] && b[b.type].rich_text;
    const text = Array.isArray(t) ? t.map((x) => x.plain_text || (x.text && x.text.content) || "").join("") : "";
    if (b.type === "to_do") return `- [${b.to_do.checked ? "x" : " "}] ${text}`;
    if (/list_item$/.test(b.type)) return `- ${text}`;
    return text;
  }).filter(Boolean).join("\n");
}

const appendBlocks = (uid, pageId, children) =>
  call(uid, "PATCH", `/blocks/${idPath(pageId)}/children`,
    { children, position: { type: "end" } }, { write: true });

const createPage = (uid, { parent, properties, children }) =>
  call(uid, "POST", "/pages",
    { parent, properties, ...(children && children.length ? { children } : {}) }, { write: true });

module.exports = {
  call, search, getPage, getDatabase, getDataSource, queryDataSource, blockChildren,
  pageMarkdown, appendBlocks, createPage, NotionError, isId, normId,
};
