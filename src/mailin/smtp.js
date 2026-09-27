/**
 * BILLS BY EMAIL — adapter (B): a receive-only SMTP listener (spec §7.1).
 *
 * Small and written here (RFC 5321 receiving side only) so the backend
 * takes no new dependency. It can never relay: there is no AUTH, and a
 * recipient outside MAILIN_DOMAIN is refused at RCPT. Unknown and
 * switched-off addresses bounce at the door (550 5.1.1), so we never
 * accept mail we would have to bounce later — no backscatter.
 *
 * Limits, none of which depend on the sender's IP (klipper-lb hides it):
 * MAILIN_MAX_CLIENTS connections, 2 DATA transfers at once (a memory guard
 * for the 512 Mi pod), the size cap while reading, 3 unknown recipients
 * per session, 40 commands per session, 60 s idle timeout, and the
 * per-address and global caps in ingestInbound.
 *
 * Nothing is logged about a message — no address, no subject.
 */
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const { cfg } = require("./config");
const address = require("./address");

const MAX_LINE = 4096;
const MAX_COMMANDS = 40;
const IDLE_MS = 60_000;
const MAX_DATA_AT_ONCE = 2;
const TERM = Buffer.from("\r\n.\r\n");

let server = null;
let dataInFlight = 0;
const sockets = new Set();

function session(sock, opts) {
  const c = cfg();
  const maxBytes = opts.maxBytes || c.maxBytes;
  const st = {
    sock, secure: false, greeted: false, from: null, rcpts: [], userId: null,
    unknown: 0, commands: 0, mode: "cmd", buf: Buffer.alloc(0), busy: false, closed: false,
    data: [], dataBytes: 0, tooBig: false, inData: false,
  };
  const write = (line) => { if (!st.closed && !st.sock.destroyed) st.sock.write(line + "\r\n"); };
  const close = (line) => {
    if (line) write(line);
    st.closed = true;
    st.sock.end();
  };
  const resetTx = () => {
    st.from = null; st.rcpts = []; st.userId = null;
  };
  const endData = () => {
    if (st.inData) { st.inData = false; dataInFlight = Math.max(0, dataInFlight - 1); }
  };

  async function command(line) {
    st.commands++;
    if (st.commands > MAX_COMMANDS) return close("421 4.7.0 Too many commands, closing");
    const m = line.match(/^([A-Za-z]+)\b\s*(.*)$/);
    const verb = m ? m[1].toUpperCase() : "";
    const arg = m ? m[2] : "";
    switch (verb) {
      case "EHLO": case "HELO": {
        st.greeted = true;
        resetTx();
        if (verb === "HELO") return write(`250 ${opts.hostname}`);
        const ext = [`${opts.hostname}`, `SIZE ${maxBytes}`, "8BITMIME", "ENHANCEDSTATUSCODES"];
        if (opts.secureContext && !st.secure) ext.push("STARTTLS");
        ext.forEach((e, i) => write(`250${i === ext.length - 1 ? " " : "-"}${e}`));
        return;
      }
      case "STARTTLS": {
        if (!opts.secureContext || st.secure) return write("502 5.5.1 Not available");
        write("220 2.0.0 Ready to start TLS");
        return upgrade();
      }
      case "MAIL": {
        if (!st.greeted) return write("503 5.5.1 Say hello first");
        if (st.from !== null) return write("503 5.5.1 Sender already given");
        const fm = arg.match(/^FROM:\s*<([^>]*)>\s*(.*)$/i);
        if (!fm) return write("501 5.5.4 Syntax: MAIL FROM:<address>");
        const size = (fm[2].match(/\bSIZE=(\d+)/i) || [])[1];
        if (size && Number(size) > maxBytes) return write(`552 5.3.4 Message too big (limit ${c.maxMb} MB)`);
        if (dataInFlight >= MAX_DATA_AT_ONCE) return write("451 4.3.2 Busy, try again later");
        st.from = fm[1];
        return write("250 2.1.0 OK");
      }
      case "RCPT": {
        if (st.from === null) return write("503 5.5.1 Need MAIL first");
        const rm = arg.match(/^TO:\s*<([^>]*)>/i);
        if (!rm) return write("501 5.5.4 Syntax: RCPT TO:<address>");
        const rcpt = rm[1];
        const p = address.parseRecipient(rcpt);
        if (!p.domainOk) return write("550 5.7.1 Relaying denied");
        const who = await address.resolve(rcpt);
        if (!who || who.status !== "active") {
          st.unknown++;
          if (st.unknown >= 3) return close("421 4.7.0 Too many unknown recipients, closing");
          return write("550 5.1.1 Address not in use");
        }
        if (st.userId !== null && st.userId !== who.userId) return write("452 4.5.3 One recipient per message");
        const store = require("./store");
        if ((await store.countSince(who.userId, Date.now() - 864e5)) >= c.dailyCap) {
          return write("550 5.2.2 Daily limit reached for this address");
        }
        st.userId = who.userId;
        st.rcpts.push(rcpt);
        return write("250 2.1.5 OK");
      }
      case "DATA": {
        if (!st.rcpts.length) return write("503 5.5.1 Need a recipient first");
        if (dataInFlight >= MAX_DATA_AT_ONCE) return write("451 4.3.2 Busy, try again later");
        dataInFlight++;
        st.inData = true;
        st.mode = "data"; st.data = []; st.dataBytes = 0; st.tooBig = false;
        return write("354 End data with <CR><LF>.<CR><LF>");
      }
      case "RSET": resetTx(); return write("250 2.0.0 OK");
      case "NOOP": return write("250 2.0.0 OK");
      case "VRFY": return write("252 2.5.0 Cannot verify");
      case "QUIT": return close("221 2.0.0 Bye");
      default: return write("502 5.5.2 Command not recognised");
    }
  }

  async function finishData(body) {
    endData();
    st.mode = "cmd";
    const rcpt = st.rcpts[0];
    resetTx();
    if (st.tooBig) return write(`552 5.3.4 Message too big (limit ${c.maxMb} MB)`);
    // Dot-unstuffing: a line that starts with ".." was sent as ".".
    const raw = Buffer.from(body.toString("latin1").replace(/(^|\r\n)\.\./g, "$1."), "latin1");
    try {
      const r = await require("./ingest").ingestInbound(raw, rcpt, { transport: "smtp", tls: st.secure });
      if (r.ok) return write("250 2.0.0 Received");
      return write(`${r.smtp.code} ${r.smtp.text}`);
    } catch (e) {
      console.error("mailin: accept failed:", e.message);
      return write("451 4.3.0 Temporary problem, try again later");
    }
  }

  async function pump() {
    if (st.busy) return;
    st.busy = true;
    try {
      while (!st.closed) {
        if (st.mode === "data") {
          // The body so far is in st.data; st.buf holds bytes not yet looked at.
          const all = st.buf;
          const probe = st.dataBytes === 0 && all.slice(0, 3).equals(Buffer.from(".\r\n")) ? 0 : all.indexOf(TERM);
          if (probe < 0) {
            // Keep the last 4 bytes: the terminator may straddle chunks.
            const keep = Math.min(4, all.length);
            const take = all.slice(0, all.length - keep);
            st.dataBytes += take.length;
            if (st.dataBytes > maxBytes + 64 * 1024) st.tooBig = true;
            if (!st.tooBig) st.data.push(take);
            st.buf = all.slice(all.length - keep);
            break;
          }
          const take = all.slice(0, probe);
          st.dataBytes += take.length;
          if (st.dataBytes > maxBytes + 64 * 1024) st.tooBig = true;
          if (!st.tooBig) st.data.push(take);
          st.buf = all.slice(probe === 0 && st.dataBytes === 0 ? 3 : probe + TERM.length);
          const body = st.tooBig ? Buffer.alloc(0) : Buffer.concat([...st.data, Buffer.from("\r\n")]);
          st.data = [];
          await finishData(body);
          continue;
        }
        const nl = st.buf.indexOf("\n");
        if (nl < 0) {
          if (st.buf.length > MAX_LINE) close("500 5.5.6 Line too long");
          break;
        }
        const line = st.buf.slice(0, nl).toString("latin1").replace(/\r$/, "");
        st.buf = st.buf.slice(nl + 1);
        await command(line);
        if (st.upgrading) break;
      }
    } finally {
      st.busy = false;
    }
  }

  function onData(chunk) {
    st.buf = st.buf.length ? Buffer.concat([st.buf, chunk]) : chunk;
    pump().catch((e) => { console.error("mailin smtp:", e.message); close("451 4.3.0 Temporary problem"); });
  }

  function attach(s) {
    s.setTimeout(IDLE_MS);
    s.on("data", onData);
    s.on("timeout", () => close("421 4.4.2 Timeout, closing"));
    s.on("error", () => {});
    s.on("close", () => { st.closed = true; endData(); sockets.delete(s); });
  }

  function upgrade() {
    st.upgrading = true;
    const plain = st.sock;
    plain.removeListener("data", onData);
    plain.setTimeout(0);
    const secure = new tls.TLSSocket(plain, { isServer: true, secureContext: opts.secureContext });
    sockets.add(secure);
    st.sock = secure;
    st.secure = true;
    st.greeted = false;
    st.buf = Buffer.alloc(0); // nothing sent before the handshake counts
    resetTx();
    attach(secure);
    st.upgrading = false;
  }

  attach(sock);
  write(`220 ${opts.hostname} ESMTP ready`);
}

