"""Server-gated lecture-video streaming.

Endpoints
---------
GET /stream/{lecture_id}/info  ->  { "mimeCodec": str, "size": int }
    Metadata the browser needs to build an MSE SourceBuffer before it opens the
    socket.

WS  /stream/{lecture_id}
    Pumps the fragmented MP4 to the client as binary frames, in file order
    (init segment first, then moof/mdat fragments), so the client can append
    them to its SourceBuffer without box-boundary alignment. The server only
    sends a chunk when BOTH hold:
      * the engagement gate is open (the client has not sent {"type":"pause"}), and
      * the client has outstanding credit (it sent {"type":"pull","n":k}).
    The gate is what enforces "won't play when the student looks away": the
    browser reports inattention with a pause frame and the server withholds
    bytes; credits are ordinary buffer backpressure.

Protocol
--------
Client -> server (text JSON control frames):
    {"type":"pull","n":<int>}   grant N chunk credits
    {"type":"pause"}            close the gate (stop sending)
    {"type":"resume"}           open the gate

Server -> client:
    <binary>                    a media chunk (append to the SourceBuffer in order)
    {"type":"eof"}              file exhausted -> MediaSource.endOfStream()
    {"type":"error","message"}  fatal; client tears down

Single-process only, like the existing /live broadcaster. See docs spec §5.
"""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from .config import STREAM_CHUNK_BYTES, VIDEO_DEFAULT_RENDITION
from .video import ensure_video, rendition_info, resolve_rendition_path

log = logging.getLogger("uvicorn.error")

router = APIRouter()


@router.get("/stream/{lecture_id}/info")
async def stream_info(lecture_id: str) -> dict:
    """Return available renditions ({id,label,mimeCodec,size}) + the default id."""
    try:
        # Blocks until the (background) provisioning has produced the files.
        await asyncio.to_thread(ensure_video)
    except Exception as exc:  # still downloading, or failed
        log.warning("[stream] info requested but video not ready: %s", exc)
        raise HTTPException(status_code=503, detail="video not available yet")
    return {"renditions": rendition_info(), "default": VIDEO_DEFAULT_RENDITION}


class _PumpState:
    """Shared state between the control reader and the byte pump."""

    def __init__(self) -> None:
        self.gate_open = True  # engagement gate; closed by {"type":"pause"}
        self.credits = 0       # backpressure; granted by {"type":"pull"}
        self.closed = False    # client disconnected
        self.wake = asyncio.Event()

    def can_send(self) -> bool:
        return self.gate_open and self.credits > 0


async def _read_control(ws: WebSocket, state: _PumpState) -> None:
    """Consume client control frames, updating shared state, until disconnect."""
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                continue
            kind = msg.get("type") if isinstance(msg, dict) else None
            if kind == "pull":
                try:
                    n = int(msg.get("n", 1))
                except (ValueError, TypeError):
                    n = 1
                state.credits += max(0, n)
            elif kind == "pause":
                state.gate_open = False
            elif kind == "resume":
                state.gate_open = True
            state.wake.set()
    except WebSocketDisconnect:
        pass
    finally:
        state.closed = True
        state.wake.set()


@router.websocket("/stream/{lecture_id}")
async def stream_video(ws: WebSocket, lecture_id: str) -> None:
    await ws.accept()
    quality = ws.query_params.get("q", VIDEO_DEFAULT_RENDITION)

    try:
        await asyncio.to_thread(ensure_video)
    except Exception as exc:
        log.warning("[stream] video unavailable: %s", exc)
        await ws.send_json({"type": "error", "message": "video not available"})
        await ws.close()
        return
    path = resolve_rendition_path(quality)

    state = _PumpState()
    reader = asyncio.create_task(_read_control(ws, state))

    try:
        f = await asyncio.to_thread(open, path, "rb")
        try:
            while True:
                # Block until we may send (gate open + credit) or the client left.
                # clear()-then-recheck avoids a lost wakeup if the reader updates
                # state between our check and the wait.
                while not state.closed and not state.can_send():
                    state.wake.clear()
                    if state.closed or state.can_send():
                        continue
                    await state.wake.wait()
                if state.closed:
                    break

                chunk = await asyncio.to_thread(f.read, STREAM_CHUNK_BYTES)
                if not chunk:
                    await ws.send_json({"type": "eof"})
                    break
                await ws.send_bytes(chunk)
                state.credits -= 1
        finally:
            await asyncio.to_thread(f.close)
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("[stream] pump error")
    finally:
        reader.cancel()
        try:
            await reader
        except BaseException:
            pass
        try:
            await ws.close()
        except Exception:
            pass
