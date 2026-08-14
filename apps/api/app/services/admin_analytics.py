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

from app.core.tiers import TIERS, tier_for
from app.services import presence

# Statuses Stripe considers as currently paying. Mirrors billing.ACTIVE_STATUSES;
# both derive from the same Stripe vocabulary.
PAYING_STATUSES = ("active", "trialing")


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

_NEW_SUBS = """
    SELECT date(created_at) AS day, count(*) AS n
    FROM subscription_events
    WHERE event_type = 'subscribed'
      AND created_at >= CURRENT_DATE - make_interval(days => :days - 1)
    GROUP BY 1
"""

_CANCELLATIONS = """
    SELECT date(created_at) AS day, count(*) AS n
    FROM subscription_events
    WHERE event_type = 'canceled'
      AND created_at >= CURRENT_DATE - make_interval(days => :days - 1)
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

    plans = await db.execute(
        text(
            "SELECT plan, count(*) AS n FROM users "
            "WHERE deleted_at IS NULL GROUP BY plan"
        )
    )
    by_plan = {p: 0 for p in TIERS}
    for row in plans:
        by_plan[row.plan] = int(row.n)

    return {
        **{k: int(v) for k, v in summary.items()},
        "by_plan": by_plan,
        "new_series": await _series(db, _NEW_USERS, days),
    }


async def _revenue(db: AsyncSession, days: int) -> dict:
    """
    Subscription state now, plus the movement that got us here.

    MRR is computed from each paying user's CURRENT plan price rather than the
    amount snapshotted on their last event: it is a forward-looking figure -
    what the next month bills at - so today's prices are the right ones.
    """
    statuses = await db.execute(
        text(
            """
            SELECT s.status, u.plan, count(*) AS n
            FROM subscriptions s
            JOIN users u ON u.id = s.user_id
            WHERE u.deleted_at IS NULL
            GROUP BY s.status, u.plan
            """
        )
    )

    by_status: dict[str, int] = {}
    mrr_cents = 0
    paying = 0
    for row in statuses:
        by_status[row.status] = by_status.get(row.status, 0) + int(row.n)
        if row.status in PAYING_STATUSES:
            paying += int(row.n)
            mrr_cents += round(tier_for(row.plan).price_monthly * 100) * int(row.n)

    movement = await db.execute(
        text(
            """
            SELECT
              count(*) FILTER (WHERE event_type = 'subscribed')     AS subscribed,
              count(*) FILTER (WHERE event_type = 'canceled')       AS canceled,
              count(*) FILTER (WHERE event_type = 'payment_failed') AS payment_failed
            FROM subscription_events
            WHERE created_at >= CURRENT_DATE - make_interval(days => :days - 1)
            """
        ),
        {"days": days},
    )
    moved = {k: int(v) for k, v in movement.mappings().one().items()}

    total_users = (
        await db.execute(
            text("SELECT count(*) FROM users WHERE deleted_at IS NULL")
        )
    ).scalar_one()

    # Churn over the window against the base that could have churned: everyone
    # paying at the end plus everyone who left during it. The textbook
    # denominator is the count at the START of the window, which we cannot
    # reconstruct for periods before migration 013 - this approximation needs no
    # history and converges on the same number once the ledger has a full
    # window in it.
    churn_base = paying + moved["canceled"]

    return {
        "mrr_cents": mrr_cents,
        "paying": paying,
        "by_status": by_status,
        "conversion_pct": round(paying / total_users * 100, 1) if total_users else 0.0,
        "churn_pct": round(moved["canceled"] / churn_base * 100, 1) if churn_base else 0.0,
        **moved,
        "new_series": await _series(db, _NEW_SUBS, days),
        "canceled_series": await _series(db, _CANCELLATIONS, days),
    }


async def overview(db: AsyncSession, days: int = 30) -> dict:
    """Everything the dashboard's first screen needs, in one round trip."""
    return {
        "days": days,
        "live": await _live(db),
        "users": await _users(db, days),
        "revenue": await _revenue(db, days),
        "engagement": {
            "active_series": await _series(db, _ACTIVE_USERS, days),
            "games_series": await _series(db, _GAMES, days),
            "jobs_series": await _series(db, _JOBS, days),
        },
    }
