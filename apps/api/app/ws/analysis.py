"""
WebSocket endpoint streaming engine evaluations to the browser.

Protocol (client -> server):
    {"op": "start", "fen": "...", "multipv": 3, "depth": 22}
    {"op": "stop"}
    {"op": "subscribe", "job_id": 123}

Server -> client:
    {"type": "info",  "depth": 18, "multipv": 1, "cp": 34, "pv": [...]}
    {"type": "done",  "depth": 22, "lines": [...]}
    {"type": "error", "code": "...", "message": "..."}
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.core.chess_utils import validate_fen, zobrist_of
from app.core.config import settings
from app.core.db import SessionLocal
from app.core.redis_client import get_redis
from app.core.security import decode_access_token
from app.core.tiers import is_paid
from app.models import AnalysisCache, AnalysisJob, User

log = logging.getLogger(__name__)
router = APIRouter()

# Concurrent live analyses allowed per plan
MAX_LIVE = {"free": 1, "pro": 3, "master": 3}


# How long a cancellation marker outlives the request. Only has to cover the
# worst case of a job sitting queued before a consumer reaches it.
CANCEL_TTL = 300


class ConnectionState:
    """Tracks the pub/sub relay task for one socket."""

    def __init__(self) -> None:
        self.relay: asyncio.Task | None = None
        self.job_id: int | None = None
        # Only live position analyses are ours to abandon. A subscribed
        # full-game review belongs to the user, not to this socket's cursor,
        # and must survive them navigating the board.
        self.cancellable: bool = False

    async def cancel(self) -> None:
        """
        Drop the relay *and* tell the engine to stop.

        Dropping the relay alone only stops us listening: the job stays on the
        queue and a worker still runs it to full depth, publishing to a channel
        with no subscriber. Since the board re-requests analysis on every move,
        that was a full abandoned search for each position walked past.
        """
        job_id, self.job_id = self.job_id, None
        cancellable, self.cancellable = self.cancellable, False

        if self.relay and not self.relay.done():
            self.relay.cancel()
            try:
                await self.relay
            except asyncio.CancelledError:
                pass
        self.relay = None

        if job_id is None or not cancellable:
            return
        try:
            redis = get_redis()
            # The key covers a job still queued; the publish stops one already
            # running. A job needs whichever of the two arrives first.
            await redis.setex(f"cancel:{job_id}", CANCEL_TTL, "1")
            await redis.publish(f"cancel:{job_id}", "1")
        except Exception:  # never let a cache blip break the socket
            log.warning("could not signal cancel for job %s", job_id, exc_info=True)


async def _relay(ws: WebSocket, job_id: int) -> None:
    """Forward every message on eval:{job_id} to the socket until 'done'."""
    redis = get_redis()
    pubsub = redis.pubsub()
    channel = f"eval:{job_id}"
    await pubsub.subscribe(channel)

    try:
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            data = message["data"]
            await ws.send_text(data)
            try:
                if json.loads(data).get("type") in ("done", "error"):
                    break
            except json.JSONDecodeError:
                continue
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        await pubsub.unsubscribe(channel)
        await pubsub.aclose()


@router.websocket("/ws/analysis")
async def analysis_socket(ws: WebSocket, token: str = Query(default="")):
    payload = decode_access_token(token)
    if not payload:
        await ws.close(code=4401, reason="Invalid or missing token")
        return

    user_id = int(payload["sub"])
    async with SessionLocal() as db:
        user = await db.get(User, user_id)
        if user is None or user.deleted_at is not None:
            await ws.close(code=4401, reason="Account not found")
            return
        plan = user.plan

    await ws.accept()
    state = ConnectionState()
    redis = get_redis()

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "code": "bad_json", "message": "Malformed message"})
                continue

            op = msg.get("op")

            if op == "stop":
                await state.cancel()
                await ws.send_json({"type": "stopped"})

            elif op == "start":
                await state.cancel()  # one live analysis per socket

                fen = msg.get("fen", "")
                try:
                    validate_fen(fen)
                except ValueError as exc:
                    await ws.send_json({"type": "error", "code": "invalid_fen", "message": str(exc)})
                    continue

                depth = min(int(msg.get("depth", 22)), settings.max_depth_for(plan))
                multipv = min(int(msg.get("multipv", 1)), settings.max_multipv_for(plan))
                zob = zobrist_of(fen)

                async with SessionLocal() as db:
                    cached = await db.execute(
                        select(AnalysisCache)
                        .where(AnalysisCache.zobrist == zob, AnalysisCache.depth >= depth)
                        .limit(1)
                    )
                    hit = cached.scalar_one_or_none()

                    if hit:
                        await ws.send_json({
                            "type": "done", "cached": True,
                            "depth": hit.depth, "lines": hit.multipv,
                        })
                        continue

                    job = AnalysisJob(
                        user_id=user_id, kind="position",
                        params={"fen": fen, "depth": depth, "multipv": multipv},
                        status="queued",
                    )
                    db.add(job)
                    await db.commit()
                    await db.refresh(job)
                    job_id = job.id

                state.job_id = job_id
                state.cancellable = True
                state.relay = asyncio.create_task(_relay(ws, job_id))

                queue = "q:pro" if is_paid(plan) else "q:free"
                await redis.rpush(queue, json.dumps({
                    "job_id": job_id, "kind": "position", "fen": fen,
                    "depth": depth, "multipv": multipv, "user_id": user_id,
                }))
                await ws.send_json({"type": "queued", "job_id": job_id})

            elif op == "subscribe":
                job_id = int(msg.get("job_id", 0))
                async with SessionLocal() as db:
                    job = await db.get(AnalysisJob, job_id)
                    if job is None or job.user_id != user_id:
                        await ws.send_json({"type": "error", "code": "not_found", "message": "Job not found"})
                        continue
                    if job.status == "done" and job.result:
                        await ws.send_json({"type": "done", **job.result})
                        continue

                await state.cancel()
                state.job_id = job_id
                state.relay = asyncio.create_task(_relay(ws, job_id))
                await ws.send_json({"type": "subscribed", "job_id": job_id})

            else:
                await ws.send_json({"type": "error", "code": "unknown_op", "message": f"Unknown op: {op}"})

    except WebSocketDisconnect:
        log.info("WS disconnected (user=%s)", user_id)
    except Exception:
        log.exception("WS handler error")
    finally:
        await state.cancel()
