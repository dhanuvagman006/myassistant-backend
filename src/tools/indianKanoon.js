/**
 * INDIAN KANOON — the single legal source on this deployment: India's
 * case law (Supreme Court, every High Court, district courts and
 * tribunals) AND the bare Central Acts and Rules. The doctypes filter
 * decides which of the two a given question searches.
 *
 * THIS API IS BILLED PER REQUEST, PRE-PAID. Published rates (INR):
 *
 *     search             0.50      docfragment        0.05
 *     origdoc            0.50      docmeta            0.02
 *     doc                0.20
 *
 * That shapes the whole design. A naive "search then fetch each judgment"
 * costs 0.50 + 3x0.20 = Rs 1.10 a question and returns tens of thousands
 * of words nobody reads. Fetching the FRAGMENT that matches the query
 * instead costs 0.50 + 3x0.05 = Rs 0.65, and a judgment's relevant
 * paragraph is a better answer than its full text anyway. Full documents
 * are fetched only when the user asks for the judgment itself.
 *
 * Every result is cached for a day in the shared Postgres store. Case law
 * does not change, so a repeat question must never be a repeat charge —
 * and with several users on one account, one person's search answers the
 * next person's for free.
 *
 * Dark until INDIANKANOON_API_TOKEN is set: no key, no tool, and the
 * assistant says it cannot look up judgments rather than inventing one.
 * Inventing case law is the single worst thing a legal assistant can do.
 */
const BASE = "https://api.indiankanoon.org";
const TIMEOUT = 15_000;
const searchCache = require("./searchCache");

function token() {
  return process.env.INDIANKANOON_API_TOKEN || "";
}
function available() {
  return Boolean(token());
}

/** Published price per call, carried into results so spend is visible. */
const PRICE = { search: 0.5, origdoc: 0.5, doc: 0.2, docfragment: 0.05, docmeta: 0.02 };

