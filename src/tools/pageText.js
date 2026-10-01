/**
 * READABLE TEXT OUT OF A WEB PAGE, AND THE LINES THAT CARRY FIGURES.
 *
 * extractReadableText used to live in builtins.js for read_webpage. The
 * web search needs it too (2026-10-01): "what are the flight timings from
 * Mangalore to Bangalore" searched three times, got pages whose snippets
 * held no times, and the assistant offered to open Google instead of
 * answering. When a question wants figures and the snippets have none,
 * webSearch now reads the top pages and hands the model the lines that
 * carry times, prices or numbers.
 */

function extractReadableText(html) {
  let h = String(html || "");
  h = h.replace(/<!--[\s\S]*?-->/g, " ");
  h = h.replace(/<(script|style|noscript|svg|iframe|form|template)\b[\s\S]*?<\/\1>/gi, " ");
  h = h.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  // Block edges become line breaks so sentences do not fuse across them.
  h = h.replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote)>/gi, "\n");
  h = h.replace(/<br\s*\/?>/gi, "\n");
  h = h.replace(/<[^>]+>/g, " ");
  h = decodeEntities(h);
  return h
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line) => line.length > 1)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(t) {
  return String(t || "")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp|mdash|ndash|hellip|rsquo|lsquo|ldquo|rdquo);/g,
      (_, e) => ({
        amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'",
        nbsp: " ", mdash: "—", ndash: "–", hellip: "…",
        rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
      })[e] || " ")
    .replace(/&#x?[0-9a-f]+;/gi, " ");
}

/** Questions whose answer is a time, a price or a count. */
const WANTS_FIGURES =
  /\b(time|times|timing|timings|schedule|timetable|depart\w*|arriv\w*|when (does|is|do|will)|what time|how long|duration|fare|fares|price|prices|cost|costs|rate|rates|how much|charges?|fee|fees|ticket|opening hours|open till|close[sd]?\b|hours|hrs|kitne baje|kab|kitna|kitne|ಎಷ್ಟು|ಯಾವಾಗ|എത്ര|எவ்வளவு|ఎంత)\b/i;

/** A time of day, a money amount, a duration or any two-digit number. */
const FIGURE =
  /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s?(?:am|pm|a\.m\.|p\.m\.)\b|(?:₹|rs\.?|inr|\$|usd)\s?\d[\d,]*|\b\d+\s?(?:h|hr|hrs|hour|hours|min|mins|minutes)\b|\b\d{2,}\b/i;

function wantsFigures(query) {
  return WANTS_FIGURES.test(String(query || ""));
}

/** Do the search snippets already carry a figure? */
function hasFigures(results) {
  return (results || []).slice(0, 5).some((r) => FIGURE.test(`${r.title || ""} ${r.snippet || ""}`));
}

/** The lines of a page that carry figures, in order, up to `max` characters. */
function figureLines(text, max = 1200) {
  const out = [];
  let size = 0;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (line.length < 6 || line.length > 240 || !FIGURE.test(line)) continue;
    if (out.includes(line)) continue;
    if (size + line.length > max) break;
    out.push(line);
    size += line.length + 1;
  }
  return out;
}

module.exports = { extractReadableText, decodeEntities, wantsFigures, hasFigures, figureLines, FIGURE };
