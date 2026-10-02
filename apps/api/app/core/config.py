import secrets
from functools import lru_cache
from urllib.parse import urlparse

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# The shipped placeholder. Fine for `docker compose up`; refused in production.
DEV_JWT_SECRET = "dev-secret-change-me"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Database / Redis
    DATABASE_URL: str = "postgresql+asyncpg://chessrabbit:devpassword@postgres:5432/chessrabbit"
    REDIS_URL: str = "redis://redis:6379/0"

    # Auth
    JWT_SECRET: str = DEV_JWT_SECRET
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_TTL_MIN: int = 15
    REFRESH_TOKEN_TTL_DAYS: int = 30
    # A reset link is a bearer credential for the account, and it sits in an
    # inbox - a place that outlives the session that requested it and is itself
    # a common target. Fifteen minutes is long enough to walk from "I clicked
    # forgot password" to a new password and short enough that a mailbox read
    # tomorrow yields nothing.
    RESET_TOKEN_TTL_MIN: int = 15
    VERIFY_TOKEN_TTL_HOURS: int = 48
    # The /admin surface has its own credential and no refresh token: an admin
    # session simply expires and is signed in again. Short on purpose - it is
    # the only thing bounding a stolen admin token, since there is nothing to
    # revoke.
    ADMIN_TOKEN_TTL_MIN: int = 60

    # How recently a user must have been seen to count as "online now" on the
    # admin dashboard. See services/presence.py.
    PRESENCE_WINDOW_S: int = 300

    # App
    APP_BASE_URL: str = "http://localhost:3000"
    ENVIRONMENT: str = "development"

    # What the login endpoints do when Redis - and therefore the rate limiter -
    # is unreachable. False (the default) serves them unmetered, so a Redis
    # outage does not become a sign-in outage; the cost is that an attacker who
    # can take Redis down also removes the brute-force ceiling. True refuses
    # sign-in instead. Turn it on once Redis is redundant enough that its being
    # down is a real incident rather than a hiccup.
    AUTH_RATELIMIT_FAIL_CLOSED: bool = False

    # True only when a reverse proxy we control (Caddy/nginx/ALB) terminates
    # every request. It is what makes X-Forwarded-For trustworthy; see
    # core/ratelimit.py. Left False, the rate limiter keys on the socket peer.
    TRUST_PROXY_HEADERS: bool = False

    # Engine
    ENGINE_MAX_MOVETIME_MS: int = 60_000
    SYZYGY_PATH: str = ""  # directory of .rtbw/.rtbz files; empty = disabled

    # Retention (services/maintenance.py, nightly). These tables only grow:
    # without a sweep, analysis_cache alone becomes the database.
    ANALYSIS_CACHE_TTL_DAYS: int = 90
    ANALYSIS_CACHE_MAX_ROWS: int = 5_000_000
    JOB_RETENTION_DAYS: int = 30
    # Revoked refresh tokens outlive their rotation on purpose: reuse detection
    # identifies a stolen token by finding its revoked row.
    REVOKED_TOKEN_GRACE_DAYS: int = 45

    # Local resource limits, identical for every account.
    LOCAL_MODE: bool = False
    ENGINE_MAX_DEPTH: int = 40
    ENGINE_MAX_MULTIPV: int = 10
    ENGINE_MAX_LIVE_ANALYSES: int = 3
    MAX_CHAPTERS_PER_STUDY: int = 64

    # Email
    EMAIL_API_KEY: str = ""
    EMAIL_FROM: str = "noreply@example.com"

    @model_validator(mode="after")
    def _refuse_insecure_production(self) -> "Settings":
        """
        Fail to boot rather than run production on the placeholder secret.

        Anyone who has read this repository can mint an admin access token for
        a server still signing with DEV_JWT_SECRET, so a missing JWT_SECRET in
        the environment has to be a crash, not a default.
        """
        if self.LOCAL_MODE and self.is_production:
            raise ValueError("LOCAL_MODE must not be enabled in production")
        if self.LOCAL_MODE:
            if urlparse(self.APP_BASE_URL).hostname not in {"localhost", "127.0.0.1", "::1"}:
                raise ValueError("LOCAL_MODE requires a loopback APP_BASE_URL")
            if self.JWT_SECRET == DEV_JWT_SECRET:
                self.JWT_SECRET = secrets.token_urlsafe(48)
        if self.ENVIRONMENT == "production":
            problems = []
            if self.JWT_SECRET == DEV_JWT_SECRET:
                problems.append("JWT_SECRET is still the development placeholder")
            elif len(self.JWT_SECRET) < 32:
                problems.append("JWT_SECRET is shorter than 32 characters")
            if self.APP_BASE_URL.startswith("http://"):
                problems.append("APP_BASE_URL is not https")
            # Without a provider key the mailer falls back to printing whole
            # messages - including password-reset links - to the application
            # log. services/mailer.py refuses that fallback in production, so
            # the real consequence of booting without a key is that nobody can
            # verify an address or recover an account. Both are launch bugs;
            # neither should be discovered by a locked-out customer.
            if not self.EMAIL_API_KEY:
                problems.append(
                    "EMAIL_API_KEY is unset, so verification and password-reset "
                    "mail cannot be delivered"
                )
            # The default DSN carries the password published in this repository.
            if "devpassword" in self.DATABASE_URL:
                problems.append(
                    "DATABASE_URL still contains the development password"
                )
            if problems:
                raise ValueError(
                    "Refusing to start in production: "
                    + "; ".join(problems)
                    + ". Generate a secret with: python -c "
                      "\"import secrets; print(secrets.token_urlsafe(48))\""
                )
        return self

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT == "production"



@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
