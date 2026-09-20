/**
 * DOCUMENT STUDIO — the assistant CREATES real, openable files.
 * -------------------------------------------------------------
 * Until now the app could FIND a document (save_web_document), READ one
 * (docs/analyze) and WRITE prose to the screen (present_text), but it
 * could not hand the user a file they could send to somebody else. That
 * is the single thing people leave for a laptop, and it is the reason a
 * busy professional still keeps ChatGPT installed beside this app.
 *
 * Four real formats, no screenshots and no HTML pretending to be a file:
 *   pdf    → PDFKit            (reports, letters, one-pagers, invoices)
 *   slides → PptxGenJS  .pptx  (a genuine PowerPoint, editable)
 *   doc    → docx       .docx  (a genuine Word file, editable)
 *   sheet  → ExcelJS    .xlsx  (a genuine Excel file, with formulas)
 *
 * THE MODEL DOES NOT WRITE THE FILE, IT ORDERS ONE. The calling agent
 * passes a brief ("8-slide deck on our Q3 numbers for the board"); this
 * module makes ONE dedicated Gemini call that returns a strict content
 * spec, then renders it. Two reasons that split matters:
 *   • over the live voice socket, long tool arguments are slow and get
 *     truncated — a brief is one line, a ten-page report is not;
 *   • the authoring call gets a prompt written for authoring, so the
 *     output is a real document rather than chat prose in a box.
 *
 * Nothing here can fail loudly enough to lose the user's request: every
 * renderer degrades (missing font → built-in font, junk chart → skipped
 * chart, short spec → short document) rather than throwing.
 */
const fs = require("fs");
const path = require("path");
const { envModel } = require("./ai/router");

const DOC_MODEL = () => envModel("GEMINI_DOC_MODEL", "gemini-2.5-flash");

/** Authoring thinking budget. 0 = fastest, which is the product default
 *  ("time is precious"); raise via env if a deck ever reads thin — no
 *  rebuild needed. Only the 2.5-flash family accepts this field. */
const DOC_THINKING = () => {
  const n = Number(process.env.GEMINI_DOC_THINKING);
  return Number.isFinite(n) ? n : 0;
};

const KINDS = ["pdf", "slides", "doc", "sheet"];

const MIME = {
  pdf: "application/pdf",
  slides: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  sheet: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const EXT = { pdf: ".pdf", slides: ".pptx", doc: ".docx", sheet: ".xlsx" };
const LABEL = { pdf: "PDF", slides: "PowerPoint", doc: "Word document", sheet: "Excel sheet" };

/* ------------------------------------------------------------------ */
/* PALETTE                                                             */
/* ------------------------------------------------------------------ */

const INK = "#111827";
const MUTED = "#6B7280";
const RULE = "#E5E7EB";
const DEFAULT_ACCENT = "#7C3AED";

/** Chart/series colours. The document's accent always leads so a deck
 *  and its report look like they came from the same hand. */
function ramp(accent) {
  const rest = ["#06B6D4", "#F59E0B", "#EC4899", "#10B981", "#6366F1", "#EF4444", "#14B8A6", "#8B5CF6"];
  return [accent, ...rest.filter((c) => c.toLowerCase() !== accent.toLowerCase())];
}

function hex(v, fallback = DEFAULT_ACCENT) {
  const s = String(v || "").trim();
  return /^#[0-9a-f]{6}$/i.test(s) ? s.toUpperCase() : fallback;
}
const bare = (h) => h.replace("#", "");

/* ------------------------------------------------------------------ */
/* FONTS (PDF only — Office formats are rendered by the reader)         */
/* ------------------------------------------------------------------ */

/**
 * PDFKit's built-in fonts are WinAnsi: they cannot draw Devanagari,
 * Kannada, Tamil, Telugu, Malayalam or Bengali at all. The container may
 * or may not carry Noto for a given script, so the font is DISCOVERED,
 * never assumed — and when nothing matches we fall back to Helvetica and
 * still produce a file. A found font is chosen once for the whole
 * document from its dominant script (PDFKit has no per-glyph fallback).
 */
let fontIndex = null;
function indexFonts() {
  if (fontIndex) return fontIndex;
  fontIndex = new Map();
  const roots = ["/usr/share/fonts", "/usr/local/share/fonts", path.join(__dirname, "..", "..", "assets", "fonts")];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.ttf$/i.test(e.name) && !fontIndex.has(e.name.toLowerCase())) {
        fontIndex.set(e.name.toLowerCase(), p);
      }
    }
  };
  for (const r of roots) walk(r, 0);
  return fontIndex;
}

