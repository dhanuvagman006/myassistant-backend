/**
 * BILLS BY EMAIL — the worker. Its own poll loop, one row at a time,
 * NOT the shared infra/jobs queue: a burst of mail can never delay a
 * scheduled task or a reminder call, and at most one analyser call is in
 * flight, so mail never crowds voice turns off the shared AI keys.
 *
 * A lease that expires (restart, rollout) re-queues the row; SKIP LOCKED
 * keeps two pods from sharing one. Three attempts: 30 s, then 2 min, and
 * the third runs with `final`, which files what it can without reading.
 */
const fs = require("fs");
const store = require("./store");

const POLL_MS = 5000;
const BACKOFF = [30_000, 120_000];
let timer = null;
let running = false;
let again = false;
let options = {};

async function tick(opts = options) {
  const now = opts.now ? opts.now() : Date.now();
  const row = await store.claimNext(now);
  if (!row) return false;
  const final = Number(row.attempts) >= 3;
  try {
    await require("./process").processInbound(row, { final, now, resolveTxt: opts.resolveTxt });
  } catch (e) {
    console.warn(`mailin: #${row.id} attempt ${row.attempts} failed — ${e.message}`);
    if (!final) {
      await store.patch(row.id, { state: "queued", run_after: now + BACKOFF[Math.min(row.attempts, 2) - 1], lease_until: 0 })
        .catch(() => {});
    } else {
      await store.patch(row.id, { state: "failed", reason: "couldn't save", raw_path: "" }).catch(() => {});
      if (row.raw_path) await fs.promises.rm(row.raw_path, { force: true }).catch(() => {});
      try { require("../infra/observability").count("mailin.failed"); } catch (_) {}
    }
  }
  return true;
}

/** Work through everything ready now; one run at a time. */
async function drain() {
  if (running) { again = true; return; }
  running = true;
  try {
    do {
      again = false;
      // eslint-disable-next-line no-await-in-loop
      while (await tick().catch((e) => { console.warn("mailin worker:", e.message); return false; })) { /* next */ }
    } while (again);
  } finally {
    running = false;
  }
}

/** After an accept: file it now, not at the next poll. */
function kick() {
  if (timer) setImmediate(() => drain());
}

function start(opts = {}) {
  options = opts;
  if (timer) return;
  timer = setInterval(() => drain(), POLL_MS);
  timer.unref?.();
  setImmediate(() => drain());
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick, kick, drain };
