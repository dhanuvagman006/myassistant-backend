require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// Sessions are signed with this — the server can't run without it.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error("FATAL: JWT_SECRET must be set (32+ random characters).");
  process.exit(1);
}

const configRoute = require("./routes/config");
const chatRoute = require("./routes/chat");
const sttRoute = require("./routes/stt");
const ttsRoute = require("./routes/tts");
const regionRoute = require("./routes/region");
const authRoute = require("./routes/auth");
const db = require("./db");
const { appAuth } = require("./middleware/auth");

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
app.use((req, res, next) => {
  const t = process.env.METRICS_TOKEN;
  if (req.path === "/metrics" && t && req.get("Authorization") !== `Bearer ${t}`) {
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
      ["^/agent-call/plivo/[^/]+/", "/agent-call/plivo/#id/"],
      ["^/agent-call/[a-f0-9]{16,}", "/agent-call/#id"],
    ],
  })
);
app.use(
  express.json({
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
  })
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

// AGENT CALLS — Hari phones a contact and reports back.
// Plivo webhooks are PUBLIC (Plivo can't send our app key); they are guarded
// by a per-call token embedded in the path and MUST be mounted before the
// app-facing routes so they don't hit appAuth.
const agentCall = require("./routes/agentCall");
app.use("/agent-call/plivo", agentCall.webhooks);
app.use("/agent-call/exotel", agentCall.exotelWebhooks);
app.use("/agent-call", appAuth, perUserLimit, agentCall.router);

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
app.use("/chat", appAuth, perUserLimit, chatRoute);

// ASSISTANT — the realtime voice-loop module the app's home screen uses
// (session + SSE event stream + mic-clip turns). The SSE stream route
// authenticates with a per-session random token (?token=…) because
// EventSource clients can't attach an Authorization header; every other
// assistant route sits behind the normal appAuth like /chat does.
const assistantRoutes = require("./assistant/routes");
app.get("/assistant/stream/:sid", assistantRoutes.streamHandler);
app.use("/assistant", appAuth, perUserLimit, assistantRoutes);

// Onboarding survey + profile view (feeds users table + agent memory).
app.use("/profile", appAuth, require("./routes/profile"));
app.use("/phone", appAuth, require("./routes/phone"));
app.use("/contacts", appAuth, require("./routes/contacts"));

// Phase 1 / ADR-004 — the user-visible audit trail of assistant actions.
app.use("/actions", appAuth, require("./routes/actions"));

// Privacy dashboard (F2): full data export + permanent account deletion.
app.use("/privacy", appAuth, require("./routes/privacy"));

// Google account link: Gmail + Calendar (read-only).
app.use("/google", appAuth, require("./google/routes"));


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
app.use("/messages", appAuth, require("./routes/messages"));

// Personalized avatar messages: the sender's OWN face/voice identity
// (consent, reference photo, voice sample, preferences). Renders always
// use the sender's profile — see src/avatarmsg/.
app.use("/avatar-profile", appAuth, require("./avatarmsg/routes").router());
app.use("/usage", appAuth, require("./routes/usage").router);
app.use("/finance", appAuth, require("./routes/finance").router);

// TODAY BRIEF — one aggregate fetch for the home dashboard (agenda,
// promises, unread agent messages, circle, weather, headlines).
app.use("/brief", appAuth, require("./routes/brief"));

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

// Voice transcription (Gemini) — same auth as chat
app.use("/stt", appAuth, perUserLimit, sttRoute);

app.use("/tts", appAuth, perUserLimit, ttsRoute);

// Group B — photos, documents, OCR, screenshot helper (Gemini vision).
app.use("/vision", appAuth, perUserLimit, require("./routes/vision"));

// Group B+ — SAVED documents: hospital reports, receipts… Hari remembers
// them and pulls them back up from a voice request (see routes/docs.js).
app.use("/docs", appAuth, require("./routes/docs"));

// PROFESSIONAL MODE — per-client/patient case files (doctor, lawyer…):
// profile + dated notes + linked documents, recalled by voice
// ("pull up patient Ramesh's file"). See routes/clients.js.
app.use("/clients", appAuth, require("./routes/clients"));

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

// LIVE MODE (experimental): the probe route must register BEFORE the JSON
// 404 catch-all below, or /live would always 404; the WS upgrade handler is
// attached to the HTTP server after listen because it needs that handle.
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
// it was. Registering here makes the tool set identical on both paths.
require("./agents/runtime");
console.log(
  `  tools: ${require("./tools/registry").declarations().length} registered`
);

const live = require("./live/proxy");
// Avatar routes mount FIRST: Express matches in order, and /live's probe
// router would otherwise swallow /live/avatar/* before it gets here.
app.use("/live/avatar", appAuth, require("./avatar/routes").router());
app.use("/live", live.probeRouter());

// Agent-level metrics (tool latency, job counts, agent turns). Mounted at
// /metrics/agent because /metrics already serves Prometheus process
// metrics — two handlers on one path would silently shadow each other.
app.get("/metrics/agent", (req, res) => {
  const want = process.env.METRICS_TOKEN;
  if (want && req.headers["x-metrics-token"] !== want) {
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
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "internal error" });
});

const port = process.env.PORT || 3000;
// Postgres: create the schema BEFORE accepting any request — a request
// racing table creation would 500. Boot fails loudly if the DB is down,
// which is exactly what Kubernetes needs to restart/backoff the pod.
require("./db")
  .init()
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

    const server = app.listen(port, () => {
      console.log(`MYASSISTANT backend on :${port} (postgres ready)`);
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
      // like "the app can't hear me" rather than a config problem.
      console.log(
        `  models: chat=${process.env.GEMINI_MODEL || "gemini-2.5-flash"}` +
          ` stt=${process.env.GEMINI_STT_MODEL || "(same as chat)"}` +
          ` vision=${process.env.GEMINI_VISION_MODEL || "gemini-2.5-flash"}` +
          ` tts=${process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts"}` +
          ` thinking=${process.env.GEMINI_THINKING_LEVEL || "low"}`
      );
      if (!process.env.GEMINI_API_KEY) {
        console.warn(
          "WARNING: GEMINI_API_KEY not set — /vision and /docs analysis " +
            "(Group B: photos, PDFs, OCR, screenshots) will return 503. " +
            "Chat and voice will NOT work without it."
        );
      }
    });
    // LIVE MODE: attach the /live/ws upgrade handler to the running server.
    live.attachWs(server);
    console.log(
      `  live mode: model=${process.env.GEMINI_LIVE_MODEL || "gemini-2.5-flash-native-audio-preview"} at /live/ws (experimental)`
    );

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