function findFont(names) {
  const idx = indexFonts();
  for (const n of names) {
    const hit = idx.get(n.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

const SCRIPTS = [
  { re: /[ऀ-ॿ]/, base: "NotoSansDevanagari" },
  { re: /[ಀ-೿]/, base: "NotoSansKannada" },
  { re: /[஀-௿]/, base: "NotoSansTamil" },
  { re: /[ఀ-౿]/, base: "NotoSansTelugu" },
  { re: /[ഀ-ൿ]/, base: "NotoSansMalayalam" },
  { re: /[ঀ-৿]/, base: "NotoSansBengali" },
  { re: /[઀-૿]/, base: "NotoSansGujarati" },
  { re: /[਀-੿]/, base: "NotoSansGurmukhi" },
];

/** @returns {{regular:string|null, bold:string|null}} absolute TTF paths. */
function pickFonts(sample) {
  const s = String(sample || "");
  for (const sc of SCRIPTS) {
    if (!sc.re.test(s)) continue;
    const regular = findFont([`${sc.base}-Regular.ttf`, `${sc.base}.ttf`]);
    if (regular) {
      return { regular, bold: findFont([`${sc.base}-Bold.ttf`]) || regular, script: sc.base };
    }
  }
  const regular = findFont(["DejaVuSans.ttf", "NotoSans-Regular.ttf", "LiberationSans-Regular.ttf", "Arial.ttf"]);
  if (!regular) return { regular: null, bold: null, script: null };
  return {
    regular,
    bold: findFont(["DejaVuSans-Bold.ttf", "NotoSans-Bold.ttf", "LiberationSans-Bold.ttf", "Arial-Bold.ttf"]) || regular,
    script: null,
  };
}

/* ------------------------------------------------------------------ */
/* AUTHORING — one Gemini call, strict JSON                            */
/* ------------------------------------------------------------------ */

const SHAPE = {
  pdf:
    `{"title":"<document title>",
 "subtitle":"<one line under it, or empty>",
 "sections":[{"heading":"<section heading>",
   "paragraphs":["<full prose paragraph>"],
   "bullets":["<short point>"],
   "table":{"columns":["<col>"],"rows":[["<cell>"]]},
   "chart":{"type":"bar|line|pie","title":"<chart title>","labels":["<x label>"],"series":[{"name":"<series>","values":[0]}]}}]}`,
  doc: null, // same shape as pdf, filled in below
  slides:
    `{"title":"<deck title>",
 "subtitle":"<presenter line or one-line premise>",
 "slides":[{"title":"<slide headline>",
   "bullets":["<one idea per bullet, max 14 words>"],
   "notes":"<what the presenter says on this slide, 2-4 sentences>",
   "chart":{"type":"bar|line|pie","title":"<chart title>","labels":["<x label>"],"series":[{"name":"<series>","values":[0]}]}}]}`,
  sheet:
    `{"title":"<workbook title>",
 "sheets":[{"name":"<tab name, max 28 chars>",
   "columns":["<column header>"],
   "rows":[["<cell>"]],
   "total_row":true,
   "note":"<one line explaining the tab, or empty>"}]}`,
};
SHAPE.doc = SHAPE.pdf;

const GUIDE = {
  pdf:
    "Write a finished document, not notes about one. Open with a short " +
    "framing paragraph before the first heading (use a section with an " +
    "empty heading for it). Prefer real prose; use bullets only where a " +
    "list is genuinely the clearest form. Include a table whenever there " +
    "are figures, dates, options or comparisons, and a chart when numbers " +
    "have a shape worth seeing. 4-8 sections unless asked otherwise.\n" +
    "A LETTER IS NOT A REPORT. If this is a letter, application, notice, " +
    "resignation, complaint, invitation or email, drop the headings " +
    "entirely: use sections with an EMPTY heading whose paragraphs are the " +
    "letter itself — the date, the recipient block, 'Subject: …', the " +
    "salutation, the body, then the sign-off and the sender's name, each " +
    "on its own line. Report headings over a leave letter look wrong to " +
    "the person receiving it.",
  doc:
    "Write a finished, editable document. Real prose paragraphs, clear " +
    "headings, tables for any figures. This file will be edited by the " +
    "user afterwards, so leave no placeholders like [insert name] unless " +
    "the user must genuinely fill them — and if you must, make them " +
    "obvious and few. A letter, application or notice takes no headings " +
    "at all — see the letter rule for pdf and follow it here as well.",
  slides:
    "Write a deck that reads well from the back of a room. Each slide: a " +
    "headline that states the POINT (not a topic label), 3-5 bullets of " +
    "at most 14 words, and speaker notes with what is actually said. " +
    "Charts where numbers matter. No slide may be a wall of text.",
  sheet:
    "Build a working spreadsheet. First row is headers. Numbers must be " +
    "real JSON numbers, never strings, so they can be summed and charted. " +
    "Dates as yyyy-mm-dd. Set total_row true when a numeric total makes " +
    "sense. Use several tabs when the data has distinct parts.",
};

/** The user's wall-clock date, so a document never dates itself to the
 *  model's training year — a budget tracker came back headed July 2024. */
function todayLine(tzOffsetMin) {
  const tz = Number.isFinite(Number(tzOffsetMin)) ? Number(tzOffsetMin) : 330;
  const d = new Date(Date.now() + tz * 60_000);
  return `${d.toUTCString().slice(0, 16).trim()} (${d.toISOString().slice(0, 10)})`;
}

function authorPrompt(kind, o) {
  const size = {
    pdf: o.length ? `Aim for about ${o.length}.` : "Aim for 2-4 pages of real content.",
    doc: o.length ? `Aim for about ${o.length}.` : "Aim for 2-4 pages of real content.",
    slides: `Produce exactly ${Math.min(Math.max(Number(o.count) || 10, 3), 30)} slides including the opening slide.`,
    sheet: o.length ? `Aim for about ${o.length}.` : "Fill each tab with the rows the task actually needs.",
  }[kind];

  return [
    `You are the document studio inside a personal assistant used by busy professionals in India.`,
    `Produce the CONTENT for a ${LABEL[kind]}.`,
    ``,
    `TASK: ${o.topic}`,
    o.brief ? `DETAIL: ${o.brief}` : "",
    o.content ? `MATERIAL THE USER GAVE YOU — use it as the source of truth, do not contradict or pad it:\n${String(o.content).slice(0, 12000)}` : "",
    o.audience ? `AUDIENCE: ${o.audience}` : "",
    o.tone ? `TONE: ${o.tone}` : "TONE: clear, professional, no filler.",
    `LANGUAGE: ${o.language || "English"}.`,
    ``,
    GUIDE[kind],
    size,
    ``,
    `TODAY IS ${o.today}. Every date you write — the letter date, a budget month, a deadline, a quarter — is relative to today, never to some other year.`,
    `Money in Indian context is rupees (₹) with Indian digit grouping in prose.`,
    `Never invent a figure and present it as fact. If a number is an estimate, say so in the text.`,
    `A detail the user did not give you and you cannot know — a phone number, an employee ID, an address — is LEFT OUT, not filled with a bracketed placeholder. Use one only where the document is genuinely unusable without it.`,
    `Omit any optional field you are not using — never emit an empty table, an empty chart, or a placeholder row.`,
    ``,
    `Reply with STRICT JSON only, no markdown fence, matching exactly:`,
    SHAPE[kind],
  ].filter(Boolean).join("\n");
}

async function authorSpec(kind, o) {
  const keys = require("./ai/keys");
  const model = DOC_MODEL();
  const generationConfig = {
    response_mime_type: "application/json",
    temperature: 0.7,
    maxOutputTokens: 16384,
  };
  if (/^gemini-2\.5-flash/i.test(model)) {
    generationConfig.thinkingConfig = { thinkingBudget: DOC_THINKING() };
  }
  // One spent key must not mean "no documents today" — see ai/keys.js.
  const data = await keys.withKeyRotation(model, async (key) => {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        signal: AbortSignal.timeout(75_000), // inside the tool's own 120s budget
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: authorPrompt(kind, o) }] }],
          generationConfig,
        }),
      }
    );
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw Object.assign(
        new Error(`the writer is busy (${r.status})${body ? ": " + body.slice(0, 160) : ""}`),
        { status: r.status, body }
      );
    }
    return r.json();
  });
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  let spec;
  try {
    spec = JSON.parse(text);
  } catch {
    // Occasionally a fence survives response_mime_type. Salvage it rather
    // than throwing away a document the model already wrote.
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("the writer returned nothing usable");
    spec = JSON.parse(m[0]);
  }
  return spec;
}

