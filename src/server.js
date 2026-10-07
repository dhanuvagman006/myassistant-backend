require("dotenv").config();
const express = require("express");
// Express 4 never routes an ASYNC handler's rejection to the error
// middleware — the rejection went unhandled and Node killed the whole
// pod (one malformed /docs/:id/file dropped every live session). Patch
// the router layer once (the express-async-errors technique) so every
// async route funnels into the JSON error handler below.
{
  const Layer = require("express/lib/router/layer");
  const copy = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function (req, res, next) {
    const fn = this.handle;
    if (fn.length <= 3) {
      const out = (() => { try { return fn(req, res, next); } catch (e) { return next(e); } })();
      if (out && typeof out.catch === "function") out.catch(next);
      return;
    }
    return copy.call(this, req, res, next);
  };
}
// Belt for everything that is not a request (timers, sockets): log loudly,
// never exit — an assistant mid-conversation must survive a stray bug.
process.on("unhandledRejection", (e) => {
  console.error("UNHANDLED REJECTION (kept alive):", e && (e.stack || e.message || e));
});
process.on("uncaughtException", (e) => {
  console.error("UNCAUGHT EXCEPTION (kept alive):", e && (e.stack || e.message || e));
});
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// Sessions are signed with this — the server can't run without it.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error("FATAL: JWT_SECRET must be set (32+ random characters).");
  process.exit(1);
}

const configRoute = require("./routes/config");
const chatRoute = require("./routes/chat");
const regionRoute = require("./routes/region");
// The app's old model routes answer 426 "update the app" (src/ai/gone.js).
const { gone } = require("./ai/gone");
const authRoute = require("./routes/auth");
const db = require("./db");
const { appAuth, appFnAuth } = require("./middleware/auth");

// Safety guard: never boot in production with auth switched off.
// This is what actually stops AUTH_DISABLED=true from leaking into prod.
if (process.env.NODE_ENV === "production" && process.env.AUTH_DISABLED === "true") {
  console.error("FATAL: AUTH_DISABLED=true is not allowed in production. Remove it and redeploy.");
  process.exit(1);
}

const app = express();

// OBSERVABILITY: correlation id + structured access log on every request,
// so one voice turn can be traced HTTP -> agent -> tool -> MCP -> database.
const observability = require("./infra/observability");
app.use(observability.requestId());
app.set("trust proxy", 1);
app.use(helmet());

// CORS — native mobile apps don't enforce it, but web-origin callers do:
// any future web client, the avatar WebView page, and local dev tools.
// Permissive-by-default is safe here because real protection is the auth
// layer (JWT / app key), not the origin.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-App-Key, X-TZ-Offset, X-Geo-Lat, X-Geo-Lng, X-Style-Tone, X-Style-Length, Last-Event-ID"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- METRICS (/metrics, Prometheus format) ----
// Powers the external monitoring VPS: request rate, latency histograms,
// status codes per route, plus Node process/heap defaults.
// Protected by METRICS_TOKEN when set (send: Authorization: Bearer <token>)
// so the endpoint can sit behind the public ingress without leaking
// traffic patterns to the world.
const promBundle = require("express-prom-bundle");
const { safeEqual } = require("./services/safeCompare");
app.use((req, res, next) => {
  const t = process.env.METRICS_TOKEN;
  // The same shape promBundle serves (/metrics and /metrics/), matched
  // case-insensitively as Express routes are: an exact "/metrics" test let
  // GET /metrics/ straight past the token.
  if (t && /^\/metrics\/?$/i.test(req.path) &&
      !safeEqual(req.get("Authorization") || "", `Bearer ${t}`)) {
    return res.status(404).json({ error: "not found" }); // don't advertise
  }
  next();
});
app.use(
  promBundle({
    includeMethod: true,
    includePath: true,
    metricsPath: "/metrics",
    promClient: { collectDefaultMetrics: {} },
    // Collapse ids so metrics stay low-cardinality.
    normalizePath: [
      ["^/docs/\\d+.*", "/docs/#id"],
      ["^/reminders/\\d+", "/reminders/#id"],
      ["^/agent-call/[a-f0-9]{16,}", "/agent-call/#id"],
      ["^/admin-panel/api/recordings/\\d+.*", "/admin-panel/api/recordings/#id"],
      ["^/admin-panel/api/video-notes/\\d+.*", "/admin-panel/api/video-notes/#id"],
      ["^/posters/photos/\\d+.*", "/posters/photos/#id"],
      ["^/posters/\\d+.*", "/posters/#id"],
      ["^/shortcuts/runs/\\d+.*", "/shortcuts/runs/#id"],
      ["^/shortcuts/\\d+.*", "/shortcuts/#id"],
      ["^/mailin/messages/\\d+.*", "/mailin/messages/#id"],
    ],
  })
);
// Routes that declare their own (larger) JSON limit must skip this global
// 2 MB parser — it runs first, so a photo over ~1.5 MB sent to
// /ai/generate was refused before the route's 25 MB limit ever applied.
const OWN_BODY_LIMIT = new Set(["/ai/generate"]);
const globalJson = express.json({
    limit: "2mb",
    // Razorpay signs the RAW bytes — keep them for webhook verification.
    //
    // This was an empty stub: the comment said the bytes were kept but
    // nothing kept them, so any signature check would have compared
    // against undefined and rejected every legitimate webhook. Only the
    // payment webhook path needs it, so nothing else pays the memory.
    verify: (req, _res, buf) => {
      if (req.originalUrl && req.originalUrl.startsWith("/payments/webhook")) {
        req.rawBody = buf;
      }
    },
  });
