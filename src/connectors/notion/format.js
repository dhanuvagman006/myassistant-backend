/**
 * NOTION — shaping text both ways: user words into blocks, page content
 * into something short enough to say aloud.
 */
const RICH_MAX = 2000;

/** Notion titles are other people's words: quoted, one line, 80 chars. */
function safeTitle(s) {
  return String(s || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled";
}

function plainOf(rich) {
  return Array.isArray(rich)
    ? rich.map((x) => x.plain_text || (x.text && x.text.content) || "").join("")
    : "";
}

/** The page's title property, whatever it is called. */
function plainTitle(page) {
  if (!page) return "";
  if (Array.isArray(page.title)) return plainOf(page.title); // a database / data source
  const props = page.properties || {};
  for (const v of Object.values(props)) {
    if (v && v.type === "title") return plainOf(v.title);
  }
  return "";
}

function richText(s) {
  const text = String(s || "");
  const out = [];
  for (let i = 0; i < text.length; i += RICH_MAX) {
    out.push({ type: "text", text: { content: text.slice(i, i + RICH_MAX) } });
  }
  return out.length ? out : [{ type: "text", text: { content: "" } }];
}

const todo = (s) => ({ object: "block", type: "to_do", to_do: { rich_text: richText(s), checked: false } });
const bullet = (s) => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: richText(s) } });
const para = (s) => ({ object: "block", type: "paragraph", paragraph: { rich_text: richText(s) } });

/** "- x" → bullet, "[ ] x" → to-do, anything else a paragraph; ≤ 100 blocks. */
function contentToBlocks(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(0, 100).map((l) => {
    if (/^\[ ?\]\s+/.test(l)) return todo(l.replace(/^\[ ?\]\s+/, ""));
    if (/^[-*]\s+/.test(l)) return bullet(l.replace(/^[-*]\s+/, ""));
    return para(l);
  });
}

/** Markdown → something to say: no images or links, cut on a sentence. */
function forSpeech(markdown, max = 3000) {
  let t = String(markdown || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (t.length <= max) return { text: t, truncated: false };
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  t = end > max * 0.5 ? cut.slice(0, end + 1) : cut;
  return { text: t.trim(), truncated: true };
}

function propText(p) {
  if (!p) return "";
  switch (p.type) {
    case "status": return (p.status && p.status.name) || "";
    case "select": return (p.select && p.select.name) || "";
    case "date": return (p.date && p.date.start) || "";
    case "checkbox": return p.checkbox ? "done" : "";
    default: return "";
  }
}

/** One database row as a line: its title and up to three short fields. */
function rowSummary(page) {
  const bits = [];
  for (const [name, p] of Object.entries(page.properties || {})) {
    if (bits.length >= 3) break;
    const v = propText(p);
    if (v) bits.push(`${name}: ${v}`);
  }
  const title = plainTitle(page) || "Untitled";
  return bits.length ? `${title} (${bits.join(", ")})` : title;
}

/** "a, b and c" / "a, b, c, and 2 more". */
function listItems(items, n = 3) {
  const shown = items.slice(0, n);
  const more = items.length - shown.length;
  if (more > 0) return `${shown.join(", ")}, and ${more} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

module.exports = {
  safeTitle, plainTitle, richText, todo, bullet, para, contentToBlocks, forSpeech, rowSummary,
  listItems, RICH_MAX,
};
