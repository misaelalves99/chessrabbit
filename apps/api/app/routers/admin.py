"""
Admin surface: analytics, user management, and the audit trail.

AUTHENTICATION IS SEPARATE FROM THE PLAYER APP. Everything here resolves an
admin token minted by POST /admin/auth/login and nothing else - a normal signed
-in session cannot reach any of it, even for an account carrying is_admin. That
is the whole point: this surface lists every customer's email address and can
change what they pay, so an XSS anywhere in the player-facing app must not
inherit it. See core/deps.py:require_admin and core/security.py.

Admin tokens are short-lived (ADMIN_TOKEN_TTL_MIN, default 60) and cannot be
refreshed. Signing out adds the token to the revocation list (core/revocation.py)
so the session ends when the operator says so; for a token leaked without a
sign-out, expiry is still the only bound, and it is kept tight on purpose.

Promote your first admin from the shell:
    python pipeline/make_admin.py you@example.com
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import revocation
from app.core.config import settings
from app.core.db import get_db
from app.core.deps import require_admin
from app.core.ratelimit import rate_limit
from app.core.redact import mask_email
from app.core.security import create_admin_token, decode_admin_token, verify_password
from app.core.tiers import tier_for
from app.models import AnalysisJob, Game, User
from app.schemas import AdminLoginRequest, AdminToken, PlanOverride
from app.services import admin_analytics

log = logging.getLogger(__name__)
router = APIRouter(prefix="/admin", tags=["admin"])

PAGE_SIZE = 50


def _client_ip(request: Request) -> str | None:
    """Recorded on audit rows. Same trust rules as the rate limiter."""
    from app.core.ratelimit import _client_ip as ip

    return ip(request)


async def _audit(
    db: AsyncSession, admin_id: int | None, action: str,
    target_user_id: int | None = None, detail: dict | None = None,
    ip: str | None = None,
) -> None:
    """
    Append to admin_audit. Caller commits.

    Every mutation and every sign-in attempt goes through here. With more than
    one admin there is otherwise no record of who suspended whom, and a plan
    change made by hand is exactly the kind of thing a customer later disputes.
    """
    import json

    await db.execute(
        text(
            "INSERT INTO admin_audit (admin_id, action, target_user_id, detail, ip) "
            "VALUES (:admin, :action, :target, cast(:detail AS jsonb), :ip)"
        ),
        {
            "admin": admin_id, "action": action, "target": target_user_id,
            "detail": json.dumps(detail or {}), "ip": ip,
        },
    )


# ------------------------------------------------------------------
# Authentication
# ------------------------------------------------------------------

@router.post(
    "/auth/login",
    response_model=AdminToken,
    dependencies=[rate_limit("admin_login", limit=5, window_s=900)],
)
async def admin_login(
    payload: AdminLoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Sign in to the admin surface. Separate credential, separate token type.

    Unknown email, wrong password, and a correct password on a non-admin
    account all produce the SAME 401. Distinguishing them would turn this
    endpoint into an oracle for "which of these accounts is an admin", which is
    precisely the list an attacker wants before spending any password guesses.

    The rate limit is 5 per 15 minutes per IP - far tighter than the player
    login's 10 per minute - because no legitimate operator needs more and the
    blast radius here is the whole customer base.
    """
    ip = _client_ip(request)
    rejected = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"code": "invalid_credentials", "message": "Incorrect email or password"},
    )

    result = await db.execute(select(User).where(User.email == payload.email))
    user = result.scalar_one_or_none()

    # Verify the password even when the account is unusable, so the response
    # time does not separate "no such admin" from "wrong password".
    password_ok = user is not None and verify_password(payload.password, user.password_hash)
    usable = (
        user is not None
        and user.deleted_at is None
        and user.suspended_at is None
        and user.is_admin
    )

    if not (password_ok and usable):
        await _audit(
            db, user.id if user else None, "admin_login_failed",
            detail={"email": payload.email}, ip=ip,
        )
        await db.commit()
        # Masked here, in full in admin_audit: the audit table is inside the
        # database and subject to its retention rules, the log stream is not.
        log.warning("Failed admin login for %s from %s", mask_email(payload.email), ip)
        raise rejected

    await _audit(db, user.id, "admin_login", ip=ip)
    await db.commit()
    log.info("Admin %s signed in from %s", mask_email(user.email), ip)

    return AdminToken(
        access_token=create_admin_token(user.id),
        expires_in=settings.ADMIN_TOKEN_TTL_MIN * 60,
        display_name=user.display_name or user.email,
    )


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
async def admin_logout(
    request: Request,
    authorization: str | None = Header(default=None),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """
    End the admin session for real.

    An admin token cannot be refreshed and has no row to revoke, so before this
    signing out only discarded the client's copy - anything that had already
    read it out of localStorage kept full admin access until the hour was up.
    The token now goes on the revocation list for its remaining lifetime.
    """
    await _audit(db, admin.id, "admin_logout", ip=_client_ip(request))
    await db.commit()

    if authorization and authorization.lower().startswith("bearer "):
        payload = decode_admin_token(authorization.split(" ", 1)[1].strip())
        if payload:
            await revocation.revoke(payload.get("jti", ""), int(payload.get("exp", 0)))


@router.get("/me")
async def admin_me(admin: User = Depends(require_admin)):
    """Lets the dashboard confirm a stored token is still good before rendering."""
    return {"id": admin.id, "email": admin.email, "display_name": admin.display_name}


# ------------------------------------------------------------------
# Analytics
# ------------------------------------------------------------------

@router.get("/overview")
async def overview(
    days: int = Query(default=30, ge=7, le=365),
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Active users, growth, and revenue - the dashboard's first screen."""
    return await admin_analytics.overview(db, days)


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


# ------------------------------------------------------------------
# User management
# ------------------------------------------------------------------

@router.get("/users")
async def list_users(
    page: int = Query(default=1, ge=1),
    q: str | None = None,
    plan: str | None = Query(default=None, pattern="^(free|pro|master)$"),
    account_status: str | None = Query(default=None, pattern="^(active|suspended|unverified)$"),
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """User roster with per-user game counts and 7-day analysis usage."""
    week_ago = datetime.now(timezone.utc) - timedelta(days=7)
    offset = (page - 1) * PAGE_SIZE

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

    filters = [User.deleted_at.is_(None)]
    if q:
        filters.append(User.email.ilike(f"%{q}%"))
    if plan:
        filters.append(User.plan == plan)
    if account_status == "suspended":
        filters.append(User.suspended_at.is_not(None))
    elif account_status == "active":
        filters.append(User.suspended_at.is_(None))
    elif account_status == "unverified":
        filters.append(User.email_verified.is_(False))

    # The roster previously returned a bare array, so the UI could not tell a
    # full last page from the end of the list.
    total = (
        await db.execute(select(func.count(User.id)).where(*filters))
    ).scalar_one()

    rows = await db.execute(
        select(
            User,
            func.coalesce(games_sub.c.games, 0),
            func.coalesce(jobs_sub.c.jobs_7d, 0),
        )
        .outerjoin(games_sub, games_sub.c.owner_id == User.id)
        .outerjoin(jobs_sub, jobs_sub.c.user_id == User.id)
        .where(*filters)
        .order_by(User.created_at.desc())
        .offset(offset)
        .limit(PAGE_SIZE)
    )

    return {
        "total": total,
        "page": page,
        "page_size": PAGE_SIZE,
        "users": [
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
        ],
    }


@router.post("/users/{user_id}/suspend", status_code=status.HTTP_204_NO_CONTENT)
async def suspend_user(
    user_id: int,
    request: Request,
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
    await _audit(
        db, admin.id, "suspend_user", target.id,
        {"email": target.email}, _client_ip(request),
    )
    await db.commit()


@router.post("/users/{user_id}/unsuspend", status_code=status.HTTP_204_NO_CONTENT)
async def unsuspend_user(
    user_id: int,
    request: Request,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    target = await db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "User not found"})
    target.suspended_at = None
    await _audit(
        db, admin.id, "unsuspend_user", target.id,
        {"email": target.email}, _client_ip(request),
    )
    await db.commit()


@router.post("/users/{user_id}/plan", status_code=status.HTTP_204_NO_CONTENT)
async def override_plan(
    user_id: int,
    payload: PlanOverride,
    request: Request,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """
    Set a user's plan by hand - comps, support fixes, refunded upgrades.

    This DELIBERATELY breaches the invariant documented at the top of
    routers/billing.py: the Stripe webhook is otherwise the only writer of
    users.plan, which is what stops a client talking itself into a paid tier.
    Two things keep the hole narrow:

      1. An account with a live Stripe subscription is refused. Stripe is the
         source of truth for those, and the next webhook would silently undo
         whatever we wrote here - a change that appears to work and then
         reverts is worse than one that is refused.
      2. Every override requires a reason and lands in admin_audit alongside a
         subscription_events row, so manual grants are visible in the revenue
         numbers rather than hiding inside them.
    """
    target = await db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "User not found"})

    live = (
        await db.execute(
            text(
                "SELECT status FROM subscriptions "
                "WHERE user_id = :uid AND status IN ('active', 'trialing')"
            ),
            {"uid": user_id},
        )
    ).scalar_one_or_none()
    if live:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "stripe_managed",
                "message": "This account has a live Stripe subscription. "
                           "Change it in Stripe - a webhook would overwrite this.",
            },
        )

    previous = target.plan
    if previous == payload.plan:
        return

    target.plan = payload.plan
    await db.execute(
        text(
            """
            INSERT INTO subscription_events
              (user_id, event_type, plan, status, amount_cents)
            VALUES (:uid, 'manual_override', :plan, 'manual', :amount)
            """
        ),
        {
            "uid": user_id, "plan": payload.plan,
            "amount": round(tier_for(payload.plan).price_monthly * 100),
        },
    )
    await _audit(
        db, admin.id, "override_plan", target.id,
        {"from": previous, "to": payload.plan, "reason": payload.reason,
         "email": target.email},
        _client_ip(request),
    )
    await db.commit()
    log.info(
        "Admin %s set user %s plan %s -> %s (%s)",
        mask_email(admin.email), user_id, previous, payload.plan, payload.reason,
    )


# ------------------------------------------------------------------
# Audit trail
# ------------------------------------------------------------------

@router.get("/audit")
async def list_audit(
    page: int = Query(default=1, ge=1),
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Who did what, most recent first."""
    offset = (page - 1) * PAGE_SIZE

    total = (await db.execute(text("SELECT count(*) FROM admin_audit"))).scalar_one()
    rows = await db.execute(
        text(
            """
            SELECT a.id, a.action, a.detail, a.ip, a.created_at,
                   a.admin_id, admin.email AS admin_email,
                   a.target_user_id, target.email AS target_email
            FROM admin_audit a
            LEFT JOIN users admin  ON admin.id  = a.admin_id
            LEFT JOIN users target ON target.id = a.target_user_id
            ORDER BY a.created_at DESC
            LIMIT :limit OFFSET :offset
            """
        ),
        {"limit": PAGE_SIZE, "offset": offset},
    )

    return {
        "total": total,
        "page": page,
        "page_size": PAGE_SIZE,
        "entries": [dict(r) for r in rows.mappings()],
    }