app.use((req, res, next) =>
  OWN_BODY_LIMIT.has(req.path) ? next() : globalJson(req, res, next)
);

// Basic abuse protection, per IP. A voice turn costs several requests
// (audio upload + one /tts per spoken sentence + session traffic), so a
// lively continuous conversation legitimately reaches ~10-15 req/min —
// 60 was close enough that a fast talker hit 429s and the app silently
// dropped to the robotic on-device voice. 240 keeps abuse out without
// throttling real use.
app.use(rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true }));

app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Public within the app: remote config (no secrets inside it)
app.use("/config", configRoute);

// Public APK download for the self-hosted update channel (sideload builds)
app.use("/app", require("./routes/appUpdate").router);

// Sign-up/sign-in — extra-tight limit to slow brute-force attempts
app.use(
  "/auth",
  rateLimit({ windowMs: 15 * 60_000, max: 20, standardHeaders: true }),
  authRoute
);

// PER-USER rate limit (on top of the per-IP one): a single hot account
// can't drain the AI quota for everyone behind the same NAT/proxy.
const perUserLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  keyGenerator: (req) => String(req.user?.sub || req.ip),
});

// PHOTO CARDS get their OWN per-user bucket (2026-09-26). perUserLimit is
// one 30/min bucket shared by /chat, /agent-call, /avatar-profile and
// /studio, so a card screen fetching photos and saving edits would starve
// the conversation talking about that very card.
const posterLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  keyGenerator: (req) => String(req.user?.sub || req.ip),
});

// SHORTCUTS get their own per-user bucket too (2026-09-27): the Hub list,
// a Run tap and its yes must never starve the voice turns. Creating and
// changing one can cost a model call; that has its own daily cap
// (shortcuts/compile.js).
const shortcutLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  keyGenerator: (req) => String(req.user?.sub || req.ip),
});

// THE CONVERSATION gets its own per-user bucket too (2026-09-29). Since
// the app runs its models itself (Firebase AI Logic), one turn is several
// small requests here — /ai/context, a /ai/tool per tool call, /ai/turn —
// and none of them calls a model. In the shared 30/min bucket, beside the
// app's own /chat polling, a lively voice conversation would meet 429s
// mid-sentence.
const aiLimit = rateLimit({
  windowMs: 60_000,
  max: 180,
  standardHeaders: true,
  keyGenerator: (req) => String(req.user?.sub || req.ip),
});

// AGENT CALLS — Hari phones a contact (or the user themself) and reports
// back. The provider webhook is PUBLIC (Bolna can't send our app key):
// gated by a key-derived URL secret, mounted before appAuth.
const agentCall = require("./routes/agentCall");
app.use("/agent-call/bolna", agentCall.bolnaWebhooks);
app.use("/agent-call", appAuth, perUserLimit, agentCall.router);
// (Hub → Your calling agent was removed on 2026-09-21 at his direction.
// Every call now uses the one agent defined in agents/callAgentConfig.js,
// so a change to how it speaks reaches every user at once.)

