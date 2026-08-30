# MYASSISTANT Backend

Node.js + Express API server for **MYASSISTANT / "Hari"** — a voice-first
personal AI assistant (Flutter app in the `MYASSISTANT` repo). All AI provider
keys live here, never in the app: the app only ever carries the user's own JWT.

- **Runtime:** Node 20+ · Express 4 · PostgreSQL (via `pg`)
- **AI:** Gemini (chat, streaming, vision, STT, **neural TTS**) through `src/services/ai/router.js`
- **Telephony:** Plivo — agent calls Hari places, speaks on, and hangs up herself
- **Realtime:** the voice loop runs over Server-Sent Events (`/assistant/*`)
- **Ops:** Helmet, per-IP + per-user rate limits, Prometheus metrics, Docker + k8s

## Data model (one place: `src/db.js` `init()`)
Every table is created idempotently at boot. User-owned data:
`users`, `agent_memories`, `reminders`, `bookings`, `documents`,
`clients` + `client_notes` (professional mode), `google_tokens`,
`actions_log` (audit), `kv`. All of it is exported by `/privacy/export` and
erased by `/privacy/account`.

## Endpoints
Auth column: **none** = public · **JWT** = `Authorization: Bearer <token>` from
`/auth/*` · a dev-only `X-App-Key` fallback exists when `ALLOW_APP_KEY=true`.

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Uptime check |
| `GET /metrics` | token | Prometheus metrics (guard with `METRICS_TOKEN`) |
| `GET /config` | none | Remote config: versions, changelog, feature flags, announcements, APK url |
| `POST /app/...` | none | Self-hosted OTA update channel (APK metadata) |
| `POST /auth/*` | none | Email + Google/Apple sign-in → issues the session JWT |
| `POST /chat` | JWT | AI chat — `{messages:[…]}` → `{reply, sources, documents}` |
| `POST /assistant/session` · `GET /assistant/stream/:sid` · `POST /assistant/:sid/*` | JWT | Realtime voice loop (SSE + mic/text/contacts/confirm) |
| `POST /stt` | JWT | Speech-to-text (Gemini Whisper-style) |
| `POST /tts` | JWT | Text-to-speech — `{text, language?, voice?}` → `audio/wav` (Gemini neural voice) |
| `POST /agent-call/preview` · `POST /agent-call` · `GET /agent-call/:id` | JWT | Agent calls — Hari places + speaks on + reports a call (Plivo) |
| `POST /agent-call/plivo/:id/:token/*` | none | Plivo call webhooks (answer/gather/hangup; per-call token in the path) |
| `POST /vision` | JWT | Photo/PDF understanding (Gemini vision) |
| `GET/POST/PATCH/DELETE /docs` · `GET /docs/:id/file` | JWT | Saved documents — recall + the original file bytes |
| `GET/POST/PATCH/DELETE /clients` + `/clients/:id/notes` + `/clients/:id/docs/:docId` | JWT | **Professional mode** — per-patient/client case files |
| `GET/POST/PATCH/DELETE /reminders` | JWT | Reminders (also created by voice via chat intents) |
| `GET /profile` · `POST /profile/survey` | JWT | Onboarding survey → name/gender + seeded memories |
| `GET /actions` | JWT | The user's action audit log |
| `GET /privacy/export` · `POST /privacy/account` | JWT | Full data export · account erasure |
| `GET/POST /google/*` | JWT | Google link, Gmail (drafts only) + Calendar |
| `POST /avatar/*` | JWT | Tavus human-avatar video sessions |
| `GET /places` · `GET /tools/weather` · `GET /tools/news` | JWT | Live data for the Today screen |
| `GET /region` | none | Regional language guess from the caller's IP |
| `/admin/*` | `ADMIN_KEY` | Read-only ops stats + APK publish |

### Getting things done in the real world (fulfillment)
"Order me a biryani", "book a cab to the airport", "get tickets for Kantara",
"book me a dentist appointment on Friday". `src/fulfillment/` runs these
errands down **three paths**, and the path is always visible to the user
because the three carry very different promises:

| Path | Used for | What Hari actually does |
|---|---|---|
| **call** | appointments, tables, collection orders | **Really telephones the business** over Plivo, asks, and reports what they said. The only path that can end `confirmed`. |
| **handoff** | Swiggy, Zomato, Uber, Ola, BookMyShow | Resolves the exact restaurant/showtime/dropoff, then deep-links the app with it prefilled. **The user pays.** Ends `handed_off`, never `confirmed`. |
| **api** | any provider you get a partner key for | `PROVIDER_ADAPTERS` in `src/fulfillment/service.js`. Deliberately empty. |

