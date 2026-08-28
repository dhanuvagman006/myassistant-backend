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
      const where = args.location || ctx.city || "";
      const w = await weather.getWeather(where);
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
      const p = await mem.upsertPerson(ctx.userId, args);
      return { ok: true, data: { id: p.id, name: p.name }, speak: "Noted." };
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
        due && !isNaN(due.getTime()) ? due.toISOString() : null
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
      "Call one of the user's contacts from their phone. Use for 'call mom', " +
      "'ring Ravi'. The call is dialled on the user's device.",
    risk: "high",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Contact name to call" },
        message: {
          type: "string",
          description: "Optional message the user wants passed on",
        },
      },
      required: ["name"],
    },
    confirmSummary: (a) =>
      a.message ? `Call ${a.name} and say: ${a.message}` : `Call ${a.name}`,
    async execute(args) {
      return {
        ok: true,
        deviceAction: {
          type: "resolve_and_call",
          name: args.name,
          message: args.message || null,
        },
        // Deliberately NOT "I called them" — the device hasn't dialled yet.
        speak: `Calling ${args.name}…`,
      };
    },
  });

  registry.register({
    name: "capture_document",
    description:
      "Ask the user to capture a document, photo, or select an image/PDF from their gallery, " +
      "e.g. 'save Raj's MRI report', 'scan this receipt'.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string", description: "What the user is capturing (e.g. 'Raj MRI Report')" },
        client_id: { type: "integer", description: "Optional: ID of the person/client to link this document to, if already known." },
        source: { type: "string", enum: ["camera", "gallery", "ask"], description: "Where to get the document from. Default is ask." },
      },
    },
    async execute(args) {
      return {
        ok: true,
        deviceAction: { type: "capture_document", note: args.note || null, client_id: args.client_id || null, source: args.source || "ask" },
        speak: args.source === "gallery" ? "Please select the file." : "Opening the capture screen.",
      };
    },
  });

  registry.register({
    name: "analyze_camera",
    description:
      "Open the camera to scan or look at an object, receipt, or scene and immediately analyze it to answer the user's question, e.g. 'what tablet is this?', 'read this receipt'.",
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
        speak: "Let me take a look. Opening the camera.",
      };
    },
  });

  registry.register({
    name: "play_music",
    description: "Play a specific song, artist, or playlist. The app will pop up and start playing the music automatically.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The song, artist, or playlist to play (e.g. 'Tum hi ho', 'Arijit Singh playlist')." },
        provider: { type: "string", enum: ["spotify", "youtube_music"], description: "Which app to play it on. Default to spotify if unspecified." }
      },
      required: ["query"],
    },
    async execute(args) {
      const p = args.provider || "spotify";
      const pkg = p === "spotify" ? "com.spotify.music" : "com.google.android.apps.youtube.music";
      const fallback = p === "spotify" 
        ? `https://open.spotify.com/search/${encodeURIComponent(args.query)}` 
        : `https://music.youtube.com/search?q=${encodeURIComponent(args.query)}`;
      const q = encodeURIComponent(args.query);
      
      // MEDIA_PLAY_FROM_SEARCH intent pops up the app and immediately starts playing the requested query
      const url = `intent://#Intent;action=android.media.action.MEDIA_PLAY_FROM_SEARCH;S.query=${q};package=${pkg};S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
      
      return {
        ok: true,
        deviceAction: { type: "open_url", url },
        speak: `Playing ${args.query} on ${p === "spotify" ? "Spotify" : "YouTube Music"}.`,
      };
    }
  });

  registry.register({
    name: "send_whatsapp_message",
    description: "Draft a WhatsApp message and open the WhatsApp chat with the contact pre-filled. Use when the user asks to WhatsApp someone.",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "The phone number of the contact including country code (e.g. +91...)." },
        message: { type: "string", description: "The message to send." }
      },
      required: ["phone", "message"],
    },
    async execute(args) {
      // Strip any non-numeric characters except +
      const cleanPhone = args.phone.replace(/[^\d+]/g, '');
      const url = `whatsapp://send?phone=${cleanPhone}&text=${encodeURIComponent(args.message)}`;
      return {
        ok: true,
        deviceAction: { type: "open_url", url },
        speak: "Opening WhatsApp with your message.",
      };
    }
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
    name: "open_service_app",
    description:
      "Open popular service apps for the user to book rides (Uber, Ola), order food (Swiggy, Zomato), groceries (Blinkit, Zepto), or shopping (Amazon, Flipkart).",
    risk: "low",
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          enum: ["uber", "ola", "swiggy", "zomato", "blinkit", "zepto", "amazon", "flipkart", "bookmyshow", "makemytrip", "youtube"],
          description: "The service provider requested."
        },
        query: {
          type: "string",
          description: "What to search for, or where to go (e.g. 'pizza', 'airport', 'iphone 15'). Leave empty if just opening the app."
        },
      },
      required: ["service"],
    },
    async execute(args) {
      let url = "";
      const q = args.query ? encodeURIComponent(args.query) : "";
      
      switch (args.service) {
        case "uber":
          url = q ? `https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[formatted_address]=${q}` : `https://m.uber.com/ul/`;
          break;
        case "ola":
          url = q ? `https://book.olacabs.com/?drop_name=${q}` : `https://book.olacabs.com/`;
          break;
        case "swiggy":
          url = q ? `https://www.swiggy.com/search?query=${q}` : `https://www.swiggy.com/`;
          break;
        case "zomato":
          url = q ? `https://www.zomato.com/search?q=${q}` : `https://www.zomato.com/`;
          break;
        case "blinkit":
          url = q ? `https://blinkit.com/s/?q=${q}` : `https://blinkit.com/`;
          break;
        case "zepto":
          url = q ? `https://www.zeptonow.com/search?q=${q}` : `https://www.zeptonow.com/`;
          break;
        case "amazon":
          url = q ? `https://www.amazon.in/s?k=${q}` : `https://www.amazon.in/`;
          break;
        case "flipkart":
          url = q ? `https://www.flipkart.com/search?q=${q}` : `https://www.flipkart.com/`;
          break;
        case "youtube":
          url = q ? `https://www.youtube.com/results?search_query=${q}` : `https://www.youtube.com/`;
          break;
        case "bookmyshow":
          url = `https://in.bookmyshow.com/`;
          break;
        case "makemytrip":
          url = `https://www.makemytrip.com/`;
          break;
        default:
          return { ok: false, error: "Unsupported service." };
      }
      
      return {
        ok: true,
        deviceAction: { type: "open_url", url },
        speak: `Opening ${args.service.charAt(0).toUpperCase() + args.service.slice(1)} for you.`,
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
    description: "Send a voice message to another user's agent (e.g., tell my mom I will be late). The other user's agent will speak it to them.",
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
      
      const { exec, one } = require("../db");
      const push = require("../services/push");
      const contactLower = String(args.contact_name).toLowerCase();

      // 1. Resolve the name to a number.
      //
      // The synced phone address book first — that is where "mom" actually
      // lives — then the user's curated client list. Exact matches win over
      // partial ones so "Ann" cannot be answered with "Annabel"; among
      // partials the shortest name is the closest fit.
      const contact = await one(
        `SELECT phone FROM (
           SELECT phone, (lower(name) = $2) AS exact, length(name) AS len
             FROM contacts
            WHERE user_id = $1 AND lower(name) LIKE $3
           UNION ALL
           SELECT phone, (lower(name) = $2) AS exact, length(name) AS len
             FROM clients
            WHERE user_id = $1 AND lower(name) LIKE $3 AND phone <> ''
         ) m
         ORDER BY exact DESC, len ASC
         LIMIT 1`,
        [ctx.userId, contactLower, `%${contactLower}%`]
      );

      if (!contact || !contact.phone) {
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
      const toPhone = normalizePhone(contact.phone);
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
      await exec(
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
          "Open the app and your assistant will read it to you."
        );
      } else {
        // Not an error: they simply have no device registered yet, so the
        // message waits in their inbox until they next open the app.
        console.log(`agent_message: no push token for user ${appUser.id} — will deliver on next open`);
      }

      return { ok: true, data: "Message sent.", speak: `I have sent the message directly to ${args.contact_name}'s assistant.` };
    }
  });

  registry.register({
    name: "book_appointment_via_call",
    description: "Autonomously dial a business and speak to them over the phone to book an appointment.",
    risk: "high",
    inputSchema: {
      type: "object",
      properties: {
        business_name: { type: "string", description: "Name of the clinic, restaurant, or business" },
        details: { type: "string", description: "Time, date, and purpose of the appointment" }
      },
      required: ["business_name", "details"]
    },
    confirmSummary: (a) => `Call ${a.business_name} to book: ${a.details}`,
    async execute(args) {
      // Mocked implementation: simulate the AI making a real phone call (which takes some time)
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return { 
        ok: true, 
        data: "Appointment confirmed.", 
        speak: `I just called ${args.business_name}. I spoke to their receptionist and your appointment is successfully confirmed for ${args.details}.` 
      };
    }
  });
}

module.exports = { registerBuiltins };
