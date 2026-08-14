"""Authentication: register, verify, login, refresh, logout, password reset."""

from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import revocation
from app.core.config import settings
from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.ratelimit import rate_limit
from app.core.security import (
    create_access_token, decode_access_token, generate_token, hash_password,
    hash_token, verify_password,
)
from app.models import EmailToken, RefreshToken, User
from app.schemas import (
    ForgotRequest, LoginRequest, RefreshRequest, RegisterRequest,
    ResetRequest, TokenPair, VerifyRequest,
)
from app.services.mailer import send_reset_email, send_verification_email

log = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])

# A real Argon2 hash of a value nothing can present, so verifying against it
# costs the same as verifying against a live account's. Computed once at import
# rather than per request: hashing is the expensive half, and doing it on every
# unknown-user login would hand back the timing difference it exists to hide.
_DUMMY_HASH = hash_password(secrets.token_urlsafe(32))


async def _issue_tokens(
    db: AsyncSession, user: User, family_id: int | None = None
) -> TokenPair:
    """
    Mint an access/refresh pair.

    `family_id` continues an existing rotation chain; omitted, this token
    starts a new one and becomes its own root. The family is what makes reuse
    detection possible - see `refresh`.
    """
    raw_refresh = generate_token()
    token = RefreshToken(
        user_id=user.id,
        token_hash=hash_token(raw_refresh),
        expires_at=datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_TTL_DAYS),
        # Provisional; a fresh chain adopts its own id once the insert assigns one.
        family_id=family_id or 0,
    )
    db.add(token)
    await db.flush()
    if family_id is None:
        token.family_id = token.id
    await db.commit()
    return TokenPair(
        access_token=create_access_token(user.id, user.plan),
        refresh_token=raw_refresh,
    )


async def _revoke_family(db: AsyncSession, family_id: int) -> int:
    """Kill every token in a rotation chain. Returns how many were live."""
    result = await db.execute(
        update(RefreshToken)
        .where(RefreshToken.family_id == family_id, RefreshToken.revoked.is_(False))
        .values(revoked=True)
    )
    return result.rowcount or 0


@router.post(
    "/register",
    response_model=TokenPair,
    status_code=status.HTTP_201_CREATED,
    # Ten accounts an hour from one address. Enough for a household, a class or
    # an office behind one NAT; far short of the volume mass-registration needs
    # to be worth doing. Tighter than this starts refusing real people, which is
    # a cost paid by everyone to inconvenience somebody who will rent a second
    # IP anyway.
    dependencies=[rate_limit("register", limit=10, window_s=3600)],
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
            expires_at=datetime.now(timezone.utc)
            + timedelta(hours=settings.VERIFY_TOKEN_TTL_HOURS),
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
    dependencies=[rate_limit("login", limit=5, window_s=60)],
)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.email == payload.email))
    user = result.scalar_one_or_none()

    # Hash something even when the account does not exist. Argon2 is
    # deliberately slow, so skipping it for an unknown address made "no such
    # user" answer in a millisecond and "wrong password" in ~50 - a timing
    # oracle that turns this endpoint into a membership check for any address
    # an attacker cares to try, which is exactly what /auth/forgot goes out of
    # its way not to be.
    password_ok = (
        verify_password(payload.password, user.password_hash)
        if user is not None
        else verify_password(payload.password, _DUMMY_HASH)
    )

    # Constant-ish response regardless of which half failed
    if user is None or user.deleted_at is not None or not password_ok:
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


@router.post(
    "/refresh",
    response_model=TokenPair,
    dependencies=[rate_limit("refresh", limit=60, window_s=60)],
)
async def refresh(payload: RefreshRequest, db: AsyncSession = Depends(get_db)):
    """Rotating refresh tokens: the presented token is revoked and a new one issued."""
    token_hash = hash_token(payload.refresh_token)
    result = await db.execute(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
    stored = result.scalar_one_or_none()

    if stored is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "invalid_refresh", "message": "Refresh token invalid or expired"},
        )

    # Reuse of a token we already rotated away. Rotation alone means a stolen
    # token stops working once the real user refreshes - but it never tells us
    # the theft happened, and whichever party refreshed second just silently
    # loses. A second presentation only occurs when a copy outlived the
    # rotation, so treat it as a compromised chain: revoke every descendant,
    # which ends the attacker's session and forces the real user to sign in
    # again with the password the attacker does not have.
    if stored.revoked:
        killed = await _revoke_family(db, stored.family_id)
        await db.commit()
        log.warning(
            "Refresh token reuse for user %s (family %s); revoked %d live token(s)",
            stored.user_id, stored.family_id, killed,
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "refresh_reuse_detected",
                "message": "This session was ended for security reasons. Please sign in again.",
            },
        )

    if stored.expires_at < datetime.now(timezone.utc):
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

    return await _issue_tokens(db, user, family_id=stored.family_id)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    payload: RefreshRequest,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
):
    """
    End the session: revoke the refresh token, and the access token with it.

    Deliberately not authenticated. The refresh token is the credential being
    surrendered, and requiring a valid access token as well would mean a
    session whose access token had just expired could not be signed out at all.
    Presenting somebody else's refresh token only revokes it, which is not an
    attack worth having - it is what the owner wanted anyway.
    """
    token_hash = hash_token(payload.refresh_token)
    result = await db.execute(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
    stored = result.scalar_one_or_none()
    if stored:
        stored.revoked = True
        await db.commit()

    # The bearer token is optional here and only ever revokes itself: the jti
    # comes from a signature-verified payload, so a caller cannot use this to
    # revoke a token they do not already hold.
    if authorization and authorization.lower().startswith("bearer "):
        access_payload = decode_access_token(authorization.split(" ", 1)[1].strip())
        if access_payload:
            await revocation.revoke(
                access_payload.get("jti", ""), int(access_payload.get("exp", 0))
            )


@router.post(
    "/verify",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[rate_limit("verify", limit=20, window_s=60)],
)
async def verify_email(payload: VerifyRequest, db: AsyncSession = Depends(get_db)):
    raw = payload.token
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
    dependencies=[rate_limit("forgot", limit=3, window_s=3600)],
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

    # Only the newest link works. Without this, every reset ever requested for
    # this account stays live until it expires, so an old link sitting in an
    # inbox the attacker already reads is still a working key.
    await db.execute(
        update(EmailToken)
        .where(
            EmailToken.user_id == user.id,
            EmailToken.purpose == "reset",
            EmailToken.used.is_(False),
        )
        .values(used=True)
    )

    raw = generate_token()
    db.add(
        EmailToken(
            user_id=user.id,
            token_hash=hash_token(raw),
            purpose="reset",
            expires_at=datetime.now(timezone.utc)
            + timedelta(minutes=settings.RESET_TOKEN_TTL_MIN),
        )
    )
    await db.commit()
    background.add_task(send_reset_email, user.email, raw)


@router.post(
    "/reset",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[rate_limit("reset", limit=10, window_s=300)],
)
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
            expires_at=datetime.now(timezone.utc)
            + timedelta(hours=settings.VERIFY_TOKEN_TTL_HOURS),
        )
    )
    await db.commit()
    background.add_task(send_verification_email, user.email, raw)
