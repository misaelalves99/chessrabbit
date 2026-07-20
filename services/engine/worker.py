"""
ChessRabbit engine worker.

Consumes analysis jobs from Redis, runs Stockfish (server-side only), streams
eval lines back over Redis pub/sub, and persists results to analysis_cache.

Queues, in priority order:  q:pro  ->  q:free
Pub/sub channel per job:    eval:{job_id}
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

QUEUES = ["q:pro", "q:free"]
CHECKPOINT_DEPTHS = {12, 16, 18, 20, 24, 28, 30, 32}

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
    evals: list[float] = []
    bests: list[str | None] = []
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

            # Terminal positions: score by rule. Asking the engine about a
            # finished game yields "mate 0", which mis-signs the eval and
            # made winning mate moves look like blunders.
            if board.is_checkmate():
                evals.append(-10000.0 if wtm else 10000.0)
                bests.append(None)
                await redis.publish(
                    channel,
                    json.dumps({"type": "progress", "done": idx + 1, "total": total}),
                )
                if idx < len(moves):
                    board.push(moves[idx])
                continue
            if board.is_stalemate() or board.is_insufficient_material():
                evals.append(0.0)
                bests.append(None)
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
                score = _line_to_cp(lines[0]) if lines else 0.0
                pv0 = (lines[0].get("pv") or [None])[0] if lines else None
            else:
                best: EvalLine | None = None
                async for item in engine.analyse(fen, depth=depth, multipv=1):
                    if isinstance(item, dict):
                        break
                    best = item
                if best is None:
                    score = 0.0
                    pv0 = None
                else:
                    norm = best.to_white_perspective(wtm)
                    await cache_store(conn, zob, fen, pool.version, norm.depth, [norm.as_dict()])
                    score = _line_to_cp(norm.as_dict())
                    pv0 = (norm.as_dict().get("pv") or [None])[0]

            evals.append(score)
            bests.append(pv0)

            await redis.publish(
                channel,
                json.dumps({"type": "progress", "done": idx + 1, "total": total}),
            )

            if idx < len(moves):
                board.push(moves[idx])

    annotations = _classify_moves(evals)
    await _store_annotations(conn, game_id, user_id, annotations, bests)

    accuracy = _accuracy_scores(evals)
    payload = {"type": "done", "accuracy": accuracy, "moves_analysed": len(evals)}
    await redis.publish(channel, json.dumps(payload))
    await set_job_status(conn, job_id, "done", result=payload)
    log.info("job %s: full game analysed (%d positions)", job_id, len(evals))


def _line_to_cp(line: dict) -> float:
    """Convert a stored eval line to a centipawn float (mate -> large signed value)."""
    if line.get("mate") is not None:
        m = line["mate"]
        return 10000.0 if m > 0 else -10000.0
    return float(line.get("cp") or 0)


def _classify_moves(evals: list[float]) -> list[dict]:
    """
    Tag each move by centipawn loss from the mover's perspective.
    NAG codes: 2 = '?', 4 = '??', 6 = '?!'
    """
    out: list[dict] = []
    for i in range(len(evals) - 1):
        before, after = evals[i], evals[i + 1]
        white_moved = (i % 2 == 0)
        loss = (before - after) if white_moved else (after - before)

        nag = None
        if loss >= 200:
            nag = 4
        elif loss >= 100:
            nag = 2
        elif loss >= 50:
            nag = 6

        out.append({"ply": i, "nag": nag, "eval_cp": int(max(-10000, min(10000, after)))})
    return out


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
    conn, game_id: int, user_id: int, annotations: list[dict], bests: list
) -> None:
    async with conn.cursor() as cur:
        for ann in annotations:
            ply = ann["ply"]
            best_uci = bests[ply] if ply < len(bests) else None
            await cur.execute(
                """
                INSERT INTO annotations (game_id, user_id, ply, nag, eval_cp, best_uci)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (game_id, user_id, ply) DO UPDATE
                  SET nag = EXCLUDED.nag, eval_cp = EXCLUDED.eval_cp,
                      best_uci = EXCLUDED.best_uci
                """,
                (game_id, user_id, ply, ann["nag"], ann["eval_cp"], best_uci),
            )
    await conn.commit()


# ---------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------

async def main() -> None:
    log.info("Starting engine worker (pool=%d threads=%d hash=%dMB)", POOL_SIZE, THREADS, HASH_MB)

    pool = EnginePool(size=POOL_SIZE, threads=THREADS, hash_mb=HASH_MB)
    try:
        await pool.start()
    except FileNotFoundError:
        log.error("Stockfish binary not found. Install it or check the Dockerfile.")
        sys.exit(1)

    redis = aioredis.from_url(REDIS_URL, decode_responses=True)
    conn = await psycopg.AsyncConnection.connect(DATABASE_URL, autocommit=False)
    log.info("Connected to Redis and Postgres. Engine: %s", pool.version)

    while not shutdown.is_set():
        try:
            popped = await redis.blpop(QUEUES, timeout=2)
            if popped is None:
                continue

            _queue, raw = popped
            job = json.loads(raw)
            kind = job.get("kind", "position")
            log.info("Picked up job %s (%s) from %s", job.get("job_id"), kind, _queue)

            if kind == "full_game":
                await handle_full_game_job(pool, redis, conn, job)
            else:
                await handle_position_job(pool, redis, conn, job)

        except asyncio.CancelledError:
            break
        except Exception:
            log.exception("Job failed with unhandled exception")
            try:
                await conn.rollback()
            except Exception:
                conn = await psycopg.AsyncConnection.connect(DATABASE_URL, autocommit=False)

    log.info("Shutting down engine pool")
    await pool.stop()
    await redis.aclose()
    await conn.close()


def _handle_signal(*_args) -> None:
    log.info("Signal received; finishing current job then exiting")
    shutdown.set()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)
    asyncio.run(main())
