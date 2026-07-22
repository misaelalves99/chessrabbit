"""
ChessRabbit API.

A ChessBase-style chess database and analysis platform.
Stockfish runs server-side only - see BLUEPRINT.md Section 3.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.db import engine
from app.core.redis_client import close_redis, get_redis
from app.routers import (
    accounts, admin, analysis, auth, billing, explorer, games, openings, play,
    prep, puzzles, training, users,
)
from app.ws import analysis as ws_analysis

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s [api] %(message)s",
)
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Starting ChessRabbit API (env=%s)", settings.ENVIRONMENT)
    yield
    await close_redis()
    await engine.dispose()
    log.info("Shutdown complete")


app = FastAPI(
    title="ChessRabbit API",
    description="Chess database, engine analysis, and opening explorer",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.APP_BASE_URL, "http://localhost:3000"],
    # Dev convenience: the web dev server may land on any localhost port.
    allow_origin_regex=r"http://localhost:\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    log.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"error": {"code": "internal_error", "message": "Something went wrong"}},
    )


@app.get("/health", tags=["meta"])
async def health():
    """Liveness + dependency check. Used by Docker healthchecks and uptime monitors."""
    db_ok = redis_ok = False

    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        log.warning("Health: database unreachable")

    try:
        await get_redis().ping()
        redis_ok = True
    except Exception:
        log.warning("Health: redis unreachable")

    healthy = db_ok and redis_ok
    return JSONResponse(
        status_code=200 if healthy else 503,
        content={
            "status": "ok" if healthy else "degraded",
            "database": db_ok,
            "redis": redis_ok,
            "version": app.version,
        },
    )


@app.get("/tiers", tags=["meta"])
async def list_tiers():
    """Public plan matrix for the pricing page. Single source: core/tiers.py."""
    from app.core.tiers import TIERS

    return [
        {
            "id": t.id, "label": t.label, "price_monthly": t.price_monthly,
            "reviews_per_day": t.reviews_per_day, "puzzles_per_day": t.puzzles_per_day,
            "rush_per_day": t.rush_per_day, "openings_white": t.openings_white,
            "openings_black": t.openings_black, "opponent_prep": t.opponent_prep,
        }
        for t in TIERS.values()
    ]


@app.get("/open-source", tags=["meta"])
async def open_source_credits():
    """
    Attribution for the open-source projects ChessRabbit depends on.
    Required by BLUEPRINT.md Section 17 launch checklist.
    """
    return {
        "stockfish": {
            "license": "GPL-3.0",
            "source": "https://github.com/official-stockfish/Stockfish",
            "note": "Run unmodified, server-side only. Never distributed to clients.",
        },
        "python-chess": {"license": "GPL-3.0", "note": "Server-side only"},
        "chess.js": {"license": "BSD-2-Clause"},
        "react-chessboard": {"license": "MIT"},
        "lichess-open-database": {
            "license": "CC0",
            "source": "https://database.lichess.org",
        },
    }


app.include_router(auth.router)
app.include_router(users.router)
app.include_router(accounts.router)
app.include_router(games.router)
app.include_router(analysis.router)
app.include_router(explorer.router)
app.include_router(training.router)
app.include_router(puzzles.router)
app.include_router(play.router)
app.include_router(openings.router)
app.include_router(prep.router)
app.include_router(admin.router)
app.include_router(billing.router)
app.include_router(ws_analysis.router)
