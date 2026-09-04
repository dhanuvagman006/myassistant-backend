# Personalized Avatar Messages

"Tell Ravi I'll be late" → Ravi's phone shows a popup video of **the
sender** — their face, their cloned voice — speaking the generated
message. This document covers the research, the architecture decision,
how the pipeline works, costs, deployment, and what is still open.

## Why this design (research summary, Sept 2026)

The existing paid video surface is HeyGen LiveAvatar (live conversation
face in `src/avatar/` — untouched by this feature). For *messages*, live
streaming is the wrong shape and the wrong price: a 5–30 s one-way clip
does not need WebRTC; it needs a fast async render and a push. Async
render also makes per-user identity practical — commercial *live* face
cloning is either Enterprise-gated (HeyGen digital twins) or per-replica
priced (Tavus $40–65/replica + ~$1/min).

Options evaluated (details in the tables below):

- **Commercial per-minute**: HeyGen Avatar III ~$1/min (twin creation
  Enterprise-only via API), Tavus ~$1/min + replica fees, D-ID ~$1.1/min
  (works from ONE photo, no per-user setup — best managed fit), A2E
  ~$0.4–0.6/min (cheap but weak consent story), Hedra ~$2/min.
- **Self-hosted open source**: MuseTalk v1.5 (MIT, commercial-OK,
  30–70 fps on an RTX 4090 = faster than real-time), Ditto (Apache-2.0,
  adds head motion, heavier), LiveTalking (Apache-2.0 streaming server —
  relevant if we later want *live* self-hosted faces). Rejected for
  license: Wav2Lip weights, SadTalker-era tools are also stale; rejected
  for economics: LiveAvatar/H100-class diffusion models.
- **Voice cloning**: Chatterbox (Resemble, MIT, zero-shot from ~10 s,
  Hindi in multilingual v3) self-hosted; ElevenLabs IVC ($0.05/min) or
  Cartesia managed; **XTTS-v2 / F5-TTS / Fish Speech local are
  non-commercial — do not ship them**. Gemini TTS (already integrated)
  is the always-on floor, not cloned.

### Cost per 15-second message

| Path | Cost |
|---|---|
| Self-host worker (RunPod community 4090, $0.34/hr, ~8s render) | **~$0.002–0.01** |
| A2E | ~$0.10 |
| HeyGen Avatar III / Tavus | ~$0.25 |
| D-ID | ~$0.28 |
| HeyGen Avatar IV | ~$1.00 |

At 10,000 messages/month: **self-host ≈ $25–245/mo** (spot vs 24/7
dedicated GPU) vs **$2,500–10,000/mo** commercial. Voice: self-host adds
~$0 (same GPU); ElevenLabs adds ~$0.0125/message.

## Architecture

```
send_agent_message (tool, unchanged surface)
        │ inserts agent_messages row  ← text delivery is NEVER blocked
        ▼
avatarmsg/service.generateForMessage        (fire-and-forget)
        │ gate: sender consented + enabled + face on file + daily cap
        ▼
VOICE stage  selfhost worker (Chatterbox clone) → ElevenLabs IVC → Gemini TTS
        ▼ wav/mp3
FACE  stage  selfhost worker (MuseTalk) → D-ID → (none)
        ▼
store media under DATA_DIR/avatar/renders + avatar_renders metrics row
        │ agent_messages.render_id / media_kind
        ▼
ONE FCM push  {kind: agent_message, avatar: 1, media: video|audio}
        ▼
Recipient app: AvatarMessageService downloads /messages/:id/media with
bearer auth → avatar_message_popup (video / audio+card / text fallback)
```

Fallback ladder (§9): **video → audio → plain text**; each stage failure
degrades one level, and the plain-text delivery path is byte-identical to
what shipped before this feature.

### Key modules

| Where | What |
|---|---|
| `src/avatarmsg/schema.js` | `avatar_profiles`, `avatar_renders`, message columns |
| `src/avatarmsg/store.js` | identity/render files under `DATA_DIR/avatar/`, daily cap |
| `src/avatarmsg/service.js` | orchestrator, fallback ladder, metrics, the one-push rule |
| `src/avatarmsg/providers/*` | `selfhost` (GPU worker), `did`, `elevenlabs`, `gemini` |
| `src/avatarmsg/routes.js` | `/avatar-profile` consent + asset + prefs + erase |
| `src/routes/messages.js` | inbox media fields + `/messages/:id/media` streaming |
| `worker-avatar/` | FastAPI GPU worker (Chatterbox + MuseTalk), Dockerfile |
| Flutter `avatar_message_service.dart` | fetch/download/popup + profile API |
| Flutter `avatar_message_popup.dart` | recipient popup (AI-generated label, mute/close) |
| Flutter `avatar_identity_screen.dart` | consent → selfie → voice-sample onboarding |

## Security & consent (§10–11)

- **Consent first**: asset uploads 403 until `POST /avatar-profile/consent`;
  revoking stops rendering immediately. Consent grants/revocations and
  asset changes are written to `actions_log`.
- **Impersonation is structural, not policy**: renders read only the
  *sender's own* profile; no API accepts a target user's face or voice.
- **No public URLs**: identity assets are never served at all; generated
  media is served solely to the *addressed, phone-verified recipient*
  through the authed `/messages/:id/media` route.
- **Abuse limits**: per-user daily render cap (`AVATAR_MSG_DAILY_LIMIT`,
  default 50) on top of the existing per-user rate limiter.
- **Secure deletion**: `DELETE /avatar-profile` removes files, provider
  clones (ElevenLabs voice), and the row.
- **Honest UI**: every popup is labelled "AI-generated message".
- Chatterbox output carries Resemble's PerTh watermark (provenance).

## Observability (§20)

Every generation writes an `avatar_renders` row: `request_id`,
sender/recipient, per-stage providers, `tts_started_at`,
`first_audio_at` (TTFA), `first_frame_at` (TTFF), `completed_at`,
status, failure reason. In-process metrics
(`avatarmsg.voice.*`, `avatarmsg.face.*`, `avatarmsg.total`,
`avatarmsg.delivered.*`) surface via the existing `/metrics`.

## Deployment

1. **Nothing** (default): feature dormant; with only `GEMINI_API_KEY`
   the ladder tops out at audio messages in the stock assistant voice.
2. **Managed pilot**: set `DID_API_KEY` (face) and `ELEVENLABS_API_KEY`
   (cloned voice). Zero infrastructure; ~$0.30/15 s message.
3. **Self-host (target)**: build `worker-avatar/` (see its README), run
   on a RunPod/Vast 4090, set `AVATAR_WORKER_URL` + `AVATAR_WORKER_KEY`.
   Managed keys can stay as automatic fallback. ~$0.01/message.

Test: `npm run test:avatarmsg` (17 checks, no GPU needed).
Benchmark: `npm run bench:avatarmsg -- face.jpg voice.wav` — measures
TTFA/TTFF per engine across six representative messages (§15/§17).

## Known limitations

- The self-hosted worker's MuseTalk/Chatterbox integration is written to
  their current CLIs/APIs but has **not been exercised on a real GPU in
  this environment** — run the benchmark on the first GPU deployment.
- Single-photo MuseTalk keeps the head still (lips only). Upgrade paths:
  short idle-video sources, or Ditto for head motion.
- Renders are fully generated before delivery (async), not streamed;
  recipient wait ≈ render time (~6–15 s self-host warm). A streaming
  (LiveTalking/WebRTC) path can be added behind the same provider
  abstraction if ever needed.
- Tamil/other Indic TTS cloning coverage is thin across all engines;
  Hindi is covered (Chatterbox multilingual / ElevenLabs).
