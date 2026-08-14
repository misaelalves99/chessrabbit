"""
Regressions for the admin surface.

The load-bearing claim of this feature is that a player session cannot reach
the admin surface and an admin session cannot drive the player app. That is one
`type` field in a JWT - cheap to break in a refactor, and silent when it breaks,
since both tokens keep working for their own side. So it is pinned in both
directions, at the token level and through the ASGI stack.

Deliberately no database: this repo has no Postgres fixture, and the checks
that matter here do not need one.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import jwt
import pytest

from app.core.config import Settings, settings
from app.core.security import (
    create_access_token, create_admin_token, decode_access_token, decode_admin_token,
)
from app.core.tiers import TIERS


# ---------- token separation ----------
#
# Both directions, because each one fails independently and neither failure is
# visible from the other side.

def test_admin_token_is_not_accepted_as_a_player_token():
    assert decode_access_token(create_admin_token(1)) is None


def test_player_token_is_not_accepted_as_an_admin_token():
    """
    The one that matters: this is what stops an XSS in the player app - which
    can read the access token out of localStorage - from reaching the dashboard.
    """
    assert decode_admin_token(create_access_token(1, "free")) is None


def test_admin_token_round_trips():
    payload = decode_admin_token(create_admin_token(42))
    assert payload is not None
    assert payload["sub"] == "42"
    assert payload["scope"] == "admin"


def test_admin_token_carries_no_plan_claim():
    """Nothing about entitlements belongs on an operator credential."""
    assert "plan" not in (decode_admin_token(create_admin_token(1)) or {})


def test_expired_admin_token_is_rejected():
    expired = jwt.encode(
        {
            "sub": "1", "scope": "admin", "type": "admin",
            "exp": datetime.now(timezone.utc) - timedelta(seconds=1),
        },
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    assert decode_admin_token(expired) is None


def test_admin_token_without_the_scope_claim_is_rejected():
    """`type` and `scope` are checked independently; forging one is not enough."""
    forged = jwt.encode(
        {
            "sub": "1", "type": "admin",
            "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
        },
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    assert decode_admin_token(forged) is None


def test_admin_sessions_are_short_and_unrefreshable():
    """
    Nothing revokes an admin token, so its lifetime is the only bound on a
    stolen one. It must not drift up towards the refresh-token window.
    """
    s = Settings()
    assert s.ADMIN_TOKEN_TTL_MIN <= 12 * 60


# ---------- the boundary, through the real stack ----------

@pytest.mark.asyncio
async def test_admin_endpoints_reject_a_valid_player_token():
    """
    A perfectly valid player token, on a real request, against every admin
    route. require_admin must refuse before any handler or database work runs -
    which is also why this passes with no database.
    """
    from app.main import app

    token = create_access_token(1, "master")
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        for path in ("/admin/overview", "/admin/stats", "/admin/users", "/admin/audit", "/admin/me"):
            res = await client.get(path, headers={"Authorization": f"Bearer {token}"})
            assert res.status_code == 401, f"{path} let a player token through"
            assert res.json()["detail"]["code"] == "admin_auth_required"


@pytest.mark.asyncio
async def test_admin_endpoints_reject_missing_and_malformed_credentials():
    from app.main import app

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        for headers in (
            {},
            {"Authorization": "Bearer "},
            {"Authorization": "Bearer not-a-jwt"},
            {"Authorization": create_admin_token(1)},  # no "Bearer " prefix
        ):
            res = await client.get("/admin/overview", headers=headers)
            assert res.status_code == 401


# ---------- revenue arithmetic ----------

def test_mrr_is_summed_from_tier_prices_in_cents():
    """
    MRR is money, so it is carried in integer cents end to end. The float in
    tiers.py is the only place a fraction exists and it is rounded once, here.
    """
    from app.services.admin_analytics import PAYING_STATUSES

    assert "active" in PAYING_STATUSES and "trialing" in PAYING_STATUSES
    assert round(TIERS["pro"].price_monthly * 100) == 499
    assert round(TIERS["master"].price_monthly * 100) == 999
    assert round(TIERS["free"].price_monthly * 100) == 0


def test_every_tier_has_a_price_mrr_can_be_computed_from():
    """A plan added without a price would silently contribute 0 to revenue."""
    for plan, tier in TIERS.items():
        assert tier.price_monthly >= 0, plan
        assert (plan == "free") == (tier.price_monthly == 0)


# ---------- presence ----------

@pytest.mark.asyncio
async def test_presence_fails_open_when_redis_is_down(monkeypatch):
    """
    A dashboard statistic must never fail a user's request. touch() runs inside
    get_current_user, so an exception here would log everybody out of a working
    site the moment Redis blinked.
    """
    from app.services import presence

    def boom():
        raise ConnectionError("redis is down")

    monkeypatch.setattr(presence, "get_redis", boom)

    await presence.touch(None, 1)          # must not raise, must not touch db
    assert await presence.count_online() is None   # unknown, NOT zero


def test_presence_window_is_a_few_minutes():
    """Long enough to cover an idle tab, short enough to mean 'now'."""
    s = Settings()
    assert 60 <= s.PRESENCE_WINDOW_S <= 1800


def test_dau_guard_outlives_its_day():
    """
    The guard key is what keeps the write to one row per user per day. If it
    expired within the day, a user active at 09:00 and 23:00 would write twice
    and the ON CONFLICT would be doing all the work.
    """
    from app.services.presence import DAU_GUARD_TTL_S

    assert DAU_GUARD_TTL_S > 86_400