/* ------------------------------------------------------------------ */
/* NORMALISATION — a model's spec is never trusted as-is               */
/* ------------------------------------------------------------------ */

const str = (v, max = 400) => String(v == null ? "" : v).replace(/\s+$/g, "").slice(0, max);
const arr = (v) => (Array.isArray(v) ? v : []);

function cleanChart(c) {
  if (!c || typeof c !== "object") return null;
  const type = ["bar", "line", "pie"].includes(String(c.type)) ? String(c.type) : "bar";
  const labels = arr(c.labels).map((l) => str(l, 40)).slice(0, 24);
  const series = arr(c.series)
    .map((s) => ({
      name: str(s?.name, 40) || "Series",
      values: arr(s?.values).map((n) => (Number.isFinite(Number(n)) ? Number(n) : 0)).slice(0, 24),
    }))
    .filter((s) => s.values.length)
    .slice(0, 6);
  if (!labels.length || !series.length) return null;
  return { type, title: str(c.title, 90), labels, series };
}

function cleanTable(t) {
  if (!t || typeof t !== "object") return null;
  const columns = arr(t.columns).map((c) => str(c, 60)).slice(0, 8);
  const rows = arr(t.rows)
    .map((r) => arr(r).map((c) => str(c, 300)).slice(0, 8))
    .filter((r) => r.some((c) => c !== ""))
    .slice(0, 200);
  if (!rows.length) return null;
  return { columns, rows };
}

function cleanSections(spec) {
  return arr(spec.sections)
    .map((s) => ({
      heading: str(s?.heading, 120),
      paragraphs: arr(s?.paragraphs).map((p) => str(p, 4000)).filter(Boolean).slice(0, 30),
      bullets: arr(s?.bullets).map((b) => str(b, 400)).filter(Boolean).slice(0, 30),
      table: cleanTable(s?.table),
      chart: cleanChart(s?.chart),
    }))
    .filter((s) => s.heading || s.paragraphs.length || s.bullets.length || s.table || s.chart)
    .slice(0, 40);
}

function normalize(kind, spec) {
  const title = str(spec?.title, 140) || "Document";
  if (kind === "slides") {
    const slides = arr(spec?.slides)
      .map((s) => ({
        title: str(s?.title, 140),
        bullets: arr(s?.bullets).map((b) => str(b, 300)).filter(Boolean).slice(0, 8),
        notes: str(s?.notes, 2000),
        chart: cleanChart(s?.chart),
      }))
      .filter((s) => s.title || s.bullets.length || s.chart)
      .slice(0, 60);
    if (!slides.length) throw new Error("the deck came back empty");
    return { title, subtitle: str(spec?.subtitle, 200), slides };
  }
  if (kind === "sheet") {
    const sheets = arr(spec?.sheets)
      .map((s, i) => ({
        // Excel forbids : \ / ? * [ ] in a tab name and caps it at 31.
        name: (str(s?.name, 28).replace(/[:\\/?*[\]]/g, " ").trim() || `Sheet ${i + 1}`),
        columns: arr(s?.columns).map((c) => str(c, 60)).slice(0, 40),
        rows: arr(s?.rows).map((r) => arr(r).slice(0, 40)).filter((r) => r.length).slice(0, 5000),
        totalRow: s?.total_row === true,
        note: str(s?.note, 300),
      }))
      .filter((s) => s.rows.length || s.columns.length)
      .slice(0, 12);
    if (!sheets.length) throw new Error("the sheet came back empty");
    return { title, sheets };
  }
  const sections = cleanSections(spec || {});
  if (!sections.length) throw new Error("the document came back empty");
  return { title, subtitle: str(spec?.subtitle, 200), sections };
}