**Why handoff exists at all:** Swiggy, Zomato, BookMyShow and Ola publish no
consumer ordering API, and Uber's Rides API is partner-gated. There is no
legitimate way for a server to place these orders. The alternatives would be
scraping (breaks their terms, breaks constantly, and would mean holding the
user's payment credentials) or faking it. So Hari does every step up to
payment and says plainly that the last tap is the user's.

> This replaced a tool that **mocked** it: `book_appointment_via_call` slept
> three seconds and told the user "I spoke to their receptionist and your
> appointment is confirmed" without dialling anything. It is now
> `book_by_calling_business`, wired to the real agent-call engine, and it
> reports failure as failure when telephony is unconfigured.

**"Book me a dentist appointment on Friday"** runs end to end: the number is
looked up on **Google Places**, Hari dials it, speaks to whoever answers, and
reports back what they said.

The lookup happens **before** the confirmation card, not after, via the
registry's `prepare()` hook. Two reasons:
1. You approve a *specific* business — name, address and the number about to
   be dialled — instead of a bare search term, when four Apollo Clinics are
   nearby and one of them is about to get a phone call.
2. The resolved number is **pinned into the approved args**, so the business
   you approved and the business that gets called cannot be different ones.

A result must also genuinely match the name you gave (`nameMatches`). Places
are distance-sorted, so without that check, asking for a dentist whose number
Google doesn't list would have dialled whoever was nearest. Now the failure is
"I couldn't find their number" — which is true — instead of a call to a
stranger. No number found means **no confirmation card at all**.

Every errand is written to `fulfillment_tasks` **before** it runs, so a
dropped call or a restart still leaves a traceable task rather than a
vanished one. `list_my_errands` reads it back ("did the restaurant confirm?").

Tools: `order_food` · `book_ride` · `book_movie_tickets` ·
`book_by_calling_business` (high risk → confirmation card) · `list_my_errands`.
`play_music` resolves the actual video id via the YouTube Data API so a song
**plays** instead of opening a results list (`YOUTUBE_API_KEY`; falls back to
search, and says so, without one).

Run `npm run test:fulfillment` — it covers the link builders and the honesty
invariants (no sentence may ever claim an order was placed).

### Third-party integrations (the extension story)
Three ways to add a capability, all already built:

1. **MCP** (`src/mcp/manager.js`) — a user connects any MCP server (Notion,
   Slack, their own internal tools) and its tools are namespaced per user,
   risk-classified and dropped into the same registry. The runtime doesn't
   know MCP exists. *This is the platform argument: the feature list is not
   fixed at build time.*
2. **Tool registry** — any REST API becomes a capability in ~40 lines.
3. **`PROVIDER_ADAPTERS`** in `src/fulfillment/service.js` — the seam for
   real booking APIs.

Built on top of them:

| Feature | Vendor | Notes |
|---|---|---|
| **Meeting negotiation** | *none* | Reads your real free slots, **phones the person**, agrees a time, writes it to your calendar |
| **Payment collection** | Razorpay | Creates a link, WhatsApps it, tells you when it's paid. Test keys work end to end |
| **Flight search + fare watch** | Amadeus / Duffel | Adapter existed; now host-configurable, with fare alerts on the proactive sweep |
| **Interpreter mode** | *none* | Live two-way translation — the model is already multilingual |

**Meeting negotiation** never books a slot the calendar says is taken, and
never books on an ambiguous "maybe" — an unbooked meeting is recoverable, a
meeting the other person doesn't know about is not. Free slots and the
resolved contact are pinned *before* the confirmation, so what you approve is
what gets offered.

**Payments are one-way by design.** There is a request-money path and no
payout, transfer or refund path — a test asserts none appears. The webhook is
verified by HMAC over the raw body and **rejects everything when no secret is
set**, because an unverified webhook could mark any invoice paid.

> Fixed while building this: `server.js` had an empty `verify` stub whose
> comment claimed it kept the raw bytes for signature checking. It kept
> nothing, so any signature check would have failed. `flights.js` was pinned
> to the Amadeus **test** host (live keys would have returned unbookable
> sandbox inventory) and silently turned any unparseable date into
> *tomorrow* — "next Friday" returned tomorrow's flights, discoverable only
> at the airport.

**Interpreter mode** is almost entirely instructions that suppress the
model's instinct to be helpful: asked a question in Tamil it wants to answer
it, and an interpreter that answers invents one side of a conversation
between two people who cannot check what it said.

Run `npm run test:integrations` — 18 tests.

### For busy professionals
Four features aimed at the thing a professional actually loses: the call
they couldn't take, the promise they made in passing, the meeting they had
no time to write up.

#### Hari answers your phone (`src/inbound/`)
The mirror image of agent calls. A Plivo number is assigned to a user, and
Hari picks it up when they can't.

- **Known contacts are put straight through** (`screen_unknown`, the default)
  — screening is only tolerable if your family still reaches you. `screen_all`
  screens everyone; `take_messages` never forwards. A `vip` list always goes
  through whatever the mode.
- **Everyone else is screened**: she asks who's calling and what it's about,
  answers what she safely can, takes a message, and pushes it to the user —
  ranked so an urgent one isn't buried behind three sales calls.
- **Spam is filed silently.** The point of screening is that it does *not*
  interrupt you.
- Hard limits on what she may say: never invent the user's whereabouts or
  availability, never share anything about other clients, never agree to
  anything binding. Offering an appointment is off unless `may_book` is on.
- `MAX_TURNS` caps the call — an AI that won't hang up is worse than voicemail.

`GET/PATCH /inbound/settings` · `GET /inbound/calls` · voice: *"did anyone call?"*
Numbers are assigned by an **admin** (`POST /inbound/admin/assign-number` with
`X-Admin-Key`) — a user must not be able to claim someone else's number and
receive their calls.

#### Commitment tracking (`src/commitments/`)
Catches "I'll send Ravi the proposal by Friday" as it's said, files it with
the person and the deadline, and nudges before it slips.

- **Extraction never costs latency.** A regex gate rejects ordinary
  conversation with no API call at all; only a sentence that looks like a
  promise pays for the model, and even then it runs *fire-and-forget after*
  the reply is already on its way.
- **False positives are worse than misses** — a list full of things you never
  promised is one you stop reading. The prompt demands a first-person,
  specific, future undertaking and rejects musings, questions, and things
  other people promised.
- Every entry keeps the **quote it came from**, so you can see why Hari thinks
  you promised it.

Voice: *"what did I promise?"* · *"I sent Ravi the proposal"* (ticks it off).

#### Pre-meeting brief + proactive nudges (`src/proactive/`)
One sweep, two jobs. Before a calendar event: who you're meeting, their case
file, the last note on it, and **anything you still owe them**. Before a
deadline: one nudge, naming the person.

- **Never interrupts twice for the same thing** — commitments carry
  `nudged_at`, briefs record the event id. An assistant that repeats itself
  gets muted, and then the useful notification never arrives either.
- **Quiet hours** (default 22:00–07:00) for anything non-urgent.
- Only scans users who have Google linked *and* a device to notify.

#### Meeting capture → follow-up (`src/meetings/`)
`POST /meetings` with a transcript, or `POST /meetings/audio` with a
recording. Returns the summary, what was **decided**, who agreed to **what**,
and a **follow-up message already written**.

- **Your own action items become tracked commitments** and get nudged. The
  other side's stay in the record — we can't chase their client for you, and
  a tracker full of other people's tasks is one you stop reading.
- Long meetings: `POST /meetings/transcribe` per chunk, so a failed chunk is
  visible instead of silently losing a slice of the hour.

Voice: *"what did we decide with Ravi?"*

Run `npm run test:professional` — 16 tests over screening decisions, the
extraction gate, quiet hours and meeting analysis.

### Knowledge packs — law, government, money, health, travel
Hari answers reference questions from a **retrieved corpus** (`src/knowledge/`),
never from the model's memory. Five packs, 132 entries, each a plain-language
summary with its source and a link to verify it:

| Pack | Covers |
|---|---|
| **legal** (77) | Offences and punishments, arrest and FIR rights, consumer, cheque bounce, tenancy, employment, motor penalties, family, cyber, RTI, constitutional rights |
| **govt** (15) | Aadhaar, PAN, passport, driving licence, voter ID, birth/death certificates, DigiLocker, CPGRAMS grievances |
| **money** (13) | Income tax regimes and slabs, ITR deadlines, 80C/80D, TDS, EPF, credit score, UPI/bank fraud recovery, insurance claims |
| **health** (16) | First aid, emergency red flags, helplines. **No diagnosis, no medicines, no doses** — see below |
| **travel** (11) | Train refunds and Tatkal, DGCA flight cancellation and baggage rights, vehicle documents, help abroad |

**Why grounding, not the model.** On **1 July 2024** the IPC, CrPC and Evidence
Act were replaced by the **BNS, BNSS and BSA** — "Section 420" is now BNS
318(4). Training data is saturated with the repealed numbering, and tax slabs
change every Budget. These answers get *acted on*, so a confident stale figure
is the failure mode that matters.

#### Built for the latency budget
Reference lookups sit on the critical path of a *spoken* turn, so the engine is
designed around cost, not just quality:

- **ONE tool for five packs.** Every tool's schema is sent to the model on
  every turn — five domain tools would slow down someone asking about the
  weather. `consult_knowledge` takes a `domain` argument instead, so the next
  five packs cost nothing per turn. Tool count went *down* (41 → 40) while
  gaining four domains.
- **The corpus lives in memory.** Loaded once at boot; retrieval is an
  in-process scan at **~0.08 ms**, with no Postgres round-trip per turn.
- **Lexical first, often lexical only.** An IDF-weighted score identifies
  named lookups ("BNS 318", "Tatkal timing") outright and **skips the
  embedding call entirely** — those questions cost *zero* API calls to
  retrieve. Query vectors are cached for the rest.
- **No nested model call.** The tool returns *facts plus the rules for using
  them*; the outer agent loop composes the spoken reply in the call it was
  always going to make. This removed a whole LLM round-trip that was doing
  the same job twice.

Net: **three sequential API round-trips per question became one** (or zero for
a named lookup).

#### Grounding and boundaries
- Nothing retrieved → the tool returns `found: 0` and instructs the model **not
  to answer from its own knowledge**. Coincidental word overlap does not count
  as a match (an absolute + relative score floor), so unrelated questions
  return nothing rather than plausible-looking wrong entries.
- `src/legal/guard.js` holds the **repealed-statute map**, working both ways: a
  user saying "498A" is routed to BNS 85, and an old citation in the question
  is corrected in the result. An *unmapped* old section returns null — it says
  it can't confirm the new number rather than guessing.
- **Health is first aid and escalation only.** No diagnosis, no medicine, no
  dose — not even for a common OTC drug, since dose depends on weight, age and
  interactions the assistant cannot know. A test asserts no dose appears
  anywhere in the pack.
- Money entries that state slabs **name their financial year aloud**; a test
  enforces it.
- Legal answers are information, not advice. Custody, bail or a live deadline
  appends a referral to a real advocate — including free legal aid (**15100**).
- Citations are pushed to the app as `search_results` and rendered as tappable
  cards, so the user can verify every figure Hari speaks.

**Coverage is the honest limit.** 132 entries covers common questions, not the
Indian statute book — 1,200+ central Acts plus state legislation, and rent,
land and police matters are largely state subjects. Outside the packs the
answer is "I don't have that". Extending: add entries to a file in
`src/knowledge/packs/` (re-seeding updates by `slug`), or add a new pack by
listing it in `engine.js` `allPacks()` and adding its rules in `rules.js`.

Run `npm run test:knowledge` — 31 tests over pack integrity, retrieval quality
(19 real questions), retrieval **cost**, and the domain boundaries. Plus
`npm run test:legal` (15) for the repealed-section detector.

### Voice recall & professional mode
`src/services/intents.js` runs **before** the AI on every chat/voice turn. It
executes deterministic actions (reminders, calendar writes) and injects a live
data block the AI must answer from. It also powers:

- **Document recall** — "show me my last hospital report", "show my Aadhaar
  card". Matched documents are returned to the app (and pushed over SSE on the
  voice loop) so they appear on screen; the app's card has a **Send** button to
  share the real file. ID documents (Aadhaar/PAN/passport/licence/voter) are
  categorised from the save note and their numbers are never read aloud.
