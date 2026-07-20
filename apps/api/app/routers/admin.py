"""
Admin endpoints. Everything here requires users.is_admin.

Promote your first admin from the shell:
    python pipeline/make_admin.py you@example.com
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.deps import require_admin
from app.models import AnalysisJob, Game, User

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/stats")
async def platform_stats(
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """One-screen health/growth overview for the operator."""
    week_ago = datetime.now(timezone.utc) - timedelta(days=7)

    rows = await db.execute(
        text(
            """
            SELECT
              (SELECT count(*) FROM users WHERE deleted_at IS NULL)              AS users_total,
              (SELECT count(*) FROM users WHERE plan = 'pro'
                 AND deleted_at IS NULL)                                          AS users_pro,
              (SELECT count(*) FROM users WHERE suspended_at IS NOT NULL)         AS users_suspended,
              (SELECT count(*) FROM users WHERE created_at >= :week)              AS users_new_7d,
              (SELECT count(*) FROM games WHERE owner_id IS NOT NULL)             AS user_games,
              (SELECT count(*) FROM games WHERE owner_id IS NULL)                 AS reference_games,
              (SELECT count(*) FROM opening_tree)                                 AS opening_tree_rows,
              (SELECT count(*) FROM analysis_cache)                              AS cache_positions,
              (SELECT count(*) FROM analysis_jobs WHERE status = 'queued')       AS jobs_queued,
              (SELECT count(*) FROM analysis_jobs WHERE status = 'running')      AS jobs_running,
              (SELECT count(*) FROM analysis_jobs WHERE status = 'failed'
                 AND created_at >= :week)                                         AS jobs_failed_7d,
              (SELECT count(*) FROM analysis_jobs WHERE created_at >= :week)     AS jobs_7d,
              (SELECT coalesce(sum(extract(epoch FROM finished_at - created_at)), 0)
                 FROM analysis_jobs
                 WHERE status = 'done' AND finished_at >= :week)                 AS engine_seconds_7d,
              (SELECT pg_database_size(current_database()))                      AS db_bytes
            """
        ),
        {"week": week_ago},
    )
    s = dict(rows.mappings().one())
    s["engine_seconds_7d"] = round(float(s["engine_seconds_7d"]))
    s["db_size_mb"] = round(s.pop("db_bytes") / 1_048_576, 1)
    return s


@router.get("/users")
async def list_users(
    page: int = Query(default=1, ge=1),
    q: str | None = None,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """User roster with per-user game counts and 7-day analysis usage."""
    week_ago = datetime.now(timezone.utc) - timedelta(days=7)
    limit, offset = 50, (page - 1) * 50

    games_sub = (
        select(Game.owner_id, func.count(Game.id).label("games"))
        .group_by(Game.owner_id)
        .subquery()
    )
    jobs_sub = (
        select(AnalysisJob.user_id, func.count(AnalysisJob.id).label("jobs_7d"))
        .where(AnalysisJob.created_at >= week_ago)
        .group_by(AnalysisJob.user_id)
        .subquery()
    )

    stmt = (
        select(
            User,
            func.coalesce(games_sub.c.games, 0),
            func.coalesce(jobs_sub.c.jobs_7d, 0),
        )
        .outerjoin(games_sub, games_sub.c.owner_id == User.id)
        .outerjoin(jobs_sub, jobs_sub.c.user_id == User.id)
        .where(User.deleted_at.is_(None))
        .order_by(User.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    if q:
        stmt = stmt.where(User.email.ilike(f"%{q}%"))

    rows = await db.execute(stmt)
    return [
        {
            "id": u.id,
            "email": u.email,
            "display_name": u.display_name,
            "plan": u.plan,
            "is_admin": u.is_admin,
            "suspended": u.suspended_at is not None,
            "email_verified": u.email_verified,
            "created_at": u.created_at,
            "games": games,
            "jobs_7d": jobs_7d,
        }
        for u, games, jobs_7d in rows.all()
    ]


@router.post("/users/{user_id}/suspend", status_code=status.HTTP_204_NO_CONTENT)
async def suspend_user(
    user_id: int,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    if user_id == admin.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "cannot_suspend_self", "message": "You cannot suspend your own account"},
        )
    target = await db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "User not found"})
    if target.is_admin:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "cannot_suspend_admin", "message": "Demote the admin flag first"},
        )
    target.suspended_at = datetime.now(timezone.utc)
    await db.commit()


@router.post("/users/{user_id}/unsuspend", status_code=status.HTTP_204_NO_CONTENT)
async def unsuspend_user(
    user_id: int,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    target = await db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "User not found"})
    target.suspended_at = None
    await db.commit()
