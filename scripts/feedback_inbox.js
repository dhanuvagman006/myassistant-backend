#!/usr/bin/env node
/**
 * THE DEVELOPER'S INBOX, locally — `node scripts/feedback_inbox.js list`.
 * See src/feedback/inbox.js for the commands; in production run the same
 * module inside the backend pod (it needs the database).
 */
require("../src/feedback/inbox").cli(process.argv.slice(2)).then(() => process.exit(0)).catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
