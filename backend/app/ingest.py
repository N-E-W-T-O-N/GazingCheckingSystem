"""Ingest endpoint + live WebSocket broadcaster.

Architecture:
  POST /ingest               → persists events, then fan-outs to live subscribers
  WS   /live/{lecture_id}    → instructor subscribes per lecture

The WebSocket manager is intentionally tiny (in-process). For multi-process
deployment replace it with Redis pub/sub — the public method names stay the
same.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session as DbSession

from .db import get_db
from .models import EngagementEvent, Session
from .schemas import IngestRequest, IngestResponse

router = APIRouter()


class LiveBroadcaster:
    """In-process pub/sub keyed by lecture_id."""

    def __init__(self) -> None:
        self._subscribers: dict[str, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def subscribe(self, lecture_id: str, ws: WebSocket) -> None:
        async with self._lock:
            self._subscribers[lecture_id].add(ws)

    async def unsubscribe(self, lecture_id: str, ws: WebSocket) -> None:
        async with self._lock:
            self._subscribers[lecture_id].discard(ws)
            if not self._subscribers[lecture_id]:
                self._subscribers.pop(lecture_id, None)

    async def publish(self, lecture_id: str, payload: dict[str, Any]) -> None:
        # Snapshot subscribers under lock, send outside lock so a slow
        # client cannot stall ingest.
        async with self._lock:
            targets = list(self._subscribers.get(lecture_id, ()))
        dead: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._subscribers[lecture_id].discard(ws)


broadcaster = LiveBroadcaster()


@router.post("/ingest", response_model=IngestResponse)
async def ingest(payload: IngestRequest, db: DbSession = Depends(get_db)) -> IngestResponse:
    """Accept a batch of engagement events.

    The first event for a (session_id) creates the Session row. Subsequent
    batches update last_event_at. All events for the batch are persisted in
    one transaction.
    """
    sess = db.get(Session, payload.session_id)
    now = datetime.now(timezone.utc)
    if sess is None:
        sess = Session(
            id=payload.session_id,
            lecture_id=payload.lecture_id,
            user_id=payload.user_id,
            mode=payload.mode,
            started_at=now,
            last_event_at=now,
        )
        db.add(sess)
    else:
        sess.last_event_at = now
        # `mode` can change mid-session if a user toggles camera permission.
        sess.mode = payload.mode

    for ev in payload.events:
        db.add(
            EngagementEvent(
                session_id=payload.session_id,
                t=ev.t,
                score=ev.score,
                features=ev.features.model_dump(),
                affect=ev.affect,
                drowsiness=ev.drowsiness,
            )
        )

    db.commit()

    # Fan-out the latest score per user to the live dashboard subscribers.
    if payload.events:
        latest = payload.events[-1]
        await broadcaster.publish(
            payload.lecture_id,
            {
                "user_id": payload.user_id,
                "session_id": payload.session_id,
                "mode": payload.mode,
                "t": latest.t,
                "score": latest.score,
            },
        )

    return IngestResponse(accepted=len(payload.events))


@router.websocket("/live/{lecture_id}")
async def live(ws: WebSocket, lecture_id: str) -> None:
    """Instructor dashboard subscription endpoint.

    The server pushes one JSON message per (user, batch) as ingest events
    arrive. The client should treat absence of messages as no activity, not
    as an error.
    """
    await ws.accept()
    await broadcaster.subscribe(lecture_id, ws)
    try:
        while True:
            # Drain any client messages (keepalive pings); we don't expect
            # commands on this channel in v1.
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await broadcaster.unsubscribe(lecture_id, ws)
