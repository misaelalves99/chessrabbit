"""Authentication: register, verify, login, refresh, logout, password reset."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.ratelimit import rate_limit
from app.core.security import (
    create_access_token, generate_token, hash_password, hash_token, verify_password,
)
from app.models import EmailToken, RefreshToken, User
from app.schemas import (
    ForgotRequest, LoginRequest, RefreshRequest, RegisterRequest,
    ResetRequest, TokenPair,
)
from app.services.mailer import send_reset_email, send_verification_email

log = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])


async def _issue_tokens(db: AsyncSession, user: User) -> TokenPair:
    raw_refresh = generate_token()
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=hash_token(raw_refresh),
            expires_at=datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_TTL_DAYS),
        )
    )
    await db.commit()
    return TokenPair(
        access_token=create_access_token(user.id, user.plan),
        refresh_token=raw_refresh,
    )


@router.post(
    "/register",
    response_model=TokenPair,
    status_code=status.HTTP_201_CREATED,
    dependencies=[rate_limit("register", limit=5, window_s=60)],
)
async def register(
    payload: RegisterRequest,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    existing = await db.execute(select(User).where(User.email == payload.email))
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "email_taken", "message": "An account with this email already exists"},
        )

    user = User(
        email=payload.email,
        password_hash=hash_password(payload.password),
        display_name=payload.display_name or payload.email.split("@")[0],
    )
    db.add(user)
    await db.flush()

    raw = generate_token()
    db.add(
        EmailToken(
            user_id=user.id,
            token_hash=hash_token(raw),
            purpose="verify",
            expires_at=datetime.now(timezone.utc) + timedelta(days=2),
        )
    )
    await db.commit()
    await db.refresh(user)

    # Delivered after the response; console backend logs the link in dev.
    background.add_task(send_verification_email, user.email, raw)

    return await _issue_tokens(db, user)


@router.post(
    "/login",
    response_model=TokenPair,
    dependencies=[rate_limit("login", limit=10, window_s=60)],
)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.email == payload.email))
    user = result.scalar_one_or_none()

    # Constant-ish response regardless of which half failed
    if user is None or user.deleted_at is not None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "invalid_credentials", "message": "Incorrect email or password"},
        )
    if user.suspended_at is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "account_suspended", "message": "This account is suspended"},
        )

    return await _issue_tokens(db, user)


@router.post("/refresh", response_model=TokenPair)
async def refresh(payload: RefreshRequest, db: AsyncSession = Depends(get_db)):
    """Rotating refresh tokens: the presented token is revoked and a new one issued."""
    token_hash = hash_token(payload.refresh_token)
    result = await db.execute(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
    stored = result.scalar_one_or_none()

    if stored is None or stored.revoked or stored.expires_at < datetime.now(timezone.utc):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "invalid_refresh", "message": "Refresh token invalid or expired"},
        )

    stored.revoked = True
    user = await db.get(User, stored.user_id)
    if user is None or user.deleted_at is not None:
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "user_not_found", "message": "Account not found"},
        )

    return await _issue_tokens(db, user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(payload: RefreshRequest, db: AsyncSession = Depends(get_db)):
    token_hash = hash_token(payload.refresh_token)
    result = await db.execute(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
    stored = result.scalar_one_or_none()
    if stored:
        stored.revoked = True
        await db.commit()


@router.post("/verify", status_code=status.HTTP_204_NO_CONTENT)
async def verify_email(payload: dict, db: AsyncSession = Depends(get_db)):
    raw = payload.get("token", "")
    result = await db.execute(select(EmailToken).where(EmailToken.token_hash == hash_token(raw)))
    tok = result.scalar_one_or_none()

    if tok is None or tok.used or tok.purpose != "verify" or tok.expires_at < datetime.now(timezone.utc):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_token", "message": "Verification link invalid or expired"},
        )

    tok.used = True
    user = await db.get(User, tok.user_id)
    if user:
        user.email_verified = True
    await db.commit()


@router.post(
    "/forgot",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[rate_limit("forgot", limit=3, window_s=300)],
)
async def forgot_password(
    payload: ForgotRequest,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """
    Always returns 204, whether or not the account exists - anything else
    lets an attacker enumerate registered emails.
    """
    result = await db.execute(select(User).where(User.email == payload.email))
    user = result.scalar_one_or_none()
    if user is None or user.deleted_at is not None:
        return

    raw = generate_token()
    db.add(
        EmailToken(
            user_id=user.id,
            token_hash=hash_token(raw),
            purpose="reset",
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        )
    )
    await db.commit()
    background.add_task(send_reset_email, user.email, raw)


@router.post("/reset", status_code=status.HTTP_204_NO_CONTENT)
async def reset_password(payload: ResetRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(EmailToken).where(EmailToken.token_hash == hash_token(payload.token))
    )
    tok = result.scalar_one_or_none()

    if (
        tok is None
        or tok.used
        or tok.purpose != "reset"
        or tok.expires_at < datetime.now(timezone.utc)
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_token", "message": "Reset link invalid or expired"},
        )

    user = await db.get(User, tok.user_id)
    if user is None or user.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_token", "message": "Reset link invalid or expired"},
        )

    tok.used = True
    user.password_hash = hash_password(payload.new_password)

    # A password change invalidates every existing session.
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked.is_(False))
        .values(revoked=True)
    )
    await db.commit()
    log.info("Password reset completed for user %s; all sessions revoked", user.id)


@router.post("/resend-verification", status_code=status.HTTP_204_NO_CONTENT)
async def resend_verification(
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if user.email_verified:
        return

    # Invalidate previous verify tokens so only the newest link works.
    await db.execute(
        update(EmailToken)
        .where(
            EmailToken.user_id == user.id,
            EmailToken.purpose == "verify",
            EmailToken.used.is_(False),
        )
        .values(used=True)
    )

    raw = generate_token()
    db.add(
        EmailToken(
            user_id=user.id,
            token_hash=hash_token(raw),
            purpose="verify",
            expires_at=datetime.now(timezone.utc) + timedelta(days=2),
        )
    )
    await db.commit()
    background.add_task(send_verification_email, user.email, raw)