// INBOUND CALLING — Hari answers the user's own number: screens callers,
// forwards the ones who matter, takes a message from the rest.
// Plivo's webhooks are PUBLIC (it cannot send our app key) and so must be
// mounted before appAuth; the follow-up hooks carry a per-call token in the
// path. Number assignment is an ADMIN action, guarded by ADMIN_KEY.
const inbound = require("./inbound/routes");
app.use("/inbound/plivo", inbound.webhooks);
app.use("/inbound/admin", inbound.adminRouter);
app.use("/inbound", appAuth, inbound.router);

// Chat requires the app key so strangers can't burn your AI credits.
// Order: authenticate → per-user throttle → plan allowance → handler.
//
// ONE MOUNT, TWO ROUTERS. Groups and direct chat were mounted separately
// on the same path with the same rate-limiter instance, so any request
// that fell through the groups router to this one was counted TWICE —
// silently halving the budget to 15/min, which the app's own polling
// nearly exhausts on its own — and re-ran appAuth. Listing both handlers
// on one mount runs the middleware once and keeps the order (groups are
// matched first; chat.js registers /thread/:phone, never a bare /:phone,
// so nothing was ever at risk of being shadowed either way).
// The assistant's own chat turns (POST /chat, /chat/stream, /chat/greeting)
// are the app's model now: an old build that asks is told to update. The
// human chat below (threads, send, groups) is unchanged.
app.post("/chat", gone);
app.all(["/chat/stream", "/chat/greeting"], gone);
app.use("/chat", appAuth, perUserLimit, require("./routes/chatGroups"), chatRoute);

// THE ASSISTANT (2026-09-29) — the app runs its models itself (Gemini Nano
// on the phone, Gemini through Firebase AI Logic); this server is its tool
// server and memory: context, tools, approvals and the record (src/ai/).
app.use("/ai", appAuth, aiLimit, require("./ai/routes"));
// The voice loop that came before it (session, SSE stream, audio and text
// turns, confirmations) is gone: old builds are told to update.
app.use("/assistant", gone);

// Onboarding survey + profile view (feeds users table + agent memory).
app.use("/profile", appAuth, require("./routes/profile"));
app.use("/nearby", appAuth, perUserLimit, require("./routes/nearby"));
app.use("/phone", appAuth, require("./routes/phone"));
// In-app dialer: call analysis uploads, history and the consent toggle.
app.use("/calls", appAuth, require("./routes/calls").router);
app.use("/contacts", appAuth, require("./routes/contacts"));

// Phase 1 / ADR-004 — the user-visible audit trail of assistant actions.
app.use("/actions", appAuth, require("./routes/actions"));

// Privacy dashboard (F2): full data export + permanent account deletion.
app.use("/privacy", appAuth, require("./routes/privacy"));

// Google account link: Gmail + Calendar (read-only).
app.use("/google", appAuth, require("./google/routes"));

// CONNECTED APPS — Notion. The OAuth callback is public (Notion sends the
// browser there; the single-use state names the user) and rate-limited;
// the rest is behind the app's auth. Inert until NOTION_CLIENT_ID/SECRET.
{
  const notion = require("./connectors/notion/routes");
  app.use("/connect/notion",
    rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true }), notion.publicRouter);
  app.use("/connections", appAuth, notion.appRouter);
  // Other connected apps (2026-10-04): standard OAuth 2, after Notion's routes.
  const apps = require("./connectors/apps");
  app.use("/connect/app",
    rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true }), apps.publicRouter);
  app.use("/connections", appAuth, apps.appRouter);
}


// PAYMENTS — collection requests. Razorpay's webhook is PUBLIC (it cannot
// carry our app key) and is verified by HMAC over the raw body instead, so
// it must be mounted before appAuth.
const paymentRoutes = require("./payments/routes");
app.use("/payments", paymentRoutes.webhooks);
app.use("/payments", appAuth, paymentRoutes.router);

// MEETINGS — record or upload, get back decisions, action items and a
// drafted follow-up. The user's own action items enter the commitment
// tracker so they are nudged before they slip.
app.use("/meetings", appAuth, require("./meetings/routes"));

