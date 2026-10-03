"""
Regressions for the hardening pass: the boot guard, whose identity the rate
limiter counts, and the input that reaches a third-party URL.

These are the checks that fail open when they break - a wrong answer here is
not a broken page, it is an unenforced control - so each one is pinned.
"""

import pytest
from app.core.config import DEV_JWT_SECRET, Settings
from app.core.ratelimit import _client_ip
from app.schemas import PrepRepertoireIn, PrepRequest, ProfileUpdate
from pydantic import ValidationError

# A production environment that satisfies every boot requirement. Each test
# below takes this and breaks exactly one thing, so a new requirement shows up
# as one failing test rather than as every test in the file.
PROD = {
    "ENVIRONMENT": "production",
    "APP_BASE_URL": "https://chessrabbit.app",
    "JWT_SECRET": "s" * 48,
    "EMAIL_API_KEY": "re_live_placeholder",
    "DATABASE_URL": "postgresql+asyncpg://chessrabbit:realpassword@db.internal:5432/chessrabbit",
}


# ---------- production boot guard ----------

def test_development_boots_on_the_placeholder_secret():
    """`docker compose up` must keep working with no .env at all."""
    s = Settings(ENVIRONMENT="development", JWT_SECRET=DEV_JWT_SECRET)
    assert not s.is_production


def test_production_refuses_the_placeholder_secret():
    with pytest.raises(ValidationError, match="placeholder"):
        Settings(**{**PROD, "JWT_SECRET": DEV_JWT_SECRET})


def test_production_refuses_a_short_secret():
    with pytest.raises(ValidationError, match="32 characters"):
        Settings(**{**PROD, "JWT_SECRET": "tooshort"})


def test_production_refuses_plaintext_base_url():
    with pytest.raises(ValidationError, match="https"):
        Settings(**{**PROD, "APP_BASE_URL": "http://chessrabbit.app"})


def test_production_refuses_without_an_email_provider():
    """
    No provider key means the mailer falls back to printing whole messages -
    reset links included - to the log, which services/mailer.py refuses to do
    in production. Booting anyway would mean nobody can recover an account.
    """
    with pytest.raises(ValidationError, match="EMAIL_API_KEY"):
        Settings(**{**PROD, "EMAIL_API_KEY": ""})


def test_production_refuses_the_development_database_password():
    """The default DSN's password is published in this repository."""
    with pytest.raises(ValidationError, match="development password"):
        Settings(
            **{
                **PROD,
                "DATABASE_URL":
                    "postgresql+asyncpg://chessrabbit:devpassword@db:5432/chessrabbit",
            }
        )


def test_production_boots_when_configured():
    s = Settings(**PROD)
    assert s.is_production
    # Off unless the operator opts in; see test_client_ip_* below.
    assert s.TRUST_PROXY_HEADERS is False
    # Likewise: an unmetered login form is a deliberate choice, not a default.
    assert s.AUTH_RATELIMIT_FAIL_CLOSED is False


# ---------- rate-limit identity ----------

class _Req:
    """Minimal stand-in for the two attributes _client_ip reads."""

    def __init__(self, peer, headers=None):
        self.headers = headers or {}
        self.client = type("C", (), {"host": peer})() if peer else None


def test_client_ip_ignores_forwarded_header_by_default(monkeypatch):
    """
    The header is attacker-controlled. Honouring it without a proxy in front
    gave every request a fresh identity - an unlimited password-guess budget.
    """
    from app.core import ratelimit

    monkeypatch.setattr(ratelimit.settings, "TRUST_PROXY_HEADERS", False)
    req = _Req("10.0.0.7", {"x-forwarded-for": "1.2.3.4"})
    assert _client_ip(req) == "10.0.0.7"


def test_client_ip_uses_forwarded_header_when_proxied(monkeypatch):
    from app.core import ratelimit

    monkeypatch.setattr(ratelimit.settings, "TRUST_PROXY_HEADERS", True)
    req = _Req("10.0.0.7", {"x-forwarded-for": "1.2.3.4, 10.0.0.1"})
    assert _client_ip(req) == "1.2.3.4"


def test_client_ip_falls_back_when_there_is_no_peer():
    assert _client_ip(_Req(None)) == "unknown"


# ---------- input that leaves the process ----------

@pytest.mark.parametrize(
    "username",
    ["../../api/account", "a/b", "with space", "a?x=1", "a#b", "a%2fb", ""],
)
def test_platform_username_rejects_url_structure(username):
    """These land in a lichess.org / chess.com URL path verbatim."""
    with pytest.raises(ValidationError):
        PrepRequest(platform="lichess", username=username)


@pytest.mark.parametrize("username", ["DrNykterstein", "hikaru", "a.b-c_1"])
def test_platform_username_accepts_real_names(username):
    assert PrepRequest(platform="lichess", username=username).username == username
    assert (
        PrepRepertoireIn(
            platform="chesscom", username=username, my_color="white"
        ).username
        == username
    )