- **Client/patient case files** — "give me the details about patient Ramesh"
  speaks the profile + dated notes + linked documents and shows the files;
  "note for patient Ramesh: allergic to penicillin" writes a dated note
  (auto-creating the card on first mention); ambiguous names ask which person.

### Agent calls & voice-driven capture
The `/assistant` loop (`src/assistant/routes.js`) detects two more spoken
intents and drives them end-to-end; the app just renders the streamed events:

- **Agent calls** — "call mom and tell her I'll be late" / "call the clinic and
  ask when I can come in". The device resolves the contact, then the server
  places the call via **Plivo** (`src/agents/agentCall.js`): it generates a
  natural, per-language script, speaks it with an Amazon Polly voice, captures
  the reply for "ask" tasks, and hangs up itself. Progress and the spoken
  outcome stream back over SSE. It auto-proceeds (announces first), offers one
  retry on no-answer, and returns **503** when telephony is unset so the app
  falls back to a plain direct dial. Reminder phrasing ("remind me to call …")
  is never mistaken for a call.
- **Voice document capture** — "save this receipt", "scan this", "remember
  this" emit an `open_camera` event; the app opens the camera, files the shot
  into document memory with the user's words as the note, and confirms. A
  spoken *fact* ("remember that mom's birthday is in May") is left for the AI.

