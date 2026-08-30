/**
 * PACK: INDIAN LAW.
 *
 * The provisions themselves stay in src/legal/seed.js, where they were
 * written, and this file only adapts them to the generic entry shape. The
 * legal domain keeps its own module because it carries something no other
 * pack needs: the repealed-statute map in src/legal/guard.js, which exists
 * because the IPC, CrPC and Evidence Act were replaced on 1 July 2024 and
 * every model's recollection of Indian criminal law is a year out of date.
 */
const { PROVISIONS } = require("../../legal/seed");

const DOMAIN = "legal";

const ENTRIES = PROVISIONS.map((p) => ({
  slug: p.slug,
  domain: DOMAIN,
  source_title: p.act,
  source_short: p.act_short,
  ref: p.section,
  title: p.title,
  summary: p.summary,
  detail: p.detail || "",
  topics: p.topics || "",
  replaces: p.replaces || "",
  source_url: p.source_url || "",
  status: p.status || "in_force",
  effective: p.effective || "",
}));

module.exports = { DOMAIN, ENTRIES };
