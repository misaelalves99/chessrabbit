"""
The numbers behind the admin dashboard.

Kept out of the router so the aggregation can be exercised without going
through HTTP, the same split services/insights.py uses.

Two things worth knowing before reading a chart built from this module:

- Every daily series is generated from `generate_series` and LEFT JOINed to the
  counts, so a day with no activity is a zero rather than a gap. A line chart
  that silently drops empty days reads as though nothing happened between the
  points it does have, which is the opposite of the truth.
- Days are bucketed in the database server's timezone (UTC in our containers),
  not the reader's. An operator in IST sees days that end at 05:30 local. This
  is deliberate - the alternative is a per-request offset that makes two
  operators disagree about yesterday's signups.
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.services import presence



async def _series(db: AsyncSession, inner_sql: str, days: int) -> list[dict]:
    """
    One count per day for the last `days` days, zeros included.

    `inner_sql` must select exactly two columns, `day` (date) and `n` (bigint).
    It is a module-level constant at every call site - never user input - which
    is what makes the interpolation below safe; `days` is bound as a parameter.
    """
    rows = await db.execute(
        text(
            f"""
            SELECT d::date AS day, coalesce(c.n, 0) AS value
            FROM generate_series(
                   CURRENT_DATE - make_interval(days => :days - 1),
                   CURRENT_DATE,
                   INTERVAL '1 day'
                 ) d
            LEFT JOIN ({inner_sql}) c ON c.day = d::date
            ORDER BY d
            """
        ),
        {"days": days},
    )
    return [{"day": r.day.isoformat(), "value": int(r.value)} for r in rows]


_NEW_USERS = """
    SELECT date(created_at) AS day, count(*) AS n
    FROM users
    WHERE created_at >= CURRENT_DATE - make_interval(days => :days - 1)
    GROUP BY 1
"""

_ACTIVE_USERS = """
    SELECT day, count(*) AS n
    FROM daily_active_users
    WHERE day >= CURRENT_DATE - make_interval(days => :days - 1)
    GROUP BY 1
"""



_GAMES = """
    SELECT date(created_at) AS day, count(*) AS n
    FROM games
    WHERE owner_id IS NOT NULL
      AND created_at >= CURRENT_DATE - make_interval(days => :days - 1)
    GROUP BY 1
"""

_JOBS = """
    SELECT date(created_at) AS day, count(*) AS n
    FROM analysis_jobs
    WHERE created_at >= CURRENT_DATE - make_interval(days => :days - 1)
    GROUP BY 1
"""


async def _live(db: AsyncSession) -> dict:
    """Who is here now, and who has been here recently."""
    return {
        # None when Redis is unreachable. The dashboard renders that as
        # "unavailable" - reporting zero would be a lie that looks like an
        # outage in the product rather than in the metric.
        "online_now": await presence.count_online(),
        "active_today": await presence.active_since(db, 1),
        "active_7d": await presence.active_since(db, 7),
        "active_30d": await presence.active_since(db, 30),
    }


async def _users(db: AsyncSession, days: int) -> dict:
    counts = await db.execute(
        text(
            """
            SELECT
              count(*)                                                  AS total,
              count(*) FILTER (WHERE email_verified)                    AS verified,
              count(*) FILTER (WHERE suspended_at IS NOT NULL)          AS suspended,
              count(*) FILTER (WHERE created_at >= CURRENT_DATE)        AS new_today,
              count(*) FILTER (WHERE created_at >= CURRENT_DATE - 6)    AS new_7d,
              count(*) FILTER (WHERE created_at >= CURRENT_DATE - 29)   AS new_30d
            FROM users
            WHERE deleted_at IS NULL
            """
        )
    )
    summary = dict(counts.mappings().one())

    return {
        **{k: int(v) for k, v in summary.items()},
        "new_series": await _series(db, _NEW_USERS, days),
    }




async def overview(db: AsyncSession, days: int = 30) -> dict:
    """Everything the dashboard's first screen needs, in one round trip."""
    return {
        "days": days,
        "live": await _live(db),
        "users": await _users(db, days),
        "engagement": {
            "active_series": await _series(db, _ACTIVE_USERS, days),
            "games_series": await _series(db, _GAMES, days),
            "jobs_series": await _series(db, _JOBS, days),
        },
    }
