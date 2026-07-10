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


if __name__ == "__main__":
    unittest.main(verbosity=2)
