"""
Auto-import games from Lichess / Chess.com public APIs (Sprint 2, 3.3).

Both platforms expose full game history without OAuth:
- Lichess:   GET https://lichess.org/api/games/user/{username}  (PGN stream)
- Chess.com: GET https://api.chess.com/pub/player/{u}/games/archives (JSON, monthly)

Sync strategy: newest games first, capped per sync (MAX_SYNC_GAMES); dedupe on
the platform's game URL stored in games.external_id. The free-tier storage cap
is respected - we import up to the remaining quota and report the rest as
"capped" so the UI can show an upgrade prompt exactly where value was denied.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.chess_utils import parse_pgn, positions_of_game
from app.core.config import settings
from app.models import ExternalAccount, Game, GamePosition, User

log = logging.getLogger(__name__)

PLATFORMS = ("lichess", "chesscom")
MAX_SYNC_GAMES = 300  # per sync run; nightly cron catches up long histories
_HEADERS = {"User-Agent": "ChessRabbit/0.1 (auto-import; noreply@chessrabbit.app)"}
_TIMEOUT = httpx.Timeout(30.0, read=60.0)

# Standard chess only: variant movetext (atomic, crazyhouse, ...) would poison
# the position index, which assumes normal rules.
_LICHESS_PERFS = "ultraBullet,bullet,blitz,rapid,classical,correspondence"


class PlatformError(Exception):
    """User not found, API unreachable, or malformed platform response."""


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(headers=_HEADERS, timeout=_TIMEOUT, follow_redirects=True)


async def verify_account(platform: str, username: str) -> str:
    """Confirm the account exists; return the platform's canonical username."""
    async with _client() as client:
        try:
            if platform == "lichess":
                res = await client.get(f"https://lichess.org/api/user/{username}")
            else:
                res = await client.get(f"https://api.chess.com/pub/player/{username.lower()}")
        except httpx.HTTPError as exc:
            raise PlatformError(f"{platform} is unreachable: {exc.__class__.__name__}") from exc

    if res.status_code == 404:
        raise PlatformError(f'No {platform} account named "{username}"')
    if res.status_code != 200:
        raise PlatformError(f"{platform} returned HTTP {res.status_code}")

    try:
        return res.json().get("username") or username
    except ValueError as exc:
        raise PlatformError(f"{platform} sent a malformed response") from exc


async def fetch_games(
    platform: str,
    username: str,
    since: datetime | None,
    max_games: int = MAX_SYNC_GAMES,
) -> list[tuple[dict, str | None]]:
    """Return [(parsed_game_dict, external_id), ...], newest first."""
    if platform == "lichess":
        return await _fetch_lichess(username, since, max_games)
    return await _fetch_chesscom(username, since, max_games)


async def _fetch_lichess(
    username: str, since: datetime | None, max_games: int
) -> list[tuple[dict, str | None]]:
    params: dict = {
        "max": max_games,
        "moves": "true",
        "tags": "true",
        "perfType": _LICHESS_PERFS,
    }
    if since is not None:
        params["since"] = int(since.timestamp() * 1000)

    async with _client() as client:
        try:
            res = await client.get(
                f"https://lichess.org/api/games/user/{username}",
                params=params,
                headers={"Accept": "application/x-chess-pgn"},
            )
        except httpx.HTTPError as exc:
            raise PlatformError(f"lichess is unreachable: {exc.__class__.__name__}") from exc

    if res.status_code == 404:
        raise PlatformError(f'No lichess account named "{username}"')
    if res.status_code == 429:
        raise PlatformError("lichess rate limit hit - try again in a minute")
    if res.status_code != 200:
        raise PlatformError(f"lichess returned HTTP {res.status_code}")

    entries: list[tuple[dict, str | None]] = []
    for parsed in parse_pgn(res.text):
        site = parsed.get("site") or ""
        ext_id = site if site.startswith("https://lichess.org/") else None
        entries.append((parsed, ext_id))
    return entries


