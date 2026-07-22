from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Database / Redis
    DATABASE_URL: str = "postgresql+asyncpg://chessrabbit:devpassword@postgres:5432/chessrabbit"
    REDIS_URL: str = "redis://redis:6379/0"

    # Auth
    JWT_SECRET: str = "dev-secret-change-me"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_TTL_MIN: int = 15
    REFRESH_TOKEN_TTL_DAYS: int = 30

    # App
    APP_BASE_URL: str = "http://localhost:3000"
    ENVIRONMENT: str = "development"

    # Engine
    ENGINE_MAX_MOVETIME_MS: int = 60_000
    SYZYGY_PATH: str = ""  # directory of .rtbw/.rtbz files; empty = disabled

    # Tier limits (BLUEPRINT Section 1.4)
    FREE_MAX_DEPTH: int = 18
    PRO_MAX_DEPTH: int = 32
    FREE_DAILY_ANALYSES: int = 10
    FREE_MAX_GAMES: int = 50
    FREE_MAX_MULTIPV: int = 1
    PRO_MAX_MULTIPV: int = 5

    # Stripe
    STRIPE_SECRET_KEY: str = ""
    STRIPE_WEBHOOK_SECRET: str = ""
    STRIPE_PRICE_PRO_MONTHLY: str = ""
    STRIPE_PRICE_PRO_YEARLY: str = ""

    # Email
    EMAIL_API_KEY: str = ""
    EMAIL_FROM: str = "noreply@example.com"

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT == "production"

    def max_depth_for(self, plan: str) -> int:
        from app.core.tiers import is_paid
        return self.PRO_MAX_DEPTH if is_paid(plan) else self.FREE_MAX_DEPTH

    def max_multipv_for(self, plan: str) -> int:
        from app.core.tiers import is_paid
        return self.PRO_MAX_MULTIPV if is_paid(plan) else self.FREE_MAX_MULTIPV


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
