/**
 * DEV ONLY — feed one .eml into Bills by email on a LOCAL database, then
 * run the worker once:
 *
 *   MAILIN_ENABLED=1 MAILIN_DOMAIN=mailin.test node scripts/mailin-inject.js <file.eml> <recipient>
 *
 * Refuses anything but a local DATABASE_URL, the same guard erase-test uses.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://myassistant:localdev@localhost:5432/myassistant";
if (process.env.NODE_ENV === "production" ||
    !/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(process.env.DATABASE_URL)) {
  console.error("mailin-inject only runs against a local database.");
  process.exit(1);
}
const fs = require("fs");

(async () => {
  const [file, rcpt] = process.argv.slice(2);
  if (!file || !rcpt) {
    console.error("usage: node scripts/mailin-inject.js <file.eml> <recipient>");
    process.exit(2);
  }
  const db = require("../src/db");
  await db.init();
  const r = await require("../src/mailin/ingest").ingestInbound(fs.readFileSync(file), rcpt, { transport: "test" });
  console.log("accept:", JSON.stringify(r));
  if (r.ok) {
    await require("../src/mailin/worker").tick();
    const row = await db.one(`SELECT id, state, reason, kind, auth, document_ids, reminder_ids FROM mail_inbound WHERE id=$1`, [r.id]);
    console.log("result:", JSON.stringify(row));
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
