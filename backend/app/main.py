"""FastAPI entrypoint.

Run with:
    uvicorn app.main:app --reload --port 8000

In container/Spaces builds, the Vite SPA is built into a directory pointed
at by the STATIC_DIR environment variable. When that directory exists we
mount it at "/" so a single port serves both API and frontend. API routes
are registered first so they take precedence over the SPA fallback.
"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import CORS_ORIGINS
from .db import init_db
from .ingest import router as ingest_router
from .reports import router as reports_router
from .stream import router as stream_router
from .video import ensure_video

log = logging.getLogger("uvicorn.error")


async def _provision_video() -> None:
    """Download the lecture video if it is missing (see app.video).

    Runs off the event loop so a slow first-run download never blocks startup.
    In the Docker image the file is baked in, so this returns immediately.
    A failure here is non-fatal: only video streaming is affected; the
    engagement pipeline and ingest keep working.
    """
    try:
        await asyncio.to_thread(ensure_video)
    except Exception:
        log.exception("[video] provisioning failed; streaming will be unavailable")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    asyncio.create_task(_provision_video())
    yield


app = FastAPI(
    title="GazingEngageMent",
    description="Engagement detection backend for a video lecturing system. See README.md and MATH.md.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ingest_router)
app.include_router(reports_router)
app.include_router(stream_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# ── Static SPA (only when a built frontend is bundled in the image) ──
# In dev (devcontainer) the Vite server runs on :5173 and proxies the API,
# so STATIC_DIR is unset and this mount is skipped. In the Spaces image
# the Dockerfile sets STATIC_DIR to /home/app/frontend/dist.
_static_dir = Path(os.environ.get("STATIC_DIR", "")).expanduser()
if _static_dir.is_dir():
    app.mount("/", StaticFiles(directory=_static_dir, html=True), name="spa")