async function call(path, kind) {
  if (!available()) throw new Error("indiankanoon_not_configured");
  const r = await fetch(BASE + path, {
    method: "POST", // what the official IKAPI client uses
    headers: {
      Accept: "application/json",
      Authorization: `Token ${token()}`,
    },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (r.status === 401 || r.status === 403) {
    throw new Error("indiankanoon auth rejected the token");
  }
  // PRE-PAID MEANS THE BALANCE CAN RUN OUT MID-SENTENCE, and that is an
  // outage, not an absence — the caller must say "I could not search",
  // never "there is no such judgment".
  if (r.status === 402 || r.status === 429) {
    throw new Error("indiankanoon rate limit / balance exhausted");
  }
  if (!r.ok) throw new Error(`indiankanoon ${r.status}`);
  const j = await r.json();
  if (j && j.error) throw new Error(`indiankanoon: ${String(j.error).slice(0, 120)}`);
  return j;
}

/** Strip Indian Kanoon's <p>/<b> markup and its highlight tags. */
function plain(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

const key = (kind, ...parts) =>
  `ik:${kind}:${parts.join(":").toLowerCase().replace(/\s+/g, " ").trim()}`;

/**
 * Judgments matching a query. Rs 0.50 — the expensive call, so it is
 * cached for a day and deduplicated by the exact question asked.
 */
async function search(q, { pagenum = 0, doctypes = "" } = {}) {
  // doctypes rides INSIDE formInput, which is how the API documents it
  // ("doctypes:highcourts,cci"). Useful values: laws (Central Acts and
  // Rules), judgments (Supreme Court, High Courts, District Courts),
  // tribunals, or a named court such as karnataka or supremecourt.
  const formInput = doctypes ? `${q} doctypes:${doctypes}` : q;
  const k = key("search", formInput, pagenum);
  const hit = await searchCache.get(k).catch(() => null);
  if (hit) return { ...hit, cached: true, cost: 0 };

  const j = await call(
    `/search/?formInput=${encodeURIComponent(formInput)}&pagenum=${pagenum}`,
    "search"
  );
  const docs = (j.docs || []).map((d) => ({
    docid: d.tid,
    title: plain(d.title),
    court: plain(d.docsource || ""),
    date: d.publishdate || "",
    // headline is Indian Kanoon's own matched snippet — already the part
    // of the judgment that answers the query.
    snippet: plain(d.headline || "").slice(0, 400),
    citation: plain(d.citation || ""),
    url: d.tid ? `https://indiankanoon.org/doc/${d.tid}/` : "",
  }));
  const out = { found: j.found || "", docs };
  searchCache.put(k, formInput, out, false).catch(() => {});
  return { ...out, cached: false, cost: PRICE.search };
}

/**
 * The passage of one judgment that matches the query. Rs 0.05 — a tenth
 * of the full document and usually the better answer, because it is the
 * paragraph the court actually said it in.
 */
async function fragment(docid, q) {
  const k = key("frag", docid, q);
  const hit = await searchCache.get(k).catch(() => null);
  if (hit) return { ...hit, cached: true, cost: 0 };

  const j = await call(
    `/docfragment/${encodeURIComponent(docid)}/?formInput=${encodeURIComponent(q)}`,
    "docfragment"
  );
  const out = {
    docid,
    title: plain(j.title || ""),
    court: plain(j.docsource || ""),
    date: j.publishdate || "",
    passages: (j.headline || []).map((h) => plain(h)).filter(Boolean).slice(0, 4),
    url: `https://indiankanoon.org/doc/${docid}/`,
  };
  searchCache.put(k, q, out, false).catch(() => {});
  return { ...out, cached: false, cost: PRICE.docfragment };
}

/** Title, court, date and citation only. Rs 0.02. */
async function meta(docid) {
  const k = key("meta", docid);
  const hit = await searchCache.get(k).catch(() => null);
  if (hit) return { ...hit, cached: true, cost: 0 };
  const j = await call(`/docmeta/${encodeURIComponent(docid)}/`, "docmeta");
  const out = {
    docid,
    title: plain(j.title || ""),
    court: plain(j.docsource || ""),
    date: j.publishdate || "",
    citation: plain(j.citation || ""),
    url: `https://indiankanoon.org/doc/${docid}/`,
  };
  searchCache.put(k, "", out, false).catch(() => {});
  return { ...out, cached: false, cost: PRICE.docmeta };
}

/** The whole judgment. Rs 0.20 — only when the judgment itself is wanted. */
async function document(docid) {
  const k = key("doc", docid);
  const hit = await searchCache.get(k).catch(() => null);
  if (hit) return { ...hit, cached: true, cost: 0 };
  const j = await call(`/doc/${encodeURIComponent(docid)}/`, "doc");
  const out = {
    docid,
    title: plain(j.title || ""),
    court: plain(j.docsource || ""),
    date: j.publishdate || "",
    citation: plain(j.citation || ""),
    text: plain(j.doc || "").slice(0, 12_000),
    url: `https://indiankanoon.org/doc/${docid}/`,
  };
  searchCache.put(k, "", out, false).catch(() => {});
  return { ...out, cached: false, cost: PRICE.doc };
}

/**
 * The whole answer to a case-law question in one call, priced to be
 * affordable: one search, then the matching passage of the top few
 * judgments. Capped at three fragments — a fourth adds cost and almost
 * never changes the answer.
 */
async function research(q, { depth = 3, doctypes = "" } = {}) {
  const found = await search(q, { doctypes });
  if (!found.docs.length) return { query: q, docs: [], spent: found.cost };
  let spent = found.cost;
  const top = found.docs.slice(0, Math.max(0, Math.min(depth, 3)));
  const detailed = await Promise.all(
    top.map(async (d) => {
      try {
        const f = await fragment(d.docid, q);
        spent += f.cost;
        return { ...d, passages: f.passages };
      } catch (_) {
        return d; // the search result's own snippet is still useful
      }
    })
  );
  return {
    query: q,
    total: found.found,
    docs: [...detailed, ...found.docs.slice(top.length, 6)],
    spent: Number(spent.toFixed(2)),
  };
}

module.exports = {
  available, search, fragment, meta, document, research, PRICE, plain,
};
