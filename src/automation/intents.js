/**
 * INTENT FIRST, THEN THE SCREEN — one task, two tools.
 *
 * An app's own link does in one jump what takes the hands five steps:
 * "https://www.swiggy.com/search?query=veg biryani" opens the app already
 * on the results for veg biryani (verified on the owner's phone,
 * 2026-09-24). So a run starts there, and screen control only finishes
 * what a link cannot — choosing, ADD, the cart — and stops at payment.
 *
 * The phone opens the link pinned to the app's package: an app that does
 * not understand it simply opens its home screen, never a browser.
 */
const deeplinks = require("../fulfillment/deeplinks");

const LEAD =
  /^(?:(?:please|kindly|hey|ok|okay)\s+|(?:can|could|would) you\s+|i (?:want|need|would like|'d like) (?:to\s+)?)*(?:order|get me|get|buy|book|find|search(?: for)?|look (?:for|up)|add|put|show me|check)\s+/i;
const TAIL =
  /\s+(?:from|near|nearby|to my|into my|in my|for me|at|under|below|with|which|that|and then|then|asap|quickly|right now|now)\b[\s\S]*$/i;

/** The thing to search for, in the owner's words: "veg biryani". */
function extractQuery(goal, appName = "") {
  let q = String(goal || "").replace(/\s+/g, " ").trim();
  if (appName) {
    q = q.replace(new RegExp(`\\s*\\b(?:on|in|from|using|via|through)\\s+(?:the\\s+)?${appName}(?:\\s+app)?\\b`, "gi"), " ");
    q = q.replace(new RegExp(`\\b${appName}\\b`, "gi"), " ");
  }
  q = q.replace(/\s+/g, " ").trim().replace(LEAD, "");
  q = q.replace(TAIL, "");
  q = q.replace(/^(?:a|an|some|the|me)\s+/i, "").replace(/[.?!,]+$/, "").trim();
  if (!q || q.length > 60 || q.split(" ").length > 8) return "";
  // "Something nice" is not a search — the hands choose from the app.
  if (/^(?:something|anything|some|stuff|whatever|food|a meal|dinner|lunch|breakfast|snacks?|it|that|this)(?:\s+(?:nice|good|tasty|healthy|light|quick|else))?$/i.test(q)) return "";
  return q;
}

/**
 * The link that starts a run on the right screen, or null.
 * @returns {{url, query, note}|null}
 */
function startLink(appName, category, goal, query) {
  const name = String(appName || "").toLowerCase();
  const q = String(query || "").trim().slice(0, 60) || extractQuery(goal, name);
  if (!q) return null;
  let link = null;
  // "platform: web" asks the builders for the plain https link.
  if ((name === "swiggy" || name === "zomato") && category !== "grocery") {
    link = deeplinks.food({ provider: name, dish: q, platform: "web" });
  } else if (["blinkit", "zepto", "amazon", "flipkart"].includes(name)) {
    link = deeplinks.shop({ provider: name, query: q, platform: "web" });
  }
  if (!link || link.precision !== "search" || !/^https:\/\//.test(link.url)) return null;
  return { url: link.url, query: q, note: link.note };
}

module.exports = { extractQuery, startLink };
