"""Tests for app.video provisioning.

Path-agnostic (locates the backend package relative to THIS file, so it makes
no assumption about where the repo lives) and offline: a tiny locally generated
clip stands in for the 355 MB Blender asset and is served to the real
``ensure_video()`` via a ``file://`` URL, so the actual backend build path
(download → fragment) runs with no network.

Run with either:
    python backend/tests/test_video.py
    python -m unittest discover -s backend/tests
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# Make the backend package importable without hardcoding an absolute repo path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import video  # noqa: E402


def _make_source_clip(dest: Path) -> None:
    """Build a tiny H.264+AAC clip using the backend's own ffmpeg resolver."""
    ffmpeg = video._ffmpeg_bin()
    subprocess.run(
        [ffmpeg, "-y",
         "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
         "-c:v", "libx264", "-c:a", "aac", "-shortest", str(dest)],
        check=True, capture_output=True,
    )


def _make_mp3_source(dest: Path) -> None:
    """Build a clip with **MP3** audio in an MP4 — the shape that broke MSE."""
    ffmpeg = video._ffmpeg_bin()
    subprocess.run(
        [ffmpeg, "-y",
         "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
         "-c:v", "libx264", "-c:a", "libmp3lame", "-shortest", str(dest)],
        check=True, capture_output=True,
    )


def _ffprobe_bin() -> str | None:
    """Resolve ffprobe (system, or alongside the resolved ffmpeg). None if absent."""
    found = shutil.which("ffprobe")
    if found:
        return found
    ffmpeg = Path(video._ffmpeg_bin())
    sibling = ffmpeg.with_name("ffprobe" + ffmpeg.suffix)
    return str(sibling) if sibling.exists() else None


def _audio_codec(ffprobe: str, path: Path) -> str:
    out = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    )
    return out.stdout.strip()


class EnsureVideoTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        # Snapshot the module-level config so each test restores it.
        self._saved = (video.VIDEO_CACHE_DIR, video.VIDEO_PATH, video.VIDEO_SOURCE_URL)

    def tearDown(self) -> None:
        video.VIDEO_CACHE_DIR, video.VIDEO_PATH, video.VIDEO_SOURCE_URL = self._saved
        self._tmp.cleanup()

    def test_downloads_and_fragments(self) -> None:
        # The backend builds the mp4: ensure_video() fetches the source and
        # fragments it. We only supply a stand-in source and assert the result.
        source = self.tmp / "source.mp4"
        _make_source_clip(source)

        out = self.tmp / "lecture.mp4"
        video.VIDEO_CACHE_DIR = self.tmp
        video.VIDEO_PATH = out
        video.VIDEO_SOURCE_URL = source.as_uri()  # file:// — no network

        result = video.ensure_video()

        self.assertEqual(result, out)
        data = out.read_bytes()
        self.assertIn(b"ftyp", data[:64], "missing init segment")
        self.assertIn(b"moof", data, "output is not a fragmented MP4 (no moof box)")

    def test_is_idempotent_when_present(self) -> None:
        out = self.tmp / "lecture.mp4"
        out.write_bytes(b"x" * 16)  # pretend it is already provisioned
        video.VIDEO_PATH = out
        # An unreachable URL: if ensure_video tried to fetch it the test fails.
        video.VIDEO_SOURCE_URL = "http://127.0.0.1:0/should-not-be-fetched"

        self.assertEqual(video.ensure_video(), out)
        self.assertEqual(out.read_bytes(), b"x" * 16, "existing file was overwritten")

    def test_fragment_transcodes_mp3_audio_to_aac(self) -> None:
        # Regression: a source with MP3 audio (like the Blender asset) must come out
        # as AAC, or MSE rejects the stream and no video plays.
        ffprobe = _ffprobe_bin()
        if not ffprobe:
            self.skipTest("ffprobe not available")
        src = self.tmp / "mp3src.mp4"
        _make_mp3_source(src)
        self.assertEqual(_audio_codec(ffprobe, src), "mp3", "test fixture should have MP3 audio")

        out = self.tmp / "fragmented.mp4"
        video._fragment(src, out)
        self.assertEqual(_audio_codec(ffprobe, out), "aac", "audio was not transcoded to AAC")


if __name__ == "__main__":
    unittest.main(verbosity=2)
