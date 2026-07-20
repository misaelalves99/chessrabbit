"""
ChessRabbit engine worker.

Consumes analysis jobs from Redis, runs Stockfish (server-side only), streams
eval lines back over Redis pub/sub, and persists results to analysis_cache.

Queues, in priority order:  q:pro  ->  q:batch  ->  q:free
Pub/sub channel per job:    eval:{job_id}

Concurrency: one consumer task per engine in the pool, so POOL_SIZE jobs run
in parallel. One consumer never drains q:batch (multi-minute full-game jobs),
guaranteeing live position analysis always has an engine available.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys

import chess
import chess.pgn        # submodules are not auto-imported by `import chess`
import chess.polyglot
import redis.asyncio as aioredis
import psycopg
from psycopg.rows import dict_row

from uci import EnginePool, EvalLine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s [engine] %(message)s",
)
log = logging.getLogger(__name__)

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://chessrabbit:devpassword@postgres:5432/chessrabbit")
POOL_SIZE = int(os.getenv("ENGINE_WORKERS", "3"))
THREADS = int(os.getenv("ENGINE_THREADS_PER_JOB", "2"))
HASH_MB = int(os.getenv("ENGINE_HASH_MB", "256"))
MAX_MOVETIME_MS = int(os.getenv("ENGINE_MAX_MOVETIME_MS", "60000"))

CHECKPOINT_DEPTHS = {12, 16, 18, 20, 24, 28, 30, 32}
# A played move counts as "book" when this many reference games reached the
# position and played it. Low default suits the seed DB; raise for real dumps.
BOOK_MIN_GAMES = int(os.getenv("BOOK_MIN_GAMES", "10"))

shutdown = asyncio.Event()


# ---------------------------------------------------------------
# Position helpers
# ---------------------------------------------------------------

def zobrist_of(fen: str) -> int:
    """
    Stable polyglot Zobrist hash of a position, as a SIGNED 64-bit int.

    python-chess returns an unsigned 64-bit value, but Postgres BIGINT is
    signed. Convert so the same position always maps to the same DB key.
    """
    board = chess.Board(fen)
    unsigned = chess.polyglot.zobrist_hash(board)
    return unsigned - (1 << 64) if unsigned >= (1 << 63) else unsigned


def white_to_move(fen: str) -> bool:
    return chess.Board(fen).turn == chess.WHITE


# ---------------------------------------------------------------
# Cache
# ---------------------------------------------------------------

async def cache_lookup(conn, zob: int, engine_version: str, min_depth: int) -> dict | None:
    async with conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(
            """
            SELECT depth, multipv, fen
            FROM analysis_cache
            WHERE zobrist = %s AND engine_version = %s AND depth >= %s
            """,
            (zob, engine_version, min_depth),
        )
        return await cur.fetchone()


async def cache_store(conn, zob: int, fen: str, engine_version: str, depth: int, lines: list[dict]) -> None:
    """Upsert, but only overwrite when the new analysis is deeper."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO analysis_cache (zobrist, fen, engine_version, depth, multipv)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (zobrist, engine_version) DO UPDATE
              SET depth   = EXCLUDED.depth,
                  multipv = EXCLUDED.multipv,
                  fen     = EXCLUDED.fen
              WHERE analysis_cache.depth < EXCLUDED.depth
            """,
            (zob, fen, engine_version, depth, json.dumps(lines)),
        )
    await conn.commit()


# ---------------------------------------------------------------
# Job status
# ---------------------------------------------------------------

async def set_job_status(conn, job_id: int, status: str, result: dict | None = None, error: str | None = None) -> None:
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE analysis_jobs
               SET status = %s,
                   result = COALESCE(%s::jsonb, result),
                   error = COALESCE(%s, error),
                   finished_at = CASE WHEN %s IN ('done','failed','canceled') THEN now() ELSE finished_at END
             WHERE id = %s
            """,
            (status, json.dumps(result) if result else None, error, status, job_id),
        )
    await conn.commit()


# ---------------------------------------------------------------
# Job handlers
# ---------------------------------------------------------------

