"""Player Insights: aggregate statistics across a player's own games."""

from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.redis_client import get_redis
from app.models import User
from app.services.insights import Filters, cached_insights

router = APIRouter(tags=["insights"])

TIME_CLASSES = ("bullet", "blitz", "rapid", "classical", "correspondence")
RANGES = {"30d": 30, "90d": 90, "1y": 365}


@router.get("/insights")
async def get_insights(
    time_class: str | None = Query(default=None),
    color: str | None = Query(default=None, pattern="^[wb]$"),
    range_: str = Query(default="all", alias="range"),
    # Minutes east of UTC, from the browser. Without it "when do you play
    # worst?" would answer in UTC, which is nobody's evening.
    tz_offset: int = Query(default=0, ge=-840, le=840),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Everything the Insights page draws, in one response.

    Filters are deliberately coarse (time class, colour, a few date ranges):
    each combination is a cache key, and the value of a finer filter does not
    pay for the cache misses it would cause.
    """
    if time_class is not None and time_class not in TIME_CLASSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "bad_time_class",
                "message": f"time_class must be one of {', '.join(TIME_CLASSES)}",
            },
        )
    if range_ != "all" and range_ not in RANGES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "bad_range",
                "message": f"range must be 'all' or one of {', '.join(RANGES)}",
            },
        )

    since = None if range_ == "all" else date.today() - timedelta(days=RANGES[range_])
    filters = Filters(
        time_class=time_class, color=color, since=since, tz_offset=tz_offset
    )

    return await cached_insights(db, user, filters, get_redis())