// Reminders (voice-created via /chat intents + Today screen CRUD).
app.use("/reminders", appAuth, require("./reminders/routes"));
app.use("/commitments", appAuth, require("./routes/commitments"));
// MOMENTUM — Today's 3, habits, focus and the streak (momentum/routes.js).
app.use("/momentum", appAuth, require("./momentum/routes"));
app.use("/messages", appAuth, require("./routes/messages"));
app.use("/usage", appAuth, require("./routes/usage").router);
app.use("/finance", appAuth, require("./routes/finance").router);

// TODAY BRIEF — one aggregate fetch for the home dashboard (agenda,
// promises, unread agent messages, circle, weather, headlines).
app.use("/brief", appAuth, require("./routes/brief"));
// NEWS CARDS (2026-09-25) — Hub → News reads its deck from here.
app.use("/news", appAuth, require("./routes/news"));
// Multi-step plans the assistant has committed to: what is running,
// what it is waiting on, and the phone's receipts for dispatched steps.
app.use("/tasks", appAuth, require("./routes/tasks"));
app.use("/email", appAuth, require("./routes/email"));
// Bills by email: the private address and what arrived (off unless MAILIN_ENABLED=1).
app.use("/mailin", appAuth, require("./mailin/routes").router);

// ADMIN — read-only ops stats behind a static key (set ADMIN_KEY).
app.use("/admin", require("./routes/admin"));

// Live data for the Today screen (weather card, headlines, astrology).
const wxTool = require("./services/tools/weather");
const newsTool = require("./services/tools/news");
const astroTool = require("./services/tools/astrology");
app.get("/tools/weather", appAuth, async (req, res) => {
  try {
    const w = await wxTool.getWeather({
      lat: parseFloat(req.query.lat),
      lng: parseFloat(req.query.lng),
      city: req.query.city,
    });
    if (!w) return res.status(400).json({ error: "lat/lng or city required" });
    res.json(w);
  } catch (e) {
    res.status(502).json({ error: "weather unavailable" });
  }
});
// Home's weather card (2026-09-30): now, 24 hours and the week, named by
// the area the phone is in. Location from the query or the X-Geo headers
// every app request carries; the name is looked up once a day per ~1 km
// and never holds the card up for more than 2.5 s.
const wxPlaces = new Map(); // "12.97,77.59" → { ts, name }
app.get("/tools/weather/forecast", appAuth, async (req, res) => {
  let lat = parseFloat(req.query.lat);
  let lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    lat = parseFloat(req.get("X-Geo-Lat"));
    lng = parseFloat(req.get("X-Geo-Lng"));
  }
  const city = typeof req.query.city === "string" ? req.query.city : undefined;
  try {
    const place = async () => {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const k = `${lat.toFixed(2)},${lng.toFixed(2)}`;
      const hit = wxPlaces.get(k);
      if (hit && Date.now() - hit.ts < 24 * 3600_000) return hit.name;
      const p = await require("./tools/builtins").reverseGeocode(lat, lng);
      const name = (p && (p.area || p.city)) || null;
      if (name) wxPlaces.set(k, { ts: Date.now(), name });
      return name;
    };
    const [w, name] = await Promise.all([
      wxTool.forecast({ lat, lng, city }),
      Promise.race([place().catch(() => null), new Promise((r) => setTimeout(() => r(null), 2500))]),
    ]);
    if (!w) return res.status(400).json({ error: "lat/lng or city required" });
    // The neighbourhood from the phone's own position first; OpenWeatherMap's
    // label is the nearest city ("Mangaluru"), coarser than where they are.
    res.json({ ...w, label: (Number.isFinite(lat) && name) || w.label || name || null });
  } catch (e) {
    res.status(502).json({ error: "weather unavailable" });
  }
});
// Holidays (India + Kerala), festivals, world days and global events for
// the Calendar screen: ?from=&to= (≤ 93 days) or ?y=&m=, region from
// ?region=IN|IN-KL or the X-Geo headers. Curated data; never a 5xx.
app.get("/tools/calendar/extras", appAuth, (req, res) =>
  require("./services/tools/calendarExtras").handler(req, res)
);
app.get("/tools/news", appAuth, async (req, res) => {
  try {
    res.json({
      headlines: await newsTool.getHeadlines({
        topic: req.query.topic,
        max: Math.min(Number(req.query.max) || 6, 30),
      }),
    });
  } catch (e) {
    res.status(502).json({ error: "news unavailable" });
  }
});
app.get("/tools/astrology", appAuth, async (req, res) => {
  try {
    const uid = Number(req.user?.sub);
    let birthday = req.query.birthday;
    let name = "Friend";
    if (uid) {
      const u = await db.findById(uid);
      if (u) {
        if (!birthday && u.birthday) birthday = u.birthday;
        if (u.name) name = u.name;
      }
    }
    const reading = await astroTool.getAstrologyReading({
      birthday,
      name,
      lat: parseFloat(req.query.lat),
      lng: parseFloat(req.query.lng),
    });
    res.json(reading);
  } catch (e) {
    res.status(502).json({ error: "astrology unavailable" });
  }
});

