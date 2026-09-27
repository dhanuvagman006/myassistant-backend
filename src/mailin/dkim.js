/**
 * BILLS BY EMAIL — DKIM and DMARC, and nothing else (spec §1, §5.3 step 2).
 *
 * Written here rather than pulled in as a package: the only network
 * traffic is DNS TXT lookups (the selector key and _dmarc), each bounded,
 * through a resolver the tests replace. No SPF (the sender IP is not
 * trustworthy behind klipper-lb, and forwarded mail fails SPF anyway), no
 * ARC, no BIMI — BIMI would resolve logo URLs, and a stranger's mail must
 * never trigger an HTTP fetch.
 *
 * Supported: rsa-sha256 with relaxed or simple canonicalization, which is
 * what bill senders and the big mailbox providers sign with. Anything
 * else (ed25519, rsa-sha1, an l= body length) counts as not signed, which
 * only ever makes mail LESS trusted.
 */
const crypto = require("crypto");
const dns = require("dns");

const DNS_TIMEOUT_MS = 5000;
const MAX_SIGNATURES = 3;

// Suffixes under which a registrant gets the third label — enough for the
// organisational-domain rule (DMARC relaxed alignment) on Indian and
// common foreign billers. Unknown ones fall back to the last two labels,
// which can only make alignment STRICTER, never looser.
const MULTI_SUFFIX = new Set([
  "co.in", "net.in", "org.in", "gov.in", "ac.in", "edu.in", "res.in", "nic.in", "firm.in",
  "gen.in", "ind.in", "mil.in", "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au",
  "org.au", "co.jp", "com.sg", "com.my", "co.za", "co.nz", "com.br", "com.cn", "com.hk",
]);

function orgDomain(domain) {
  const labels = String(domain || "").toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const last2 = labels.slice(-2).join(".");
  return MULTI_SUFFIX.has(last2) ? labels.slice(-3).join(".") : last2;
}

const defaultResolver = (() => {
  let r = null;
  return (name) => {
    if (!r) r = new dns.promises.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
    return r.resolveTxt(name);
  };
})();

async function txt(resolveTxt, name) {
  let timer;
  try {
    const rows = await Promise.race([
      resolveTxt(name),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("dns timeout")), DNS_TIMEOUT_MS); }),
    ]);
    return (rows || []).map((r) => (Array.isArray(r) ? r.join("") : String(r)));
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Bare LF → CRLF, so a hand-saved .eml canonicalizes the way it was signed. */
function crlf(buf) {
  return Buffer.from(buf.toString("latin1").replace(/\r?\n/g, "\r\n"), "latin1");
}

/** → {headers:[{name, raw}], body:string} (latin1, so bytes survive). */
function split(raw) {
  const s = crlf(raw).toString("latin1");
  let idx = s.indexOf("\r\n\r\n");
  const head = idx >= 0 ? s.slice(0, idx) : s;
  const body = idx >= 0 ? s.slice(idx + 4) : "";
  const headers = [];
  for (const line of head.split("\r\n")) {
    if (/^[ \t]/.test(line) && headers.length) headers[headers.length - 1].raw += "\r\n" + line;
    else if (line.includes(":")) headers.push({ name: line.slice(0, line.indexOf(":")).trim().toLowerCase(), raw: line });
  }
  return { headers, body };
}

