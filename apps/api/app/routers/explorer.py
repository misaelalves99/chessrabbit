"""Opening explorer and reference-database search."""

from __future__ import annotations

import json
import logging

import chess
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.chess_utils import validate_fen, zobrist_of
from app.core.db import get_db
from app.core.deps import get_optional_user
from app.core.redis_client import get_redis
from app.models import User
from app.schemas import ExplorerMove, ExplorerOut, ExplorerRequest, GameOut
from app.services.lichess_explorer import ExplorerUnavailable, masters_moves

log = logging.getLogger(__name__)
router = APIRouter(tags=["explorer"])

# The reference tree only changes when we reload a dump, so this can be long.
EXPLORER_TTL = 86400


async def _lichess_live(fen: str) -> ExplorerOut:
    """Map Lichess's live masters response to our ExplorerOut shape."""
    try:
        data = await masters_moves(fen)
    except ExplorerUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "explorer_unavailable", "message": str(exc)},
        )

    moves: list[ExplorerMove] = []
    for m in data.get("moves", []):
        w, d, b = m.get("white", 0), m.get("draws", 0), m.get("black", 0)
        n = max(1, w + d + b)
        moves.append(
            ExplorerMove(
                uci=m.get("uci", ""),
                san=m.get("san", m.get("uci", "")),
                games=w + d + b,
                white_wins=w, draws=d, black_wins=b,
                avg_elo=m.get("averageRating"),
                white_pct=round(100 * w / n, 1),
                draw_pct=round(100 * d / n, 1),
                black_pct=round(100 * b / n, 1),
            )
        )

    total = data.get("white", 0) + data.get("draws", 0) + data.get("black", 0)
    return ExplorerOut(fen=fen, total_games=total, moves=moves)


@router.post("/explorer", response_model=ExplorerOut)
async def explorer(
    payload: ExplorerRequest,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_optional_user),
):
    """
    Move statistics for a position.

    scope="reference" (default): precomputed opening_tree of master games.
    scope="mine": aggregated live from the caller's own imported games -
    the Personal Opening Tree. Requires auth; user collections are small
    enough (free tier caps at 50 games) that an indexed GROUP BY at query
    time beats maintaining a second tree.
    scope="lichess_live": queried on demand from Lichess's Opening Explorer
    API, so the masters statistics are always current (not our snapshot).
    """
    try:
        board = validate_fen(payload.fen)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_fen", "message": str(exc)},
        )

    if payload.scope == "lichess_live":
        return await _lichess_live(payload.fen)

    zob = zobrist_of(payload.fen)

    # The reference tree is a static snapshot and openings are power-law
    # distributed, so a small cache absorbs most of the traffic the analysis
    # board generates. Keyed on the position, not the FEN string, so
    # transpositions share an entry. "mine" is per-user and changes on import,
    # so it is deliberately not cached here.
    cache_key = f"exp:ref:{zob}" if payload.scope == "reference" else None
    if cache_key:
        try:
            hit = await get_redis().get(cache_key)
            if hit:
                return ExplorerOut(**json.loads(hit))
        except Exception:
            log.warning("explorer cache read failed", exc_info=True)

    if payload.scope == "mine":
        if user is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"code": "auth_required", "message": "Sign in to see your own games"},
            )
        rows = await db.execute(
            text(
                """
                SELECT p.move_uci,
                       COUNT(*)                                    AS games,
                       COUNT(*) FILTER (WHERE g.result = '1-0')    AS white_wins,
                       COUNT(*) FILTER (WHERE g.result = '1/2-1/2') AS draws,
                       COUNT(*) FILTER (WHERE g.result = '0-1')    AS black_wins,
                       AVG(GREATEST(g.white_elo, g.black_elo))::smallint AS avg_elo
                FROM game_positions p
                JOIN games g ON g.id = p.game_id
                WHERE p.zobrist = :zob AND g.owner_id = :uid
                GROUP BY p.move_uci
                ORDER BY games DESC
                LIMIT 20
                """
            ),
            {"zob": zob, "uid": user.id},
        )
    else:
        rows = await db.execute(
            text(
                """
                SELECT move_uci, games, white_wins, draws, black_wins, avg_elo
                FROM opening_tree
                WHERE zobrist = :zob
                ORDER BY games DESC
                LIMIT 20
                """
            ),
            {"zob": zob},
        )

    moves: list[ExplorerMove] = []
    total = 0
    for r in rows.mappings():
        total += r["games"]
        n = max(1, r["games"])
        try:
            san = board.san(chess.Move.from_uci(r["move_uci"]))
        except (ValueError, AssertionError):
            san = r["move_uci"]

        moves.append(
            ExplorerMove(
                uci=r["move_uci"], san=san, games=r["games"],
                white_wins=r["white_wins"], draws=r["draws"], black_wins=r["black_wins"],
                avg_elo=r["avg_elo"],
                white_pct=round(100 * r["white_wins"] / n, 1),
                draw_pct=round(100 * r["draws"] / n, 1),
                black_pct=round(100 * r["black_wins"] / n, 1),
            )
        )

    out = ExplorerOut(fen=payload.fen, total_games=total, moves=moves)

    if cache_key:
        try:
            await get_redis().setex(cache_key, EXPLORER_TTL, out.model_dump_json())
        except Exception:
            log.warning("explorer cache write failed", exc_info=True)

    return out


