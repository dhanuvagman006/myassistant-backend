/**
 * TEST MANIFEST CHECK — runs first in `npm run test:all`.
 *
 * The registry has contract.js, which refuses to boot when a seed list
 * names a tool that does not exist. This is the same idea for the test
 * suite, and it exists because the suite failed exactly that way:
 *
 *   c172da9 deleted eight test files but left their npm scripts behind.
 *   `test:all` chained through `test:e2e` as its SECOND step, npm halted
 *   on the missing file, and the command reported success having run
 *   three checks out of roughly four hundred and seventy. Five suites
 *   that DID exist — fulfillment, legal, knowledge, professional,
 *   integrations — were never in the chain at all, so one of them had
 *   been failing unnoticed.
 *
 * Two invariants, both of which were broken at once:
 *   1. every `test*` script points at a file that exists;
 *   2. every `test:*` suite is actually reached by `test:all`.
 *
 * Deleting a suite is fine. Deleting it and leaving the script is not,
 * and neither is adding one that nothing runs.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const scripts = require(path.join(root, "package.json")).scripts || {};

const EXEMPT = new Set(["test:all", "test:manifest"]);
const problems = [];

// ── 1. every target file exists ──────────────────────────────────────
const suites = [];
for (const [name, cmd] of Object.entries(scripts)) {
  if (!name.startsWith("test")) continue;
  if (EXEMPT.has(name)) continue;
  suites.push(name);
  const m = cmd.match(/node\s+([^\s|&><]+\.js)/);
  if (!m) {
    problems.push(`${name}: cannot tell which file it runs — "${cmd}"`);
    continue;
  }
  if (!fs.existsSync(path.join(root, m[1]))) {
    problems.push(
      `${name}: runs ${m[1]}, which does not exist. ` +
        `Delete the script, or restore the file.`
    );
  }
}

// ── 2. test:all reaches every suite ──────────────────────────────────
const all = scripts["test:all"] || "";
if (!all) {
  problems.push("test:all is missing — nothing runs the whole suite.");
} else {
  for (const name of suites) {
    // Word-boundary match so test:state is not satisfied by test:stateful.
    if (!new RegExp(`npm run ${name}(?![\\w:-])`).test(all)) {
      problems.push(`${name} exists but test:all never runs it.`);
    }
  }
}

if (problems.length) {
  console.error("\n  test manifest is broken:\n");
  for (const p of problems) console.error(`    ✗ ${p}`);
  console.error(
    `\n  ${problems.length} problem(s). Fix package.json before trusting a green run.\n`
  );
  process.exit(1);
}

console.log(`  ok  test manifest: ${suites.length} suites, all present, all reached`);
