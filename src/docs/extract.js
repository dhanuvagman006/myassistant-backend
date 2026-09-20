/**
 * TEXT OUT OF THE FILES GEMINI CANNOT READ DIRECTLY.
 * -------------------------------------------------
 * The multimodal call understands images and PDFs. It does not understand
 * a .docx, an .xlsx, a .pptx or a CSV — those are ZIPs and byte formats,
 * and handing them over as inline_data returns nothing useful.
 *
 * So anything that is not natively readable is converted to plain text
 * here FIRST, and the analyser then works on the text. That is what makes
 * "share me the sales sheet and tell me which region slipped" possible at
 * all: the numbers reach the model as numbers.
 *
 * Never throws. A format we cannot open returns null and the document is
 * still saved — it simply has no searchable text.
 */
const path = require("path");

const CAP = 200000; // characters handed on; the analyser caps again at 12k

const TEXTUAL = new Set([
  "text/plain", "text/csv", "text/tab-separated-values", "text/markdown",
  "application/json", "text/html", "application/rtf", "text/rtf",
]);

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** Types this module can turn into text (used to gate uploads). */
const EXTRACTABLE = new Set([DOCX, XLSX, PPTX, ...TEXTUAL]);

function byExtension(filename) {
  const e = path.extname(String(filename || "")).toLowerCase();
  return {
    ".docx": DOCX, ".xlsx": XLSX, ".pptx": PPTX,
    ".csv": "text/csv", ".tsv": "text/tab-separated-values",
    ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
    ".html": "text/html", ".htm": "text/html", ".rtf": "application/rtf",
  }[e] || null;
}

const stripTags = (s) => String(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

async function fromDocx(buffer) {
  const mammoth = require("mammoth");
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}

async function fromXlsx(buffer) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = [];
  wb.eachSheet((ws) => {
    out.push("\n[" + ws.name + "]");
    ws.eachRow({ includeEmpty: false }, (row) => {
      // ExcelJS row.values is 1-based with a leading hole.
      const cells = (row.values || []).slice(1).map((v) => {
        if (v == null) return "";
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (typeof v === "object") {
          if (v.result !== undefined) return String(v.result); // formula
          if (v.formula !== undefined) return "=" + v.formula; // uncached
          if (v.text !== undefined) return String(v.text);     // hyperlink
          if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
          return "";
        }
        return String(v);
      });
      const line = cells.join(" | ").trim();
      if (line.replace(/\|/g, "").trim()) out.push(line);
    });
  });
  return out.join("\n");
}

async function fromPptx(buffer) {
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  const out = [];
  for (const n of names) {
    const xml = await zip.file(n).async("string");
    const runs = (xml.match(/<a:t>[\s\S]*?<\/a:t>/g) || []).map((t) => stripTags(t)).filter(Boolean);
    if (runs.length) out.push("\n[Slide " + (out.length + 1) + "]\n" + runs.join("\n"));
  }
  return out.join("\n");
}

/**
 * @returns {Promise<string|null>} plain text, or null when the format is
 * not one we can open (or the file turned out to be empty).
 */
async function extractText(buffer, mime, filename) {
  const type = EXTRACTABLE.has(mime) ? mime : byExtension(filename);
  if (!type) return null;
  try {
    let text;
    if (type === DOCX) text = await fromDocx(buffer);
    else if (type === XLSX) text = await fromXlsx(buffer);
    else if (type === PPTX) text = await fromPptx(buffer);
    else {
      text = buffer.toString("utf8");
      if (type === "text/html") text = stripTags(text);
      if (/rtf$/.test(type)) text = text.replace(/\\[a-z]+-?\d*\s?|[{}]/gi, " ").replace(/\s+/g, " ");
    }
    // Strip NUL bytes: a mis-typed binary arrives as a string full of
    // them, and Postgres rejects a NUL inside a text column outright.
    text = String(text || "").replace(/\u0000/g, "").trim();
    return text ? text.slice(0, CAP) : null;
  } catch (e) {
    console.error("doc extract failed:", mime, e.message);
    return null;
  }
}

module.exports = { extractText, EXTRACTABLE, byExtension, DOCX, XLSX, PPTX };
