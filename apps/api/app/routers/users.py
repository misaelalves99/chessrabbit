"""Current-user profile, usage, GDPR export/delete."""

from __future__ import annotations

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.db import get_db
from app.core.deps import get_current_user, usage_today
from app.models import Game, User
from app.schemas import MeOut, ProfileUpdate

router = APIRouter(tags=["users"])


@router.get("/me", response_model=MeOut)
async def me(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    used = await usage_today(db, user)
    return MeOut(
        local_mode=settings.LOCAL_MODE,
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        email_verified=user.email_verified,
        created_at=user.created_at,
        analyses_today=used,
        daily_limit=None,
        max_depth=settings.ENGINE_MAX_DEPTH,
        max_multipv=settings.ENGINE_MAX_MULTIPV,
    )


@router.patch("/me", response_model=MeOut)
async def update_me(
    payload: ProfileUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if payload.display_name is not None:
        user.display_name = payload.display_name.strip()
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
