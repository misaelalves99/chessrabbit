"""Analysis endpoints: queue positions/games for the server-side engine."""

from __future__ import annotations

import json


from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.chess_utils import validate_fen, zobrist_of
from app.core.config import settings
from app.core.db import get_db
from app.core.deps import check_and_increment_usage, get_current_user, require_pro
from app.core.redis_client import get_redis
from app.models import AnalysisCache, AnalysisJob, Game, User
from app.schemas import AnalysePositionRequest, AnalysisJobOut

router = APIRouter(prefix="/analysis", tags=["analysis"])


@router.post("/position", response_model=AnalysisJobOut)
async def analyse_position(
    payload: AnalysePositionRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Request analysis of a position.

    Cache hit  -> returns the stored evaluation immediately (status='done').
    Cache miss -> enqueues a job; client subscribes to /ws/analysis for the stream.
    """
    try:
        validate_fen(payload.fen)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_fen", "message": str(exc)},
        )

    # Clamp request to the caller's plan rather than rejecting outright
    depth = min(payload.depth, settings.max_depth_for(user.plan))
    multipv = min(payload.multipv, settings.max_multipv_for(user.plan))
    zob = zobrist_of(payload.fen)

    cached = await db.execute(
        select(AnalysisCache).where(
            AnalysisCache.zobrist == zob, AnalysisCache.depth >= depth
        ).limit(1)
    )
    hit = cached.scalar_one_or_none()
    if hit:
        job = AnalysisJob(
            user_id=user.id, kind="position",
            params={"fen": payload.fen, "depth": depth, "multipv": multipv},
            status="done",
            result={"cached": True, "depth": hit.depth, "lines": hit.multipv},
        )
        db.add(job)
        await db.commit()
        await db.refresh(job)
        return AnalysisJobOut(job_id=job.id, status="done", cached=True, result=job.result)

    # Cache miss: meter it, then queue
    await check_and_increment_usage(db, user)

    job = AnalysisJob(
        user_id=user.id, kind="position",
        params={"fen": payload.fen, "depth": depth, "multipv": multipv},
        status="queued",
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    queue = "q:pro" if user.plan == "pro" else "q:free"
    await get_redis().rpush(
        queue,
        json.dumps({
            "job_id": job.id, "kind": "position", "fen": payload.fen,
            "depth": depth, "multipv": multipv, "user_id": user.id,
        }),
    )

    return AnalysisJobOut(job_id=job.id, status="queued", cached=False)


@router.post("/game/{game_id}", response_model=AnalysisJobOut)
async def analyse_full_game(
    game_id: int,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
):
    """Queue a full-game annotation pass. Pro only (BLUEPRINT 9.3)."""
    game = await db.get(Game, game_id)
    if game is None or (game.owner_id is not None and game.owner_id != user.id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Game not found"},
        )

    job = AnalysisJob(
        user_id=user.id, game_id=game_id, kind="full_game",
        params={"depth": 18}, status="queued",
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    # q:batch, not q:pro: full-game jobs hold an engine for minutes and must
    # never sit ahead of live position analyses (see services/engine/worker.py).
    await get_redis().rpush(
        "q:batch",
        json.dumps({
            "job_id": job.id, "kind": "full_game", "game_id": game_id,
            "user_id": user.id, "depth": 18,
        }),
    )
    return AnalysisJobOut(job_id=job.id, status="queued")


@router.post("/collection/{collection_id}", response_model=list[AnalysisJobOut])
async def analyse_collection(
    collection_id: int,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
):
    """Queue a full-game annotation pass for every game in a collection (Pro).

    Capped at 25 games per request to keep one user from monopolising the
    engine pool; call again for the next batch.
    """
    from app.models import Collection, CollectionGame

    col = await db.get(Collection, collection_id)
    if col is None or col.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Collection not found"},
        )

    rows = await db.execute(
        select(CollectionGame.game_id)
        .where(CollectionGame.collection_id == collection_id)
        .limit(25)
    )
    game_ids = [r[0] for r in rows.all()]
    if not game_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "empty_collection", "message": "Collection has no games"},
        )

    redis = get_redis()
    out: list[AnalysisJobOut] = []
    for gid in game_ids:
        job = AnalysisJob(
            user_id=user.id, game_id=gid, kind="full_game",
            params={"depth": 18}, status="queued",
        )
        db.add(job)
        await db.flush()
        out.append(AnalysisJobOut(job_id=job.id, status="queued"))

    await db.commit()
    for job_out, gid in zip(out, game_ids):
        await redis.rpush(
            "q:batch",
            json.dumps({
                "job_id": job_out.job_id, "kind": "full_game",
                "game_id": gid, "user_id": user.id, "depth": 18,
            }),
        )
    return out


@router.get("/tablebase")
async def tablebase_probe(
    fen: str,
    user: User = Depends(get_current_user),
):
    """
    Exact endgame result for positions with <= 7 pieces.

    Sources, in order:
    1. Chess rules - insufficient-material positions are draws, no files needed.
    2. Syzygy tablebases on disk (SYZYGY_PATH) - exact WDL + DTZ.
    If neither applies, returns available=false with install instructions
    rather than an error: absence of tablebases is a configuration state,
    not a client mistake.
    """
    import os

    import chess.syzygy

    try:
        board = validate_fen(fen)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_fen", "message": str(exc)},
        )

    piece_count = chess.popcount(board.occupied)
    if piece_count > 7:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "too_many_pieces",
                "message": f"Tablebases cover at most 7 pieces; position has {piece_count}",
            },
        )

    side = "white" if board.turn == chess.WHITE else "black"

    # Exact by rule: neither side can ever mate.
    if board.is_insufficient_material():
        return {
            "available": True,
            "source": "rules",
            "pieces": piece_count,
            "side_to_move": side,
            "wdl": 0,
            "dtz": None,
            "category": "draw",
            "detail": "Insufficient mating material",
        }

    if settings.SYZYGY_PATH and os.path.isdir(settings.SYZYGY_PATH):
        try:
            with chess.syzygy.open_tablebase(settings.SYZYGY_PATH) as tb:
                wdl = tb.probe_wdl(board)   # side-to-move view: 2/1/0/-1/-2
                dtz = tb.probe_dtz(board)
        except (KeyError, chess.syzygy.MissingTableError):
            return {
                "available": False,
                "pieces": piece_count,
                "message": f"No table for this {piece_count}-piece material balance "
                           f"in SYZYGY_PATH; download the matching .rtbw/.rtbz files.",
            }

        category = {
            2: "win", 1: "cursed-win", 0: "draw",
            -1: "blessed-loss", -2: "loss",
        }[wdl]
        return {
            "available": True,
            "source": "syzygy",
            "pieces": piece_count,
            "side_to_move": side,
            "wdl": wdl,
            "dtz": dtz,
            "category": category,
            "detail": f"{side} to move: {category}"
                      + (f", zeroing in {abs(dtz)}" if dtz else ""),
        }

    return {
        "available": False,
        "pieces": piece_count,
        "message": "Syzygy tablebases not installed. Download 3-4-5 piece files "
                   "(~1 GB) from tablebase.lichess.ovh and set SYZYGY_PATH.",
    }


@router.get("/jobs/{job_id}", response_model=AnalysisJobOut)
async def get_job(
    job_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await db.get(AnalysisJob, job_id)
    if job is None or job.user_id != user.id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Job not found"})
    return AnalysisJobOut(
        job_id=job.id, status=job.status,
        cached=bool((job.result or {}).get("cached")), result=job.result,
    )


@router.delete("/jobs/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_job(
    job_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await db.get(AnalysisJob, job_id)
    if job is None or job.user_id != user.id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Job not found"})
    if job.status in ("queued", "running"):
        job.status = "canceled"
        await db.commit()