/** Every word in the spec — used only to choose a script-capable font. */
function specText(spec) {
  return JSON.stringify(spec).slice(0, 20000);
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

async function renderPdf(spec, accent) {
  const PDFDocument = require("pdfkit");
  const A = accent;
  const COLORS = ramp(A);
  const doc = new PDFDocument({
    size: "A4",
    margin: 56,
    bufferPages: true,
    autoFirstPage: false,
    info: { Title: spec.title, Author: "MYASSISTANT" },
  });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const finished = new Promise((res) => doc.on("end", res));

  const f = pickFonts(specText(spec));
  const plainNums = !!f.script; // see fmtNum
  let F = "Helvetica", FB = "Helvetica-Bold";
  if (f.regular) {
    try {
      doc.registerFont("body", f.regular);
      doc.registerFont("bodyB", f.bold || f.regular);
      F = "body"; FB = "bodyB";
    } catch { /* keep the built-ins */ }
  }

  doc.addPage();
  const M = doc.page.margins.left;
  const W = doc.page.width - M * 2;
  const FOOT = 64; // reserved strip at the bottom for the page number
  const bottom = () => doc.page.height - FOOT;
  const room = (h) => { if (doc.y + h > bottom()) { doc.addPage(); return true; } return false; };

  // ---- title block
  doc.font(FB).fontSize(23).fillColor(INK).text(spec.title, M, doc.y, { width: W });
  if (spec.subtitle) {
    doc.moveDown(0.35).font(F).fontSize(11.5).fillColor(MUTED).text(spec.subtitle, { width: W });
  }
  doc.moveDown(0.7);
  doc.save().rect(M, doc.y, 64, 3.2).fill(A).restore();
  doc.y += 3.2;
  doc.moveDown(1.2);

  // EVERY CELL IN A ROW SHARES ONE BASELINE. doc.text() advances doc.y, so
  // reading doc.y inside the per-cell loop made each cell start below the
  // previous one and the table came out as a diagonal staircase. The row's
  // y is captured once, and doc.y is moved on deliberately at the end.
  const drawTable = (t) => {
    const n = Math.max(t.columns.length, t.rows[0]?.length || 0);
    if (!n) return;
    const cw = W / n;
    const PAD = 6;
    const head = () => {
      if (!t.columns.length) return;
      const h = 21;
      const y = doc.y;
      doc.save().rect(M, y, W, h).fill(A).restore();
      doc.font(FB).fontSize(8.5).fillColor("#FFFFFF");
      for (let i = 0; i < n; i++) {
        doc.text(t.columns[i] ?? "", M + i * cw + PAD, y + 6.5,
          { width: cw - PAD * 2, height: 11, ellipsis: true, lineBreak: false });
      }
      doc.y = y + h;
    };
    room(64);
    head();
    doc.font(F).fontSize(8.5);
    t.rows.forEach((r, ri) => {
      const cells = Array.from({ length: n }, (_, i) => r[i] ?? "");
      const rh = Math.max(17, Math.max(...cells.map((c) => doc.heightOfString(c, { width: cw - PAD * 2 }))) + 9);
      if (doc.y + rh > bottom()) { doc.addPage(); head(); doc.font(F).fontSize(8.5); }
      const y = doc.y;
      if (ri % 2 === 1) doc.save().rect(M, y, W, rh).fill("#F9FAFB").restore();
      doc.fillColor(INK);
      for (let i = 0; i < n; i++) {
        doc.text(cells[i], M + i * cw + PAD, y + 4.5, { width: cw - PAD * 2 });
      }
      doc.y = y + rh;
      doc.save().moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(0.5).strokeColor(RULE).stroke().restore();
    });
    doc.x = M;
    doc.moveDown(0.8);
  };

  const drawChart = (c) => {
    const H = 190;
    room(H + 36);
    if (c.title) {
      doc.font(FB).fontSize(9.5).fillColor(MUTED).text(c.title, M, doc.y, { width: W });
      doc.moveDown(0.3);
    }
    const top = doc.y;
    const plotH = H - 26;               // leave room for x labels
    const plotW = c.type === "pie" ? W : W - 42;
    const left = c.type === "pie" ? M : M + 42;

    if (c.type === "pie") {
      const vals = c.series[0].values.slice(0, c.labels.length).map((v) => Math.max(0, v));
      const total = vals.reduce((a, b) => a + b, 0) || 1;
      const r = plotH / 2 - 4;
      const cx = M + r + 8, cy = top + plotH / 2;
      let a0 = -Math.PI / 2;
      vals.forEach((v, i) => {
        const a1 = a0 + (v / total) * Math.PI * 2;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const x1 = cx + r * Math.cos(a0), y1 = cy + r * Math.sin(a0);
        const x2 = cx + r * Math.cos(a1), y2 = cy + r * Math.sin(a1);
        doc.save()
          .path(`M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`)
          .fill(COLORS[i % COLORS.length])
          .restore();
        a0 = a1;
      });
      // legend
      let ly = top + 4;
      const lx = cx + r + 22;
      c.labels.forEach((l, i) => {
        if (ly > top + plotH - 10) return;
        doc.save().rect(lx, ly + 1.5, 7, 7).fill(COLORS[i % COLORS.length]).restore();
        doc.font(F).fontSize(8).fillColor(INK)
          .text(`${l} — ${Math.round((vals[i] / total) * 100)}%`, lx + 12, ly, { width: M + W - lx - 12, ellipsis: true });
        ly += 13;
      });
      doc.y = top + plotH + 8;
      doc.moveDown(0.8);
      return;
    }

    const all = c.series.flatMap((s) => s.values);
    const max = Math.max(...all, 0) || 1;
    const min = Math.min(...all, 0);
    const span = max - min || 1;
    const yAt = (v) => top + plotH - ((v - min) / span) * plotH;

    // axis + three gridlines
    doc.save().lineWidth(0.5).strokeColor(RULE);
    for (let i = 0; i <= 3; i++) {
      const y = top + (plotH / 3) * i;
      doc.moveTo(left, y).lineTo(left + plotW, y).stroke();
    }
    doc.restore();
    doc.font(F).fontSize(7).fillColor(MUTED);
    for (let i = 0; i <= 3; i++) {
      const v = max - (span / 3) * i;
      doc.text(fmtNum(v, plainNums), M, top + (plotH / 3) * i - 3.5,
        { width: 36, align: "right", lineBreak: false });
    }

    const step = plotW / c.labels.length;
    if (c.type === "bar") {
      const bw = Math.max(3, (step * 0.66) / c.series.length);
      c.labels.forEach((_, li) => {
        c.series.forEach((s, si) => {
          const v = Number(s.values[li] ?? 0);
          const y = yAt(v), y0 = yAt(Math.max(min, 0));
          const x = left + li * step + step * 0.17 + si * bw;
          doc.save().rect(x, Math.min(y, y0), bw - 1.5, Math.max(1.5, Math.abs(y0 - y)))
            .fill(COLORS[si % COLORS.length]).restore();
        });
      });
    } else {
      c.series.forEach((s, si) => {
        doc.save().lineWidth(1.6).strokeColor(COLORS[si % COLORS.length]);
        s.values.slice(0, c.labels.length).forEach((v, li) => {
          const x = left + li * step + step / 2, y = yAt(Number(v) || 0);
          li === 0 ? doc.moveTo(x, y) : doc.lineTo(x, y);
        });
        doc.stroke().restore();
      });
    }

    // x labels
    doc.font(F).fontSize(7).fillColor(MUTED);
    c.labels.forEach((l, li) => {
      doc.text(l, left + li * step, top + plotH + 5, { width: step, align: "center", height: 9, ellipsis: true });
    });

    // legend when more than one series
    if (c.series.length > 1) {
      let lx = left;
      const ly = top + plotH + 16;
      c.series.forEach((s, si) => {
        doc.save().rect(lx, ly + 1, 7, 7).fill(COLORS[si % COLORS.length]).restore();
        doc.font(F).fontSize(7.5).fillColor(INK).text(s.name, lx + 11, ly, { width: 110, height: 9, ellipsis: true });
        lx += 11 + Math.min(110, doc.widthOfString(s.name)) + 16;
      });
      doc.y = ly + 12;
    } else {
      doc.y = top + plotH + 16;
    }
    doc.moveDown(0.8);
  };

  for (const s of spec.sections) {
    if (s.heading) {
      room(44);
      doc.font(FB).fontSize(13.5).fillColor(A).text(s.heading, M, doc.y, { width: W });
      doc.moveDown(0.4);
    }
    for (const p of s.paragraphs) {
      doc.font(F).fontSize(10.5).fillColor(INK);
      room(Math.min(doc.heightOfString(p, { width: W }), 120));
      doc.text(p, M, doc.y, { width: W, align: "left", lineGap: 2.4 });
      doc.moveDown(0.55);
    }
    if (s.bullets.length) {
      doc.font(F).fontSize(10.5).fillColor(INK);
      room(30);
      doc.list(s.bullets, M, doc.y, { width: W, bulletRadius: 1.6, textIndent: 12, lineGap: 2.4, bulletIndent: 0 });
      doc.moveDown(0.7);
    }
    if (s.table) drawTable(s.table);
    if (s.chart) drawChart(s.chart);
    doc.moveDown(0.35);
  }

  // Footers last, so the page count is final.
  //
  // THE FOOTER SITS BELOW THE BOTTOM MARGIN, and PDFKit treats any text
  // written past that margin as an overflow — it silently starts a new
  // page and draws it there, which produced two blank trailing pages and
  // a footer reading "1 / 2" alone on page 3. Dropping the margin to zero
  // for the duration of the write is the documented way to place content
  // in the footer strip.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 44;
    doc.save().moveTo(M, y - 10).lineTo(M + W, y - 10).lineWidth(0.5).strokeColor(RULE).stroke().restore();
    doc.font(F).fontSize(8).fillColor(MUTED)
      .text(spec.title, M, y, { width: W * 0.7, height: 10, ellipsis: true, lineBreak: false });
    doc.font(F).fontSize(8).fillColor(MUTED)
      .text(`${i + 1} / ${range.count}`, M + W * 0.7, y, { width: W * 0.3, align: "right", lineBreak: false });
    doc.page.margins.bottom = keep;
  }

  doc.end();
  await finished;
  return Buffer.concat(chunks);
}

