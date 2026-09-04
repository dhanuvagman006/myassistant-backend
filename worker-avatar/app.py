"""
AVATAR GPU WORKER — stateless render service for personalized avatar
messages.

Runs on any CUDA box (RunPod / Vast.ai spot RTX 4090 recommended; L4/A10G
work). The Node backend is the only client; it sends the user's identity
assets per request, so this process holds NO user state and can be a spot
instance that comes and goes.

Engines (both commercially licensed):
  TTS   Chatterbox (Resemble AI, MIT) — zero-shot voice cloning from the
        ~10s sample sent with each request. No training step.
  FACE  MuseTalk v1.5 (Tencent, MIT/commercial-OK) — photo + speech →
        lip-synced talking-head MP4. Avatar prep for a face is cached on
        local disk keyed by content hash, so repeat senders skip the
        expensive preprocessing.

Endpoints (bearer auth via AVATAR_WORKER_KEY):
  GET  /health          → {ok, engines:{tts, face}, gpu}
  POST /tts    (multipart: text, voice, language?)      → audio/wav
  POST /render (multipart: face, audio, quality?)       → video/mp4

Deploy: see README.md in this directory. Model weights are fetched at
image build time so cold start is container start, not a download.
"""
import hashlib
import io
import os
import shutil
import subprocess
import tempfile
import time
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response

app = FastAPI(title="avatar-worker", docs_url=None, redoc_url=None)

WORKER_KEY = os.environ.get("AVATAR_WORKER_KEY", "")
CACHE_DIR = os.environ.get("AVATAR_CACHE_DIR", "/tmp/avatar-cache")
os.makedirs(CACHE_DIR, exist_ok=True)


# --------------------------------------------------------------------------
# Engine singletons — loaded lazily so /health works even mid-download, and
# so this file can run (and be API-contract-tested) on a CPU box where the
# engines simply report unavailable.
# --------------------------------------------------------------------------
class Engines:
    tts = None          # chatterbox.tts.ChatterboxTTS
    tts_error: Optional[str] = None
    face = None         # musetalk wrapper (see musetalk_engine.py)
    face_error: Optional[str] = None


def get_tts():
    if Engines.tts is None and Engines.tts_error is None:
        try:
            from chatterbox.tts import ChatterboxTTS  # pip install chatterbox-tts
            Engines.tts = ChatterboxTTS.from_pretrained(device="cuda")
        except Exception as e:  # noqa: BLE001 — report, don't crash the worker
            Engines.tts_error = str(e)
    return Engines.tts


def get_face():
    if Engines.face is None and Engines.face_error is None:
        try:
            from musetalk_engine import MuseTalkEngine
            Engines.face = MuseTalkEngine(cache_dir=CACHE_DIR)
        except Exception as e:  # noqa: BLE001
            Engines.face_error = str(e)
    return Engines.face


def check_auth(request: Request):
    if not WORKER_KEY:
        return  # explicit opt-out for private-network deployments
    if request.headers.get("authorization") != f"Bearer {WORKER_KEY}":
        raise HTTPException(status_code=401, detail="bad worker key")


@app.get("/health")
def health(request: Request):
    check_auth(request)
    gpu = None
    try:
        import torch
        gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    except Exception:  # noqa: BLE001
        pass
    return {
        "ok": True,
        "engines": {
            "tts": get_tts() is not None,
            "face": get_face() is not None,
        },
        "errors": {
            "tts": Engines.tts_error,
            "face": Engines.face_error,
        },
        "gpu": gpu,
    }


@app.post("/tts")
async def tts(
    request: Request,
    text: str = Form(...),
    voice: UploadFile = File(...),
    language: str = Form(""),
):
    check_auth(request)
    engine = get_tts()
    if engine is None:
        raise HTTPException(status_code=503, detail=f"tts engine unavailable: {Engines.tts_error}")
    if not text.strip() or len(text) > 2000:
        raise HTTPException(status_code=400, detail="text empty or too long")

    t0 = time.time()
    with tempfile.TemporaryDirectory() as td:
        sample = os.path.join(td, "sample" + os.path.splitext(voice.filename or "s.wav")[1])
        with open(sample, "wb") as f:
            shutil.copyfileobj(voice.file, f)

        # Zero-shot clone-and-speak. Chatterbox resamples internally.
        wav_tensor = engine.generate(text, audio_prompt_path=sample)

        import torchaudio
        buf = io.BytesIO()
        torchaudio.save(buf, wav_tensor, engine.sr, format="wav")
        audio = buf.getvalue()

    return Response(
        content=audio,
        media_type="audio/wav",
        headers={"x-generation-ms": str(int((time.time() - t0) * 1000))},
    )


@app.post("/render")
async def render(
    request: Request,
    face: UploadFile = File(...),
    audio: UploadFile = File(...),
    quality: str = Form("standard"),
):
    check_auth(request)
    engine = get_face()
    if engine is None:
        raise HTTPException(status_code=503, detail=f"face engine unavailable: {Engines.face_error}")

    t0 = time.time()
    face_bytes = await face.read()
    face_key = hashlib.sha256(face_bytes).hexdigest()[:24]

    with tempfile.TemporaryDirectory() as td:
        face_path = os.path.join(td, "face" + os.path.splitext(face.filename or "f.jpg")[1])
        with open(face_path, "wb") as f:
            f.write(face_bytes)
        audio_path = os.path.join(td, "speech.wav")
        with open(audio_path, "wb") as f:
            shutil.copyfileobj(audio.file, f)

        out_path = os.path.join(td, "out.mp4")
        try:
            # prep is cached by face_key: first render for a face pays the
            # preprocessing (~seconds), every later one skips straight to
            # inference at faster-than-real-time on a 4090.
            engine.render(
                face_path=face_path,
                face_key=face_key,
                audio_path=audio_path,
                out_path=out_path,
                quality=quality,
            )
        except subprocess.CalledProcessError as e:
            raise HTTPException(status_code=500, detail=f"render pipeline failed: {e}") from e

        with open(out_path, "rb") as f:
            video = f.read()

    return Response(
        content=video,
        media_type="video/mp4",
        headers={"x-generation-ms": str(int((time.time() - t0) * 1000))},
    )


@app.exception_handler(Exception)
async def unhandled(_request: Request, exc: Exception):
    return JSONResponse(status_code=500, content={"detail": str(exc)[:300]})
