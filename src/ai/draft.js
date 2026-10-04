/**
 * THE DRAFT PAD (owner, 2026-10-04): "draft an email / a cover letter /
 * anything" opens an editable pad on the phone and the words appear as
 * they are written; "change this, add that" edits exactly that and
 * nothing else. The phone streams from POST /ai/draft with what is on the
 * pad right now (the user may have typed in it), so an edit always works
 * on the real text, never on the model's memory of it.
 */
const SYSTEM = [
  "You are a professional writer working on ONE document in the user's draft pad.",
  "Return ONLY the document text — no preamble, no 'Here is', no closing remark, no markdown symbols (** or #).",
  "Plain text: short paragraphs separated by a blank line; an email starts with a 'Subject:' line.",
  "Write in the language and tone the instruction asks for; otherwise clear, warm, professional English.",
  "NEVER invent facts: names, dates, numbers, addresses, phone numbers, company or job details the user did not give stay as a bracketed placeholder such as [Company name].",
].join("\n");

const EDIT_RULES = [
  "You are given the CURRENT DOCUMENT and an EDIT INSTRUCTION.",
  "Apply exactly the requested change and keep everything else word for word — same wording, order and line breaks.",
  "If the instruction asks to continue, add or append, keep the whole document and add the new part where it belongs.",
  "If the instruction asks to rewrite, polish or make it professional, improve the whole document while keeping its facts.",
  "Return the COMPLETE revised document, never only the changed part.",
].join("\n");

const MAX_CURRENT = 60_000;

function messagesFor({ instruction, current, title }) {
  const ask = String(instruction || "").trim().slice(0, 4000);
  const doc = String(current || "").slice(0, MAX_CURRENT);
  if (!doc.trim()) {
    return {
      system: SYSTEM,
      messages: [{ role: "user", content: `${title ? `Title: ${title}\n` : ""}Write this: ${ask}` }],
    };
  }
  return {
    system: `${SYSTEM}\n\n${EDIT_RULES}`,
    messages: [{ role: "user", content: `CURRENT DOCUMENT:\n<<<\n${doc}\n>>>\n\nEDIT INSTRUCTION: ${ask}` }],
  };
}

/** Streams the draft (new or revised) through onDelta; resolves with the full text. */
async function streamDraft(body, onDelta) {
  const instruction = String((body && body.instruction) || "").trim();
  if (!instruction) {
    const e = new Error("instruction required");
    e.status = 400;
    throw e;
  }
  const openai = require("../services/ai/openai");
  const { system, messages } = messagesFor(body);
  const out = await openai.chat({
    system,
    messages,
    // A cheaper model than the brain (owner, 2026-10-04): drafting is its own
    // request, apart from the voice and calls. OPENAI_DRAFT_MODEL swaps it.
    model: process.env.OPENAI_DRAFT_MODEL || "gpt-4.1-mini",
    temperature: 0.4,
    maxTokens: 16_000,
    timeoutMs: 120_000,
    stream: true,
    onDelta,
  });
  return out.text || "";
}

module.exports = { streamDraft, messagesFor, MAX_CURRENT };
