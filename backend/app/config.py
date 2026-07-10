"""Configuration constants for the engagement backend.

Kept deliberately small — no Pydantic settings layer needed for v1.
"""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# SQLite database file. Override with DB_PATH env var for tests.
DB_PATH = Path(os.environ.get("DB_PATH", BASE_DIR / "engagement.db"))
DB_URL = f"sqlite:///{DB_PATH}"

# Thresholds used by the report aggregator. These mirror the constants in
# MATH.md §7.3 so a change in one place should be reflected in the other.
ATTENTIVE_THRESHOLD = 0.6
DISENGAGED_THRESHOLD = 0.3

# CORS — wide-open in dev, lock down in prod.
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*").split(",")

# ── Lecture video ────────────────────────────────────────────────────────
# The video is large and is NOT committed to git. It is provisioned two ways:
#   * baked into the Docker image at build time (see the Dockerfile `RUN curl`
#     step), so the container ships ready to stream; and
#   * downloaded on startup by app.video.ensure_video() when the cached file
#     is missing (native/local runs, or an ephemeral host that wiped it).
# Both paths land the playable file at VIDEO_PATH.
VIDEO_CACHE_DIR = Path(os.environ.get("VIDEO_CACHE_DIR", BASE_DIR / "media"))
VIDEO_PATH = Path(os.environ.get("VIDEO_PATH", VIDEO_CACHE_DIR / "lecture.mp4"))
VIDEO_SOURCE_URL = os.environ.get(
    "VIDEO_SOURCE_URL",
    "https://download.blender.org/demo/movies/BBB/bbb_sunflower_1080p_60fps_normal.mp4.zip",
)

# Streaming (see app/stream.py):
# Chunk size the WebSocket pump sends per credit.
STREAM_CHUNK_BYTES = int(os.environ.get("STREAM_CHUNK_BYTES", 128 * 1024))
# MSE codec string the client uses to build its SourceBuffer, returned by
# /stream/{id}/info. Default matches the H.264 High + AAC Blender asset; override
# via env if you point VIDEO_SOURCE_URL at a differently-encoded file.
VIDEO_MIME_CODEC = os.environ.get(
    "VIDEO_MIME_CODEC", 'video/mp4; codecs="avc1.640028, mp4a.40.2"'
)