/**
 * Axis labels. The k/L/Cr suffixes are Latin letters, and a document set
 * in a script font (Noto Sans Devanagari and friends) has no glyph for
 * them — a Hindi report's y-axis read "52.0□". So when the page is set in
 * a script font the numbers are written in full with Indian grouping,
 * which every one of those fonts can draw.
 */
function fmtNum(v, plain = false) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  if (plain) {
    const r = Math.round(n);
    const neg = r < 0 ? "-" : "";
    const d = String(Math.abs(r));
    if (d.length <= 3) return neg + d;
    const head = d.slice(0, d.length - 3);
    return neg + head.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + d.slice(-3);
  }
  const a = Math.abs(n);
  if (a >= 1e7) return (n / 1e7).toFixed(1) + "Cr";
  if (a >= 1e5) return (n / 1e5).toFixed(1) + "L";
  if (a >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/* ------------------------------------------------------------------ */
/* SLIDES (.pptx)                                                      */
/* ------------------------------------------------------------------ */

async function renderSlides(spec, accent) {
  const PptxGenJS = require("pptxgenjs");
  const COLORS = ramp(accent).map(bare);
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9"; // 10 x 5.625 in
  pptx.title = spec.title;
  pptx.author = "MYASSISTANT";

  const W = 10, H = 5.625;

  // ---- opening slide
  const cover = pptx.addSlide();
  cover.background = { color: "0F1020" };
  cover.addShape(pptx.ShapeType.rect, { x: 0, y: H - 0.62, w: W, h: 0.62, fill: { color: bare(accent) } });
  cover.addShape(pptx.ShapeType.rect, { x: 0.62, y: 1.72, w: 0.14, h: 1.5, fill: { color: bare(accent) } });
  cover.addText(spec.title, {
    x: 0.95, y: 1.6, w: W - 1.8, h: 1.7,
    fontSize: 38, bold: true, color: "FFFFFF", fontFace: "Calibri", valign: "middle",
  });
  if (spec.subtitle) {
    cover.addText(spec.subtitle, {
      x: 0.95, y: 3.25, w: W - 1.8, h: 0.8, fontSize: 15, color: "C9C9D6", fontFace: "Calibri",
    });
  }

  spec.slides.forEach((s, i) => {
    const sl = pptx.addSlide();
    sl.background = { color: "FFFFFF" };
    sl.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.16, h: H, fill: { color: bare(accent) } });
    if (s.title) {
      sl.addText(s.title, {
        x: 0.55, y: 0.36, w: W - 1.1, h: 0.85,
        fontSize: 26, bold: true, color: bare(INK), fontFace: "Calibri", valign: "top",
      });
    }
    sl.addShape(pptx.ShapeType.rect, { x: 0.58, y: 1.24, w: 0.9, h: 0.045, fill: { color: bare(accent) } });

    const hasChart = !!s.chart;
    const bodyW = hasChart && s.bullets.length ? (W - 1.2) * 0.46 : W - 1.2;

    if (s.bullets.length) {
      sl.addText(
        s.bullets.map((b) => ({ text: b, options: { bullet: { code: "2022" }, breakLine: true } })),
        {
          x: 0.6, y: 1.5, w: bodyW, h: H - 2.1,
          fontSize: s.bullets.length > 5 ? 14 : 16.5,
          color: "24252E", fontFace: "Calibri", lineSpacingMultiple: 1.28, valign: "top",
        }
      );
    }

    if (hasChart) {
      const cx = s.bullets.length ? 0.66 + bodyW + 0.25 : 0.7;
      const cw = s.bullets.length ? (W - 1.2) * 0.5 : W - 1.6;
      try {
        const data = s.chart.series.map((ser, si) => ({
          name: ser.name,
          labels: s.chart.labels,
          values: s.chart.labels.map((_, li) => Number(ser.values[li] ?? 0)),
          ...(si === 0 ? {} : {}),
        }));
        const type = s.chart.type === "line" ? pptx.ChartType.line
          : s.chart.type === "pie" ? pptx.ChartType.pie
            : pptx.ChartType.bar;
        sl.addChart(type, data, {
          x: cx, y: 1.55, w: cw, h: H - 2.3,
          chartColors: COLORS,
          showLegend: s.chart.series.length > 1 || s.chart.type === "pie",
          legendPos: "b",
          showValue: s.chart.type !== "line" && s.chart.labels.length <= 8,
          dataLabelFontSize: 9,
          catAxisLabelFontSize: 9,
          valAxisLabelFontSize: 9,
          title: s.chart.title || undefined,
          showTitle: !!s.chart.title,
          titleFontSize: 11,
        });
      } catch { /* a bad chart must never cost the slide */ }
    }

    if (s.notes) sl.addNotes(s.notes);
    sl.addText(String(i + 1), {
      x: W - 0.85, y: H - 0.52, w: 0.5, h: 0.3, fontSize: 10, color: "9AA0AA", align: "right", fontFace: "Calibri",
    });
  });

  return Buffer.from(await pptx.write({ outputType: "nodebuffer" }));
}

