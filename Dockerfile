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
FROM node:20-bookworm-slim AS frontend-builder

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
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7860"]
