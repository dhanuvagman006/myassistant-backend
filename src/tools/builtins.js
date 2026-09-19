/**
 * BUILT-IN TOOLS — existing capabilities, exposed to the agent runtime.
 *
 * Every tool here WRAPS a module that already worked (weather, news,
 * places, currency, reminders, documents, people, calls). Nothing is
 * reimplemented and nothing is faked: if an integration is missing, the
 * tool says so honestly rather than returning a pretend result (§28).
 */
const registry = require("./registry");
const { normalizePhone } = require("../users/phone");

/// Parses a model-supplied datetime as the USER's wall-clock time.
/// Models routinely emit bare ISO strings ("2026-09-04T17:00:00"); the old
/// `new Date(s)` read those in the SERVER's zone (UTC in the container),
/// so "5 pm" became 10:30 pm IST. A string carrying its own offset/Z is
/// trusted as-is; a bare one is shifted by ctx.tzOffsetMin.
function parseUserTime(s, tzOffsetMin) {
  if (!s) return null;
  const str = String(s).trim();
  if (!str) return null;
  const hasOffset = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(str);
  const ms = Date.parse(hasOffset ? str : `${str}Z`);
  if (!Number.isFinite(ms)) return null;
  const tz = Number.isFinite(tzOffsetMin) ? tzOffsetMin : 330;
  return hasOffset ? ms : ms - tz * 60_000;
}

const weather = require("../services/tools/weather");
const news = require("../services/tools/news");
const places = require("../services/tools/places");
const currency = require("../services/tools/currency");
const reminders = require("../reminders/store");
const memory = require("../agents/memory");
const docs = require("../docs/store");
const people = require("../clients/store");

let registered = false;