async def _fetch_chesscom(
    username: str, since: datetime | None, max_games: int
) -> list[tuple[dict, str | None]]:
    uname = username.lower()
    since_epoch = since.timestamp() if since is not None else 0.0

    async with _client() as client:
        try:
            res = await client.get(f"https://api.chess.com/pub/player/{uname}/games/archives")
        except httpx.HTTPError as exc:
            raise PlatformError(f"chess.com is unreachable: {exc.__class__.__name__}") from exc

        if res.status_code == 404:
            raise PlatformError(f'No chess.com account named "{username}"')
        if res.status_code != 200:
            raise PlatformError(f"chess.com returned HTTP {res.status_code}")

        try:
            archives: list[str] = res.json().get("archives", [])
        except ValueError as exc:
            raise PlatformError("chess.com sent a malformed response") from exc

        entries: list[tuple[dict, str | None]] = []
        # Archives are chronological month URLs (.../games/YYYY/MM); walk newest first.
        for archive_url in reversed(archives):
            if len(entries) >= max_games:
                break
            try:
                month_res = await client.get(archive_url)
            except httpx.HTTPError as exc:
                raise PlatformError(
                    f"chess.com is unreachable: {exc.__class__.__name__}"
                ) from exc
            if month_res.status_code != 200:
                continue  # a single bad month should not kill the sync

            games = month_res.json().get("games", [])
            month_all_old = True
            for game in reversed(games):  # newest first within the month
                if len(entries) >= max_games:
                    break
                end_time = game.get("end_time", 0)
                if end_time <= since_epoch:
                    continue
                month_all_old = False
                if game.get("rules") != "chess" or not game.get("pgn"):
                    continue
                parsed = parse_pgn(game["pgn"])
                if parsed:
                    entries.append((parsed[0], game.get("url")))
            if month_all_old and since_epoch and games:
                break  # every earlier month is older still

    return entries


async def _import_entries(
    db: AsyncSession,
    user: User,
    entries: list[tuple[dict, str | None]],
    source: str,
) -> tuple[int, int, int, list[str]]:
    """Insert games + position index rows. Returns (imported, duplicates, capped, errors)."""
    result = await db.execute(
        select(Game.external_id).where(
            Game.owner_id == user.id, Game.external_id.is_not(None)
        )
    )
    seen: set[str] = {row[0] for row in result.all()}

    count_res = await db.execute(
        select(func.count(Game.id)).where(Game.owner_id == user.id)
    )
    from app.core.tiers import is_paid

    quota: int | None = (
        None
        if is_paid(user.plan)
        else max(0, settings.FREE_MAX_GAMES - count_res.scalar_one())
    )

    imported = duplicates = capped = 0
    errors: list[str] = []

    for parsed, ext_id in entries:
        if ext_id and ext_id in seen:
            duplicates += 1
            continue
        if quota is not None and imported >= quota:
            capped += 1
            continue
        try:
            game = Game(owner_id=user.id, source=source, external_id=ext_id, **parsed)
            db.add(game)
            await db.flush()
            for ply, zob, uci in positions_of_game(game.movetext):
                db.add(GamePosition(game_id=game.id, ply=ply, zobrist=zob, move_uci=uci))
            if ext_id:
                seen.add(ext_id)
            imported += 1
        except Exception as exc:  # keep importing the rest of the batch
            errors.append(str(exc)[:200])

    await db.commit()
    return imported, duplicates, capped, errors


async def sync_account(db: AsyncSession, user: User, account: ExternalAccount) -> dict:
    """
    Fetch new games for a connected account and import them.
    Updates the account row's sync bookkeeping in all cases.
    """
    try:
        entries = await fetch_games(
            account.platform, account.username, account.last_synced_at
        )
    except PlatformError as exc:
        account.last_status = f"error: {exc}"[:300]
        await db.commit()
        raise

    imported, duplicates, capped, errors = await _import_entries(
        db, user, entries, source=account.platform
    )

    account.last_synced_at = datetime.now(timezone.utc)
    account.games_imported += imported
    account.last_status = "ok" if not errors else f"ok ({len(errors)} games failed to parse)"
    await db.commit()

    log.info(
        "Synced %s/%s for user %s: %d fetched, %d imported, %d dup, %d capped",
        account.platform, account.username, user.id,
        len(entries), imported, duplicates, capped,
    )
    return {
        "platform": account.platform,
        "username": account.username,
        "fetched": len(entries),
        "imported": imported,
        "duplicates": duplicates,
        "capped": capped,
        "errors": errors,
    }
