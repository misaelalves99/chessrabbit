"""Connected platform accounts: Lichess / Chess.com auto-import (Sprint 2, 3.3)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.ratelimit import rate_limit
from app.models import ExternalAccount, User
from app.schemas import ConnectAccountRequest, ExternalAccountOut, SyncResult
from app.services.importers import PlatformError, sync_account, verify_account

router = APIRouter(tags=["accounts"])


async def _get_account(
    db: AsyncSession, user_id: int, platform: str
) -> ExternalAccount | None:
    result = await db.execute(
        select(ExternalAccount).where(
            ExternalAccount.user_id == user_id, ExternalAccount.platform == platform
        )
    )
    return result.scalar_one_or_none()


@router.get("/me/accounts", response_model=list[ExternalAccountOut])
async def list_accounts(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    result = await db.execute(
        select(ExternalAccount).where(ExternalAccount.user_id == user.id)
    )
    return list(result.scalars().all())


@router.post(
    "/me/accounts",
    response_model=SyncResult,
    status_code=status.HTTP_201_CREATED,
    dependencies=[rate_limit("connect_account", 3, 60)],
)
async def connect_account(
    payload: ConnectAccountRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Link a Lichess/Chess.com username and run the first import immediately."""
    if await _get_account(db, user.id, payload.platform):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "already_connected",
                "message": f"A {payload.platform} account is already connected. Disconnect it first.",
            },
        )

    try:
        canonical = await verify_account(payload.platform, payload.username)
    except PlatformError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "platform_user_not_found", "message": str(exc)},
        )

    account = ExternalAccount(
        user_id=user.id, platform=payload.platform, username=canonical
    )
    db.add(account)
    await db.flush()

    try:
        stats = await sync_account(db, user, account)
    except PlatformError as exc:
        # Account row is kept (with error status) so a retry sync can succeed.
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "platform_sync_failed", "message": str(exc)},
        )
    return SyncResult(**stats)


@router.post(
    "/me/accounts/{platform}/sync",
    response_model=SyncResult,
    dependencies=[rate_limit("sync_account", 2, 60)],
)
async def sync_now(
    platform: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    account = await _get_account(db, user.id, platform)
    if account is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_connected", "message": f"No {platform} account connected"},
        )

    try:
        stats = await sync_account(db, user, account)
    except PlatformError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "platform_sync_failed", "message": str(exc)},
        )
    return SyncResult(**stats)


@router.delete("/me/accounts/{platform}", status_code=status.HTTP_204_NO_CONTENT)
async def disconnect_account(
    platform: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Unlink the account. Imported games are kept - they belong to the user."""
    account = await _get_account(db, user.id, platform)
    if account is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_connected", "message": f"No {platform} account connected"},
        )
    await db.delete(account)
    await db.commit()