async def handle_position_job(pool: EnginePool, redis, conn, job: dict) -> None:
    job_id = job["job_id"]
    fen = job["fen"]
    depth = min(int(job.get("depth", 20)), 40)
    multipv = max(1, min(int(job.get("multipv", 1)), 5))
    channel = f"eval:{job_id}"

    try:
        chess.Board(fen)  # validate before handing anything to the engine
    except ValueError as exc:
        await redis.publish(channel, json.dumps({"type": "error", "message": f"Invalid FEN: {exc}"}))
        await set_job_status(conn, job_id, "failed", error=f"Invalid FEN: {exc}")
        return

    zob = zobrist_of(fen)
    wtm = white_to_move(fen)

    cached = await cache_lookup(conn, zob, pool.version, depth)
    if cached:
        payload = {"type": "done", "cached": True, "depth": cached["depth"], "lines": cached["multipv"]}
        await redis.publish(channel, json.dumps(payload))
        await set_job_status(conn, job_id, "done", result=payload)
        log.info("job %s: cache hit at depth %s", job_id, cached["depth"])
        return

    await set_job_status(conn, job_id, "running")
    best_by_pv: dict[int, EvalLine] = {}
    reached_depth = 0

    async with pool.acquire() as engine:
        async for item in engine.analyse(fen, depth=depth, multipv=multipv, movetime_ms=None):
            if isinstance(item, dict) and item.get("type") == "bestmove":
                lines = [
                    best_by_pv[k].to_white_perspective(wtm).as_dict()
                    for k in sorted(best_by_pv)
                ]
                await cache_store(conn, zob, fen, pool.version, reached_depth, lines)
                payload = {
                    "type": "done",
                    "cached": False,
                    "depth": reached_depth,
                    "best": item.get("move"),
                    "lines": lines,
                }
                await redis.publish(channel, json.dumps(payload))
                await set_job_status(conn, job_id, "done", result=payload)
                log.info("job %s: computed to depth %s", job_id, reached_depth)
                return

            ev: EvalLine = item
            best_by_pv[ev.multipv] = ev
            reached_depth = max(reached_depth, ev.depth)

            norm = ev.to_white_perspective(wtm)
            await redis.publish(channel, json.dumps({"type": "info", **norm.as_dict()}))

            # Persist at checkpoint depths so partial work survives a crash
            if ev.depth in CHECKPOINT_DEPTHS and ev.multipv == multipv:
                snapshot = [
                    best_by_pv[k].to_white_perspective(wtm).as_dict()
                    for k in sorted(best_by_pv)
                ]
                await cache_store(conn, zob, fen, pool.version, ev.depth, snapshot)


