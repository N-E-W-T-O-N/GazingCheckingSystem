"""Per-session aggregate report.

Implements the four metrics defined in MATH.md §7.3:
  mean_engagement, percent_attentive, percent_disengaged, longest_drop_seconds

`longest_drop_seconds` is computed on the un-smoothed score stream so that
brief but severe drops aren't hidden by client-side EMA smoothing.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from .config import ATTENTIVE_THRESHOLD, DISENGAGED_THRESHOLD
from .db import get_db
from .models import EngagementEvent, Session
from .schemas import SessionReport

router = APIRouter()


def _longest_below(times: list[float], scores: list[float], threshold: float) -> float:
    """Longest contiguous run where score < threshold, in seconds.

    `times` are assumed sorted ascending (we sort them before calling). The
    duration of a run is `t_last - t_first` between the first and last sample
    that satisfy the predicate; single-sample runs are counted with duration
    equal to the median sample interval to avoid a zero result for very brief
    drops.
    """
    if not times:
        return 0.0
    # Median sample interval as a fallback duration for one-sample runs.
    deltas = sorted(t2 - t1 for t1, t2 in zip(times, times[1:]) if t2 > t1)
    median_dt = deltas[len(deltas) // 2] if deltas else 1.0

    best = 0.0
    run_start: float | None = None
    run_last: float | None = None
    for t, s in zip(times, scores):
        if s < threshold:
            if run_start is None:
                run_start = t
            run_last = t
        else:
            if run_start is not None and run_last is not None:
                duration = max(run_last - run_start, median_dt)
                best = max(best, duration)
            run_start = None
            run_last = None
    if run_start is not None and run_last is not None:
        duration = max(run_last - run_start, median_dt)
        best = max(best, duration)
    return best


@router.get("/sessions/{session_id}/report", response_model=SessionReport)
def session_report(session_id: str, db: DbSession = Depends(get_db)) -> SessionReport:
    sess = db.get(Session, session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="session not found")

    rows = db.execute(
        select(EngagementEvent.t, EngagementEvent.score)
        .where(EngagementEvent.session_id == session_id)
        .order_by(EngagementEvent.t.asc())
    ).all()

    n = len(rows)
    if n == 0:
        return SessionReport(
            session_id=sess.id,
            lecture_id=sess.lecture_id,
            user_id=sess.user_id,
            mode=sess.mode,
            n_events=0,
            mean_engagement=0.0,
            percent_attentive=0.0,
            percent_disengaged=0.0,
            longest_drop_seconds=0.0,
        )

    times = [r[0] for r in rows]
    scores = [r[1] for r in rows]

    mean_e = sum(scores) / n
    pct_attentive = sum(1 for s in scores if s > ATTENTIVE_THRESHOLD) / n
    pct_disengaged = sum(1 for s in scores if s < DISENGAGED_THRESHOLD) / n
    longest_drop = _longest_below(times, scores, DISENGAGED_THRESHOLD)

    return SessionReport(
        session_id=sess.id,
        lecture_id=sess.lecture_id,
        user_id=sess.user_id,
        mode=sess.mode,
        n_events=n,
        mean_engagement=mean_e,
        percent_attentive=pct_attentive,
        percent_disengaged=pct_disengaged,
        longest_drop_seconds=longest_drop,
    )
