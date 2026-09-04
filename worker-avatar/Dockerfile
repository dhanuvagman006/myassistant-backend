# AVATAR GPU WORKER — CUDA image for RunPod / Vast.ai / any nvidia-docker
# host. Build once, push to a registry, point AVATAR_WORKER_URL at it.
#
#   docker build -t myassistant-avatar-worker worker-avatar/
#   docker run --gpus all -p 8100:8100 -e AVATAR_WORKER_KEY=... myassistant-avatar-worker
FROM pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ffmpeg libgl1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt

# --- MuseTalk v1.5 (MIT / commercial-friendly) + weights ------------------
RUN git clone --depth 1 https://github.com/TMElyralab/MuseTalk.git /opt/MuseTalk && \
    pip install --no-cache-dir -r /opt/MuseTalk/requirements.txt
# Weights (~10GB): musetalkV15 UNet, whisper-tiny, sd-vae-ft-mse, dwpose,
# face-parse. MuseTalk ships a download script; bake them into the image so
# a spot instance is serving seconds after boot.
RUN cd /opt/MuseTalk && bash ./download_weights.sh || \
    echo "WARN: weight download failed at build time — run download_weights.sh at first boot"

# --- Chatterbox TTS (MIT) --------------------------------------------------
RUN pip install --no-cache-dir chatterbox-tts

# --- The worker ------------------------------------------------------------
COPY requirements.txt /opt/worker/requirements.txt
RUN pip install --no-cache-dir -r /opt/worker/requirements.txt
COPY app.py musetalk_engine.py /opt/worker/

ENV MUSETALK_DIR=/opt/MuseTalk \
    AVATAR_CACHE_DIR=/workspace/avatar-cache \
    PYTHONPATH=/opt/worker

EXPOSE 8100
CMD ["uvicorn", "app:app", "--app-dir", "/opt/worker", "--host", "0.0.0.0", "--port", "8100"]
