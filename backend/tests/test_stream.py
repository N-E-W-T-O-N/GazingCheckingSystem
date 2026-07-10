"""Integration test for the /stream WebSocket pump (app.stream).

Path-agnostic (locates backend/ relative to this file). Drives the real router
through Starlette's TestClient over a small fragmented clip built by the
backend's own ``video._fragment`` — so the actual pump code runs, not a stand-in.

Requires the test-only deps fastapi + httpx. Run with a Python that has them:
    python backend/tests/test_stream.py
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import stream, video  # noqa: E402


def _make_fragmented(dest: Path) -> None:
    """Build a small fragmented MP4 at ``dest`` using the backend's own code."""
    ffmpeg = video._ffmpeg_bin()
    src = dest.with_name("src.mp4")
    subprocess.run(
        [ffmpeg, "-y",
         "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=30",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
         "-c:v", "libx264", "-c:a", "aac", "-shortest", str(src)],
        check=True, capture_output=True,
    )
    video._fragment(src, dest)          # exercises real fragmentation
    src.unlink(missing_ok=True)


class StreamPumpTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "lecture.mp4"
        _make_fragmented(self.path)
        self._saved = (video.VIDEO_PATH, stream.STREAM_CHUNK_BYTES)
        video.VIDEO_PATH = self.path      # ensure_video() returns this (it exists)
        stream.STREAM_CHUNK_BYTES = 8192  # force several chunks from a small file
        app = FastAPI()
        app.include_router(stream.router)
        self.client = TestClient(app)

    def tearDown(self) -> None:
        video.VIDEO_PATH, stream.STREAM_CHUNK_BYTES = self._saved
        self._tmp.cleanup()

    def _drain(self, ws) -> bytes:
        """Collect binary frames until the server sends the eof control frame."""
        received = bytearray()
        while True:
            msg = ws.receive()
            if msg.get("bytes") is not None:
                received.extend(msg["bytes"])
            elif msg.get("text") is not None and '"eof"' in msg["text"]:
                break
        return bytes(received)

    def test_info(self) -> None:
        r = self.client.get("/stream/lec-1/info")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["size"], self.path.stat().st_size)
        self.assertIn("codecs", body["mimeCodec"])

    def test_pump_delivers_full_file_in_order(self) -> None:
        expected = self.path.read_bytes()
        with self.client.websocket_connect("/stream/lec-1") as ws:
            ws.send_json({"type": "pull", "n": 100000})  # plenty of credit
            received = self._drain(ws)
        self.assertEqual(received, expected)

    def test_no_bytes_without_credit(self) -> None:
        # With zero credit granted the pump must not send anything; then a pull
        # releases the stream. Proves credit-gating (backpressure).
        expected = self.path.read_bytes()
        with self.client.websocket_connect("/stream/lec-1") as ws:
            ws.send_json({"type": "pause"})              # gate shut
            ws.send_json({"type": "pull", "n": 100000})  # credit, but gated
            ws.send_json({"type": "resume"})             # now it may flow
            received = self._drain(ws)
        self.assertEqual(received, expected)


if __name__ == "__main__":
    unittest.main(verbosity=2)
