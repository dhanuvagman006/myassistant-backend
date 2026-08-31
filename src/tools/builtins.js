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
    async execute(args) {
      const items = await news.getHeadlines({ topic: args.topic });
      if (!items || !items.length) {
        return { ok: false, error: "no headlines found" };
      }
      return { ok: true, data: items, speak: news.describe(items, args.topic) };
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
    name: "search_places",
    description:
      "Find nearby places: restaurants, hospitals, ATMs, shops, petrol pumps. " +
      "Returns names, distance, rating and phone where available.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, e.g. 'dosa restaurant'" },
      },
      required: ["query"],
    },
    async execute(args, ctx) {
      const list = await places.searchPlaces({
        q: args.query,
        lat: ctx.lat,
        lng: ctx.lng,
      });
      if (!list || !list.length) return { ok: false, error: "no places found" };
      return { ok: true, data: list, speak: places.describePlaces(list) };
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
      "personal context would improve the answer.",
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
      const when = args.when ? Date.parse(args.when) : NaN;
      const e = await mem.addEvent(ctx.userId, {
        title: args.title,
        whenAt: Number.isFinite(when) ? when : null,
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
      "(relationship, organisation, notes, linked documents). Use for " +
      "'what do you know about Ravi', 'tell me about my client X'.",
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
      properties: { name: { type: "string", description: "Person's name" } },
      required: ["name"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const found = await mem.findPerson(ctx.userId, args.name);
      if (!found) return { ok: false, error: `no person named ${args.name}` };
      const list = await mem.documentsFor(ctx.userId, "person", found.id);
      const profile = await mem.recallAbout(ctx.userId, args.name);
      const all = profile ? profile.documents : list;
      if (!all.length) return { ok: false, error: `no documents stored for ${args.name}` };
      return { ok: true, data: all, deviceAction: { type: "documents", documents: all } };
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
      const list = await docs.searchDocuments(ctx.userId, args.query);
      if (!list || !list.length) return { ok: false, error: "no matching documents" };
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
      },
      required: ["query"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const intel = require("../docs/intelligence");
      const r = await intel.findDocuments(ctx.userId, args.query, { person: args.person });
      if (!r.found) {
        return {
          ok: false,
          error: r.scope
            ? `no documents for ${r.scope} matching that`
            : "no matching documents",
        };
      }
      return { ok: true, data: r.documents, deviceAction: { type: "documents", documents: r.documents } };
    },
  });

  registry.register({
    name: "associate_document",
    description:
      "Link the most recent (or a named) document to a person and/or case — " +
      "'this document belongs to Ravi's case'.",
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

  registry.register({
    name: "create_reminder",
    description:
      "Create a reminder or task for the user, optionally with a due time.",
    risk: "medium",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to be reminded of" },
        due_at: {
          type: "string",
          description: "ISO-8601 datetime, or omit if no specific time",
        },
      },
      required: ["text"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const due = args.due_at ? new Date(args.due_at) : null;
      const r = await reminders.create(
        ctx.userId,
        args.text,
        due && !isNaN(due.getTime()) ? due.getTime() : null
      );
      if (!r) return { ok: false, error: "could not save the reminder" };
      return { ok: true, data: r, speak: "Saved." };
    },
  });

  registry.register({
    name: "list_reminders",
    description: "List the user's upcoming reminders and tasks.",
    risk: "low",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const list = await reminders.list(ctx.userId);
      return { ok: true, data: list };
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
      const a = await userCtx.setAssistantProfile(ctx.userId, args);
      return {
        ok: true,
        data: a,
        speak: args.name ? `From now on I'm ${a.name}.` : "Done.",
      };
    },
  });

  // ---------------- DEVICE ACTIONS ----------------
  // These CANNOT be performed by the server. Android/iOS require the app to
  // initiate them, so the tool returns an authorized action for the app and
  // the app reports the real outcome. The agent must never claim success.

  registry.register({
    name: "place_phone_call",
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
      "phone dials the contact directly for the user to speak.",
    risk: "high",
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
    async execute(args) {
      // The app decides HOW to act on this from agent_available: with a
      // message and the relay configured it asks the server to place the
      // call (Hari speaks it herself); otherwise it dials directly.
      const agentAvailable = require("../agents/agentCall").enabled();
      const relaying = Boolean(args.message) && agentAvailable;
      return {
        ok: true,
        deviceAction: {
          type: "resolve_and_call",
          name: args.name,
          message: args.message || null,
          agent_available: agentAvailable,
        },
        // Deliberately NOT "I called them" — nothing has dialled yet.
        speak: relaying
          ? `Alright — I'll call ${args.name} and pass that on, then tell you how it went.`
          : args.message
            ? `I can't speak on calls myself on this setup, so I'm connecting you to ${args.name} directly.`
            : `Calling ${args.name}…`,
      };
    },
  });

  registry.register({
    name: "capture_document",
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
      // Ensure the person exists in memory NOW, so "what do you know about
      // Prasant" works even if the capture is cancelled — and the upload
      // that follows links to this same record by name.
      if (args.person && ctx.userId) {
        try {
          await mem.upsertPerson(ctx.userId, { name: args.person });
        } catch (_) {}
      }
      return {
        ok: true,
        deviceAction: {
          type: "capture_document",
          note: args.note || null,
          person: args.person || null,
          client_id: args.client_id || null,
          source: args.source || "ask",
        },
        speak: args.source === "gallery" ? "Please select the file." : "Opening the capture screen.",
      };
    },
  });

  registry.register({
    name: "analyze_camera",
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
      "'put on some Arijit Singh', 'play my workout playlist'.",
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
        `intent://#Intent;action=android.media.action.MEDIA_PLAY_FROM_SEARCH;` +
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
      "words; keep it natural and short.",
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
    description: "Set an alarm on the user's phone for a specific time.",
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
      const label = args.label ? `S.android.intent.extra.alarm.MESSAGE=${encodeURIComponent(args.label)};` : "";
      const url = `intent://#Intent;action=android.intent.action.SET_ALARM;i.android.intent.extra.alarm.HOUR=${args.hour};i.android.intent.extra.alarm.MINUTES=${args.minute};${label}end`;
      return {
        ok: true,
        deviceAction: { type: "open_url", url },
        speak: `Setting an alarm for ${args.hour}:${args.minute < 10 ? '0' + args.minute : args.minute}.`,
      };
    }
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
      "Open ANY website on the user's phone — 'open the income tax filing " +
      "site', 'open irctc', 'open github.com'. YOU supply the URL: for a " +
      "named service use its well-known OFFICIAL domain (income tax India " +
      "e-filing → https://eportal.incometax.gov.in, IRCTC → " +
      "https://www.irctc.co.in, DigiLocker → https://www.digilocker.gov.in). " +
      "Prefer the dedicated tools for YouTube, shopping, food, cabs and " +
      "movies; this one is for everything else on the web.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Full URL of the page to open. https:// is assumed if missing.",
        },
        label: {
          type: "string",
          description:
            "Short human name of the site ('the income tax portal') for the spoken confirmation.",
        },
      },
      required: ["url"],
    },
    async execute(args) {
      let url = String(args.url || "").trim();
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
    name: "generate_image",
    description:
      "CREATE an image from a description — 'draw a poster for my café', " +
      "'make a picture of a beach house at sunset', 'design a birthday " +
      "card for amma', 'generate a logo'. Write a vivid, detailed prompt " +
      "from what the user asked (style, colors, mood, composition). The " +
      "image appears on their screen and is saved to their documents. " +
      "Takes a few seconds — never refuse a creative request.",
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
      },
      required: ["prompt"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const prompt = String(args.prompt || "").trim().slice(0, 1400);
      if (!prompt) return { ok: false, error: "describe what to draw" };
      try {
        const { generateImage } = require("../services/imagegen");
        const img = await generateImage(prompt);
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
            summary: `Image generated by Hari from: ${prompt}`,
            tags: ["generated", "ai-art"],
            fullText: `AI-generated image. Prompt: ${prompt}`,
          })
          .catch(() => null);
        return {
          ok: true,
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
      "waves at sunset'. If video isn't enabled on the current plan it " +
      "says so; then OFFER to create it as an image instead (generate_image " +
      "always works).",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Rich visual description of the video to create.",
        },
      },
      required: ["prompt"],
    },
    async execute(args, ctx) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const prompt = String(args.prompt || "").trim().slice(0, 1400);
      if (!prompt) return { ok: false, error: "describe the video" };
      try {
        const { tryVeoVideo } = require("../services/imagegen");
        const vid = await tryVeoVideo(prompt);
        if (!vid) {
          return {
            ok: true,
            data: {
              result:
                "Video generation is not enabled on the current plan yet. " +
                "Tell the user video is coming soon, and offer to create " +
                "this as a stunning image right now instead (generate_image).",
            },
          };
        }
        const docs = require("../docs/store");
        const row = await docs.createDocument(ctx.userId, {
          buffer: vid.buffer,
          filename: `hari-video-${Date.now()}.mp4`,
          mime: vid.mime,
          note: prompt,
        });
        return {
          ok: true,
          deviceAction: {
            type: "show_video",
            doc_id: row.id,
            prompt,
            document: docs.toClient(row),
          },
          speak: "Your video is ready — it's saved in your files.",
        };
      } catch (e) {
        console.error("generate_video:", e.message);
        return { ok: false, error: "Video generation failed — offer an image instead." };
      }
    },
  });

  registry.register({
    name: "open_service_app",
    description:
      "Open a shopping or grocery app for the user — Blinkit, Zepto, Amazon, " +
      "Flipkart, MakeMyTrip, YouTube — searching for something if given. " +
      "For food delivery use order_food, for cabs use book_ride, for cinema " +
      "tickets use book_movie_tickets: those resolve the real target first.",
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
      "Search the live web for current information the assistant would not " +
      "otherwise know: today's events, prices, company news, facts that change.",
    risk: "low",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
    async execute(args) {
      const search = require("./webSearch");
      return search.run(args.query);
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
      "user to choose between WhatsApp and a call first. Use " +
      "send_whatsapp_message ONLY when the user explicitly says WhatsApp. " +
      "If the recipient turns out not to be reachable this way, this tool " +
      "says so — offer WhatsApp then.",
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
        return { 
          ok: true, 
          data: "User not on app.", 
          speak: `${args.contact_name} is not using the app yet. Would you like me to draft an SMS invitation so they can download it?` 
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

      return { ok: true, data: "Message sent.", speak: `I have sent the message directly to ${args.contact_name}'s assistant.` };
    }
  });

  // ---------------- FULFILLMENT: BOOKING BY REAL PHONE CALL ----------------
  //
  // This tool used to be a mock: it slept three seconds and told the user
  // "I spoke to their receptionist and your appointment is confirmed" —
  // without dialling anything. That is the exact failure §28 exists to
  // prevent, and the user would have discovered it by turning up at a
  // clinic that had never heard of them.
  //
  // It now uses the real Plivo agent-call engine that was already in the
  // codebase (src/agents/agentCall.js), pointed at a business number
  // resolved from Google Places. Hari genuinely dials, genuinely asks, and
  // reports what the business genuinely said. When telephony is not
  // configured on this deployment, it says so instead of pretending.

  registry.register({
    name: "book_by_calling_business",
    // Hidden without telephony — she genuinely cannot dial.
    available: () => require("../agents/agentCall").enabled(),
    description:
      "Actually telephone a business and speak to them to arrange something: " +
      "a doctor/dentist/salon appointment, a restaurant table, or an order " +
      "for collection. Hari places the call herself and reports what they " +
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
      "the app. Use for 'order biryani', 'get me pizza from Domino's'. For " +
      "a table reservation or a collection order use book_by_calling_business.",
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
    // Same: negotiating a meeting means phoning someone.
    available: () => require("../agents/agentCall").enabled(),
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
      "Recall a recent meeting Hari captured — what was decided, who agreed " +
      "to what, and the follow-up she drafted. Use for 'what did we decide " +
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
      "Read back the calls Hari answered on the user's behalf while they " +
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

  registry.register({
    name: "list_my_errands",
    description:
      "List the errands Hari has run for the user — orders, rides, tickets " +
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

module.exports = { registerBuiltins };