// Speech in, speech out and "what is this" with the camera are the app's
// own now (on-device recognition, Gemini TTS and Nano/cloud vision through
// Firebase AI Logic). Old builds are told to update.
app.use(["/stt", "/tts", "/vision"], gone);

// Group B+ — SAVED documents: hospital reports, receipts… Hari remembers
// them and pulls them back up from a voice request (see routes/docs.js).
app.use("/docs", appAuth, require("./routes/docs"));

// SEND MESSAGES AS YOU (2026-09-26) — consent, the 30-second identity
// video recorded in the app, and the switch; the video notes made from
// it are delivered from the admin panel. Its own hourly upload cap sits
// inside the router, on top of the per-user minute limit here.
app.use("/avatar-profile", appAuth, perUserLimit, require("./routes/avatarProfile"));

// STYLE STUDIO — "show me how I'd look": outfit and hairstyle try-on on
// the user's own photo, professional headshots, spec-correct passport
// photos, old-photo restoration. Paid image models sit behind this, so it
// carries its own per-user daily cap and its own consent record.
app.use("/studio", appAuth, perUserLimit, require("./routes/studio"));

// PHOTO CARDS (2026-09-26) — "make a birthday card for my daughter… with
// my signature": his exact words, a real photo cleaned up without AI, the
// card drawn on the phone. Working photos stay out of /docs; only the
// finished card (and a photo he keeps) becomes a document.
app.use("/posters", appAuth, posterLimit, require("./routes/posters"));
// SHORTCUTS — "office mode": one word, several things (routes/shortcuts.js).
app.use("/shortcuts", appAuth, shortcutLimit, require("./routes/shortcuts"));
// THE SHOPPING LIST and THE KITCHEN (2026-09-29) — one list for anything
// to buy; pantry, recipes and the week plan (src/shopping, src/kitchen).
// Each has its own per-user bucket, so a list screen never starves a turn.
const shopping = require("./shopping");
const kitchen = require("./kitchen");
app.use("/shopping", appAuth, shopping.limiter, shopping.router);
app.use("/kitchen", appAuth, kitchen.limiter, kitchen.router);

// ASSISTANT FUNCTIONS (2026-09-29) — Android AppFunctions: Gemini and other
// system agents add to the list, set reminders, plan Today's 3 and log a
// habit without the app open (src/appfunctions). The phone's background
// service holds a narrow "appfn" key: minted and revoked here by a normal
// session only, accepted on /appfunctions alone — appAuth refuses it on
// every other route. Its own per-user bucket, 60 a minute.
const appfunctions = require("./appfunctions");
app.use("/appfunctions/token", appAuth, appfunctions.limiter, appfunctions.tokenRouter);
app.use("/appfunctions", appFnAuth, appfunctions.limiter, appfunctions.router);

// PROFESSIONAL MODE — per-client/patient case files (doctor, lawyer…):
// profile + dated notes + linked documents, recalled by voice
// ("pull up patient Ramesh's file"). See routes/clients.js.
app.use("/clients", appAuth, require("./routes/clients"));

// TASK OUTCOMES — what the assistant was asked to do and what REALLY
// happened (call connected / failed and why…). Written by the device and by
// the relay webhooks; read by the agent, the app's Activity screen and the
// admin panel. See routes/outcomes.js and outcomes/store.js.
app.use("/outcomes", appAuth, require("./routes/outcomes"));

