"""Game CRUD, PGN import/export, collections, annotations."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.chess_utils import parse_pgn, positions_of_game
from app.models import Annotation, Collection, CollectionGame, Game, GamePosition, User
from app.schemas import (
    AnnotationIn, AnnotationOut, CollectionIn, CollectionOut,
    GameDetail, GameOut, GameUpdate, ImportPgnRequest, ImportResult,
)

router = APIRouter(tags=["games"])


async def _count_user_games(db: AsyncSession, user_id: int) -> int:
    result = await db.execute(select(func.count(Game.id)).where(Game.owner_id == user_id))
    return result.scalar_one()


@router.get("/games", response_model=list[GameOut])
async def list_games(
    page: int = 1,
    limit: int = 50,
    collection: int | None = None,
    q: str | None = None,
    result: str | None = None,
    eco: str | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    limit = min(limit, 100)
    stmt = select(Game).where(Game.owner_id == user.id)

    if collection is not None:
        stmt = stmt.join(CollectionGame, CollectionGame.game_id == Game.id).where(
            CollectionGame.collection_id == collection
        )
    if q:
        needle = f"%{q.lower()}%"
        stmt = stmt.where(
            func.lower(Game.white).like(needle) | func.lower(Game.black).like(needle)
        )
    if result in ("1-0", "0-1", "1/2-1/2", "*"):
        stmt = stmt.where(Game.result == result)
    if eco:
        stmt = stmt.where(Game.eco == eco.upper()[:3])

    stmt = stmt.order_by(Game.created_at.desc()).offset((page - 1) * limit).limit(limit)
    result_rows = await db.execute(stmt)
    return list(result_rows.scalars().all())


@router.post("/games", response_model=ImportResult, status_code=status.HTTP_201_CREATED)
async def import_games(
    payload: ImportPgnRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Import one or many games from PGN text."""
    parsed = parse_pgn(payload.pgn)
    if not parsed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_pgn", "message": "No valid games found in that PGN"},
        )

    existing = await _count_user_games(db, user.id)
    if user.plan != "pro" and existing + len(parsed) > settings.FREE_MAX_GAMES:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "code": "game_limit_reached",
                "message": f"Free plan stores {settings.FREE_MAX_GAMES} games. Upgrade for unlimited.",
            },
        )

    ids: list[int] = []
    errors: list[str] = []

    for entry in parsed:
        try:
            game = Game(owner_id=user.id, source="user", **entry)
            db.add(game)
            await db.flush()
            ids.append(game.id)

            for ply, zob, uci in positions_of_game(game.movetext):
                db.add(GamePosition(game_id=game.id, ply=ply, zobrist=zob, move_uci=uci))
        except Exception as exc:  # keep importing the rest of the file
            errors.append(str(exc)[:200])

    await db.commit()
    return ImportResult(
        imported=len(ids), skipped=len(parsed) - len(ids), errors=errors, game_ids=ids
    )


@router.get("/games/{game_id}", response_model=GameDetail)
async def get_game(
    game_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    game = await db.get(Game, game_id)
    if game is None or (game.owner_id is not None and game.owner_id != user.id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Game not found"},
        )

    result = await db.execute(
        select(Annotation).where(Annotation.game_id == game_id, Annotation.user_id == user.id)
    )
    annotations = [AnnotationOut.model_validate(a) for a in result.scalars().all()]

    detail = GameDetail.model_validate(game)
    detail.annotations = annotations
    return detail


@router.patch("/games/{game_id}", response_model=GameOut)
async def update_game(
    game_id: int,
    payload: GameUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    game = await db.get(Game, game_id)
    if game is None or game.owner_id != user.id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Game not found"})

    for field, value in payload.model_dump(exclude_none=True).items():
        setattr(game, field, value)
    await db.commit()
    await db.refresh(game)
    return game


@router.delete("/games/{game_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_game(
    game_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    game = await db.get(Game, game_id)
    if game is None or game.owner_id != user.id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Game not found"})
    await db.delete(game)
    await db.commit()


@router.get("/games/{game_id}/pgn")
async def export_game_pgn(
    game_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Download a game as a .pgn file with headers rebuilt from metadata."""
    game = await db.get(Game, game_id)
    if game is None or (game.owner_id is not None and game.owner_id != user.id):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Game not found"})

    date_tag = game.played_on.strftime("%Y.%m.%d") if game.played_on else "????.??.??"
    headers = [
        f'[Event "{game.event or "?"}"]',
        f'[Site "{game.site or "?"}"]',
        f'[Date "{date_tag}"]',
        f'[White "{game.white or "?"}"]',
        f'[Black "{game.black or "?"}"]',
        f'[Result "{game.result}"]',
    ]
    if game.white_elo:
        headers.append(f'[WhiteElo "{game.white_elo}"]')
    if game.black_elo:
        headers.append(f'[BlackElo "{game.black_elo}"]')
    if game.eco:
        headers.append(f'[ECO "{game.eco}"]')

    body = "\n".join(headers) + "\n\n" + game.movetext
    if not body.rstrip().endswith(game.result):
        body = body.rstrip() + f" {game.result}"
    body += "\n"

    from fastapi.responses import PlainTextResponse
    return PlainTextResponse(
        body,
        media_type="application/x-chess-pgn",
        headers={"Content-Disposition": f'attachment; filename="game_{game_id}.pgn"'},
    )


@router.put("/games/{game_id}/annotations", response_model=list[AnnotationOut])
async def upsert_annotations(
    game_id: int,
    payload: list[AnnotationIn],
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    game = await db.get(Game, game_id)
    if game is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Game not found"})

    for item in payload:
        result = await db.execute(
            select(Annotation).where(
                Annotation.game_id == game_id,
                Annotation.user_id == user.id,
                Annotation.ply == item.ply,
            )
        )
        existing = result.scalar_one_or_none()
        if existing:
            existing.nag = item.nag
            existing.comment = item.comment
        else:
            db.add(
                Annotation(
                    game_id=game_id, user_id=user.id, ply=item.ply,
                    nag=item.nag, comment=item.comment,
                )
            )

    await db.commit()
    result = await db.execute(
        select(Annotation).where(Annotation.game_id == game_id, Annotation.user_id == user.id)
    )
    return list(result.scalars().all())


# ---------- collections ----------

@router.get("/collections", response_model=list[CollectionOut])
async def list_collections(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    result = await db.execute(
        select(Collection, func.count(CollectionGame.game_id))
        .outerjoin(CollectionGame, CollectionGame.collection_id == Collection.id)
        .where(Collection.user_id == user.id)
        .group_by(Collection.id)
    )
    return [
        CollectionOut(id=c.id, name=c.name, game_count=n) for c, n in result.all()
    ]


@router.post("/collections", response_model=CollectionOut, status_code=status.HTTP_201_CREATED)
async def create_collection(
    payload: CollectionIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    col = Collection(user_id=user.id, name=payload.name)
    db.add(col)
    await db.commit()
    await db.refresh(col)
    return CollectionOut(id=col.id, name=col.name, game_count=0)


@router.post("/collections/{collection_id}/games/{game_id}", status_code=status.HTTP_204_NO_CONTENT)
async def add_to_collection(
    collection_id: int,
    game_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    col = await db.get(Collection, collection_id)
    if col is None or col.user_id != user.id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Collection not found"})
    db.add(CollectionGame(collection_id=collection_id, game_id=game_id))
    await db.commit()