/* ------------------------------------------------------------------ */
/* WORD (.docx)                                                        */
/* ------------------------------------------------------------------ */

async function renderDocx(spec, accent) {
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
    Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
  } = require("docx");
  const A = bare(accent);
  const kids = [];

  kids.push(new Paragraph({
    spacing: { after: 80 },
    children: [new TextRun({ text: spec.title, bold: true, size: 46, color: bare(INK), font: "Calibri" })],
  }));
  if (spec.subtitle) {
    kids.push(new Paragraph({
      spacing: { after: 200 },
      children: [new TextRun({ text: spec.subtitle, size: 24, color: bare(MUTED), font: "Calibri" })],
    }));
  }
  kids.push(new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: A, space: 1 } },
    spacing: { after: 280 },
    children: [],
  }));

  for (const s of spec.sections) {
    if (s.heading) {
      kids.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 280, after: 120 },
        children: [new TextRun({ text: s.heading, bold: true, size: 28, color: A, font: "Calibri" })],
      }));
    }
    for (const p of s.paragraphs) {
      kids.push(new Paragraph({
        spacing: { after: 160, line: 300 },
        alignment: AlignmentType.LEFT,
        children: [new TextRun({ text: p, size: 22, color: bare(INK), font: "Calibri" })],
      }));
    }
    for (const b of s.bullets) {
      kids.push(new Paragraph({
        bullet: { level: 0 },
        spacing: { after: 90, line: 290 },
        children: [new TextRun({ text: b, size: 22, color: bare(INK), font: "Calibri" })],
      }));
    }
    if (s.table) {
      const n = Math.max(s.table.columns.length, s.table.rows[0]?.length || 0);
      const cell = (text, opts = {}) => new TableCell({
        margins: { top: 90, bottom: 90, left: 110, right: 110 },
        shading: opts.head ? { type: ShadingType.CLEAR, fill: A, color: "auto" } : undefined,
        children: [new Paragraph({
          children: [new TextRun({
            text: String(text ?? ""), bold: !!opts.head, size: 19,
            color: opts.head ? "FFFFFF" : bare(INK), font: "Calibri",
          })],
        })],
      });
      const rows = [];
      if (s.table.columns.length) {
        rows.push(new TableRow({
          tableHeader: true,
          children: Array.from({ length: n }, (_, i) => cell(s.table.columns[i] ?? "", { head: true })),
        }));
      }
      for (const r of s.table.rows) {
        rows.push(new TableRow({ children: Array.from({ length: n }, (_, i) => cell(r[i] ?? "")) }));
      }
      kids.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.SINGLE, size: 2, color: bare(RULE) },
          bottom: { style: BorderStyle.SINGLE, size: 2, color: bare(RULE) },
          left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
          right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
          insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: bare(RULE) },
          insideVertical: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
        },
        rows,
      }));
      kids.push(new Paragraph({ spacing: { after: 220 }, children: [] }));
    }
    // A chart cannot be embedded natively here; its numbers become a table
    // so the figures still reach the page instead of vanishing.
    if (s.chart) {
      const t = {
        columns: ["", ...s.chart.labels],
        rows: s.chart.series.map((ser) => [ser.name, ...s.chart.labels.map((_, i) => String(ser.values[i] ?? ""))]),
      };
      if (s.chart.title) {
        kids.push(new Paragraph({
          spacing: { after: 100 },
          children: [new TextRun({ text: s.chart.title, bold: true, size: 20, color: bare(MUTED), font: "Calibri" })],
        }));
      }
      const n = t.columns.length;
      const cell = (text, head) => new TableCell({
        margins: { top: 80, bottom: 80, left: 100, right: 100 },
        shading: head ? { type: ShadingType.CLEAR, fill: A, color: "auto" } : undefined,
        children: [new Paragraph({
          children: [new TextRun({ text: String(text ?? ""), bold: !!head, size: 18, color: head ? "FFFFFF" : bare(INK), font: "Calibri" })],
        })],
      });
      kids.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ tableHeader: true, children: t.columns.map((c) => cell(c, true)) }),
          ...t.rows.map((r) => new TableRow({ children: Array.from({ length: n }, (_, i) => cell(r[i] ?? "")) })),
        ],
      }));
      kids.push(new Paragraph({ spacing: { after: 220 }, children: [] }));
    }
  }

  const docx = new Document({
    creator: "MYASSISTANT",
    title: spec.title,
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } }, children: kids }],
  });
  return Packer.toBuffer(docx);
}