// Group C — nearby places search (ratings, distance, call & directions).
app.use("/places", appAuth, require("./routes/places"));

// ---------------- STOCKS API ----------------
app.use("/stocks", appAuth, require("./routes/stocks"));

// ---------------- ADMIN ANALYTICS ----------------
app.use("/analytics", appAuth, require("./routes/analytics"));

// ---------------- ADMIN WEB DASHBOARD ----------------
// Note: no appAuth here because this is for the web browser
app.use("/admin-panel", require("./routes/admin_web"));
// Public legal pages — the Play Store listing links to /legal/privacy.
app.use("/legal", require("./routes/legal"));

// Regional language from the caller's IP (no app permissions needed)
app.use("/region", regionRoute);

// MCP servers are per-user configuration, so the route sits behind the
// same auth as the rest of the API.
app.use("/mcp", appAuth, require("./mcp/routes"));

// TOOL REGISTRY — must be populated at BOOT, not on first use.
//
// registerBuiltins() runs as a side effect of loading agents/runtime, and the
// only thing that used to load it was a lazy require inside the classic
// /assistant turn handler. A process where the user only ever spoke through
// LIVE mode therefore declared ZERO tools to the model: no camera, no
// agent-to-agent messages, no reminders. The assistant did not fail loudly —
// it simply said it was unable to do those things, because as far as it knew
// it was. Registering here makes the tool set identical on every path — the
// app's cloud model (/ai) and the server's background agent alike.
require("./agents/runtime");
// SEAL THE CONTRACT once every tool is registered: derive the safety sets
// from what the tools declared about themselves, and report any list that
// names a tool which does not exist. That last check is not theoretical —
// MEMORY_WRITES named "add_instruction" for months, a tool that has never
// existed, so the grounding gate on permanent behaviour rules protected
// nothing. In production this warns loudly rather than refusing to boot;
// outside production it throws, so a typo fails a test run instead.
{
  const registry = require("./tools/registry");
  const sealed = registry.seal();
  console.log(
    `  tools: ${registry.declarations().length} registered` +
    ` (${sealed.counts.world} world, ${sealed.counts.memoryWrites} memory-write,` +
    ` ${sealed.counts.repeatGuarded} repeat-guarded)`
  );
}

// Avatar routes stay under /live (the app's avatar screen). The Live
// speech-to-speech socket and its probe are gone (the app runs its models
// itself): GET /live and a plain request to /live/ws say "update the app",
// and so does the /live/ws upgrade (attached after listen, src/ai/gone.js).
app.use("/live/avatar", appAuth, require("./avatar/routes").router());
app.all(["/live", "/live/ws"], gone);

// Agent-level metrics (tool latency, job counts, agent turns). Mounted at
// /metrics/agent because /metrics already serves Prometheus process
// metrics — two handlers on one path would silently shadow each other.
app.get("/metrics/agent", (req, res) => {
  const want = process.env.METRICS_TOKEN;
  if (want && !safeEqual(String(req.headers["x-metrics-token"] || ""), want)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  res.json(observability.snapshot());
});

// JSON 404 for unmatched routes (instead of Express's default HTML page)
app.use((_req, res) => res.status(404).json({ error: "not found" }));

// Last-resort error handler — also catches malformed JSON bodies
app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "invalid JSON body" });
  }
  if (res.headersSent) return; // a stream already started — nothing to add
  // Body/upload problems carry their own 4xx status (413 too large, 400
  // aborted). Pass it through with a kind sentence instead of a bare 500.
  const status = err.code === "LIMIT_FILE_SIZE" ? 413 : Number(err.status || err.statusCode);
  if (status >= 400 && status < 500) {
    const tooBig = status === 413 || err.type === "entity.too.large" || err.code === "LIMIT_FILE_SIZE";
    return res.status(tooBig ? 413 : status).json({
      error: tooBig
        ? "That file is a little too large for me. Could you try a smaller one?"
        : "Something about that request didn't go through. Please try again.",
    });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Sorry, something went wrong on our side. Please try again in a moment." });
});

