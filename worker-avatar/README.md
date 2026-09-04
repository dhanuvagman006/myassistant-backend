# Avatar GPU worker

Stateless render service for personalized avatar messages. The Node
backend sends the sender's face photo + voice sample per request; this
worker clones the voice (Chatterbox, MIT) and lip-syncs the photo
(MuseTalk v1.5, MIT/commercial-OK), returning WAV / MP4. No user data is
stored beyond a content-hash-keyed prep cache.

## Requirements

- NVIDIA GPU, ≥12 GB VRAM recommended (RTX 4090 ≈ best price/perf;
  L4/A10G fine). CUDA 12.x driver.
- ~20 GB disk for weights.

## Run

```bash
docker build -t myassistant-avatar-worker .
docker run --gpus all -p 8100:8100 \
  -e AVATAR_WORKER_KEY=<long-random-secret> \
  -v /workspace/avatar-cache:/workspace/avatar-cache \
  myassistant-avatar-worker
```

On RunPod: use the image, expose 8100, set `AVATAR_WORKER_KEY`, attach a
volume at `/workspace`. A community-cloud 4090 (~$0.34/hr) renders a 15 s
message in roughly 6–12 s warm and serves ~1–3 concurrent renders.

## Backend wiring

```
AVATAR_WORKER_URL=https://<pod-host>:8100
AVATAR_WORKER_KEY=<same secret>
```

`GET /health` should report `{"ok":true,"engines":{"tts":true,"face":true}}`.
Either engine reporting `false` degrades gracefully: the backend falls
back to ElevenLabs/D-ID (if keys are set) and finally to Gemini TTS
audio-only or plain text. The feature never blocks message delivery.

## Endpoints

| Endpoint | Body (multipart) | Returns |
|---|---|---|
| `GET /health` | – | engine/GPU status |
| `POST /tts` | `text`, `voice` (wav/mp3 sample), `language?` | `audio/wav` |
| `POST /render` | `face` (jpg/png), `audio` (wav), `quality?` | `video/mp4` |

All requests need `Authorization: Bearer $AVATAR_WORKER_KEY` unless the
key is unset (private-network deployments only).

## Cost reality (Sept 2026)

- RunPod community RTX 4090: **$0.34/hr** → 24/7 ≈ $245/mo, or run it
  scale-to-zero (serverless/spot) for a few dollars per thousand messages.
- Per 15 s message at even 50% utilisation: **≈ $0.002–0.01**, vs
  ~$0.25 (HeyGen Avatar III / Tavus) or ~$0.28 (D-ID) per message.

## Licenses

- MuseTalk v1.5 — MIT code; model README permits commercial use.
- Chatterbox — MIT. Output carries Resemble's PerTh watermark (a feature:
  provenance for AI-generated speech).
- This service intentionally avoids Wav2Lip (research-only weights),
  XTTS (CPML non-commercial) and other non-commercial models.