function registerBuiltins() {
  if (registered) return; // idempotent: tests and boot both call this
  registered = true;

  // Reference knowledge (law, government services, money, health, travel)
  // is ONE retrieval-grounded tool over many domain packs — see
  // tools/knowledge.js for why it is not one tool per domain.
  require("./knowledge").registerKnowledgeTools();

  // ---------------- INFORMATION (low risk) ----------------

  registry.register({
    name: "get_weather",
    description:
      "Current weather and short forecast for a city or the user's area. " +
      "Use whenever the user asks about weather, rain, temperature or what to wear.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City name. Omit to use the user's current area.",
        },
      },
    },
    async execute(args, ctx) {
      // getWeather takes {city, lat, lng}, not a bare string — passing the
      // string made every lookup return null ("weather service returned
      // nothing") since where.city was always undefined. A named city wins;
      // otherwise fall back to the device's coordinates.
      const w = args.location
        ? await weather.getWeather({ city: String(args.location) })
        : await weather.getWeather({ city: ctx.city, lat: ctx.lat, lng: ctx.lng });
      if (!w) return { ok: false, error: "weather service returned nothing" };
      return { ok: true, data: w, speak: weather.describe(w) };
    },
  });

  registry.register({
    name: "get_news",
    description:
      "Latest news headlines, optionally about a topic, company or person. " +
      "Use for anything current: today's news, what's happening with X.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Subject to search, e.g. 'NVIDIA'. Omit for top headlines.",
        },
      },
    },
    async execute(args, ctx) {
      // Ask for the whole page, not six: freshFor picks what this user has
      // not been read yet. Asked twice, the second answer used to be the
      // identical six headlines from cache — the same BRICS story, again.
      const items = await news.getHeadlines({ topic: args.topic, max: 12 });
      if (!items || !items.length) {
        return { ok: false, error: "no headlines found" };
      }
      const fresh = news.freshFor(ctx && ctx.userId, items, 6);
      return { ok: true, data: fresh, speak: news.describe(fresh, args.topic) };
    },
  });

  registry.register({
    name: "daily_brief",
    description:
      "The user's brief for today: agenda (reminders and calendar meetings), " +
      "open promises they made, unread messages from other people's " +
      "assistants, and the weather. Use when they ask for their brief, " +
      "'what's my day look like', 'what's on my plate', 'catch me up', or " +
      "'anything I'm missing?'.",
    risk: "low",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const uid = Number(ctx.userId);
      if (!Number.isInteger(uid) || uid <= 0) {
        return { ok: false, error: "not signed in" };
      }
      const { buildBrief, speakBrief } = require("../services/brief");
      const b = await buildBrief(uid, {
        lat: ctx.lat,
        lng: ctx.lng,
        tzOffsetMin: ctx.tzOffsetMin,
      });
      return { ok: true, data: b, speak: speakBrief(b) };
    },
  });

  registry.register({
    name: "convert_currency",
    description: "Convert an amount between currencies at the current rate.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Amount to convert" },
        from: { type: "string", description: "3-letter code, e.g. USD" },
        to: { type: "string", description: "3-letter code, e.g. INR" },
      },
      required: ["amount", "from", "to"],
    },
    async execute(args) {
      const rate = await currency.getRate(
        String(args.from).toUpperCase(),
        String(args.to).toUpperCase()
      );
      if (!rate) return { ok: false, error: "rate unavailable" };
      const value = args.amount * rate;
      return {
        ok: true,
        data: { rate, value },
        speak: `${args.amount} ${args.from.toUpperCase()} is about ${value.toFixed(2)} ${args.to.toUpperCase()}.`,
      };
    },
  });

  // ---------------- MEMORY ----------------

  registry.register({
    name: "remember_fact",
    description:
      "Store a durable fact about the user or their life so it is remembered " +
      "in future conversations (preferences, family, work, important dates).",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "The fact, in third person: 'prefers Kannada'" },
        about: { type: "string", description: "Person this fact concerns, if any" },
        importance: { type: "integer", description: "1-5, default 3" },
      },
      required: ["fact"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      let subjectType = "", subjectId = null;
      if (args.about) {
        const p = await mem.findPerson(ctx.userId, args.about);
        if (p) { subjectType = "person"; subjectId = p.id; }
      }
      await mem.remember(ctx.userId, {
        fact: args.fact,
        importance: args.importance || 3,
        subjectType, subjectId,
      });
      return { ok: true, data: { saved: args.fact }, speak: "I'll remember that." };
    },
  });

  registry.register({
    name: "recall_memory",
    description:
      "Look up what is remembered about the user or a topic. Use when asked " +
      "'what do you know about me', 'what did I tell you about X', or when " +
      "personal context would improve the answer." +
      " SCOPE: durable facts about the user's life only. NEVER use it " +
      "for what happened in this conversation or for what you did — " +
      "'what did I just ask', 'when did I ask you to call X', 'did you " +
      "open that' are answered by check_recent_actions or by reading the " +
      "conversation in front of you, never by recalling memory.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What to recall about" } },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      if (args.query) {
        const r = await mem.search(ctx.userId, args.query);
        return { ok: true, data: r };
      }
      const list = await memory.listMemories(ctx.userId);
      return { ok: true, data: list };
    },
  });

  registry.register({
    name: "end_conversation",
    description:
      "The user is ENDING the conversation — 'bye', 'goodbye', 'ok bye', " +
      "'that's all', 'we're done', 'stop', 'thanks, bye', 'ಸಾಕು', 'बस', " +
      "'ok thank you' as a clear sign-off. Call this IMMEDIATELY and say " +
      "AT MOST a three-word farewell in their language ('Goodbye!', " +
      "'ಸರಿ, ಬೈ!'). Never continue the conversation after it, never ask " +
      "'anything else?', never summarise. The screen closes itself.",
    risk: "low",
    deviceAction: true,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return {
        ok: true,
        deviceAction: { type: "end_conversation" },
        speak: "Goodbye!",
      };
    },
  });

  registry.register({
    name: "call_recall",
    description:
      "Search the user's ANALYSED PHONE CALLS (AI call analysis records " +
      "and transcribes them; each call carries a full summary, a list of " +
      "concrete FACTS, and the transcript). Use for ANY question whose " +
      "answer might live in a call — 'when will Yashmitha return', " +
      "'when is my exam', 'how much did the repair cost', 'what was my " +
      "last communication with X', 'did we fix a time yesterday'. Answer " +
      "from the facts and transcript, not only the summary. This is the " +
      "ONLY channel of past conversations: SMS and WhatsApp history " +
      "cannot be read, so never route such questions there. Only calls " +
      "made with analysis enabled exist here; if nothing matches, say so " +
      "and mention the toggle.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        person: {
          type: "string",
          description:
            "Name or number of the other party. REQUIRED whenever the " +
            "user names a person — never omit it and answer from " +
            "somebody else's call.",
        },
        daysBack: {
          type: "number",
          description:
            "How many days back to search, e.g. 4 for 'four days ago'. Omit for the last 30 days.",
        },
        query: {
          type: "string",
          description: "Topic words to find inside the calls, if the user gave any.",
        },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const days = Number(args.daysBack);
      // "4 days back" means AROUND that day, not everything since — a ±1
      // day window when a specific distance was named, else 30 days.
      let from, to;
      if (Number.isFinite(days) && days > 0) {
        const target = Date.now() - days * 86400_000;
        from = target - 86400_000;
        to = target + 86400_000;
      } else {
        from = Date.now() - 30 * 86400_000;
        to = Date.now() + 1;
      }
      // processing rows included on purpose: "what did my last call say"
      // seconds after hanging up should answer "still analysing", not
      // "no such call".
      const wheres = [`user_id = $1`, `started_at BETWEEN $2 AND $3`,
        `status IN ('done','processing')`];
      const params = [ctx.userId, from, to];
      if (args.person) {
        params.push(`%${String(args.person).trim()}%`);
        wheres.push(
          `(peer_name ILIKE $${params.length} OR peer_number ILIKE $${params.length})`);
      }
      if (args.query) {
        params.push(`%${String(args.query).trim()}%`);
        wheres.push(
          `(transcript ILIKE $${params.length} OR summary ILIKE ` +
          `$${params.length} OR facts ILIKE $${params.length})`);
      }
      const { query } = require("../db");
      const rows = await query(
        `SELECT id, peer_name, peer_number, direction, started_at,
                duration_s, summary, actions, status, facts,
                LEFT(transcript, 4000) AS transcript_excerpt
           FROM call_records WHERE ${wheres.join(" AND ")}
          ORDER BY started_at DESC LIMIT 5`,
        params
      );
      if (!rows.length) {
        return {
          ok: true,
          data: { calls: [] },
          speak:
            "I don't have an analysed call matching that. Calls are only " +
            "recorded when AI call analysis is switched on in Settings.",
        };
      }
      if (rows.every((r) => r.status === "processing")) {
        return {
          ok: true,
          data: { calls: rows },
          speak: "I'm still going through that call — give me a minute " +
            "and ask again.",
        };
      }
      return { ok: true, data: { calls: rows } };
    },
  });

  // ---------------- PEOPLE (clients/contacts the user told us about) ------

  const mem = require("../memory/service");

  registry.register({
    name: "remember_person",
    description:
      "Record or update a PERSON the user tells you about — their name, how " +
      "they relate to the user (client, patient, friend, colleague), their " +
      "organisation and location. Use for 'Ravi is my client', 'my doctor is " +
      "Dr Rao at Manipal'.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Person's name" },
        relationship: { type: "string", description: "client, patient, friend, wife, colleague…" },
        organisation: { type: "string", description: "Company or institution" },
        location: { type: "string", description: "City or place" },
      },
      required: ["name"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      // The page tag (kind) follows the stated relationship, so "Riya is
      // my friend" shows Friend on her card — not a default like Patient.
      const p = await mem.upsertPerson(ctx.userId, {
        ...args,
        kind: args.relationship,
      });
      return { ok: true, data: { id: p.id, name: p.name }, speak: "Noted." };
    },
  });

  registry.register({
    name: "add_person_note",
    description:
      "File a dated note on a PERSON's record — anything the user tells you " +
      "about someone that is worth keeping: money owed either way ('Chetan " +
      "owes me 15,000'), health details, preferences, family facts, things " +
      "they said. The note lands on that person's page in the app and comes " +
      "back whenever the user asks about them. Creates the person if they " +
      "are not on file yet. This is the DEFAULT place for facts about a " +
      "person — NOT create_reminder (reminders are only for 'remind me').",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Person's name" },
        note: { type: "string", description: "The fact to file, in plain words, e.g. 'Owes me ₹15,000'" },
        relationship: { type: "string", description: "friend, patient, client, colleague… when the user's words imply it" },
      },
      required: ["name", "note"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const p = await mem.upsertPerson(ctx.userId, {
        name: args.name,
        relationship: args.relationship,
        // The page tag follows the stated relationship ("friend"), so a
        // friend never gets filed looking like a patient.
        kind: args.relationship,
      });
      const { run } = require("../db");
      await run(
        `INSERT INTO client_notes (user_id, client_id, text, created_at)
         VALUES ($1,$2,$3,$4)`,
        [ctx.userId, p.id, String(args.note).slice(0, 500), Date.now()]
      );
      return {
        ok: true,
        data: { person: p.name },
        speak: `Noted on ${p.name}'s page.`,
      };
    },
  });

  registry.register({
    name: "remember_case",
    description:
      "Record a CASE, matter or project — a legal case, medical record, " +
      "business project or personal matter — and optionally attach a person " +
      "to it. Use for 'his case is a property dispute in Mangalore'.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title, e.g. 'Property dispute'" },
        person: { type: "string", description: "Person this case belongs to" },
        description: { type: "string" },
        location: { type: "string" },
        status: { type: "string", description: "open, closed, on_hold" },
      },
      required: ["title"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      let personId = null;
      if (args.person) {
        const p = await mem.upsertPerson(ctx.userId, { name: args.person });
        personId = p.id;
      }
      const c = await mem.upsertCase(ctx.userId, { ...args, personId });
      return { ok: true, data: { id: c.id, title: c.title }, speak: "Got it." };
    },
  });

  registry.register({
    name: "remember_event",
    description:
      "Record a dated event tied to a person or case — a hearing, meeting, " +
      "appointment or deadline. Use for \'Ravi\'s next hearing is on September 3\'.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What the event is" },
        when: { type: "string", description: "ISO-8601 date/time if known" },
        person: { type: "string", description: "Person it relates to" },
        case_title: { type: "string", description: "Case it relates to" },
      },
      required: ["title"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      let subjectType = "", subjectId = null;
      if (args.person) {
        const p = await mem.upsertPerson(ctx.userId, { name: args.person });
        subjectType = "person"; subjectId = p.id;
      }
      const when = parseUserTime(args.when, ctx.tzOffsetMin);
      const e = await mem.addEvent(ctx.userId, {
        title: args.title,
        whenAt: when,
        subjectType, subjectId,
      });
      // Also store as a retrievable fact so plain recall finds it.
      if (subjectId) {
        await mem.remember(ctx.userId, {
          fact: args.when ? `${args.title} on ${args.when}` : args.title,
          kind: "episodic", subjectType, subjectId, importance: 4,
        });
      }
      return { ok: true, data: { id: e.id }, speak: "I'll remember that." };
    },
  });

  registry.register({
    name: "forget_memory",
    description:
      "Delete or correct something previously remembered, when the user says " +
      "it is wrong or asks you to forget it. Use for 'forget Ravi\'s hearing " +
      "date', 'Ravi is not my client anymore'.",
    risk: "high",
    inputSchema: {
      type: "object",
      properties: {
        about: { type: "string", description: "Person or case it concerns" },
        what: { type: "string", description: "What to forget, e.g. 'hearing date'" },
      },
      required: ["what"],
    },
    confirmSummary: (a) =>
      a.about ? `Forget ${a.about}'s ${a.what}` : `Forget: ${a.what}`,
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      let subjectType = "", subjectId = null;
      if (args.about) {
        const p = await mem.findPerson(ctx.userId, args.about);
        if (p) { subjectType = "person"; subjectId = p.id; }
      }
      const n = await mem.forget(ctx.userId, { subjectType, subjectId, match: args.what });
      if (!n) return { ok: false, error: "nothing matching was stored" };
      return { ok: true, data: { forgotten: n }, speak: "Forgotten." };
    },
  });

  registry.register({
    name: "lookup_person",
    description:
      "Retrieve everything stored about a person the user has told us about " +
      "(relationship, organisation, notes, linked documents, and saved " +
      "birthdays/anniversaries under `dates`). Use for 'what do you know " +
      "about Ravi', 'tell me about my client X', 'when is Allen's birthday'.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Person's name" } },
      required: ["name"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const profile = await mem.recallAbout(ctx.userId, args.name);
      if (!profile) return { ok: false, error: `nothing stored about ${args.name}` };
      return { ok: true, data: profile };
    },
  });

  registry.register({
    name: "list_person_documents",
    description:
      "List documents linked to a person, e.g. 'show me Ravi's documents'.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Person's name" },
        show: {
          type: "boolean",
          description:
            "Default true: the documents POP UP full-screen. Pass false " +
            "when only locating them as a step toward another action — " +
            "nothing should open unless the user asked to SEE them.",
        },
      },
      required: ["name"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const found = await mem.findPerson(ctx.userId, args.name);
      if (!found) return { ok: false, error: `no person named ${args.name}` };
      // recallAbout gathers the full set (person + their cases) but only
      // compact rows; re-fetch those ids so the app gets the real document
      // shape (mime, filename, dates) its cards and gallery render from.
      const profile = await mem.recallAbout(ctx.userId, found.name);
      const ids = (profile ? profile.documents : []).map((d) => d.id);
      if (!ids.length) return { ok: false, error: `no documents stored for ${found.name}` };
      const { query } = require("../db");
      const rows = await query(
        `SELECT * FROM documents WHERE user_id=$1 AND id = ANY($2::bigint[])
          ORDER BY created_at DESC LIMIT 50`,
        [ctx.userId, ids]
      );
      const all = rows.map(docs.toClient);
      const out = { ok: true, data: all };
      if (args.show !== false) {
        out.deviceAction = { type: "documents", documents: all };
      }
      return out;
    },
  });

  // ---------------- DOCUMENTS ----------------

  registry.register({
    name: "search_documents",
    description:
      "Search the user's saved documents (receipts, reports, notices) by text.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What to look for" } },
      required: ["query"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      // searchDocuments returns {hits, exact}, not a bare array — the old
      // .length check on the object made this tool report "no matching
      // documents" for EVERY query.
      const r = await docs.searchDocuments(ctx.userId, args.query);
      const list = (r && r.hits) || [];
      if (!list.length) return { ok: false, error: "no matching documents" };
      return { ok: true, data: list.map(docs.toClient) };
    },
  });

  // ---------------- PRODUCTIVITY ----------------

  registry.register({
    name: "search_flights",
    // Hidden without an airline API key, so the model searches instead.
    available: () => Boolean(require("./flights").provider()),
    description:
      "Find real flights between two cities on a date. Use for 'next flight " +
      "from Bangalore to Delhi', 'flights to Mumbai tomorrow'.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Origin city or 3-letter airport code" },
        to: { type: "string", description: "Destination city or 3-letter airport code" },
        date: { type: "string", description: "Departure date YYYY-MM-DD; omit for tomorrow" },
        adults: { type: "integer", description: "Passengers, default 1" },
      },
      required: ["from", "to"],
    },
    async execute(args) {
      return require("./flights").search(args);
    },
  });

  registry.register({
    name: "find_document",
    description:
      "Find a specific document, optionally belonging to a person — e.g. " +
      "'find Ravi's court notice', 'show me the electricity bill'. Searches " +
      "INSIDE document contents, not just titles.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What the document is, e.g. 'court notice'" },
        person: { type: "string", description: "Whose document, if the user named someone" },
        show: {
          type: "boolean",
          description:
            "Default true: the matches POP UP full-screen on the user's " +
            "phone. Pass false when you are only locating a document as a " +
            "step toward something else (sending it, answering a question " +
            "about it) — nothing should open unless the user asked to SEE it.",
        },
      },
      required: ["query"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const intel = require("../docs/intelligence");
      const r = await intel.findDocuments(ctx.userId, args.query, { person: args.person });
      if (!r.found) {
        // A person who HAS documents, just none matching this query: say
        // so and point at the listing tool, instead of a bare "nothing"
        // that reads as an empty file.
        if (args.person) {
          const p = await mem.findPerson(ctx.userId, args.person);
          const prof = p && (await mem.recallAbout(ctx.userId, p.name));
          const n = prof ? prof.documents.length : 0;
          if (n > 0) {
            return {
              ok: false,
              error:
                `nothing matching "${args.query}" among ${p.name}'s ${n} saved ` +
                `document(s) — call list_person_documents to show them all`,
            };
          }
        }
        return {
          ok: false,
          error: r.scope
            ? `no documents for ${r.scope} matching that`
            : "no matching documents",
        };
      }
      const out = { ok: true, data: r.documents };
      if (args.show !== false) {
        out.deviceAction = { type: "documents", documents: r.documents };
      }
      return out;
    },
  });

  registry.register({
    name: "get_last_document",
    description:
      "Read the user's MOST RECENTLY saved document or scan — its title, " +
      "summary and full extracted text — and show it on their screen. Use " +
      "whenever they ask about 'the image/photo/document I just scanned', " +
      "'what does it say', 'tell me about that picture I saved'. Answer " +
      "their questions FROM the returned text.",
    risk: "low",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const { one } = require("../db");
      const d = await one(
        `SELECT * FROM documents WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [ctx.userId]
      );
      if (!d) return { ok: false, error: "no documents saved yet" };
      const client = docs.toClient(d);
      const fullText = String(d.full_text || "").trim();
      return {
        ok: true,
        data: {
          ...client,
          full_text: fullText.slice(0, 4000),
          // The vision pass runs seconds after upload; be honest if the
          // user asks before it lands instead of hallucinating contents.
          ...(fullText
            ? {}
            : {
                status:
                  "still being analyzed — the text will be readable in a few seconds; say so and offer to check again",
              }),
        },
        deviceAction: { type: "documents", documents: [client] },
      };
    },
  });

  registry.register({
    name: "associate_document",
    description:
      "Link the most recent (or a named) document to a person in memory and/or " +
      "a case — 'this document belongs to Ravi's case'. If the person is one of " +
      "the user's saved clients/patients the document is filed in that case " +
      "file (prefer file_document_under_client for that).",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "integer", description: "Omit to use the newest document" },
        person: { type: "string" },
        case_title: { type: "string" },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const intel = require("../docs/intelligence");
      const { one } = require("../db");
      let id = args.document_id;
      if (!id) {
        const latest = await one(
          `SELECT id FROM documents WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
          [ctx.userId]
        );
        if (!latest) return { ok: false, error: "no documents saved yet" };
        id = latest.id;
      }
      // If the named person is one of the user's REAL clients/patients the
      // document belongs in that case file — same path as
      // file_document_under_client, so either tool the model picks lands
      // the file in the right place (or asks when the name is ambiguous).
      if (args.person) {
        const r = await people.resolveByName(ctx.userId, args.person);
        if (r.ambiguous) {
          return {
            ok: false,
            error: "ambiguous_client",
            data: { candidates: r.ambiguous.map((c) => ({ id: c.id, name: c.name, kind: c.kind })) },
            speak: "Which one do you mean: " + r.ambiguous.map((c) => c.name).join(" or ") + "?",
          };
        }
        if (r.client) return fileUnderClient(ctx.userId, id, r.client);
      }
      const out = await intel.associate(ctx.userId, id, {
        person: args.person || null,
        caseTitle: args.case_title || null,
      });
      if (!out.person && !out.case) {
        return { ok: false, error: "name a person or case to link it to" };
      }
      return { ok: true, data: out, speak: "Linked." };
    },
  });

  /** Shared by file_document_under_client and associate_document: move a
   *  document into a client's case file and VERIFY it landed there before
   *  reporting success. Returns a tool result. */
  async function fileUnderClient(userId, docId, client) {
    const before = await docs.getDocument(userId, docId);
    if (!before) return { ok: false, error: "that document no longer exists" };
    const linked = await people.linkDocument(userId, docId, client.id);
    const after = linked ? await docs.getDocument(userId, docId) : null;
    if (!after || Number(after.client_id) !== Number(client.id)) {
      return { ok: false, error: `could not file the document under ${client.name} — it was NOT moved` };
    }
    const shape = docs.toClient(after);
    const movedFrom = before.client_id && Number(before.client_id) !== Number(client.id)
      ? await people.getClient(userId, before.client_id)
      : null;
    return {
      ok: true,
      data: {
        client: { id: Number(client.id), name: client.name, kind: client.kind },
        document: shape,
        movedFrom: movedFrom ? movedFrom.name : null,
      },
      // The app refreshes the case file / document lists on this event.
      deviceAction: {
        type: "document_filed",
        client: { id: Number(client.id), name: client.name, kind: client.kind },
        document: shape,
      },
      speak: `Filed under ${client.name}.`,
    };
  }

  registry.register({
    name: "file_document_under_client",
    description:
      "File a saved document into one of the user's EXISTING clients/patients' " +
      "case files — 'save this in Manish's section', 'put this under patient " +
      "Ravi', 'this report belongs to Manish', 'move it to Sharma's file'. " +
      "'This/it' means the document the user just captured or saved (omit " +
      "document_id). Resolves the name against the user's REAL client list: " +
      "it never creates a client. If the name matches nobody, tell the user so " +
      "and offer to add the person from the Clients screen; if it is ambiguous, " +
      "ask which one. Do NOT open the camera for this — the document already " +
      "exists. Report success ONLY when this tool returns ok:true.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "The patient/client's name as the user said it." },
        client_id: { type: "integer", description: "Use instead of client_name when the id is already known (e.g. from an ambiguity answer)." },
        document_id: { type: "integer", description: "Omit for the most recently saved/captured document." },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const { one } = require("../db");

      // 1. Which client — by id, else by an unambiguous name match.
      let client = null;
      if (args.client_id) {
        client = await people.getClient(ctx.userId, args.client_id);
        if (!client) return { ok: false, error: "no client with that id" };
      } else {
        const name = String(args.client_name || "").trim();
        if (!name) return { ok: false, error: "client_name or client_id is required" };
        const r = await people.resolveByName(ctx.userId, name);
        if (r.none) {
          const total = await people.countClients(ctx.userId);
          return {
            ok: false,
            error: "no_such_client",
            data: {
              searched: name,
              hint: total
                ? `none of the user's ${total} saved clients/patients is named "${name}". Nothing was filed and no record was created — offer to add them from the Clients screen first.`
                : "the user has no saved clients/patients yet. Nothing was filed — tell them to add the person from the Clients screen first.",
            },
          };
        }
        if (r.ambiguous) {
          return {
            ok: false,
            error: "ambiguous_client",
            data: { candidates: r.ambiguous.map((c) => ({ id: c.id, name: c.name, kind: c.kind })) },
            speak: "Which one do you mean: " + r.ambiguous.map((c) => c.name).join(" or ") + "?",
          };
        }
        client = r.client;
      }

      // 2. Which document — explicit id, else the newest one.
      let docId = args.document_id;
      if (!docId) {
        const latest = await one(
          `SELECT id FROM documents WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
          [ctx.userId]
        );
        if (!latest) return { ok: false, error: "no documents saved yet — capture or upload one first" };
        docId = latest.id;
      }
      return fileUnderClient(ctx.userId, docId, client);
    },
  });

  registry.register({
    name: "create_reminder",
    description:
      "Create a reminder or task for the user, optionally with a due time. " +
      "This only NOTIFIES the user at that time — if they want the " +
      "assistant to actually DO the thing then (place a call, order food, " +
      "send a message), use schedule_task instead. " +
      "Set wake_me ONLY when they asked to be WOKEN or insisted it must " +
      "not be missed ('wake me at 5', 'make sure I get up', 'ring loudly') " +
      "— that rings like a clock alarm through silent mode. Everything " +
      "else stays a normal notification. To create a real alarm in the " +
      "phone's own clock app instead, use set_alarm.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to be reminded of" },
        due_at: {
          type: "string",
          description: "ISO-8601 datetime, or omit if no specific time",
        },
        wake_me: {
          type: "boolean",
          description:
            "True ONLY if the user asked to be woken or said it must not be missed. Rings like an alarm through silent mode.",
        },
        repeat: {
          type: "string",
          enum: ["daily", "weekly", "monthly", "yearly"],
          description:
            "For a reminder that comes back: 'every morning' → daily, 'every " +
            "Monday' → weekly, 'on the 1st of every month' → monthly, " +
            "birthdays and anniversaries → yearly. Needs due_at as well — " +
            "the first occurrence sets the time the series keeps.",
        },
      },
      required: ["text"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const due = parseUserTime(args.due_at, ctx.tzOffsetMin);
      // A TIME THAT COULD NOT BE READ IS NOT "NO TIME".
      //
      // parseUserTime understands ISO-8601 and nothing else, so "tomorrow
      // 9am" came back null — and the reminder was saved with no time at
      // all, confirmed as "Saved", and never rang. Silently dropping the
      // one detail that makes a reminder work is the worst outcome
      // available; asking again costs a sentence.
      if (args.due_at && due === null) {
        return {
          ok: false,
          error:
            `"${String(args.due_at).slice(0, 40)}" is not a datetime I can ` +
            `read. Send due_at as full ISO-8601 in the user's local time ` +
            `with their offset, e.g. 2026-09-14T09:00:00+05:30. Do NOT ` +
            `save it without a time — a reminder with no time never rings.`,
        };
      }
      const ring = args.wake_me === true ? "alarm" : "gentle";
      const repeat = String(args.repeat || "");
      if (repeat && !due) {
        return {
          ok: false,
          error: "a repeating reminder needs a time",
          data: { hint: "Ask what time it should come back at each time." },
        };
      }
      const r = await reminders.create(ctx.userId, args.text, due, ring, {
        repeat,
        tzOffsetMin: ctx.tzOffsetMin,
      });
      if (!r) return { ok: false, error: "could not save the reminder" };
      const every = { daily: "every day", weekly: "every week",
                      monthly: "every month", yearly: "every year" }[r.repeat];
      return {
        ok: true,
        data: r,
        speak: every
          ? `Saved — ${every}.`
          : ring === "alarm" ? "Set — it'll ring like an alarm." : "Saved.",
      };
    },
  });

  registry.register({
    name: "update_reminder",
    description:
      "EDIT an existing reminder/appointment — add or change a detail, move " +
      "the time, or reword it: 'the meeting tomorrow is with Allen', 'move my " +
      "3pm reminder to 5', 'change the hackathon meeting to Friday'. Finds " +
      "the reminder by its words/day, applies the change, and the updated " +
      "text is what agenda questions read back — so details like WHO a " +
      "meeting is with are never lost. If nothing matches, say so and offer " +
      "to create it; never pretend an edit happened.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        match: { type: "string", description: "Words identifying the reminder, e.g. 'hackathon meeting'." },
        new_text: { type: "string", description: "The COMPLETE new text, keeping every existing detail plus the change, e.g. 'Meeting regarding Hackathon with Allen'." },
        new_due_at: { type: "string", description: "New ISO-8601 datetime, only if the time changes." },
      },
      required: ["match"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const rows = (await reminders.list(ctx.userId)).filter((r) => !r.done);
      const words = String(args.match || "").toLowerCase()
        .replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length >= 3);
      if (!words.length) return { ok: false, error: "say which reminder to change" };
      const scored = rows
        .map((r) => ({ r, hits: words.filter((w) => r.text.toLowerCase().includes(w)).length }))
        .filter((x) => x.hits > 0)
        .sort((a, b) => b.hits - a.hits || Number(b.r.created_at) - Number(a.r.created_at));
      if (!scored.length) {
        return { ok: false, error: "no_matching_reminder",
          data: { hint: "no reminder matches those words — offer to create it instead; do NOT claim an edit happened" } };
      }
      if (scored.length > 1 && scored[0].hits === scored[1].hits) {
        return { ok: false, error: "ambiguous",
          speak: `Which one: "${scored[0].r.text}" or "${scored[1].r.text}"?` };
      }
      const target = scored[0].r;
      const newDue = args.new_due_at ? parseUserTime(args.new_due_at, ctx.tzOffsetMin) : undefined;
      // Same rule as create: an unreadable time must not quietly become
      // "no time", which silently stops the reminder ringing.
      if (args.new_due_at && newDue === null) {
        return {
          ok: false,
          error:
            `"${String(args.new_due_at).slice(0, 40)}" is not a datetime I ` +
            `can read. Send it as full ISO-8601 with the user's offset, ` +
            `e.g. 2026-09-14T09:00:00+05:30.`,
        };
      }
      const updated = await reminders.update(
        ctx.userId, target.id,
        args.new_text ? String(args.new_text) : null,
        newDue !== undefined ? newDue : undefined
      );
      if (!updated) return { ok: false, error: "could not update the reminder" };
      return { ok: true, data: updated, speak: `Updated: ${updated.text}.` };
    },
  });

  registry.register({
    name: "remember_person_date",
    description:
      "Save an important DATE for a person — birthday, anniversary, due " +
      "date: 'Chetan's birthday is 14 September', 'mom's anniversary is " +
      "May 2nd'. The user gets a reminder push the day before, every year.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        person: { type: "string", description: "Person's name" },
        date: {
          type: "string",
          description:
            "The date as YYYY-MM-DD, or MM-DD when the year is unknown",
        },
        label: {
          type: "string",
          description: "What the date is: birthday (default), anniversary, …",
        },
      },
      required: ["person", "date"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const m = /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/.exec(
        String(args.date).trim().replace(/^--/, "")
      );
      const month = m ? Number(m[2]) : 0;
      const day = m ? Number(m[3]) : 0;
      if (!m || month < 1 || month > 12 || day < 1 || day > 31) {
        return { ok: false, error: "date must be YYYY-MM-DD or MM-DD" };
      }
      const year = m[1] ? Number(m[1]) : null;
      const label =
        String(args.label || "birthday").trim().slice(0, 40).toLowerCase() ||
        "birthday";
      // Speech drifts names ("Allen" arrives as "Alan"): match the person
      // FUZZILY first, and only create a new card when nobody matches —
      // otherwise every retry mints a duplicate person with its own date.
      const p =
        (await mem.findPerson(ctx.userId, args.person)) ||
        (await mem.upsertPerson(ctx.userId, { name: args.person }));
      const { run } = require("../db");
      await run(
        `INSERT INTO person_dates (user_id,person_id,label,month,day,year,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (user_id,person_id,label)
         DO UPDATE SET month=$4, day=$5, year=$6`,
        [ctx.userId, p.id, label, month, day, year, Date.now()]
      );
      return {
        ok: true,
        data: { person: p.name, label, month, day, year },
        speak: `Saved — I'll remind you the day before ${p.name}'s ${label}.`,
      };
    },
  });

  registry.register({
    name: "set_morning_brief",
    description:
      "Control the user's morning brief push — 'send my brief at 7', " +
      "'stop the morning notifications', 'start my daily summary again'. " +
      "The brief is one push at the start of the day with their agenda, " +
      "waiting messages and open promises.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "false turns the daily push off" },
        hour: {
          type: "integer",
          description: "Local hour 0-23 to deliver it (e.g. 7 for 7 am)",
        },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const { run, one } = require("../db");
      if (typeof args.enabled === "boolean") {
        await run(`UPDATE users SET brief_push=$2 WHERE id=$1`, [
          ctx.userId, args.enabled ? 1 : 0,
        ]);
      }
      if (Number.isInteger(args.hour) && args.hour >= 0 && args.hour <= 23) {
        await run(`UPDATE users SET brief_hour=$2 WHERE id=$1`, [
          ctx.userId, args.hour,
        ]);
      }
      const u = await one(
        `SELECT brief_push, brief_hour FROM users WHERE id=$1`,
        [ctx.userId]
      );
      const on = u.brief_push !== 0;
      const hr = Number.isFinite(Number(u.brief_hour)) && u.brief_hour !== null
        ? Number(u.brief_hour)
        : 8;
      return {
        ok: true,
        data: { enabled: on, hour: hr },
        speak: on
          ? `Morning brief is on, around ${hr === 0 ? 12 : hr % 12 || 12} ${hr < 12 ? "am" : "pm"}.`
          : "Morning brief is off.",
      };
    },
  });

  // ---------------- SCHEDULED TASKS (do X at time Y) ----------------
  const jobsQ = require("../infra/jobs");

  registry.register({
    name: "schedule_task",
    description:
      "Schedule ANY task to run automatically at a later time — 'order " +
      "biryani from Swiggy at 11', 'call Allen at 1:50 and tell him the " +
      "meeting moved', 'send a message to Manish tomorrow morning'. " +
      "When the user wants something DONE later (not just a reminder), " +
      "use this instead of doing it now or refusing — INCLUDING 'call X " +
      "at TIME and ask/tell them Y': at that moment the assistant places " +
      "the call itself, speaks with them, and reports their answer back; " +
      "a plain 'call X at TIME' makes the user's own phone dial. Pass " +
      "the task self-contained with every detail needed to execute it " +
      "with no one present. For notify-me-only reminders use " +
      "create_reminder.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "The full task, self-contained, e.g. 'Order one chicken biryani from Swiggy from my usual restaurant'",
        },
        when: {
          type: "string",
          description: "When to run it — ISO-8601 datetime in the user's local time",
        },
        repeat: {
          type: "string",
          enum: ["daily", "weekly", "monthly"],
          description:
            "Repeat the task on this cadence starting from `when` — for " +
            "'every day at 9', 'every Sunday'. Omit for a one-time task.",
        },
      },
      required: ["task", "when"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const at = parseUserTime(args.when, ctx.tzOffsetMin);
      if (!at) return { ok: false, error: "could not understand the time — ask which exact time" };
      const delayMs = at - Date.now();
      if (delayMs < 15_000) {
        return { ok: false, error: "that time is in the past or seconds away — just do the task now instead" };
      }
      if (delayMs > 60 * 24 * 3600_000) {
        return { ok: false, error: "that is more than 60 days away — too far to schedule" };
      }
      const { one } = require("../db");
      const pending = await one(
        `SELECT COUNT(*)::int AS n FROM jobs
          WHERE user_id=$1 AND kind='scheduled_task' AND status='pending'`,
        [ctx.userId]
      );
      if (pending.n >= 25) {
        return { ok: false, error: "25 tasks already scheduled — cancel one first" };
      }
      const repeat = ["daily", "weekly", "monthly"].includes(args.repeat)
        ? args.repeat
        : null;
      const tz = Number.isFinite(ctx.tzOffsetMin) ? ctx.tzOffsetMin : 330;
      const payload = {
        task: String(args.task).slice(0, 800),
        tzOffsetMin: tz,
      };
      if (repeat) {
        payload.repeat = repeat;
        // Monthly recurrence keeps the ORIGINAL day-of-month ("the 31st")
        // even after passing through a short month that clamped it.
        payload.anchorDay = new Date(at + tz * 60_000).getUTCDate();
      }
      const id = await jobsQ.enqueue("scheduled_task", payload, {
        userId: ctx.userId,
        delayMs,
      });
      // A call-task confirmation must promise the RIGHT thing: the user's
      // own phone dials the contact at that time. "I've scheduled a call
      // with Allen" sounds like a meeting was arranged — it wasn't.
      const isCall = /\b(call|dial|ring)\b/i.test(payload.task);
      return {
        ok: true,
        data: { id, runAt: new Date(at).toISOString(), repeat },
        speak: isCall
          ? `Done — at that time your phone will place the call itself${repeat ? `, ${repeat}` : ""}.`
          : repeat
            ? `Scheduled ${repeat} — I'll do it each time and send you the outcome.`
            : "Scheduled — I'll do it then and send you the outcome.",
      };
    },
  });

  registry.register({
    name: "list_scheduled_tasks",
    description:
      "List the user's scheduled tasks — upcoming ones and recent " +
      "outcomes. Use for 'what have I scheduled', 'did my 11 pm order go " +
      "through'.",
    risk: "low",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const { query } = require("../db");
      const rows = await query(
        `SELECT id, payload, status, run_after, last_error FROM jobs
          WHERE user_id=$1 AND kind='scheduled_task'
          ORDER BY run_after DESC LIMIT 20`,
        [ctx.userId]
      );
      if (!rows.length) return { ok: true, data: [], speak: "Nothing scheduled." };
      return {
        ok: true,
        data: rows.map((r) => ({
          id: Number(r.id),
          task: r.payload?.task || "",
          status: r.status,
          runAt: new Date(Number(r.run_after)).toISOString(),
          repeat: r.payload?.repeat || null,
          outcome: r.last_error || null,
        })),
      };
    },
  });

  registry.register({
    name: "cancel_scheduled_task",
    description:
      "Cancel a scheduled task before it runs — 'cancel the biryani " +
      "order', 'don't call Allen tonight'. List first if the id is unknown.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", description: "Task id from list_scheduled_tasks" } },
      required: ["id"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const { run } = require("../db");
      const n = await run(
        `UPDATE jobs SET status='cancelled', updated_at=$3
          WHERE id=$1 AND user_id=$2 AND kind='scheduled_task' AND status='pending'`,
        [Number(args.id), ctx.userId, Date.now()]
      );
      return n > 0
        ? { ok: true, speak: "Cancelled." }
        : { ok: false, error: "no pending scheduled task with that id" };
    },
  });

  registry.register({
    name: "list_reminders",
    description:
      "The user's upcoming agenda: reminders, tasks, appointments AND " +
      "patient/client recalls. USE THIS to answer 'do I have any meetings/" +
      "appointments/anything tomorrow', 'what's on Friday', 'am I free on " +
      "the 12th' — answer ONLY from what it returns (each entry carries a " +
      "human-readable `when`). Pass `day` to filter to one day.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        day: {
          type: "string",
          description:
            "'today', 'tomorrow' or a YYYY-MM-DD date — only that user-local day. Omit for everything upcoming.",
        },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const tz = Number.isFinite(ctx.tzOffsetMin) ? ctx.tzOffsetMin : 330;
      const localDay = (ms) => {
        const d = new Date(ms + tz * 60_000);
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      };
      let wantDay = null;
      const dayArg = String(args.day || "").trim().toLowerCase();
      if (dayArg === "today") wantDay = localDay(Date.now());
      else if (dayArg === "tomorrow") wantDay = localDay(Date.now() + 86_400_000);
      else if (/^\d{4}-\d{2}-\d{2}$/.test(dayArg)) wantDay = dayArg;

      const humanize = (ms) => {
        if (!Number.isFinite(ms) || ms <= 0) return "no set time";
        const day = localDay(ms);
        const rel =
          day === localDay(Date.now()) ? "today" :
          day === localDay(Date.now() + 86_400_000) ? "tomorrow" : null;
        const t = new Date(ms).toLocaleString("en-IN", {
          weekday: rel ? undefined : "short", day: rel ? undefined : "numeric",
          month: rel ? undefined : "short",
          hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
        });
        return rel ? `${rel} ${t}` : t;
      };

      const rows = await reminders.list(ctx.userId);
      const items = rows
        .filter((r) => !r.done)
        .map((r) => ({ kind: "reminder", text: r.text, dueAt: Number(r.due_at) || null,
          when: humanize(Number(r.due_at)) }))
        .filter((r) => !wantDay || (r.dueAt && localDay(r.dueAt) === wantDay));

      // A professional's recalls ARE their appointments — include them.
      try {
        const practice = require("../practice/store");
        const { one } = require("../db");
        const recs = await practice.listRecalls(ctx.userId, { limit: 50 });
        for (const r of recs) {
          const due = Number(r.due_at);
          if (wantDay && localDay(due) !== wantDay) continue;
          const c = await one("SELECT name FROM clients WHERE id = $1 AND user_id = $2",
            [r.client_id, ctx.userId]);
          items.push({
            kind: "recall",
            text: `Recall: ${c?.name || "client"}${r.note ? ` — ${r.note}` : ""}`,
            dueAt: due, when: humanize(due),
          });
        }
      } catch (_) {}
      items.sort((a, b) => (a.dueAt || Infinity) - (b.dueAt || Infinity));

      if (!items.length) {
        return { ok: true, data: [],
          speak: wantDay
            ? `Nothing scheduled ${dayArg === "today" || dayArg === "tomorrow" ? dayArg : "on " + wantDay}.`
            : "Nothing scheduled." };
      }
      return { ok: true, data: items };
    },
  });

  // ---------------- PROFILE + STANDING RULES ----------------
  const userCtx = require("../users/context");

  registry.register({
    name: "update_my_profile",
    description:
      "Save personal details the user shares about THEMSELVES — profession, " +
      "organisation, location, preferred language, what to call them. Use " +
      "for 'I'm a software engineer at Acme in Mangalore', 'call me Dhanu'.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "What the user wants to be called" },
        profession: { type: "string" },
        organisation: { type: "string" },
        location: { type: "string" },
        preferred_language: { type: "string" },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const p = await userCtx.updateProfile(ctx.userId, args);
      return { ok: true, data: p.user, speak: "Got it." };
    },
  });

  registry.register({
    name: "add_standing_instruction",
    description:
      "Save a PERMANENT rule for how the assistant should behave — 'always " +
      "ask before sending messages', 'you can create reminders without " +
      "asking', 'never call anyone after 10pm'. Use when the user states a " +
      "lasting preference about YOUR behaviour, not a one-off request.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: { instruction: { type: "string", description: "The rule, verbatim" } },
      required: ["instruction"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      await userCtx.addInstruction(ctx.userId, args.instruction);
      return { ok: true, speak: "Understood — I'll always do that." };
    },
  });

  registry.register({
    name: "remove_standing_instruction",
    description:
      "Remove a previously saved behaviour rule when the user cancels it — " +
      "'you don't need to ask before reminders anymore'.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: { about: { type: "string", description: "Words identifying the rule" } },
      required: ["about"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const n = await userCtx.removeInstruction(ctx.userId, args.about);
      if (!n) return { ok: false, error: "no matching rule found" };
      return { ok: true, data: { removed: n }, speak: "Done, rule removed." };
    },
  });

  registry.register({
    name: "configure_assistant",
    description:
      "Change the ASSISTANT's own identity when the user asks — its name " +
      "('I'll call you Maya'), gender presentation, or communication style " +
      "(concise/friendly/formal).",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "New assistant name, e.g. Maya" },
        gender: { type: "string", description: "female, male or neutral" },
        style: { type: "string", description: "concise, friendly or formal" },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const before = await userCtx.getAssistantProfile(ctx.userId).catch(() => null);
      const a = await userCtx.setAssistantProfile(ctx.userId, args);

      // A VOICE CHANGE NEEDS A NEW SESSION TO BE HEARD.
      //
      // Gemini Live fixes the voice in the setup message, which is sent
      // once when the socket opens. Changing the profile mid-call updates
      // the database and nothing else: the user asks for a male voice, is
      // told it changed, and carries on hearing the same female one. The
      // Settings screen has the same gap — it saves and never reconnects.
      //
      // So the app is told to rebuild the session. It waits for this
      // confirmation to finish speaking first, or the sentence announcing
      // the change is cut off by the change itself.
      const voiceMoved = Boolean(a && before && a.voice !== before.voice);
      const renamed = Boolean(args.name);

      let deviceAction;
      if (renamed) deviceAction = { type: "assistant_renamed", name: a.name };
      else if (voiceMoved) deviceAction = { type: "live_voice_changed", voice: a.voice || "" };

      return {
        ok: true,
        data: a,
        // The app renames itself on the spot — settings has no name field;
        // the conversation IS how the assistant is named.
        deviceAction,
        speak: renamed
          ? `From now on I'm ${a.name}.`
          : voiceMoved
            ? "Done — give me a second to switch over."
            : "Done.",
      };
    },
  });

  // ---------------- EMAIL (read + send, when asked) ----------------
  // One mailbox per user, connected in Hub → Email. Both tools answer
  // with a clear "connect it first" when no account is linked — the
  // model must relay that instead of improvising.

  registry.register({
    name: "email_read",
    description:
      "Read/summarise the user's EMAIL INBOX when asked — 'read my " +
      "mails', 'any new mail?', 'did the bank send something', 'mail " +
      "from Ravi about the invoice'. Args narrow it: from (sender name " +
      "or address), query (words in subject/body), unread_only, or uid " +
      "(read ONE full message the user picked from a previous list). " +
      "Without uid it returns the newest matching messages (sender, " +
      "subject, when, unread) — summarise those in ONE or TWO spoken " +
      "sentences, newest first; NEVER read out raw lists, addresses or " +
      "message IDs. If it reports that no mailbox is connected, tell " +
      "the user to connect their email once in the Hub → Email screen.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Sender name or address to filter by" },
        query: { type: "string", description: "Words to search in subject/body" },
        unread_only: { type: "boolean", description: "Only unread mail" },
        uid: { type: "string", description: "Read this ONE message in full (uid from an earlier email_read result, passed back EXACTLY as received)" },
        limit: { type: "number", description: "How many to fetch (default 5, max 10)" },
      },
    },
    async execute(args, ctx) {
      const email = require("../services/email");
      const uid = Number(ctx?.userId || ctx?.uid || 0);
      try {
        if (args.uid) {
          const m = await email.readBody(uid, args.uid);
          if (!m) return { ok: false, error: "couldn't fetch that message any more" };
          return { ok: true, data: m };
        }
        const list = await email.listRecent(uid, {
          from: args.from,
          text: args.query,
          unreadOnly: Boolean(args.unread_only),
          limit: args.limit,
        });
        if (!list.length) {
          return {
            ok: true,
            data: { messages: [] },
            speak: args.from || args.query
              ? "No mail matching that — want me to check the whole inbox?"
              : "Your inbox has nothing new.",
          };
        }
        return { ok: true, data: { messages: list } };
      } catch (e) {
        if (e?.code === "no_account") {
          return {
            ok: false,
            error: "no mailbox connected",
            speak:
              "Your email isn't connected yet — open the Hub, tap Email, " +
              "and link it once. After that I can read and send mail for you.",
          };
        }
        return { ok: false, error: `mailbox unreachable: ${String(e.message || e).slice(0, 120)}` };
      }
    },
  });

  registry.register({
    name: "email_send",
    description:
      "SEND an email from the user's own mailbox — 'mail ravi@x.com " +
      "that I'll be late', 'send the report follow-up to my professor'. " +
      "Needs a real email ADDRESS in `to`: if the user only named a " +
      "person, ASK for the address (or find it in an earlier email_read " +
      "result) — never guess one. Compose a short professional body in " +
      "the user's language and normal prose (no markdown), read the " +
      "GIST back, and call this only after the user agrees. If it " +
      "reports no mailbox is connected, point the user to Hub → Email.",
    risk: "high",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address (required, must contain @)" },
        subject: { type: "string", description: "Short subject line" },
        body: { type: "string", description: "The message body, plain text" },
      },
      required: ["to", "subject", "body"],
    },
    confirmSummary: (a) => `Email ${a.to}: ${String(a.subject || "").slice(0, 60)}`,
    async execute(args, ctx) {
      const email = require("../services/email");
      const uid = Number(ctx?.userId || ctx?.uid || 0);
      try {
        const out = await email.send(uid, args);
        return {
          ok: true,
          data: out,
          speak: out.draft
            ? `The mail is ready as a draft in your Gmail — open Gmail and tap send. To let me send directly, reconnect Google in the Hub once.`
            : `Sent — your mail to ${args.to} is on its way.`,
        };
      } catch (e) {
        if (e?.code === "no_account") {
          return {
            ok: false,
            error: "no mailbox connected",
            speak:
              "Your email isn't connected yet — open the Hub, tap Email, " +
              "and link it once. Then I can send this for you.",
          };
        }
        if (e?.code === "bad_address") {
          return { ok: false, error: "that recipient address is not a valid email address — ask the user for the correct one" };
        }
        return { ok: false, error: `send failed: ${String(e.message || e).slice(0, 120)}` };
      }
    },
  });

  // ---------------- DEVICE ACTIONS ----------------
  // These CANNOT be performed by the server. Android/iOS require the app to
  // initiate them, so the tool returns an authorized action for the app and
  // the app reports the real outcome. The agent must never claim success.

  registry.register({
    name: "place_phone_call",
    requiresPermission: "phone",
    description:
      "Call one of the user's contacts. Use for 'call mom', 'ring Ravi'. " +
      "EMERGENCIES work too: 'call an ambulance / the police / fire " +
      "brigade / emergency / 112' — pass that service word or code as the " +
      "name and the phone dials India's emergency short code directly. " +
      "Act IMMEDIATELY on emergency requests, never ask follow-ups. " +
      "When the user wants a message DELIVERED for them ('call Chethan and " +
      "tell him I'll be late'), pass it as `message` — if the agent-calling " +
      "service is configured, the assistant places the call itself and " +
      "speaks the message so the user doesn't have to talk; otherwise the " +
      "phone dials the contact directly for the user to speak. " +
      "WAKE-UP / SELF CALLS: 'call me and remind me…', 'give me a wake-up " +
      "call' — pass the literal name 'me' plus the reminder as `message`; " +
      "the assistant rings the user's own registered number, and if they " +
      "don't pick up it automatically calls again a few minutes later. " +
      "IMPORTANT: this tool only ASKS the phone to try — the contact is " +
      "not even looked up yet, so NEVER say 'calling X now'; say you are " +
      "finding them. The contact may not exist or permissions may be off. " +
      "NEVER say the call was made or " +
      "delivered until a [SYSTEM] message confirms it; if a [SYSTEM] " +
      "message reports an ERROR, tell the user plainly that the call " +
      "FAILED and why.",
    // MEDIUM, deliberately (Dhanush, twice): "call Allen Lobo" must just
    // dial — the user watches their own phone place the call and can end
    // it in one tap, so a spoken should-I-call round-trip on every
    // explicit command was pure friction. Money and anything irreversible
    // stay high-risk.
    risk: "medium",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Contact name to call" },
        message: {
          type: "string",
          description:
            "The message to deliver or question to ask on the call, when the user asked you to pass one on",
        },
      },
      required: ["name"],
    },
    confirmSummary: (a) =>
      a.message ? `Call ${a.name} and say: ${a.message}` : `Call ${a.name}`,
    async execute(args, ctx) {
      // The app decides HOW to act on this from agent_available: with a
      // message and the relay configured it asks the server to place the
      // call (Hari speaks it herself); otherwise it dials directly.
      const agentAvailable = require("../agents/agentCall").enabled();
      const relaying = Boolean(args.message) && agentAvailable;

      // "Call ME" — wake-up call to the user's own verified number, placed
      // right here (no contact lookup, no device). Redials if unanswered.
      if (/^(me|myself|my\s*(own\s*)?(phone|number|mobile))$/i.test(String(args.name || "").trim())) {
        if (!agentAvailable) {
          return {
            ok: false,
            error:
              "calling isn't configured on this server yet, so I can't ring " +
              "the user's phone — offer to set a loud reminder alarm instead",
          };
        }
        if (!ctx?.userId) return { ok: false, error: "not signed in" };
        const me = await require("../db").findById(ctx.userId);
        const own = String(me?.phone_number || "").trim();
        if (!own) {
          return {
            ok: false,
            error:
              "the user's own phone number isn't verified in their profile, " +
              "so there is nothing to dial — ask them to add it in Profile, " +
              "and offer a reminder alarm as the alternative",
          };
        }
        const task = String(args.message || "").trim() ||
          "Check in with them as they requested.";
        try {
          const { id } = await require("../agents/agentCall").start({
            userId: ctx.userId,
            userName: me?.name ? String(me.name).split(" ")[0] : null,
            toNumber: own,
            contactName: me?.name ? String(me.name).split(" ")[0] : "you",
            task,
            lang: ctx.lang || null,
            selfCall: true,
          });
          return {
            ok: true,
            data: { call_id: id, to: "own number" },
            speak:
              "I'll ring your phone now — if you don't pick up, I'll try " +
              "again in five minutes.",
          };
        } catch (e) {
          if (e?.code === "quota") {
            return { ok: false, error: "today's limit for placed calls is reached" };
          }
          return { ok: false, error: "the call could not be started: " + String(e?.message || e?.code || e) };
        }
      }
      return {
        ok: true,
        note:
          "Nothing has dialled yet — the phone is now trying to resolve " +
          "the contact. Wait for the [SYSTEM] status message before " +
          "reporting the outcome; never claim the call was placed on " +
          "your own.",
        deviceAction: {
          type: "resolve_and_call",
          name: args.name,
          message: args.message || null,
          agent_available: agentAvailable,
        },
        // NOT "calling X now": the contact has not even been looked up
        // yet. Testers were told "Calling Dikshit Pujari now" and then, a
        // beat later, that no such contact exists — the phone reports the
        // truth on /call_result and the model speaks THAT.
        speak: relaying
          ? `Let me find ${args.name} and call them — I'll tell you how it goes.`
          : args.message
            ? `I can't speak on calls myself on this setup, so I'll connect you to ${args.name} directly.`
            : `Looking up ${args.name}…`,
      };
    },
  });

  registry.register({
    name: "translator_mode",
    description:
      "Turn LIVE TRANSLATOR (interpreter) mode ON or OFF. Use when the " +
      "user asks to translate a conversation with someone present — 'be my " +
      "translator', 'translate between Kannada and English', 'help me talk " +
      "to him in Hindi' — and OFF for 'stop translating'. While ON, the " +
      "device listens to EVERYONE nearby (not only the owner's voice) and " +
      "each utterance heard is spoken back in the other language. Always " +
      "pass both languages when turning it on; infer them from the request " +
      "and the user's own language.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        on: { type: "boolean", description: "true = start translating, false = stop" },
        language_a: { type: "string", description: "The user's language, e.g. 'Kannada'" },
        language_b: { type: "string", description: "The other person's language, e.g. 'English'" },
      },
      required: ["on"],
    },
    async execute(args) {
      const on = Boolean(args.on);
      const a = String(args.language_a || "").trim();
      const b = String(args.language_b || "").trim();
      if (on && (!a || !b)) {
        return { ok: false, error: "need both languages — ask the user which two languages to translate between" };
      }
      return {
        ok: true,
        data: { on, language_a: a, language_b: b },
        deviceAction: { type: "translator", on, from: a, to: b },
        speak: on
          ? `Translator on — I'll interpret between ${a} and ${b}. Everyone near the phone can talk now.`
          : "Translator off — back to just you and me.",
      };
    },
  });

  registry.register({
    name: "capture_document",
    requiresPermission: "camera",
    description:
      "Ask the user to capture a document, photo, or select an image/PDF from their gallery, " +
      "e.g. 'save Raj's MRI report', 'scan this receipt'. When the user names " +
      "WHOSE document it is (a patient, client, or person — 'save this scan " +
      "report for Prasant'), ALWAYS pass their name as `person` so the file " +
      "lands in that person's records and can be recalled later with " +
      "list_person_documents / find_document.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string", description: "What the user is capturing (e.g. 'Raj MRI Report')" },
        person: { type: "string", description: "Whose document this is — the patient/client/person's NAME, when the user said one." },
        client_id: { type: "integer", description: "Optional: ID of the person/client to link this document to, if already known." },
        source: { type: "string", enum: ["camera", "gallery", "ask"], description: "Where to get the document from. Default is ask." },
      },
    },
    async execute(args, ctx) {
      let clientId = args.client_id || null;
      let clientName = null;
      if (args.person && ctx.userId && !clientId) {
        // Is this one of the user's REAL clients/patients? Resolve BEFORE the
        // camera opens so the shot is filed straight into the right case
        // file — and so an ambiguous name is asked about now, not guessed.
        try {
          const r = await people.resolveByName(ctx.userId, args.person);
          if (r.ambiguous) {
            return {
              ok: false,
              error: "ambiguous_client",
              data: { candidates: r.ambiguous.map((c) => ({ id: c.id, name: c.name, kind: c.kind })) },
              speak: "Which one do you mean: " + r.ambiguous.map((c) => c.name).join(" or ") + "?",
            };
          }
          if (r.client) {
            clientId = Number(r.client.id);
            clientName = r.client.name;
          }
        } catch (_) {}
      }
      if (args.person && ctx.userId && !clientId) {
        // Not a client: a plain person in memory ("Prasant's MRI"). Ensure
        // the person exists NOW so "what do you know about Prasant" works
        // even if the capture is cancelled, and the upload links by name.
        try {
          await mem.upsertPerson(ctx.userId, { name: args.person });
        } catch (_) {}
      }
      return {
        ok: true,
        data: clientId ? { filesUnder: { id: clientId, name: clientName || args.person || null } } : { filesUnder: "personal" },
        deviceAction: {
          type: "capture_document",
          note: args.note || null,
          person: args.person || null,
          client_id: clientId,
          client_name: clientName,
          source: args.source || "ask",
        },
        speak: args.source === "gallery" ? "Please select the file." : "Opening the capture screen.",
      };
    },
  });

  registry.register({
    name: "phone_control",
    description:
      "Control the phone itself — what Siri/Gemini do on-device: " +
      "'turn on the flashlight/torch', 'volume up / set volume to 40 / " +
      "mute', 'pause/play/next song' (controls whatever app is playing), " +
      "'battery level', 'open wifi/bluetooth/sound settings'. Runs ON the " +
      "device; for battery, wait for the [SYSTEM] result before answering. " +
      "If the device reports a failure, say so plainly.\n" +
      "open_settings is ONLY for the user explicitly asking for a settings " +
      "screen. NEVER call it because some other tool failed, an app would " +
      "not open, or you are out of ideas — an unrequested Settings page " +
      "reads as the phone malfunctioning.\n" +
      "CLOSING AN APP: Android does not let one app close another, and you " +
      "must never claim you did. What you CAN do: action 'go_home' leaves " +
      "the app the user is in, which is what most people mean by 'close " +
      "it'; action 'app_info' with app_package opens that app's settings " +
      "page, one tap from Force stop. Offer the closer thing plainly — " +
      "'I can\'t close it for you, but I can take you Home, or open its " +
      "settings so you can force stop it.'",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["flashlight_on", "flashlight_off", "volume_set", "volume_up",
                 "volume_down", "mute", "unmute", "media_play", "media_pause",
                 "media_next", "media_previous", "battery", "open_settings",
                 "go_home", "app_info"],
        },
        value: { type: "integer", description: "For volume_set: 0-100." },
        app_package: {
          type: "string",
          description:
            "For app_info: the Android package, e.g. com.instagram.android. " +
            "If you only know the app's name, call open_app's lookup first.",
        },
        panel: {
          type: "string",
          enum: ["wifi", "bluetooth", "sound", "display", "battery", "settings"],
          description: "For open_settings: which settings screen.",
        },
      },
      required: ["action"],
    },
    async execute(args) {
      // go_home and app_info are INTENTS, not device controls — the same
      // deep-link route set_alarm uses, so they need no app change.
      if (args.action === "go_home") {
        return {
          ok: true,
          deviceAction: {
            type: "open_url",
            url: "intent:#Intent;action=android.intent.action.MAIN;" +
                 "category=android.intent.category.HOME;end",
          },
          speak: "Taking you Home.",
          note:
            "This leaves the app they were in; it does NOT close it. Do not " +
            "say you closed anything.",
        };
      }
      if (args.action === "app_info") {
        const pkg = String(args.app_package || "").trim();
        if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(pkg)) {
          return {
            ok: false,
            error: "need the app's package name for that",
            data: { hint: "Ask which app, or resolve the package first." },
          };
        }
        return {
          ok: true,
          deviceAction: {
            type: "open_url",
            url: `intent://${pkg}#Intent;scheme=package;` +
                 `action=android.settings.APPLICATION_DETAILS_SETTINGS;end`,
          },
          speak: "Opening its settings — Force stop is on that screen.",
          note:
            "You have opened a settings page. The app is NOT closed; the user " +
            "has to tap Force stop themselves. Say exactly that.",
        };
      }
      const speakBy = {
        flashlight_on: "Flashlight on.",
        flashlight_off: "Flashlight off.",
        volume_set: `Setting volume to ${args.value ?? 50}.`,
        volume_up: "Volume up.",
        volume_down: "Volume down.",
        mute: "Muted.",
        unmute: "Unmuted.",
        media_play: "Playing.",
        media_pause: "Paused.",
        media_next: "Next track.",
        media_previous: "Previous track.",
        battery: "Checking the battery.",
        open_settings: "Opening settings.",
        go_home: "Taking you Home.",
        app_info: "Opening its settings.",
      };
      return {
        ok: true,
        deviceAction: {
          type: "phone_control",
          action: args.action,
          value: args.value ?? null,
          panel: args.panel || null,
        },
        speak: speakBy[args.action] || "Done.",
      };
    },
  });

  registry.register({
    name: "analyze_camera",
    requiresPermission: "camera",
    description:
      "Open the phone camera, look at whatever is in front of the user, and answer a question about it. " +
      "USE THIS WHENEVER the user cannot read, see or identify something in front of them — a sign, board, " +
      "notice, menu, label, receipt, document, medicine packet or object. This includes TRANSLATION: if the " +
      "user says a board or text is in a language they do not understand and asks what it says, call this " +
      "with a question asking to read the text and translate it into their language. Do not ask them to " +
      "describe or photograph it first — this tool opens the camera itself.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to answer about the image" },
      },
      required: ["question"],
    },
    async execute(args) {
      return {
        ok: true,
        deviceAction: { type: "analyze_camera", question: args.question },
        // Said BEFORE the camera opens, so the user knows why their screen
        // just changed. The reading itself comes back as a second turn once
        // the picture has been taken and analysed.
        speak: "Let me take a look — point the camera at it.",
      };
    },
  });

  registry.register({
    name: "play_music",
    description:
      "Play a song, artist or playlist for the user. Defaults to YouTube, " +
      "where the track starts playing on its own. Use for 'play Tum Hi Ho', " +
      "'put on some Arijit Singh', 'play my workout playlist'.\n" +
      "ONLY for actual music the user named. This OPENS YOUTUBE on their " +
      "phone and takes over their screen, so it is never the answer to a " +
      "request for YOU to do something with your voice — 'laugh', 'sing', " +
      "'tell me a joke', 'make a sound', 'do an accent'. Do those yourself, " +
      "out loud, with no tool at all. A tester asked the assistant to laugh " +
      "and YouTube opened.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The song, artist or playlist, e.g. 'Tum hi ho', 'Arijit Singh'",
        },
        provider: {
          type: "string",
          enum: ["youtube", "spotify", "youtube_music"],
          description: "Where to play it. Default youtube unless the user names another.",
        },
      },
      required: ["query"],
    },
    async execute(args, ctx) {
      const provider = args.provider || "youtube";

      // YOUTUBE — resolve the actual video first so the song PLAYS.
      //
      // A search URL only opens a list of results; the user still has to
      // pick one, which is not what "play this song" means. One Data API
      // lookup turns the request into a /watch link, and YouTube starts
      // playing it the moment it opens. Without an API key we fall back to
      // the search list and say plainly that we did.
      if (provider === "youtube") {
        const yt = require("../fulfillment/youtube");
        const hit = await yt.resolveVideo(args.query);
        if (hit) {
          return {
            ok: true,
            data: { videoId: hit.videoId, title: hit.title },
            deviceAction: { type: "open_url", url: yt.watchUrl(hit.videoId, ctx.platform) },
            speak: `Playing ${hit.title} on YouTube.`,
          };
        }
        return {
          ok: true,
          data: { resolved: false },
          deviceAction: { type: "open_url", url: yt.searchUrl(args.query, ctx.platform) },
          speak: yt.enabled()
            ? `I couldn't find that one, so here are the YouTube results for ${args.query}.`
            : `Opening YouTube results for ${args.query} — tap the one you want.`,
        };
      }

      // SPOTIFY / YOUTUBE MUSIC — MEDIA_PLAY_FROM_SEARCH hands the query to
      // the app's own player, which starts playback without a lookup.
      const pkg = provider === "spotify"
        ? "com.spotify.music"
        : "com.google.android.apps.youtube.music";
      const fallback = provider === "spotify"
        ? `https://open.spotify.com/search/${encodeURIComponent(args.query)}`
        : `https://music.youtube.com/search?q=${encodeURIComponent(args.query)}`;
      const q = encodeURIComponent(args.query);
      const url =
        `intent:#Intent;action=android.media.action.MEDIA_PLAY_FROM_SEARCH;` +
        `S.query=${q};package=${pkg};S.browser_fallback_url=${encodeURIComponent(fallback)};end`;

      return {
        ok: true,
        deviceAction: { type: "open_url", url },
        speak: `Playing ${args.query} on ${provider === "spotify" ? "Spotify" : "YouTube Music"}.`,
      };
    },
  });

  registry.register({
    name: "send_whatsapp_message",
    description:
      "ONLY when the user EXPLICITLY says WhatsApp ('whatsapp Ravi…', 'send " +
      "it on WhatsApp'). For a plain 'send a message to X' use " +
      "send_agent_message instead. " +
      "Write and send a WhatsApp message for the user. Give the recipient by " +
      "NAME as the user said it ('Ravi', 'my wife', 'the project group') — " +
      "the number is looked up from their contacts. Use for 'whatsapp Ravi " +
      "that I'll be late', 'message the team group about tomorrow'. Write " +
      "the message yourself in the user's voice unless they dictated exact " +
      "words; keep it natural and short. This PREPARES the chat — the user " +
      "must tap Send themselves. If they ask why it didn't send by itself, " +
      "explain warmly and simply: WhatsApp doesn't allow any assistant to " +
      "press send on a person's behalf — that last tap is theirs by " +
      "WhatsApp's own rules — and offer the automatic ways instead (their " +
      "assistant-to-assistant message, or a plain text message).",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description:
            "Recipient NAME as the user said it. For a group, the group name. " +
            "Omit only if the user genuinely did not say who.",
        },
        message: { type: "string", description: "The message to send, fully written out." },
        is_group: {
          type: "boolean",
          description:
            "True when the recipient is a WhatsApp GROUP rather than a person.",
        },
        phone: {
          type: "string",
          description: "Only if the user dictated an actual number.",
        },
      },
      required: ["message"],
    },
    async execute(args, ctx) {
      const message = String(args.message || "").trim();
      if (!message) return { ok: false, needsArgs: ["message"] };
      const text = encodeURIComponent(message);

      // GROUPS: WhatsApp has no addressable group identifier available to
      // any third party — the Business Cloud API cannot post to a group at
      // all, and no deep link accepts a group name. What DOES work is
      // opening WhatsApp's own chooser with the text already written: the
      // user picks the group and sends. Two taps, no typing, and it works
      // for every group they are in.
      if (args.is_group) {
        return {
          ok: true,
          data: { drafted: message, target: "group_picker" },
          deviceAction: { type: "open_url", url: `whatsapp://send?text=${text}` },
          // Never "I sent it" — WhatsApp requires the user's own tap, and
          // claiming otherwise is the one thing that must not happen here.
          speak: `I've written it — pick ${args.to ? args.to : "the group"} and hit send.`,
        };
      }

      // A dictated number wins; otherwise resolve the NAME from contacts.
      let phone = args.phone ? String(args.phone).replace(/[^\d+]/g, "") : null;
      let who = args.to || "them";

      if (!phone && args.to) {
        if (!ctx.userId) return { ok: false, error: "not signed in, so I can't look up contacts" };
        const { resolveContact } = require("../users/resolve");
        const { match, candidates } = await resolveContact(ctx.userId, args.to);

        // Two people with the same name: ask. An outbound message sent to
        // the wrong person cannot be taken back.
        if (!match && candidates.length > 1) {
          return {
            ok: false,
            error:
              `there are ${candidates.length} contacts matching "${args.to}" — ` +
              `${candidates.map((c) => c.name).join(", ")}. Ask which one.`,
          };
        }
        if (match) {
          phone = match.phone;
          who = match.name;
        }
      }

      // No name, or a name we could not resolve: still useful. The chooser
      // opens with the message written, so the user picks the chat rather
      // than retyping anything.
      if (!phone) {
        return {
          ok: true,
          data: { drafted: message, target: "picker", unresolved: args.to || null },
          deviceAction: { type: "open_url", url: `whatsapp://send?text=${text}` },
          speak: args.to
            ? `I couldn't find ${args.to} in your contacts, so I've written the message — pick the chat and send.`
            : "I've written it — pick the chat and send.",
        };
      }

      return {
        ok: true,
        data: { drafted: message, to: who, phone },
        deviceAction: {
          type: "open_url",
          url: `whatsapp://send?phone=${phone}&text=${text}`,
        },
        speak: `Ready to send to ${who} — just tap send.`,
      };
    },
  });

  registry.register({
    name: "start_navigation",
    requiresPermission: "location",
    description: "Start turn-by-turn navigation in Google Maps to a specific destination.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        destination: { type: "string", description: "Where the user wants to go (e.g. 'Starbucks', '123 Main St', 'Airport')." }
      },
      required: ["destination"],
    },
    async execute(args) {
      const url = `google.navigation:q=${encodeURIComponent(args.destination)}`;
      return {
        ok: true,
        deviceAction: { type: "open_url", url },
        speak: `Getting directions to ${args.destination}.`,
      };
    }
  });

  registry.register({
    name: "set_alarm",
    description:
      "Create a real alarm in the phone's own clock app — the right choice " +
      "for waking up ('wake me at 5:30', 'set an alarm for 6'), because it " +
      "rings even if this app is closed. For a reminder that should nag at " +
      "a time without being a clock alarm, use create_reminder.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        hour: { type: "integer", description: "The hour in 24-hour format (0-23)." },
        minute: { type: "integer", description: "The minute (0-59)." },
        label: { type: "string", description: "Optional label for the alarm." }
      },
      required: ["hour", "minute"],
    },
    async execute(args) {
      const label = args.label
        ? `S.android.intent.extra.alarm.MESSAGE=${encodeURIComponent(args.label)};`
        : "";
      // SKIP_UI creates the alarm in the phone's own clock app without
      // making the user finish the form — and because it lives in the
      // clock app, it rings even if this app is closed or updated.
      const hh = String(args.hour).padStart(2, "0");
      const mm = String(args.minute).padStart(2, "0");
      return {
        ok: true,
        deviceAction: {
          type: "clock_intent",
          action: "android.intent.action.SET_ALARM",
          extras: {
            "android.intent.extra.alarm.HOUR": args.hour,
            "android.intent.extra.alarm.MINUTES": args.minute,
            "android.intent.extra.alarm.SKIP_UI": true,
            ...(args.label ? { "android.intent.extra.alarm.MESSAGE": String(args.label).slice(0, 60) } : {}),
          },
        },
        speak: `Setting a clock alarm for ${hh}:${mm}.`,
      };
    }
  });

  registry.register({
    name: "update_app",
    deviceAction: true,
    description:
      "Check whether a newer version of THIS app has been released and, if " +
      "so, put the installer in front of the user. Use when they ask to " +
      "update the app, say 'is there a new version', 'update yourself', " +
      "'install the latest update'. It reports honestly when they are " +
      "already on the newest build.",
    risk: "low",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      let meta = null;
      try {
        meta = require("../routes/appUpdate").readMeta();
      } catch (_) {}
      const latest = Number(meta && meta.versionCode) || 0;
      const have = Number(ctx.appBuild) || 0;

      if (!latest) {
        return {
          ok: false,
          error: "no_published_build",
          note: "Say there is no update available right now. Do not invent a version.",
        };
      }
      // ALREADY CURRENT IS AN ANSWER, NOT A FAILURE — and it must not open
      // a sheet that would immediately say the same thing.
      if (have && have >= latest) {
        return {
          ok: true,
          data: { installed: have, latest, upToDate: true },
          speak: `You're already on the latest version.`,
          note:
            "They are up to date. Say so in one short line and do NOT claim " +
            "to be opening or installing anything.",
        };
      }
      return {
        ok: true,
        deviceAction: { type: "check_for_update" },
        data: {
          installed: have || null,
          latest,
          versionName: meta.versionName || "",
          upToDate: false,
        },
        speak: `Version ${meta.versionName || latest} is ready — opening the installer.`,
        note:
          "THE UPDATE SHEET IS NOW ON THEIR SCREEN with an install button. " +
          "Say in one line that the update is ready and they can tap to " +
          "install. Do NOT claim it is installed — they have to accept it, " +
          "and Android asks for confirmation.",
      };
    },
  });

  /* ---------------------------------------------------------------- */
  /* THE REST OF THE CLOCK                                             */
  /*                                                                   */
  /* Setting was the only half that existed, so "switch off my alarm"  */
  /* got "I can't turn off your alarms from here" — seen verbatim in a */
  /* transcript. Android exposes the whole surface through standard    */
  /* intents, all seven verified as handled on a real device before    */
  /* these were written.                                               */
  /* ---------------------------------------------------------------- */

  registry.register({
    name: "stop_alarm",
    description:
      "Turn OFF a ringing or upcoming alarm in the phone's clock app — " +
      "'switch off my alarm', 'turn off the alarm', 'cancel my 6 am alarm', " +
      "'stop that alarm'. Use which='next' for the upcoming one (the usual " +
      "case), which='all' to clear every alarm, or give hour and minute to " +
      "dismiss one specific alarm.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        which: { type: "string", enum: ["next", "all"], description: "Default 'next'." },
        hour: { type: "integer", description: "0-23, only to dismiss one specific alarm." },
        minute: { type: "integer", description: "0-59, with hour." },
      },
    },
    async execute(args) {
      const hasTime =
        Number.isInteger(args.hour) && Number.isInteger(args.minute);
      // SEARCH_MODE is REQUIRED by ACTION_DISMISS_ALARM; without it the
      // clock app has no idea which alarm is meant and does nothing.
      const mode = hasTime
        ? "android.time"
        : args.which === "all"
          ? "android.all"
          : "android.next";
      const time = hasTime
        ? `i.android.intent.extra.alarm.HOUR=${args.hour};` +
          `i.android.intent.extra.alarm.MINUTES=${args.minute};`
        : "";
      const dismissAction = {
        type: "clock_intent",
        action: "android.intent.action.DISMISS_ALARM",
        extras: {
          "android.intent.extra.alarm.SEARCH_MODE": mode,
          ...(hasTime
            ? {
                "android.intent.extra.alarm.HOUR": args.hour,
                "android.intent.extra.alarm.MINUTES": args.minute,
              }
            : {}),
        },
      };
      const what = hasTime
        ? `the ${String(args.hour).padStart(2, "0")}:${String(args.minute).padStart(2, "0")} alarm`
        : args.which === "all"
          ? "all your alarms"
          : "your next alarm";
      return {
        ok: true,
        deviceAction: dismissAction,
        speak: `Turning off ${what}.`,
      };
    },
  });

  registry.register({
    name: "snooze_alarm",
    description:
      "Snooze the alarm that is ringing right now — 'snooze', 'five more " +
      "minutes', 'snooze the alarm'. Only meaningful while an alarm is " +
      "actually sounding; to cancel an upcoming one use stop_alarm.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        minutes: { type: "integer", description: "How long to snooze for, if they said." },
      },
    },
    async execute(args) {
      const mins = Number.isInteger(args.minutes) && args.minutes > 0 ? args.minutes : 0;
      return {
        ok: true,
        deviceAction: {
          type: "clock_intent",
          action: "android.intent.action.SNOOZE_ALARM",
          extras: mins ? { "android.intent.extra.alarm.SNOOZE_DURATION": mins } : {},
        },
        speak: mins ? `Snoozing for ${mins} minutes.` : "Snoozing that alarm.",
      };
    },
  });

  registry.register({
    name: "stop_timer",
    description:
      "Stop or cancel a running countdown timer — 'stop the timer', " +
      "'cancel the timer', 'turn that timer off'. For an ALARM use " +
      "stop_alarm instead; a timer counts down, an alarm rings at a time.",
    risk: "low",
    deviceAction: true,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return {
        ok: true,
        deviceAction: {
          type: "clock_intent",
          action: "android.intent.action.DISMISS_TIMER",
          extras: {},
        },
        speak: "Stopping the timer.",
      };
    },
  });

  registry.register({
    name: "show_alarms",
    description:
      "Open the phone's clock app so the user can SEE their alarms or " +
      "timers — 'show me my alarms', 'what alarms do I have', 'open the " +
      "timer'. Use this when they want to look at them rather than change " +
      "one; there is no way to read the list back, so do not describe or " +
      "count their alarms, just put the clock in front of them.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        what: { type: "string", enum: ["alarms", "timers"], description: "Default 'alarms'." },
      },
    },
    async execute(args) {
      const timers = args.what === "timers";
      const action = timers
        ? "android.intent.action.SHOW_TIMERS"
        : "android.intent.action.SHOW_ALARMS";
      return {
        ok: true,
        deviceAction: { type: "clock_intent", action, extras: {} },
        speak: timers ? "Opening your timers." : "Opening your alarms.",
        note:
          "The clock app is now on their screen. You CANNOT read what is in " +
          "it — never state how many alarms they have or what time they are " +
          "set for, because you did not see them.",
      };
    },
  });

  registry.register({
    name: "set_timer",
    description:
      "Start a countdown in the phone's clock app — 'set a timer for ten " +
      "minutes', 'remind me in 20 minutes', 'time this for 2 hours'. " +
      "Different from set_alarm, which rings at a TIME of day; a timer " +
      "counts DOWN from now. It rings even if this app is closed.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        minutes: { type: "number", description: "How long, in minutes. Use decimals for seconds (0.5 = 30s)." },
        label: { type: "string", description: "What the timer is for, e.g. 'pasta'." },
      },
      required: ["minutes"],
    },
    async execute(args) {
      const minutes = Number(args.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return { ok: false, error: "how long should the timer run?" };
      }
      const seconds = Math.round(Math.min(minutes, 24 * 60) * 60);
      const label = args.label
        ? `S.android.intent.extra.alarm.MESSAGE=${encodeURIComponent(String(args.label).slice(0, 60))};`
        : "";
      // Same route as set_alarm: the phone's own clock app, via an intent
      // deep link. SKIP_UI starts it without making the user finish a form.
      const timerAction = {
        type: "clock_intent",
        action: "android.intent.action.SET_TIMER",
        extras: {
          "android.intent.extra.alarm.LENGTH": seconds,
          "android.intent.extra.alarm.SKIP_UI": true,
          ...(args.label ? { "android.intent.extra.alarm.MESSAGE": String(args.label).slice(0, 60) } : {}),
        },
      };
      const human =
        seconds % 3600 === 0 && seconds >= 3600
          ? `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`
          : seconds >= 60
            ? `${Math.round(seconds / 60)} minute${Math.round(seconds / 60) === 1 ? "" : "s"}`
            : `${seconds} seconds`;
      return {
        ok: true,
        deviceAction: timerAction,
        speak: `Timer set for ${human}.`,
      };
    },
  });

  registry.register({
    name: "get_app_usage",
    description:
      "The user's phone screen time, per app per day — 'how much did I use " +
      "YouTube', 'what's my screen time', 'which apps am I wasting time " +
      "on', 'help me reduce my phone usage'. Returns per-app minutes for " +
      "recent days; use it to answer, compare days, and suggest realistic " +
      "cuts (name the top offenders, suggest limits). If it reports no " +
      "data, the Usage access permission is off — offer " +
      "enable_usage_tracking.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          description: "How many days back to include (default 7, max 30)",
        },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const { usageOf } = require("../routes/usage");
      const days = Math.max(1, Math.min(30, Number(args.days) || 7));
      const rows = await usageOf(ctx.userId, { days });
      if (!rows.length) {
        return {
          ok: true,
          data:
            "No screen-time data yet. The phone reports it only after the " +
            "user grants Usage access — offer to open that settings screen " +
            "with enable_usage_tracking.",
        };
      }
      // Compact per-day summary the model can reason over.
      const byDay = {};
      for (const r of rows) {
        (byDay[r.day] ||= []).push(`${r.app_name}: ${r.minutes}m`);
      }
      const lines = Object.entries(byDay).map(([day, apps]) => {
        const total = rows
          .filter((r) => r.day === day)
          .reduce((s, r) => s + r.minutes, 0);
        return `${day} (total ${Math.floor(total / 60)}h${total % 60}m): ${apps
          .slice(0, 8)
          .join(", ")}`;
      });
      return { ok: true, data: lines.join("\n") };
    },
  });

  registry.register({
    name: "enable_usage_tracking",
    description:
      "Open the phone's Usage access settings screen so the user can grant " +
      "screen-time permission to this app. Use when get_app_usage has no " +
      "data and the user wants usage tracking. Tell them to find this app " +
      "in the list and switch Usage access ON.",
    risk: "low",
    deviceAction: true,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return {
        ok: true,
        deviceAction: { type: "open_usage_access" },
        speak:
          "Opening the Usage access settings — find me in the list and " +
          "switch it on. From tomorrow I'll know your screen time.",
      };
    },
  });

  registry.register({
    name: "open_webpage",
    description:
      "Open a website on the user's phone. Pass `url` ONLY for a service " +
      "whose OFFICIAL domain you are completely certain of (IndiGo → " +
      "https://www.goindigo.in, IRCTC → https://www.irctc.co.in, income " +
      "tax e-filing → https://eportal.incometax.gov.in). For ANYTHING " +
      "generic or any domain you are not 100% sure of — 'court documents', " +
      "'course material', a small business, an unfamiliar site — pass " +
      "`search` instead and the user gets Google results to choose from. " +
      "A guessed domain that doesn't exist is far worse than a search " +
      "page: NEVER invent or approximate a URL. Prefer the dedicated " +
      "tools for YouTube, shopping, food, cabs and movies.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Full URL — ONLY when the official domain is beyond doubt. https:// is assumed if missing.",
        },
        search: {
          type: "string",
          description:
            "What to search Google for, when no certain official URL exists — e.g. 'district court documents download Karnataka'.",
        },
        label: {
          type: "string",
          description:
            "Short human name of the site ('the income tax portal') for the spoken confirmation.",
        },
      },
    },
    async execute(args) {
      const searchQ = String(args.search || "").trim();
      let url = String(args.url || "").trim();
      if (!url && !searchQ) {
        return { ok: false, error: "give either a certain official url or a search query" };
      }
      if (!url) {
        return {
          ok: true,
          deviceAction: {
            type: "open_url",
            url: `https://www.google.com/search?q=${encodeURIComponent(searchQ)}`,
          },
          speak: `I've put the search results for ${searchQ.slice(0, 60)} on your screen — pick the one you want.`,
        };
      }
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;
      let parsed;
      try {
        parsed = new URL(url);
      } catch (_) {
        return { ok: false, error: "That doesn't look like a valid web address." };
      }
      // Only the web: this tool must not become a way to fire arbitrary
      // intent schemes on the handset.
      if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname.includes(".")) {
        return { ok: false, error: "That doesn't look like a valid web address." };
      }
      const label = String(args.label || parsed.hostname).slice(0, 80);
      return {
        ok: true,
        deviceAction: { type: "open_url", url: parsed.href },
        speak: `Opening ${label} on your screen.`,
      };
    },
  });

  registry.register({
    name: "add_finance_item",
    description:
      "Record a money item in the user's finance section — an EMI ('I " +
      "have a bike EMI of 3500 at 11 percent'), an expected income ('I " +
      "get 2000 on the 15th'), or a recurring expense (rent, fees). " +
      "Amounts are monthly rupees. Use whenever the user states an EMI, " +
      "loan, income or recurring expense they want tracked. ALWAYS pass " +
      "due_day when the user gives ANY timing — 'tomorrow', 'on the 15th', " +
      "'every 3rd' — converted to the day of month; due_day is what places " +
      "the item on their calendar every month. Do NOT also create a " +
      "reminder for it: the calendar shows finance items by itself.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["income", "emi", "expense"] },
        name: { type: "string", description: "Short label ('Bike EMI', 'Salary')" },
        amount: { type: "number", description: "Monthly amount in rupees" },
        interest_rate: {
          type: "number",
          description: "Annual interest % (EMIs only)",
        },
        due_day: {
          type: "integer",
          description:
            "Day of month it hits (1-31). Convert any stated timing " +
            "('tomorrow', 'the 15th') to this — required for the calendar.",
        },
        outstanding: {
          type: "number",
          description: "Remaining loan principal in rupees (EMIs), if known",
        },
      },
      required: ["kind", "name", "amount"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      try {
        const db = require("../db");
        // listItems owns the CREATE TABLE — run it first so a voice-add
        // works even if the Finance screen was never opened.
        await require("../routes/finance").listItems(ctx.userId);
        const kind = ["income", "emi", "expense"].includes(args.kind)
          ? args.kind : "expense";
        const amount = Number(args.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          return { ok: false, error: "a positive amount is needed" };
        }
        await db.run(
          `INSERT INTO finance_items
             (user_id, kind, name, amount, interest_rate, due_day, outstanding, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            ctx.userId, kind,
            String(args.name || kind).trim().slice(0, 80),
            amount,
            Number(args.interest_rate) || 0,
            Number.isInteger(args.due_day) ? args.due_day : 0,
            Number(args.outstanding) || 0,
            Date.now(),
          ]
        );
        return {
          ok: true,
          data: { saved: true },
          speak: `Noted — ${args.name}, ₹${amount} monthly${kind === "emi" && args.interest_rate ? ` at ${args.interest_rate} percent` : ""}. It's in your finance section.`,
        };
      } catch (e) {
        console.error("add_finance_item:", e.message);
        return { ok: false, error: "couldn't save that — try once more" };
      }
    },
  });

  registry.register({
    name: "get_finance_plan",
    description:
      "The user's full finance picture — incomes, EMIs (with interest " +
      "rates and outstanding principal), expenses, monthly surplus. Use " +
      "for ANY money-planning question: 'which EMI should I close first', " +
      "'can I afford X', 'plan my finances', 'I'm getting 2000 on the " +
      "15th, how should I use it'. Rule of thumb to apply: put spare money " +
      "against the HIGHEST-INTEREST debt first (after keeping a small " +
      "buffer). Give concrete numbers and put a structured plan on screen " +
      "with present_text for anything beyond a one-liner.",
    risk: "low",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const { listItems, summarize } = require("../routes/finance");
      const items = await listItems(ctx.userId);
      if (!items.length) {
        return {
          ok: true,
          data: {
            result:
              "No finance items recorded yet. Offer to note their EMIs, " +
              "incomes and expenses (add_finance_item) — or they can add " +
              "them in the Finance section of the app.",
          },
        };
      }
      const s = summarize(items);
      const lines = items.map((i) => {
        if (i.kind === "emi") {
          return `EMI: ${i.name} — ₹${i.amount}/mo at ${i.interest_rate}%` +
            (i.outstanding ? `, ₹${i.outstanding} outstanding` : "") +
            (i.due_day ? `, due day ${i.due_day}` : "");
        }
        return `${i.kind}: ${i.name} — ₹${i.amount}/mo` +
          (i.due_day ? `, day ${i.due_day}` : "");
      });
      return {
        ok: true,
        data: {
          result:
            lines.join("\n") +
            `\nTotals: income ₹${s.monthly_income}/mo, EMIs ₹${s.monthly_emi}/mo, ` +
            `expenses ₹${s.monthly_expense}/mo, surplus ₹${s.surplus}/mo, ` +
            `total debt outstanding ₹${s.total_debt}.`,
        },
      };
    },
  });

  registry.register({
    name: "remove_finance_item",
    description:
      "Delete a finance item by its name ('remove the bike EMI', 'my rent " +
      "changed — delete it'). Exact-ish name match on the user's items.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const db = require("../db");
      const { listItems } = require("../routes/finance");
      const items = await listItems(ctx.userId);
      const q = String(args.name || "").toLowerCase().trim();
      const hit = items.find((i) => i.name.toLowerCase() === q) ||
        items.find((i) => i.name.toLowerCase().includes(q) && q.length >= 3);
      if (!hit) return { ok: false, error: `no finance item matching "${args.name}"` };
      await db.run(`DELETE FROM finance_items WHERE id=$1 AND user_id=$2`,
        [hit.id, ctx.userId]);
      return { ok: true, speak: `Removed ${hit.name} from your finance section.` };
    },
  });

  registry.register({
    name: "update_finance_item",
    description:
      "Change an existing finance item by name — its due day ('my bike EMI " +
      "hits on the 3rd'), amount, interest rate, or outstanding principal. " +
      "Use this instead of deleting and re-adding. Setting due_day places " +
      "the item on the user's calendar every month.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Which item ('bike EMI')" },
        due_day: { type: "integer", description: "Day of month (1-31)" },
        amount: { type: "number", description: "New monthly rupees" },
        interest_rate: { type: "number", description: "Annual interest %" },
        outstanding: { type: "number", description: "Remaining principal ₹" },
      },
      required: ["name"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const db = require("../db");
      const { listItems } = require("../routes/finance");
      const items = await listItems(ctx.userId);
      const q = String(args.name || "").toLowerCase().trim();
      const hit = items.find((i) => i.name.toLowerCase() === q) ||
        items.find((i) => i.name.toLowerCase().includes(q) && q.length >= 3);
      if (!hit) return { ok: false, error: `no finance item matching "${args.name}"` };
      const sets = [];
      const vals = [];
      let i = 1;
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
      if (num(args.due_day) !== null && args.due_day >= 1 && args.due_day <= 31) {
        sets.push(`due_day = $${i++}`); vals.push(Math.round(args.due_day));
      }
      if (num(args.amount) !== null && args.amount > 0) {
        sets.push(`amount = $${i++}`); vals.push(args.amount);
      }
      if (num(args.interest_rate) !== null && args.interest_rate >= 0) {
        sets.push(`interest_rate = $${i++}`); vals.push(args.interest_rate);
      }
      if (num(args.outstanding) !== null && args.outstanding >= 0) {
        sets.push(`outstanding = $${i++}`); vals.push(args.outstanding);
      }
      if (!sets.length) return { ok: false, error: "nothing to change" };
      vals.push(hit.id, ctx.userId);
      await db.run(
        `UPDATE finance_items SET ${sets.join(", ")} WHERE id=$${i++} AND user_id=$${i}`,
        vals
      );
      const bits = [];
      if (args.due_day) bits.push(`due on the ${args.due_day}`);
      if (args.amount) bits.push(`₹${args.amount} a month`);
      return {
        ok: true,
        speak: `Updated ${hit.name}${bits.length ? " — " + bits.join(", ") : ""}.`,
      };
    },
  });

  registry.register({
    name: "present_text",
    description:
      "Put a WRITTEN piece on the user's screen — a speech, meeting script, " +
      "talking points, email draft, plan, list, or a decision breakdown. " +
      "YOU write the full content; the phone shows it in a reader the user " +
      "can scroll, copy and share. Use whenever the user asks you to " +
      "write/draft/generate/prepare something meant to be READ or REUSED " +
      "('generate a script for my speech today', 'draft a reply', 'help me " +
      "decide — lay it out'). Plain text only: short paragraphs, blank " +
      "lines between sections, CAPITALISED or numbered headings — no " +
      "markdown symbols like ** or #.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short title ('Speech — Team Meeting').",
        },
        content: {
          type: "string",
          description: "The complete written piece, ready to read out or send.",
        },
      },
      required: ["title", "content"],
    },
    async execute(args) {
      const title = String(args.title || "").trim().slice(0, 120);
      const content = String(args.content || "").trim().slice(0, 20000);
      if (!content) return { ok: false, error: "nothing to show" };
      return {
        ok: true,
        deviceAction: { type: "show_text", title, content },
        speak: "It's on your screen — tell me if you want any part changed.",
      };
    },
  });

  registry.register({
    name: "generate_image",
    description:
      "CREATE an image from a description — 'draw a poster for my café', " +
      "'make a picture of a beach house at sunset', 'design a birthday " +
      "card for amma', 'generate a logo'. Write a vivid, detailed prompt " +
      "from what the user asked (style, colors, mood, composition) — and " +
      "say the CRAFT out loud in the prompt: the lens or medium, the " +
      "lighting, the palette, what is in focus. A thin prompt gets a thin " +
      "picture; the quality of the result is mostly the quality of these " +
      "words.\n" +
      "SPELL OUT WHAT THE SUBJECT LOOKS LIKE when it has a canonical " +
      "appearance the image model may not know — a deity, a saint, a " +
      "regional dress, a specific temple, a cultural object. Asked for Lord " +
      "Krishna with only 'divine aura, cinematic lighting', the model " +
      "produced a red-skinned idol with the flute through his cheek. State " +
      "the skin colour, the dress, what is held and how it is held. It " +
      "cannot infer any of this, and there is no negative prompt to undo it " +
      "with. Pick `aspect` from what it is for. The image appears on their " +
      "screen and is saved to their documents. Takes a few seconds — never " +
      "refuse a creative request.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Rich visual description of the image to create — subject, " +
            "style, lighting, mood. Expand the user's words into a real " +
            "art prompt.",
        },
        title: {
          type: "string",
          description: "Short human title ('Café poster') for the saved file.",
        },
        aspect: {
          type: "string",
          enum: ["square", "portrait", "landscape", "wide"],
          description:
            "The SHAPE the subject wants, and it matters — a poster, a " +
            "greeting card or a phone wallpaper is portrait; a banner, a " +
            "scene or a desktop wallpaper is landscape; a logo or a feed " +
            "post is square; wide is 16:9. Choose it from what they asked " +
            "for rather than defaulting: everything used to come out square " +
            "and posters were cropped into a box.",
        },
      },
      required: ["prompt"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const prompt = String(args.prompt || "").trim().slice(0, 1400);
      if (!prompt) return { ok: false, error: "describe what to draw" };
      try {
        const { generateImage } = require("../services/imagegen");
        const img = await generateImage(prompt, { aspect: args.aspect });
        const docs = require("../docs/store");
        const ext = img.mime === "image/png" ? "png" : "jpg";
        const row = await docs.createDocument(ctx.userId, {
          buffer: img.buffer,
          filename: `hari-art-${Date.now()}.${ext}`,
          mime: img.mime,
          note: prompt,
        });
        const title = String(args.title || "").trim().slice(0, 120) ||
          `AI image — ${prompt.slice(0, 100)}`;
        // fullText = prompt keeps the docs self-heal pass from spending a
        // vision call re-analyzing an image we already know everything about.
        const updated = await docs
          .setMetadata(ctx.userId, row.id, {
            title,
            category: "other",
            docDate: new Date().toISOString().slice(0, 10),
            summary: `AI-generated image from: ${prompt}`,
            tags: ["generated", "ai-art"],
            fullText: `AI-generated image. Prompt: ${prompt}`,
          })
          .catch(() => null);
        return {
          ok: true,
          // FINISHED, AND SAID SO. Without a data field the live path
          // summarised this to the model as "Device action requested",
          // which is how a generated image came to be described as still
          // on its way — and then, a turn later, as having failed.
          data: {
            generated: true,
            title,
            documentId: row.id,
            note:
              "The image EXISTS and is saved. It is on the user's screen " +
              "now. Do not say it is still being made, and do not say it " +
              "failed.",
          },
          deviceAction: {
            type: "show_image",
            doc_id: row.id,
            prompt,
            title,
            // Full client shape so the app can render + share with no
            // extra round-trip.
            document: docs.toClient(updated || row),
          },
          speak: "Here it is — your image is on the screen, and I've saved it to your files.",
        };
      } catch (e) {
        console.error("generate_image:", e.message);
        return {
          ok: false,
          error:
            "Image generation hit a snag just now — ask me to try again in a moment.",
        };
      }
    },
  });

  registry.register({
    name: "generate_video",
    description:
      "CREATE a short video clip from a description — 'make a video of " +
      "waves at sunset', 'a clip of my café for Instagram'. It is made in " +
      "the background and takes a couple of minutes: say you are on it and " +
      "that you will tell them when it lands in their documents, then carry " +
      "on. Never wait for it and never describe what you have not seen. " +
      "Write a vivid prompt the way you would for an image.\n" +
      "Tell the user what they are getting, because there are two kinds and " +
      "the result says which: `kind: \"veo\"` is fully synthesised video, " +
      "`kind: \"keyframes\"` is a cinematic sequence of generated frames " +
      "crossfaded with a slow camera push — a real moving clip, but not " +
      "synthesised motion. Describe the second one as that honestly if " +
      "asked; never call it something it is not.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Rich visual description of the video to create.",
        },
        aspect: {
          type: "string",
          enum: ["wide", "portrait", "square"],
          description:
            "wide (16:9) for a normal clip, portrait for a Reel or Story, " +
            "square for a feed post. Default wide.",
        },
        seconds: {
          type: "integer",
          description: "Roughly how long, 5-15. Default 8.",
        },
      },
      required: ["prompt"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const prompt = String(args.prompt || "").trim().slice(0, 1400);
      if (!prompt) return { ok: false, error: "describe the video" };
      try {
        await require("../infra/jobs").enqueue(
          "generate_video",
          {
            userId: ctx.userId,
            prompt,
            aspect: args.aspect || "wide",
            seconds: Math.min(Math.max(Number(args.seconds) || 8, 5), 15),
          },
          { userId: ctx.userId }
        );
      } catch (e) {
        return {
          ok: false,
          error: `could not start the video: ${String(e.message).slice(0, 120)}`,
        };
      }
      return {
        ok: true,
        data: { prompt, status: "started" },
        speak: "",
        note:
          "STARTED, not finished — this takes a couple of minutes and lands " +
          "AFTER this conversation. Tell the user you are making it and that " +
          "you will let them know when it is in their documents, then move " +
          "on. Do NOT describe the video: you have not seen it.",
      };
    },
  });

  /* ------------------------------------------------------------------ */
  /* STYLE STUDIO — "show me how I'd look ..."                           */
  /*                                                                     */
  /* One tool for every recipe rather than ten near-identical ones: the  */
  /* model picks a recipe id and fills its parameters, which is the same  */
  /* decision it would make choosing between ten tools, with ten times   */
  /* less schema in front of it.                                         */
  /* ------------------------------------------------------------------ */
  registry.register({
    name: "try_a_look",
    description:
      "SHOW THE USER HOW THEY WOULD LOOK — on their own photo. 'how would " +
      "I look in a navy suit', 'show me with short hair', 'what about a " +
      "beard', 'make me a LinkedIn photo', 'I need a passport photo', " +
      "'restore this old photo of my father', 'put me in front of an " +
      "office background', 'dress me for my cousin's wedding'.\n" +
      "It uses the photo they saved in Style Studio, edits it, and the " +
      "result appears full-screen on their phone and is saved to their " +
      "files. Takes ten to sixty seconds — say you're on it, then let the " +
      "result speak. Never describe what the picture looks like: you have " +
      "not seen it. Say it is on their screen.\n" +
      "PICK THE RECIPE from what they asked for:\n" +
      "  outfit    clothes — a suit, a saree, a kurta, a jacket\n" +
      "  hair      a haircut or hair colour\n" +
      "  beard     facial hair, or clean-shaven\n" +
      "  eyewear   spectacles or sunglasses\n" +
      "  jewellery a necklace, earrings, bangles\n" +
      "  headshot  a professional / LinkedIn / corporate portrait\n" +
      "  idphoto   a passport, visa, PAN or Aadhaar photograph\n" +
      "  restore   repairing an old, damaged or faded photograph\n" +
      "  backdrop  changing only the background\n" +
      "  occasion  a complete look for a named event\n" +
      "WRITE THE PARAMETERS PROPERLY — the quality of the picture is mostly " +
      "the quality of these words. 'a navy suit' is thin; 'a sharply " +
      "tailored navy-blue two-piece suit with a white shirt and a dark " +
      "silk tie' is what they asked for. Name the fabric, the cut and the " +
      "colour. For Indian clothing name the type exactly — Kanjivaram silk " +
      "saree, ivory sherwani with gold zardozi, cotton chikankari kurta.\n" +
      "If it says they have no photo saved yet, tell them to add one in " +
      "Style Studio — once — and that every look afterwards uses it.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        recipe: {
          type: "string",
          enum: ["outfit", "hair", "beard", "eyewear", "jewellery",
                 "headshot", "idphoto", "restore", "backdrop", "occasion"],
          description: "Which kind of look to make.",
        },
        outfit: {
          type: "string",
          description:
            "recipe=outfit: the garment, described richly — fabric, cut, " +
            "colour, detailing. Also used for the `occasion` recipe's dress " +
            "direction if given.",
        },
        style: {
          type: "string",
          description:
            "recipe=hair: the haircut ('a chin-length blunt bob with a side " +
            "parting'). recipe=beard: the facial hair ('a neat French beard').",
        },
        colour: {
          type: "string",
          description:
            "recipe=hair: the hair colour, or omit to keep their own — " +
            "'Natural black', 'Dark brown', 'Burgundy', 'Salt and pepper', " +
            "'Caramel highlights', 'Silver'.",
        },
        frame: { type: "string", description: "recipe=eyewear: the frames." },
        piece: { type: "string", description: "recipe=jewellery: the piece." },
        attire: {
          type: "string",
          description:
            "recipe=headshot: 'Business suit', 'Formal shirt', 'Smart " +
            "casual', 'Kurta', 'Saree', \"Doctor's coat\", or \"Keep what " +
            "I'm wearing\". recipe=idphoto: clothing for the document photo.",
        },
        backdrop: {
          type: "string",
          description:
            "recipe=headshot: 'Studio grey', 'Modern office', 'Library', " +
            "'Garden light', 'City at night', 'Pure white'.",
        },
        scene: {
          type: "string",
          description: "recipe=backdrop: the new background, described.",
        },
        spec: {
          type: "string",
          enum: ["India passport", "PAN / Aadhaar", "US visa / DV",
                 "Schengen visa", "UK passport"],
          description:
            "recipe=idphoto: WHICH document. Required — each has a different " +
            "size, background colour and head-height rule, and a photo made " +
            "to the wrong one is rejected at the counter. Ask if unclear.",
        },
        occasion: {
          type: "string",
          description:
            "recipe=occasion: the event, in their words ('my cousin's " +
            "wedding reception', 'a job interview'). Also usable with " +
            "recipe=outfit to steer footwear and accessories.",
        },
        notes: { type: "string", description: "Anything else they said that matters." },
        colourise: {
          type: "string",
          enum: ["Add natural colour", "Keep it black and white"],
          description: "recipe=restore only.",
        },
      },
      required: ["recipe"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const recipe = String(args.recipe || "").trim();
      const params = {};
      for (const k of ["outfit", "style", "colour", "frame", "piece", "attire",
                       "backdrop", "scene", "spec", "occasion", "notes",
                       "colourise", "fit", "length"]) {
        const v = String(args[k] || "").trim();
        if (v) params[k] = v;
      }
      // The occasion recipe reads `occasion`; an outfit description handed
      // to it belongs in its notes rather than being dropped.
      if (recipe === "occasion" && params.outfit) {
        params.notes = [params.notes, `dress direction: ${params.outfit}`]
          .filter(Boolean).join("; ");
        delete params.outfit;
      }

      try {
        const out = await require("../studio/run").runRecipe(ctx.userId, {
          recipeId: recipe, params, surface: "voice",
        });
        return {
          ok: true,
          // A data field, so the live path summarises this as FINISHED. An
          // empty one is what made a generated image get announced as
          // still on its way and then, a turn later, as having failed.
          data: {
            generated: true,
            recipe,
            documentId: out.document.id,
            size: `${out.width}x${out.height}`,
            note:
              "The picture EXISTS, is on the user's screen now and is saved " +
              "to their files. Do not say it is still being made, do not " +
              "say it failed, and do not describe what is in it.",
          },
          deviceAction: {
            type: "show_image",
            doc_id: out.document.id,
            title: out.document.title,
            document: out.document,
          },
          speak:
            recipe === "idphoto"
              ? `Here it is — made to the ${params.spec || "document"} spec and saved to your files.`
              : "Here you go — it's on your screen and saved to your files.",
        };
      } catch (e) {
        // Every one of these is a sentence worth saying out loud as-is:
        // "add a photo first", "that's today's limit", "it needs setting up".
        const code = e.code || "";
        if (code === "no_model_photo" || code === "daily_cap" ||
            code === "no_provider" || code === "edit_failed" ||
            code === "missing_photo" || code === "missing_file") {
          return { ok: false, error: e.message, data: { code } };
        }
        console.error("try_a_look:", e.stack || e.message);
        return {
          ok: false,
          error: "That didn't come out — ask me to try it again in a moment.",
        };
      }
    },
  });

  registry.register({
    name: "open_app",
    description:
      "Open an app on the user's phone, optionally straight at a PERSON'S " +
      "PROFILE or a search — 'open Instagram', 'open the Prime Minister's " +
      "Instagram', 'show me Virat Kohli on X', 'open WhatsApp'. This DOES " +
      "open the app on their phone; say you're opening it.\n" +
      "OPENING SOMEONE'S PROFILE: put their NAME in `person`, exactly as " +
      "the user said it. Works for ANYONE — a head of state, a cricketer, " +
      "a regional actor, a friend. The handle is established from the live " +
      "profile page, which is what makes it THEIR account and not a " +
      "namesake's. DO NOT GUESS A HANDLE: a remembered username opens a " +
      "stranger's profile while saying the person's name.\n" +
      "Only pass `handle` when the USER themselves said the username " +
      "('open @virat.kohli'). If the lookup cannot find them the tool falls " +
      "back to a search page, which is correct — showing a choice beats " +
      "confidently opening a stranger.\n" +
      "THE APP MUST BE ONE OF THE LISTED VALUES. For anything else the user " +
      "names — Swiggy, Zomato, Uber, Ola, BookMyShow, Blinkit — use " +
      "open_named_app instead. Never substitute a different app from this " +
      "list, and never say you opened one you did not.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        app: {
          type: "string",
          enum: ["instagram", "facebook", "x", "linkedin", "whatsapp", "maps",
                 "gmail", "google_images", "google", "youtube", "spotify"],
        },
        person: {
          type: "string",
          description:
            "The PERSON'S NAME as the user said it. Preferred over " +
            "handle: the real username is established from the profile " +
            "page, so it opens the right person and not a namesake.",
        },
        handle: {
          type: "string",
          description:
            "Only when the USER gave the username themselves ('open " +
            "@virat.kohli'). Never a username you remembered — use `person`.",
        },
        query: {
          type: "string",
          description:
            "What to SEARCH for. Use only when there is no specific person, " +
            "or when you do not know their handle.",
        },
      },
      required: ["app"],
    },
    async execute(args, ctx = {}) {
      const q = String(args.query || "").trim();
      const enc = encodeURIComponent(q);
      // A handle the USER typed or spoke wins. Failing that, a single-token
      // query IS a handle — "open instagram someusername" arrives that way.
      const raw = String(args.handle || "").trim().replace(/^@/, "");
      let unverified = false;
      let handle = /^[a-z0-9._]{2,30}$/i.test(raw)
        ? raw
        : /^@?[a-z0-9._]{2,30}$/i.test(q) && !/\s/.test(q)
          ? q.replace(/^@/, "")
          : "";

      // LOOK THE PERSON UP RATHER THAN TRUSTING A REMEMBERED USERNAME.
      // A guessed handle opens a stranger's profile while saying the
      // person's name — the failure this resolves. A name with a space in
      // it is a person, not a username, so it is resolved too.
      const person =
        String(args.person || "").trim() || (/\s/.test(q) ? q : "");
      if (person) {
        // resolveVerified, not resolve: it CHECKS each candidate against
        // the live profile page rather than trusting a search snippet or a
        // remembered username, and picks the biggest account whose page
        // actually carries the person's name. That is what separates the
        // actress (1M followers) from the two strangers who share her
        // name, and it needs no search quota — which matters, because the
        // search was rate-limited and answering with Wikipedia articles
        // about a different woman.
        const sh = require("./socialHandles");
        const found = await sh.resolveVerified(person, args.app, ctx).catch(() => null);
        // The looked-up handle wins over anything remembered.
        if (found) handle = found;
        else if (raw && !args.person) handle = raw;
        else handle = "";  // no confident match → fall through to search
        // WAS THE PAGE ACTUALLY CHECKED? Instagram answers this server 429
        // — datacenter ranges are rate-limited — so on production the
        // profile cannot be read and the "biggest matching account wins"
        // ranking never runs. A handle from a search snippet is a decent
        // guess, not a confirmed identity, and the reply must not present
        // it as one.
        unverified = Boolean(handle) && sh.inspectionBlocked(args.app);
      }

      // Web URLs, not app-scheme links: Android hands these to the installed
      // app when it is there and to the browser when it is not, so the user
      // never lands on a dead "can't open" screen.
      //
      // A PROFILE URL OPENS THE PROFILE; a search URL mostly does not.
      // Instagram has no external search deep link at all — handing it one
      // opens the home feed, which is what testers kept reporting as "it
      // only opens Instagram". So every platform that has a profile URL
      // shape now gets one when a handle is known, and only falls back to
      // search when it is not.
      const PROFILE = {
        instagram: (h) => `https://www.instagram.com/${h}/`,
        x: (h) => `https://x.com/${h}`,
        facebook: (h) => `https://www.facebook.com/${h}`,
        linkedin: (h) => `https://www.linkedin.com/in/${h}`,
        youtube: (h) => `https://www.youtube.com/@${h}`,
        spotify: null, // spotify handles are opaque ids, not usernames
      };
      const SEARCH = {
        instagram: (t) =>
          // Google image results scoped to the site, NOT Instagram's own
          // /explore/search/keyword/?q=.
          //
          // That path is real and the Android app does claim it — but the
          // app IGNORES the query and opens on Reels, which was checked on
          // a device and is worse than useless: the user asked for a
          // person and got a video feed. Image results scoped to
          // instagram.com at least show the person, with their profile a
          // tap away.
          `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(t + " site:instagram.com")}`,
        facebook: (t) => `https://www.facebook.com/search/top?q=${encodeURIComponent(t)}`,
        x: (t) => `https://x.com/search?q=${encodeURIComponent(t)}`,
        linkedin: (t) => `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(t)}`,
        maps: (t) => `https://www.google.com/maps/search/${encodeURIComponent(t)}`,
        google_images: (t) => `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(t)}`,
        google: (t) => `https://www.google.com/search?q=${encodeURIComponent(t)}`,
        youtube: (t) => `https://www.youtube.com/results?search_query=${encodeURIComponent(t)}`,
        spotify: (t) => `https://open.spotify.com/search/${encodeURIComponent(t)}`,
      };
      const HOME = {
        instagram: "https://www.instagram.com/",
        facebook: "https://www.facebook.com/",
        x: "https://x.com/",
        linkedin: "https://www.linkedin.com/",
        whatsapp: "https://web.whatsapp.com/",
        maps: "https://www.google.com/maps",
        gmail: "https://mail.google.com/",
        google_images: "https://www.google.com/",
        google: "https://www.google.com/",
        youtube: "https://www.youtube.com/",
        spotify: "https://open.spotify.com/",
      };

      const app = args.app;
      if (!HOME[app]) return { ok: false, error: `unknown app ${app}` };

      let url;
      let mode;
      // SEARCH FOR THE PERSON WHEN THE HANDLE COULD NOT BE FOUND.
      //
      // This used to require `query`, which the model does not send when
      // it sends `person` — so a failed lookup opened Instagram's HOME
      // FEED — reported as "it just opens Instagram, but I can't find
      // their profile". The fallback was throwing away the one thing the
      // user had told us: the person's name.
      const searchFor = q || require("./socialHandles").cleanName(person || "");
      if (handle && PROFILE[app]) {
        url = PROFILE[app](handle);
        mode = "profile";
      } else if (searchFor && SEARCH[app]) {
        url = SEARCH[app](searchFor);
        mode = "search";
      } else {
        url = HOME[app];
        mode = "home";
      }

      const label = app === "google_images" ? "image search" : app;
      // Say what will ACTUALLY appear. Promising "their profile"
      // and delivering the app's home feed is the kind of small lie that
      // erodes trust.
      // `searchFor`, not `q`: when the lookup failed we searched for the
      // PERSON, and saying "here are 's Instagram photos" — which is what
      // the old template produced with an empty query — is worse than
      // saying nothing.
      const who = searchFor || person || q;
      const speak =
        mode === "profile"
          ? unverified
            ? `Opening @${handle} on ${label} — I couldn't confirm it's the right one, so check the name.`
            : `Opening ${handle}'s ${label} profile.`
          : mode === "search"
            ? app === "instagram"
              ? who
                ? `I couldn't pin down ${who}'s exact account, so I've opened Instagram's search for them — tap the right one.`
                : "I've opened Instagram's search."
              : who
                ? `Opening ${label} for ${who}.`
                : `Opening ${label}.`
            : `Opening ${label}.`;

      return {
        ok: true,
        data: { url, mode, handle: handle || null },
        deviceAction: { type: "open_url", url },
        speak,
        // The old note told the model to "call this again with handle set
        // if you know their username" — i.e. to guess, which is what
        // opened a namesake's account. It must not retry from
        // memory; the lookup already tried and could not confirm.
        note:
          mode === "profile" && unverified
            ? `The profile page could not be read from this server, so @${handle} ` +
              `comes from a web search and is NOT confirmed. Say you have opened ` +
              `it but could not verify it is the right account, in one short ` +
              `clause. Do NOT state it is theirs as fact.`
          : mode === "search" && PROFILE[app]
            ? `This is a SEARCH, not ${who || "their"} profile: the username ` +
              `could not be confirmed. Do NOT call this again with a handle ` +
              `you remember — a guessed username opens a stranger's account. ` +
              `Tell the user you could not confirm which account is theirs ` +
              `and that the results are on screen to pick from.`
            : undefined,
      };
    },
  });

  registry.register({
    name: "set_app_theme",
    description:
      "Change how the APP ITSELF looks — 'switch to dark mode', 'make it " +
      "light', 'turn on dark theme', 'go back to automatic'. This is the " +
      "assistant app's own appearance, not the phone's system theme.\n" +
      "'adaptive' follows the clock: light by day, dark in the evening. It " +
      "is the default, and what 'automatic' means. Pick it when the user " +
      "asks for automatic or says to stop choosing for them.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["dark", "light", "adaptive"],
          description:
            "dark or light to fix it; adaptive to follow the time of day.",
        },
      },
      required: ["mode"],
    },
    async execute(args) {
      const mode = String(args.mode || "").toLowerCase().trim();
      if (!["dark", "light", "adaptive"].includes(mode)) {
        return { ok: false, error: `"${args.mode}" is not a theme I can set` };
      }
      return {
        ok: true,
        deviceAction: { type: "set_theme", mode },
        speak:
          mode === "adaptive"
            ? "Back to automatic — light by day, dark in the evening."
            : `Switched to ${mode} mode.`,
      };
    },
  });

  registry.register({
    name: "open_app_screen",
    description:
      "Open a screen INSIDE this assistant app — 'open my settings', 'show " +
      "my documents', 'open my clients', 'show my finances', 'open " +
      "diagnostics'. Use this for the app's OWN screens.\n" +
      "Not for other apps on the phone (use open_named_app or open_app), " +
      "and not for the phone's system settings (use phone_control).",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        screen: {
          type: "string",
          enum: [
            "settings", "home", "hub", "chat",
            "documents", "clients", "finance", "stocks",
            "diagnostics", "mcp",
          ],
          description:
            "settings = the assistant's own settings (voice, name, theme). " +
            "home/hub/chat are the main tabs. The rest are feature screens.",
        },
      },
      required: ["screen"],
    },
    async execute(args) {
      const screen = String(args.screen || "").toLowerCase().trim();
      const ALLOWED = [
        "settings", "home", "hub", "chat", "documents", "clients",
        "finance", "stocks", "diagnostics", "mcp",
      ];
      if (!ALLOWED.includes(screen)) {
        return { ok: false, error: `I don't have a screen called "${args.screen}"` };
      }
      const LABEL = {
        settings: "your settings", home: "Home", hub: "the Hub", chat: "Chat",
        documents: "your documents", clients: "your clients",
        finance: "your finances", stocks: "your stocks",
        diagnostics: "diagnostics", mcp: "your connected servers",
      };
      return {
        ok: true,
        deviceAction: { type: "open_app_screen", screen },
        speak: `Opening ${LABEL[screen]}.`,
      };
    },
  });

  registry.register({
    name: "open_named_app",
    description:
      "OPEN ANY APP INSTALLED ON THE USER'S PHONE, by the name they used — " +
      "'open Swiggy', 'open BigBasket', 'open Uber', 'open PhonePe', 'open " +
      "my banking app'. USE THIS FIRST for any plain 'open X' request.\n" +
      "THERE IS NO LIST. The phone looks up what it actually has installed " +
      "and opens it, so do NOT refuse because an app sounds unfamiliar — " +
      "pass the name through and let the phone answer. Only if it comes " +
      "back saying the app is not installed do you tell the user that.\n" +
      "Do NOT substitute a different app. Opening YouTube when the user " +
      "asked for Swiggy is worse than admitting you could not.\n" +
      "When they want something DONE rather than opened — order a dish, " +
      "book a cab, get tickets — use order_food, book_ride or " +
      "book_movie_tickets instead; those prepare the real target.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        app: {
          type: "string",
          description:
            "The app's name exactly as the user said it — 'Swiggy', " +
            "'BigBasket', 'PhonePe'. Free text; any installed app works.",
        },
      },
      required: ["app"],
    },
    async execute(args, ctx) {
      const deeplinks = require("../fulfillment/deeplinks");
      const asked = String(args.app || "").trim();
      if (!asked) return { ok: false, error: "no app was named" };

      // A KNOWN PROVIDER STILL GETS ITS DEEP LINK. Swiggy opened by
      // intent:// lands on its own host with a browser fallback, which is
      // better than a bare launcher intent — it works even when the app is
      // not installed. Everything else goes to the phone, which is the
      // only thing that knows what is actually on it.
      const link = deeplinks.launch({ name: asked, platform: ctx.platform });
      if (link) {
        return {
          ok: true,
          deviceAction: { type: "open_url", url: link.url },
          speak: `Opening ${link.label}.`,
        };
      }
      // AN OLD APP CANNOT DO THIS, AND MUST NOT BE TOLD IT DID.
      //
      // open_any_app is handled from build 34. An older app receives an
      // event type it has no case for, ignores it in silence — and the
      // tool has already said "Opening it." That is a false claim the
      // claim checker cannot catch, because the tool really did run.
      //
      // Builds that predate version reporting send 0, so unknown counts as
      // too old: guessing in the other direction produces exactly the
      // silent failure this avoids.
      const OPEN_ANY_APP_FROM = 34;
      const build = Number(ctx.appBuild) || 0;
      // UNKNOWN IS NOT OLD.
      //
      // Treating a missing build as 0 meant a dropped X-App-Build header
      // was indistinguishable from an ancient install, and the client —
      // who updates diligently — was told his app was too old on every
      // single turn. The app-side race that dropped that header is fixed,
      // but a header can always go missing, and the cost of the two
      // mistakes is not symmetric: refusing someone who can do it is a
      // visible, repeated insult, while attempting it on a phone that
      // cannot now ends in an honest device_result failure the assistant
      // reports. So only a build we actually KNOW to be too old is
      // refused.
      if (build > 0 && build < OPEN_ANY_APP_FROM) {
        return {
          ok: false,
          error: "app_too_old",
          data: {
            asked,
            hint:
              `This phone's app is too old to open ${asked} by name. Do NOT ` +
              `tell them to go and update it themselves — call update_app, ` +
              `which puts the installer on their screen, and say in one line ` +
              `that you need a newer version first and it is ready to ` +
              `install. Never claim ${asked} opened.`,
          },
        };
      }
      // THE PHONE DECIDES. There is no list here to be missing from — the
      // app matches the spoken name against what is installed and reports
      // back. It says "opening" rather than "opened" because the receipt
      // has not arrived yet; if the app is not there, the phone reports a
      // failure and the assistant is corrected.
      return {
        ok: true,
        deviceAction: { type: "open_any_app", name: asked },
        speak: `Opening ${asked}.`,
      };
    },
  });

  registry.register({
    name: "open_service_app",
    description:
      "Open a shopping or grocery app for the user — Blinkit, Zepto, Amazon, " +
      "Flipkart, MakeMyTrip, YouTube — searching for something if given. " +
      "For food delivery use order_food, for cabs use book_ride, for cinema " +
      "tickets use book_movie_tickets: those resolve the real target first.\n" +
      "THE SERVICE MUST BE ONE OF THE LISTED VALUES. If the user named " +
      "anything else — Swiggy, Zomato, Uber, Ola, BookMyShow — use " +
      "open_named_app. NEVER pick the nearest value from this list instead: " +
      "asked for Swiggy, this tool was called with 'youtube' and the user " +
      "was told YouTube was opening. That is worse than doing nothing.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          enum: ["blinkit", "zepto", "amazon", "flipkart", "makemytrip", "youtube"],
          description: "The service provider requested.",
        },
        query: {
          type: "string",
          description: "What to search for, e.g. 'milk', 'iphone 15'. Omit to just open the app.",
        },
      },
      required: ["service"],
    },
    async execute(args, ctx) {
      const deeplinks = require("../fulfillment/deeplinks");

      // YouTube isn't a fulfillment provider — it has no order to prepare,
      // so it keeps its own plain search link.
      if (args.service === "youtube") {
        const url = args.query
          ? `https://www.youtube.com/results?search_query=${encodeURIComponent(args.query)}`
          : "https://www.youtube.com/";
        return {
          ok: true,
          deviceAction: { type: "open_url", url },
          speak: args.query ? `Opening YouTube for ${args.query}.` : "Opening YouTube.",
        };
      }

      const link = deeplinks.shop({
        provider: args.service,
        query: args.query,
        platform: ctx.platform,
      });
      if (!link) return { ok: false, error: `I can't open ${args.service}.` };

      return {
        ok: true,
        deviceAction: { type: "open_url", url: link.url },
        speak: deeplinks.speakFor({
          precision: link.precision,
          providerLabel: deeplinks.labelFor(args.service),
          what: args.query,
        }),
      };
    },
  });

  registry.register({
    name: "open_video_mode",
    description:
      "Switch to the face-to-face video avatar conversation. Use only when " +
      "the user asks for video/face mode — NOT for calling a contact.",
    risk: "medium",
    deviceAction: true,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return {
        ok: true,
        deviceAction: { type: "open_video" },
        speak: "Opening video mode.",
      };
    },
  });

  // ---------------- WEB SEARCH (interface defined, key required) ----------

  registry.register({
    name: "web_search",
    // Hidden when no search provider is configured.
    available: () => Boolean(require("./webSearch").provider()),
    description:
      "Search the live web. USE THIS BY DEFAULT for anything that could " +
      "have changed since training: prices, rates, fares, gold and fuel " +
      "rates, today's news, scores, opening hours, availability, who holds " +
      "a post, what a company just did, and anything about a named local " +
      "business or a real person (their official Instagram handle, their " +
      "clinic, their address). It is cheap and uncapped on this account — " +
      "never skip it to save quota, and never answer such a question from " +
      "memory instead. Weather and currency rates come from their own " +
      "dedicated sources through this same tool, so ask it for those too. " +
      "Then answer from the RESULTS: quote the figures, names and dates " +
      "they contain rather than your own impression of the subject.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
    async execute(args, ctx) {
      const search = require("./webSearch");
      // ctx carries the user's coordinates, so "what's the weather" with no
      // place named answers for where they actually are.
      return search.run(args.query, { lat: ctx.lat, lng: ctx.lng });
    },
  });

  /* ---------------------------------------------------------------- */
  /* THE DAY'S COMMITMENTS                                             */
  /*                                                                   */
  /* Not an "appointments" feature. A doctor's clinic list, a lawyer's  */
  /* hearings and anybody's dentist appointment are the same question,  */
  /* and the answer has to come from every place a commitment can be    */
  /* made — calendar, bookings, recalls, reminders — or the count at    */
  /* the top of the panel is simply wrong.                              */
  /* ---------------------------------------------------------------- */

  registry.register({
    name: "show_schedule",
    deviceAction: true,
    description:
      "Show the user's commitments for a day on their screen and say how " +
      "many there are. USE THIS for 'show me today's appointments', " +
      "'what meetings do I have', 'my schedule', 'who am I seeing " +
      "tomorrow', 'my hearings today', 'am I free this afternoon'. It " +
      "covers calendar meetings, bookings, client and patient recalls, and " +
      "time-bound reminders together. Do NOT read the whole list aloud — " +
      "the list is on screen; say the count and the next one or two.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        day: {
          type: "string",
          description:
            "Which day: 'today' (default), 'tomorrow' or 'yesterday'.",
          enum: ["today", "tomorrow", "yesterday"],
        },
      },
    },
    async execute(args, ctx) {
      const uid = Number(ctx.userId);
      if (!Number.isInteger(uid) || uid <= 0) {
        return { ok: false, error: "not signed in" };
      }
      const offsets = { today: 0, tomorrow: 1, yesterday: -1 };
      const dayOffset = offsets[String(args.day || "today").toLowerCase()] ?? 0;
      try {
        const out = await require("../services/schedule").forDay(uid, {
          dayOffset,
          tzOffsetMin: Number.isFinite(ctx.tzOffsetMin) ? ctx.tzOffsetMin : 330,
        });
        const when = out.label || "that day";
        const spoken = out.items.slice(0, 2)
          .map((i) => `${i.time} ${i.title}`)
          .join(", ");
        return {
          ok: true,
          deviceAction: {
            type: "show_schedule",
            day: when,
            total: out.total,
            items: out.items,
            failed: out.failed,
          },
          speak: out.total
            ? `${out.total} ${when}: ${spoken}`
            : `Nothing scheduled ${when}.`,
          note:
            (out.failed.length
              ? `COULD NOT REACH: ${out.failed.join(", ")}. Say the list may ` +
                "be incomplete because one source could not be read — do NOT " +
                "present this as a complete day. "
              : "") +
            "THE LIST IS ON THEIR SCREEN. Say how many there are and the " +
            "next one or two in your own words. Do NOT read every entry, " +
            "do NOT list times like a table, and do NOT ask which one they " +
            "want — they can see it.",
        };
      } catch (e) {
        return {
          ok: false,
          error: `schedule failed: ${String(e.message).slice(0, 160)}`,
          note:
            "Say you could not pull their schedule up just now — NOT that " +
            "they have nothing on. Never invent an appointment.",
        };
      }
    },
  });

  /* ---------------------------------------------------------------- */
  /* NEWS                                                              */
  /*                                                                   */
  /* Ten headlines read aloud takes over a minute and nobody remembers */
  /* the fourth. The list goes ON SCREEN, scrollable, while the voice  */
  /* covers only the top few — and tapping one opens that story for it */
  /* to actually read. The panel is the answer; the narration is the   */
  /* summary of the answer.                                            */
  /* ---------------------------------------------------------------- */

  registry.register({
    name: "show_news",
    deviceAction: true,
    available: () => Boolean(process.env.BRAVE_SEARCH_API_KEY),
    description:
      "Show today's headlines on the user's screen and read out the top " +
      "few. USE THIS whenever they ask for the news, headlines, what is " +
      "happening today, or news about a particular subject — do NOT use " +
      "web_search for that and do NOT read a long list aloud. Pass a topic " +
      "only if they named one ('sports news', 'news about the budget'); " +
      "leave it empty for general headlines. MATCH THE NUMBER THEY ASKED " +
      "FOR: 'five news' is count 5, 'the best news' or 'the top story' is " +
      "count 1 or 2, 'the latest news' or no number is 10. Ten every time " +
      "is wrong when they asked for fewer.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "Optional subject, only if the user named one. Empty for " +
            "general headlines.",
        },
        count: {
          type: "integer",
          description:
            "HOW MANY they asked for. 'five news' -> 5. 'the best news' " +
            "or 'the top story' -> 1 or 2. 'the latest news' or no number " +
            "-> 10. Never show ten when they asked for fewer.",
        },
        sort: {
          type: "string",
          enum: ["relevance", "recent"],
          description:
            "'recent' ONLY when they ask for the latest or newest. For " +
            "'top', 'best' or 'main' news use 'relevance' — the most " +
            "important story is rarely the one published most recently.",
        },
      },
    },
    async execute(args, ctx = {}) {
      const news = require("./news");
      try {
        // THE USER'S OWN WORDS WIN. A number they said out loud is not a
        // judgement call, so it is read straight from the utterance and
        // overrides whatever the model guessed. Falls back to the model's
        // count, then to ten.
        const said = news.countFromText(
          ctx.intent || (ctx.session && ctx.session.turn && ctx.session.turn.text) || ""
        );
        const asked = Number(args.count);
        const count =
          said ||
          (Number.isFinite(asked) && asked > 0 ? Math.min(asked, 10) : 10);
        const out = await news.headlines({
          topic: String(args.topic || "").trim(),
          count,
          sort: args.sort === "recent" ? "recent" : "relevance",
        });
        if (!out.items.length) {
          return {
            ok: false,
            error: "no_headlines",
            note:
              "Say you could not get the headlines just now — NOT that " +
              "there is no news — and offer to try again.",
          };
        }
        // Only the top three are spoken. The rest are on screen, which is
        // the whole point of the panel.
        const spoken = out.items.slice(0, 3)
          .map((x, i) => `${i + 1}. ${x.title}`)
          .join(" ");
        return {
          ok: true,
          deviceAction: { type: "show_news", topic: out.topic, items: out.items },
          speak: spoken,
          note:
            "THE HEADLINES ARE NOW ON THEIR SCREEN. Say in ONE short line " +
            "that today's headlines are up, then read out ONLY the top two " +
            "or three in your own words — or ALL of them when they asked " +
            "for just one or two. Do NOT list every item, do NOT read " +
            "URLs or source names, and do NOT ask which one they want — " +
            "they can see the list and will tap one. Tapping a headline " +
            "opens the full story for you to read, so there is nothing for " +
            "them to do first.",
        };
      } catch (e) {
        return {
          ok: false,
          error: `news failed: ${String(e.message).slice(0, 160)}`,
          note:
            "Say you could not fetch the headlines at the moment. Never " +
            "invent a headline or recite news from memory as if it were " +
            "today's.",
        };
      }
    },
  });

  /* ---------------------------------------------------------------- */
  /* INDIAN LAW                                                        */
  /*                                                                   */
  /* One source - Indian Kanoon - split into two tools, because a      */
  /* lawyer asks two questions and each wants a different slice of it. */
  /*                                                                   */
  /*   indian_law       doctypes:laws      Central Acts and Rules      */
  /*   indian_case_law  doctypes:judgments SC, High Courts, districts  */
  /*                                                                   */
  /* "What does section 302 say" must never reach the paid API, and    */
  /* "has the Supreme Court ruled on this" cannot be answered without  */
  /* it. The descriptions below are what makes the model choose right, */
  /* so they name the question type, not the vendor.                   */
  /* ---------------------------------------------------------------- */

  registry.register({
    name: "indian_law",
    // Dark without a token: saying judgments and Acts cannot be looked up
    // is survivable. A model inventing a section or a citation is not.
    available: () => require("./indianKanoon").available(),
    description:
      "Look up INDIAN STATUTE TEXT — Central Acts and Rules — by citation " +
      "or keyword: the Constitution, IPC, BNS, BNSS, BSA, the Negotiable " +
      "Instruments Act (cheque bounce, s.138), Companies Act, Contract " +
      "Act, CPC, CrPC, GST and the rest. USE THIS, NOT web_search, for " +
      "'what does section 302 say', 'article 21', 'section 138 NI Act', " +
      "'the provision on anticipatory bail'. It returns the Act's own " +
      "wording. For JUDGMENTS and precedent use indian_case_law instead.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The provision as the user referred to it — 'IPC 302', " +
            "'article 21', 'section 138 Negotiable Instruments Act'. " +
            "Do not pre-parse it.",
        },
      },
      required: ["query"],
    },
    timeoutMs: 45_000,
    async execute(args) {
      const ik = require("./indianKanoon");
      const q = String(args.query || "").trim();
      if (!q) return { ok: false, error: "empty query" };
      try {
        // doctypes:laws confines the search to Central Acts and Rules, so
        // "section 302" returns the PROVISION rather than the ten thousand
        // judgments that happen to cite it. statuteQuery then turns what
        // the user actually said into what this index wants — measured on
        // the live API, "can you tell me what section 420 says" returned
        // the Police Regulations, Bengal, 1943 until it did.
        const prepared = ik.statuteQuery(q);
        const out = await ik.research(prepared, { doctypes: "laws", depth: 2 });
        if (!out.docs.length) {
          return {
            ok: false,
            error: "not_found",
            data: {
              hint:
                "The search ran and returned no Act for those terms. Say you " +
                "could not find that provision and ask which Act they mean — " +
                "do NOT quote a section from memory, and do NOT invent one.",
            },
          };
        }
        return {
          ok: true,
          provider: "indiankanoon",
          data: out,
          speak: out.docs
            .slice(0, 3)
            .map((d) => {
              const body = (d.passages && d.passages.length
                ? d.passages.join(" … ")
                : d.snippet || ""
              ).slice(0, 600);
              return `${d.title}\n   ${body}`;
            })
            .join("\n"),
          note:
            "Quote the provision and name the Act and section — that is " +
            "what a lawyer needs. Never paraphrase wording the passages do " +
            "not contain, and never invent a section number. Do NOT add a " +
            "disclaimer about this not being legal advice; they know.",
        };
      } catch (e) {
        const m = String(e.message || "");
        return {
          ok: false,
          error: `law lookup failed: ${m.slice(0, 160)}`,
          note:
            /balance|rate limit|auth|not_configured/i.test(m)
              ? "The legal database is unavailable right now (credit or " +
                "credentials). Say you could not look the provision up at " +
                "the moment — NOT that it does not exist — and offer to retry."
              : "SAY YOU COULD NOT LOOK IT UP, not that the law does not " +
                "exist. Never quote a section from memory to fill the gap.",
        };
      }
    },
  });

  registry.register({
    name: "indian_case_law",
    // Dark without a token: better to say judgments cannot be searched
    // than to let the model invent one, which is the worst thing a legal
    // assistant can do.
    available: () => require("./indianKanoon").available(),
    description:
      "Search INDIAN JUDGMENTS AND CASE LAW — Supreme Court, High Courts " +
      "and tribunals — on Indian Kanoon. Use for 'is there a judgment " +
      "on...', 'what has the Supreme Court said about...', 'find me case " +
      "law on...', 'precedent for...', or when the user names a case. " +
      "Returns the court, the date and the passage of each judgment that " +
      "matches. For the WORDING OF A STATUTE use indian_law instead — it " +
      "is free and exact; this is billed per search.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to search for, in legal terms — 'anticipatory bail " +
            "498A', 'cheque dishonour section 138 limitation'.",
        },
      },
      required: ["query"],
    },
    timeoutMs: 45_000,
    async execute(args) {
      const ik = require("./indianKanoon");
      const q = String(args.query || "").trim();
      if (!q) return { ok: false, error: "empty query" };
      try {
        // Filler stripped, but NOT pinned to the title: a judgment is
        // titled by its parties, so title: would exclude every case that
        // discusses the point without naming it.
        const out = await ik.research(ik.stripFiller(q), { doctypes: "judgments" });
        if (!out.docs.length) {
          return {
            ok: false,
            error: "no_judgments_found",
            data: {
              hint:
                "The search ran and genuinely returned nothing. Say no " +
                "reported judgment came up for those terms and offer to try " +
                "different wording — do NOT invent a case, a citation or a " +
                "judge's name.",
            },
          };
        }
        return {
          ok: true,
          provider: "indiankanoon",
          data: out,
          speak: out.docs
            .slice(0, 4)
            .map((d) => {
              const head =
                `${d.title}${d.court ? ` (${d.court}` : ""}` +
                `${d.date ? `, ${String(d.date).slice(0, 10)}` : ""}${d.court ? ")" : ""}`;
              const body = (d.passages && d.passages.length
                ? d.passages.join(" … ")
                : d.snippet || ""
              ).slice(0, 500);
              return `${head}\n   ${body}`;
            })
            .join("\n"),
          note:
            "These are REAL judgments. Name the case and the court when you " +
            "answer, and never state a holding the passages do not support. " +
            "If the passages are thin, say what was found and offer to open " +
            "the judgment rather than filling the gap from memory. Do not " +
            "add a legal-advice disclaimer.",
        };
      } catch (e) {
        const m = String(e.message || "");
        return {
          ok: false,
          error: `case law search failed: ${m.slice(0, 160)}`,
          note:
            /balance|rate limit|auth/i.test(m)
              ? "The case-law service is unavailable right now (credit or " +
                "credentials). Say you could not search the judgments at the " +
                "moment — NOT that no such case exists — and offer to retry."
              : "Say you could not search case law just now. Never invent a " +
                "judgment or a citation to fill the gap.",
        };
      }
    },
  });
  /* ---------------------------------------------------------------- */
  /* CALENDAR                                                          */
  /*                                                                   */
  /* Creating an event used to be a REGEX INTENT wired into the SSE    */
  /* path alone, so the app's main screen — live mode — could not put  */
  /* anything in the diary at all. Nothing could change or cancel an   */
  /* event, and "what's on today" read the reminders table and never   */
  /* the calendar, so a meeting the user could see in Google was       */
  /* invisible to the assistant that was supposed to know their day.   */
  /*                                                                   */
  /* Editing and cancelling resolve the event FIRST and refuse when    */
  /* more than one matches — the same discipline update_reminder uses. */
  /* Guessing which meeting to delete is not a recoverable mistake.    */
  /* ---------------------------------------------------------------- */

  const googleLinked = async (userId) => {
    try {
      return Boolean(await require("../google/tokens").accessToken(userId));
    } catch (_) {
      return false;
    }
  };
  const NOT_LINKED = {
    ok: false,
    error: "google_not_linked",
    data: {
      hint:
        "Their Google account is not connected, so the calendar cannot be " +
        "reached. Say that plainly and offer to set it up in Settings — do " +
        "NOT invent what is on their calendar.",
    },
  };

  /** Match an upcoming event by what the user called it. */
  async function findEvent(userId, { title, day }) {
    const gapi = require("../google/api");
    const events = (await gapi.upcomingEvents(userId, { days: 30, max: 50 })) || [];
    const q = String(title || "").trim().toLowerCase();
    let pool = events;
    if (day) {
      const d = String(day).slice(0, 10);
      pool = pool.filter((e) => String(e.start || "").slice(0, 10) === d);
    }
    if (q) {
      const exact = pool.filter((e) => e.title.toLowerCase() === q);
      pool = exact.length ? exact : pool.filter((e) => e.title.toLowerCase().includes(q));
    }
    return pool;
  }

  registry.register({
    name: "list_calendar_events",
    // DECLARED, not discovered. Each of these four used to re-check
    // googleLinked() by hand and return the same NOT_LINKED constant, so
    // the model learned the account was unlinked only by calling the tool
    // and failing. Declaring it means the tool is not offered at all when
    // it cannot work, and limitsBlock() can say why.
    requires: [{ kind: "auth" }, { kind: "integration", id: "google_oauth" }],
    description:
      "The user's actual CALENDAR — meetings and appointments from Google. " +
      "list_reminders covers what they asked to be reminded of; this covers " +
      "what is booked. For 'what does my day look like', 'am I free at 4', " +
      "'what's my schedule tomorrow', check BOTH.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", description: "How many days ahead to look (default 7)." },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      if (!(await googleLinked(ctx.userId))) return NOT_LINKED;
      const gapi = require("../google/api");
      const days = Math.min(Math.max(Number(args.days) || 7, 1), 60);
      const events = await gapi.upcomingEvents(ctx.userId, { days, max: 25 });
      if (events === null) return NOT_LINKED;
      return {
        ok: true,
        data: { events, days },
        speak: events.length ? "" : "Nothing on the calendar for that stretch.",
        note: "Answer ONLY from these entries. An empty list means nothing is booked.",
      };
    },
  });

  registry.register({
    name: "create_calendar_event",
    // DECLARED, not discovered. Each of these four used to re-check
    // googleLinked() by hand and return the same NOT_LINKED constant, so
    // the model learned the account was unlinked only by calling the tool
    // and failing. Declaring it means the tool is not offered at all when
    // it cannot work, and limitsBlock() can say why.
    requires: [{ kind: "auth" }, { kind: "integration", id: "google_oauth" }],
    description:
      "Put a meeting or appointment in the user's Google Calendar. Use for " +
      "'book', 'schedule', 'put in my diary', 'add a meeting'. For something " +
      "they just want to be reminded about, use create_reminder instead.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What the event is called." },
        start: { type: "string", description: "Start, ISO 8601 with the user's offset, e.g. 2026-09-12T16:00:00+05:30." },
        end: { type: "string", description: "End, same format. Defaults to an hour after the start." },
        location: { type: "string" },
        description: { type: "string" },
      },
      required: ["title", "start"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      if (!(await googleLinked(ctx.userId))) return NOT_LINKED;
      const startMs = Date.parse(args.start);
      if (!Number.isFinite(startMs)) {
        return { ok: false, error: "I could not read that start time" };
      }
      const endMs = Date.parse(args.end);
      const gapi = require("../google/api");
      let ev;
      try {
        ev = await gapi.createEvent(ctx.userId, {
          title: args.title,
          startMs,
          endMs: Number.isFinite(endMs) ? endMs : startMs + 36e5,
          location: args.location,
          description: args.description,
        });
      } catch (e) {
        return { ok: false, error: String(e.message).slice(0, 160) };
      }
      if (!ev) return NOT_LINKED;
      return { ok: true, data: { event: ev, title: args.title, start: args.start } };
    },
  });

  registry.register({
    name: "update_calendar_event",
    // DECLARED, not discovered. Each of these four used to re-check
    // googleLinked() by hand and return the same NOT_LINKED constant, so
    // the model learned the account was unlinked only by calling the tool
    // and failing. Declaring it means the tool is not offered at all when
    // it cannot work, and limitsBlock() can say why.
    requires: [{ kind: "auth" }, { kind: "integration", id: "google_oauth" }],
    description:
      "Move or change an existing calendar event — 'push the 4 o'clock to 5', " +
      "'rename tomorrow's meeting', 'change where it is'. Identify it by what " +
      "the user calls it; if more than one matches you will be told, and you " +
      "must ask which one rather than picking.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What the event is called, or part of it." },
        day: { type: "string", description: "The event's date as YYYY-MM-DD, to narrow it down." },
        new_title: { type: "string" },
        new_start: { type: "string", description: "New start, ISO 8601 with offset." },
        new_end: { type: "string", description: "New end, ISO 8601 with offset." },
        new_location: { type: "string" },
      },
      required: ["title"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      if (!(await googleLinked(ctx.userId))) return NOT_LINKED;
      const matches = await findEvent(ctx.userId, { title: args.title, day: args.day });
      if (!matches.length) {
        return {
          ok: false,
          error: "no_such_event",
          data: { hint: "Nothing upcoming matches that. Say so; do not invent an event." },
        };
      }
      if (matches.length > 1) {
        return {
          ok: false,
          error: "ambiguous_event",
          data: {
            matches: matches.slice(0, 5),
            hint: "ASK which one. Do NOT change any of them until they say.",
          },
        };
      }
      const ev = matches[0];
      const patch = {};
      if (args.new_title) patch.summary = String(args.new_title).slice(0, 200);
      if (args.new_location) patch.location = String(args.new_location).slice(0, 200);
      const s2 = Date.parse(args.new_start);
      const e2 = Date.parse(args.new_end);
      if (Number.isFinite(s2)) patch.start = { dateTime: new Date(s2).toISOString() };
      if (Number.isFinite(e2)) patch.end = { dateTime: new Date(e2).toISOString() };
      else if (Number.isFinite(s2)) {
        // Moving the start alone would otherwise leave the old end behind
        // and produce a meeting that ends before it begins.
        const oldLen = ev.end && ev.start
          ? Math.max(Date.parse(ev.end) - Date.parse(ev.start), 0) : 36e5;
        patch.end = { dateTime: new Date(s2 + (oldLen || 36e5)).toISOString() };
      }
      if (!Object.keys(patch).length) {
        return { ok: false, error: "nothing to change — say what should be different" };
      }
      try {
        await require("../google/api").updateEvent(ctx.userId, ev.id, patch);
      } catch (e) {
        return { ok: false, error: String(e.message).slice(0, 160) };
      }
      return { ok: true, data: { was: ev, changed: patch } };
    },
  });

  registry.register({
    name: "delete_calendar_event",
    // DECLARED, not discovered. Each of these four used to re-check
    // googleLinked() by hand and return the same NOT_LINKED constant, so
    // the model learned the account was unlinked only by calling the tool
    // and failing. Declaring it means the tool is not offered at all when
    // it cannot work, and limitsBlock() can say why.
    requires: [{ kind: "auth" }, { kind: "integration", id: "google_oauth" }],
    description:
      "Cancel an event in the user's calendar — 'cancel tomorrow's dentist', " +
      "'drop the 3pm'. Identify it by what they call it. If more than one " +
      "matches you must ask which, never guess: cancelling the wrong meeting " +
      "cannot be undone from here.",
    risk: "high",
    confirmSummary: (a) => `Cancel "${a.title}"${a.day ? ` on ${a.day}` : ""}?`,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What the event is called, or part of it." },
        day: { type: "string", description: "The event's date as YYYY-MM-DD, to narrow it down." },
      },
      required: ["title"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      if (!(await googleLinked(ctx.userId))) return NOT_LINKED;
      const matches = await findEvent(ctx.userId, { title: args.title, day: args.day });
      if (!matches.length) {
        return {
          ok: false,
          error: "no_such_event",
          data: { hint: "Nothing upcoming matches that. Say so; do not invent an event." },
        };
      }
      if (matches.length > 1) {
        return {
          ok: false,
          error: "ambiguous_event",
          data: {
            matches: matches.slice(0, 5),
            hint: "ASK which one. Nothing has been cancelled.",
          },
        };
      }
      const ev = matches[0];
      try {
        await require("../google/api").deleteEvent(ctx.userId, ev.id);
      } catch (e) {
        return { ok: false, error: String(e.message).slice(0, 160) };
      }
      return { ok: true, data: { cancelled: ev }, speak: `Cancelled ${ev.title}.` };
    },
  });

  registry.register({
    name: "deep_research",
    // Pointless without a search provider — hide it rather than promise it.
    available: () => Boolean(require("./webSearch").provider()),
    description:
      "Research a question properly: several searches from different angles, " +
      "then a written brief with its sources, saved to the user's documents. " +
      "Use for 'research X', 'find out everything about Y', 'compare A and B' " +
      "— questions where one search result is not an answer. It takes about a " +
      "minute and finishes AFTER this conversation: tell the user it is being " +
      "worked on and that you will let them know, then move on. Never wait " +
      "for it and never describe findings you have not been given.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The research question, in full." },
      },
      required: ["question"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const question = String(args.question || "").trim();
      if (question.length < 8) {
        return { ok: false, error: "that is too short to research — what exactly should I look into?" };
      }
      try {
        await require("../infra/jobs").enqueue(
          "deep_research", { userId: ctx.userId, question }, { userId: ctx.userId }
        );
      } catch (e) {
        return { ok: false, error: `could not start the research: ${String(e.message).slice(0, 120)}` };
      }
      return {
        ok: true,
        data: { question, status: "started" },
        speak: "",
        note:
          "STARTED, not finished. Tell the user you are researching it and " +
          "will put a brief in their documents in a minute or so. Do NOT " +
          "state any findings — you have none yet.",
      };
    },
  });

  registry.register({
    name: "look_at_screenshot",
    requiresPermission: "camera",
    minAppBuild: 26,
    description:
      "Look at a SCREENSHOT or photo already on the user's phone and answer " +
      "about it. Use when they say 'look at this screenshot', 'what does " +
      "this say', 'read this for me', 'what do I do about this' and the " +
      "thing is a picture they already have — an error message, a bill, a " +
      "form, a message thread, a poster. They pick it from their gallery. " +
      "For something in front of them RIGHT NOW use analyze_camera instead. " +
      "You cannot see their live screen; never claim you can.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "What to find out about it, in the user's own words. Leave empty " +
            "to just read and explain what it shows.",
        },
      },
    },
    async execute(args) {
      return {
        ok: true,
        deviceAction: {
          type: "ask_about_image",
          source: "gallery",
          question: String(args.question || "").slice(0, 400),
        },
        speak: "",
        note:
          "The gallery is opening for them to pick the picture. NOTHING has " +
          "been read yet — the answer arrives as a [SYSTEM] line once they " +
          "choose. Say you are ready to look, then WAIT. Do not describe an " +
          "image you have not been given.",
      };
    },
  });

  registry.register({
    name: "read_webpage",
    description:
      "Read the actual TEXT of a web page so you can summarise it, answer a " +
      "question about it, pull a figure out of it, or translate it. Use this " +
      "whenever the user asks what a page or article SAYS — 'summarise this', " +
      "'what does this article say', 'what's the price on that page'. " +
      "web_search gives you titles and snippets; this gives you the page. " +
      "open_webpage only puts it on their screen and tells you nothing.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full http(s) URL of the page to read." },
      },
      required: ["url"],
    },
    async execute(args) {
      const url = String(args.url || "").trim();
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, error: "need a full http(s) URL" };
      }
      let html, mime;
      try {
        const r = await fetch(url, {
          redirect: "follow",
          headers: {
            "user-agent": "Mozilla/5.0 (Android) MyAssistant/1.0",
            accept: "text/html,application/xhtml+xml",
          },
          signal: AbortSignal.timeout(20000),
        });
        if (!r.ok) return { ok: false, error: `the site returned ${r.status}` };
        mime = String(r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (mime && !/^text\/(html|plain)$|xhtml/.test(mime)) {
          return {
            ok: false,
            error: `that link is a ${mime} file, not a readable page`,
            data: {
              hint: mime === "application/pdf"
                ? "offer save_web_document to keep the PDF instead"
                : "say plainly that it is not a page you can read",
            },
          };
        }
        // Cap the DOWNLOAD, not just the extract: a 50 MB page must not
        // be pulled into memory to produce 8 kB of text.
        const reader = r.body.getReader();
        const chunks = [];
        let size = 0;
        while (size < 3 * 1024 * 1024) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          size += value.length;
        }
        try { await reader.cancel(); } catch (_) {}
        html = Buffer.concat(chunks.map(Buffer.from)).toString("utf8");
      } catch (e) {
        return { ok: false, error: `could not read it: ${String(e.message).slice(0, 120)}` };
      }

      const text = extractReadableText(html);
      if (text.length < 40) {
        return {
          ok: false,
          error: "that page had almost no readable text",
          data: {
            hint:
              "It is probably rendered by JavaScript or behind a login. Say so " +
              "plainly and offer to open it on their screen instead — do NOT " +
              "summarise it from the title or from memory.",
          },
        };
      }
      const title = (/<title[^>]*>([\s\S]{1,300}?)<\/title>/i.exec(html) || [])[1];
      return {
        ok: true,
        data: {
          url,
          title: decodeEntities(String(title || "").trim()).slice(0, 200),
          text: text.slice(0, 8000),
          truncated: text.length > 8000,
        },
        speak: "",
        note:
          "This is the page's real text. Answer from IT, not from what you " +
          "already believed about the page. If it does not contain the answer, " +
          "say that rather than filling the gap.",
      };
    },
  });

  registry.register({
    name: "get_horoscope",
    description: "Get daily astrological horoscope predictions for a given zodiac sign using an external astrology API.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        sign: { type: "string", description: "Zodiac sign (e.g. aries, taurus, gemini...)" },
        day: { type: "string", description: "today, tomorrow, or yesterday (default: today)" }
      },
      required: ["sign"]
    },
    async execute(args) {
      try {
        const sign = String(args.sign).toLowerCase();
        const day = args.day ? String(args.day).toLowerCase() : "today";
        const url = `https://horoscope-app-api.vercel.app/api/v1/get-horoscope/daily?sign=${sign}&day=${day}`;
        const res = await fetch(url);
        if (!res.ok) return { ok: false, error: "Astrology API request failed" };
        const data = await res.json();
        return { ok: true, data: data.data };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  });
  registry.register({
    name: "send_agent_message",
    description:
      "THE DEFAULT way to send a message to a person — 'send a message to " +
      "X', 'tell X that…', 'let X know…', 'inform X…', 'tell X's agent…', " +
      "'inform X's agent that…'. Delivers through the recipient's OWN " +
      "assistant: they get a push notification and their assistant speaks " +
      "it aloud, naming the sender. Call this IMMEDIATELY — never ask the " +
      "user to choose a channel first. DELIVERY LADDER, automatic: if the " +
      "recipient uses this app the message goes through their assistant; " +
      "if not, the phone sends it as a normal SMS text by itself — either " +
      "way nothing needs a tap. Use send_whatsapp_message ONLY when the " +
      "user explicitly says WhatsApp.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        contact_name: { type: "string", description: "Who to send it to (e.g. mom, wife)" },
        message: { type: "string", description: "The message to deliver" }
      },
      required: ["contact_name", "message"]
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      
      // db exports run/one/query — `exec` does not exist, and calling it
      // threw exactly on the success path (recipient IS an app user).
      const { run, one } = require("../db");
      const push = require("../services/push");
      // "Inform Hemalatha's agent" names the PERSON, not a contact called
      // "Hemalatha's agent" — strip the agent suffix before resolving.
      const contactLower = String(args.contact_name)
        .toLowerCase()
        .replace(/['’]?s?\s+(agent|assistant)\s*$/i, "")
        .trim();

      // 1. Resolve the name to a number — through the SHARED resolver,
      // which ranks exact > whole-name nickname ("Ammmmaaa" for amma) >
      // prefix > substring. The old inline LIKE query here picked the
      // SHORTEST substring hit, which sent "message amma" to "Dammayathi".
      const { resolveContact } = require("../users/resolve");
      const { query } = require("../db");
      const { match, candidates } = await resolveContact(
        ctx.userId,
        contactLower
      );

      let contactPhone = match?.phone || null;
      if (!contactPhone && candidates.length) {
        // Ambiguous by name — but THIS tool can only deliver to registered
        // app users. If exactly one candidate is registered, they are the
        // only possible recipient; more than one means genuinely ask.
        const phones = candidates
          .map((c) => normalizePhone(c.phone))
          .filter(Boolean);
        const regd = await query(
          `SELECT phone_number FROM users
            WHERE phone_number = ANY($1) AND phone_verified_at IS NOT NULL`,
          [phones]
        ).catch(() => []);
        if (regd.length === 1) contactPhone = regd[0].phone_number;
        else if (regd.length > 1) {
          const names = candidates.map((c) => c.name).slice(0, 4).join(", ");
          return {
            ok: false,
            data: `Ambiguous contact: ${names}`,
            speak: `I found more than one match — ${names}. Who should get it?`,
          };
        }
      }
      if (!contactPhone) {
        // Not in the address book — but the recipient may simply BE a
        // registered user whose name the user spoke ("Hemalatha"), saved
        // in contacts under something else entirely ("Ammmmaaa"). A single
        // unambiguous verified-user name match is safe to deliver to.
        const users = await query(
          `SELECT phone_number FROM users
            WHERE phone_verified_at IS NOT NULL AND phone_number IS NOT NULL
              AND (lower(name) = $1 OR lower(name) LIKE $1 || ' %')`,
          [contactLower]
        ).catch(() => []);
        if (users.length === 1) contactPhone = users[0].phone_number;
      }
      if (!contactPhone) {
        return {
          ok: false,
          data: "Contact not found in address book.",
          speak: `I couldn't find a phone number for ${args.contact_name} in your synced contacts.`
        };
      }

      // 2. Check if that phone number belongs to a registered user of the app.
      //
      // Normalise first. This is an exact-string match, and the same person
      // is "+91 98765 43210" in one address book and "9876543210" in
      // another. Comparing raw text made real registered users look absent,
      // and the failure was silent — the assistant simply said they were
      // not on the app. Both sides go through E.164 so they meet.
      //
      // Only a VERIFIED number counts: phone_verified_at NULL means nobody
      // proved they own it, so delivering there could hand this message to
      // whoever typed it.
      const toPhone = normalizePhone(contactPhone);
      const appUser = toPhone
        ? await one(
            `SELECT id, fcm_token FROM users
              WHERE phone_number = $1 AND phone_verified_at IS NOT NULL
              LIMIT 1`,
            [toPhone]
          )
        : null;

      if (!appUser) {
        // CAPABILITY GATE. Automatic SMS shipped in app build 13; an older
        // install silently drops the send_sms action — and the assistant
        // would have already claimed it was sending. Never promise what
        // THIS install cannot do.
        if (!(Number(ctx.appBuild) >= 13)) {
          return {
            ok: true,
            data: "Recipient not on app; this app build cannot auto-send SMS.",
            speak:
              `${args.contact_name} isn't on the app, and this version of the ` +
              `app can't send texts by itself yet — update the app when the ` +
              `popup offers it. Meanwhile I can set up a WhatsApp message for ` +
              `you to tap send on.`,
          };
        }
        // PERMISSION, CHECKED BEFORE PROMISING. A tester was told "Alan
        // isn't on the app, so I'm sending it to them as a text message
        // instead" — and the next turn had to admit SMS permission was
        // never granted. The phone now reports what it can do, so the rung
        // that cannot run is skipped instead of announced.
        const caps = ctx.deviceCaps;
        if (caps && Array.isArray(caps.denied) && caps.denied.includes("sms") &&
            !(Array.isArray(caps.granted) && caps.granted.includes("sms"))) {
          return {
            ok: false,
            error: "sms_permission_denied",
            data: {
              recipient: args.contact_name,
              hint:
                "SMS permission is OFF on this phone, so the text CANNOT be " +
                "sent and you must not say it was. Tell them the permission " +
                "is off, offer to open Settings, and offer a WhatsApp message " +
                "they tap send on as the alternative.",
            },
          };
        }
        // Not on the app → the phone sends a REAL SMS by itself (the app
        // holds the SEND_SMS permission; the user granted it once). Still
        // zero taps for the user — and the phone reports the true result
        // to /outcomes, so "did it go?" has an honest answer.
        return {
          ok: true,
          data: { channel: "sms", to: contactPhone, name: args.contact_name },
          deviceAction: {
            type: "send_sms",
            to: contactPhone,
            name: args.contact_name,
            message: args.message,
          },
          speak:
            `${args.contact_name} isn't on the app, so I'm sending it to them ` +
            `as a text message instead.`,
        };
      }

      // 3. User is on the app! Save to queue and push notify
      // Store the NORMALISED number: the recipient's session looks its own
      // inbox up by the same E.164 value, so anything else never arrives.
      await run(
        `INSERT INTO agent_messages (from_user_id, to_phone_number, message, created_at) VALUES ($1, $2, $3, $4)`,
        [ctx.userId, toPhone, args.message, Date.now()]
      );

      // A nudge, not the message itself. The words are spoken by their own
      // assistant when they open the app; putting them in the banner would
      // also put them on a lock screen anyone can read.
      if (appUser.fcm_token) {
        await push.sendNotification(
          appUser.fcm_token,
          ctx.userName ? `${ctx.userName} sent you a message` : "You have a new message",
          "Open the app and your assistant will read it to you.",
          // Lets the recipient's app react: fetch the inbox and have their
          // assistant SPEAK the message the moment the app is open/opened.
          { kind: "agent_message" }
        );
      } else {
        // Not an error: they simply have no device registered yet, so the
        // message waits in their inbox until they next open the app.
        console.log(`agent_message: no push token for user ${appUser.id} — will deliver on next open`);
      }

      // The recipient's own assistant may be able to acknowledge this
      // immediately (scheduling questions answered from their calendar,
      // privacy-preserving). Fire-and-forget: delivery above already
      // happened, and this must never slow the sender's turn. Runs only
      // for human-initiated sends (this tool), so an automatic reply can
      // never trigger another automatic reply.
      require("../agents/inbound")
        .onMessageDelivered({
          toUserId: appUser.id,
          fromUserId: ctx.userId,
          fromName: ctx.userName,
          text: args.message,
        })
        .catch((e) => console.warn("inbound hook:", e.message));

      // ONE RECORD, NOT TWO STORIES. This path wrote nothing to
      // task_outcomes, so the two stores the assistant consults about a
      // send disagreed: check_recent_actions saw send_agent_message ok=1
      // and said it went, check_task_outcomes saw nothing and said there
      // was no record. A tester got three contradictory answers about one
      // message in four turns — "yes, sent directly to Allen's assistant",
      // then "I can't actually send messages to Allen's assistant", then
      // "my mistake, it looks like the message went through after all".
      //
      // The SMS rung has always produced an outcome row, because the phone
      // posts one. The successful rung produced none.
      const delivered = Boolean(appUser.fcm_token);
      require("../outcomes/store")
        .create(ctx.userId, {
          kind: "message",
          target: args.contact_name,
          status: "completed",
          path: "agent",
          // Phrased to CONTINUE "the message to X was delivered …" — see
          // outcomes/store.describe.
          detail: delivered
            ? "through their assistant, with a notification"
            : "into their inbox, but they have no device registered yet, so they will hear it when they next open the app",
        })
        .catch((e) => console.warn("message outcome write failed:", e.message));

      return {
        ok: true,
        data: { channel: "agent", delivered, to: args.contact_name },
        speak: delivered
          ? `I have sent the message directly to ${args.contact_name}'s assistant.`
          : `It is in ${args.contact_name}'s inbox — their assistant will read ` +
            `it out when they next open the app. They have no device registered ` +
            `for a notification yet.`,
      };
    }
  });

  registry.register({
    name: "send_document",
    description:
      "Send one of the USER'S OWN saved documents to another person who " +
      "uses this app — 'send my driving license to Allen', 'send Chetan's " +
      "receipt to Allen'. Call this DIRECTLY — never find_document or " +
      "list_person_documents first, which would pop the file on screen " +
      "mid-send; when the document belongs to a person's case file, pass " +
      "`person`. The document is copied into the recipient's documents and " +
      "their assistant tells them it arrived. Works only for registered " +
      "app users; for anyone else, tell the user to open the document and " +
      "use its Send button (WhatsApp, email…).",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        contact_name: { type: "string", description: "Who should receive it" },
        document: { type: "string", description: "Which document, e.g. 'driving license', 'receipt'" },
        person: {
          type: "string",
          description:
            "Whose case file the document is in, when the user said one — 'send CHETAN'S receipt'",
        },
        note: { type: "string", description: "Optional short message to send along" },
      },
      required: ["contact_name", "document"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const { one, query } = require("../db");
      const fs = require("fs");

      // 1. Which document? A person scope ("CHETAN'S receipt") resolves
      // through their case file; otherwise full-library text search. Only
      // a confident match may be sent — the recency fallback is fine for
      // showing, but silently mailing a guessed document to another
      // person is not.
      let docId = null;
      if (args.person) {
        const intel = require("../docs/intelligence");
        const r = await intel.findDocuments(ctx.userId, args.document, {
          person: args.person,
        });
        if (r.found && r.documents.length === 1) {
          docId = r.documents[0].id;
        } else if (r.found && r.documents.length > 1) {
          const titles = r.documents.map((x) => x.title).slice(0, 4).join("; ");
          return {
            ok: false,
            error: `${args.person} has several matches — ${titles}. Ask which one to send.`,
          };
        } else {
          return {
            ok: false,
            error: `no document matching "${args.document}" in ${args.person}'s file`,
          };
        }
      } else {
        const found = await docs.searchDocuments(ctx.userId, args.document);
        const hit = found && found.exact && found.hits && found.hits[0];
        if (!hit) {
          const recent = ((found && found.hits) || [])
            .map((x) => x.title || x.filename)
            .filter(Boolean)
            .slice(0, 3)
            .join("; ");
          return {
            ok: false,
            error:
              `no saved document clearly matching "${args.document}"` +
              (recent ? ` — recent saves: ${recent}. Ask which one to send.` : ""),
          };
        }
        docId = hit.id;
      }
      const d = await one(
        `SELECT * FROM documents WHERE user_id=$1 AND id=$2`,
        [ctx.userId, docId]
      );
      if (!d || !d.path || !fs.existsSync(d.path)) {
        return { ok: false, error: "that document's file is missing on the server" };
      }
      const docName = d.title || d.filename || "document";

      // 2. The recipient must be a REGISTERED user — same resolution rules
      // as send_agent_message, condensed: address book first, then a
      // single unambiguous registered-user name match.
      const contactLower = String(args.contact_name).trim().toLowerCase();
      const { resolveContact } = require("../users/resolve");
      const { match, candidates } = await resolveContact(ctx.userId, args.contact_name);
      let phone = normalizePhone(match?.phone || "");
      if (!phone && candidates?.length) {
        const phones = candidates.map((c) => normalizePhone(c.phone)).filter(Boolean);
        const regd = await query(
          `SELECT phone_number FROM users
            WHERE phone_number = ANY($1) AND phone_verified_at IS NOT NULL`,
          [phones]
        ).catch(() => []);
        if (regd.length === 1) phone = regd[0].phone_number;
      }
      let appUser = phone
        ? await one(
            `SELECT id, name, fcm_token FROM users
              WHERE phone_number=$1 AND phone_verified_at IS NOT NULL LIMIT 1`,
            [phone]
          )
        : null;
      if (!appUser) {
        const users = await query(
          `SELECT id, name, fcm_token, phone_number FROM users
            WHERE phone_verified_at IS NOT NULL AND phone_number IS NOT NULL
              AND (lower(name) = $1 OR lower(name) LIKE $1 || ' %')`,
          [contactLower]
        ).catch(() => []);
        if (users.length === 1) {
          appUser = users[0];
          phone = users[0].phone_number;
        }
      }
      if (!appUser) {
        return {
          ok: false,
          error: `${args.contact_name} is not a registered app user`,
          speak:
            `${args.contact_name} isn't on the app, so I can't deliver it ` +
            `directly — open the document and use its Send button to share ` +
            `it on WhatsApp instead.`,
        };
      }

      // 3. COPY into the recipient's library — their own row and file, so
      // the sender later deleting theirs never breaks the received copy.
      // Metadata rides along; the copy is instantly searchable, no re-OCR.
      const buffer = fs.readFileSync(d.path);
      const copy = await docs.createDocument(appUser.id, {
        buffer,
        filename: d.filename,
        mime: d.mime,
        note: `sent by ${ctx.userName || "a contact"}`,
      });
      await docs.setMetadata(appUser.id, copy.id, {
        title: d.title,
        category: d.category,
        docDate: d.doc_date,
        summary: d.summary,
        tags: d.tags,
        fullText: d.full_text,
      });

      // 4. Announce through the normal agent-message channel: push nudge
      // now, spoken delivery when they next talk to their assistant, and
      // "show the document X sent" works because the copy is THEIRS.
      const text =
        (args.note ? `${String(args.note).slice(0, 300)} — ` : "") +
        `I've sent you a document: "${docName}". Ask your assistant to show it.`;
      await query(
        `INSERT INTO agent_messages
           (from_user_id, to_phone_number, message, document_id, from_document_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [ctx.userId, phone, text, copy.id, d.id, Date.now()]
      );
      // A nudge, not the content — same contract as send_agent_message:
      // the recipient's own assistant speaks it when they open the app.
      if (appUser.fcm_token) {
        try {
          await require("../services/push").sendNotification(
            appUser.fcm_token,
            ctx.userName
              ? `${ctx.userName} sent you a document`
              : "You received a document",
            "Open the app and your assistant will show it to you.",
            { kind: "agent_message" }
          );
        } catch (e) {
          console.error("send_document push:", e.message);
        }
      }

      return {
        ok: true,
        data: { sent: docName, to: appUser.name },
        speak: `Sent — ${appUser.name} now has your ${docName} and will be told it arrived.`,
      };
    },
  });

  // ---------------- FULFILLMENT: BOOKING BY REAL PHONE CALL ----------------
  //
  // This tool used to be a mock: it slept three seconds and told the user
  // "I spoke to their receptionist and your appointment is confirmed" —
  // without dialling anything. That is the exact failure §28 exists to
  // prevent, and the user would have discovered it by turning up at a
  // clinic that had never heard of them.
  //
  // It now uses the real agent-call engine (src/agents/agentCall.js,
  // Bolna/Retell), pointed at a business number resolved from Google
  // Places. Hari genuinely dials, genuinely asks, and reports what the
  // business genuinely said. When telephony is not configured on this
  // deployment, it says so instead of pretending.

  registry.register({
    name: "book_by_calling_business",
    requiresPermission: "phone",
    // HIDDEN entirely for now: the call rings via the server, but the
    // follow-up channel is a deviceAction ("fulfillment_call") no app
    // build handles, so the user never hears the real outcome — a fake
    // feature by our own rule. Re-enable together with the app handler
    // (and only when telephony credit exists).
    available: () => false,
    description:
      "Actually telephone a business and speak to them to arrange something: " +
      "a doctor/dentist/salon appointment, a restaurant table, or an order " +
      "for collection. The assistant places the call and reports what they " +
      "said. Use this when the user wants the booking MADE, not just an app " +
      "opened. Do not use it for ordering delivery on Swiggy/Zomato.",
    risk: "high",
    inputSchema: {
      type: "object",
      properties: {
        business_name: {
          type: "string",
          description: "Name of the clinic, restaurant or business to call",
        },
        kind: {
          type: "string",
          enum: ["appointment", "table", "food"],
          description: "appointment = doctor/salon/service, table = restaurant reservation, food = order for collection",
        },
        when: {
          type: "string",
          description: "When the user wants it, in their words: 'tomorrow at 7pm', 'Friday morning'",
        },
        party_size: { type: "integer", description: "Number of people, for a table" },
        purpose: { type: "string", description: "Reason for an appointment, e.g. 'a filling'" },
        items: { type: "string", description: "What to order, for a collection order" },
        phone: {
          type: "string",
          description: "The business's number if the user gave it. Otherwise it is looked up.",
        },
        // Filled in by prepare() from the Google Places result, not by the
        // model. It must be declared here or coerceArgs would strip it when
        // the approved call is replayed, and the confirmation card would
        // lose the address it was approved with.
        address: {
          type: "string",
          description: "Resolved street address of the business. Set automatically.",
        },
      },
      required: ["business_name"],
    },
    confirmSummary: (a) => {
      const what =
        a.kind === "table"
          ? `a table for ${a.party_size || 2}`
          : a.kind === "food"
            ? `an order${a.items ? ` of ${a.items}` : ""}`
            : `an appointment${a.purpose ? ` for ${a.purpose}` : ""}`;
      const where = a.address ? `\n${a.address}` : "";
      const num = a.phone ? `\n${a.phone}` : "";
      return `Phone ${a.business_name} and ask for ${what}${a.when ? ` ${a.when}` : ""}${where}${num}`;
    },

    /**
     * Looks the business up on Google BEFORE the confirmation card is
     * shown, so the user approves a specific place — name, address and the
     * number Hari is about to dial — rather than a bare search term.
     *
     * This is also what stops the approved business and the called
     * business from being two different places: the number is pinned into
     * the args here and reused verbatim after approval.
     */
    async prepare(args, ctx) {
      if (args.phone) return null; // the user gave a number; nothing to resolve

      const fulfil = require("../fulfillment/service");
      const agentCall = require("../agents/agentCall");

      if (!agentCall.enabled()) {
        return {
          error:
            "calling businesses on your behalf isn't configured on this server " +
            "(no telephony credentials), so I cannot make this booking myself",
        };
      }

      const place = await fulfil.resolveBusiness({
        query: args.business_name,
        lat: ctx.lat,
        lng: ctx.lng,
        requirePhone: true,
      });

      // No listed number means there is nothing to approve. Say so now
      // rather than showing a confirmation for a call that cannot happen.
      if (!place || !place.phone) {
        return {
          error:
            `I couldn't find a listed phone number for ${args.business_name}` +
            (ctx.lat ? " near you" : " — and I don't have your location to narrow it down") +
            ". Ask the user for the number and I'll call it.",
        };
      }

      return {
        args: {
          business_name: place.name || args.business_name,
          phone: place.phone,
          address: place.address || null,
        },
      };
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };

      const fulfil = require("../fulfillment/service");
      const agentCall = require("../agents/agentCall");
      const kind = args.kind || "appointment";

      // Honest early exit: without telephony this tool cannot do the one
      // thing it claims to do. Say that, and let the model offer the
      // handoff or a direct dial instead of inventing a confirmation.
      if (!agentCall.enabled()) {
        return {
          ok: false,
          error:
            "calling businesses on your behalf isn't configured on this server " +
            "(no telephony credentials), so I cannot make this booking myself",
        };
      }

      // Find a number to ring. A booking tool with no phone number is not
      // a booking tool, so this failure is reported plainly.
      let phone = args.phone || null;
      let venue = args.business_name;
      if (!phone) {
        const place = await fulfil.resolveBusiness({
          query: args.business_name,
          lat: ctx.lat,
          lng: ctx.lng,
          requirePhone: true,
        });
        if (place) {
          phone = place.phone;
          venue = place.name || venue;
        }
      }
      if (!phone) {
        return {
          ok: false,
          error: `I couldn't find a phone number for ${args.business_name}, so I can't call them. Ask the user for the number.`,
        };
      }

      const whenMs = parseWhenMs(args.when, ctx.tzOffsetMin);
      const started = await fulfil.startCallBooking({
        userId: ctx.userId,
        userName: ctx.userName || null,
        kind,
        venue,
        phone,
        when: args.when || null,
        whenMs,
        partySize: args.party_size || null,
        items: args.items || null,
        purpose: args.purpose || null,
        lang: ctx.lang || null,
      });

      if (!started.ok) {
        const why = {
          telephony: "calling isn't configured on this server",
          no_phone: `I couldn't find a number for ${venue}`,
          quota: "you've reached today's limit for calls I place for you",
          failed: "the call wouldn't start",
        }[started.reason];
        return { ok: false, error: why || "the call wouldn't start" };
      }

      // The call is RINGING. It is not booked. The device action hands the
      // session layer the ids it needs to follow the call to its real end
      // and speak the true outcome when it lands.
      return {
        ok: true,
        data: { task_id: started.task.id, call_id: started.callId, venue, phone },
        deviceAction: {
          type: "fulfillment_call",
          task_id: started.task.id,
          call_id: started.callId,
          venue,
          kind,
        },
        speak: `Calling ${venue} now — I'll tell you exactly what they say.`,
      };
    },
  });

  // ---------------- FULFILLMENT: SMART HANDOFF TO PROVIDER APPS ----------
  //
  // Swiggy, Zomato, BookMyShow, Uber and Ola publish no consumer ordering
  // API, so no server can legitimately place these orders. What Hari CAN
  // do is every step before payment: work out which restaurant, which
  // showtime, which exact dropoff, then open the app already pointed at it.
  // Each of these tools says out loud that the user completes the payment.

  registry.register({
    name: "order_food",
    description:
      "Order food delivery through Swiggy or Zomato. Works out the dish or " +
      "restaurant the user means and opens the app there; the user pays in " +
      "the app. Use for 'order biryani', 'get me pizza from Domino's'. " +
      "Act IMMEDIATELY: call this the moment the user asks, with the dish " +
      "exactly as they said it. Do NOT ask which restaurant, which app, " +
      "veg or non-veg, or for confirmation — default to swiggy and let " +
      "them choose specifics inside the app. For a table reservation or a " +
      "collection order use book_by_calling_business.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        dish: { type: "string", description: "What the user wants to eat, e.g. 'chicken biryani'" },
        restaurant: { type: "string", description: "Specific restaurant, if the user named one" },
        provider: { type: "string", enum: ["swiggy", "zomato"], description: "Default swiggy" },
      },
    },
    async execute(args, ctx) {
      const deeplinks = require("../fulfillment/deeplinks");
      const fulfil = require("../fulfillment/service");
      if (!args.dish && !args.restaurant) {
        return { ok: false, needsArgs: ["dish"] };
      }
      const provider = args.provider || "swiggy";
      const link = deeplinks.food({
        provider,
        dish: args.dish,
        restaurant: args.restaurant,
        platform: ctx.platform,
      });
      const what = args.restaurant || args.dish;

      if (!ctx.userId) {
        return { ok: true, deviceAction: { type: "open_url", url: link.url },
          speak: deeplinks.speakFor({ precision: link.precision, providerLabel: deeplinks.labelFor(provider), what }) };
      }
      const out = await fulfil.handoff({
        userId: ctx.userId,
        kind: "food",
        provider,
        link,
        title: `Food: ${what}`,
        venue: args.restaurant || null,
        details: { dish: args.dish || null, restaurant: args.restaurant || null },
        what,
      });
      return {
        ok: true,
        data: { task_id: out.task.id, handoff: true },
        deviceAction: { type: "open_url", url: out.url },
        speak: out.speak,
      };
    },
  });

  registry.register({
    name: "book_ride",
    description:
      "Book a cab through Uber or Ola to a destination. Resolves the real " +
      "address and opens the app with the trip already set up; the user " +
      "confirms and pays. Use for 'book a cab to the airport', 'get me an Uber home'.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        destination: { type: "string", description: "Where the user wants to go" },
        provider: { type: "string", enum: ["uber", "ola"], description: "Default uber" },
      },
      required: ["destination"],
    },
    async execute(args, ctx) {
      const deeplinks = require("../fulfillment/deeplinks");
      const fulfil = require("../fulfillment/service");
      const provider = args.provider || "uber";

      // Coordinates are what make a ride link land on a real quoted trip
      // instead of the app guessing at a text address, so resolve first.
      let lat = null, lng = null, resolvedName = args.destination;
      const place = await fulfil.resolveBusiness({
        query: args.destination,
        lat: ctx.lat,
        lng: ctx.lng,
      });
      if (place && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lng))) {
        lat = place.lat;
        lng = place.lng;
        resolvedName = place.name || resolvedName;
      }

      const link = deeplinks.ride({
        provider,
        destination: resolvedName,
        lat,
        lng,
        pickupLat: ctx.lat,
        pickupLng: ctx.lng,
        platform: ctx.platform,
      });

      if (!ctx.userId) {
        return { ok: true, deviceAction: { type: "open_url", url: link.url },
          speak: deeplinks.speakFor({ precision: link.precision, providerLabel: deeplinks.labelFor(provider), what: resolvedName }) };
      }
      const out = await fulfil.handoff({
        userId: ctx.userId,
        kind: "ride",
        provider,
        link,
        title: `Ride to ${resolvedName}`,
        venue: resolvedName,
        details: { destination: resolvedName, lat, lng },
        what: resolvedName,
      });
      return {
        ok: true,
        data: { task_id: out.task.id, handoff: true },
        deviceAction: { type: "open_url", url: out.url },
        speak: out.speak,
      };
    },
  });

  registry.register({
    name: "book_movie_tickets",
    description:
      "Book cinema tickets on BookMyShow. Opens the app at the film the user " +
      "named (or today's listings for their city); they choose the showtime " +
      "and pay. Use for 'book tickets for <film>', 'what's on at the cinema'.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Film title, if the user named one" },
        city: { type: "string", description: "City. Omit to use the user's area." },
      },
    },
    async execute(args, ctx) {
      const deeplinks = require("../fulfillment/deeplinks");
      const fulfil = require("../fulfillment/service");
      const city = args.city || ctx.city || null;
      const link = deeplinks.movie({ title: args.title, city, platform: ctx.platform });
      const what = args.title || (city ? `films in ${city}` : null);

      if (!ctx.userId) {
        return { ok: true, deviceAction: { type: "open_url", url: link.url },
          speak: deeplinks.speakFor({ precision: link.precision, providerLabel: "BookMyShow", what }) };
      }
      const out = await fulfil.handoff({
        userId: ctx.userId,
        kind: "movie",
        provider: "bookmyshow",
        link,
        title: args.title ? `Tickets: ${args.title}` : `Cinema listings${city ? ` — ${city}` : ""}`,
        venue: null,
        details: { title: args.title || null, city },
        what,
      });
      return {
        ok: true,
        data: { task_id: out.task.id, handoff: true },
        deviceAction: { type: "open_url", url: out.url },
        speak: out.speak,
      };
    },
  });

  // ---------------- INTERPRETER ----------------

  registry.register({
    name: "start_interpreter_mode",
    // HIDDEN: duplicates translator_mode, and its whole effect rides on a
    // deviceAction ("interpreter_mode") no app build has ever handled —
    // the model announced interpreter mode while nothing changed. Remove
    // this gate only together with an app-side handler.
    available: () => false,
    description:
      "Become a live two-way interpreter between the user and someone who " +
      "speaks another language. Use for 'translate between me and him', " +
      "'my patient speaks only Tamil', 'be my interpreter for Hindi', " +
      "'I need to talk to someone in Kannada'.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        their_language: {
          type: "string",
          description: "The OTHER person's language, e.g. 'Tamil', 'ta'",
        },
        my_language: {
          type: "string",
          description: "The user's language. Default English.",
        },
      },
      required: ["their_language"],
    },
    async execute(args) {
      const mode = require("../interpreter/mode");
      const b = mode.languageName(args.their_language);
      const a = mode.languageName(args.my_language) || "English";
      if (!b) return { ok: false, needsArgs: ["their_language"] };
      if (a.toLowerCase() === b.toLowerCase()) {
        return { ok: false, error: `both sides are ${a} — no interpreting needed` };
      }
      return {
        ok: true,
        data: { active: true, languages: [a, b] },
        deviceAction: {
          type: "interpreter_mode",
          active: true,
          a, b,
          instructions: mode.instructions({ a, b }),
        },
        speak: mode.announcement({ a, b }),
      };
    },
  });

  registry.register({
    name: "stop_interpreter_mode",
    // HIDDEN: see start_interpreter_mode.
    available: () => false,
    description:
      "Leave interpreter mode and go back to being the user's assistant. " +
      "Use for 'stop translating', 'that's enough', 'back to normal'.",
    risk: "low",
    deviceAction: true,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      const mode = require("../interpreter/mode");
      return {
        ok: true,
        data: { active: false },
        deviceAction: {
          type: "interpreter_mode",
          active: false,
          instructions: mode.OFF_INSTRUCTIONS,
        },
        speak: "Interpreter mode off.",
      };
    },
  });

  // ---------------- FARE WATCH ----------------

  registry.register({
    name: "watch_flight_fare",
    // A fare watch needs a fare source to re-price against.
    available: () => Boolean(require("./flights").provider()),
    description:
      "Watch a flight route and tell the user when the price drops or hits " +
      "their target. Use for 'tell me when Bangalore to Delhi drops below " +
      "6000', 'watch the Mumbai flight for next Friday', 'alert me if the " +
      "fare falls'.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Origin city or 3-letter airport code" },
        to: { type: "string", description: "Destination city or 3-letter code" },
        date: { type: "string", description: "Travel date, e.g. '2026-09-15' or 'next Friday'" },
        target_price: { type: "number", description: "Rupee price they'd be happy with. Optional." },
        adults: { type: "integer", description: "Default 1" },
      },
      required: ["from", "to", "date"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const flights = require("./flights");
      if (!flights.provider()) {
        return { ok: false, error: "flight search isn't configured on this server, so I can't watch fares" };
      }
      const origin = flights.resolveAirport(args.from);
      const dest = flights.resolveAirport(args.to);
      const missing = [];
      if (!origin) missing.push(`which airport "${args.from}" means`);
      if (!dest) missing.push(`which airport "${args.to}" means`);
      if (missing.length) return { ok: false, needsArgs: missing };

      // Resolve the date the same way the search does — a watch on the
      // wrong day is worse than no watch.
      let day = String(args.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        let parsed = null;
        try {
          parsed = require("chrono-node").parseDate(day, new Date(), { forwardDate: true });
        } catch (_) {}
        if (!parsed) return { ok: false, needsArgs: [`a clearer travel date (I couldn't read "${args.date}")`] };
        day = parsed.toISOString().slice(0, 10);
      }

      const fares = require("../travel/fares");
      const out = await fares.create(ctx.userId, {
        origin, destination: dest, departDate: day,
        adults: args.adults || 1,
        targetPrice: args.target_price || null,
      });
      if (!out.ok) return { ok: false, error: out.error };

      return {
        ok: true,
        data: { id: out.id, origin, destination: dest, date: day },
        speak: args.target_price
          ? `Watching ${origin} to ${dest} on ${day} — I'll tell you if it drops to ₹${Number(args.target_price).toLocaleString("en-IN")}.`
          : `Watching ${origin} to ${dest} on ${day} — I'll tell you if the fare drops.`,
      };
    },
  });

  // ---------------- PAYMENT COLLECTION ----------------

  registry.register({
    name: "collect_payment",
    // Hidden without Razorpay keys — there is no link to create.
    available: () => require("../payments/service").enabled(),
    description:
      "Ask someone to PAY the user — creates a real payment link for the " +
      "amount and opens WhatsApp to send it. Use for 'collect 15000 from " +
      "Ravi for the consultation', 'send Priya a payment link for 2500', " +
      "'bill the client'. This requests money coming TO the user; it can " +
      "never send money out.",
    risk: "high",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Who should pay, by name" },
        amount: { type: "number", description: "Amount in rupees" },
        reason: { type: "string", description: "What it's for, e.g. 'the consultation'" },
        phone: { type: "string", description: "Only if the user dictated a number" },
      },
      required: ["from", "amount"],
    },
    confirmSummary: (a) =>
      `Request ₹${Number(a.amount).toLocaleString("en-IN")} from ${a.from}` +
      (a.reason ? ` for ${a.reason}` : "") +
      (a.phone ? `\n${a.phone}` : ""),

    /** Resolve the payer before asking — you approve a person, not a name. */
    async prepare(args, ctx) {
      if (!ctx.userId) return { error: "not signed in" };
      const payments = require("../payments/service");
      if (!payments.enabled()) {
        return { error: "payment collection isn't set up on this server yet (no Razorpay keys)" };
      }
      if (!(Number(args.amount) > 0)) return { error: "I need a valid amount" };
      if (args.phone) return null;

      const { resolveContact } = require("../users/resolve");
      const { match, candidates } = await resolveContact(ctx.userId, args.from);
      if (!match) {
        // Not fatal: a link still works, the user just picks the chat.
        return candidates.length > 1
          ? { error: `several contacts match "${args.from}" — ${candidates.map((c) => c.name).join(", ")}. Ask which one.` }
          : null;
      }
      return { args: { from: match.name, phone: match.phone } };
    },

    async execute(args, ctx) {
      const payments = require("../payments/service");
      const out = await payments.createRequest({
        userId: ctx.userId,
        amountRupees: args.amount,
        payerName: args.from,
        payerPhone: args.phone || null,
        description: args.reason || `Payment to ${ctx.userName || "your assistant's user"}`,
        userName: ctx.userName,
      });
      if (!out.ok) return { ok: false, error: out.error };

      const rupees = Number(out.amountRupees).toLocaleString("en-IN");
      const text =
        `Hi ${args.from}, here's the payment link for ₹${rupees}` +
        (args.reason ? ` for ${args.reason}` : "") + `: ${out.url}`;
      const url = args.phone
        ? `whatsapp://send?phone=${String(args.phone).replace(/[^\d+]/g, "")}&text=${encodeURIComponent(text)}`
        : `whatsapp://send?text=${encodeURIComponent(text)}`;

      await payments.markSent(out.id);

      return {
        ok: true,
        data: { id: out.id, url: out.url, amount: out.amountRupees },
        deviceAction: { type: "open_url", url },
        // The link exists; it has NOT been paid, and it has not even been
        // sent until the user taps send.
        speak:
          `Payment link for ₹${rupees} is ready — tap send and I'll tell you the moment ${args.from} pays.`,
      };
    },
  });

  registry.register({
    name: "check_payments",
    description:
      "Check money the user has asked people for — what's been paid and " +
      "what's still outstanding. Use for 'has Ravi paid', 'what's " +
      "outstanding', 'who still owes me'.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["paid", "sent", "created"], description: "Filter" },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const payments = require("../payments/service");
      const rows = await payments.list(ctx.userId, { status: args.status || null, limit: 10 });
      if (!rows.length) {
        return { ok: true, data: [], speak: "No payment requests yet." };
      }
      const lines = rows.slice(0, 5).map((r) => {
        const amt = (Number(r.amount_paise) / 100).toLocaleString("en-IN");
        const who = r.payer_name || "someone";
        return r.status === "paid"
          ? `${who} paid ₹${amt}`
          : `₹${amt} from ${who} still outstanding`;
      });
      const outstanding = rows
        .filter((r) => r.status !== "paid" && r.status !== "cancelled")
        .reduce((n, r) => n + Number(r.amount_paise), 0) / 100;
      return {
        ok: true,
        data: rows,
        speak:
          lines.join(". ") +
          (outstanding > 0 ? `. That's ₹${outstanding.toLocaleString("en-IN")} outstanding.` : ""),
      };
    },
  });

  // ---------------- MEETING NEGOTIATION ----------------

  registry.register({
    name: "arrange_meeting_with",
    // HIDDEN: same reason as book_by_calling_business — its outcome rides
    // on the unhandled "scheduling_call" deviceAction.
    available: () => false,
    description:
      "Arrange a meeting with someone END TO END: find times the user is " +
      "free, PHONE the person, agree a slot with them, and put it in the " +
      "calendar. Use for 'set up a call with Ravi next week', 'get me 30 " +
      "minutes with Dr Rao', 'arrange a meeting with the client'. This " +
      "actually telephones them — it is not a calendar invite.",
    risk: "high",
    inputSchema: {
      type: "object",
      properties: {
        person: { type: "string", description: "Who to meet, by name" },
        purpose: { type: "string", description: "What it's about, e.g. 'the pricing review'" },
        duration_minutes: { type: "integer", description: "Default 30" },
        within_days: { type: "integer", description: "How far ahead to look. Default 7" },
        // Filled by prepare(), not the model — they MUST be declared or
        // coerceArgs strips them before execute() ever sees them (the same
        // hazard book_by_calling_business documents on its own schema).
        phone: { type: "string", description: "Filled automatically — do not set" },
        slots_label: { type: "string", description: "Filled automatically — do not set" },
      },
      required: ["person"],
    },
    confirmSummary: (a) =>
      `Phone ${a.person} and agree a ${a.duration_minutes || 30}-minute meeting` +
      (a.purpose ? ` about ${a.purpose}` : "") +
      (a.slots_label ? `\nOffering: ${a.slots_label}` : "") +
      (a.phone ? `\n${a.phone}` : ""),

    /**
     * Resolve the person AND the free slots before asking permission.
     *
     * The user is approving a real phone call, so they need to see who is
     * being rung and — just as important — which times are about to be
     * offered on their behalf. Pinning both into the args also means the
     * slots that were approved are the slots that get offered.
     */
    async prepare(args, ctx) {
      if (!ctx.userId) return { error: "not signed in" };
      const agentCallMod = require("../agents/agentCall");
      if (!agentCallMod.enabled()) {
        return { error: "calling isn't configured on this server, so I can't arrange it by phone" };
      }

      const { resolveContact } = require("../users/resolve");
      const { match, candidates } = await resolveContact(ctx.userId, args.person);
      if (!match) {
        return {
          error: candidates.length
            ? `several contacts match "${args.person}" — ${candidates.map((c) => c.name).join(", ")}. Ask which one.`
            : `I couldn't find ${args.person} in your contacts, and I need their number to call them.`,
        };
      }

      const freeslots = require("../scheduling/freeslots");
      const slots = await freeslots.findSlots(ctx.userId, {
        durationMin: args.duration_minutes || 30,
        withinDays: args.within_days || 7,
        tzOffsetMin: ctx.tzOffsetMin || 330,
        count: 3,
      });

      // No calendar linked: we will not invent availability.
      if (slots === null) {
        return {
          error:
            "your Google Calendar isn't linked, so I don't know when you're free. " +
            "Link it, or tell me which times to offer.",
        };
      }
      if (!slots.length) {
        return { error: `you have no free ${args.duration_minutes || 30}-minute gaps in the next ${args.within_days || 7} days` };
      }

      return {
        args: {
          person: match.name,
          phone: match.phone,
          slots_label: slots.map((s) => s.label).join(", "),
        },
      };
    },

    async execute(args, ctx) {
      const negotiator = require("../scheduling/negotiator");
      const freeslots = require("../scheduling/freeslots");

      const slots = await freeslots.findSlots(ctx.userId, {
        durationMin: args.duration_minutes || 30,
        withinDays: args.within_days || 7,
        tzOffsetMin: ctx.tzOffsetMin || 330,
        count: 3,
      });
      if (!slots || !slots.length) {
        return { ok: false, error: "I no longer have free slots to offer" };
      }

      const started = await negotiator.start({
        userId: ctx.userId,
        userName: ctx.userName || null,
        contact: { name: args.person, phone: args.phone },
        purpose: args.purpose || null,
        slots,
        lang: ctx.lang || null,
      });

      if (!started.ok) {
        const why = {
          telephony: "calling isn't configured on this server",
          no_phone: `I don't have a number for ${args.person}`,
          no_slots: "I couldn't find any free slots",
          quota: "you've reached today's limit for calls I place",
          failed: "the call wouldn't start",
        }[started.reason];
        return { ok: false, error: why || "the call wouldn't start" };
      }

      // Ringing, not arranged. The session layer follows it to the end.
      return {
        ok: true,
        data: { task_id: started.taskId, call_id: started.callId },
        deviceAction: {
          type: "scheduling_call",
          task_id: started.taskId,
          call_id: started.callId,
          person: args.person,
          purpose: args.purpose || null,
          slots,
          tz: ctx.tzOffsetMin || 330,
        },
        speak: `Calling ${args.person} now to fix a time — I'll tell you what they say.`,
      };
    },
  });

  // ---------------- MEETINGS ----------------

  registry.register({
    name: "recall_meeting",
    description:
      "Recall a recent meeting the assistant captured — what was decided, who " +
      "agreed to what, and the drafted follow-up. Use for 'what did we decide " +
      "in the meeting', 'what came out of the call with Ravi', 'read me the " +
      "follow-up', 'what were my action items'.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        about: {
          type: "string",
          description: "Person or topic to match, e.g. 'Ravi', 'the pricing call'. Omit for the latest.",
        },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const svc = require("../meetings/service");
      const all = await svc.list(ctx.userId, { limit: 10 });
      if (!all.length) return { ok: true, data: [], speak: "I haven't captured any meetings yet." };

      const q = String(args.about || "").trim().toLowerCase();
      const m = q
        ? all.find((x) =>
            `${x.title} ${x.participants} ${x.summary}`.toLowerCase().includes(q))
        : all[0];
      if (!m) {
        return { ok: false, error: `no meeting matching "${args.about}" — say so rather than guessing` };
      }

      const mine = m.actions.filter((a) => a.mine);
      const spoken = [
        m.summary,
        m.decisions.length ? `Decided: ${m.decisions.slice(0, 3).join("; ")}.` : null,
        mine.length ? `Your actions: ${mine.map((a) => a.text).join("; ")}.` : null,
      ].filter(Boolean).join(" ");

      return {
        ok: true,
        data: m,
        speak: spoken || "I have the transcript but no clear decisions came out of it.",
      };
    },
  });

  // ---------------- COMMITMENTS ----------------

  registry.register({
    name: "list_my_commitments",
    description:
      "What the user has promised to do and hasn't done yet — things they " +
      "said they'd send, call, file or finish. Use for 'what did I promise', " +
      "'what do I owe people', 'what's pending', 'anything I said I'd do'.",
    risk: "low",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const svc = require("../commitments/service");
      const rows = await svc.list(ctx.userId, { status: "open", limit: 10 });
      if (!rows.length) {
        return { ok: true, data: [], speak: "Nothing outstanding — you're clear." };
      }
      const now = Date.now();
      const lines = rows.slice(0, 6).map((c) => {
        const who = c.owed_to ? ` to ${c.owed_to}` : "";
        if (!c.due_at) return `${c.text}${who}`;
        const overdue = Number(c.due_at) < now;
        return `${c.text}${who} — ${overdue ? "overdue" : "due " + relative(Number(c.due_at), now)}`;
      });
      return {
        ok: true,
        data: rows,
        speak: `${rows.length} open. ` + lines.join(". "),
      };
    },
  });

  registry.register({
    name: "complete_commitment",
    description:
      "Mark something the user promised as done. Use when they say 'I sent " +
      "Ravi the proposal', 'done with the GST filing', 'I called her back'.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "What they finished, e.g. 'the proposal for Ravi'",
        },
      },
      required: ["description"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const svc = require("../commitments/service");
      const done = await svc.complete(ctx.userId, args.description);
      if (!done) {
        return {
          ok: false,
          error: `nothing open matching "${args.description}" — say so rather than pretending it was ticked off`,
        };
      }
      return { ok: true, data: done, speak: `Done — ticked off "${done.text}".` };
    },
  });

  // ---------------- INBOUND CALLS (Hari answered the phone) ----------------

  registry.register({
    name: "check_my_calls",
    description:
      "Read back the calls answered on the user's behalf while they " +
      "were unavailable — who rang, what they wanted, and any message left. " +
      "Use for 'did anyone call', 'any messages', 'who called me', 'what did " +
      "I miss'.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        unseen_only: {
          type: "boolean",
          description: "Only calls the user hasn't been told about yet. Default true.",
        },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const receptionist = require("../inbound/receptionist");
      const unseenOnly = args.unseen_only !== false;
      const calls = await receptionist.listCalls(ctx.userId, { limit: 10, unseenOnly });

      if (!calls.length) {
        return {
          ok: true,
          data: [],
          speak: unseenOnly ? "No new calls." : "No calls yet.",
        };
      }

      // Urgent first — the whole reason for screening is that the important
      // one should not be buried behind three sales calls.
      const order = { urgent: 0, normal: 1, low: 2 };
      calls.sort((a, b) => (order[a.urgency] ?? 1) - (order[b.urgency] ?? 1));

      const lines = calls.slice(0, 5).map((c) => {
        const who = c.caller_name || `a number ending ${String(c.from_number).slice(-4)}`;
        if (c.outcome === "forwarded") return `${who} — I put them through`;
        if (c.outcome === "blocked") return `${who} — a sales call, I ended it`;
        const urgent = c.urgency === "urgent" ? "Urgent — " : "";
        return `${urgent}${who}: ${c.message || c.summary}`;
      });

      // Reading them out IS being told about them.
      await receptionist.markSeen(ctx.userId, calls.map((c) => Number(c.id)));

      return {
        ok: true,
        data: calls,
        speak: `${calls.length === 1 ? "One call" : `${calls.length} calls`}. ` + lines.join(". "),
      };
    },
  });

  /** Shared: resolve a spoken name to exactly one real client, or return a
   *  tool error the model can act on (ask / say nobody matches). */
  async function requireClient(userId, spokenName) {
    const name = String(spokenName || "").trim();
    if (!name) return { err: { ok: false, error: "client_name is required" } };
    const r = await people.resolveByName(userId, name);
    if (r.none) {
      return { err: { ok: false, error: "no_such_client",
        data: { searched: name, hint: "no saved client/patient by that name — nothing was done; offer to add them from the Clients screen" } } };
    }
    if (r.ambiguous) {
      return { err: { ok: false, error: "ambiguous_client",
        data: { candidates: r.ambiguous.map((c) => ({ id: c.id, name: c.name, kind: c.kind })) },
        speak: "Which one do you mean: " + r.ambiguous.map((c) => c.name).join(" or ") + "?" } };
    }
    return { client: r.client };
  }

  registry.register({
    name: "schedule_patient_recall",
    description:
      "Schedule a RECALL / follow-up / next appointment for one of the user's " +
      "clients or patients — 'recall Ramesh in six months for cleaning', " +
      "'Sharma's next hearing is October 3rd', 'call Manish back for review " +
      "next Friday 10am'. The user gets a reminder when it is due, and when " +
      "notify_patient is true the assistant itself PHONES the patient in the " +
      "hours before to remind them (needs the patient's number on their card). " +
      "Default notify_patient to true when the patient has a phone number " +
      "unless the user says otherwise.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "The patient/client's name as spoken." },
        due_at: { type: "string", description: "ISO-8601 datetime it is due. Resolve relative phrases ('in six months', 'next Friday 10am') yourself; default 10:00 when no time was given." },
        note: { type: "string", description: "What the recall is for, e.g. 'cleaning', 'case hearing', 'review'." },
        notify_patient: { type: "boolean", description: "Assistant phones the patient beforehand. Default true when they have a number." },
      },
      required: ["client_name", "due_at"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const practice = require("../practice/store");
      const { client, err } = await requireClient(ctx.userId, args.client_name);
      if (err) return err;
      const due = parseUserTime(args.due_at, ctx.tzOffsetMin);
      if (!due || due < Date.now() - 60_000) {
        return { ok: false, error: "due_at must be a valid future datetime (ISO-8601)" };
      }
      const hasPhone = Boolean(String(client.phone || "").trim());
      const notify = args.notify_patient !== false && hasPhone;
      const recall = await practice.createRecall(ctx.userId, {
        clientId: client.id,
        note: args.note || "",
        dueAt: due,
        notifyPatient: notify,
      });
      // The professional's own nudge rides the normal reminder pipeline
      // (push + alarm), so recalls never need a second delivery mechanism.
      try {
        const r = await reminders.create(
          ctx.userId,
          `Recall: ${client.name}${args.note ? ` — ${args.note}` : ""}`,
          due
        );
        if (r) await practice.setReminderId(ctx.userId, recall.id, r.id);
      } catch (_) {}
      const when = new Date(due).toLocaleString("en-IN", {
        day: "numeric", month: "short",
        hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
      });
      return {
        ok: true,
        data: { recall: practice.recallToClient(recall), client: { id: Number(client.id), name: client.name } },
        speak:
          `Recall for ${client.name} set for ${when}.` +
          (notify ? " I'll phone them beforehand to remind them." :
            args.notify_patient !== false && !hasPhone ? " I can't call them — there's no number on their card." : ""),
      };
    },
  });

  registry.register({
    name: "complete_patient_recall",
    description:
      "Mark a client/patient's pending recall as DONE ('Ramesh came in, close " +
      "his recall') or CANCELLED ('cancel Sharma's recall').",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        client_name: { type: "string" },
        cancel: { type: "boolean", description: "true to cancel instead of completing" },
      },
      required: ["client_name"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const practice = require("../practice/store");
      const { client, err } = await requireClient(ctx.userId, args.client_name);
      if (err) return err;
      const next = await practice.nextRecallFor(ctx.userId, client.id);
      if (!next) return { ok: false, error: `${client.name} has no pending recall` };
      await practice.closeRecall(ctx.userId, next.id, args.cancel ? "cancelled" : "done");
      if (next.reminder_id) {
        await reminders.setDone(ctx.userId, Number(next.reminder_id), true).catch(() => {});
      }
      return { ok: true, data: { closed: practice.recallToClient(next) },
        speak: `${client.name}'s recall is ${args.cancel ? "cancelled" : "marked done"}.` };
    },
  });

  registry.register({
    name: "record_patient_payment",
    description:
      "Track money per client/patient — 'Ramesh paid 500' (entry_type paid), " +
      "'Sharma owes 2000 for the filing' / 'bill Manish 1500' (entry_type due). " +
      "Speaks the client's new outstanding balance back.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        client_name: { type: "string" },
        amount: { type: "number", description: "Positive amount in rupees." },
        entry_type: { type: "string", enum: ["paid", "due"], description: "'paid' = they settled money, 'due' = they now owe this much more." },
        note: { type: "string", description: "What it was for, if said." },
      },
      required: ["client_name", "amount", "entry_type"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const practice = require("../practice/store");
      const { client, err } = await requireClient(ctx.userId, args.client_name);
      if (err) return err;
      const row = await practice.addLedger(ctx.userId, {
        clientId: client.id, amount: args.amount, kind: args.entry_type, note: args.note,
      });
      if (!row) return { ok: false, error: "amount must be a positive number" };
      const bal = await practice.balanceOf(ctx.userId, client.id);
      const balLine = bal > 0 ? `They now owe ₹${bal}.` : bal < 0 ? `They are ₹${-bal} in credit.` : "They're fully settled.";
      return { ok: true, data: { client: { id: Number(client.id), name: client.name }, balance: bal },
        speak: `Noted — ${client.name} ${args.entry_type === "paid" ? "paid" : "owes"} ₹${args.amount}. ${balLine}` };
    },
  });

  registry.register({
    name: "check_patient_dues",
    description:
      "Outstanding money across clients/patients — 'who hasn't paid', 'how much " +
      "does Ramesh owe', 'total pending dues'. Answer ONLY from this data.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "One client's balance; omit for everyone who owes." },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const practice = require("../practice/store");
      if (args.client_name) {
        const { client, err } = await requireClient(ctx.userId, args.client_name);
        if (err) return err;
        const bal = await practice.balanceOf(ctx.userId, client.id);
        return { ok: true, data: { client: client.name, balance: bal },
          speak: bal > 0 ? `${client.name} owes ₹${bal}.` : bal < 0 ? `${client.name} is ₹${-bal} in credit.` : `${client.name} is fully settled.` };
      }
      const rows = await practice.pendingDues(ctx.userId);
      if (!rows.length) return { ok: true, data: [], speak: "Nobody owes you anything right now." };
      const total = Math.round(rows.reduce((a, r) => a + Number(r.balance), 0) * 100) / 100;
      const lines = rows.slice(0, 5).map((r) => `${r.name} ₹${Number(r.balance)}`);
      return { ok: true, data: rows,
        speak: `₹${total} pending across ${rows.length} ${rows.length === 1 ? "person" : "people"}: ${lines.join(", ")}.` };
    },
  });

  registry.register({
    name: "send_patient_document",
    description:
      "Send/share one of a client/patient's filed documents — 'send Ramesh his " +
      "blood report on WhatsApp', 'share Sharma's contract'. Finds the document " +
      "in that person's case file and opens the phone's share sheet with the " +
      "real file attached; the user taps the app/chat to send it. Nothing is " +
      "sent without that tap, so never claim it was sent — say it's ready to send.",
    risk: "medium",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        client_name: { type: "string" },
        description: { type: "string", description: "Which document, in the user's words ('blood report', 'latest x-ray'). Omit for the most recent one." },
      },
      required: ["client_name"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const { client, err } = await requireClient(ctx.userId, args.client_name);
      if (err) return err;
      const rows = await people.listClientDocuments(ctx.userId, client.id, 50);
      if (!rows.length) return { ok: false, error: `${client.name} has no documents filed yet` };
      let doc = rows[0];
      const want = String(args.description || "").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ")
        .split(/\s+/).filter((w) => w.length >= 3);
      if (want.length) {
        let best = 0;
        for (const r of rows) {
          const hay = `${r.title} ${r.note} ${r.category} ${r.tags} ${r.summary}`.toLowerCase();
          const hits = want.filter((w) => hay.includes(w)).length;
          if (hits > best) { best = hits; doc = r; }
        }
      }
      const shape = docs.toClient(doc);
      return {
        ok: true,
        data: { client: { id: Number(client.id), name: client.name }, document: shape },
        deviceAction: { type: "share_document", document: shape, client_name: client.name },
        speak: `Here's ${client.name}'s ${shape.title || "document"} — pick the chat to send it.`,
      };
    },
  });

  registry.register({
    name: "record_entry",
    description:
      "Log an entry in the user's own record book — the running accounts and " +
      "tallies they dictate: 'race 1 minus 4.5', 'log 2000 for site expenses', " +
      "'today's collection 15,600'. USE THIS whenever the user dictates a " +
      "figure or result to be KEPT. Never send such a figure to anyone as a " +
      "message. Amount is signed: losses negative, gains positive. Topic " +
      "groups the book ('horse race accounts'); reuse the topic already in use.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Which book, e.g. 'horse race accounts'." },
        label: { type: "string", description: "What this entry is, e.g. 'Race 1'." },
        amount: { type: "number", description: "Signed number: -4.5 for a loss of 4.5." },
        note: { type: "string", description: "Anything extra the user said." },
      },
      required: ["topic"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const records = require("../records/store");
      try {
        const row = await records.add(ctx.userId, args);
        const { total } = await records.list(ctx.userId, { topic: args.topic, limit: 200 });
        const amt = row.amount === null ? null : Number(row.amount);
        return {
          ok: true,
          data: { entry: records.toClient(row), total },
          speak:
            (args.label ? `${args.label}: ` : "") +
            (amt === null ? "noted" : `${amt}`) +
            `. Total ${total}.`,
        };
      } catch (e) {
        return { ok: false, error: String(e.message).slice(0, 160) };
      }
    },
  });

  registry.register({
    name: "amend_last_entry",
    description:
      "Correct the MOST RECENT entry in a record book — 'no, that should be " +
      "minus 4.5', 'change it to 3', 'that was race 2'. Use whenever the user " +
      "corrects a figure they just gave.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Which book. Omit for the newest entry overall." },
        amount: { type: "number" },
        label: { type: "string" },
        note: { type: "string" },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const records = require("../records/store");
      const row = await records.amendLatest(ctx.userId, args);
      if (!row) return { ok: false, error: "no entry to correct" };
      const { total } = await records.list(ctx.userId, { topic: row.topic, limit: 200 });
      return {
        ok: true,
        data: { entry: records.toClient(row), total },
        speak: `Corrected to ${row.amount}. Total ${total}.`,
      };
    },
  });

  registry.register({
    name: "list_entries",
    description:
      "Read back a record book with its total — 'what's my race account', " +
      "'show today's entries', 'how much am I down'. Answer ONLY from what " +
      "this returns. Omit topic to list the books the user keeps.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Which book. Omit to list all books." },
        period: { type: "string", enum: ["today", "week", "month", "all"] },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const records = require("../records/store");
      if (!args.topic) {
        const books = await records.topics(ctx.userId);
        if (!books.length) return { ok: true, data: [], speak: "You have no record books yet." };
        return {
          ok: true,
          data: books,
          speak: books
            .map((b) => `${b.topic}: ${Math.round(Number(b.total) * 100) / 100} over ${b.entries} entries`)
            .join(". "),
        };
      }
      const sinceMs =
        args.period === "today" ? Date.now() - 86400000 :
        args.period === "week" ? Date.now() - 7 * 86400000 :
        args.period === "month" ? Date.now() - 30 * 86400000 : undefined;
      const { rows, total } = await records.list(ctx.userId, { topic: args.topic, sinceMs });
      if (!rows.length) return { ok: true, data: [], speak: `Nothing recorded in ${args.topic} yet.` };
      const lines = rows.slice(0, 10).map((r) =>
        `${r.label || "entry"} ${r.amount === null ? "" : Number(r.amount)}`.trim());
      return {
        ok: true,
        data: { entries: rows.map(records.toClient), total },
        speak: `${lines.join(", ")}. Total ${total}.`,
      };
    },
  });

  registry.register({
    name: "save_web_document",
    description:
      "Download a document from the web INTO the user's documents — a court " +
      "judgment PDF, a form, a report: 'download that judgment', 'save this " +
      "PDF'. Pass the direct file URL (from a web_search result). Only real " +
      "PDFs and images can be saved; if the link is a web page, say so and " +
      "offer to open it instead — never claim a download that did not happen.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Direct URL of the PDF or image." },
        title: { type: "string", description: "What to call it." },
        client_name: { type: "string", description: "File it under this client instead of My Documents." },
      },
      required: ["url"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const url = String(args.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: "need a full http(s) URL" };
      let buf, mime;
      try {
        const r = await fetch(url, {
          redirect: "follow",
          headers: { "user-agent": "Mozilla/5.0 (Android) MyAssistant/1.0" },
          signal: AbortSignal.timeout(20000),
        });
        if (!r.ok) return { ok: false, error: `the site returned ${r.status}` };
        mime = String(r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const OK = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
        if (!OK.has(mime)) {
          return {
            ok: false,
            error: `that link is a web page (${mime || "unknown type"}), not a downloadable file`,
            data: { hint: "offer to OPEN it with open_webpage instead; do not claim it was saved" },
          };
        }
        buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length) return { ok: false, error: "the file came back empty" };
        if (buf.length > 18 * 1024 * 1024) return { ok: false, error: "that file is too large to save (18 MB max)" };
      } catch (e) {
        return { ok: false, error: `could not download it: ${String(e.message).slice(0, 120)}` };
      }
      const docsStore = require("../docs/store");
      const people = require("../clients/store");
      const title = String(args.title || "").trim() || "Downloaded document";
      let row;
      try {
        row = await docsStore.createDocument(ctx.userId, {
          buffer: buf,
          filename: title.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80) +
            (mime === "application/pdf" ? ".pdf" : ".jpg"),
          mime,
          note: title,
        });
      } catch (e) {
        return { ok: false, error: `could not save it: ${String(e.message).slice(0, 120)}` };
      }
      let filedUnder = null;
      if (args.client_name) {
        const rc = await people.resolveByName(ctx.userId, args.client_name);
        if (rc.client && (await people.linkDocument(ctx.userId, row.id, rc.client.id))) {
          filedUnder = rc.client.name;
        }
      }
      const saved = (await docsStore.getDocument(ctx.userId, row.id)) || row;
      const shape = docsStore.toClient(saved);
      return {
        ok: true,
        data: { document: shape, filedUnder },
        deviceAction: { type: "documents", documents: [shape] },
        speak: filedUnder ? `Saved to ${filedUnder}'s file.` : "Saved to your documents.",
      };
    },
  });

  registry.register({
    name: "recall_conversation",
    description:
      "Read back what was actually SAID in this conversation (or a recent " +
      "one) — 'what did I just ask you?', 'what was my previous request?', " +
      "'when did I ask you to call Jeevan?', 'what did you say about that?'. " +
      "This is the transcript, so it is the truth about the exchange. Use it " +
      "instead of recall_memory for anything about the conversation itself, " +
      "and answer only from what it returns. If it shows nothing, say so.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        about: { type: "string", description: "Optional words to search for, e.g. 'Jeevan', 'reminder'." },
        mine_only: { type: "boolean", description: "Only what the USER said. Default false." },
        minutes: { type: "integer", description: "How far back. Default 180." },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const recent = require("../memory/recent");
      const minutes = Math.min(Math.max(Number(args.minutes) || 180, 1), 60 * 24 * 3);
      const rows = await recent.turns(ctx.userId, {
        sinceMs: Date.now() - minutes * 60_000,
        role: args.mine_only ? "user" : undefined,
        match: args.about || undefined,
        limit: 20,
      });
      if (!rows.length) {
        return {
          ok: true,
          data: [],
          speak:
            "Nothing in the conversation record matches that. Say so plainly — " +
            "do not invent what was said.",
        };
      }
      const fmt = (r) => {
        const when = new Date(Number(r.created_at)).toLocaleString("en-IN", {
          hour: "numeric", minute: "2-digit", day: "numeric", month: "short",
          timeZone: "Asia/Kolkata",
        });
        const who = r.role === "assistant" ? "you said" : "they said";
        const sameSession = ctx.sessionId && r.session_id === ctx.sessionId;
        return `${when} (${sameSession ? "this conversation" : "an earlier conversation"}) ${who}: ${String(r.text).slice(0, 200)}`;
      };
      return {
        ok: true,
        data: rows.map((r) => ({
          role: r.role,
          text: r.text,
          at: Number(r.created_at),
          thisSession: Boolean(ctx.sessionId && r.session_id === ctx.sessionId),
        })),
        speak: rows.slice(0, 6).map(fmt).join(". "),
      };
    },
  });

  registry.register({
    name: "get_current_location",
    requiresPermission: "location",
    description:
      "Where the user is right now — 'where am I', 'what is my location', " +
      "'which area is this'. The phone sends its coordinates with every " +
      "request, so answer from this tool. NEVER open settings to answer a " +
      "location question; if this tool says location is unavailable, say so " +
      "and offer to guide them to turn it on.",
    risk: "low",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const lat = Number(ctx.lat);
      const lng = Number(ctx.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return {
          ok: false,
          error: "no_location",
          data: {
            hint:
              "The phone has not shared a location this session — usually the " +
              "location permission is off. Say that plainly and OFFER to open " +
              "the location settings; do not open anything unasked.",
          },
        };
      }
      const key = process.env.GOOGLE_PLACES_API_KEY;
      if (key) {
        try {
          const r = await fetch(
            `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}`,
            { signal: AbortSignal.timeout(6000) }
          );
          const j = await r.json();
          const best = (j.results || [])[0];
          if (best && best.formatted_address) {
            const parts = (best.address_components || []);
            const pick = (type) =>
              (parts.find((p) => (p.types || []).includes(type)) || {}).long_name;
            const area = pick("sublocality") || pick("locality") || "";
            const city = pick("locality") || pick("administrative_area_level_2") || "";
            return {
              ok: true,
              data: { lat, lng, address: best.formatted_address, area, city },
              speak: area && city && area !== city
                ? `They are in ${area}, ${city}.`
                : `They are at ${best.formatted_address}.`,
            };
          }
        } catch (e) {
          console.warn("reverse geocode failed:", e.message);
        }
      }
      return {
        ok: true,
        data: { lat, lng },
        speak:
          `The phone reports ${lat.toFixed(3)}, ${lng.toFixed(3)} — give that as ` +
          "an approximate position and offer to open Maps for the exact place.",
      };
    },
  });

  registry.register({
    name: "check_recent_actions",
    description:
      "What the assistant ACTUALLY did, from its execution record — the only " +
      "correct way to answer 'did you call X?', 'why did settings open?', " +
      "'what did I just ask you?', 'when did I ask you to call Jeevan?', " +
      "'did you open Google search?', 'why did YouTube open?'. A line that " +
      "says an app was opened on the phone means it OPENED — do not deny it " +
      "because the tool had another name (play_music opens YouTube). " +
      "NEVER answer those from memory or " +
      "from your impression of the conversation: use this, and say exactly " +
      "what it returns. If it returns nothing, say plainly that nothing of " +
      "that kind was done.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        about: {
          type: "string",
          description:
            "Optional filter in the user's words — a person, an app, 'call', 'settings', 'search'.",
        },
        minutes: {
          type: "integer",
          description: "How far back to look. Default 120.",
        },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const store = require("../actions/store");
      const minutes = Math.min(Math.max(Number(args.minutes) || 120, 1), 60 * 24 * 7);
      const rows = await store.recent(ctx.userId, {
        limit: 25,
        sinceMs: Date.now() - minutes * 60_000,
      });
      const about = String(args.about || "").trim().toLowerCase();
      const words = about.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length >= 3);
      const matched = words.length
        ? rows.filter((r) => {
            const hay = `${r.tool} ${r.target} ${r.detail}`.toLowerCase();
            return words.some((w) => hay.includes(w));
          })
        : rows;
      const use = (matched.length ? matched : rows).slice(0, 8);
      if (!use.length) {
        return {
          ok: true,
          data: [],
          speak:
            "Nothing like that is in my record for the last " +
            (minutes >= 60 ? Math.round(minutes / 60) + " hours" : minutes + " minutes") +
            " — say so plainly; do not guess that you might have done it.",
        };
      }
      return {
        ok: true,
        data: use.map((r) => ({
          tool: r.tool,
          target: r.target,
          ok: r.ok === 1 || r.ok === true,
          at: Number(r.created_at),
          line: store.describe(r),
        })),
        speak: use.map((r) => store.describe(r)).join(". ") +
          ". Answer ONLY from these; they are the record of what really ran. " +
          "Where a line says an app was opened on the phone, THAT APP DID " +
          "OPEN — say so even if the tool's own name is something else. " +
          "Denying an app opened because the tool was called something " +
          "different is the mistake this record exists to prevent.",
      };
    },
  });

  registry.register({
    name: "check_task_outcomes",
    description:
      "The REAL result of things the user asked the assistant to do — did " +
      "the call to X connect or fail (and why), did the message reach them, " +
      "was the document filed. Use for 'did my call go through', 'did you " +
      "call Allen', 'did that message send', 'what happened with that call', " +
      "'was that saved'. Answer ONLY from this data; a status of " +
      "requested/dialing means the result is not known yet.\n" +
      "IF THERE IS NO ROW for what they are asking about, say the record " +
      "shows nothing rather than concluding it worked — and do not then " +
      "contradict yourself a turn later. When this and check_recent_actions " +
      "seem to disagree, THIS one is about whether it ARRIVED and the other " +
      "is about whether the assistant TRIED; say both plainly in one " +
      "sentence instead of picking one and reversing it.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["call", "message", "document", "all"], description: "Default all." },
        limit: { type: "integer", description: "How many recent tasks (default 5)." },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const outcomes = require("../outcomes/store");
      const max = Math.min(Number(args.limit) || 5, 20);
      let rows = await outcomes.list(ctx.userId, { limit: max * 3 });
      if (args.kind === "call") rows = rows.filter((r) => r.kind === "call" || r.kind === "agent_call");
      else if (args.kind === "message") rows = rows.filter((r) => r.kind === "message");
      else if (args.kind === "document") rows = rows.filter((r) => r.kind === "document");
      rows = rows.slice(0, max);
      if (!rows.length) return { ok: true, data: [], speak: "I don't have any recorded tasks yet." };
      const lines = rows.map((r) => {
        const when = new Date(Number(r.updated_at)).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
        return `${when}: ${outcomes.describe(r)}`;
      });
      return { ok: true, data: rows.map(outcomes.toClient), speak: lines.join(". ") };
    },
  });

  registry.register({
    name: "list_my_errands",
    description:
      "List the errands the assistant has run for the user — orders, rides, tickets " +
      "and bookings — with their real status. Use for 'what have you booked', " +
      "'did the restaurant confirm', 'what happened with my appointment'.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        active_only: { type: "boolean", description: "Only errands still in progress" },
      },
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const fstore = require("../fulfillment/store");
      const rows = await fstore.list(ctx.userId, { activeOnly: args.active_only === true });
      if (!rows.length) {
        return { ok: true, data: [], speak: "I haven't run any errands for you yet." };
      }
      // Spoken form states the PATH, because "handed off" and "confirmed by
      // the restaurant" are very different promises.
      const lines = rows.slice(0, 5).map((r) => {
        if (r.status === "confirmed" && r.outcome) return `${r.title} — ${r.outcome}`;
        if (r.status === "handed_off") return `${r.title} — I opened the app; you finished it there`;
        if (r.status === "calling") return `${r.title} — I'm on the phone with them now`;
        if (r.status === "failed") return `${r.title} — didn't work out: ${r.outcome || "unknown"}`;
        return `${r.title} — ${r.status}`;
      });
      return { ok: true, data: rows, speak: lines.join(". ") };
    },
  });
}