/* ------------------------------------------------------------------ */
/* EXCEL (.xlsx)                                                       */
/* ------------------------------------------------------------------ */

async function renderSheet(spec, accent) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "MYASSISTANT";
  wb.created = new Date();
  const A = bare(accent);

  for (const s of spec.sheets) {
    const ws = wb.addWorksheet(s.name, { views: [{ state: "frozen", ySplit: s.columns.length ? 1 : 0 }] });
    if (s.columns.length) {
      const head = ws.addRow(s.columns);
      head.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      head.height = 22;
      head.alignment = { vertical: "middle" };
      head.eachCell((c) => {
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + A } };
        c.border = { bottom: { style: "thin", color: { argb: "FFD1D5DB" } } };
      });
    }
    for (const r of s.rows) {
      ws.addRow(r.map((v) => (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v)));
    }

    // Column widths from the widest real value, capped so one long note
    // cannot push every other column off the screen.
    const n = Math.max(s.columns.length, ...s.rows.map((r) => r.length), 1);
    for (let i = 1; i <= n; i++) {
      let w = String(s.columns[i - 1] ?? "").length + 2;
      for (const r of s.rows) w = Math.max(w, String(r[i - 1] ?? "").length + 2);
      ws.getColumn(i).width = Math.min(Math.max(w, 9), 46);
    }

    // A real SUM formula, not a baked number: the user can edit a row and
    // the total follows.
    if (s.totalRow && s.rows.length) {
      const first = s.columns.length ? 2 : 1;
      const last = ws.rowCount;
      const cells = [];
      for (let i = 1; i <= n; i++) {
        const numeric = s.rows.every((r) => r[i - 1] == null || r[i - 1] === "" || Number.isFinite(Number(r[i - 1])))
          && s.rows.some((r) => Number.isFinite(Number(r[i - 1])) && String(r[i - 1]).trim() !== "");
        // A CACHED RESULT AS WELL AS THE FORMULA. A formula with no cached
        // value shows as blank in every viewer that does not recalculate —
        // which on a phone is most of them — so the total the user asked
        // for would simply not be there. Excel still recalculates on edit.
        const col = ws.getColumn(i).letter;
        const result = s.rows.reduce((a, r) => a + (Number(r[i - 1]) || 0), 0);
        cells.push(numeric && i > 1
          ? { formula: `SUM(${col}${first}:${col}${last})`, result }
          : (i === 1 ? "Total" : null));
      }
      const row = ws.addRow(cells);
      row.font = { bold: true };
      row.eachCell((c) => {
        c.border = { top: { style: "double", color: { argb: "FF" + A } } };
      });
    }

    if (s.note) {
      ws.addRow([]);
      const note = ws.addRow([s.note]);
      note.font = { italic: true, color: { argb: "FF6B7280" }, size: 10 };
    }
    ws.autoFilter = s.columns.length && s.rows.length
      ? { from: { row: 1, column: 1 }, to: { row: 1, column: n } }
      : undefined;
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ------------------------------------------------------------------ */
/* PUBLIC                                                              */
/* ------------------------------------------------------------------ */

