"""
Who is using the site, right now and on any past day.

Nothing recorded user activity before this: there is no last_seen column and no
session log, so "how many users are active" had no answer at any price. Two
halves, because they are two different questions:

    Redis   - "online now". A sorted set scored by last-seen timestamp. This is
              a question about the present; it does not need to survive a
              restart, and losing it costs nothing but a few minutes of
              recovery.
    Postgres - "active on 4 June". One row per user per day in
              daily_active_users. This is history, so it has to be durable, and
              a Redis flush must not be able to erase it.

Cost control is the point of the split. The Redis write happens on every
authenticated request and is a single O(log n) ZADD. The database write happens
at most ONCE PER USER PER DAY, gated by a Redis SET NX that only the first
request of that user's day wins.

Everything here fails open. A dashboard metric is never worth returning 500 on
a user's request, so a Redis outage degrades presence to "unknown" and leaves
the API serving - the same trade core/ratelimit.py makes for the same reason.
"""

from __future__ import annotations

import logging
import time
from datetime import date, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.redis_client import get_redis

log = logging.getLogger(__name__)

PRESENCE_KEY = "presence"
# The DAU guard outlives its day so a user active at 23:59 does not write a
# second row at 00:01 for a day they were already counted on.
DAU_GUARD_TTL_S = 172_800


async def touch(db: AsyncSession, user_id: int) -> None:
    """
    Record that `user_id` was seen just now.

    Called from get_current_user, which every authenticated request already
    passes through. Admin requests do not call it: operators are not users, and
    counting them would inflate the number they are looking at.
    """
    now = time.time()

    try:
        redis = get_redis()
        await redis.zadd(PRESENCE_KEY, {str(user_id): now})
        # Returns None when the key already exists, i.e. this user has already
        # been written to the database today.
        first_today = await redis.set(
            f"dau:{user_id}:{date.today().isoformat()}", "1",
            nx=True, ex=DAU_GUARD_TTL_S,
        )
    except Exception:
        log.warning("Presence: Redis unavailable, skipping activity record")
        return

    if not first_today:
        return

    try:
        await db.execute(
            text(
                "INSERT INTO daily_active_users (day, user_id) "
                "VALUES (CURRENT_DATE, :uid) ON CONFLICT DO NOTHING"
            ),
            {"uid": user_id},
        )
        await db.commit()
    except Exception:
        # The guard key is already set, so this user will not be retried until
        # tomorrow - one missed row on a transient error, which is the right
        # price for never failing a user's request over a statistic.
        log.warning("Presence: could not record daily active user %s", user_id, exc_info=True)
        await db.rollback()


async def count_online(window_s: int | None = None) -> int | None:
    """
    Users seen within the window. None means Redis could not answer, which the
    dashboard shows as "unavailable" rather than as zero.
    """
    window = window_s if window_s is not None else settings.PRESENCE_WINDOW_S
    try:
        return await get_redis().zcount(PRESENCE_KEY, time.time() - window, "+inf")
    except Exception:
        log.warning("Presence: Redis unavailable, online count unknown")
        return None


async def active_since(db: AsyncSession, days: int) -> int:
    """Distinct users active in the last `days` days, today included."""
    since = date.today() - timedelta(days=days - 1)
    row = await db.execute(
        text("SELECT count(DISTINCT user_id) FROM daily_active_users WHERE day >= :since"),
        {"since": since},
    )
    return row.scalar_one()


async def trim(max_age_s: int = 86_400) -> int:
    """
    Drop presence entries far older than any window we report on.

    Without this the sorted set keeps one member per user who has ever signed
    in - small, but unbounded, and none of it is ever read. Called nightly from
    services/maintenance.py.
    """
    try:
        return await get_redis().zremrangebyscore(
            PRESENCE_KEY, "-inf", time.time() - max_age_s
        )
    except Exception:
        log.warning("Presence: Redis unavailable, skipping trim")
        return 0