/**
 * Best-effort epoch-ms for a spoken time ("tomorrow at 7pm"), in the user's
 * local frame. Returns null when the phrase carries no time — the ledger
 * stores NULL rather than a guessed timestamp.
 */
/** "in 2 hours", "tomorrow", "on Friday" — spoken, not ISO. */
function relative(ms, now) {
  const d = Math.round((ms - now) / 60000);
  if (d < 60) return `in ${Math.max(1, d)} minutes`;
  if (d < 24 * 60) return `in ${Math.round(d / 60)} hours`;
  const days = Math.round(d / (60 * 24));
  if (days === 1) return "tomorrow";
  if (days < 7) return `in ${days} days`;
  return `in ${Math.round(days / 7)} weeks`;
}

function parseWhenMs(when, tzOffsetMin) {
  if (!when) return null;
  try {
    const chrono = require("chrono-node");
    const off = Number.isFinite(Number(tzOffsetMin)) ? Number(tzOffsetMin) : 330;
    const ref = new Date(Date.now() + off * 60_000);
    const d = chrono.parseDate(String(when), ref, { forwardDate: true });
    return d ? d.getTime() - off * 60_000 : null;
  } catch (_) {
    return null;
  }
}


/**
 * Readable text out of an HTML document, without a parser dependency.
 *
 * Deliberately crude and deliberately ordered: script, style, nav, header,
 * footer and aside go FIRST, because their content is the noise that
 * otherwise dominates a news page and pushes the article out of the 8 kB
 * budget. What remains collapses to paragraphs.
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
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
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
        rsquo: "\u2019", lsquo: "\u2018", ldquo: "\u201c", rdquo: "\u201d",
      })[e] || " ")
    .replace(/&#x?[0-9a-f]+;/gi, " ");
}

module.exports = { registerBuiltins };