def test_profile_update_is_typed():
    """`payload: dict` accepted any JSON; display_name is now bounded."""
    assert ProfileUpdate(display_name="  Magnus  ").display_name == "  Magnus  "
    with pytest.raises(ValidationError):
        ProfileUpdate(display_name="x" * 101)
    with pytest.raises(ValidationError):
        ProfileUpdate(display_name="")


# ---------- response hardening ----------

# ---------- study visibility ----------

def test_unlisted_study_is_not_readable_by_guessing_its_id():
    """
    The slug IS the access control for an unlisted study. Serving one to a
    stranger who supplied a sequential id made the slug decorative: an attacker
    walks /studies/1, /studies/2 and reads everything nobody chose to publish.
    """
    from app.routers.studies import stranger_may_read

    assert stranger_may_read("unlisted", by_id=True) is False
    assert stranger_may_read("unlisted", by_id=False) is True


def test_private_study_is_readable_by_no_stranger():
    from app.routers.studies import stranger_may_read

    assert stranger_may_read("private", by_id=True) is False
    assert stranger_may_read("private", by_id=False) is False


def test_public_study_is_readable_either_way():
    from app.routers.studies import stranger_may_read

    assert stranger_may_read("public", by_id=True) is True
    assert stranger_may_read("public", by_id=False) is True


# ---------- token identity ----------

def test_access_tokens_carry_a_revocable_id():
    """
    Signing out revokes the refresh token, but the access token in hand stays
    valid on its signature alone. The jti is what lets logout revoke that
    specific token; without it, "sign out" leaves the session usable.
    """
    from app.core.security import create_access_token, decode_access_token

    payload = decode_access_token(create_access_token(1))
    assert payload is not None
    assert payload["jti"]
    assert decode_access_token(create_access_token(1))["jti"] != payload["jti"]


def test_admin_tokens_carry_a_revocable_id():
    from app.core.security import create_admin_token, decode_admin_token

    payload = decode_admin_token(create_admin_token(1))
    assert payload is not None and payload["jti"]


# ---------- log hygiene ----------

def test_emails_are_masked_before_they_reach_a_log():
    from app.core.redact import mask_email

    assert mask_email("alice@example.com") == "a***e@example.com"
    assert "@example.com" in mask_email("ab@example.com")
    assert mask_email("ab@example.com").startswith("**@")
    assert mask_email(None) == "<none>"


def test_tokens_are_never_logged_whole():
    from app.core.redact import mask_token

    secret = "s" * 64
    masked = mask_token(secret)
    assert secret not in masked
    assert masked.startswith("ssssssss")


def test_api_sends_security_headers():
    """
    Error bodies and PGN exports echo user text. A browser navigated straight
    at such a URL must not be free to interpret what comes back.
    """
    from app.main import SECURITY_HEADERS

    assert SECURITY_HEADERS["X-Content-Type-Options"] == "nosniff"
    assert SECURITY_HEADERS["X-Frame-Options"] == "DENY"
    assert "frame-ancestors 'none'" in SECURITY_HEADERS["Content-Security-Policy"]
    assert "default-src 'none'" in SECURITY_HEADERS["Content-Security-Policy"]


def test_cors_does_not_wildcard_localhost_in_production(monkeypatch):
    """
    Credentialed CORS makes the origin list an authorization boundary. The
    localhost wildcard is a dev-server convenience; in production it would let
    any page on any localhost port drive the API as the signed-in user.
    """
    import importlib

    import app.main

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("JWT_SECRET", "p" * 48)
    monkeypatch.setenv("APP_BASE_URL", "https://chessrabbit.app")
    # The rest of the production boot contract, so this test fails on the CORS
    # assertion it is about rather than on an unrelated missing variable.
    monkeypatch.setenv("EMAIL_API_KEY", "re_live_placeholder")
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql+asyncpg://chessrabbit:realpassword@db.internal:5432/chessrabbit",
    )
    import app.core.config

    importlib.reload(app.core.config)
    reloaded = importlib.reload(app.main)
    try:
        assert reloaded._cors_origin_regex is None
        assert reloaded._cors_origins == ["https://chessrabbit.app"]
    finally:
        # Leave the module registry as the rest of the suite expects it.
        monkeypatch.undo()
        importlib.reload(app.core.config)
        importlib.reload(app.main)


# ---------- retention ----------

def test_retention_windows_are_sane():
    """
    Revoked refresh tokens must outlive the access tokens they could refresh,
    or reuse detection loses the row it recognises a stolen token by.
    """
    s = Settings()
    assert s.REVOKED_TOKEN_GRACE_DAYS > s.REFRESH_TOKEN_TTL_DAYS - 1
    assert s.ANALYSIS_CACHE_TTL_DAYS > 0
    assert s.ANALYSIS_CACHE_MAX_ROWS > 0
    assert s.JOB_RETENTION_DAYS > 0