const RENDER = { pdf: renderPdf, slides: renderSlides, doc: renderDocx, sheet: renderSheet };

function safeName(title, ext) {
  const base = String(title || "document")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70) || "document";
  return base + ext;
}

/**
 * Write a document end to end.
 * @returns {Promise<{buffer:Buffer, mime:string, filename:string, title:string, summary:string}>}
 */
async function create(kind, options = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown document kind "${kind}"`);
  const accent = hex(options.accent);
  const raw = await authorSpec(kind, { ...options, today: options.today || todayLine(options.tzOffsetMin) });
  const spec = normalize(kind, raw);
  const buffer = await RENDER[kind](spec, accent);
  if (!buffer?.length) throw new Error("the file came out empty");
  const title = options.title ? String(options.title).slice(0, 140) : spec.title;
  return {
    buffer,
    mime: MIME[kind],
    filename: safeName(title, EXT[kind]),
    title,
    label: LABEL[kind],
    summary: summarize(kind, spec),
    text: flatten(kind, spec),
  };
}

/**
 * The document as plain text, stored as the row's full_text so the file
 * the assistant just wrote is searchable and answerable later ("what did
 * that proposal say about pricing?") exactly like an uploaded one.
 */
function flatten(kind, spec) {
  const out = [spec.title];
  if (spec.subtitle) out.push(spec.subtitle);
  if (kind === "slides") {
    spec.slides.forEach((s, i) => {
      out.push(`\nSlide ${i + 2}: ${s.title}`);
      s.bullets.forEach((b) => out.push(`  • ${b}`));
      if (s.chart) out.push(`  [chart] ${s.chart.title || ""} ${s.chart.labels.join(", ")}`);
      if (s.notes) out.push(`  Notes: ${s.notes}`);
    });
  } else if (kind === "sheet") {
    spec.sheets.forEach((sh) => {
      out.push(`\n[${sh.name}]`);
      if (sh.columns.length) out.push(sh.columns.join(" | "));
      sh.rows.slice(0, 200).forEach((r) => out.push(r.join(" | ")));
      if (sh.note) out.push(sh.note);
    });
  } else {
    spec.sections.forEach((sec) => {
      if (sec.heading) out.push(`\n${sec.heading}`);
      sec.paragraphs.forEach((p) => out.push(p));
      sec.bullets.forEach((b) => out.push(`• ${b}`));
      if (sec.table) {
        if (sec.table.columns.length) out.push(sec.table.columns.join(" | "));
        sec.table.rows.forEach((r) => out.push(r.join(" | ")));
      }
      if (sec.chart) out.push(`[chart] ${sec.chart.title || ""} ${sec.chart.labels.join(", ")}`);
    });
  }
  return out.join("\n").slice(0, 12000);
}

function summarize(kind, spec) {
  if (kind === "slides") return `${spec.slides.length + 1} slides`;
  if (kind === "sheet") {
    const rows = spec.sheets.reduce((a, s) => a + s.rows.length, 0);
    return `${spec.sheets.length} tab${spec.sheets.length === 1 ? "" : "s"}, ${rows} rows`;
  }
  const words = spec.sections.reduce(
    (a, s) => a + s.paragraphs.join(" ").split(/\s+/).length + s.bullets.join(" ").split(/\s+/).length, 0);
  return `${Math.max(1, Math.round(words / 380))} page${words > 560 ? "s" : ""}`;
}

module.exports = { create, KINDS, MIME, EXT, LABEL, authorSpec, normalize, flatten, RENDER, hex };