/**
 * @returns Promise<{port}> once listening. Only called when the feature
 * is on (service.startReceiver), or by the tests.
 */
function start({ port, hostname, key, cert, maxClients } = {}) {
  if (server) return Promise.resolve({ port: server.address().port });
  const c = cfg();
  const opts = {
    hostname: hostname || c.hostname,
    secureContext: key && cert ? tls.createSecureContext({ key, cert }) : null,
  };
  const limit = maxClients || c.maxClients;
  server = net.createServer((sock) => {
    sockets.add(sock);
    if (sockets.size > limit) {
      sock.on("error", () => {});
      sock.end("421 4.7.0 Too busy, try again later\r\n");
      sockets.delete(sock);
      return;
    }
    session(sock, opts);
  });
  server.on("error", (e) => console.error("mailin smtp server:", e.message));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port == null ? c.port : port, "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve({ port: server.address().port, tls: Boolean(opts.secureContext) });
    });
  });
}

function stop() {
  if (!server) return Promise.resolve();
  const s = server;
  server = null;
  for (const sock of sockets) { try { sock.end("421 4.3.2 Shutting down\r\n"); sock.destroy(); } catch (_) {} }
  sockets.clear();
  dataInFlight = 0;
  return new Promise((r) => s.close(() => r()));
}

/** Key and certificate from MAILIN_TLS_*_FILE, or nulls. */
function tlsFiles() {
  const c = cfg();
  try {
    if (c.tlsKeyFile && c.tlsCertFile) {
      return { key: fs.readFileSync(c.tlsKeyFile), cert: fs.readFileSync(c.tlsCertFile) };
    }
  } catch (e) {
    console.warn("mailin: TLS files unreadable — STARTTLS off:", e.message);
  }
  return { key: null, cert: null };
}

module.exports = { start, stop, tlsFiles };