async def handle_full_game_job(pool: EnginePool, redis, conn, job: dict) -> None:
    """
    Analyse every position in a game, tag mistakes, compute accuracy.
    Implements BLUEPRINT.md Section 9.3.
    """
    job_id = job["job_id"]
    game_id = job.get("game_id")
    user_id = job.get("user_id")
    depth = min(int(job.get("depth", 18)), 24)
    channel = f"eval:{job_id}"

    async with conn.cursor(row_factory=dict_row) as cur:
        await cur.execute("SELECT id, movetext FROM games WHERE id = %s", (game_id,))
        game = await cur.fetchone()

    if not game:
        await set_job_status(conn, job_id, "failed", error="Game not found")
        return

    await set_job_status(conn, job_id, "running")

    board = chess.Board()
    posinfo: list[dict] = []  # per position: {cp, mate, pv} in White perspective
    fens: list[str] = []
    zobs: list[int] = []
    moves: list[chess.Move] = []

    try:
        import io
        pgn_game = chess.pgn.read_game(io.StringIO(game["movetext"]))
        if pgn_game is None:
            raise ValueError("Unparseable movetext")
        moves = list(pgn_game.mainline_moves())
    except Exception as exc:
        await set_job_status(conn, job_id, "failed", error=f"PGN parse error: {exc}")
        return

    total = len(moves) + 1
    async with pool.acquire() as engine:
        for idx in range(total):
            if shutdown.is_set():
                await set_job_status(conn, job_id, "canceled")
                return

            fen = board.fen()
            zob = zobrist_of(fen)
            wtm = board.turn == chess.WHITE
            fens.append(fen)
            zobs.append(zob)

            # Terminal positions: score by rule. Asking the engine about a
            # finished game yields "mate 0", which mis-signs the eval and
            # made winning mate moves look like blunders.
            if board.is_checkmate():
                posinfo.append({"cp": -10000.0 if wtm else 10000.0, "mate": None, "pv": []})
                await redis.publish(
                    channel,
                    json.dumps({"type": "progress", "done": idx + 1, "total": total}),
                )
                if idx < len(moves):
                    board.push(moves[idx])
                continue
            if board.is_stalemate() or board.is_insufficient_material():
                posinfo.append({"cp": 0.0, "mate": None, "pv": []})
                await redis.publish(
                    channel,
                    json.dumps({"type": "progress", "done": idx + 1, "total": total}),
                )
                if idx < len(moves):
                    board.push(moves[idx])
                continue

            cached = await cache_lookup(conn, zob, pool.version, depth)
            if cached:
                lines = cached["multipv"]
                first = lines[0] if lines else {}
                posinfo.append({
                    "cp": _line_to_cp(first) if lines else 0.0,
                    "mate": first.get("mate"),
                    "pv": first.get("pv") or [],
                })
            else:
                best: EvalLine | None = None
                async for item in engine.analyse(fen, depth=depth, multipv=1):
                    if isinstance(item, dict):
                        break
                    best = item
                if best is None:
                    posinfo.append({"cp": 0.0, "mate": None, "pv": []})
                else:
                    d = best.to_white_perspective(wtm).as_dict()
                    await cache_store(conn, zob, fen, pool.version, d["depth"], [d])
                    posinfo.append({
                        "cp": _line_to_cp(d),
                        "mate": d.get("mate"),
                        "pv": d.get("pv") or [],
                    })

            await redis.publish(
                channel,
                json.dumps({"type": "progress", "done": idx + 1, "total": total}),
            )

            if idx < len(moves):
                board.push(moves[idx])

    book_plies = await _book_plies(conn, zobs, moves)
    annotations = _build_reviews(moves, fens, posinfo, book_plies)
    await _store_annotations(conn, game_id, user_id, annotations)

    evals = [p["cp"] for p in posinfo]
    accuracy = _accuracy_scores(evals)
    payload = {
        "type": "done",
        "accuracy": accuracy,
        "moves_analysed": len(evals),
        "classifications": _summarize(annotations),
    }
    await redis.publish(channel, json.dumps(payload))
    await set_job_status(conn, job_id, "done", result=payload)
    log.info("job %s: full game reviewed (%d positions)", job_id, len(evals))


def _line_to_cp(line: dict) -> float:
    """Convert a stored eval line to a centipawn float (mate -> large signed value)."""
    if line.get("mate") is not None:
        m = line["mate"]
        return 10000.0 if m > 0 else -10000.0
    return float(line.get("cp") or 0)


async def _book_plies(conn, zobs: list[int], moves: list) -> set[int]:
    """Plies (first 16 only) whose played move is known opening theory."""
    limit = min(len(moves), 16)
    if limit == 0:
        return set()
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT zobrist, move_uci FROM opening_tree "
            "WHERE zobrist = ANY(%s) AND games >= %s",
            (zobs[:limit], BOOK_MIN_GAMES),
        )
        known = {(z, u) for z, u in await cur.fetchall()}
    return {i for i in range(limit) if (zobs[i], moves[i].uci()) in known}


def _san_line(fen: str, pv: list[str], limit: int = 5) -> str:
    """Render the first few PV moves as a readable SAN line."""
    board = chess.Board(fen)
    sans: list[str] = []
    for uci in pv[:limit]:
        try:
            move = chess.Move.from_uci(uci)
            sans.append(board.san(move))
            board.push(move)
        except Exception:
            break
    return " ".join(sans)


def _mate_for(info: dict, white: bool) -> int | None:
    """Mate distance if `info` says the given side has a forced mate."""
    m = info.get("mate")
    if m is None:
        return None
    return abs(m) if (m > 0) == white else None


NAG_BY_CLASS = {"blunder": 4, "mistake": 2, "inaccuracy": 6}