## The update switchboard
`src/config/remoteConfig.js` controls what every installed app sees on launch:
feature flags, announcements, version prompts, and the OTA APK url/hash. Edit +
redeploy = instant update for all users. New AI capabilities ship here on the
server; the app is the window to them.

## Run locally
```bash
npm install
cp .env.example .env          # fill in your keys (see below)
createdb myassistant          # or point DATABASE_URL at any Postgres 14+
DATABASE_URL=postgres://user:pass@localhost:5432/myassistant npm run dev
```

## Tests
```bash
npm test        # agents + clients + audit + smoke (needs a throwaway DATABASE_URL)
```
`scripts/smoke-test.js` boots the real server against an empty database and
exercises auth, memory, reminders, documents (incl. the Aadhaar/ID path) and
client case files. `agents-test`, `clients-test` and `audit-test` stub the DB
and AI, so they need no Postgres and no keys.

## Environment
Required: `DATABASE_URL`, `JWT_SECRET`, `GEMINI_API_KEY`.
Common: `PORT`, `DATA_DIR` (where document files live), `GEMINI_MODEL`,
`GEMINI_VISION_MODEL`, `CORS_ORIGIN`, `PG_POOL_SIZE`, `PUBLIC_BASE_URL`.
Voice: `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICE` (neural TTS; reuse the Gemini key).
Agent calls (Plivo — feature returns 503 until all set): `PLIVO_AUTH_ID`,
`PLIVO_AUTH_TOKEN`, `PLIVO_FROM_NUMBER`, `PUBLIC_BASE_URL` (Plivo must reach it
for call webhooks), `PLIVO_VOICE` (default `Polly.Aditi`), `AGENT_CALL_DAILY_LIMIT`.
Auth/dev: `ALLOW_APP_KEY`, `APP_API_KEY`, `AUTH_DISABLED` (dev only — the
server refuses to boot with this in production), `GOOGLE_WEB_CLIENT_ID`,
`GOOGLE_WEB_CLIENT_SECRET`, `APPLE_BUNDLE_ID`.
Integrations: `GOOGLE_PLACES_API_KEY`, `TAVUS_API_KEY`, `TAVUS_FACE_ID`,
`TAVUS_PAL_ID`, `TAVUS_MAX_CALL_SECONDS`.
Ops: `ADMIN_KEY`, `METRICS_TOKEN`, `NODE_ENV`.

## Deploy
Deploy to an **India region** (AWS ap-south-1 Mumbai / GCP asia-south1) per the
contract's data-residency commitment (Section 5.1). Any Node 20+ host works
(Railway, Render, EC2, Cloud Run); `Dockerfile`, `docker-compose.yml` and `k8s/`
are included. Postgres replaces the old single-writer SQLite so the deployment
can scale horizontally behind the HPA.

## Security notes
- AI provider keys live only here, never in the app.
- Production auth is the session JWT; `X-App-Key` is a dev fallback gated by
  `ALLOW_APP_KEY` and `AUTH_DISABLED` is refused in production.
- Rate-limited per-IP (60/min default) and per-user.
- Every externally-visible or destructive action is written to `actions_log`
  (append-only; the user can read, export and erase it). Case-file reads are
  audited too — the confidentiality trail a doctor/lawyer needs.
- ⚠️ Never paste real keys or tokens into code, chats, or commits. If one leaks,
  rotate it immediately.
