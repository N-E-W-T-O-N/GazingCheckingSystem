"""Lecture-video provisioning (multi-rendition).

The lecture video is large and is NOT committed to git. It is fetched on demand
so a fresh clone (or an ephemeral host) can stream out of the box:

  * In the Docker image it is provisioned at build time, so the container ships
    ready to stream.
  * For native/local runs, or when the cache is missing, ``ensure_video`` does
    it on startup.

The source is downloaded once and encoded into several **renditions** (see
``_RENDITIONS``), each a stream-ready **fragmented** MP4 (fMP4, so the browser's
MSE SourceBuffer can be fed it segment-by-segment), cached as
``media/lecture-{id}.mp4``. The client picks one and can switch (see
`/stream?q=`); switching restarts playback (the stream has no seek).

**Audio is always transcoded to AAC.** The sample assets (Blender's Big Buck
Bunny) ship MP3 audio, and MP3-in-MP4 is not reliably decodable via MSE — the
browser rejects the whole stream on a codec mismatch. AAC is universal and
matches the ``mp4a.40.2`` reported by /info.

ffmpeg is resolved at run time (``_ffmpeg_bin``): the Docker image installs it
via apt; native runs fall back to the static binary from ``imageio-ffmpeg``.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
import threading
import urllib.request
import zipfile
from pathlib import Path

from .config import (
    VIDEO_CACHE_DIR,
    VIDEO_DEFAULT_RENDITION,
    VIDEO_MIME_CODEC,
    VIDEO_SOURCE_URL,
)

log = logging.getLogger("uvicorn.error")

# Guards two callers (startup task + a request handler) racing to provision.
_lock = threading.Lock()

_VIDEO_SUFFIXES = (".mp4", ".m4v", ".mov", ".webm")
_COPY_CHUNK = 1024 * 1024  # 1 MiB

# Rendition ladder. Each is encoded from the single downloaded source:
#   720p  — downscaled + capped to 30fps, re-encoded H.264 High@4.0 (light).
#   1080p — the source video stream copied losslessly (heaviest).
# Audio is forced to AAC for both (added in `_encode`).
_RENDITIONS = [
    {
        "id": "720p",
        "label": "720p",
        "video_args": [
            "-vf", "scale=-2:720", "-r", "30",
            "-c:v", "libx264", "-profile:v", "high", "-level", "4.0",
            "-preset", "veryfast", "-pix_fmt", "yuv420p",
        ],
    },
    {
        "id": "1080p",
        "label": "1080p",
        "video_args": ["-c:v", "copy"],
    },
]


def rendition_path(rid: str) -> Path:
    return VIDEO_CACHE_DIR / f"lecture-{rid}.mp4"


def _ready(path: Path) -> bool:
    return path.exists() and path.stat().st_size > 0


def _all_ready() -> bool:
    return all(_ready(rendition_path(r["id"])) for r in _RENDITIONS)


def resolve_rendition_path(rid: str) -> Path:
    """Path for `rid` if it's a known, ready rendition; else the default's."""
    if any(r["id"] == rid for r in _RENDITIONS) and _ready(rendition_path(rid)):
        return rendition_path(rid)
    return rendition_path(VIDEO_DEFAULT_RENDITION)


def rendition_info() -> list[dict]:
    """Renditions available to the client, for /stream/{id}/info."""
    out = []
    for r in _RENDITIONS:
        p = rendition_path(r["id"])
        if _ready(p):
            out.append({"id": r["id"], "label": r["label"],
                        "mimeCodec": VIDEO_MIME_CODEC, "size": p.stat().st_size})
    return out


def _download(url: str, dest: Path) -> None:
    log.info("[video] downloading %s", url)
    tmp = dest.with_name(dest.name + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "GazingEngageMent/0.1"})
    with urllib.request.urlopen(req, timeout=60) as resp, tmp.open("wb") as fh:
        shutil.copyfileobj(resp, fh, _COPY_CHUNK)
    tmp.replace(dest)
    log.info("[video] downloaded %.1f MB -> %s", dest.stat().st_size / 1e6, dest)


def _extract_video_from_zip(zip_path: Path, dest: Path) -> None:
    with zipfile.ZipFile(zip_path) as zf:
        members = [n for n in zf.namelist() if n.lower().endswith(_VIDEO_SUFFIXES)]
        if not members:
            raise RuntimeError(f"no video file found inside {zip_path.name}")
        log.info("[video] extracting %s", members[0])
        tmp = dest.with_name(dest.name + ".part")
        with zf.open(members[0]) as src, tmp.open("wb") as fh:
            shutil.copyfileobj(src, fh, _COPY_CHUNK)
        tmp.replace(dest)


def _acquire_source(tmpdir: Path) -> Path:
    """Download (and unzip) the source video into tmpdir; return its path."""
    url = VIDEO_SOURCE_URL
    raw = tmpdir / "source.mp4"
    if url.lower().endswith(".zip"):
        zip_path = tmpdir / "source.zip"
        _download(url, zip_path)
        _extract_video_from_zip(zip_path, raw)
    else:
        _download(url, raw)
    return raw


def _ffmpeg_bin() -> str:
    """Resolve an ffmpeg executable.

    Order: ``FFMPEG_BINARY`` env → system ffmpeg on PATH (Docker's apt install)
    → the static binary bundled by the ``imageio-ffmpeg`` pip package.
    """
    override = os.environ.get("FFMPEG_BINARY")
    if override:
        return override
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg  # bundled static binary; see requirements.txt

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:  # pragma: no cover - only when neither is present
        raise RuntimeError(
            "ffmpeg not found. Install it (winget/brew/apt install ffmpeg) "
            "or `pip install imageio-ffmpeg`."
        ) from exc


def _encode(src: Path, dest: Path, video_args: list[str]) -> None:
    """Encode ``src`` into a fragmented MP4 at ``dest`` with the given video args.

    Audio is always AAC; output is fragmented for MSE. Atomic via a .part file.
    """
    ffmpeg = _ffmpeg_bin()
    tmp = dest.with_name(dest.name + ".part")
    cmd = [
        ffmpeg, "-y", "-i", str(src), "-map", "0:v:0", "-map", "0:a:0",
        *video_args, "-c:a", "aac",
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", str(tmp),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed for {dest.name}:\n{result.stderr[-2000:]}")
    tmp.replace(dest)


def _fragment(src: Path, dest: Path) -> None:
    """Stream-copy video + AAC audio into a fragmented MP4 (the 1080p rendition)."""
    _encode(src, dest, ["-c:v", "copy"])


def ensure_video() -> Path:
    """Ensure all renditions exist; download + encode any that are missing.

    Downloads the source once and encodes each rendition. Idempotent,
    lock-guarded. Returns the default rendition's path. A rendition that fails
    to encode is logged and skipped, but the default rendition must succeed.
    """
    if _all_ready():
        return resolve_rendition_path(VIDEO_DEFAULT_RENDITION)

    with _lock:
        if _all_ready():
            return resolve_rendition_path(VIDEO_DEFAULT_RENDITION)

        VIDEO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=VIDEO_CACHE_DIR) as tmpdir:
            raw = _acquire_source(Path(tmpdir))
            for r in _RENDITIONS:
                dest = rendition_path(r["id"])
                if _ready(dest):
                    continue
                log.info("[video] encoding rendition %s", r["id"])
                try:
                    _encode(raw, dest, r["video_args"])
                except Exception:
                    log.exception("[video] rendition %s failed", r["id"])

        default = rendition_path(VIDEO_DEFAULT_RENDITION)
        if not _ready(default):
            raise RuntimeError(f"default rendition {VIDEO_DEFAULT_RENDITION} not produced")
        log.info("[video] renditions ready: %s", [i["id"] for i in rendition_info()])
        return default
