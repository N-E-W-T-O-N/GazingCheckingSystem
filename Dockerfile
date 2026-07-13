# Production Dockerfile for Hugging Face Spaces.
#
# Single public port (7860 — HF Spaces convention) serves both the built
# Vite SPA and the FastAPI API behind the same origin. WebSockets on
# /live/{lecture_id} work because the container is a real long-running
# process (unlike serverless).
#
# Storage policy: SQLite lives inside the container's writable layer. It
# resets whenever the Space rebuilds or restarts. That's the desired
# behavior — no persistent volume is requested.
#
# Build: docker build -t gazing-engagement .
# Run:   docker run --rm -p 7860:7860 gazing-engagement
#
# Two stages:
#   1. node:20 builds the frontend with `npm run build` → /build/frontend/dist
#   2. python:3.12-slim copies the dist + installs backend deps + runs uvicorn

# ─── Stage 1: build the frontend ──────────────────────────────────────────
FROM node:24-bookworm-slim AS frontend-builder

WORKDIR /build/frontend

# Copy package manifests first so this layer caches when only source changes.
COPY frontend/package.json frontend/package-lock.json* ./
# `npm ci` if a lockfile is present, else fall back to `npm install`.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY frontend/ ./
RUN npm run build

# ─── Stage 2: runtime ─────────────────────────────────────────────────────
FROM python:3.12-slim-bookworm

# Hugging Face Spaces runs as UID 1000 by default. Create a matching user
# so the container also works on hosts that enforce non-root.
RUN useradd --create-home --uid 1000 app

# System deps for baking the lecture video into the image at build time:
#   curl  — download the source asset
#   unzip — the default Blender asset ships as a .zip
#   ffmpeg — fragment the MP4 to fMP4 so MSE can stream it segment-by-segment
#   ca-certificates — required for the https download
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PATH=/home/app/.local/bin:$PATH \
    # Tell the FastAPI app where the built SPA lives. Resolved by main.py.
    STATIC_DIR=/home/app/frontend/dist \
    # HF Spaces' default port.
    PORT=7860

USER app
WORKDIR /home/app

# Install Python deps in the user's home so we don't need sudo.
COPY --chown=app:app backend/requirements.txt ./backend/requirements.txt
RUN pip install --user --no-cache-dir -r backend/requirements.txt

# Copy backend source and built frontend.
COPY --chown=app:app backend/ ./backend/
COPY --chown=app:app --from=frontend-builder /build/frontend/dist ./frontend/dist

EXPOSE 7860

WORKDIR /home/app/backend

# Bake the lecture video into the image so the container ships ready to stream
# (no slow first-request download). This mirrors the runtime "download if
# missing" fallback in app/video.py::ensure_video() used by native runs.
# Lands at backend/media/lecture.mp4 — the VIDEO_PATH default. Kept as its own
# layer so it caches across code changes. Override with:
#   docker build --build-arg VIDEO_SOURCE_URL=... .
ARG VIDEO_SOURCE_URL=https://download.blender.org/demo/movies/BBB/bbb_sunflower_1080p_60fps_normal.mp4.zip
RUN mkdir -p media /tmp/vid \
    && curl -fL --retry 3 -o /tmp/vid/src.zip "$VIDEO_SOURCE_URL" \
    && unzip -o -j /tmp/vid/src.zip '*.mp4' -d /tmp/vid \
    && ffmpeg -y \
         -i /tmp/vid/*.mp4 \
         -map 0:v:0 \
         -map 0:a:0 \
         -c copy \
         -movflags +frag_keyframe+empty_moov+default_base_moof \
         -f mp4 media/lecture.mp4 \
    && rm -rf /tmp/vid

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7860"]
