"""Lecture-video provisioning.

The lecture video is large and is NOT committed to git. Instead it is fetched
on demand so a fresh clone (or an ephemeral host) can stream out of the box:

  * In the Docker image it is baked in at build time (see the Dockerfile
    ``RUN curl`` step), so the container ships ready to stream.
  * For native/local runs, or when the cached file is missing, ``ensure_video``
    downloads it on startup.

Both paths land a stream-ready **fragmented** MP4 at ``config.VIDEO_PATH`` (fMP4,
so the browser's MSE SourceBuffer can be fed the file segment-by-segment). The
source may be a direct media file or a ``.zip`` containing one (the default
Blender Big Buck Bunny asset is a zip); ``ensure_video`` detects a zip and
extracts the video before fragmenting it.

ffmpeg is resolved at run time (see ``_ffmpeg_bin``): the Docker image installs
it via apt, and native/local runs fall back to the static binary bundled by the
``imageio-ffmpeg`` pip package, so no manual ffmpeg install is required.
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

from .config import VIDEO_CACHE_DIR, VIDEO_PATH, VIDEO_SOURCE_URL

log = logging.getLogger("uvicorn.error")

# Guards against two callers (e.g. the startup task and a request handler)
# racing to download the same file.
_lock = threading.Lock()

_VIDEO_SUFFIXES = (".mp4", ".m4v", ".mov", ".webm")
_COPY_CHUNK = 1024 * 1024  # 1 MiB


def _is_ready() -> bool:
    return VIDEO_PATH.exists() and VIDEO_PATH.stat().st_size > 0


def _download(url: str, dest: Path) -> None:
    """Stream ``url`` to ``dest`` via a temp file, then atomically rename."""
    log.info("[video] downloading %s", url)
    tmp = dest.with_name(dest.name + ".part")
    # Blender's download host wants a UA; default urllib UA is fine but be explicit.
    req = urllib.request.Request(url, headers={"User-Agent": "GazingEngageMent/0.1"})
    with urllib.request.urlopen(req, timeout=60) as resp, tmp.open("wb") as fh:
        shutil.copyfileobj(resp, fh, _COPY_CHUNK)
    tmp.replace(dest)
    log.info("[video] downloaded %.1f MB -> %s", dest.stat().st_size / 1e6, dest)


def _extract_video_from_zip(zip_path: Path, dest: Path) -> None:
    """Extract the first video entry from ``zip_path`` to ``dest`` atomically."""
    with zipfile.ZipFile(zip_path) as zf:
        members = [n for n in zf.namelist() if n.lower().endswith(_VIDEO_SUFFIXES)]
        if not members:
            raise RuntimeError(f"no video file found inside {zip_path.name}")
        member = members[0]
        log.info("[video] extracting %s", member)
        tmp = dest.with_name(dest.name + ".part")
        with zf.open(member) as src, tmp.open("wb") as fh:
            shutil.copyfileobj(src, fh, _COPY_CHUNK)
        tmp.replace(dest)


def _ffmpeg_bin() -> str:
    """Resolve an ffmpeg executable.

    Order: ``FFMPEG_BINARY`` env → system ffmpeg on PATH (what the Docker image
    installs via apt) → the static binary bundled by the ``imageio-ffmpeg`` pip
    package (so native/local runs work with no system install).
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


def _run_ffmpeg(ffmpeg: str, src: Path, dest: Path, codec_args: list[str]):
    # Fragmented MP4 (moof/mdat fragments) so the browser's MSE SourceBuffer can
    # be fed the file segment-by-segment. See docs spec §5.
    cmd = [
        ffmpeg, "-y", "-i", str(src), *codec_args,
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", str(dest),
    ]
    return subprocess.run(cmd, capture_output=True, text=True)


def _fragment(src: Path, dest: Path) -> None:
    """Remux ``src`` into an MSE-ready fragmented MP4 at ``dest`` (atomic via .part).

    Video is stream-copied (lossless H.264); **audio is always transcoded to AAC**.
    The sample assets (Blender's Big Buck Bunny) ship MP3 audio, and MP3-in-MP4 is not
    reliably decodable via Media Source Extensions — the browser's demuxer rejects the
    whole stream on a codec mismatch, so the video never plays. AAC is universally
    MSE-supported and matches the `mp4a.40.2` codec string reported by /info.
    """
    ffmpeg = _ffmpeg_bin()
    tmp = dest.with_name(dest.name + ".part")
    log.info("[video] fragmenting %s -> %s (audio -> AAC)", src.name, dest)
    # Copy the H.264 video, force AAC audio.
    result = _run_ffmpeg(ffmpeg, src, tmp, ["-c:v", "copy", "-c:a", "aac"])
    if result.returncode != 0:
        # Last resort for a non-H.264 source: full re-encode to H.264 + AAC.
        log.warning("[video] copy+aac failed, retrying with a full re-encode")
        result = _run_ffmpeg(
            ffmpeg, src, tmp, ["-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac"]
        )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg fragmentation failed:\n{result.stderr[-2000:]}")
    tmp.replace(dest)


def ensure_video() -> Path:
    """Ensure a stream-ready (fragmented MP4) lecture video exists at VIDEO_PATH.

    If missing, download the source (extracting it when it is a .zip) and
    fragment it with ffmpeg. Idempotent and safe to call repeatedly or
    concurrently. Raises on failure so callers can decide how to react (the
    startup task logs and continues; a request handler can surface an error).
    """
    if _is_ready():
        return VIDEO_PATH

    with _lock:
        # Re-check inside the lock: another caller may have just finished.
        if _is_ready():
            return VIDEO_PATH

        VIDEO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        url = VIDEO_SOURCE_URL

        # Stage the raw source in a temp dir, then fragment into VIDEO_PATH.
        with tempfile.TemporaryDirectory(dir=VIDEO_CACHE_DIR) as tmpdir:
            tmp = Path(tmpdir)
            raw = tmp / "source.mp4"
            if url.lower().endswith(".zip"):
                zip_path = tmp / "source.zip"
                _download(url, zip_path)
                _extract_video_from_zip(zip_path, raw)
            else:
                _download(url, raw)
            _fragment(raw, VIDEO_PATH)

        log.info("[video] ready (fragmented) at %s", VIDEO_PATH)
        return VIDEO_PATH