const port = process.env.PORT || 3000;
// Postgres: create the schema BEFORE accepting any request — a request
// racing table creation would 500. Boot fails loudly if the DB is down,
// which is exactly what Kubernetes needs to restart/backoff the pod.
require("./db")
  .init()
  // CALL NOTES — before the listener, so a fresh upload is never caught
  // in the sweep of analyses the last restart cut short.
  .then(() =>
    require("./routes/calls")
      .recoverInterrupted()
      .then((r) => {
        if (r.interrupted || r.duplicates) {
          console.log(`  calls: ${r.interrupted} interrupted, ` +
            `${r.duplicates} duplicate(s) flagged`);
        }
      })
      .catch((e) => console.error("  calls recovery failed:", e.message))
      // Same for recorded meetings: their audio went with the old pod.
      .then(() => require("./meetings/service").recoverInterrupted())
      .then((n) => n && console.log(`  meetings: ${n} interrupted recording(s) marked`))
      .catch((e) => console.error("  meetings recovery failed:", e.message)))
  .then(() => {
    // KNOWLEDGE PACKS — seed the reference corpus, embed anything new,
    // and load it into memory.
    //
    // Deliberately NOT awaited: seeding is idempotent and the embedding
    // pass costs a few seconds on the first boot after a pack changes.
    // Blocking the listener on it would delay every restart. Once loaded,
    // retrieval is in-process — no database round-trip on a spoken turn.
    require("./knowledge/engine")
      .seed()
      .then((r) =>
        console.log(
          `  knowledge: ${r.total} entries (${r.inserted} new, ${r.updated} updated, ` +
            `${r.embedded} embedded, ${r.entries} in memory)`
        )
      )
      .catch((e) => console.error("  knowledge seed failed:", e.message));

    // PROACTIVE — commitment nudges and pre-meeting briefs.
    // Background only; a failure here never affects a request.
    try {
      require("./proactive/scheduler").start();
    } catch (e) {
      console.error("  proactive scheduler failed to start:", e.message);
    }

    // The durable job queue: document indexing and user-scheduled tasks
    // ("order biryani at 11"). Handlers first, then the poller — a queue
    // with no worker is silently write-only.
    try {
      require("./infra/handlers").install();
      require("./infra/jobs").start();
    } catch (e) {
      console.error("  job worker failed to start:", e.message);
    }

    // Bills by email: the SMTP receiver and its worker, only when switched
    // on. A failure is logged and never blocks HTTP; GET /mailin then says
    // available:false and the app hides the feature.
    require("./mailin/service").startReceiver().catch((e) =>
      console.error("  mailin: receiver failed to start:", e.message));

    const server = app.listen(port, () => {
      console.log(`MYASSISTANT backend on :${port} (postgres ready)`);
      // GPT-Live's recorded openings, every natural voice, in the background.
      if (require("./ai/config").gptLiveOn() && require("./services/ai/openai").ready()) {
        setTimeout(() => require("./ai/liveVoices").warmOpenings().catch(() => {}), 5000).unref();
      }
      // A key defined TWICE in .env silently keeps the LAST value, which is
      // a brutal way to lose an afternoon: the file looks right at a glance
      // but the app runs the other value. Call it out loudly at boot.
      try {
        const fs = require("fs");
        const path = require("path");
        const envPath = path.resolve(process.cwd(), ".env");
        if (fs.existsSync(envPath)) {
          const seen = new Map();
          for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
            const m = /^\s*([A-Z0-9_]+)\s*=/i.exec(line);
            if (m) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
          }
          const dupes = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
          if (dupes.length) {
            console.error(
              `  WARNING: .env defines these keys more than once — the LAST ` +
                `value wins: ${dupes.join(", ")}`
            );
          }
        }
      } catch (_) {}
      // Print the models actually in use. A wrong/retired name otherwise
      // only shows up as a 404 on the user's first voice turn, which reads
      // like "the app can't hear me" rather than a config problem. Read
      // from the router itself, so the defaults printed are the ones used
      // (they are the -latest aliases since 2026-09-25).
      const ai = require("./services/ai/router");
      console.log(
        `  models (openai): chat=${ai.chatModel()}` +
          ` smart=${require("./services/ai/openai").models.smart()}` +
          ` stt=${require("./services/ai/openai").models.stt()}` +
          ` tts=${require("./services/ai/openai").models.tts()}` +
          ` image=${require("./services/ai/openai").models.image()}` +
          ` fallback=${ai.fallbackModel()}`
      );
      // What the APP is told to run (GET /ai/config): the conversation's
      // models live on the phone and in Firebase AI Logic now.
      const aiCfg = require("./ai/config");
      console.log(
        `  app models: cloud=${aiCfg.cloudModel()} (${aiCfg.thinkingLevel()} thinking, fallback ${aiCfg.cloudFallbackModel()})` +
          ` fast=${aiCfg.cloudFastModel()}` +
          ` tts=${aiCfg.ttsModel()} (build ${aiCfg.EXPRESSIVE_BUILD}+: ${aiCfg.expressiveTtsModel()})` +
          ` live=${aiCfg.liveModel()}`
      );
      if (!process.env.OPENAI_API_KEY) {
        console.warn(
          "WARNING: OPENAI_API_KEY not set — replies, /docs analysis, meeting and " +
            "call notes, pictures and every background task will fail without it."
        );
      }
    });
    // The /live/ws upgrade an old build still tries answers 426.
    require("./ai/gone").attachUpgrade(server);

    // Call recordings are pruned after every session, but a server that
    // sat idle over a weekend still holds expired ones. Sweep at boot and
    // once a day, so nothing depends on someone making a call.
    // The same daily pass drops video-note clips kept past their 30 days
    // (videonotes/service.js sweep); the recipient's copy stays. And the
    // photo cards' working photos and drafts untouched for 30 days
    // (posters/service.js sweep): the finished card is in his documents.
    {
      const rec = require("./live/recorder");
      const sweep = () => Promise.all([
        rec.prune().catch((e) =>
          console.warn("recordings: prune failed —", e.message)),
        require("./videonotes/service").sweep().catch((e) =>
          console.warn("video notes: sweep failed —", e.message)),
        require("./posters/service").sweep().catch((e) =>
          console.warn("posters: sweep failed —", e.message)),
        // "Help improve" off: no stray recording survives a day, and their
        // turns stay within the private window (users/helpImprove.js).
        require("./users/helpImprove").sweep().catch((e) =>
          console.warn("help improve: sweep failed —", e.message)),
        require("./connectors/notion/store").sweepStates().catch((e) =>
          console.warn("notion: state sweep failed —", e.message)),
        require("./mailin/service").sweep().catch((e) =>
          console.warn("mailin: sweep failed —", e.message)),
      ]);
      setTimeout(sweep, 30_000).unref?.();
      setInterval(sweep, 24 * 3600_000).unref?.();
      console.log(
        `  recordings: ${rec.ENABLED ? `on, kept ${rec.KEEP_DAYS} days` : "off (LIVE_RECORD=0)"}`
      );
    }

    const avatarSessions = require("./avatar/session");
    console.log(
      `  avatar: ${
        !avatarSessions.configured()
          ? "disabled — missing HEYGEN_API_KEY"
          : `heygen ${require("./avatar/heygen").avatarId()}${
              require("./avatar/heygen").sandbox() ? " (SANDBOX — free, ~1 min sessions)" : ""
            }`
      }`
    );

    // A restart must not strand a live avatar room: nothing else would
    // ever delete it, and BEY keeps billing an empty room until its own
    // timeout. Deploys send SIGTERM, Ctrl-C sends SIGINT.
    let shuttingDown = false;
    for (const sig of ["SIGTERM", "SIGINT"]) {
      process.on(sig, async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        try { await avatarSessions.stopAll(); } catch (_) {}
        // server.close() does not close WebSockets, so a live call's
        // recording would otherwise be abandoned as raw PCM on every
        // deploy. Bounded, because the exit timer below is not.
        try {
          await Promise.race([
            Promise.all([
              require("./live/recorder").stopAll(),
              require("./mailin/service").stopReceiver().catch(() => {}),
            ]),
            new Promise((r) => setTimeout(r, 4000).unref?.()),
          ]);
        } catch (_) {}
        server.close(() => process.exit(0));
        // Don't let a hung socket hold the paid room open indefinitely.
        setTimeout(() => process.exit(0), 5000).unref();
      });
    }
  })
  .catch((e) => {
    console.error("FATAL: could not initialize Postgres:", e.message);
    process.exit(1);
  });
