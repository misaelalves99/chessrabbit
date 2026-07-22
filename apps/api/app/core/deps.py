"""Shared FastAPI dependencies: current user, plan gating, usage metering."""

from __future__ import annotations

from datetime import date

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.db import get_db
from app.core.security import decode_access_token
from app.core.tiers import is_paid
from app.models import UsageDaily, User


async def get_current_user(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Resolve the bearer token to a live user. Plan is read from the DB, never the token."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "not_authenticated", "message": "Missing bearer token"},
        )

    token = authorization.split(" ", 1)[1].strip()
    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "invalid_token", "message": "Token invalid or expired"},
        )

    user = await db.get(User, int(payload["sub"]))
    if user is None or user.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "user_not_found", "message": "Account not found"},
        )
    if user.suspended_at is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "account_suspended", "message": "This account is suspended"},
        )
    return user


async def get_optional_user(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> User | None:
    """For endpoints that work logged-out but personalize when logged in."""
    if not authorization:
        return None
    try:
        return await get_current_user(authorization, db)
    except HTTPException:
        return None


async def require_pro(user: User = Depends(get_current_user)) -> User:
    if not is_paid(user.plan):
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={"code": "upgrade_required", "message": "This feature requires a Pro subscription"},
        )
    return user


async def require_master(user: User = Depends(get_current_user)) -> User:
    if user.plan != "master":
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={"code": "upgrade_required", "message": "This feature requires the Master plan"},
        )
    return user


async def check_and_increment_usage(db: AsyncSession, user: User) -> int:
    """
    Atomically bump today's analysis counter, enforcing the free-tier daily cap.
    Returns the new count. Pro users are metered but never blocked.
    """
    today = date.today()

    result = await db.execute(
        text(
            """
            INSERT INTO usage_daily (user_id, day, analyses)
            VALUES (:uid, :day, 1)
            ON CONFLICT (user_id, day) DO UPDATE
              SET analyses = usage_daily.analyses + 1
            RETURNING analyses
            """
        ),
        {"uid": user.id, "day": today},
    )
    count = result.scalar_one()
    await db.commit()

    if not is_paid(user.plan) and count > settings.FREE_DAILY_ANALYSES:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": "daily_limit_reached",
                "message": f"Free plan allows {settings.FREE_DAILY_ANALYSES} analyses per day. Upgrade for unlimited.",
            },
        )
    return count


async def usage_today(db: AsyncSession, user: User) -> int:
    row = await db.execute(
        select(UsageDaily.analyses).where(
            UsageDaily.user_id == user.id, UsageDaily.day == date.today()
        )
    )
    return row.scalar_one_or_none() or 0


async def require_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "admin_required", "message": "Admin access required"},
        )
    return user