def _build_reviews(
    moves: list, fens: list[str], posinfo: list[dict], book_plies: set[int]
) -> list[dict]:
    """
    Chess.com-style review: classify every move and explain it from engine
    facts only (mates, hanging pieces, eval swings) - no speculation.
    """
    out: list[dict] = []

    for i, move in enumerate(moves):
        if i + 1 >= len(posinfo) or i + 1 >= len(fens):
            break  # job was cut short (shutdown mid-game)

        info, nxt = posinfo[i], posinfo[i + 1]
        white_moved = i % 2 == 0
        board = chess.Board(fens[i])
        after = chess.Board(fens[i + 1])

        pv = info["pv"]
        best_uci = pv[0] if pv else None
        played_is_best = best_uci == move.uci()

        best_san = line = None
        if best_uci and not played_is_best:
            try:
                best_san = board.san(chess.Move.from_uci(best_uci))
                line = _san_line(fens[i], pv)
            except Exception:
                pass

        wp_before = _win_percent(info["cp"])
        wp_after = _win_percent(nxt["cp"])
        drop = max(0.0, (wp_before - wp_after) if white_moved else (wp_after - wp_before))

        # ----- classification -----
        if after.is_checkmate():
            cls, review = "best", "Checkmate."
        elif i in book_plies:
            cls, review = "book", "Book move — established opening theory."
        elif played_is_best:
            cls = "best"
            mate_kept = _mate_for(nxt, white_moved)
            review = (
                f"Best move — keeps the forced mate in {mate_kept} on track."
                if mate_kept is not None
                else "Best move — the engine's top choice."
            )
        elif drop < 2:
            cls, review = "excellent", "Excellent — practically as strong as the engine's first choice."
        elif drop < 5:
            cls, review = "good", "A solid move."
        else:
            cls = "inaccuracy" if drop < 10 else ("mistake" if drop < 20 else "blunder")
            review = _explain_bad_move(
                cls, move, board, after, fens, i, info, nxt, white_moved, best_san, line
            )

        out.append({
            "ply": i,
            "nag": NAG_BY_CLASS.get(cls),
            "eval_cp": int(max(-10000, min(10000, nxt["cp"]))),
            "best_uci": best_uci,
            "classification": cls,
            "review": review,
        })

    return out


def _explain_bad_move(
    cls: str,
    move,
    board,
    after,
    fens: list[str],
    i: int,
    info: dict,
    nxt: dict,
    white_moved: bool,
    best_san: str | None,
    line: str | None,
) -> str:
    opener = {"inaccuracy": "An inaccuracy.", "mistake": "A mistake.", "blunder": "A blunder."}[cls]

    # Cause, most specific first.
    missed_mate = _mate_for(info, white_moved)
    allowed_mate = _mate_for(nxt, not white_moved)
    had_mate_against = _mate_for(info, not white_moved)  # already lost before the move

    cause = None
    if missed_mate is not None and _mate_for(nxt, white_moved) is None:
        cause = f"There was a forced mate in {missed_mate}" + (
            f" starting with {best_san}." if best_san else "."
        )
    elif allowed_mate is not None and had_mate_against is None:
        cause = f"This allows a forced mate in {allowed_mate}."
    elif after.is_stalemate():
        cause = "Stalemate — the game is drawn despite the material."
    elif cls != "inaccuracy" and nxt["pv"]:
        # Hanging piece: the opponent's best reply simply captures what just moved.
        reply = nxt["pv"][0]
        if reply[2:4] == move.uci()[2:4]:
            victim = after.piece_at(chess.parse_square(reply[2:4]))
            if victim is not None:
                try:
                    reply_san = after.san(chess.Move.from_uci(reply))
                    cause = (
                        f"This leaves the {chess.piece_name(victim.piece_type)} on "
                        f"{reply[2:4]} en prise — {reply_san} wins material."
                    )
                except Exception:
                    pass

    if cause is None:
        both_normal = abs(info["cp"]) < 2000 and abs(nxt["cp"]) < 2000
        if both_normal:
            pawns = abs(info["cp"] - nxt["cp"]) / 100
            cause = f"The evaluation swings by {pawns:.1f} pawns."
        else:
            cause = "The advantage slips away."

    suggestion = ""
    if best_san:
        suggestion = f" Better was {best_san}" + (f" ({line})." if line and " " in line else ".")

    return f"{opener} {cause}{suggestion}"


def _summarize(annotations: list[dict]) -> dict:
    """Per-player counts of each classification, for the review summary panel."""
    counts: dict[str, dict[str, int]] = {"white": {}, "black": {}}
    for a in annotations:
        side = "white" if a["ply"] % 2 == 0 else "black"
        cls = a["classification"]
        counts[side][cls] = counts[side].get(cls, 0) + 1
    return counts


