/**
 * SAFE FETCH — fetch() for URLs a user or a model chose.
 * -----------------------------------------------------
 * read_webpage, save_web_document and user MCP servers fetch whatever
 * URL they are handed. With plain fetch that included this server's own
 * neighbourhood: http://127.0.0.1, the cluster's service IPs, the
 * Postgres pod, and the cloud metadata endpoint at 169.254.169.254 —
 * and read_webpage hands the response body straight back. (SSRF.)
 *
 * The check happens in the DNS lookup the SOCKET uses, not in a lookup
 * done beforehand: checking first and connecting second lets a hostile
 * DNS server answer "public" to the check and "10.0.0.5" to the connect
 * (rebinding). IP literals skip DNS entirely, so they are checked up
 * front. Redirects are followed by hand so every hop is checked again.
 *
 * Drop-in for fetch(url, init): returns a standard Response. Pass it as
 * the MCP SDK's `fetch` option unchanged.
 */
const http = require("http");
const https = require("https");
const dns = require("dns");
const net = require("net");
const zlib = require("zlib");
const { Readable } = require("stream");

/** Everything that is not the public internet. */
const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) BLOCKED.addSubnet(addr, prefix, "ipv4");
// No ::ffff:0:0/96 rule: BlockList already checks IPv4-mapped addresses
// against the IPv4 rules above, and it also matches plain IPv4 against
// that rule — adding it blocked the entire IPv4 internet.
for (const [addr, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96],
  ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) BLOCKED.addSubnet(addr, prefix, "ipv6");

/** Tests only: lets a local server stand in for "the internet". */
const TEST_ALLOW = new Set();

function isBlockedAddress(ip) {
  const family = net.isIP(ip);
  if (!family) return true; // not an address at all: refuse, never guess
  if (TEST_ALLOW.has(ip)) return false;
  return BLOCKED.check(ip, family === 6 ? "ipv6" : "ipv4");
}

class BlockedAddressError extends Error {
  constructor(host) {
    super(`${host} is not on the public internet`);
    this.code = "EBLOCKED";
  }
}

/** The lookup every socket we open goes through. */
function guardedLookup(hostname, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err);
    if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) {
      return callback(new BlockedAddressError(hostname));
    }
    if (options.all) return callback(null, addrs);
    callback(null, addrs[0].address, addrs[0].family);
  });
}

/** Rejects anything but a public http(s) URL whose host is not a private IP literal. */
function assertFetchableUrl(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http(s) links can be fetched");
  }
  if (url.username || url.password) throw new Error("links with credentials are not fetched");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isBlockedAddress(host)) throw new BlockedAddressError(host);
  if (/^localhost$|\.localhost$|\.local$|\.internal$|\.svc$|\.cluster\.local$/i.test(host)) {
    throw new BlockedAddressError(host);
  }
}

/**
 * For hosts that are dialled by something other than fetch (IMAP, SMTP):
 * resolves now and refuses private answers. Weaker than guardedLookup —
 * the client resolves again when it connects — but it stops the plain
 * "connect to 10.0.0.5:5432 and tell me the error" probe.
 */
async function assertPublicHost(hostname) {
  const host = String(hostname || "").trim().replace(/^\[|\]$/g, "");
  if (!host) throw new Error("no host given");
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new BlockedAddressError(host);
    return;
  }
  const addrs = await dns.promises.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) {
    throw new BlockedAddressError(host);
  }
}

function bodyBytes(body) {
  if (body == null) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return Buffer.from(body);
  throw new Error("safeFetch supports string and byte bodies only");
}

function requestOnce(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, { method, headers, signal, lookup: guardedLookup }, resolve);
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function decoded(res) {
  const enc = String(res.headers["content-encoding"] || "").toLowerCase().trim();
  if (enc === "gzip" || enc === "x-gzip") return res.pipe(zlib.createGunzip());
  if (enc === "deflate") return res.pipe(zlib.createInflate());
  if (enc === "br") return res.pipe(zlib.createBrotliDecompress());
  return res;
}

function toResponse(res, url, method) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (/^(content-encoding|content-length)$/i.test(k) && res.headers["content-encoding"]) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, String(one));
  }
  const empty = method === "HEAD" || [204, 205, 304].includes(res.statusCode);
  if (empty) res.resume();
  const response = new Response(empty ? null : Readable.toWeb(decoded(res)), {
    status: res.statusCode,
    statusText: res.statusMessage || "",
    headers,
  });
  Object.defineProperty(response, "url", { value: url.href });
  return response;
}

/**
 * @param input  URL or string
 * @param init   fetch init: method, headers, body, signal, redirect
 * @param opts.timeoutMs     overall deadline incl. reading the body (0 = none)
 * @param opts.maxRedirects  hops followed before giving up
 */
async function safeFetch(input, init = {}, { timeoutMs = 0, maxRedirects = 5 } = {}) {
  let url = new URL(String(input instanceof URL ? input.href : input?.url || input));
  let method = String(init.method || "GET").toUpperCase();
  let body = bodyBytes(init.body);
  const headers = {};
  new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; });
  if (!headers["accept-encoding"]) headers["accept-encoding"] = "gzip, deflate, br";
  if (body) headers["content-length"] = String(body.length);
  const signals = [init.signal, timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null].filter(Boolean);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  for (let hop = 0; ; hop++) {
    assertFetchableUrl(url);
    const res = await requestOnce(url, { method, headers, body, signal });
    const location = res.headers.location;
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && location && init.redirect !== "manual") {
      res.resume();
      if (hop >= maxRedirects) throw new Error("too many redirects");
      url = new URL(location, url);
      if (res.statusCode === 303 || ([301, 302].includes(res.statusCode) && method === "POST")) {
        method = "GET";
        body = null;
        delete headers["content-type"];
        delete headers["content-length"];
      }
      continue;
    }
    return toResponse(res, url, method);
  }
}

module.exports = {
  safeFetch, assertPublicHost, isBlockedAddress, BlockedAddressError,
  _TEST_ALLOW: TEST_ALLOW,
};
