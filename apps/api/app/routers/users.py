"""Current-user profile, usage, GDPR export/delete."""

from __future__ import annotations

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.db import get_db
from app.core.deps import get_current_user, usage_today
from app.models import Game, User
from app.schemas import MeOut

router = APIRouter(tags=["users"])


@router.get("/me", response_model=MeOut)
async def me(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    used = await usage_today(db, user)
    return MeOut(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        plan=user.plan,
        email_verified=user.email_verified,
        created_at=user.created_at,
        analyses_today=used,
        daily_limit=None if user.plan == "pro" else settings.FREE_DAILY_ANALYSES,
        max_depth=settings.max_depth_for(user.plan),
        max_multipv=settings.max_multipv_for(user.plan),
    )


@router.patch("/me", response_model=MeOut)
async def update_me(
    payload: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if "display_name" in payload:
        user.display_name = str(payload["display_name"])[:100]
    await db.commit()
    await db.refresh(user)
    return await me(user, db)


@router.get("/me/export")
async def export_my_data(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """GDPR data export: account fields plus every game as PGN."""
    result = await db.execute(select(Game).where(Game.owner_id == user.id))
    games = result.scalars().all()

    return {
        "account": {
            "email": user.email,
            "display_name": user.display_name,
            "plan": user.plan,
            "created_at": user.created_at.isoformat(),
        },
        "games": [
            {
                "white": g.white,
                "black": g.black,
                "result": g.result,
                "played_on": g.played_on.isoformat() if g.played_on else None,
                "movetext": g.movetext,
            }
            for g in games
        ],
    }


@router.delete("/me", status_code=status.HTTP_204_NO_CONTENT)
async def delete_me(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Soft delete. A nightly job hard-deletes after the retention window."""
    from datetime import datetime, timezone

    user.deleted_at = datetime.now(timezone.utc)
    await db.commit()
