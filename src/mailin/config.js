/**
 * BILLS BY EMAIL — configuration. Everything is OFF when unset: with no
 * MAILIN_ENABLED=1 there is no listener, every accept is refused, and
 * GET /mailin tells the app to hide the feature. The subdomain is not
 * chosen yet, so it is only ever read from MAILIN_DOMAIN.
 */
const num = (name, dflt, min = 1) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? n : dflt;
};

function cfg() {
  const domain = String(process.env.MAILIN_DOMAIN || "").trim().toLowerCase();
  return {
    enabled: process.env.MAILIN_ENABLED === "1" && Boolean(domain),
    domain,
    hostname: String(process.env.MAILIN_HOSTNAME || domain || "localhost").trim().toLowerCase(),
    port: num("MAILIN_SMTP_PORT", 2525, 0),
    maxBytes: num("MAILIN_MAX_MB", 10) * 1024 * 1024,
    maxMb: num("MAILIN_MAX_MB", 10),
    maxPartBytes: num("MAILIN_MAX_PART_MB", 10) * 1024 * 1024,
    maxFiles: num("MAILIN_MAX_FILES", 5),
    dailyCap: num("MAILIN_DAILY_CAP", 25),
    hourlyCap: num("MAILIN_GLOBAL_HOURLY_CAP", 500),
    maxClients: num("MAILIN_MAX_CLIENTS", 20),
    remindUnverified: process.env.MAILIN_REMIND_UNVERIFIED === "1",
    tlsKeyFile: process.env.MAILIN_TLS_KEY_FILE || "",
    tlsCertFile: process.env.MAILIN_TLS_CERT_FILE || "",
  };
}

module.exports = { cfg };