@router.post("/search/position", response_model=list[GameOut])
async def search_by_position(
    payload: ExplorerRequest,
    page: int = Query(default=1, ge=1),
    db: AsyncSession = Depends(get_db),
):
    """Find reference games that reached this exact position (BLUEPRINT 10.3)."""
    try:
        validate_fen(payload.fen)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"code": "invalid_fen", "message": str(exc)})

    zob = zobrist_of(payload.fen)
    limit, offset = 50, (page - 1) * 50

    rows = await db.execute(
        text(
            """
            SELECT g.id, g.white, g.black, g.white_elo, g.black_elo, g.result,
                   g.event, g.played_on, g.eco, g.opening, g.ply_count
            FROM game_positions p
            JOIN games g ON g.id = p.game_id
            WHERE p.zobrist = :zob AND g.owner_id IS NULL
            ORDER BY GREATEST(g.white_elo, g.black_elo) DESC NULLS LAST
            LIMIT :lim OFFSET :off
            """
        ),
        {"zob": zob, "lim": limit, "off": offset},
    )
    return [GameOut(**dict(r)) for r in rows.mappings()]


@router.get("/search/games", response_model=list[GameOut])
async def search_games(
    white: str | None = None,
    black: str | None = None,
    eco: str | None = None,
    result: str | None = None,
    min_elo: int | None = None,
    page: int = Query(default=1, ge=1),
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_optional_user),
):
    """Metadata search over the public reference database."""
    clauses = ["g.owner_id IS NULL"]
    params: dict = {"lim": 50, "off": (page - 1) * 50}

    if white:
        clauses.append("lower(g.white) LIKE :white")
        params["white"] = f"%{white.lower()}%"
    if black:
        clauses.append("lower(g.black) LIKE :black")
        params["black"] = f"%{black.lower()}%"
    if eco:
        clauses.append("g.eco = :eco")
        params["eco"] = eco.upper()[:3]
    if result:
        clauses.append("g.result = :result")
        params["result"] = result
    if min_elo:
        clauses.append("GREATEST(g.white_elo, g.black_elo) >= :min_elo")
        params["min_elo"] = min_elo

    sql = f"""
        SELECT g.id, g.white, g.black, g.white_elo, g.black_elo, g.result,
               g.event, g.played_on, g.eco, g.opening, g.ply_count
        FROM games g
        WHERE {' AND '.join(clauses)}
        ORDER BY GREATEST(g.white_elo, g.black_elo) DESC NULLS LAST
        LIMIT :lim OFFSET :off
    """
    rows = await db.execute(text(sql), params)
    return [GameOut(**dict(r)) for r in rows.mappings()]