function tags(value) {
  const out = {};
  for (const part of value.replace(/\r\n/g, "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).replace(/\s+/g, "");
  }
  return out;
}

function canonHeader(raw, mode) {
  if (mode === "simple") return raw;
  const i = raw.indexOf(":");
  const name = raw.slice(0, i).trim().toLowerCase();
  const value = raw.slice(i + 1).replace(/\r\n/g, "").replace(/[ \t]+/g, " ").trim();
  return `${name}:${value}`;
}

function canonBody(body, mode) {
  let lines = body.split("\r\n");
  if (mode === "relaxed") lines = lines.map((l) => l.replace(/[ \t]+/g, " ").replace(/ $/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (!lines.length) return mode === "relaxed" ? "" : "\r\n";
  return lines.join("\r\n") + "\r\n";
}

function publicKey(p) {
  const der = Buffer.from(p, "base64");
  for (const type of ["spki", "pkcs1"]) {
    try { return crypto.createPublicKey({ key: der, format: "der", type }); } catch (_) {}
  }
  return null;
}

/** One DKIM-Signature header → 'pass' | 'fail' | 'none' (unsupported). */
async function verifyOne(sigHeader, headers, body, resolveTxt, now) {
  const t = tags(sigHeader.raw.slice(sigHeader.raw.indexOf(":") + 1));
  if (t.v !== "1" || t.a !== "rsa-sha256" || !t.d || !t.s || !t.b || !t.bh || !t.h) return { result: "none" };
  if (t.l !== undefined) return { result: "none", domain: t.d.toLowerCase() };
  const [hc, bc = "simple"] = String(t.c || "simple/simple").toLowerCase().split("/");
  const domain = t.d.toLowerCase();
  const signed = t.h.toLowerCase().split(":").map((x) => x.trim()).filter(Boolean);
  if (!signed.includes("from")) return { result: "fail", domain };
  if (t.x && Number(t.x) * 1000 < now) return { result: "fail", domain };

  const bh = crypto.createHash("sha256").update(canonBody(body, bc), "latin1").digest("base64");
  if (bh !== t.bh) return { result: "fail", domain };

  const used = new Map();
  let data = "";
  for (const name of signed) {
    const all = headers.filter((h) => h.name === name && h !== sigHeader);
    const n = used.get(name) || 0;
    const h = all[all.length - 1 - n];
    used.set(name, n + 1);
    if (h) data += canonHeader(h.raw, hc) + "\r\n";
  }
  const emptied = sigHeader.raw.replace(/((?:^|;)\s*b\s*=)[^;]*/i, (m, keep) => keep);
  // The regex also matched the header name part when b= came first; guard:
  data += canonHeader(emptied, hc);

  const records = await txt(resolveTxt, `${t.s}._domainkey.${domain}`);
  const rec = records.map(tags).find((r) => r.p !== undefined);
  if (!rec || !rec.p) return { result: "fail", domain };
  const key = publicKey(rec.p);
  if (!key) return { result: "fail", domain };
  try {
    const ok = crypto.verify("RSA-SHA256", Buffer.from(data, "latin1"), key, Buffer.from(t.b, "base64"));
    return { result: ok ? "pass" : "fail", domain };
  } catch (_) {
    return { result: "fail", domain };
  }
}

/** The header From's single address, lowercased; null when not exactly one. */
function headerFrom(headers) {
  const froms = headers.filter((h) => h.name === "from");
  if (froms.length !== 1) return null;
  const value = froms[0].raw.slice(froms[0].raw.indexOf(":") + 1).replace(/\r\n/g, "");
  let list = [];
  try { list = require("nodemailer/lib/addressparser")(value, { flatten: true }); } catch (_) {}
  if (list.length !== 1 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(list[0].address || "")) return null;
  return String(list[0].address).toLowerCase();
}

/**
 * → { fromAddr, fromDomain, dkim:[{domain,result}], dmarc: 'pass'|'fail'|'none' }
 * DMARC 'pass' = a DMARC record exists for the From domain (or its
 * organisational domain) and a passing DKIM signature is aligned with it.
 */
async function authenticate(raw, { resolveTxt = defaultResolver, now = Date.now() } = {}) {
  const { headers, body } = split(raw);
  const fromAddr = headerFrom(headers);
  const fromDomain = fromAddr ? fromAddr.split("@")[1] : "";
  const sigs = headers.filter((h) => h.name === "dkim-signature").slice(0, MAX_SIGNATURES);
  const dkim = [];
  for (const s of sigs) {
    try { dkim.push(await verifyOne(s, headers, body, resolveTxt, now)); }
    catch (_) { dkim.push({ result: "fail" }); }
  }
  if (!fromDomain) return { fromAddr: "", fromDomain: "", dkim, dmarc: "fail" };

  const org = orgDomain(fromDomain);
  let rec = (await txt(resolveTxt, `_dmarc.${fromDomain}`)).find((r) => /^v=DMARC1\b/i.test(r.trim()));
  if (!rec && org !== fromDomain) {
    rec = (await txt(resolveTxt, `_dmarc.${org}`)).find((r) => /^v=DMARC1\b/i.test(r.trim()));
  }
  if (!rec) return { fromAddr, fromDomain, dkim, dmarc: "none" };
  const strict = tags(rec).adkim === "s";
  const aligned = dkim.some((d) => d.result === "pass" && d.domain &&
    (strict ? d.domain === fromDomain : orgDomain(d.domain) === org));
  return { fromAddr, fromDomain, dkim, dmarc: aligned ? "pass" : "fail" };
}

module.exports = { authenticate, orgDomain, canonBody, canonHeader, split };
