"""
MuseTalk v1.5 wrapper — single photo + speech WAV → lip-synced MP4.

MuseTalk animates the MOUTH REGION of a source video (or a single image
treated as a 1-frame loop). From one photo the head stays still and the
lips move — that is the "standard" quality. "high" additionally runs the
result through GFPGAN face restoration if it is installed.

The expensive part (face detection, landmark extraction, latent prep) is
per-FACE, not per-message, so it is cached under cache_dir keyed by the
photo's content hash. Inference itself runs at ~30-70 fps on a RTX 4090 —
faster than real time, so a 15s message renders in well under 15s warm.

This module shells out to MuseTalk's realtime inference entrypoint rather
than importing its internals: the project is research code whose module
layout moves between releases, while the CLI contract
(--avatar_id / --audio_path / --result_dir + a prepared avatar cache) has
been stable across v1.0 → v1.5. MUSETALK_DIR must point at a checkout with
weights downloaded (see Dockerfile).
"""
import os
import shutil
import subprocess
import tempfile

import yaml

MUSETALK_DIR = os.environ.get("MUSETALK_DIR", "/opt/MuseTalk")


class MuseTalkEngine:
    def __init__(self, cache_dir: str):
        if not os.path.isdir(MUSETALK_DIR):
            raise RuntimeError(f"MuseTalk checkout not found at {MUSETALK_DIR}")
        self.cache_dir = cache_dir

    def _prepared(self, face_key: str) -> bool:
        # MuseTalk's realtime mode writes its per-avatar prep into
        # results/v15/avatars/<avatar_id>; reuse its own cache layout.
        return os.path.isdir(
            os.path.join(MUSETALK_DIR, "results", "v15", "avatars", face_key)
        )

    def render(self, face_path: str, face_key: str, audio_path: str,
               out_path: str, quality: str = "standard"):
        with tempfile.TemporaryDirectory() as td:
            cfg = {
                face_key: {
                    "preparation": not self._prepared(face_key),
                    "bbox_shift": 0,
                    "video_path": face_path,
                    "audio_clips": {"msg": audio_path},
                }
            }
            cfg_path = os.path.join(td, "job.yaml")
            with open(cfg_path, "w") as f:
                yaml.safe_dump(cfg, f)

            subprocess.run(
                [
                    "python", "-m", "scripts.realtime_inference",
                    "--inference_config", cfg_path,
                    "--result_dir", os.path.join(MUSETALK_DIR, "results"),
                    "--unet_model_path", "models/musetalkV15/unet.pth",
                    "--unet_config", "models/musetalkV15/musetalk.json",
                    "--version", "v15",
                    "--fps", "25",
                ],
                cwd=MUSETALK_DIR,
                check=True,
                timeout=600,
            )

            produced = os.path.join(
                MUSETALK_DIR, "results", "v15", "avatars", face_key,
                "vid_output", "msg.mp4",
            )
            if not os.path.isfile(produced):
                raise RuntimeError("MuseTalk finished but produced no video")

            if quality == "high":
                produced = self._restore(produced, td) or produced

            shutil.copyfile(produced, out_path)

    def _restore(self, video_path: str, workdir: str):
        """Optional GFPGAN pass for 'high' quality. Best effort."""
        try:
            restored = os.path.join(workdir, "restored.mp4")
            subprocess.run(
                ["python", "-m", "gfpgan_video", video_path, restored],
                check=True,
                timeout=600,
            )
            return restored if os.path.isfile(restored) else None
        except Exception:  # noqa: BLE001 — quality bonus, never a failure
            return None
