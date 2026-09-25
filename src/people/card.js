/**
 * BUSINESS CARD SCANNER. Owner's pick, 2026-09-23.
 *
 * One photo of a visiting card in, one person out: name, designation,
 * company, phone numbers, emails, website, address — saved to the user's
 * people (the same cards the assistant already looks people up in), with
 * the card photo kept in their documents. The app then offers "add to
 * phone contacts" and a ready "nice meeting you" on WhatsApp.
 *
 * One Gemini vision call per card; nothing is re-read later.
 */
const { envModel } = require("../services/ai/router");
const db = require("../db");

// Unset, the alias Google keeps current (2.5 Flash answers new users 404).
const MODEL = () => envModel("GEMINI_VISION_MODEL", "gemini-flash-latest");

const PROMPT = `This is a photo of a business / visiting card. Read it and reply
with STRICT JSON only (no markdown):
{"name":"<the person's full name, as printed>",
 "title":"<designation / job title, or empty>",
 "company":"<company or organisation, or empty>",
 "phones":["<every phone number, digits with + and country code if printed>"],
 "emails":["<every email address>"],
 "website":"<website, or empty>",
 "address":"<postal address on one line, or empty>"}
If a field is not on the card, use an empty string or empty list. Never
invent anything. If this is not a business card, return empty fields.`;

const clean = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);

/** @returns {Promise<object|null>} the card's fields, or null on failure */
async function readCard(buffer, mime) {
  const keys = require("../services/ai/keys");
  if (!keys.pool().length) return null;
  try {
    const data = await keys.withKeyRotation(MODEL(), async (key) => {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [
                { inline_data: { mime_type: mime, data: buffer.toString("base64") } },
                { text: PROMPT },
              ],
            }],
            generationConfig: { response_mime_type: "application/json", temperature: 0.1 },
          }),
        }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw Object.assign(new Error(`card ${res.status}`), { status: res.status, body });
      }
      return res.json();
    });
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    return normalise(JSON.parse(text));
  } catch (e) {
    console.error("card read failed:", e.message);
    return null;
  }
}

function normalise(j = {}) {
  const list = (a, n) => (Array.isArray(a) ? a : [a])
    .map((x) => clean(x, n)).filter(Boolean).slice(0, 4);
  return {
    name: clean(j.name, 120),
    title: clean(j.title, 120),
    company: clean(j.company, 160),
    phones: list(j.phones, 30).map((p) => p.replace(/[^\d+]/g, "")).filter((p) => p.length >= 6),
    emails: list(j.emails, 120).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)).map((e) => e.toLowerCase()),
    website: clean(j.website, 160),
    address: clean(j.address, 300),
  };
}

/**
 * Saves the card as a person (merging into an existing one of the same
 * name) and keeps the photo in their documents.
 */
async function saveCard(userId, card, { buffer, mime } = {}) {
  const mem = require("../memory/service");
  const who = card.name || card.company;
  const summary = [card.title, card.company, card.website, card.address]
    .filter(Boolean).join(" · ").slice(0, 600);
  const p = await mem.upsertPerson(userId, {
    name: who,
    organisation: card.company,
    relationship: "business contact",
    summary,
  });
  // upsertPerson does not carry phone/email — a card is exactly where
  // they come from, so fill them in (never blanking what was known).
  await db.run(
    `UPDATE clients SET phone = CASE WHEN $3 <> '' THEN $3 ELSE phone END,
            email = CASE WHEN $4 <> '' THEN $4 ELSE email END
      WHERE id=$1 AND user_id=$2`,
    [p.id, userId, card.phones[0] || "", card.emails[0] || ""]
  );

  let documentId = null;
  if (buffer && buffer.length) {
    try {
      const docs = require("../docs/store");
      const ext = mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : ".jpg";
      const doc = await docs.createDocument(userId, {
        buffer, mime, filename: `card-${who.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}${ext}`,
        note: `Business card of ${who}`,
      });
      await docs.setMetadata(userId, doc.id, {
        title: `Business card — ${who}`,
        category: "other",
        summary: [card.name, summary, card.phones.join(", "), card.emails.join(", ")]
          .filter(Boolean).join(" · "),
        tags: ["business card", card.company, card.name].filter(Boolean),
        fullText: JSON.stringify(card),
      });
      documentId = doc.id;
    } catch (e) {
      console.error("card photo not kept:", e.message);
    }
  }
  return { id: p.id, created: p.created, ...card, documentId };
}

module.exports = { readCard, saveCard, normalise };