def _win_percent(cp: float) -> float:
    """Standard logistic mapping from centipawns to win probability (0-100)."""
    import math
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def _accuracy_scores(evals: list[float]) -> dict:
    """Per-player accuracy from win-percent drops across their own moves."""
    import math
    white_losses: list[float] = []
    black_losses: list[float] = []

    for i in range(len(evals) - 1):
        wp_before = _win_percent(evals[i])
        wp_after = _win_percent(evals[i + 1])
        if i % 2 == 0:
            white_losses.append(max(0.0, wp_before - wp_after))
        else:
            black_losses.append(max(0.0, wp_after - wp_before))

    def score(losses: list[float]) -> float:
        if not losses:
            return 100.0
        per_move = [
            max(0.0, min(100.0, 103.1668 * math.exp(-0.04354 * loss) - 3.1669))
            for loss in losses
        ]
        return round(sum(per_move) / len(per_move), 1)

    return {"white": score(white_losses), "black": score(black_losses)}


async def _store_annotations(
    conn, game_id: int, user_id: int, annotations: list[dict]
) -> None:
    """Upsert review rows. `comment` is the user's own field - never touched."""
    async with conn.cursor() as cur:
        for ann in annotations:
            await cur.execute(
                """
                INSERT INTO annotations
                  (game_id, user_id, ply, nag, eval_cp, best_uci, classification, review)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (game_id, user_id, ply) DO UPDATE
                  SET nag = EXCLUDED.nag, eval_cp = EXCLUDED.eval_cp,
                      best_uci = EXCLUDED.best_uci,
                      classification = EXCLUDED.classification,
                      review = EXCLUDED.review
                """,
                (
                    game_id, user_id, ann["ply"], ann["nag"], ann["eval_cp"],
                    ann["best_uci"], ann["classification"], ann["review"],
                ),
            )
    await conn.commit()


# ---------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------

async def consume(consumer_id: int, queues: list[str], pool: EnginePool, redis) -> None:
    """One consumer: own DB connection, drains `queues` in priority order."""
    conn = await psycopg.AsyncConnection.connect(DATABASE_URL, autocommit=False)
    log.info("Consumer %d up (queues=%s)", consumer_id, queues)

    while not shutdown.is_set():
        try:
            popped = await redis.blpop(queues, timeout=2)
            if popped is None:
                continue

            _queue, raw = popped
            job = json.loads(raw)
            kind = job.get("kind", "position")
            log.info("Consumer %d picked up job %s (%s) from %s",
                     consumer_id, job.get("job_id"), kind, _queue)

            if kind == "full_game":
                await handle_full_game_job(pool, redis, conn, job)
            else:
                await handle_position_job(pool, redis, conn, job)

        except asyncio.CancelledError:
            break
        except Exception:
            log.exception("Consumer %d: job failed with unhandled exception", consumer_id)
            try:
                await conn.rollback()
            except Exception:
                try:
                    conn = await psycopg.AsyncConnection.connect(DATABASE_URL, autocommit=False)
                except Exception:
                    log.warning("Consumer %d: Postgres unreachable, retrying shortly", consumer_id)
                    await asyncio.sleep(2)

    await conn.close()


async def main() -> None:
    log.info("Starting engine worker (pool=%d threads=%d hash=%dMB)", POOL_SIZE, THREADS, HASH_MB)

    pool = EnginePool(size=POOL_SIZE, threads=THREADS, hash_mb=HASH_MB)
    try:
        await pool.start()
    except FileNotFoundError:
        log.error("Stockfish binary not found. Install it or check the Dockerfile.")
        sys.exit(1)

    redis = aioredis.from_url(REDIS_URL, decode_responses=True)
    log.info("Connected to Redis. Engine: %s", pool.version)

    # One consumer per engine so the whole pool works in parallel. The last
    # consumer skips q:batch: a full-game job holds an engine for minutes, and
    # live position analysis must always have a free slot.
    consumers: list[asyncio.Task] = []
    for i in range(POOL_SIZE):
        reserved = POOL_SIZE > 1 and i == POOL_SIZE - 1
        queues = ["q:pro", "q:free"] if reserved else ["q:pro", "q:batch", "q:free"]
        consumers.append(asyncio.create_task(consume(i, queues, pool, redis)))

    await asyncio.gather(*consumers)

    log.info("Shutting down engine pool")
    await pool.stop()
    await redis.aclose()


def _handle_signal(*_args) -> None:
    log.info("Signal received; finishing current job then exiting")
    shutdown.set()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)
    asyncio.run(main())
